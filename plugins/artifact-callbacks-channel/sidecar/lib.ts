// Pure helpers for the Artifact Callbacks listener (Node stdlib only).
// listener.ts imports these; test/unit covers them. Every behaviour here is
// pinned in docs/CONTRACT.md. The wire types below (event body, status.json,
// stdout lines) are exported for the tests and other components.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

// ---------------------------------------------------------------------------
// Wire types

/** Every state an event can be in (status.json and the sidecar's own records). */
export type EventState =
  | 'queued'
  | 'awaiting-approval'
  | 'running'
  | 'done'
  | 'rejected'
  | 'dropped'
  | 'expired'

/** Why the admission step dropped an event. */
export type DropReason = 'paused' | 'queue-full' | 'rate-limit'

/** `reason` of a `rejected` stdout line. */
export type RejectReason =
  | 'host'
  | 'origin'
  | 'sec-fetch-site'
  | 'content-type'
  | 'auth'
  | 'page'
  | 'body'
  | 'too-large'
  | 'template-changed'
  | 'method'

/** `reason` of an `error` stdout line. */
export type ErrorReason = 'port-in-use' | 'root-missing' | 'bad-config'

/** A JSON object as parsed from untrusted input. */
export type JsonObject = { [key: string]: unknown }

/** A POST /_cb/event body after validateBody: unknown keys dropped, `data` defaulted. */
export interface EventBody {
  v: 1
  action: string
  label?: string
  data: JsonObject
  prompt?: string
  idempotencyKey?: string
  page?: string
}

/** The body as reported on stdout: `page` is overwritten with the served page. */
export interface ReportedEventBody extends EventBody {
  page: string
}

export interface ReadyLine { type: 'ready'; port: number; pid: number }
export interface EventLine {
  type: 'event'
  id: string
  receivedAt: number
  servedPage: string
  body: ReportedEventBody
}
export interface RejectedLine { type: 'rejected'; reason: RejectReason; path: string; origin?: string }
export interface DroppedLine { type: 'dropped'; id: string; reason: DropReason; servedPage: string }
export interface ErrorLine { type: 'error'; reason: ErrorReason; message: string }

/** One NDJSON line the listener writes on stdout. */
export type StdoutLine = ReadyLine | EventLine | RejectedLine | DroppedLine | ErrorLine

/**
 * One record of status.json `events` as the mod writes it. The sidecar reads it
 * from disk, so every field is checked before use (see isEventRecord).
 */
export interface StatusEventRecord {
  id?: string
  state: string
  page?: unknown
  action?: unknown
  turnStartedAt?: unknown
  turnEndedAt?: unknown
  note?: unknown
  reason?: unknown
}

/** status.json after parseStatus: `events` values are still unchecked JSON. */
export interface Status {
  v: 1
  paused: boolean
  queueDepth: number
  events: { [id: string]: unknown }
}

/** A record of an id the sidecar itself issued. */
export interface OwnRecord {
  state: 'queued' | 'dropped'
  page: string
  reason?: DropReason
}

/** Body of `200` from GET /_cb/events/<id>. */
export interface PublicRecord {
  id: string
  state: string
  turnStartedAt?: unknown
  turnEndedAt?: unknown
  note?: unknown
  reason?: unknown
}

/** One line of a reply-stream file (`<stream dir>/<id>.ndjson`) the listener acts on. */
export type StreamLine =
  | { type: 'text'; text: string }
  | { type: 'state'; state: string }
  | { type: 'end' }

// ---------------------------------------------------------------------------
// Limits and patterns

export const MAX_BODY_BYTES = 16384
export const IDEMPOTENCY_WINDOW_MS = 60_000
export const RATE_WINDOW_MS = 60_000
export const RATE_LIMIT_PER_PAGE = 10
export const RATE_LIMIT_PER_SESSION = 30
export const QUEUE_CAP = 5
export const TERMINAL_STATES: ReadonlySet<string> = new Set<EventState>(['done', 'rejected', 'dropped', 'expired'])
export const EVENT_ID_RE = /^ev_[a-z0-9]{10}$/
export const ACTION_RE = /^[a-z0-9_-]{1,40}$/
export const SECRET_RE = /^[0-9a-fA-F]{32,}$/

