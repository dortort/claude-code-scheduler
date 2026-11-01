// What the channel adapter writes for the listener and the pages: status.json
// (event states, paused, queueDepth) and the reply-stream files. Same formats
// as the mod (docs/CONTRACT.md in plugins/artifact-callbacks); the state
// mapping is the channel build's own (see README.md, "Event states").
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventLine, EventState, Status, StatusEventRecord } from '../../sidecar/lib.ts'
import { ReplyStream } from '../shared/stream.ts'

/** Records kept, newest first (as the mod). */
export const MAX_RECORDS = 200
/** A second event with the same page, action and data within this window is merged into the first. */
export const COALESCE_MS = 1500
/** Events not marked done this long after they were forwarded become done with note "unacknowledged". */
export const DONE_TIMEOUT_MS = 10 * 60 * 1000
/** Outstanding (forwarded, not done) events at which the listener drops new ones (its queue cap). */
export const OUTSTANDING_CAP = 5

const TERMINAL: ReadonlySet<EventState> = new Set<EventState>(['done', 'rejected', 'dropped', 'expired'])

export interface Rec {
  id: string
  state: EventState
  page: string
  action: string
  receivedAt: number
  turnStartedAt: number | null
  turnEndedAt: number | null
  note: string | null
  /** Coalescing key: page + action + canonical data. */
  key: string
  /** For a coalesced duplicate: the event it was merged into. */
  into: string | null
}

/** JSON with object keys sorted, so equal data gives equal text. */
export function canonicalJson (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export interface StoreOptions {
  statusFile: string
  streamDir: string
  now: () => number
  log: (message: string) => void
}

export type Forward = { kind: 'forward'; rec: Rec } | { kind: 'coalesced'; rec: Rec; into: Rec }

export class Store {
  private readonly o: StoreOptions
  private readonly recs = new Map<string, Rec>()
  private readonly streams = new Map<string, ReplyStream>()
  /** Streams changed since the last flush. */
  private readonly dirty = new Set<string>()
  private writeTail: Promise<void> = Promise.resolve()
  paused = false

  constructor (options: StoreOptions) {
    this.o = options
  }

  get (id: string): Rec | undefined {
    return this.recs.get(id)
  }

  /** Records, newest first. */
  list (): Rec[] {
    return [...this.recs.values()].reverse()
  }

  /** Forwarded events not yet done (coalesced duplicates not counted). */
  outstanding (): Rec[] {
    return this.list().filter((r) => r.state === 'running' && r.into === null)
  }

  /** An event line from the listener: a new running event, or a duplicate merged into one. */
  accept (line: EventLine): Forward {
    const now = this.o.now()
    const page = line.servedPage
    const action = line.body.action
    const key = `${page}\n${action}\n${canonicalJson(line.body.data ?? {})}`
    const first = this.list().find((r) => r.into === null && r.key === key && now - r.receivedAt <= COALESCE_MS)
    if (first) {
      const rec: Rec = { ...first, id: line.id, receivedAt: now, note: 'coalesced', into: first.id }
      this.add(rec)
      return { kind: 'coalesced', rec, into: first }
    }
    const rec: Rec = {
      id: line.id, state: 'running', page, action, receivedAt: now,
      turnStartedAt: now, turnEndedAt: null, note: null, key, into: null,
    }
    this.add(rec)
    this.streamState(rec.id, 'running')
    return { kind: 'forward', rec }
  }

  /** Marks an event (and its coalesced duplicates) done. False when it is unknown or already over. */
  done (id: string, note: string | null): boolean {
    const rec = this.recs.get(id)
    if (!rec || rec.into !== null || TERMINAL.has(rec.state)) return false
    const now = this.o.now()
    for (const r of [rec, ...this.list().filter((d) => d.into === id)]) {
      r.state = 'done'
      r.turnEndedAt = now
      if (r.into === null) r.note = note
    }
    this.streamState(id, 'done', true)
    return true
  }

  /** Reply text for the page of a running event. False when it is unknown or over. */
  reply (id: string, text: string): boolean {
    const rec = this.recs.get(id)
    if (!rec || rec.into !== null || rec.state !== 'running') return false
    if (this.streamFor(id).text(text)) this.dirty.add(id)
    return true
  }

  private add (rec: Rec): void {
    this.recs.set(rec.id, rec)
    while (this.recs.size > MAX_RECORDS) {
      const oldest = this.recs.keys().next().value
      if (oldest === undefined) break
      this.recs.delete(oldest)
      this.streams.delete(oldest)
      this.dirty.delete(oldest)
    }
  }

  private streamFor (id: string): ReplyStream {
    let s = this.streams.get(id)
    if (!s) {
      s = new ReplyStream()
      this.streams.set(id, s)
    }
    return s
  }

  private streamState (id: string, state: string, isEnd = false): void {
    const s = this.streamFor(id)
    s.state(state)
    if (isEnd) s.end()
    this.dirty.add(id)
  }

  /** status.json as the listener reads it. */
  status (): Status {
    const events: Record<string, StatusEventRecord> = {}
    for (const r of this.list()) {
      events[r.id] = {
        id: r.id, state: r.state, page: r.page, action: r.action,
        turnStartedAt: r.turnStartedAt, turnEndedAt: r.turnEndedAt, note: r.note,
      }
    }
    return { v: 1, paused: this.paused, queueDepth: this.outstanding().length, events }
  }

  /**
   * Writes every reply stream that changed, then status.json, each through a
   * `.tmp` file and a rename, one write at a time. Streams go first so a page
   * that sees a terminal state in status.json finds the stream's last text too.
   */
  flush (): Promise<void> {
    const streams: [string, ReplyStream][] = []
    for (const id of this.dirty) {
      const s = this.streams.get(id)
      if (s) streams.push([id, s])
      if (s?.ended) this.streams.delete(id)
    }
    this.dirty.clear()
    const status = `${JSON.stringify(this.status(), null, 2)}\n`
    const run = this.writeTail.then(async () => {
      if (streams.length > 0) await mkdir(this.o.streamDir, { recursive: true })
      for (const [id, s] of streams) await atomicWrite(join(this.o.streamDir, `${id}.ndjson`), s.toString())
      await atomicWrite(this.o.statusFile, status)
    })
    this.writeTail = run.catch((err: unknown) => this.o.log(`could not write status: ${(err as Error).message}`))
    return this.writeTail
  }
}

async function atomicWrite (path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}
