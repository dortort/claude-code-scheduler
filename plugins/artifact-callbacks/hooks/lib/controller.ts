// The mod's logic: the sidecar's life, the event queue and confirm policy,
// the status file and line, reply streams and the /callbacks command.
//
// It reaches the engine only through `Effects`, which the hooks module
// builds from `$` inside its session.start hook (the engine requires `$` to
// be spelled at each call site, so `$` itself is never passed around).

import type {
  ArtifactCallbacksEventRecord as EventRecord,
  ArtifactCallbacksListener as Listener,
  ArtifactCallbacksPending as Pending,
  ArtifactCallbacksSession as Session,
} from '../../types/index.d.ts'
import {
  HEALTHY_MS,
  NODE_PROBE,
  backoffDelay,
  checkNode,
  listenerArgv,
  nodeReason,
  openCommand,
  platformFrom,
  randomHex,
  remoteReason,
  type NodeCheck,
  type Platform,
  type RemoteKind,
} from './host.ts'
import { LineSplitter, parseLine, type EventLine } from './ndjson.ts'
import { RUN_ROOT, artifactsDir, join, normalizePage, runDir } from './paths.ts'
import {
  APPROVAL_MS,
  canonicalJson,
  findCoalesceTarget,
  isQueueFull,
  needsApproval,
  newRecord,
  nextSubmittable,
  parsePolicy,
  patchRecord,
  trimRecords,
  type ConfirmPolicy,
  type RecordPatch,
} from './queue.ts'
import { buildStatus, composeText, encodePagePath, serializeStatus, statusLine, statusReport } from './status.ts'
import { ReplyStream, STREAM_FLUSH_MS } from './stream.ts'
import { DEFAULT_MAX_PROMPT_CHARS, renderContext, renderPrompt } from './template.ts'
import { pageToken, tokenTags } from './token.ts'

export const PLUGIN = 'artifact-callbacks'
/** How long session.start and /callbacks start wait for the ready line. */
export const READY_WAIT_MS = 3000

/** What the controller keeps in `$.state`. */
export type Snapshot = {
  events: EventRecord[]
  trusted: string[]
  listener: Listener
  paused: boolean
  queue: Pending[]
  session: Session | null
}

export type SpawnChunk = { stream: 'stdout' | 'stderr'; text: string }
export type SpawnExit = { code: number | null; signal: string | null }
export type SpawnStream = AsyncGenerator<SpawnChunk, unknown>
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type DirEntry = { name: string; kind: 'file' | 'dir' | 'other' }
export type Timer = { cancel: () => void }

/** The engine operations the controller uses; built from `$` by the hooks module. */
export type Effects = {
  pluginRoot: string
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  debug: (text: string) => void
  toast: (text: string) => void
  status: (text: string | undefined) => void
  invalidateSections: () => void
  save: (snapshot: Snapshot) => Promise<void>
  load: () => Promise<Snapshot | undefined>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<DirEntry[]>
  run: (argv: string[], init?: { timeoutMs?: number }) => Promise<RunResult>
  spawn: (request: { argv: string[]; env: Record<string, string>; cwd: string }) => SpawnStream
  submit: (text: string) => Promise<{ drop?: string | undefined }>
  /** Appends a hidden user-role row the model reads (the event's raw JSON). */
  appendContext: (text: string) => Promise<void>
  sessionId: () => Promise<string>
  osVar: () => Promise<string | undefined>
}

export type Config = {
  policy: ConfirmPolicy
  port: number
  maxPromptChars: number
  autoStart: boolean
  allowFileOrigin: boolean
  streamReplies: boolean
  artifactsDir: string | undefined
}

export function configFrom(options: Readonly<Record<string, unknown>>): Config {
  return {
    policy: parsePolicy(options.confirm),
    port: toPort(options.port),
    maxPromptChars: toPositive(options.maxPromptChars, DEFAULT_MAX_PROMPT_CHARS),
    autoStart: options.autoStart !== false,
    allowFileOrigin: options.allowFileOrigin === true,
    streamReplies: options.streamReplies === true,
    artifactsDir: typeof options.artifactsDir === 'string' && options.artifactsDir.trim() !== '' ? options.artifactsDir.trim() : undefined,
  }
}

type Child = {
  stream: SpawnStream
  port: number
  isStopping: boolean
  stop: () => void
  stopped: Promise<'stop'>
  readyAt: number | null
  error: { reason: string; message?: string } | null
  onReady: Array<() => void>
  onExit: Array<() => void>
}

