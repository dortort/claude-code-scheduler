// A fake engine for the hooks module's tests: the hooks a test registers on
// `on` sit beneath the plugin and answer what the engine would. Files live in
// memory, host commands are scripted, and each spawned sidecar is a stream
// the test drives line by line.

import { mock } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

declare function setTimeout(fn: () => void, ms: number): unknown

export const CWD = '/work'
export const SESSION_ID = 'sess-1'
export const ROOT = '/plugins/artifact-callbacks'
export const RUN = `${CWD}/.claude/.artifact-callbacks/${SESSION_ID}`
export const STATUS = `${RUN}/status.json`
export const ARTIFACTS = `${CWD}/.claude/artifacts`
export const T0 = 1_791_821_700_000

export type Exit = { code: number | null; signal: string | null }
type Chunk = { stream: 'stdout' | 'stderr'; text: string }

/** One spawned sidecar: what it was started with, and its stdout to drive. */
export class FakeSidecar {
  private readonly pending: Array<Chunk | Exit> = []
  private wake: (() => void) | undefined
  isClosed = false

  constructor(
    readonly argv: readonly string[],
    readonly env: Readonly<Record<string, string>>,
    readonly cwd: string | undefined,
  ) {}

  /** Writes one NDJSON line (or raw text) to the sidecar's stdout. */
  emit(line: unknown): void {
    this.pending.push({ stream: 'stdout', text: typeof line === 'string' ? line : `${JSON.stringify(line)}\n` })
    this.wake?.()
  }

  stderr(text: string): void {
    this.pending.push({ stream: 'stderr', text })
    this.wake?.()
  }

  exit(code: number | null = 1, signal: string | null = null): void {
    this.pending.push({ code, signal })
    this.wake?.()
  }

  async *run(): AsyncGenerator<Chunk, { value: Exit }> {
    try {
      for (;;) {
        while (this.pending.length > 0) {
          const item = this.pending.shift() as Chunk | Exit
          if ('stream' in item) yield item
          else return { value: item }
        }
        await new Promise<void>(resolve => {
          this.wake = resolve
        })
        this.wake = undefined
      }
    } finally {
      this.isClosed = true
    }
  }
}

export type Submitted = { text: string; context: readonly string[] | undefined; origin: unknown; asUser: boolean }

export type KitOptions = {
  /** Which runtimes answer `--version` with exit code 0. */
  runtimes?: { node?: boolean; python3?: boolean; py?: boolean }
  /** What `uname -s` prints (and `OS` in the environment). */
  uname?: string
  env?: Record<string, string>
  /** Port a sidecar reports when spawned with CB_PORT=0. */
  randomPorts?: number[]
  /** Emit `ready` as soon as a sidecar is spawned (default true). */
  autoReady?: boolean
  /** Ports a sidecar fails to bind (it reports port-in-use and exits 2). */
  busyPorts?: number[]
  /** The browser opener exits with this code and stderr. */
  openerFails?: { code: number; stderr: string }
  /** `prompt.submit` answers with this drop instead of entering the prompt. */
  dropSubmit?: string
}

export type Kit = ReturnType<typeof engine>

