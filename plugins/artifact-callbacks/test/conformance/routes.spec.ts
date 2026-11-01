// Host check, routing, response headers, health, client.js and /a/ static serving.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startListener, assertBaseHeaders, rawSocket, PLUGIN_DIR } from './harness.ts'
import type { Listener } from './harness.ts'

let L: Listener
before(async () => {
  L = await startListener()
  L.writePage('p.html', '<!doctype html><p>hi</p>')
  L.writePage('sub/x.html', '<p>nested</p>')
})
after(async () => { await L.cleanup() })

describe('Host header (DNS rebinding)', () => {
  const badHosts = (port: number): (string | undefined)[] => [
    'evil.example',
    `evil.example:${port}`,
    `rebind.attacker.test:${port}`,
    '127.0.0.1',
    'localhost',
    `127.0.0.1:${port + 1}`,
    `localhost:${port}.evil.example`,
    `[::1]:${port}`,
    `0.0.0.0:${port}`,
    `127.0.0.2:${port}`
  ]
  for (const route of [['GET', '/_cb/health'], ['GET', '/a/p.html'], ['GET', '/_cb/client.js'], ['POST', '/_cb/event'],
    ['GET', '/_cb/events/ev_aaaaaaaaaa'], ['GET', '/nope'], ['OPTIONS', '/_cb/event']]) {
    test(`${route[0]} ${route[1]} with a foreign Host → 403 empty + rejected/host`, async () => {
      for (const host of badHosts(L.port)) {
        const r = await L.req({ method: route[0], path: route[1], host, headers: { origin: 'https://evil.example' } })
        assert.equal(r.status, 403, host)
        assert.equal(r.body, '')
        assert.equal(r.headers['set-cookie'], undefined)
        assertBaseHeaders(assert, r)
        const line = await L.waitLine((l) => l.type === 'rejected' && l.reason === 'host' && l.path === route[1] && !l._seen)
        line._seen = true
        assert.equal(line.origin, 'https://evil.example')
      }
    })
  }

  test('missing Host → 403', async () => {
    const r = await L.req({ path: '/_cb/health', host: undefined })
    assert.equal(r.status, 403)
  })

  test('localhost:<port> and 127.0.0.1:<port> are accepted', async () => {
    assert.equal((await L.req({ path: '/_cb/health', host: `localhost:${L.port}` })).status, 200)
    assert.equal((await L.req({ path: '/_cb/health', host: `127.0.0.1:${L.port}` })).status, 200)
  })
})

describe('routing', () => {
  test('unknown routes → 404 empty', async () => {
    for (const path of ['/', '/nope', '/_cb', '/_cb/', '/_cb/events', '/_cb/events/', '/_cb/events/bad-id',
      '/_cb/events/ev_AAAAAAAAAA', '/_cb/events/ev_aaaaaaaaaa/other', '/_cb/events/ev_aaaaaaaaa', '/a', '/_cb/health/x']) {
      const r = await L.req({ path })
      assert.equal(r.status, 404, path)
      assert.equal(r.body, '')
      assertBaseHeaders(assert, r)
    }
  })

  test('wrong method on a known route → 405 empty + rejected/method', async () => {
    for (const [method, path] of [['POST', '/_cb/health'], ['DELETE', '/_cb/client.js'], ['GET', '/_cb/event'],
      ['PUT', '/_cb/event'], ['POST', '/a/p.html'], ['HEAD', '/a/p.html'], ['POST', '/_cb/events/ev_aaaaaaaaaa'],
      ['POST', '/_cb/events/ev_aaaaaaaaaa/stream']]) {
      const before = L.lines.length
      const r = await L.req({ method, path })
      assert.equal(r.status, 405, `${method} ${path}`)
      assert.equal(r.body, '')
      assertBaseHeaders(assert, r)
      await L.waitLine((l) => L.lines.indexOf(l) >= before && l.type === 'rejected' && l.reason === 'method' && l.path === path)
    }
  })

  test('OPTIONS anything → 403 empty, no Access-Control-* headers', async () => {
    for (const path of ['/_cb/event', '/_cb/health', '/a/p.html', '/nope', '/_cb/events/ev_aaaaaaaaaa']) {
      for (const origin of [undefined, 'https://evil.example', L.origin, 'null']) {
        const r = await L.req({
          method: 'OPTIONS',
          path,
          headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
        })
        assert.equal(r.status, 403, `${path} ${origin}`)
        assert.equal(r.body, '')
        assertBaseHeaders(assert, r)
      }
    }
    await L.waitLine((l) => l.type === 'rejected' && l.reason === 'method' && l.path === '/nope')
  })

  test('query strings are ignored for routing', async () => {
    assert.equal((await L.req({ path: '/_cb/health?x=1' })).status, 200)
    assert.equal((await L.req({ path: '/a/p.html?v=2' })).status, 200)
  })
})

