// Runtime-agnostic harness for the listener conformance suite.
// Spawns the listener from CB_LISTENER_CMD (default "node sidecar/listener.mjs"),
// run from the plugin folder, and talks raw HTTP via node:http so tests control
// Host, Origin and every other header.

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LISTENER_CMD = (process.env.CB_LISTENER_CMD || 'node sidecar/listener.mjs').trim().split(/\s+/)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function hmac (secret, msg) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(msg, 'utf8').digest('hex')
}

export function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** Poll `fn` until it returns a truthy value or `timeout` ms pass. */
export async function waitFor (fn, { timeout = 5000, interval = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(interval)
  }
}

export function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Temp folder layout: root/, run/status.json, run/streams/. */
export function makeDirs () {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cb-conf-')))
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
export async function startListener ({ env = {}, dirs = makeDirs(), wait = true, argv = LISTENER_CMD } = {}) {
  const secret = env.CB_SECRET ?? randomBytes(32).toString('hex')
  const fullEnv = {
    ...process.env,
    CB_PORT: '0',
    CB_ROOT: dirs.root,
    CB_STATUS_FILE: dirs.statusFile,
    CB_SECRET: secret,
    ...env
  }
  for (const [k, v] of Object.entries(fullEnv)) if (v === undefined) delete fullEnv[k]
  const child = spawn(argv[0], argv.slice(1), { cwd: PLUGIN_DIR, env: fullEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end() // the mod closes stdin immediately
  const L = {
    child,
    dirs,
    root: dirs.root,
    statusFile: dirs.statusFile,
    secret,
    lines: [],
    raw: [],
    stderr: '',
    exit: null,
    port: null,
    pid: null
  }
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      L.raw.push(line)
      try {
        L.lines.push(JSON.parse(line))
      } catch {
        L.lines.push({ type: '__unparsable__', line })
      }
    }
  })
  child.stdout.on('error', () => {})
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { L.stderr += d })
  L.exited = new Promise((resolve) => child.once('exit', (code, signal) => { L.exit = { code, signal }; resolve(L.exit) }))

  L.waitLine = (pred, opts = {}) => waitFor(() => L.lines.find(pred), { what: 'stdout line', ...opts })
  L.linesOfType = (type) => L.lines.filter((l) => l.type === type)
  L.stop = async () => {
    if (L.exit === null) {
      child.kill('SIGKILL')
      await L.exited
    }
  }
  L.cleanup = async () => {
    await L.stop()
    rmSync(dirs.base, { recursive: true, force: true })
  }
  L.writeStatus = (obj) => {
    const tmp = L.statusFile + '.tmp'
    writeFileSync(tmp, typeof obj === 'string' ? obj : JSON.stringify({ v: 1, paused: false, queueDepth: 0, events: {}, ...obj }))
    renameSync(tmp, L.statusFile)
  }
  L.writePage = (rel, html) => {
    const p = join(dirs.root, ...rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, html)
    return p
  }
  L.req = (opts) => request({ port: L.port, ...opts })

  if (wait) {
    const ready = await waitFor(() => L.lines.find((l) => l.type === 'ready') || (L.exit && 'exit'),
      { timeout: 10000, what: 'ready line' })
    if (ready === 'exit') throw new Error(`listener exited early: ${JSON.stringify(L.exit)} ${L.raw.join('\n')} ${L.stderr}`)
    L.port = ready.port
    L.pid = ready.pid
    L.origin = `http://127.0.0.1:${L.port}`
    L.host = `127.0.0.1:${L.port}`
    L.cookieName = `cb_session_${L.port}`
    L.cookieValue = hmac(secret, String(L.port))
  }

  let markers = 0
  /** Flush point: every stdout line written before this call is in L.lines once it resolves. */
  L.marker = async () => {
    const path = `/__marker_${++markers}_${Date.now()}`
    await L.req({ path, host: 'marker.invalid' })
    const idx = await waitFor(() => {
      const i = L.lines.findIndex((l) => l.type === 'rejected' && l.path === path)
      return i >= 0 ? i + 1 : 0
    }, { what: 'marker line' })
    return idx - 1
  }

  /** GET a page (writing it first when html given) and return its Cookie header value. */
  L.serve = async (rel, html) => {
    if (html !== undefined) L.writePage(rel, html)
    const r = await L.req({ path: '/a/' + rel })
    if (r.status !== 200) throw new Error(`serve ${rel}: ${r.status}`)
    const sc = r.headers['set-cookie']
    return sc ? sc[0].split(';')[0] : null
  }

  /** POST /_cb/event with sane same-origin defaults; `headers` entries set to undefined are removed. */
  L.post = (body, { headers = {}, page = 'p.html', raw } = {}) => {
    const h = {
      origin: L.origin,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      cookie: `${L.cookieName}=${L.cookieValue}`,
      referer: `${L.origin}/a/${page}`,
      ...headers
    }
    return L.req({ method: 'POST', path: '/_cb/event', headers: h, body: raw ?? JSON.stringify(body) })
  }

  L.getEvent = (id, { headers = {}, suffix = '' } = {}) => L.req({
    path: `/_cb/events/${id}${suffix}`,
    headers: { cookie: `${L.cookieName}=${L.cookieValue}`, 'sec-fetch-site': 'same-origin', ...headers }
  })

  return L
}

/**
 * Raw HTTP request. `host` overrides the Host header (default 127.0.0.1:<port>);
 * header values of undefined are dropped. Resolves { status, headers, body, json }.
 */
export function request (opts) {
  const { port, method = 'GET', path = '/', headers = {}, body, timeout = 5000 } = opts
  const host = Object.prototype.hasOwnProperty.call(opts, 'host') ? opts.host : `127.0.0.1:${port}`
  return new Promise((resolve, reject) => {
    const h = { host }
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete h[k.toLowerCase()]
      else h[k.toLowerCase()] = v
    }
    if (h.host === undefined) delete h.host
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false, setHost: false })
    req.setTimeout(timeout, () => req.destroy(new Error('client timeout')))
    req.once('error', reject)
    req.once('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: text, json })
      })
      res.once('error', reject)
    })
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

/** Open a raw TCP socket to the listener; resolves { socket, data(), closed }. */
export function rawSocket (port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (d) => { data += d })
    socket.on('error', () => {})
    const closed = new Promise((r) => socket.once('close', r))
    socket.once('connect', () => resolve({ socket, data: () => data, closed }))
    socket.once('error', reject)
  })
}

/** Assert the three headers every response carries, and no ACAO (cookie mode). */
export function assertBaseHeaders (assert, res, { acao = false } = {}) {
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['referrer-policy'], 'same-origin')
  if (!acao) {
    for (const k of Object.keys(res.headers)) assert.ok(!k.startsWith('access-control-'), `unexpected ${k}`)
  }
}

export const EVENT_ID = /^ev_[a-z0-9]{10}$/