/** Registers the fake engine beneath the plugin; call before the first `$` call. */
export function engine(on: On, options: KitOptions = {}) {
  const clock = mock.clock(on, { now: T0 })
  const session = mock.session(on)
  const environment: Record<string, string> = { ...(options.env ?? {}) }
  if (options.uname === 'Windows') environment.OS = 'Windows_NT'
  mock.env(on, environment)

  const files = new Map<string, string>()
  const dirs = new Set<string>(['/', CWD, `${CWD}/.claude`])
  const writes: Array<{ path: string; text: string }> = []
  const runs: string[][] = []
  const sidecars: FakeSidecar[] = []
  const submitted: Submitted[] = []
  const toasts: string[] = []
  const statuses: Array<string | undefined> = []
  const logs: string[] = []
  const invalidated: string[] = []
  const commands: string[] = []
  const tools: string[] = []
  const randomPorts = [...(options.randomPorts ?? [51234, 51235, 51236, 51237, 51238, 51239])]
  const runtimes = options.runtimes ?? { node: true, python3: true, py: true }
  let turnSeq = 0

  const parentOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))
  const addDirs = (path: string): void => {
    let p = path
    while (p.length > 1) {
      dirs.add(p)
      p = parentOf(p)
    }
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__artifact-callbacks__${e.name}` } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', (_$, e) => {
    invalidated.push(e.event)
    return { value: undefined }
  })

  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    writes.push({ path: e.path, text: e.text })
    addDirs(parentOf(e.path))
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.list', (_$, e) => {
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of files.keys()) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const [first = '', ...more] = rest.split('/')
      names.set(first, more.length > 0 ? 'dir' : 'file')
    }
    for (const d of dirs) {
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (rest && !rest.includes('/')) names.set(rest, 'dir')
    }
    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
    }
  })

  const result = (exitCode: number, stdout = '', stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const [cmd, ...args] = argv
    switch (cmd) {
      case 'uname':
        return result(0, `${options.uname ?? 'Linux'}\n`)
      case 'node':
        return runtimes.node ? result(0, 'v22.0.0\n') : { deny: 'spawn node ENOENT' }
      case 'python3':
        return runtimes.python3 ? result(0, 'Python 3.12.0\n') : { deny: 'spawn python3 ENOENT' }
      case 'py':
        return runtimes.py ? result(0, 'Python 3.12.0\n') : { deny: 'spawn py ENOENT' }
      case 'mkdir':
        for (const d of args.filter(a => !a.startsWith('-'))) addDirs(d)
        return result(0)
      case 'mv': {
        const [from = '', to = ''] = args.filter(a => !a.startsWith('-'))
        const text = files.get(from)
        if (text === undefined) return result(1, '', 'no such file')
        files.delete(from)
        files.set(to, text)
        return result(0)
      }
      case 'cmd': {
        if (args[1] === 'move') {
          const from = (args[3] ?? '').replace(/\\/g, '/')
          const to = (args[4] ?? '').replace(/\\/g, '/')
          const text = files.get(from)
          if (text === undefined) return result(1)
          files.delete(from)
          files.set(to, text)
          return result(0)
        }
        if (args[1] === 'mkdir') {
          addDirs((args[2] ?? '').replace(/\\/g, '/'))
          return result(0)
        }
        return result(0)
      }
      case 'open':
      case 'xdg-open':
        return options.openerFails ? result(options.openerFails.code, '', options.openerFails.stderr) : result(0)
      default:
        return result(127, '', `${cmd}: not found`)
    }
  })

  on('process.spawn', async function* (_$, e) {
    const sidecar = new FakeSidecar(e.argv, e.env ?? {}, e.cwd)
    sidecars.push(sidecar)
    const asked = Number(sidecar.env.CB_PORT ?? '0')
    if (asked !== 0 && options.busyPorts?.includes(asked)) {
      sidecar.emit({ type: 'error', reason: 'port-in-use', message: `port ${asked} is in use` })
      sidecar.exit(2)
    } else if (options.autoReady !== false) {
      const port = asked !== 0 ? asked : (randomPorts.shift() ?? 50000 + sidecars.length)
      sidecar.emit({ type: 'ready', port, pid: 4400 + sidecars.length })
    }
    return yield* sidecar.run()
  })

  on('prompt.submit', (_$, e) => {
    submitted.push({ text: e.text, context: e.context, origin: e.origin, asUser: (e.origin as { asUser?: boolean }).asUser === true })
    if (options.dropSubmit !== undefined) return { drop: options.dropSubmit }
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // The engine's own drawing, where the plugin leaves a site to it.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'engine band') as RenderElement
  })

  const kit = {
    clock,
    session,

    /** The hidden user rows the mod appended (the event JSON). */
    appendedTexts(): string[] {
      return session.appended().flatMap(row =>
        (row.message.content as ReadonlyArray<{ type: string; text?: unknown }>).flatMap(block =>
          block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
        ),
      )
    },
    files,
    writes,
    runs,
    sidecars,
    submitted,
    toasts,
    statuses,
    logs,
    invalidated,
    commands,
    tools,

    /** Lets every chain under way run as far as it can. */
    async settle(rounds = 40): Promise<void> {
      for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => setTimeout(() => resolve(), 1))
    },

    sidecar(): FakeSidecar {
      const s = sidecars[sidecars.length - 1]
      if (!s) throw new Error('no sidecar was spawned')
      return s
    },

    status(): {
      v: number
      paused: boolean
      queueDepth: number
      events: Record<string, { id: string; state: string; page: string; action: string; turnStartedAt: number | null; turnEndedAt: number | null; note: string | null }>
    } {
      const text = files.get(STATUS)
      if (text === undefined) throw new Error('status.json was not written')
      return JSON.parse(text)
    },

    stateOf(id: string): string | undefined {
      return kit.status().events[id]?.state
    },

    lastStatus(): string | undefined {
      return statuses[statuses.length - 1]
    },

    nextTurnId(): string {
      turnSeq += 1
      return `turn-${turnSeq}`
    },
  }
  return kit
}

export const COMPOSE_INPUT = {
  model: 'claude',
  promptModel: 'claude',
  surfaces: ['terminal'] as const,
  tools: [],
  outputStyle: null,
  traits: [],
}

let eventSeq = 0

/** An `event` line as the sidecar writes it. */
export function eventLine(
  over: {
    id?: string
    page?: string
    action?: string
    label?: string
    data?: Record<string, unknown>
    prompt?: string
    receivedAt?: number
  } = {},
) {
  eventSeq += 1
  const id = over.id ?? `ev_${String(eventSeq).padStart(10, '0')}`
  const page = over.page ?? 'triage.html'
  return {
    type: 'event',
    id,
    receivedAt: over.receivedAt ?? T0,
    servedPage: page,
    body: {
      v: 1,
      page,
      action: over.action ?? 'fix',
      label: over.label ?? 'Fix this',
      data: over.data ?? { test: `test_${eventSeq}` },
      ...(over.prompt !== undefined ? { prompt: over.prompt } : {}),
    },
  }
}

export const BAND = {
  plugin: 'artifact-callbacks',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