describe('health and client.js', () => {
  test('GET /_cb/health → 200 JSON with paused from status.json', async () => {
    let r = await L.req({ path: '/_cb/health' })
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /^application\/json/)
    assert.deepEqual(r.json, { ok: true, paused: false })
    assertBaseHeaders(assert, r)
    L.writeStatus({ paused: true })
    r = await L.req({ path: '/_cb/health' })
    assert.deepEqual(r.json, { ok: true, paused: true })
    // Unparsable file: keep the last good parse.
    L.writeStatus('{not json')
    r = await L.req({ path: '/_cb/health' })
    assert.deepEqual(r.json, { ok: true, paused: true })
    L.writeStatus({ paused: false })
    r = await L.req({ path: '/_cb/health' })
    assert.deepEqual(r.json, { ok: true, paused: false })
  })

  test('health reveals nothing to a foreign Host', async () => {
    const r = await L.req({ path: '/_cb/health', host: 'evil.example' })
    assert.equal(r.status, 403)
    assert.equal(r.body, '')
  })

  test('GET /_cb/client.js → the client file, text/javascript, no secrets', async () => {
    const r = await L.req({ path: '/_cb/client.js' })
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8')
    assertBaseHeaders(assert, r)
    assert.equal(r.headers['set-cookie'], undefined)
    assert.equal(r.body, readFileSync(join(PLUGIN_DIR, 'sidecar', 'client.js'), 'utf8'))
    assert.ok(!r.body.includes(L.secret))
    assert.ok(!r.body.includes(L.cookieValue))
  })

  test('client.js refuses cross-site and same-site loads (no running the client on another site)', async () => {
    for (const sfs of ['same-origin', 'none', undefined]) {
      const r = await L.req({ path: '/_cb/client.js', headers: { 'sec-fetch-site': sfs } })
      assert.equal(r.status, 200, `Sec-Fetch-Site ${sfs}`)
    }
    for (const sfs of ['cross-site', 'same-site', 'bogus']) {
      const before = L.lines.length
      const r = await L.req({ path: '/_cb/client.js', headers: { 'sec-fetch-site': sfs, origin: 'http://localhost:1' } })
      assert.equal(r.status, 403, `Sec-Fetch-Site ${sfs}`)
      assert.equal(r.body, '')
      assertBaseHeaders(assert, r)
      await L.marker()
      const line = L.lines.slice(before).find((l) => l.type === 'rejected')
      assert.deepEqual(line, { type: 'rejected', reason: 'sec-fetch-site', path: '/_cb/client.js', origin: 'http://localhost:1' })
    }
  })

  test('in token mode file:// pages (cross-site) may load client.js; same-site still may not', async () => {
    const M = await startListener({ env: { CB_ALLOW_FILE_ORIGIN: '1' } })
    try {
      assert.equal((await M.req({ path: '/_cb/client.js', headers: { 'sec-fetch-site': 'cross-site' } })).status, 200)
      assert.equal((await M.req({ path: '/_cb/client.js', headers: { 'sec-fetch-site': 'same-site' } })).status, 403)
    } finally {
      await M.cleanup()
    }
  })

  test('CB_CLIENT_JS overrides the client path', async () => {
    const dirs = L.dirs
    const file = join(dirs.run, 'custom-client.js')
    writeFileSync(file, '/* custom client */\n')
    const M = await startListener({ env: { CB_CLIENT_JS: file } })
    try {
      const r = await M.req({ path: '/_cb/client.js' })
      assert.equal(r.status, 200)
      assert.equal(r.body, '/* custom client */\n')
    } finally {
      await M.cleanup()
    }
  })
})

