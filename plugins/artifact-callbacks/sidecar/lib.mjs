// Pure helpers for the Artifact Callbacks listener (Node stdlib only).
// listener.mjs imports these; test/unit covers them. sidecar/listener.py mirrors
// the same rules, so every behaviour here is pinned in docs/CONTRACT.md.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

export const MAX_BODY_BYTES = 16384
export const IDEMPOTENCY_WINDOW_MS = 60_000
export const RATE_WINDOW_MS = 60_000
export const RATE_LIMIT_PER_PAGE = 10
export const RATE_LIMIT_PER_SESSION = 30
export const QUEUE_CAP = 5
export const TERMINAL_STATES = new Set(['done', 'rejected', 'dropped', 'expired'])
export const EVENT_ID_RE = /^ev_[a-z0-9]{10}$/
export const ACTION_RE = /^[a-z0-9_-]{1,40}$/
export const SECRET_RE = /^[0-9a-fA-F]{32,}$/

// ---------------------------------------------------------------------------
// HMAC and constant-time comparison

/** HMAC-SHA256 over UTF-8 `msg` keyed by the UTF-8 bytes of `secret`, lowercase hex. */
export function hmacHex (secret, msg) {
  return createHmac('sha256', Buffer.from(String(secret), 'utf8'))
    .update(Buffer.from(String(msg), 'utf8'))
    .digest('hex')
}

/** Value of the session cookie for a listener bound to `port`. */
export function cookieValue (secret, port) {
  return hmacHex(secret, String(port))
}

/** Name of the session cookie. Port-scoped so two sessions on one host never clobber each other. */
export function cookieName (port) {
  return `cb_session_${port}`
}

/** file:// token for a page path relative to the artifacts root. */
export function pageToken (secret, page) {
  return hmacHex(secret, 'page:' + page)
}

