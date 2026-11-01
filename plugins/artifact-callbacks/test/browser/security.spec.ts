// CSRF from other origins, in real Chromium: nothing another page does may produce an event.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { launch, startListener, page, events, open, otherServer, sleep } from './helpers.ts'
import type { Browser, Listener, OtherServer } from './helpers.ts'

let browser: Browser, L: Listener, spy: OtherServer
before(async () => {
  browser = await launch()
  L = await startListener()
  L.writePage('p.html', page('<button id="b" data-cb-action="legit">Legit</button>'))
  // A recorder on the listener's host but another port: cookies are host-scoped, so it
  // sees exactly the cookies a request to 127.0.0.1 would carry.
  spy = await otherServer({})
})
after(async () => {
  await browser.close()
  await spy.close()
  await L.cleanup()
})

function attackPage (target: string, spyUrl: string): string {
  const body = JSON.stringify({ v: 1, action: 'evil', data: { from: 'attacker' }, page: 'p.html' })
  return `<!doctype html><meta charset="utf-8"><body>
<iframe name="sink1"></iframe><iframe name="sink2"></iframe><iframe name="sink3"></iframe>
<form id="f1" method="POST" action="${target}/_cb/event" enctype="text/plain" target="sink1">
  <input name='{"v":1,"action":"evil","x":"' value='"}'>
</form>
<form id="f2" method="POST" action="${target}/_cb/event" enctype="application/x-www-form-urlencoded" target="sink2">
  <input name="v" value="1"><input name="action" value="evil">
</form>
<form id="f3" method="POST" action="${spyUrl}" enctype="text/plain" target="sink3">
  <input name="probe" value="1">
</form>
<script>
window.__results = {}
const body = ${JSON.stringify(body)}
const T = ${JSON.stringify(target)}
const settle = (name, p) => p.then((r) => { window.__results[name] = 'ok:' + (r && r.type) }, (e) => { window.__results[name] = 'error:' + e.name })
const loaded = (name) => new Promise((resolve) => { document.querySelector('iframe[name=' + name + ']').addEventListener('load', resolve, { once: true }); setTimeout(resolve, 3000) })
Promise.all([
  settle('cors-json', fetch(T + '/_cb/event', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body })),
  settle('no-cors-text', fetch(T + '/_cb/event', { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'text/plain' }, body })),
  settle('no-cors-json', fetch(T + '/_cb/event', { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'application/json' }, body })),
  settle('read-state', fetch(T + '/_cb/events/ev_aaaaaaaaaa', { credentials: 'include' }).then((r) => r.text())),
  settle('beacon', Promise.resolve(navigator.sendBeacon(T + '/_cb/event', new Blob([body], { type: 'text/plain' })))),
  (async () => { const l = loaded('sink1'); document.getElementById('f1').submit(); await l })(),
  (async () => { const l = loaded('sink2'); document.getElementById('f2').submit(); await l })(),
  (async () => { const l = loaded('sink3'); document.getElementById('f3').submit(); await l })()
]).then(() => { window.__done = true })
</script>`
}

async function runAttack (attackerHost: string) {
  // The victim has a legit tab open, so the browser holds the session cookie.
  const { ctx } = await open(browser, `${L.origin}/a/p.html`)
  const cookies = await ctx.cookies(`${L.origin}/_cb/event`)
  assert.ok(cookies.some((c) => c.name === L.cookieName && c.sameSite === 'Strict' && c.httpOnly && c.path === '/_cb/'))
  const before = L.lines.length
  const spySeen = spy.seen.length
  const evil = await otherServer({}, attackerHost)
  const spyUrl = `http://127.0.0.1:${spy.port}/spy`
  evil.server.removeAllListeners('request')
  evil.server.on('request', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(attackPage(L.origin, spyUrl))
  })
  try {
    const p = await ctx.newPage()
    await p.goto(`http://${attackerHost === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:${evil.port}/attack.html`)
    await p.waitForFunction(() => window.__done === true, null, { timeout: 15000 })
    const results = await p.evaluate(() => window.__results)
    await sleep(300)
    await L.marker()
    const mine = L.lines.slice(before).filter((l) => !String(l.path).startsWith('/__marker'))
    const spyReq = spy.seen.slice(spySeen).find((r) => r.url === '/spy')
    return { results, lines: mine, spyReq }
  } finally {
    await ctx.close()
    await evil.close()
  }
}

