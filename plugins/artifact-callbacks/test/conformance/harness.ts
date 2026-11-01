// Harness for the listener conformance suite.
// Spawns the listener from CB_LISTENER_CMD (default "node sidecar/listener.ts"),
// run from the plugin folder, and talks raw HTTP via node:http so tests control
// Host, Origin and every other header.

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import http from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type assertModule from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LISTENER_CMD: string[] = (process.env.CB_LISTENER_CMD || 'node sidecar/listener.ts').trim().split(/\s+/)

/**
 * One stdout line as the listener under test printed it. Deliberately loose:
 * the suite asserts the shape against the contract (StdoutLine in sidecar/lib.ts)
 * rather than assuming it. Unparsable lines show up as `__unparsable__`.
 */
export type Line = { type: string; [key: string]: any }

/** Request headers for request(); entries set to undefined are removed. */
export type Headers = { [name: string]: string | string[] | number | undefined }

export interface Response {
  status: number
  headers: IncomingHttpHeaders
  body: string
  /** The body parsed as JSON, or undefined. */
  json: any
}

export interface RequestOptions {
  port: number
  method?: string
  path?: string
  /** Host header; defaults to 127.0.0.1:<port>, undefined sends none. */
  host?: string | undefined
  headers?: Headers
  body?: string | Buffer
  timeout?: number
}

export interface Dirs {
  base: string
  root: string
  run: string
  streams: string
  statusFile: string
}

export interface ExitInfo { code: number | null; signal: NodeJS.Signals | null }

export interface StartOptions {
  /** Extra or overriding env vars; undefined removes one. */
  env?: { [name: string]: string | undefined }
  dirs?: Dirs
  /** Resolve after the ready line (default true). */
  wait?: boolean
  argv?: string[]
}

export interface PostOptions {
  headers?: Headers
  page?: string
  raw?: string
}

export interface Listener {
  child: ChildProcessWithoutNullStreams
  dirs: Dirs
  root: string
  statusFile: string
  secret: string
  lines: Line[]
  raw: string[]
  stderr: string
  exit: ExitInfo | null
  exited: Promise<ExitInfo>
  /** Set from the ready line (when started with wait); 0 until then. */
  port: number
  pid: number
  origin: string
  host: string
  cookieName: string
  cookieValue: string
  waitLine (pred: (l: Line) => unknown, opts?: WaitOptions): Promise<Line>
  linesOfType (type: string): Line[]
  stop (): Promise<void>
  cleanup (): Promise<void>
  writeStatus (obj: string | { [key: string]: unknown }): void
  writePage (rel: string, html: string | Buffer): string
  req (opts: Omit<RequestOptions, 'port'>): Promise<Response>
  marker (): Promise<number>
  serve (rel: string, html?: string): Promise<string | null>
  post (body: unknown, opts?: PostOptions): Promise<Response>
  getEvent (id: string, opts?: { headers?: Headers; suffix?: string }): Promise<Response>
}

export interface WaitOptions { timeout?: number; interval?: number; what?: string }

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function hmac (secret: string, msg: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(msg, 'utf8').digest('hex')
}

export function freePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

/** Poll `fn` until it returns a truthy value or `timeout` ms pass. */
export async function waitFor<T> (fn: () => T | Promise<T>, { timeout = 5000, interval = 20, what = 'condition' }: WaitOptions = {}): Promise<NonNullable<T>> {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(interval)
  }
}

export function pidAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Temp folder layout: root/, run/status.json, run/streams/. */
export function makeDirs (): Dirs {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cb-conf-')))
  const root = join(base, 'artifacts')
  const run = join(base, 'run')
  const streams = join(run, 'streams')
  mkdirSync(root)
  mkdirSync(streams, { recursive: true })
  return { base, root, run, streams, statusFile: join(run, 'status.json') }
}

/**
 * Spawn a listener. Options: env (extra/override vars), dirs (from makeDirs),
 * wait (default true: resolve after the ready line), argv (override command).
 */