// ---------------------------------------------------------------------------
// HMAC and constant-time comparison

/** HMAC-SHA256 over UTF-8 `msg` keyed by the UTF-8 bytes of `secret`, lowercase hex. */
export function hmacHex (secret: string, msg: string): string {
  return createHmac('sha256', Buffer.from(String(secret), 'utf8'))
    .update(Buffer.from(String(msg), 'utf8'))
    .digest('hex')
}

/** Value of the session cookie for a listener bound to `port`. */
export function cookieValue (secret: string, port: number): string {
  return hmacHex(secret, String(port))
}

/** Name of the session cookie. Port-scoped so two sessions on one host never clobber each other. */
export function cookieName (port: number): string {
  return `cb_session_${port}`
}

/** file:// token for a page path relative to the artifacts root. */
export function pageToken (secret: string, page: string): string {
  return hmacHex(secret, 'page:' + page)
}

/** Constant-time string equality (false for non-strings or different lengths). */
export function safeEqual (a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // Still spend comparable time so length is not trivially observable.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/** `ev_` + 10 chars of [a-z0-9] from a CSPRNG (rejection sampling, no modulo bias). */
export function newEventId (): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  while (out.length < 10) {
    for (const b of randomBytes(16)) {
      if (b < 252) out += alphabet[b % 36] // 252 = 7 * 36
      if (out.length === 10) break
    }
  }
  return 'ev_' + out
}

// ---------------------------------------------------------------------------
// Request helpers

/** Parse a Cookie header into a Map (first occurrence of a name wins). */
export function parseCookies (header: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    let value = part.slice(i + 1).trim()
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') value = value.slice(1, -1)
    if (name && !out.has(name)) out.set(name, value)
  }
  return out
}

/** Host header check: exactly 127.0.0.1:<port> or localhost:<port> (ASCII case-insensitive). */
export function isAllowedHost (host: unknown, port: number): boolean {
  if (typeof host !== 'string') return false
  const h = host.toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

/** Origins allowed for cookie mode. */
export function allowedOrigins (port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

export function isAllowedOrigin (origin: unknown, port: number): boolean {
  return typeof origin === 'string' && allowedOrigins(port).includes(origin.toLowerCase())
}

/** Content-Type must be application/json, parameters allowed. */
export function isJsonContentType (ct: unknown): boolean {
  if (typeof ct !== 'string') return false
  return (ct.split(';')[0] ?? '').trim().toLowerCase() === 'application/json'
}

/** Split a request target into pathname (no query/fragment). Returns null for non-origin-form targets. */
export function requestPath (url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('/')) return null
  const q = url.search(/[?#]/)
  return q < 0 ? url : url.slice(0, q)
}

// ---------------------------------------------------------------------------
// Artifact paths

/**
 * Turn the raw (still percent-encoded) part of a URL after `/a/` into a
 * root-relative page path such as `sub/x.html`, or null when it must be refused:
 * bad percent-encoding, NUL, backslash, empty segments, or any segment starting
 * with `.` (covers `.`, `..` and dotfiles).
 */
export function normalizeArtifactPath (raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  return checkRelativePath(decoded)
}

/** Same rules as normalizeArtifactPath for an already-decoded path. */
export function checkRelativePath (p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null
  if (p.includes('\0') || p.includes('\\')) return null
  const segs = p.split('/')
  for (const s of segs) {
    if (s === '' || s.startsWith('.')) return null
  }
  return segs.join('/')
}

/** Page path from a body `page` value: strip a leading `/a/` or `/`, then apply the path rules. */
export function pageFromBody (page: unknown): string | null {
  if (typeof page !== 'string') return null
  let p = page
  if (p.startsWith('/a/')) p = p.slice(3)
  else if (p.startsWith('/')) p = p.slice(1)
  return checkRelativePath(p)
}

/**
 * Page path for a token-mode body `page`: an absolute file path inside one of
 * `roots` (as given or realpath'd) is made relative; otherwise pageFromBody.
 */
export function pageFromFileBody (page: unknown, roots: readonly (string | null | undefined)[]): string | null {
  if (typeof page !== 'string') return null
  for (const r of roots) {
    if (!r) continue
    const prefix = r.endsWith('/') ? r : r + '/'
    if (page.startsWith(prefix)) return checkRelativePath(page.slice(prefix.length))
  }
  return pageFromBody(page)
}

/** Page path from a Referer URL: only same-origin referers under `/a/`. */
export function pageFromReferer (referer: unknown, port: number): string | null {
  if (typeof referer !== 'string') return null
  let u: URL
  try {
    u = new URL(referer)
  } catch {
    return null
  }
  if (!isAllowedOrigin(u.origin, port)) return null
  // u.pathname keeps percent-encoding; normalize like the /a/ route does.
  if (!u.pathname.startsWith('/a/')) return null
  return normalizeArtifactPath(u.pathname.slice(3))
}

/**
 * Resolve a normalized relative path inside `rootReal` (already realpath'd).
 * Returns the absolute real path of a regular file inside the root, else null.
 */
export async function resolveInsideRoot (rootReal: string, rel: string | null | undefined): Promise<string | null> {
  if (rel == null) return null
  const candidate = join(rootReal, ...rel.split('/'))
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return null
  }
  if (!real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)) return null
  try {
    const st = await stat(real)
    if (!st.isFile()) return null
  } catch {
    return null
  }
  return real
}

const MIME: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  map: 'application/json; charset=utf-8'
}