describe('cross-origin pages cannot send events', () => {
  test('cross-site attacker (http://localhost:<other>): no event, no cookie, nothing readable', async () => {
    const { results, lines, spyReq } = await runAttack('localhost')
    assert.equal(lines.filter((l) => l.type === 'event' || l.type === 'dropped').length, 0, JSON.stringify(lines))
    // The JSON fetch dies at the preflight; reads are blocked by CORS.
    assert.equal(results['cors-json'], 'error:TypeError')
    assert.equal(results['read-state'], 'error:TypeError')
    assert.equal(results['no-cors-text'], 'ok:opaque')
    // Requests that did reach the listener were turned away at the Origin check.
    const rejected = lines.filter((l) => l.type === 'rejected')
    assert.ok(rejected.length >= 3, JSON.stringify(rejected))
    for (const l of rejected) {
      assert.ok(['origin', 'method'].includes(l.reason), JSON.stringify(l))
    }
    assert.ok(rejected.some((l) => l.reason === 'origin' && l.origin.startsWith('http://localhost:')))
    // SameSite=Strict: a cross-site form POST to the listener's host carries no session cookie.
    assert.ok(spyReq, 'spy saw the probe')
    assert.ok(!(spyReq.headers.cookie || '').includes('cb_session_'), `cookie leaked: ${spyReq.headers.cookie}`)
  })

  test('same-site attacker on another port (http://127.0.0.1:<other>): no event, and the cookie stays off its paths', async () => {
    const { results, lines, spyReq } = await runAttack('127.0.0.1')
    assert.equal(lines.filter((l) => l.type === 'event' || l.type === 'dropped').length, 0, JSON.stringify(lines))
    assert.equal(results['cors-json'], 'error:TypeError')
    assert.equal(results['read-state'], 'error:TypeError')
    const rejected = lines.filter((l) => l.type === 'rejected')
    assert.ok(rejected.some((l) => l.reason === 'origin' && l.origin.startsWith('http://127.0.0.1:')))
    // Ports do not make a different site, but the cookie is scoped to /_cb/, so a request
    // to another port's /spy does not carry it.
    assert.ok(spyReq)
    assert.doesNotMatch(spyReq.headers.cookie || '', new RegExp(`${L.cookieName}=`))
  })

  test('residual (documented): a server on another 127.0.0.1 port sees the cookie on its own /_cb/ paths', async () => {
    // Cookies are not port-scoped: a same-site page that requests /_cb/... on its own
    // port gets the session cookie sent to it. SPEC's security model states this.
    const { ctx } = await open(browser, `${L.origin}/a/p.html`)
    const seen = spy.seen.length
    try {
      const p = await ctx.newPage()
      // The spy answers 204, which aborts the navigation; the request was still made.
      await p.goto(`http://127.0.0.1:${spy.port}/_cb/anything`).catch(() => undefined)
      const req = spy.seen.slice(seen).find((r) => r.url === '/_cb/anything')
      assert.ok(req)
      assert.match(req.headers.cookie || '', new RegExp(`${L.cookieName}=${L.cookieValue}`))
    } finally {
      await ctx.close()
    }
  })

  test('the legit page still works afterwards', async () => {
    const before = events(L).length
    const { page: p, ctx } = await open(browser, `${L.origin}/a/p.html`)
    try {
      await p.click('#b')
      await L.waitLine((l) => l.type === 'event' && l.body.action === 'legit')
      assert.equal(events(L).length - before, 1)
    } finally {
      await ctx.close()
    }
  })
})

describe('another site cannot run the client', () => {
  for (const host of ['localhost', '127.0.0.1']) {
    test(`a page on http://${host}:<other> fails to load /_cb/client.js`, async () => {
      const probe = `<!doctype html><meta charset="utf-8"><script>
const s = document.createElement('script')
s.src = ${JSON.stringify(`${L.origin}/_cb/client.js`)}
s.onload = () => { window.__probe = 'loaded:' + typeof window.ArtifactCallbacks }
s.onerror = () => { window.__probe = 'error:' + typeof window.ArtifactCallbacks }
document.head.appendChild(s)
</script>`
      const evil = await otherServer({ '/probe.html': probe }, host)
      const before = L.lines.length
      const ctx = await browser.newContext()
      try {
        const p = await ctx.newPage()
        await p.goto(`http://${host}:${evil.port}/probe.html`)
        await p.waitForFunction(() => typeof window.__probe === 'string', null, { timeout: 10000 })
        assert.equal(await p.evaluate(() => window.__probe), 'error:undefined')
        await L.marker()
        const line = L.lines.slice(before).find((l) => l.type === 'rejected' && l.path === '/_cb/client.js')
        assert.equal(line?.reason, 'sec-fetch-site')
      } finally {
        await ctx.close()
        await evil.close()
      }
    })
  }
})