type Current = {
  id: string
  text: string
  context: string
  isStarted: boolean
  turnId: string | null
  /** The mod's prompt.submit hook attached the context to the prompt. */
  isContextAttached: boolean
}

export const OFF_LISTENER: Listener = {
  state: 'off',
  port: null,
  pid: null,
  reason: null,
  restarts: 0,
  nodeVersion: null,
}

export const USAGE = [
  'Usage: /callbacks [subcommand]',
  '  (none)          status: URL, port, pages, queue, last 10 events',
  '  open <page>     open http://127.0.0.1:<port>/a/<page> in the browser',
  '  pause | resume  stop or restart submitting events as prompts',
  '  start | stop    start or stop the listener',
  '  rotate          new secret and port (open tabs must reload)',
  '  trust <page>    run events from <page> without asking',
  '  untrust <page>  ask again before events from <page>',
].join('\n')

export type Controller = ReturnType<typeof createController>

export function createController(config: Config) {
  // Session state, mirrored to $.state (survives reloads) and status.json.
  let events: EventRecord[] = []
  let trusted: string[] = []
  let listener: Listener = { ...OFF_LISTENER }
  let paused = false
  let queue: Pending[] = []
  let session: Session | null = null

  // Module-only state: a reload resets it and rebuilds it from the above.
  let fx: Effects | undefined
  let isActive = false
  let child: Child | undefined
  let current: Current | undefined
  let keepPort: number | undefined
  let restartTimer: Timer | undefined
  let hasToastedGiveUp = false
  let isComposeVisible = false
  const activeTurns = new Set<string>()
  /** Turns seen starting that were not the in-flight event's. */
  const foreignTurns = new Set<string>()
  const expiryTimers = new Map<string, Timer>()
  const streams = new Map<string, ReplyStream>()
  let streamFlushTimer: Timer | undefined
  let persistTail: Promise<void> = Promise.resolve()
  let isPersistQueued = false
  let writeTail: Promise<void> = Promise.resolve()

  /** Runs work nobody awaits; a failure is logged, never left unhandled. */
  function background(work: () => Promise<unknown>): void {
    void work().catch(err => {
      try {
        fx?.debug(`artifact-callbacks: ${errorText(err)}`)
      } catch {
        // The engine is gone (the module unloaded): nothing to tell.
      }
    })
  }

  function engine(): Effects {
    if (!fx) throw new Error('artifact-callbacks: no session yet')
    return fx
  }

  // ---------------------------------------------------------------- state

  function persist(): Promise<void> {
    if (!fx) return Promise.resolve()
    if (isPersistQueued) return persistTail
    isPersistQueued = true
    const run = persistTail.then(async () => {
      isPersistQueued = false
      await writeState()
    })
    persistTail = run.catch(err => {
      fx?.debug(`artifact-callbacks: could not save state: ${errorText(err)}`)
    })
    return persistTail
  }

  async function writeState(): Promise<void> {
    const e = engine()
    events = trimRecords(events)
    await e.save({ events, trusted, listener, paused, queue, session })
    e.status(isActive ? statusLine(listener, queue.length, paused) : undefined)
    const isVisible = composeVisible()
    if (isVisible !== isComposeVisible) {
      isComposeVisible = isVisible
      e.invalidateSections()
    }
    if (session) {
      await atomicWrite(session.statusFile, serializeStatus(buildStatus({ paused, queue, events })))
    }
  }

  /** Writes `path` through `<path>.tmp` and a rename, one write at a time. */
  function atomicWrite(path: string, text: string): Promise<void> {
    const run = writeTail.then(async () => {
      const e = engine()
      const tmp = `${path}.tmp`
      await e.write(tmp, text)
      const argv =
        session?.platform === 'win32'
          ? ['cmd', '/c', 'move', '/y', tmp.replace(/\//g, '\\'), path.replace(/\//g, '\\')]
          : ['mv', '-f', tmp, path]
      const isMoved = await e.run(argv).then(
        r => r.exitCode === 0,
        () => false,
      )
      if (!isMoved) await e.write(path, text)
    })
    writeTail = run.catch(() => undefined)
    return run
  }

  function composeVisible(): boolean {
    return isActive && listener.state === 'up' && listener.port !== null && !paused
  }

  function patch(id: string, p: RecordPatch): void {
    events = patchRecord(events, id, p)
  }

  function record(id: string): EventRecord | undefined {
    return events.find(r => r.id === id)
  }

  // ------------------------------------------------------------- listener

  async function detectPlatform(): Promise<Platform> {
    const e = engine()
    const os = await e.osVar()
    if (os === 'Windows_NT') return 'win32'
    const uname = await e.run(['uname', '-s']).then(
      r => (r.exitCode === 0 ? r.stdout : undefined),
      () => undefined,
    )
    return platformFrom(os, uname)
  }

  /** Runs `node --version` and judges it against the minimum. */
  async function probeNode(): Promise<NodeCheck> {
    const result = await engine()
      .run([...NODE_PROBE], { timeoutMs: 10_000 })
      .then(
        r => r,
        () => undefined,
      )
    return checkNode(result)
  }

  async function ensureDirs(s: Session): Promise<void> {
    const e = engine()
    const missing: string[] = []
    for (const dir of [s.artifactsDir, s.runDir, s.streamDir]) {
      if (!(await e.exists(dir).catch(() => false))) missing.push(dir)
    }
    if (missing.length > 0) {
      let isMade: boolean
      if (s.platform === 'win32') {
        const each = await Promise.all(
          missing.map(d =>
            e.run(['cmd', '/c', 'mkdir', d.replace(/\//g, '\\')]).then(
              r => r.exitCode === 0,
              () => false,
            ),
          ),
        )
        isMade = each.every(Boolean)
      } else {
        isMade = await e.run(['mkdir', '-p', ...missing]).then(
          r => r.exitCode === 0,
          () => false,
        )
      }
      if (!isMade) for (const dir of missing) await e.write(join(dir, '.keep'), '')
    }
    const ignore = join(s.cwd, RUN_ROOT, '.gitignore')
    if (!(await e.exists(ignore).catch(() => false))) await e.write(ignore, '*\n')
  }

  /** Starts the sidecar; resolves once it is spawned (not once it is ready). */
  async function startListener(): Promise<void> {
    if (!session || child || !isActive) return
    const e = engine()
    restartTimer?.cancel()
    restartTimer = undefined
    const s = session
    if (listener.state !== 'restarting') listener = { ...listener, state: 'starting', reason: null }
    await persist()
    const node = await probeNode()
    if (!node.isOk) {
      listener = { ...listener, state: 'down', pid: null, reason: nodeReason(node), nodeVersion: node.found }
      await persist()
      return
    }
    try {
      await ensureDirs(s)
    } catch (err) {
      listener = { ...listener, state: 'down', pid: null, reason: `cannot create folders: ${errorText(err)}` }
      await persist()
      return
    }
    if (child || session !== s) return
    const port = keepPort ?? config.port
    const env: Record<string, string> = {
      CB_PORT: String(port),
      CB_ROOT: s.artifactsDir,
      CB_STATUS_FILE: s.statusFile,
      CB_SECRET: s.secret,
    }
    if (config.allowFileOrigin) env.CB_ALLOW_FILE_ORIGIN = '1'
    if (config.streamReplies) env.CB_STREAM_DIR = s.streamDir
    let stop: () => void = () => undefined
    const stopped = new Promise<'stop'>(resolve => {
      stop = () => resolve('stop')
    })
    const c: Child = {
      stream: e.spawn({ argv: listenerArgv(e.pluginRoot), env, cwd: s.cwd }),
      port,
      isStopping: false,
      stop,
      stopped,
      readyAt: null,
      error: null,
      onReady: [],
      onExit: [],
    }
    child = c
    listener = { ...listener, nodeVersion: node.version }
    background(() => runChild(c))
  }

  /** Resolves true once the current child is ready, false on exit or timeout. */
  function waitReady(ms: number = READY_WAIT_MS): Promise<boolean> {
    const c = child
    if (!c) return Promise.resolve(listener.state === 'up')
    if (c.readyAt !== null) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      let isSettled = false
      const settle = (value: boolean): void => {
        if (isSettled) return
        isSettled = true
        timer.cancel()
        resolve(value)
      }
      const timer = engine().after(ms, () => settle(false))
      c.onReady.push(() => settle(true))
      c.onExit.push(() => settle(false))
    })
  }

  async function runChild(c: Child): Promise<void> {
    const splitter = new LineSplitter()
    let failure: string | undefined
    let exit: SpawnExit | undefined
    try {
      for (;;) {
        const step = await Promise.race([c.stream.next(), c.stopped])
        if (step === 'stop') {
          void c.stream.return(undefined).catch(() => undefined)
          return
        }
        if (step.done) {
          exit = step.value as SpawnExit | undefined
          break
        }
        const { stream, text } = step.value
        if (stream === 'stdout') {
          for (const line of splitter.push(text)) await onLine(c, line)
        } else {
          fx?.debug(`artifact-callbacks sidecar: ${text.trimEnd()}`)
        }
      }
      for (const line of splitter.flush()) await onLine(c, line)
    } catch (err) {
      failure = errorText(err)
    } finally {
      for (const resolve of c.onExit.splice(0)) resolve()
    }
    if (c.isStopping || child !== c) return
    child = undefined
    await onChildExit(c, exit, failure)
  }

  async function onLine(c: Child, raw: string): Promise<void> {
    const line = parseLine(raw)
    if (!line) {
      fx?.debug('artifact-callbacks: ignored a malformed sidecar line')
      return
    }
    if (child !== c) return
    switch (line.type) {
      case 'ready': {
        c.readyAt = await engine().now()
        c.port = line.port
        keepPort = line.port
        listener = { ...listener, state: 'up', port: line.port, pid: line.pid, reason: null }
        await persist()
        for (const resolve of c.onReady.splice(0)) resolve()
        return
      }
      case 'event':
        await onEvent(line)
        return
      case 'dropped': {
        if (record(line.id)) return
        events = [
          ...events,
          newRecord({
            id: line.id,
            page: line.servedPage ?? '?',
            action: line.action ?? '?',
            label: line.label ?? null,
            receivedAt: await engine().now(),
            dataKey: '{}',
            state: 'dropped',
            note: line.reason,
          }),
        ]
        await persist()
        return
      }
      case 'rejected':
        fx?.debug(`artifact-callbacks: the listener refused a request (${line.reason})`)
        return
      case 'error':
        c.error = { reason: line.reason, ...(line.message ? { message: line.message } : {}) }
        fx?.debug(`artifact-callbacks: listener error ${line.reason}: ${line.message ?? ''}`)
        return
    }
  }

  async function onChildExit(c: Child, exit: SpawnExit | undefined, failure: string | undefined): Promise<void> {
    const e = engine()
    const now = await e.now()
    const why =
      failure ??
      (c.error ? `${c.error.reason}${c.error.message ? `: ${c.error.message}` : ''}` : undefined) ??
      `exited (${exit?.signal ?? `code ${exit?.code ?? '?'}`})`
    // The kept port was taken meanwhile: start over on a random one, at once.
    if (c.error?.reason === 'port-in-use' && c.port !== 0 && config.port === 0) {
      keepPort = 0
      listener = { ...listener, state: 'restarting', pid: null, reason: why }
      await startListener()
      return
    }
    if (c.readyAt !== null && now - c.readyAt >= HEALTHY_MS) listener = { ...listener, restarts: 0 }
    const delay = backoffDelay(listener.restarts)
    if (delay === undefined) {
      listener = { ...listener, state: 'down', pid: null, reason: `gave up after ${listener.restarts} restarts: ${why}` }
      await persist()
      if (!hasToastedGiveUp) {
        hasToastedGiveUp = true
        e.toast('Artifact Callbacks: the listener keeps exiting and stays down. /callbacks start tries again.')
      }
      return
    }
    listener = { ...listener, state: 'restarting', pid: null, reason: why, restarts: listener.restarts + 1 }
    await persist()
    restartTimer = e.after(delay, () => {
      restartTimer = undefined
      if (listener.state === 'restarting' && !child) background(startListener)
    })
  }

  async function stopListener(): Promise<void> {
    restartTimer?.cancel()
    restartTimer = undefined
    const c = child
    child = undefined
    if (c) {
      c.isStopping = true
      c.stop()
      for (const resolve of c.onExit.splice(0)) resolve()
    }
    listener = { ...listener, state: 'stopped', pid: null, reason: null }
    await persist()
  }

  // --------------------------------------------------------------- events

  async function onEvent(line: EventLine): Promise<void> {
    if (!session || record(line.id)) return
    const e = engine()
    const now = await e.now()
    const receivedAt = line.receivedAt > 0 ? line.receivedAt : now
    const page = line.servedPage
    const { action } = line.body
    const label = typeof line.body.label === 'string' ? line.body.label : null
    const data = line.body.data ?? {}
    const dataKey = canonicalJson(data)
    const base = { id: line.id, page, action, label, receivedAt, dataKey }

    const target = findCoalesceTarget(events, { page, action, dataKey, receivedAt })
    if (target) {
      events = [
        ...events,
        {
          ...newRecord({ ...base, state: target.state, note: 'coalesced', coalescedInto: target.id }),
          turnStartedAt: target.turnStartedAt,
          turnEndedAt: target.turnEndedAt,
        },
      ]
      await persist()
      return
    }
    if (paused || isQueueFull(queue)) {
      events = [...events, newRecord({ ...base, state: 'dropped', note: paused ? 'paused' : 'queue-full' })]
      await persist()
      return
    }
    const text = renderPrompt({ page, action, label, data, prompt: line.body.prompt ?? null }, config.maxPromptChars)
    const context = renderContext(line)
    const isWaiting = needsApproval(config.policy, trusted, page)
    events = [
      ...events,
      newRecord({ ...base, state: isWaiting ? 'awaiting-approval' : 'queued', expiresAt: isWaiting ? now + APPROVAL_MS : null }),
    ]
    queue = [...queue, { id: line.id, page, action, dataKey, text, context, receivedAt }]
    e.toast(`${page} → ${action}`)
    if (isWaiting) armExpiry(line.id, APPROVAL_MS)
    await persist()
    background(pump)
  }

  function armExpiry(id: string, ms: number): void {
    expiryTimers.get(id)?.cancel()
    expiryTimers.set(
      id,
      engine().after(Math.max(0, ms), () => {
        expiryTimers.delete(id)
        background(() => expire(id))
      }),
    )
  }

  async function expire(id: string): Promise<void> {
    if (record(id)?.state !== 'awaiting-approval') return
    patch(id, { state: 'expired', expiresAt: null, note: 'no approval in 5 minutes' })
    queue = queue.filter(p => p.id !== id)
    await persist()
  }

  function release(ids: readonly string[]): void {
    for (const id of ids) {
      expiryTimers.get(id)?.cancel()
      expiryTimers.delete(id)
      patch(id, { state: 'queued', expiresAt: null })
    }
  }

  function awaitingFrom(page: string): string[] {
    return events.filter(r => r.page === page && r.state === 'awaiting-approval' && r.coalescedInto === null).map(r => r.id)
  }

  /** Run on the band: under first-per-page it trusts the page too. */
  async function approve(id: string): Promise<void> {
    const r = record(id)
    if (r?.state !== 'awaiting-approval') return
    if (config.policy === 'first-per-page') {
      if (!trusted.includes(r.page)) trusted = [...trusted, r.page]
      release(awaitingFrom(r.page))
    } else {
      release([id])
    }
    await persist()
    background(pump)
  }

  /** Discard on the band. */
  async function discard(id: string): Promise<void> {
    if (record(id)?.state !== 'awaiting-approval') return
    expiryTimers.get(id)?.cancel()
    expiryTimers.delete(id)
    patch(id, { state: 'rejected', expiresAt: null, note: 'discarded' })
    queue = queue.filter(p => p.id !== id)
    await persist()
  }

  /** Submits the next approved event; one is in flight at a time. */
  async function pump(): Promise<void> {
    if (current || paused || !isActive || !fx) return
    const next = nextSubmittable(queue, events)
    if (!next) return
    const mine: Current = {
      id: next.id,
      text: next.text,
      context: next.context,
      isStarted: false,
      turnId: null,
      isContextAttached: false,
    }
    current = mine
    let result: { drop?: string | undefined }
    try {
      result = await fx.submit(next.text)
    } catch (err) {
      result = { drop: errorText(err) }
    }
    if (current !== mine) return
    if (result.drop !== undefined) {
      current = undefined
      queue = queue.filter(p => p.id !== mine.id)
      patch(mine.id, { state: 'rejected', note: `not submitted: ${result.drop}` })
      await persist()
      background(pump)
      return
    }
    // The submit resolves as its turn starts: when no turn.start named the
    // turn and no other turn runs, it is ours.
    if (!mine.isStarted && activeTurns.size === 0) await markRunning(mine, null)
  }

  async function markRunning(c: Current, turnId: string | null): Promise<void> {
    if (turnId !== null) c.turnId = turnId
    if (c.isStarted) {
      if (turnId !== null) {
        patch(c.id, { turnId })
        await persist()
      }
      return
    }
    c.isStarted = true
    // The engine skips every hook of the mod for a submit made outside a hook
    // of its own (an event from the sidecar, a press on the band): then the
    // raw event goes in as a hidden row at the start of the event's turn.
    if (!c.isContextAttached) {
      c.isContextAttached = true
      await engine()
        .appendContext(c.context)
        .catch(err => fx?.debug(`artifact-callbacks: could not attach the event JSON: ${errorText(err)}`))
    }
    queue = queue.filter(p => p.id !== c.id)
    patch(c.id, { state: 'running', turnStartedAt: await engine().now(), turnId: c.turnId })
    streamState(c.id, 'running')
    await persist()
  }

  async function markDone(c: Current, note: string | null): Promise<void> {
    current = undefined
    patch(c.id, { state: 'done', turnEndedAt: await engine().now(), note })
    streamState(c.id, 'done', true)
    await persist()
    background(pump)
  }

  // ------------------------------------------------------------ streaming

  function streamFor(id: string): ReplyStream | undefined {
    if (!config.streamReplies || !session) return undefined
    let s = streams.get(id)
    if (!s) {
      s = new ReplyStream()
      streams.set(id, s)
    }
    return s
  }

  function streamState(id: string, state: string, isEnd = false): void {
    const s = streamFor(id)
    if (!s) return
    s.state(state)
    if (isEnd) s.end()
    background(flushStreams)
  }

  function flushStreams(): Promise<void> {
    streamFlushTimer?.cancel()
    streamFlushTimer = undefined
    if (!session || !fx) return Promise.resolve()
    const dir = session.streamDir
    const work: Promise<void>[] = []
    for (const [id, s] of [...streams]) {
      if (s.ended) streams.delete(id)
      work.push(
        atomicWrite(join(dir, `${id}.ndjson`), s.toString()).catch(err =>
          fx?.debug(`artifact-callbacks: could not write a reply stream: ${errorText(err)}`),
        ),
      )
    }
    return Promise.all(work).then(() => undefined)
  }

  // ------------------------------------------------------------ lifecycle

  async function newSession(cwd: string): Promise<void> {
    const e = engine()
    const sessionId = await e.sessionId()
    const platform = await detectPlatform()
    const dir = runDir(cwd, sessionId)
    session = {
      cwd,
      runDir: dir,
      artifactsDir: artifactsDir(cwd, config.artifactsDir),
      statusFile: join(dir, 'status.json'),
      streamDir: join(dir, 'streams'),
      platform,
      secret: randomHex(32),
    }
    listener = config.autoStart ? { ...OFF_LISTENER } : { ...OFF_LISTENER, reason: 'autoStart is off; /callbacks start starts it' }
    await persist()
    if (config.autoStart) {
      await startListener()
      await waitReady()
    }
  }

  /** After a hot reload: the module is new, the session is not. */
  async function resumeSession(prior: Snapshot): Promise<void> {
    const e = engine()
    events = prior.events
    trusted = prior.trusted
    paused = prior.paused
    queue = prior.queue
    session = prior.session ? { ...prior.session, artifactsDir: artifactsDir(prior.session.cwd, config.artifactsDir) } : null
    const was = prior.listener
    // Field by field, so a snapshot from an older build (one with `runtime`)
    // carries nothing the listener type no longer has.
    listener = {
      state: was.state,
      port: was.port,
      pid: null,
      reason: was.reason,
      restarts: was.restarts,
      nodeVersion: was.nodeVersion ?? null,
    }
    const now = await e.now()
    for (const r of events) {
      if (r.state === 'running' && r.coalescedInto === null) {
        patch(r.id, { state: 'done', turnEndedAt: now, note: 'reload' })
        streamState(r.id, 'done', true)
      }
    }
    for (const r of events) {
      if (r.state !== 'awaiting-approval' || r.coalescedInto !== null) continue
      const due = r.expiresAt ?? now + APPROVAL_MS
      if (due <= now) {
        patch(r.id, { state: 'expired', expiresAt: null, note: 'no approval in 5 minutes' })
        queue = queue.filter(p => p.id !== r.id)
      } else {
        armExpiry(r.id, due - now)
      }
    }
    // Pending items whose record is gone or settled are not held any more.
    queue = queue.filter(p => {
      const st = record(p.id)?.state
      return st === 'queued' || st === 'awaiting-approval'
    })
    keepPort = config.port !== 0 ? config.port : (was.port ?? undefined)
    const isWanted =
      was.state === 'up' ||
      was.state === 'starting' ||
      was.state === 'restarting' ||
      (was.state === 'down' && !was.reason?.startsWith('gave up')) ||
      (was.state === 'off' && config.autoStart && session !== null)
    if (isWanted && session) {
      listener = { ...listener, state: 'starting', restarts: 0, reason: null }
      await startListener()
      await waitReady()
    } else {
      await persist()
    }
    background(pump)
  }

  // ------------------------------------------------------------- /callbacks

  /**
   * A pump started from a command waits for a timer: the engine refuses a
   * submit made inside a command.run hook (the turn would wait on it).
   */
  function deferPump(): void {
    fx?.after(0, () => background(pump))
  }

  /**
   * Starts the listener from a timer: a child spawned inside a command.run
   * hook would report its events in that hook's context, where submits are
   * refused.
   */
  function startOutsideCommand(): Promise<void> {
    const e = engine()
    return new Promise<void>(resolve => {
      e.after(0, () => background(() => startListener().finally(resolve)))
    })
  }

  async function command(args: string): Promise<string> {
    const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    if (!isActive || !session) {
      return `Artifact Callbacks is off: ${listener.reason ?? 'this session has no interactive surface'}`
    }
    switch (sub.toLowerCase()) {
      case '':
        return report()
      case 'open':
        return openPage(arg)
      case 'pause':
        paused = true
        await persist()
        return 'Paused: new events are dropped and nothing is submitted until /callbacks resume.'
      case 'resume':
        paused = false
        await persist()
        deferPump()
        return `Resumed.${queue.length ? ` ${queue.length} pending event(s) will run.` : ''}`
      case 'start': {
        if (child) return `The listener is already ${listener.state === 'up' ? `up on port ${listener.port}` : listener.state}.`
        listener = { ...listener, restarts: 0 }
        hasToastedGiveUp = false
        await startOutsideCommand()
        const isUp = await waitReady()
        return isUp ? `Listener up at http://127.0.0.1:${listener.port}/` : `Listener ${listener.state}${listener.reason ? `: ${listener.reason}` : ''}`
      }
      case 'stop':
        await stopListener()
        return 'Listener stopped. /callbacks start starts it again.'
      case 'rotate': {
        await stopListener()
        session = { ...session, secret: randomHex(32) }
        keepPort = config.port
        listener = { ...listener, port: null, restarts: 0 }
        hasToastedGiveUp = false
        await startOutsideCommand()
        const isUp = await waitReady()
        return isUp
          ? `Rotated: new secret and port; the listener is at http://127.0.0.1:${listener.port}/. Open tabs must reload from the new address.`
          : `Rotated the secret; the listener is ${listener.state}${listener.reason ? `: ${listener.reason}` : ''}.`
      }
      case 'trust': {
        const page = normalizePage(arg)
        if (!page) return 'Usage: /callbacks trust <page>'
        if (!trusted.includes(page)) trusted = [...trusted, page]
        const waiting = awaitingFrom(page)
        release(waiting)
        await persist()
        deferPump()
        return `Trusted ${page} for this session.${waiting.length ? ` ${waiting.length} waiting event(s) released.` : ''}`
      }
      case 'untrust': {
        const page = normalizePage(arg)
        if (!page) return 'Usage: /callbacks untrust <page>'
        const wasTrusted = trusted.includes(page)
        trusted = trusted.filter(p => p !== page)
        await persist()
        return wasTrusted ? `${page} is no longer trusted; its next event asks first.` : `${page} was not trusted.`
      }
      default:
        return USAGE
    }
  }

  async function report(): Promise<string> {
    const e = engine()
    const s = session as Session
    return statusReport({
      listener,
      paused,
      queue,
      events,
      trusted,
      pages: await listPages(e, s.artifactsDir),
      artifactsDir: s.artifactsDir,
      policy: config.policy,
      now: await e.now(),
    })
  }

  async function openPage(arg: string): Promise<string> {
    const page = normalizePage(arg)
    if (!page) return 'Usage: /callbacks open <page>'
    if (listener.state !== 'up' || listener.port === null) {
      return `The listener is ${listener.state}${listener.reason ? ` (${listener.reason})` : ''}; /callbacks start starts it.`
    }
    const url = `http://127.0.0.1:${listener.port}/a/${encodePagePath(page)}`
    const outcome = await engine()
      .run(openCommand(session?.platform ?? 'linux', url))
      .then(
        r => (r.exitCode === 0 ? undefined : r.stderr.trim() || `exit code ${r.exitCode}`),
        err => errorText(err),
      )
    return outcome === undefined ? `Opened ${url}` : `Could not open ${url}: ${outcome}`
  }

  // ------------------------------------------------------- the hooks' API

  return {
    config,

    /** session.start of an interactive session: a new session or a reload. */
    async start(effects: Effects, cwd: string, remote: RemoteKind | undefined): Promise<void> {
      fx = effects
      if (remote !== undefined) {
        isActive = false
        listener = { ...OFF_LISTENER, reason: remoteReason(remote) }
        effects.status(undefined)
        return
      }
      isActive = true
      const prior = await effects.load()
      if (prior) await resumeSession(prior)
      else await newSession(cwd)
    },

    /** The prompt.submit hook: the hidden context for our own submission. */
    contextFor(text: string, origin: { kind: string; name?: string }): string | undefined {
      const c = current
      if (!c || origin.kind !== 'plugin' || origin.name !== PLUGIN || text !== c.text) return undefined
      c.isContextAttached = true
      return c.context
    },

    async turnStarted(turnId: string, text: string): Promise<void> {
      activeTurns.add(turnId)
      const c = current
      if (c && c.turnId === null && matchesPrompt(text, c.text)) await markRunning(c, turnId)
      else foreignTurns.add(turnId)
    },

    async turnCompleted(turnId: string, reason: string, isAborted: boolean): Promise<void> {
      activeTurns.delete(turnId)
      const isForeign = foreignTurns.delete(turnId)
      const c = current
      if (!c || !c.isStarted) return
      // A turn bound to the event, or (when no turn.start named it) the first
      // turn to end that was not seen starting as someone else's.
      if (c.turnId !== turnId && (c.turnId !== null || isForeign)) return
      const note = isAborted || reason === 'aborted' ? 'interrupted' : reason === 'answer' ? null : reason
      await markDone(c, note)
    },

    /** The event id whose reply a step of `turnId` streams, if any. */
    streamingEvent(turnId: string): string | undefined {
      const c = current
      return config.streamReplies && c && c.turnId === turnId ? c.id : undefined
    },

    streamText(id: string, text: string): void {
      const s = streamFor(id)
      if (!s?.text(text) || streamFlushTimer || !fx) return
      streamFlushTimer = fx.after(STREAM_FLUSH_MS, () => {
        streamFlushTimer = undefined
        background(flushStreams)
      })
    },

    /** The compose section's text while it is shown; undefined while not. */
    composeSection(): string | undefined {
      if (!composeVisible() || listener.port === null) return undefined
      const text = composeText(listener.port, config.artifactsDir?.replace(/[\\/]+$/, ''))
      if (!config.allowFileOrigin) return text
      return `${text}\nFor a page the user will open from disk (file://), call the page_token tool for its head tags.`
    },

    /** The page_token tool: head tags for a file:// page, or why not. */
    async pageTokenTags(pageArg: unknown): Promise<{ text: string; isError: boolean }> {
      if (!config.allowFileOrigin) return { text: 'file:// token mode is off (allowFileOrigin).', isError: true }
      const page = typeof pageArg === 'string' ? normalizePage(pageArg) : undefined
      if (!page) return { text: 'page must be a path relative to the artifacts folder, such as triage.html.', isError: true }
      if (!session || listener.state !== 'up' || listener.port === null) {
        return { text: `The listener is ${listener.state}; there is no endpoint to give a token for.`, isError: true }
      }
      return { text: tokenTags(listener.port, page, await pageToken(session.secret, page)), isError: false }
    },

    /** Run on the band; never rejects. */
    approve(id: string): void {
      background(() => approve(id))
    },
    /** Discard on the band; never rejects. */
    discard(id: string): void {
      background(() => discard(id))
    },
    command,

    /** Waits for the persisted state, the status file and pending writes. */
    async settled(): Promise<void> {
      await persistTail
      await writeTail
    },
  }
}

/** Lists the pages under the artifacts folder (`.html`, three levels deep, 50 at most). */
async function listPages(e: Effects, root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 3 || found.length >= 50) return
    const entries = await e.list(dir).catch(() => [] as DirEntry[])
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.kind === 'dir') await walk(join(dir, entry.name), rel, depth + 1)
      else if (entry.kind === 'file' && /\.html?$/i.test(entry.name)) found.push(rel)
      if (found.length >= 50) return
    }
  }
  await walk(root, '', 0)
  return found
}

/** Whether a turn's text is our submitted prompt (the engine may frame it). */
export function matchesPrompt(started: string, ours: string): boolean {
  if (started === ours || started.includes(ours)) return true
  const head = ours.slice(0, 80)
  return head.length >= 20 && started.includes(head)
}

export function toPort(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0
}

export function toPositive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