/** MIME type by (case-insensitive) extension; unknown → application/octet-stream. */
export function mimeFor (path: string): string {
  const base = String(path).split('/').pop() ?? ''
  const i = base.lastIndexOf('.')
  if (i <= 0) return 'application/octet-stream'
  const ext = base.slice(i + 1).toLowerCase()
  // Own keys only: `x.constructor` must not find Object.prototype.constructor.
  return (Object.hasOwn(MIME, ext) ? MIME[ext] : undefined) || 'application/octet-stream'
}

export function isHtmlPath (path: string): boolean {
  return mimeFor(path).startsWith('text/html')
}

// ---------------------------------------------------------------------------
// HTML attribute extraction (data-cb-prompt templates)

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * Decode the entities the contract names: `&amp; &lt; &gt; &quot; &apos;` and
 * numeric `&#N;` / `&#xH;` (which covers `&#39;`). Anything else stays as is.
 * Numeric references to 0, surrogates or > 0x10FFFF stay undecoded.
 */
export function decodeEntities (s: string): string {
  return String(s).replace(/&(?:#([0-9]{1,8})|#[xX]([0-9a-fA-F]{1,7})|([a-zA-Z]+));/g,
    (m: string, dec: string | undefined, hex: string | undefined, name: string | undefined): string => {
      if (name !== undefined) {
        return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] ?? m : m
      }
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16)
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m
      return String.fromCodePoint(cp)
    })
}

const WS: ReadonlySet<string | undefined> = new Set([' ', '\t', '\n', '\r', '\f'])

/**
 * Collect every value of attribute `attr` (ASCII case-insensitive name) in the
 * start tags of `html`. Values may be double-quoted, single-quoted or unquoted;
 * entities are decoded with decodeEntities. Comments, `<!...>` and `<?...>`
 * are skipped; a bare attribute (no `=`) yields the empty string.
 */
export function extractAttributeValues (html: string, attr: string): string[] {
  const want = attr.toLowerCase()
  const out: string[] = []
  const s = String(html)
  const n = s.length
  let i = 0
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) break
    i = lt + 1
    if (s.startsWith('!--', i)) {
      const end = s.indexOf('-->', i + 3)
      i = end < 0 ? n : end + 3
      continue
    }
    const c = s[i]
    if (c === '!' || c === '?' || c === '/') {
      const end = s.indexOf('>', i)
      i = end < 0 ? n : end + 1
      continue
    }
    if (!c || !/[A-Za-z]/.test(c)) continue
    // tag name
    while (i < n && !WS.has(s[i]) && s[i] !== '>' && s[i] !== '/') i++
    // attributes
    for (;;) {
      while (i < n && (WS.has(s[i]) || s[i] === '/')) i++
      if (i >= n) break
      if (s[i] === '>') { i++; break }
      const nameStart = i
      i++ // the first char may be '=' per HTML tokenizer rules
      while (i < n && !WS.has(s[i]) && s[i] !== '/' && s[i] !== '>' && s[i] !== '=') i++
      const name = s.slice(nameStart, i).toLowerCase()
      while (i < n && WS.has(s[i])) i++
      let value = ''
      if (s[i] === '=') {
        i++
        while (i < n && WS.has(s[i])) i++
        const q = s[i]
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, i + 1)
          const stop = end < 0 ? n : end
          value = s.slice(i + 1, stop)
          i = end < 0 ? n : end + 1
        } else {
          const start = i
          while (i < n && !WS.has(s[i]) && s[i] !== '>') i++
          value = s.slice(start, i)
        }
      }
      if (name === want) out.push(decodeEntities(value))
    }
  }
  return out
}

