#!/usr/bin/env node
// Artifact Callbacks loopback listener (Node >= 22.18, stdlib only, run as `node listener.ts`).
// Contract: ../docs/CONTRACT.md. Reports on stdout as NDJSON; diagnostics on stderr.

import http from 'node:http'
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { readFileSync, statSync, realpathSync, createReadStream } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

import {
  MAX_BODY_BYTES, QUEUE_CAP, TERMINAL_STATES, EVENT_ID_RE, SECRET_RE,
  cookieValue, cookieName, pageToken, safeEqual, newEventId, parseCookies,
  isAllowedHost, isAllowedOrigin, isJsonContentType, requestPath, normalizeArtifactPath,
  pageFromBody, pageFromFileBody, pageFromReferer, resolveInsideRoot, mimeFor, isHtmlPath,
  extractPromptTemplates, validateBody, parseStatus, publicRecord, isEventRecord, EMPTY_STATUS,
  RateLimiter, IdempotencyCache, sseFrame, NdjsonSplitter, streamLine, isOrphaned
} from './lib.ts'
import type {
  StdoutLine, RejectedLine, RejectReason, ErrorReason, DropReason, EventBody, Status,
  StatusEventRecord, OwnRecord
} from './lib.ts'

type Req = IncomingMessage
type Res = ServerResponse

const STREAM_POLL_MS = 250
const OWN_RECORD_CAP = 1000

// ---------------------------------------------------------------------------
// stdout

let exiting = false
function exitNow (code: number): void {
  if (exiting) return
  exiting = true
  process.exit(code)
}

process.stdout.on('error', () => exitNow(0)) // EPIPE: the mod went away

function emit (obj: StdoutLine): void {
  if (exiting) return
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch {
    exitNow(0)
  }
}

function fatal (reason: ErrorReason, message: string, code = 1): void {
  if (exiting) return
  exiting = true
  const line: StdoutLine = { type: 'error', reason, message }
  try {
    process.stdout.write(JSON.stringify(line) + '\n', () => process.exit(code))
  } catch {
    process.exit(code)
  }
  setTimeout(() => process.exit(code), 500).unref()
}

// ---------------------------------------------------------------------------
// configuration

const env = process.env
const here = dirname(fileURLToPath(import.meta.url))

function intEnv (name: string, dflt: number, min: number, max: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return dflt
  if (!/^[0-9]+$/.test(raw)) return NaN
  const n = Number(raw)
  return n >= min && n <= max ? n : NaN
}

interface Config {
  port: number
  root: string | undefined
  statusFile: string | undefined
  secret: string | undefined
  allowFile: boolean
  streamDir: string | null
  clientJs: string
  timeoutMs: number
  pingMs: number
}

/** Config after checkConfig passed. */
interface CheckedConfig extends Config {
  root: string
  statusFile: string
  secret: string
}

const cfg: Config = {
  port: intEnv('CB_PORT', 0, 0, 65535),
  root: env.CB_ROOT,
  statusFile: env.CB_STATUS_FILE,
  secret: env.CB_SECRET,
  allowFile: env.CB_ALLOW_FILE_ORIGIN === '1',
  streamDir: env.CB_STREAM_DIR || null,
  clientJs: env.CB_CLIENT_JS || join(here, 'client.js'),
  timeoutMs: intEnv('CB_REQUEST_TIMEOUT_MS', 10_000, 1, 3_600_000),
  pingMs: intEnv('CB_STREAM_PING_MS', 15_000, 1, 3_600_000)
}

function checkConfig (c: Config): [ErrorReason, string] | CheckedConfig {
  if (Number.isNaN(c.port)) return ['bad-config', 'CB_PORT must be an integer 0-65535']
  if (Number.isNaN(c.timeoutMs)) return ['bad-config', 'CB_REQUEST_TIMEOUT_MS must be a positive integer']
  if (Number.isNaN(c.pingMs)) return ['bad-config', 'CB_STREAM_PING_MS must be a positive integer']
  if (typeof c.secret !== 'string' || !SECRET_RE.test(c.secret)) return ['bad-config', 'CB_SECRET must be at least 32 hex characters']
  if (!c.statusFile || !isAbsolute(c.statusFile)) return ['bad-config', 'CB_STATUS_FILE must be an absolute path']
  if (c.streamDir && !isAbsolute(c.streamDir)) return ['bad-config', 'CB_STREAM_DIR must be an absolute path']
  if (!c.root || !isAbsolute(c.root)) return ['bad-config', 'CB_ROOT must be an absolute path']
  try {
    if (!statSync(c.root).isDirectory()) return ['root-missing', 'CB_ROOT is not a directory']
  } catch {
    return ['root-missing', 'CB_ROOT does not exist']
  }
  return { ...c, root: c.root, statusFile: c.statusFile, secret: c.secret }
}