/** Constant-time string equality (false for non-strings or different lengths). */
export function safeEqual (a, b) {
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
export function newEventId () {
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
export function parseCookies (header) {
  const out = new Map()
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
export function isAllowedHost (host, port) {
  if (typeof host !== 'string') return false
  const h = host.toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

/** Origins allowed for cookie mode. */
export function allowedOrigins (port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

export function isAllowedOrigin (origin, port) {
  return typeof origin === 'string' && allowedOrigins(port).includes(origin.toLowerCase())
}

/** Content-Type must be application/json, parameters allowed. */
export function isJsonContentType (ct) {
  if (typeof ct !== 'string') return false
  return ct.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** Split a request target into pathname (no query/fragment). Returns null for non-origin-form targets. */
export function requestPath (url) {
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
export function normalizeArtifactPath (raw) {
  if (typeof raw !== 'string' || raw === '') return null
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  return checkRelativePath(decoded)
}

/** Same rules as normalizeArtifactPath for an already-decoded path. */
export function checkRelativePath (p) {
  if (typeof p !== 'string' || p === '') return null
  if (p.includes('\0') || p.includes('\\')) return null
  const segs = p.split('/')
  for (const s of segs) {
    if (s === '' || s.startsWith('.')) return null
  }
  return segs.join('/')
}

/** Page path from a body `page` value: strip a leading `/a/` or `/`, then apply the path rules. */
export function pageFromBody (page) {
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
export function pageFromFileBody (page, roots) {
  if (typeof page !== 'string') return null
  for (const r of roots) {
    if (!r) continue
    const prefix = r.endsWith('/') ? r : r + '/'
    if (page.startsWith(prefix)) return checkRelativePath(page.slice(prefix.length))
  }
  return pageFromBody(page)
}

/** Page path from a Referer URL: only same-origin referers under `/a/`. */
export function pageFromReferer (referer, port) {
  if (typeof referer !== 'string') return null
  let u
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
export async function resolveInsideRoot (rootReal, rel) {
  if (rel == null) return null
  const candidate = join(rootReal, ...rel.split('/'))
  let real
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

const MIME = {
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
export function mimeFor (path) {
  const base = String(path).split('/').pop()
  const i = base.lastIndexOf('.')
  if (i <= 0) return 'application/octet-stream'
  return MIME[base.slice(i + 1).toLowerCase()] || 'application/octet-stream'
}

export function isHtmlPath (path) {
  return mimeFor(path).startsWith('text/html')
}

// ---------------------------------------------------------------------------
// HTML attribute extraction (data-cb-prompt templates)

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * Decode the entities the contract names: `&amp; &lt; &gt; &quot; &apos;` and
 * numeric `&#N;` / `&#xH;` (which covers `&#39;`). Anything else stays as is.
 * Numeric references to 0, surrogates or > 0x10FFFF stay undecoded.
 */
export function decodeEntities (s) {
  return String(s).replace(/&(?:#([0-9]{1,8})|#[xX]([0-9a-fA-F]{1,7})|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    if (name !== undefined) {
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m
    }
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16)
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m
    return String.fromCodePoint(cp)
  })
}

const WS = new Set([' ', '\t', '\n', '\r', '\f'])

/**
 * Collect every value of attribute `attr` (ASCII case-insensitive name) in the
 * start tags of `html`. Values may be double-quoted, single-quoted or unquoted;
 * entities are decoded with decodeEntities. Comments, `<!...>` and `<?...>`
 * are skipped; a bare attribute (no `=`) yields the empty string.
 */
export function extractAttributeValues (html, attr) {
  const want = attr.toLowerCase()
  const out = []
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

export function extractPromptTemplates (html) {
  return extractAttributeValues(html, 'data-cb-prompt')
}

// ---------------------------------------------------------------------------
// Body schema

/** Length in Unicode code points. */
export function cpLength (s) {
  let n = 0
  for (const _ of s) n++ // eslint-disable-line no-unused-vars
  return n
}

function optString (body, key, max, out) {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || cpLength(v) > max) return `${key} must be a string of at most ${max} characters`
  out[key] = v
  return null
}

/**
 * Validate a parsed event body. Returns `{ value }` with unknown keys dropped and
 * `data` defaulted to `{}`, or `{ error }` whose text starts with the offending
 * field name (or `body`). `null` for an optional field counts as absent.
 */
export function validateBody (body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' }
  if (body.v !== 1) return { error: 'v must be 1' }
  if (typeof body.action !== 'string' || !ACTION_RE.test(body.action)) return { error: 'action must match ^[a-z0-9_-]{1,40}$' }
  const out = { v: 1, action: body.action }
  let err = optString(body, 'label', 200, out)
  if (err) return { error: err }
  if (body.data === undefined || body.data === null) out.data = {}
  else if (typeof body.data !== 'object' || Array.isArray(body.data)) return { error: 'data must be a JSON object' }
  else out.data = body.data
  err = optString(body, 'prompt', 2000, out) ||
    optString(body, 'idempotencyKey', 100, out) ||
    optString(body, 'page', 300, out)
  if (err) return { error: err }
  return { value: out }
}

// ---------------------------------------------------------------------------
// status.json

export const EMPTY_STATUS = Object.freeze({ v: 1, paused: false, queueDepth: 0, events: {} })

/** Parse status.json text; returns null when unusable (caller keeps its last good parse). */
export function parseStatus (text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const events = obj.events && typeof obj.events === 'object' && !Array.isArray(obj.events) ? obj.events : {}
  const depth = Number.isFinite(obj.queueDepth) ? obj.queueDepth : 0
  return { v: 1, paused: obj.paused === true, queueDepth: depth, events }
}

/** Public view of an event record for GET /_cb/events/<id>. */
export function publicRecord (id, rec) {
  const out = { id, state: rec.state }
  for (const k of ['turnStartedAt', 'turnEndedAt', 'note']) {
    if (rec[k] !== undefined) out[k] = rec[k]
  }
  if (rec.reason !== undefined) out.reason = rec.reason
  return out
}

// ---------------------------------------------------------------------------
// Rate limiting and idempotency

/** Sliding-window counter: allow() is true while fewer than `limit` hits fall in the trailing window. */
export class SlidingWindow {
  constructor (limit, windowMs) {
    this.limit = limit
    this.windowMs = windowMs
    this.hits = new Map() // key -> number[] (ascending)
  }

  _prune (key, now) {
    const arr = this.hits.get(key)
    if (!arr) return []
    while (arr.length && arr[0] <= now - this.windowMs) arr.shift()
    if (!arr.length) this.hits.delete(key)
    return arr
  }

  count (key, now) {
    return this._prune(key, now).length
  }

  allow (key, now) {
    return this.count(key, now) < this.limit
  }

  record (key, now) {
    this._prune(key, now)
    const arr = this.hits.get(key) || []
    arr.push(now)
    this.hits.set(key, arr)
  }
}

/**
 * Per-page (10/min) and per-session (30/min) limits. Only accepted events count;
 * a dropped attempt does not extend the lockout.
 */
export class RateLimiter {
  constructor ({ perPage = RATE_LIMIT_PER_PAGE, perSession = RATE_LIMIT_PER_SESSION, windowMs = RATE_WINDOW_MS } = {}) {
    this.page = new SlidingWindow(perPage, windowMs)
    this.session = new SlidingWindow(perSession, windowMs)
  }

  allow (page, now) {
    return this.page.allow(page, now) && this.session.allow('', now)
  }

  record (page, now) {
    this.page.record(page, now)
    this.session.record('', now)
  }
}

/** idempotencyKey -> event id, remembered for `windowMs`. */
export class IdempotencyCache {
  constructor (windowMs = IDEMPOTENCY_WINDOW_MS) {
    this.windowMs = windowMs
    this.map = new Map()
  }

  _prune (now) {
    for (const [k, v] of this.map) {
      if (v.at <= now - this.windowMs) this.map.delete(k)
      else break // insertion order == time order
    }
  }

  get (key, now) {
    this._prune(now)
    const v = this.map.get(key)
    return v ? v.id : undefined
  }

  set (key, id, now) {
    this._prune(now)
    this.map.delete(key)
    this.map.set(key, { id, at: now })
  }
}

// ---------------------------------------------------------------------------
// SSE

/** One SSE frame: `event: <name>` + `data: <json>`. */
export function sseFrame (event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Incremental NDJSON splitter for the reply-stream file. push(text) returns the
 * parsed objects of every complete line; a trailing partial line is kept.
 * Unparsable lines and non-objects are skipped.
 */
export class NdjsonSplitter {
  constructor () {
    this.buf = ''
  }

  push (text) {
    this.buf += text
    const out = []
    let nl
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj)
      } catch {}
    }
    return out
  }
}