export function extractPromptTemplates (html: string): string[] {
  return extractAttributeValues(html, 'data-cb-prompt')
}

// ---------------------------------------------------------------------------
// Body schema

/** Length in Unicode code points. */
export function cpLength (s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

type OptionalStringKey = 'label' | 'prompt' | 'idempotencyKey' | 'page'

function optString (body: JsonObject, key: OptionalStringKey, max: number, out: Partial<EventBody>): string | null {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || cpLength(v) > max) return `${key} must be a string of at most ${max} characters`
  out[key] = v
  return null
}

function isJsonObject (v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export type ValidateResult = { value: EventBody; error?: undefined } | { error: string; value?: undefined }

/**
 * Validate a parsed event body. Returns `{ value }` with unknown keys dropped and
 * `data` defaulted to `{}`, or `{ error }` whose text starts with the offending
 * field name (or `body`). `null` for an optional field counts as absent.
 */
export function validateBody (body: unknown): ValidateResult {
  if (!isJsonObject(body)) return { error: 'body must be a JSON object' }
  if (body.v !== 1) return { error: 'v must be 1' }
  if (typeof body.action !== 'string' || !ACTION_RE.test(body.action)) return { error: 'action must match ^[a-z0-9_-]{1,40}$' }
  // Key order (kept on stdout): v, action, label?, data, prompt?, idempotencyKey?, page?
  const out: Partial<EventBody> = { v: 1, action: body.action }
  let err = optString(body, 'label', 200, out)
  if (err) return { error: err }
  let data: JsonObject
  if (body.data === undefined || body.data === null) data = {}
  else if (!isJsonObject(body.data)) return { error: 'data must be a JSON object' }
  else data = body.data
  out.data = data
  err = optString(body, 'prompt', 2000, out) ||
    optString(body, 'idempotencyKey', 100, out) ||
    optString(body, 'page', 300, out)
  if (err) return { error: err }
  return { value: { ...out, v: 1, action: body.action, data } }
}

// ---------------------------------------------------------------------------
// status.json

export const EMPTY_STATUS: Readonly<Status> = Object.freeze({ v: 1, paused: false, queueDepth: 0, events: {} })

/** Parse status.json text; returns null when unusable (caller keeps its last good parse). */
export function parseStatus (text: string): Status | null {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!isJsonObject(obj)) return null
  const events = isJsonObject(obj.events) ? obj.events : {}
  const depth = typeof obj.queueDepth === 'number' && Number.isFinite(obj.queueDepth) ? obj.queueDepth : 0
  return { v: 1, paused: obj.paused === true, queueDepth: depth, events }
}

/** True for a status.json `events` value the sidecar can use (an object with a string `state`). */
export function isEventRecord (rec: unknown): rec is StatusEventRecord {
  return rec !== null && typeof rec === 'object' && typeof (rec as { state?: unknown }).state === 'string'
}

/** Public view of an event record for GET /_cb/events/<id>. */
export function publicRecord (id: string, rec: StatusEventRecord | OwnRecord): PublicRecord {
  const out: PublicRecord = { id, state: rec.state }
  const r: { [key: string]: unknown } = { ...rec }
  for (const k of ['turnStartedAt', 'turnEndedAt', 'note'] as const) {
    if (r[k] !== undefined) out[k] = r[k]
  }
  if (rec.reason !== undefined) out.reason = rec.reason
  return out
}

// ---------------------------------------------------------------------------
// Rate limiting and idempotency