describe('/a/ static serving', () => {
  test('html: 200, text/html, session cookie, recorded as served', async () => {
    const r = await L.req({ path: '/a/p.html' })
    assert.equal(r.status, 200)
    assert.equal(r.body, '<!doctype html><p>hi</p>')
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
    assertBaseHeaders(assert, r)
    const sc = r.headers['set-cookie']
    assert.ok(sc)
    assert.equal(sc.length, 1)
    const parts = sc[0].split(';').map((s) => s.trim())
    assert.equal(parts[0], `${L.cookieName}=${L.cookieValue}`)
    assert.match(parts[0], /^cb_session_\d+=[0-9a-f]{64}$/)
    const attrs = parts.slice(1).map((s) => s.toLowerCase()).sort()
    assert.deepEqual(attrs, ['httponly', 'path=/_cb/', 'samesite=strict'])
  })

  test('nested html page', async () => {
    const r = await L.req({ path: '/a/sub/x.html' })
    assert.equal(r.status, 200)
    assert.equal(r.body, '<p>nested</p>')
    assert.ok(r.headers['set-cookie'])
  })

  test('percent-encoded names are decoded', async () => {
    L.writePage('my page.html', 'spaced')
    const r = await L.req({ path: '/a/my%20page.html' })
    assert.equal(r.status, 200)
    assert.equal(r.body, 'spaced')
  })

  test('MIME types by extension; non-html sets no cookie', async () => {
    const table = {
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
      map: 'application/json; charset=utf-8',
      bin: 'application/octet-stream',
      htm: 'application/octet-stream'
    }
    for (const [ext, mime] of Object.entries(table)) {
      L.writePage(`m/f.${ext}`, `content-${ext}`)
      const r = await L.req({ path: `/a/m/f.${ext}` })
      assert.equal(r.status, 200, ext)
      assert.equal(r.headers['content-type'], mime, ext)
      assert.equal(r.body, `content-${ext}`)
      assert.equal(r.headers['set-cookie'], undefined, ext)
      assertBaseHeaders(assert, r)
    }
    L.writePage('m/noext', 'x')
    assert.equal((await L.req({ path: '/a/m/noext' })).headers['content-type'], 'application/octet-stream')
    L.writePage('m/UP.HTML', '<b>up</b>')
    const up = await L.req({ path: '/a/m/UP.HTML' })
    assert.equal(up.headers['content-type'], 'text/html; charset=utf-8')
  })

  test('traversal, dotfiles, NUL, backslashes, directories → 404', async () => {
    const outside = join(L.dirs.base, 'secret.txt')
    writeFileSync(outside, 'TOP SECRET')
    L.writePage('.hidden.html', 'hidden')
    L.writePage('sub/.git/config', 'cfg')
    mkdirSync(join(L.root, 'emptydir'), { recursive: true })
    const paths = [
      '/a/../secret.txt',
      '/a/sub/../../secret.txt',
      '/a/%2e%2e/secret.txt',
      '/a/%2E%2E/secret.txt',
      '/a/%2e%2e%2fsecret.txt',
      '/a/sub/%2e%2e/%2e%2e/secret.txt',
      '/a/..%2fsecret.txt',
      '/a/.hidden.html',
      '/a/%2ehidden.html',
      '/a/sub/.git/config',
      '/a/./p.html',
      '/a/p.html%00',
      '/a/p.html%00.txt',
      '/a/sub%5cx.html',
      '/a/sub\\x.html',
      '/a/sub',
      '/a/sub/',
      '/a/emptydir',
      '/a/',
      '/a//p.html',
      '/a/%zz',
      '/a/missing.html'
    ]
    for (const path of paths) {
      const r = await L.req({ path })
      assert.equal(r.status, 404, path)
      assert.equal(r.body, '', path)
      assert.ok(!r.body.includes('TOP SECRET'))
      assert.equal(r.headers['set-cookie'], undefined, path)
      assertBaseHeaders(assert, r)
    }
  })

  test('symlinks: out of root → 404, inside root → served', async () => {
    const outside = join(L.dirs.base, 'outside.html')
    writeFileSync(outside, '<p>outside</p>')
    symlinkSync(outside, join(L.root, 'link-out.html'))
    symlinkSync(L.dirs.base, join(L.root, 'dirlink'))
    symlinkSync(join(L.root, 'p.html'), join(L.root, 'link-in.html'))
    assert.equal((await L.req({ path: '/a/link-out.html' })).status, 404)
    assert.equal((await L.req({ path: '/a/dirlink/outside.html' })).status, 404)
    const r = await L.req({ path: '/a/link-in.html' })
    assert.equal(r.status, 200)
    assert.equal(r.body, '<!doctype html><p>hi</p>')
  })
})

describe('malformed requests', () => {
  test('garbage request line gets a bare 400 with the standard headers', async () => {
    const s = await rawSocket(L.port)
    s.socket.write('THIS IS NOT HTTP\r\n\r\n')
    await s.closed
    assert.match(s.data(), /^HTTP\/1\.1 400/)
    assert.match(s.data(), /Cache-Control: no-store/i)
    assert.ok(!/Access-Control/i.test(s.data()))
  })
})
