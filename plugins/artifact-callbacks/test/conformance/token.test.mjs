// file:// token mode (CB_ALLOW_FILE_ORIGIN=1): Origin null + X-CB-Token.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startListener, assertBaseHeaders, hmac, EVENT_ID } from './harness.mjs'

const PAGE = '<!doctype html><button data-cb-action="fix" data-cb-prompt="Fix it">Fix</button>'

function tokenPost (L, body, { token, headers = {} } = {}) {
  return L.req({
    method: 'POST',
    path: '/_cb/event',
    headers: {
      origin: 'null',
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
      'x-cb-token': token,
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

function assertNoCors (r) {
  for (const k of Object.keys(r.headers)) assert.ok(!k.startsWith('access-control-'), `unexpected ${k}`)
}

describe('token mode enabled', () => {
  let L
  const tok = (page) => hmac(L.secret, 'page:' + page)
  before(async () => {
    L = await startListener({ env: { CB_ALLOW_FILE_ORIGIN: '1' } })
    L.writePage('t.html', PAGE)
    L.writePage('sub/u.html', PAGE)
  })
  after(() => L.cleanup())

  test('valid token for an existing page → 202, event line, ACAO null', async () => {
    const r = await tokenPost(L, { v: 1, action: 'fix', page: 't.html', label: 'Fix' }, { token: tok('t.html') })
    assert.equal(r.status, 202, r.body)
    assert.match(r.json.id, EVENT_ID)
    assertBaseHeaders(assert, r, { acao: true })
    assert.equal(r.headers['access-control-allow-origin'], 'null')
    const ev = await L.waitLine((l) => l.type === 'event' && l.id === r.json.id)
    assert.equal(ev.servedPage, 't.html')
    assert.equal(ev.body.page, 't.html')
    assert.equal(ev.body.label, 'Fix')
  })

  test('page given as /a/<page>, /<page>, or an absolute path inside the root', async () => {
    for (const page of ['/a/sub/u.html', '/sub/u.html', join(L.root, 'sub', 'u.html')]) {
      const r = await tokenPost(L, { v: 1, action: 'fix', page }, { token: tok('sub/u.html') })
      assert.equal(r.status, 202, page)
      const ev = await L.waitLine((l) => l.type === 'event' && l.id === r.json.id)
      assert.equal(ev.servedPage, 'sub/u.html')
    }
  })

  test('the page need not have been served over http (file pages never are)', async () => {
    L.writePage('fresh.html', PAGE)
    const r = await tokenPost(L, { v: 1, action: 'fix', page: 'fresh.html' }, { token: tok('fresh.html') })
    assert.equal(r.status, 202)
  })

  test('templates are verified in token mode too', async () => {
    assert.equal((await tokenPost(L, { v: 1, action: 'fix', page: 't.html', prompt: 'Fix it' }, { token: tok('t.html') })).status, 202)
    const r = await tokenPost(L, { v: 1, action: 'fix', page: 't.html', prompt: 'Other' }, { token: tok('t.html') })
    assert.equal(r.status, 409)
    assert.deepEqual(r.json, { error: 'template-changed' })
    assert.equal(r.headers['access-control-allow-origin'], 'null')
  })

  const bad = [
    ['missing token', (L) => [{ v: 1, action: 'fix', page: 't.html' }, undefined]],
    ['wrong token', (L) => [{ v: 1, action: 'fix', page: 't.html' }, 'f'.repeat(64)]],
    ['token of another page', (L) => [{ v: 1, action: 'fix', page: 't.html' }, hmac(L.secret, 'page:sub/u.html')]],
    ['token without the page: prefix', (L) => [{ v: 1, action: 'fix', page: 't.html' }, hmac(L.secret, 't.html')]],
    ['cookie value as token', (L) => [{ v: 1, action: 'fix', page: 't.html' }, hmac(L.secret, String(L.port))]],
    ['page file missing', (L) => [{ v: 1, action: 'fix', page: 'gone.html' }, hmac(L.secret, 'page:gone.html')]],
    ['page outside the root', (L) => [{ v: 1, action: 'fix', page: '../x.html' }, hmac(L.secret, 'page:../x.html')]],
    ['no page', (L) => [{ v: 1, action: 'fix' }, hmac(L.secret, 'page:')]],
    ['invalid JSON (unauthenticated callers get no schema errors)', (L) => ['{nope', hmac(L.secret, 'page:t.html')]]
  ]
  for (const [name, mk] of bad) {
    test(`${name} → 403 auth, no CORS headers`, async () => {
      const [body, token] = mk(L)
      const before = L.lines.length
      const r = await tokenPost(L, body, { token })
      assert.equal(r.status, 403)
      assert.equal(r.body, '')
      assertNoCors(r)
      const line = await L.waitLine((l) => L.lines.indexOf(l) >= before && l.type === 'rejected')
      assert.equal(line.reason, 'auth')
      assert.equal(line.origin, 'null')
    })
  }

  test('authenticated schema errors → 400 with ACAO null', async () => {
    const r = await tokenPost(L, { v: 1, action: 'BAD', page: 't.html' }, { token: tok('t.html') })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /^action/)
    assert.equal(r.headers['access-control-allow-origin'], 'null')
  })

  test('content-type is still enforced', async () => {
    const r = await tokenPost(L, { v: 1, action: 'fix', page: 't.html' }, { token: tok('t.html'), headers: { 'content-type': 'text/plain' } })
    assert.equal(r.status, 403)
    await L.waitLine((l) => l.type === 'rejected' && l.reason === 'content-type' && l.origin === 'null')
  })

  test('preflight from Origin null → 204 with CORS for the event routes only', async () => {
    for (const path of ['/_cb/event', '/_cb/events/ev_aaaaaaaaaa', '/_cb/events/ev_aaaaaaaaaa/stream']) {
      const r = await L.req({
        method: 'OPTIONS',
        path,
        headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-cb-token', 'access-control-request-private-network': 'true' }
      })
      assert.equal(r.status, 204, path)
      assertBaseHeaders(assert, r, { acao: true })
      assert.equal(r.headers['access-control-allow-origin'], 'null')
      assert.match(r.headers['access-control-allow-methods'], /POST/)
      assert.match(r.headers['access-control-allow-headers'].toLowerCase(), /x-cb-token/)
      assert.match(r.headers['access-control-allow-headers'].toLowerCase(), /content-type/)
      assert.equal(r.headers['access-control-allow-private-network'], 'true')
      assert.equal(r.headers['access-control-allow-credentials'], undefined)
    }
    for (const [path, origin] of [['/_cb/health', 'null'], ['/a/t.html', 'null'], ['/_cb/event', 'https://evil.example'], ['/_cb/event', L.origin], ['/_cb/event', undefined]]) {
      const r = await L.req({ method: 'OPTIONS', path, headers: { origin, 'access-control-request-method': 'POST' } })
      assert.equal(r.status, 403, `${path} ${origin}`)
      assertNoCors(r)
    }
  })

  test('GET /_cb/events/<id> with the page token → 200 + ACAO null; wrong token → 403', async () => {
    const id = (await tokenPost(L, { v: 1, action: 'fix', page: 't.html' }, { token: tok('t.html') })).json.id
    let r = await L.req({ path: `/_cb/events/${id}`, headers: { origin: 'null', 'x-cb-token': tok('t.html') } })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { id, state: 'queued' })
    assert.equal(r.headers['access-control-allow-origin'], 'null')
    for (const token of [tok('sub/u.html'), undefined, 'x']) {
      r = await L.req({ path: `/_cb/events/${id}`, headers: { origin: 'null', 'x-cb-token': token } })
      assert.equal(r.status, 403)
      assertNoCors(r)
    }
    // status.json records carry the page the token is checked against
    L.writeStatus({ events: { [id]: { id, state: 'running', page: 't.html', action: 'fix', turnStartedAt: 5, turnEndedAt: null, note: null } } })
    r = await L.req({ path: `/_cb/events/${id}`, headers: { origin: 'null', 'x-cb-token': tok('t.html') } })
    assert.equal(r.json.state, 'running')
  })

  test('cookie mode keeps working alongside token mode, without CORS headers', async () => {
    await L.serve('t.html')
    const r = await L.post({ v: 1, action: 'fix' }, { page: 't.html' })
    assert.equal(r.status, 202)
    assertNoCors(r)
  })

  test('a token request with a real Origin is treated as cookie mode', async () => {
    const r = await tokenPost(L, { v: 1, action: 'fix', page: 't.html' }, { token: tok('t.html'), headers: { origin: L.origin, 'sec-fetch-site': 'same-origin' } })
    assert.equal(r.status, 403)
    await L.waitLine((l) => l.type === 'rejected' && l.reason === 'auth' && l.origin === L.origin)
  })
})

describe('token mode disabled (default)', () => {
  let L
  before(async () => {
    L = await startListener()
    L.writePage('t.html', PAGE)
  })
  after(() => L.cleanup())

  test('Origin null → 403 origin even with a valid token', async () => {
    const r = await tokenPost(L, { v: 1, action: 'fix', page: 't.html' }, { token: hmac(L.secret, 'page:t.html') })
    assert.equal(r.status, 403)
    assert.equal(r.body, '')
    assertNoCors(r)
    await L.waitLine((l) => l.type === 'rejected' && l.reason === 'origin' && l.origin === 'null')
    assert.ok(!L.lines.some((l) => l.type === 'event'))
  })

  test('preflight from Origin null → 403', async () => {
    const r = await L.req({ method: 'OPTIONS', path: '/_cb/event', headers: { origin: 'null', 'access-control-request-method': 'POST' } })
    assert.equal(r.status, 403)
    assertNoCors(r)
  })

  test('CB_ALLOW_FILE_ORIGIN values other than 1 keep it off', async () => {
    const M = await startListener({ env: { CB_ALLOW_FILE_ORIGIN: 'true' } })
    try {
      M.writePage('t.html', PAGE)
      const r = await tokenPost(M, { v: 1, action: 'fix', page: 't.html' }, { token: hmac(M.secret, 'page:t.html') })
      assert.equal(r.status, 403)
    } finally {
      await M.cleanup()
    }
  })
})