/** Sliding-window counter: allow() is true while fewer than `limit` hits fall in the trailing window. */
export class SlidingWindow {
  limit: number
  windowMs: number
  hits: Map<string, number[]> // key -> timestamps (ascending)

  constructor (limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
    this.hits = new Map()
  }

  _prune (key: string, now: number): number[] {
    const arr = this.hits.get(key)
    if (!arr) return []
    while (arr.length && (arr[0] ?? 0) <= now - this.windowMs) arr.shift()
    if (!arr.length) this.hits.delete(key)
    return arr
  }

  count (key: string, now: number): number {
    return this._prune(key, now).length
  }

  allow (key: string, now: number): boolean {
    return this.count(key, now) < this.limit
  }

  record (key: string, now: number): void {
    this._prune(key, now)
    const arr = this.hits.get(key) || []
    arr.push(now)
    this.hits.set(key, arr)
  }
}

export interface RateLimiterOptions {
  perPage?: number
  perSession?: number
  windowMs?: number
}

/**
 * Per-page (10/min) and per-session (30/min) limits. Only accepted events count;
 * a dropped attempt does not extend the lockout.
 */
export class RateLimiter {
  page: SlidingWindow
  session: SlidingWindow

  constructor ({ perPage = RATE_LIMIT_PER_PAGE, perSession = RATE_LIMIT_PER_SESSION, windowMs = RATE_WINDOW_MS }: RateLimiterOptions = {}) {
    this.page = new SlidingWindow(perPage, windowMs)
    this.session = new SlidingWindow(perSession, windowMs)
  }

  allow (page: string, now: number): boolean {
    return this.page.allow(page, now) && this.session.allow('', now)
  }

  record (page: string, now: number): void {
    this.page.record(page, now)
    this.session.record('', now)
  }
}

/** idempotencyKey -> event id, remembered for `windowMs`. */
export class IdempotencyCache {
  windowMs: number
  map: Map<string, { id: string; at: number }>

  constructor (windowMs: number = IDEMPOTENCY_WINDOW_MS) {
    this.windowMs = windowMs
    this.map = new Map()
  }

  _prune (now: number): void {
    for (const [k, v] of this.map) {
      if (v.at <= now - this.windowMs) this.map.delete(k)
      else break // insertion order == time order
    }
  }

  get (key: string, now: number): string | undefined {
    this._prune(now)
    const v = this.map.get(key)
    return v ? v.id : undefined
  }

  set (key: string, id: string, now: number): void {
    this._prune(now)
    this.map.delete(key)
    this.map.set(key, { id, at: now })
  }
}

// ---------------------------------------------------------------------------
// SSE

/** One SSE frame: `event: <name>` + `data: <json>`. */
export function sseFrame (event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Incremental NDJSON splitter for the reply-stream file. push(text) returns the
 * parsed objects of every complete line; a trailing partial line is kept.
 * Unparsable lines and non-objects are skipped.
 */
export class NdjsonSplitter {
  buf: string

  constructor () {
    this.buf = ''
  }

  push (text: string): JsonObject[] {
    this.buf += text
    const out: JsonObject[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        const obj: unknown = JSON.parse(line)
        if (isJsonObject(obj)) out.push(obj)
      } catch {}
    }
    return out
  }
}

/** The stream-file lines the listener forwards; anything else is ignored. */
export function streamLine (obj: JsonObject): StreamLine | null {
  if (obj.type === 'text' && typeof obj.text === 'string') return { type: 'text', text: obj.text }
  if (obj.type === 'state' && typeof obj.state === 'string') return { type: 'state', state: obj.state }
  if (obj.type === 'end') return { type: 'end' }
  return null
}

// ---------------------------------------------------------------------------
// Parent watch

/** True while a process with this pid exists. EPERM means it exists but belongs to someone else. */
export function processExists (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether the listener has been orphaned: its parent pid changed (POSIX
 * re-parents orphans) or the original parent no longer exists (Windows keeps
 * the stale ppid, so only the liveness check notices there).
 */
export function isOrphaned (parent: number, currentPpid: number, exists: (pid: number) => boolean = processExists): boolean {
  return currentPpid !== parent || !exists(parent)
}