export async function startListener ({ env = {}, dirs = makeDirs(), wait = true, argv = LISTENER_CMD }: StartOptions = {}): Promise<Listener> {
  const secret = env.CB_SECRET ?? randomBytes(32).toString('hex')
  const fullEnv: { [name: string]: string | undefined } = {
    ...process.env,
    CB_PORT: '0',
    CB_ROOT: dirs.root,
    CB_STATUS_FILE: dirs.statusFile,
    CB_SECRET: secret,
    ...env
  }
  for (const [k, v] of Object.entries(fullEnv)) if (v === undefined) delete fullEnv[k]
  const [cmd = 'node', ...args] = argv
  const child = spawn(cmd, args, { cwd: PLUGIN_DIR, env: fullEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end() // the mod closes stdin immediately
  const lines: Line[] = []
  const raw: string[] = []
  let exitInfo: ExitInfo | null = null
  const exited = new Promise<ExitInfo>((resolve) => child.once('exit', (code, signal) => {
    exitInfo = { code, signal }
    L.exit = exitInfo
    resolve(exitInfo)
  }))

  let markers = 0
  const L: Listener = {
    child,
    dirs,
    root: dirs.root,
    statusFile: dirs.statusFile,
    secret,
    lines,
    raw,
    stderr: '',
    exit: exitInfo,
    exited,
    port: 0,
    pid: 0,
    origin: '',
    host: '',
    cookieName: '',
    cookieValue: '',

    waitLine: (pred, opts = {}) => waitFor(() => L.lines.find(pred), { what: 'stdout line', ...opts }),
    linesOfType: (type) => L.lines.filter((l) => l.type === type),
    stop: async () => {
      if (L.exit === null) {
        child.kill('SIGKILL')
        await L.exited
      }
    },
    cleanup: async () => {
      await L.stop()
      rmSync(dirs.base, { recursive: true, force: true })
    },
    writeStatus: (obj) => {
      const tmp = L.statusFile + '.tmp'
      writeFileSync(tmp, typeof obj === 'string' ? obj : JSON.stringify({ v: 1, paused: false, queueDepth: 0, events: {}, ...obj }))
      renameSync(tmp, L.statusFile)
    },
    writePage: (rel, html) => {
      const p = join(dirs.root, ...rel.split('/'))
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, html)
      return p
    },
    req: (opts) => request({ port: L.port, ...opts }),

    /** Flush point: every stdout line written before this call is in L.lines once it resolves. */
    marker: async () => {
      const path = `/__marker_${++markers}_${Date.now()}`
      await L.req({ path, host: 'marker.invalid' })
      const idx = await waitFor(() => {
        const i = L.lines.findIndex((l) => l.type === 'rejected' && l.path === path)
        return i >= 0 ? i + 1 : 0
      }, { what: 'marker line' })
      return idx - 1
    },

    /** GET a page (writing it first when html given) and return its Cookie header value. */
    serve: async (rel, html) => {
      if (html !== undefined) L.writePage(rel, html)
      const r = await L.req({ path: '/a/' + rel })
      if (r.status !== 200) throw new Error(`serve ${rel}: ${r.status}`)
      const sc = r.headers['set-cookie']
      return sc && sc[0] ? sc[0].split(';')[0] ?? null : null
    },

    /** POST /_cb/event with sane same-origin defaults; `headers` entries set to undefined are removed. */
    post: (body, { headers = {}, page = 'p.html', raw: rawBody } = {}) => {
      const h: Headers = {
        origin: L.origin,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        cookie: `${L.cookieName}=${L.cookieValue}`,
        referer: `${L.origin}/a/${page}`,
        ...headers
      }
      return L.req({ method: 'POST', path: '/_cb/event', headers: h, body: rawBody ?? JSON.stringify(body) })
    },

    getEvent: (id, { headers = {}, suffix = '' } = {}) => L.req({
      path: `/_cb/events/${id}${suffix}`,
      headers: { cookie: `${L.cookieName}=${L.cookieValue}`, 'sec-fetch-site': 'same-origin', ...headers }
    })
  }

  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      raw.push(line)
      try {
        lines.push(JSON.parse(line))
      } catch {
        lines.push({ type: '__unparsable__', line })
      }
    }
  })
  child.stdout.on('error', () => {})
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => { L.stderr += d })

  if (wait) {
    const ready = await waitFor<Line | 'exit' | undefined | null>(() => L.lines.find((l) => l.type === 'ready') || (L.exit && 'exit'),
      { timeout: 10000, what: 'ready line' })
    if (ready === 'exit') throw new Error(`listener exited early: ${JSON.stringify(L.exit)} ${L.raw.join('\n')} ${L.stderr}`)
    L.port = ready.port as number
    L.pid = ready.pid as number
    L.origin = `http://127.0.0.1:${L.port}`
    L.host = `127.0.0.1:${L.port}`
    L.cookieName = `cb_session_${L.port}`
    L.cookieValue = hmac(secret, String(L.port))
  }

  return L
}

/**
 * Raw HTTP request. `host` overrides the Host header (default 127.0.0.1:<port>);
 * header values of undefined are dropped. Resolves { status, headers, body, json }.
 */
export function request (opts: RequestOptions): Promise<Response> {
  const { port, method = 'GET', path = '/', headers = {}, body, timeout = 5000 } = opts
  const host = Object.prototype.hasOwnProperty.call(opts, 'host') ? opts.host : `127.0.0.1:${port}`
  return new Promise((resolve, reject) => {
    const h: OutgoingHttpHeaders = { host }
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete h[k.toLowerCase()]
      else h[k.toLowerCase()] = v
    }
    if (h.host === undefined) delete h.host
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false, setHost: false })
    req.setTimeout(timeout, () => req.destroy(new Error('client timeout')))
    req.once('error', reject)
    req.once('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: any
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json })
      })
      res.once('error', reject)
    })
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

export interface RawSocket { socket: net.Socket; data (): string; closed: Promise<unknown> }

/** Open a raw TCP socket to the listener; resolves { socket, data(), closed }. */
export function rawSocket (port: number): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (d: string) => { data += d })
    socket.on('error', () => {})
    const closed = new Promise((r) => socket.once('close', r))
    socket.once('connect', () => resolve({ socket, data: () => data, closed }))
    socket.once('error', reject)
  })
}

/** Assert the three headers every response carries, and no ACAO (cookie mode). */
export function assertBaseHeaders (assert: typeof assertModule, res: Pick<Response, 'headers'>, { acao = false }: { acao?: boolean } = {}): void {
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['referrer-policy'], 'same-origin')
  if (!acao) {
    for (const k of Object.keys(res.headers)) assert.ok(!k.startsWith('access-control-'), `unexpected ${k}`)
  }
}

export const EVENT_ID = /^ev_[a-z0-9]{10}$/
