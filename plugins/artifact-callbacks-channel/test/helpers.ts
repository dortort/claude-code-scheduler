// Drives the real channel server (node server/server.ts) over stdio as Claude
// Code would, and talks to the listener it spawns over HTTP as a page would.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SERVER = join(ROOT, 'server', 'server.ts')

export type Json = Record<string, any>

export function sleep (ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitFor<T> (fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, timeoutMs = 8000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

export function tempProject (): string {
  return mkdtempSync(join(tmpdir(), 'cb-channel-'))
}

export interface Client {
  proc: ChildProcessWithoutNullStreams
  project: string
  /** Every message the server sent, in order. */
  messages: Json[]
  /** Channel notifications only. */
  channel (): Json[]
  stderr (): string
  request (method: string, params?: Json): Promise<Json>
  /** Raw JSON-RPC result (or error) for a request. */
  call (method: string, params?: Json): Promise<Json>
  notify (method: string, params?: Json): void
  send (line: string): void
  initialize (protocolVersion?: string): Promise<Json>
  tool (name: string, args?: Json): Promise<{ text: string; isError: boolean }>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  close (): Promise<void>
}

export interface StartOptions {
  env?: Record<string, string>
  project?: string
}

const live = new Set<ChildProcessWithoutNullStreams>()
process.on('exit', () => { for (const p of live) p.kill('SIGKILL') })

export function startServer (options: StartOptions = {}): Client {
  const project = options.project ?? tempProject()
  const proc = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? '', CB_PROJECT_DIR: project, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  live.add(proc)
  const messages: Json[] = []
  let err = ''
  let buf = ''
  const waiting = new Map<number | string, (m: Json) => void>()
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (line.trim() === '') continue
      const m = JSON.parse(line) as Json
      messages.push(m)
      if (m.id !== undefined && m.id !== null && waiting.has(m.id)) {
        const w = waiting.get(m.id)
        waiting.delete(m.id)
        w?.(m)
      }
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (c: string) => { err += c })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    proc.once('exit', (code, signal) => { live.delete(proc); r({ code, signal }) })
  })
  let nextId = 1

  const client: Client = {
    proc,
    project,
    messages,
    channel: () => messages.filter((m) => m.method === 'notifications/claude/channel'),
    stderr: () => err,
    send (line) { proc.stdin.write(`${line}\n`) },
    call (method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no answer to ${method}\n${err}`)), 10000)
        waiting.set(id, (m) => { clearTimeout(t); resolve(m) })
        client.send(JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }))
      })
    },
    async request (method, params) {
      const m = await client.call(method, params)
      if (m.error) throw new Error(`${method}: ${m.error.code} ${m.error.message}`)
      return m.result as Json
    },
    notify (method, params) {
      client.send(JSON.stringify(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }))
    },
    async initialize (protocolVersion = '2025-06-18') {
      const r = await client.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      client.notify('notifications/initialized')
      return r
    },
    async tool (name, args = {}) {
      const r = await client.request('tools/call', { name, arguments: args })
      return { text: r.content.map((c: Json) => c.text).join('\n'), isError: r.isError === true }
    },
    exited,
    async close () {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.stdin.end()
        const t = setTimeout(() => proc.kill('SIGKILL'), 5000)
        await exited
        clearTimeout(t)
      }
    },
  }
  return client
}

/** The listener's port and pid, from callbacks_status once it is up. */
export async function listenerInfo (c: Client): Promise<{ port: number; pid: number }> {
  return waitFor(async () => {
    const { text } = await c.tool('callbacks_status')
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/a\/<file> \(pid (\d+)\)/.exec(text)
    return m ? { port: Number(m[1]), pid: Number(m[2]) } : undefined
  }, 'the listener to be up')
}

/** The run folder (status.json, streams/) of the only server in `project`. */
export function runDir (project: string): string {
  const base = join(project, '.claude', '.artifact-callbacks')
  const dirs = readdirSync(base).filter((d) => d.startsWith('channel-'))
  if (dirs.length !== 1) throw new Error(`expected one run dir, found ${dirs.join(', ')}`)
  return join(base, dirs[0] ?? '')
}

export function readStatus (project: string): Json {
  return JSON.parse(readFileSync(join(runDir(project), 'status.json'), 'utf8')) as Json
}

export function writePage (project: string, name: string, html: string): void {
  const file = join(project, '.claude', 'artifacts', name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html)
}

export interface HttpResult { status: number; headers: Record<string, string | string[] | undefined>; body: string }

export function http (port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Serves `page` once (as a browser would) and returns the session cookie header. */
export async function pageCookie (port: number, page: string): Promise<string> {
  const r = await http(port, 'GET', `/a/${page}`)
  if (r.status !== 200) throw new Error(`GET /a/${page}: ${r.status}`)
  const set = r.headers['set-cookie']
  const first = Array.isArray(set) ? set[0] : set
  if (!first) throw new Error('no cookie')
  return first.split(';')[0] ?? ''
}

/** POSTs an event from `page` the way client.js does. */
export async function postEvent (port: number, page: string, cookie: string, body: Json): Promise<HttpResult & { json: Json }> {
  const origin = `http://127.0.0.1:${port}`
  const r = await http(port, 'POST', '/_cb/event', {
    origin,
    referer: `${origin}/a/${page}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    cookie,
  }, JSON.stringify({ v: 1, page, ...body }))
  return { ...r, json: r.body ? JSON.parse(r.body) as Json : {} }
}

export function isAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
