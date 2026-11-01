// Runs the listener (sidecar/listener.ts, the same file the mod spawns) as a
// child process and keeps it running: NDJSON stdout lines go to `onLine`, an
// unexpected exit restarts it after 1 s, 5 s, 30 s (kept port when it was
// free), and after the third failed restart it stays down. A run of
// `healthyMs` without exiting resets the count.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { StdoutLine } from '../../sidecar/lib.ts'

export const BACKOFF_MS: readonly number[] = [1000, 5000, 30000]
export const HEALTHY_MS = 60_000

export type ListenerState = 'starting' | 'up' | 'restarting' | 'down' | 'stopped'

export interface ListenerStatus {
  state: ListenerState
  port: number | null
  pid: number | null
  /** Restarts since the last healthy run. */
  restarts: number
  /** Why it is down or restarting (the last `error` line or the exit). */
  reason: string | null
}

export interface SupervisorOptions {
  /** argv[0] for the child: the running Node (process.execPath). */
  node: string
  /** Absolute path of listener.ts. */
  listener: string
  /** CB_* variables for the child, without CB_PORT. */
  env: Record<string, string>
  /** Configured port (0 = random). */
  port: number
  backoffMs?: readonly number[]
  healthyMs?: number
  onLine: (line: StdoutLine) => void
  onStatus?: (status: ListenerStatus) => void
  log: (message: string) => void
}

function parseStdout (text: string): StdoutLine | undefined {
  try {
    const v: unknown = JSON.parse(text)
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { type?: unknown }).type === 'string') {
      return v as StdoutLine
    }
  } catch {
    // not JSON: the listener never prints such a line; ignore it
  }
  return undefined
}

/** Environment the child inherits: just enough to run Node, plus CB_*. */
function baseEnv (): Record<string, string> {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']
  const out: Record<string, string> = {}
  for (const k of keep) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

export class Supervisor {
  private readonly o: SupervisorOptions
  private readonly backoff: readonly number[]
  private readonly healthyMs: number
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private healthyTimer: NodeJS.Timeout | null = null
  private lastPort: number | null = null
  private lastError: { reason: string; message: string } | null = null
  private waiters: (() => void)[] = []
  private exited: Promise<void> = Promise.resolve()
  readonly status: ListenerStatus = { state: 'stopped', port: null, pid: null, restarts: 0, reason: null }

  constructor (options: SupervisorOptions) {
    this.o = options
    this.backoff = options.backoffMs ?? BACKOFF_MS
    this.healthyMs = options.healthyMs ?? HEALTHY_MS
  }

  start (): void {
    if (this.child || this.status.state === 'up' || this.status.state === 'starting') return
    this.status.restarts = 0
    this.spawnOnce('starting')
  }

  /** Resolves once the listener is up or down, or after `ms`. */
  waitSettled (ms: number): Promise<void> {
    if (this.status.state === 'up' || this.status.state === 'down' || this.status.state === 'stopped') return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      const self = this
      function done (): void {
        clearTimeout(t)
        self.waiters = self.waiters.filter((w) => w !== done)
        resolve()
      }
      this.waiters.push(done)
    })
  }

  /** Stops the listener for good and waits (at most 3 s) for it to exit. */
  async stop (): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    if (this.healthyTimer) clearTimeout(this.healthyTimer)
    this.timer = null
    this.healthyTimer = null
    const child = this.child
    this.set({ state: 'stopped', port: null, pid: null, reason: null })
    if (!child) return
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
    await this.exited
    clearTimeout(kill)
  }

  private set (patch: Partial<ListenerStatus>): void {
    Object.assign(this.status, patch)
    if (this.status.state !== 'starting' && this.status.state !== 'restarting') {
      const ws = this.waiters
      this.waiters = []
      for (const w of ws) w()
    }
    this.o.onStatus?.({ ...this.status })
  }

  private spawnOnce (state: 'starting' | 'restarting'): void {
    const port = this.lastPort ?? this.o.port
    this.lastError = null
    const child = spawn(this.o.node, [this.o.listener], {
      env: { ...baseEnv(), ...this.o.env, CB_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.set({ state, pid: child.pid ?? null, port: null })
    let resolveExit: () => void = () => {}
    this.exited = new Promise((resolve) => { resolveExit = resolve })

    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const text = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (text === '') continue
        const line = parseStdout(text)
        if (!line || this.child !== child) continue
        if (line.type === 'ready') {
          this.lastPort = line.port
          this.set({ state: 'up', port: line.port, pid: line.pid, reason: null })
          if (this.healthyTimer) clearTimeout(this.healthyTimer)
          this.healthyTimer = setTimeout(() => { this.status.restarts = 0 }, this.healthyMs)
          this.healthyTimer.unref()
        } else if (line.type === 'error') {
          this.lastError = { reason: line.reason, message: line.message }
        }
        this.o.onLine(line)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const l of chunk.split('\n')) if (l.trim() !== '') this.o.log(`listener: ${l}`)
    })
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.child !== child) return
      this.child = null
      if (this.healthyTimer) clearTimeout(this.healthyTimer)
      this.healthyTimer = null
      resolveExit()
      if (this.status.state === 'stopped') return
      const why = this.lastError
        ? `${this.lastError.reason}: ${this.lastError.message}`
        : `exited (${signal ?? `code ${code}`})`
      // A kept port that is now taken: the next try takes a fresh one (unless the user fixed it).
      if (this.lastError?.reason === 'port-in-use' && this.o.port === 0) this.lastPort = null
      this.scheduleRestart(why)
    }
    child.once('exit', onExit)
    child.once('error', (err) => {
      this.lastError = { reason: 'spawn', message: err.message }
      onExit(null, null)
    })
  }

  private scheduleRestart (why: string): void {
    const n = this.status.restarts
    const delay = this.backoff[n]
    if (delay === undefined) {
      this.log(`listener down after ${n} restarts: ${why}`)
      this.set({ state: 'down', port: null, pid: null, reason: why })
      return
    }
    this.log(`listener ${why}; restarting in ${delay} ms`)
    this.set({ state: 'restarting', port: null, pid: null, reason: why, restarts: n + 1 })
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.status.state === 'restarting') this.spawnOnce('restarting')
    }, delay)
  }

  private log (message: string): void {
    this.o.log(message)
  }
}