const checked = checkConfig(cfg)
if (Array.isArray(checked)) {
  fatal(checked[0], checked[1])
} else {
  start(checked)
}

// ---------------------------------------------------------------------------
// server

interface ReadAuth { tokenMode: boolean }

type BodyResult = { buf: Buffer } | { tooLarge: true } | { aborted: true }

function headerString (v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function start (cfg: CheckedConfig): void {
  const rootReal = realpathSync(cfg.root)
  const rootCandidates = [...new Set([cfg.root.replace(/\/+$/, ''), rootReal])]
  let port = 0
  let cookie = ''
  let cookieKey = ''
  const servedPages = new Set<string>()
  const own = new Map<string, OwnRecord>()
  const idem = new IdempotencyCache()
  const rate = new RateLimiter()
  let lastStatus: Status = EMPTY_STATUS

  function readStatus (): Status {
    let text: string
    try {
      text = readFileSync(cfg.statusFile, 'utf8')
    } catch {
      return lastStatus
    }
    const parsed = parseStatus(text)
    if (parsed) lastStatus = parsed
    return lastStatus
  }

  function remember (id: string, rec: OwnRecord): void {
    own.set(id, rec)
    if (own.size > OWN_RECORD_CAP) {
      const oldest = own.keys().next()
      if (!oldest.done) own.delete(oldest.value)
    }
  }

  function lookup (id: string, status: Status = readStatus()): StatusEventRecord | OwnRecord | undefined {
    const rec = status.events[id]
    if (isEventRecord(rec)) return rec
    return own.get(id)
  }

  // --- responses -----------------------------------------------------------

  function baseHeaders (res: Res): void {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
  }

  function bare (res: Res, status: number, extra: OutgoingHttpHeaders = {}): void {
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) res.setHeader(k, v)
    res.setHeader('Content-Length', '0')
    res.writeHead(status)
    res.end()
  }

  function json (res: Res, status: number, obj: unknown, extra: OutgoingHttpHeaders = {}): void {
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) res.setHeader(k, v)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(body.length))
    res.writeHead(status)
    res.end(body)
  }

  function rejectedLine (req: Req, path: string, reason: RejectReason): RejectedLine {
    const line: RejectedLine = { type: 'rejected', reason, path }
    if (req.headers.origin !== undefined) line.origin = String(req.headers.origin)
    return line
  }

  function reject (req: Req, res: Res, path: string, reason: RejectReason, status = 403, obj: unknown = null): void {
    emit(rejectedLine(req, path, reason))
    if (obj) json(res, status, obj)
    else bare(res, status)
  }

  function corsNull (res: Res): void {
    res.setHeader('Access-Control-Allow-Origin', 'null')
    res.setHeader('Vary', 'Origin')
  }

  // --- auth shared by GET /_cb/events/* -----------------------------------

  /** Returns { tokenMode } or answers the request itself and returns null. */
  function authRead (req: Req, res: Res, path: string): ReadAuth | null {
    const origin = req.headers.origin
    const tokenMode = cfg.allowFile && origin === 'null'
    if (origin !== undefined && !tokenMode && !isAllowedOrigin(origin, port)) {
      reject(req, res, path, 'origin')
      return null
    }
    if (tokenMode) {
      if (typeof req.headers['x-cb-token'] !== 'string') {
        reject(req, res, path, 'auth')
        return null
      }
      return { tokenMode }
    }
    const sfs = req.headers['sec-fetch-site']
    if (sfs !== undefined && sfs !== 'same-origin') {
      reject(req, res, path, 'sec-fetch-site')
      return null
    }
    if (!safeEqual(parseCookies(req.headers.cookie).get(cookieKey), cookie)) {
      reject(req, res, path, 'auth')
      return null
    }
    return { tokenMode }
  }

  function eventForRead (req: Req, res: Res, path: string, id: string, auth: ReadAuth): StatusEventRecord | OwnRecord | null {
    const rec = lookup(id)
    if (!rec) {
      bare(res, 404)
      return null
    }
    if (auth.tokenMode) {
      const page = typeof rec.page === 'string' ? rec.page : ''
      if (!page || !safeEqual(req.headers['x-cb-token'], pageToken(cfg.secret, page))) {
        reject(req, res, path, 'auth')
        return null
      }
      corsNull(res)
    }
    return rec
  }

  // --- routes --------------------------------------------------------------

  function health (_req: Req, res: Res): void {
    json(res, 200, { ok: true, paused: readStatus().paused })
  }

  function clientJs (_req: Req, res: Res): void {
    let body: Buffer
    try {
      body = readFileSync(cfg.clientJs)
    } catch (err) {
      process.stderr.write(`artifact-callbacks: cannot read client.js: ${(err as Error).message}\n`)
      bare(res, 404)
      return
    }
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.setHeader('Content-Length', String(body.length))
    res.writeHead(200)
    res.end(body)
  }

  async function artifact (_req: Req, res: Res, path: string): Promise<void> {
    const rel = normalizeArtifactPath(path.slice(3))
    const real = await resolveInsideRoot(rootReal, rel)
    if (!real || rel === null) return bare(res, 404)
    const stream = createReadStream(real)
    stream.once('error', () => {
      if (!res.headersSent) bare(res, 404)
      else res.destroy()
    })
    stream.once('open', () => {
      if (isHtmlPath(rel)) {
        servedPages.add(rel)
        res.setHeader('Set-Cookie', `${cookieKey}=${cookie}; HttpOnly; SameSite=Strict; Path=/`)
      }
      res.setHeader('Content-Type', mimeFor(rel))
      res.writeHead(200)
      stream.pipe(res)
    })
  }

  function readBody (req: Req): Promise<BodyResult> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const finish = (v: BodyResult): void => {
        if (done) return
        done = true
        req.removeListener('data', onData)
        resolve(v)
      }
      const onData = (chunk: Buffer): void => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          chunks.length = 0
          finish({ tooLarge: true })
          return
        }
        chunks.push(chunk)
      }
      req.on('data', onData)
      req.once('end', () => finish({ buf: Buffer.concat(chunks) }))
      req.once('error', () => finish({ aborted: true }))
      req.once('close', () => finish({ aborted: true }))
    })
  }

  function dropOrAccept (res: Res, value: EventBody, page: string): void {
    const now = Date.now()
    const status = readStatus()
    let reason: DropReason | null = null
    if (status.paused) reason = 'paused'
    else if (status.queueDepth >= QUEUE_CAP) reason = 'queue-full'
    else if (!rate.allow(page, now)) reason = 'rate-limit'
    const id = newEventId()
    if (value.idempotencyKey !== undefined) idem.set(value.idempotencyKey, id, now)
    if (reason) {
      remember(id, { state: 'dropped', page, reason })
      emit({ type: 'dropped', id, reason, servedPage: page })
      return json(res, 429, { id, state: 'dropped', reason })
    }
    rate.record(page, now)
    remember(id, { state: 'queued', page })
    emit({ type: 'event', id, receivedAt: now, servedPage: page, body: { ...value, page } })
    json(res, 202, { id, state: 'queued' })
  }

  async function postEvent (req: Req, res: Res, path: string): Promise<void> {
    const h = req.headers
    const origin = h.origin
    const tokenMode = cfg.allowFile && origin === 'null'
    // a. Origin
    if (origin === undefined || (!tokenMode && !isAllowedOrigin(origin, port))) return reject(req, res, path, 'origin')
    // b. Sec-Fetch-Site (cookie mode only)
    if (!tokenMode && h['sec-fetch-site'] !== undefined && h['sec-fetch-site'] !== 'same-origin') {
      return reject(req, res, path, 'sec-fetch-site')
    }
    // c. Content-Type
    if (!isJsonContentType(h['content-type'])) return reject(req, res, path, 'content-type')
    // d. Auth (token mode verifies the token after the body names the page)
    if (tokenMode) {
      if (typeof h['x-cb-token'] !== 'string') return reject(req, res, path, 'auth')
    } else if (!safeEqual(parseCookies(h.cookie).get(cookieKey), cookie)) {
      return reject(req, res, path, 'auth')
    }
    // e. Size
    const declared = h['content-length']
    if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) return reject(req, res, path, 'too-large', 413)
    const got = await readBody(req)
    if ('aborted' in got) return
    if ('tooLarge' in got) return reject(req, res, path, 'too-large', 413)
    // f. Schema
    let parsed: unknown
    let parseError = false
    try {
      parsed = JSON.parse(got.buf.toString('utf8'))
    } catch {
      parseError = true
    }
    let page: string | null = null
    if (tokenMode) {
      // d (token mode). Unauthenticated callers learn nothing about the schema.
      page = parseError || parsed === null || typeof parsed !== 'object'
        ? null
        : pageFromFileBody((parsed as { page?: unknown }).page, rootCandidates)
      if (!page || !safeEqual(h['x-cb-token'], pageToken(cfg.secret, page)) || !(await resolveInsideRoot(rootReal, page))) {
        return reject(req, res, path, 'auth')
      }
      corsNull(res)
    }
    if (parseError) return reject(req, res, path, 'body', 400, { error: 'body is not valid JSON' })
    const v = validateBody(parsed)
    if (v.error !== undefined) return reject(req, res, path, 'body', 400, { error: v.error })
    const value = v.value
    // g. Page
    if (!tokenMode) {
      const fromRef = pageFromReferer(h.referer, port)
      const fromBody = pageFromBody(value.page)
      if (fromRef && servedPages.has(fromRef)) page = fromRef
      else if (fromBody && servedPages.has(fromBody)) page = fromBody
      else return reject(req, res, path, 'page')
    }
    if (page === null) return reject(req, res, path, 'page') // unreachable: both modes set it above
    value.page = page
    // h. Template
    if (value.prompt !== undefined) {
      const real = await resolveInsideRoot(rootReal, page)
      let html: string | null = null
      if (real) {
        try {
          html = await readFile(real, 'utf8')
        } catch {}
      }
      if (html === null || !extractPromptTemplates(html).includes(value.prompt)) {
        return reject(req, res, path, 'template-changed', 409, { error: 'template-changed' })
      }
    }
    // i. Idempotency
    if (value.idempotencyKey !== undefined) {
      const prior = idem.get(value.idempotencyKey, Date.now())
      if (prior) {
        const rec = lookup(prior)
        return json(res, 202, { id: prior, state: rec ? rec.state : 'queued' })
      }
    }
    // j/k. Admission and accept
    dropOrAccept(res, value, page)
  }

  function getEvent (req: Req, res: Res, path: string, id: string): void {
    const auth = authRead(req, res, path)
    if (!auth) return
    const rec = eventForRead(req, res, path, id, auth)
    if (!rec) return
    json(res, 200, publicRecord(id, rec))
  }

  function streamEvent (req: Req, res: Res, path: string, id: string): void {
    const auth = authRead(req, res, path)
    if (!auth) return
    if (!eventForRead(req, res, path, id, auth)) return
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.writeHead(200)
    res.write(': stream\n\n')

    const file = cfg.streamDir ? join(cfg.streamDir, id + '.ndjson') : null
    const splitter = new NdjsonSplitter()
    const decoder = new StringDecoder('utf8')
    let offset = 0
    let lastState: string | null = null
    let closed = false
    let timer: NodeJS.Timeout | undefined
    const ping = setInterval(() => { if (!closed) res.write(': ping\n\n') }, cfg.pingMs)

    const close = (): void => {
      if (closed) return
      closed = true
      clearInterval(ping)
      clearTimeout(timer)
      res.end()
    }
    res.on('close', () => {
      closed = true
      clearInterval(ping)
      clearTimeout(timer)
    })

    async function drain (): Promise<boolean> {
      if (!file) return false
      let fh: FileHandle
      try {
        fh = await open(file, 'r')
      } catch {
        return false
      }
      try {
        const { size } = await fh.stat()
        if (size < offset) offset = size // truncated: keep going from the new end
        while (offset < size && !closed) {
          const len = Math.min(64 * 1024, size - offset)
          const buf = Buffer.alloc(len)
          const { bytesRead } = await fh.read(buf, 0, len, offset)
          if (!bytesRead) break
          offset += bytesRead
          for (const obj of splitter.push(decoder.write(buf.subarray(0, bytesRead)))) {
            if (closed) return true
            const line = streamLine(obj)
            if (line === null) continue
            if (line.type === 'text') {
              res.write(sseFrame('text', line))
            } else if (line.type === 'state') {
              lastState = line.state
              res.write(sseFrame('state', line))
            } else {
              res.write(sseFrame('end', line))
              close()
              return true
            }
          }
        }
      } finally {
        await fh.close().catch(() => {})
      }
      return false
    }

    async function tick (): Promise<void> {
      if (closed) return
      try {
        if (await drain()) return
        const rec = lookup(id)
        if (rec && TERMINAL_STATES.has(rec.state)) {
          if (await drain()) return
          if (closed) return
          if (lastState !== rec.state) res.write(sseFrame('state', { type: 'state', state: rec.state }))
          res.write(sseFrame('end', { type: 'end' }))
          close()
          return
        }
      } catch (err) {
        process.stderr.write(`artifact-callbacks: stream error: ${(err as Error).message}\n`)
      }
      if (!closed) timer = setTimeout(tick, STREAM_POLL_MS)
    }
    void tick()
  }

  // --- dispatch ------------------------------------------------------------

  const EVENTS_RE = /^\/_cb\/events\/([^/]+)(\/stream)?$/

  function preflightAllowed (req: Req, path: string): boolean {
    return cfg.allowFile && req.headers.origin === 'null' && (path === '/_cb/event' || EVENTS_RE.test(path))
  }

  async function handle (req: Req, res: Res): Promise<void> {
    baseHeaders(res)
    const path = requestPath(req.url) ?? String(req.url)
    // 1. Host
    if (!isAllowedHost(req.headers.host, port)) return reject(req, res, path, 'host')
    // 2. OPTIONS
    if (req.method === 'OPTIONS') {
      if (preflightAllowed(req, path)) {
        corsNull(res)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST')
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-cb-token')
        res.setHeader('Access-Control-Max-Age', '600')
        if (headerString(req.headers['access-control-request-private-network']) === 'true') {
          res.setHeader('Access-Control-Allow-Private-Network', 'true')
        }
        return bare(res, 204)
      }
      return reject(req, res, path, 'method')
    }
    if (requestPath(req.url) === null) return bare(res, 404)
    const method = req.method
    const only = (m: string, fn: () => void | Promise<void>): void | Promise<void> => {
      if (method === m) return fn()
      emit(rejectedLine(req, path, 'method'))
      bare(res, 405, { Allow: m })
    }
    if (path === '/_cb/health') return only('GET', () => health(req, res))
    if (path === '/_cb/client.js') return only('GET', () => clientJs(req, res))
    if (path === '/_cb/event') return only('POST', () => postEvent(req, res, path))
    if (path.startsWith('/a/')) return only('GET', () => artifact(req, res, path))
    const m = EVENTS_RE.exec(path)
    const id = m?.[1]
    if (m && id !== undefined && EVENT_ID_RE.test(id)) {
      return only('GET', () => (m[2] ? streamEvent(req, res, path, id) : getEvent(req, res, path, id)))
    }
    bare(res, 404)
  }

  const server = http.createServer({
    requireHostHeader: false, // a missing Host gets our 403, not Node's 400
    requestTimeout: cfg.timeoutMs,
    headersTimeout: cfg.timeoutMs,
    connectionsCheckingInterval: Math.max(50, Math.min(1000, Math.floor(cfg.timeoutMs / 4)))
  }, (req, res) => {
    Promise.resolve(handle(req, res)).catch((err: unknown) => {
      const e = err as Error | null | undefined
      process.stderr.write(`artifact-callbacks: ${e && e.stack ? e.stack : String(err)}\n`)
      if (!res.headersSent) bare(res, 500)
      else res.destroy()
    })
  })

  server.on('clientError', (err: NodeJS.ErrnoException, socket: Socket & { _httpMessage?: unknown }) => {
    if (socket.destroyed) return
    if (socket._httpMessage || !socket.writable) {
      socket.destroy()
      return
    }
    const status = err && err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request'
    socket.end(`HTTP/1.1 ${status}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n` +
      'Referrer-Policy: same-origin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })

  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err && err.code === 'EADDRINUSE') fatal('port-in-use', `port ${cfg.port} is already in use`, 2)
    else fatal('bad-config', `cannot listen: ${err && err.message}`)
  })

  server.listen({ port: cfg.port, host: '127.0.0.1', exclusive: true }, () => {
    port = (server.address() as AddressInfo).port
    cookie = cookieValue(cfg.secret, port)
    cookieKey = cookieName(port)
    emit({ type: 'ready', port, pid: process.pid })
  })

  const shutdown = (): void => exitNow(0)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', shutdown)

  const parent = process.ppid
  setInterval(() => {
    if (isOrphaned(parent, process.ppid)) shutdown()
  }, 1000)
}
