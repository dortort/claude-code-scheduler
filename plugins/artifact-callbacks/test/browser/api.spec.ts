// window.ArtifactCallbacks imperative API, reply streaming, and file:// token mode.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHmac } from 'node:crypto'
import { launch, startListener, page, events, settledEvents, open, waitAttr, attr, sleep } from './helpers.ts'
import type { Browser, Listener } from './helpers.ts'
import { makeDirs } from '../conformance/harness.ts'

let browser: Browser
before(async () => { browser = await launch() })
after(async () => { await browser.close() })

describe('imperative API', () => {
  let L: Listener
  before(async () => {
    const dirs = makeDirs()
    L = await startListener({ dirs, env: { CB_STREAM_DIR: dirs.streams } })
    L.writePage('app.html', page('<p>app</p>'))
  })
  after(() => L.cleanup())

  test('send → handle; on("state") replays and follows; done resolves; onDone fires', async () => {
    const m = events(L).length
    const { page: p, ctx } = await open(browser, `${L.origin}/a/app.html`)
    try {
      const id = await p.evaluate(async () => {
        window.__states = []
        window.__globalDone = []
        window.__handleDone = []
        window.ArtifactCallbacks.onDone((h) => window.__globalDone.push(h.id))
        const ev = await window.ArtifactCallbacks.send('reorder', { order: ['b', 'a', 'c'] }, { label: 'Reorder' })
        window.__ev = ev
        ev.on('state', (s) => window.__states.push(s))
        ev.onDone((h) => window.__handleDone.push(h.id))
        window.__donePromise = ev.done.then((h) => 'resolved:' + h.state, (e) => 'rejected:' + e.state)
        return ev.id
      })
      assert.ok(id)
      const [ev] = (await settledEvents(L)).slice(m)
      assert.equal(ev.id, id)
      assert.equal(ev.body.action, 'reorder')
      assert.deepEqual(ev.body.data, { order: ['b', 'a', 'c'] })
      assert.equal(ev.body.label, 'Reorder')
      assert.equal(ev.servedPage, 'app.html')
      L.writeStatus({ events: { [id]: { id, state: 'running', page: 'app.html', action: 'reorder' } } })
      await p.waitForFunction(() => window.__states.includes('running'))
      L.writeStatus({ events: { [id]: { id, state: 'done', page: 'app.html', action: 'reorder', note: 'coalesced' } } })
      assert.equal(await p.evaluate(() => window.__donePromise), 'resolved:done')
      const out = await p.evaluate(() => ({ states: window.__states, g: window.__globalDone, h: window.__handleDone, note: window.__ev.note }))
      assert.deepEqual(out.states, ['queued', 'running', 'done'])
      assert.deepEqual(out.g, [id])
      assert.deepEqual(out.h, [id])
      assert.equal(out.note, 'coalesced')
    } finally {
      await ctx.close()
    }
  })

  test('done rejects on dropped, rejected and expired', async () => {
    const { page: p, ctx } = await open(browser, `${L.origin}/a/app.html`)
    try {
      L.writeStatus({ paused: true })
      const dropped = await p.evaluate(async () => {
        const ev = await window.ArtifactCallbacks.send('x', {}, { toast: false })
        return ev.done.then(() => 'resolved', (e) => [e.state, e.reason, ev.state, ev.reason, !!ev.id])
      })
      assert.deepEqual(dropped, ['dropped', 'paused', 'dropped', 'paused', true])
      L.writeStatus({ paused: false })
      for (const terminal of ['rejected', 'expired']) {
        const id = await p.evaluate(async () => {
          const ev = await window.ArtifactCallbacks.send('y')
          window.__p = ev.done.then(() => 'resolved', (e) => 'rejected:' + e.state)
          return ev.id
        })
        assert.ok(id)
        L.writeStatus({ events: { [id]: { id, state: terminal, page: 'app.html', action: 'y' } } })
        assert.equal(await p.evaluate(() => window.__p), 'rejected:' + terminal)
      }
      assert.deepEqual(p.__errors || [], [])
    } finally {
      L.writeStatus({ paused: false })
      await ctx.close()
    }
  })

  test('opts.prompt is verified; opts.idempotencyKey dedupes across calls', async () => {
    L.writePage('tpl.html', page('<template><b data-cb-prompt="Do {{data.x}}"></b></template>'))
    const m = events(L).length
    const { page: p, ctx } = await open(browser, `${L.origin}/a/tpl.html`)
    try {
      const r = await p.evaluate(async () => {
        const ok = await window.ArtifactCallbacks.send('do', { x: 1 }, { prompt: 'Do {{data.x}}', idempotencyKey: 'same-key' })
        const again = await window.ArtifactCallbacks.send('do', { x: 1 }, { prompt: 'Do {{data.x}}', idempotencyKey: 'same-key' })
        const bad = await window.ArtifactCallbacks.send('do', {}, { prompt: 'Invented', toast: false })
        return [ok.id === again.id, ok.state, bad.state, bad.reason]
      })
      assert.deepEqual(r, [true, 'queued', 'rejected', 'template-changed'])
      assert.equal((await settledEvents(L)).length - m, 1)
    } finally {
      await ctx.close()
    }
  })

  test('reply text streams to handle.on("text") over SSE', async () => {
    const { page: p, ctx } = await open(browser, `${L.origin}/a/app.html`)
    try {
      const id = await p.evaluate(async () => {
        window.__text = []
        window.__st = []
        const ev = await window.ArtifactCallbacks.send('ask', { q: 'why' })
        ev.on('text', (t) => window.__text.push(t))
        ev.on('state', (s) => window.__st.push(s))
        window.__done = ev.done.then(() => 'done')
        return ev.id
      })
      assert.ok(id)
      const file = join(L.dirs.streams, `${id}.ndjson`)
      appendFileSync(file, JSON.stringify({ type: 'state', state: 'running' }) + '\n')
      appendFileSync(file, JSON.stringify({ type: 'text', text: 'Because ' }) + '\n')
      await p.waitForFunction(() => window.__text.length === 1)
      appendFileSync(file, JSON.stringify({ type: 'text', text: 'tests are flaky.\nDone.' }) + '\n')
      await p.waitForFunction(() => window.__text.length === 2)
      assert.deepEqual(await p.evaluate(() => window.__text), ['Because ', 'tests are flaky.\nDone.'])
      assert.ok((await p.evaluate(() => window.__st)).includes('running'))
      L.writeStatus({ events: { [id]: { id, state: 'done', page: 'app.html', action: 'ask' } } })
      assert.equal(await p.evaluate(() => window.__done), 'done')
      // after end the EventSource is closed and does not reconnect / replay
      await sleep(600)
      assert.equal(await p.evaluate(() => window.__text.length), 2)
    } finally {
      await ctx.close()
    }
  })

  test('declarative and imperative events update element state via data-cb-event', async () => {
    L.writePage('mix.html', page('<button id="b" data-cb-action="mix">Mix</button>'))
    const { page: p, ctx } = await open(browser, `${L.origin}/a/mix.html`)
    try {
      await p.click('#b')
      await p.waitForFunction(() => document.querySelector('#b')?.hasAttribute('data-cb-event'))
      const id = await attr(p, '#b', 'data-cb-event')
      assert.ok(id)
      L.writeStatus({ events: { [id]: { id, state: 'done', page: 'mix.html', action: 'mix' } } })
      await waitAttr(p, '#b', 'data-cb-state', 'done')
    } finally {
      await ctx.close()
    }
  })
})

describe('file:// token mode', () => {
  function filePage (L: Listener, rel: string, { token = true, endpoint = true, extra = '' } = {}): string {
    const tok = createHmac('sha256', Buffer.from(L.secret, 'utf8')).update('page:' + rel).digest('hex')
    const metas = (token ? `<meta name="cb-token" content="${tok}">` : '') +
      (endpoint ? `<meta name="cb-endpoint" content="${L.origin}">` : '') + extra
    const html = `<!doctype html><html><head><meta charset="utf-8">${metas}` +
      `<script src="${L.origin}/_cb/client.js"></script></head><body>` +
      '<button id="go" data-cb-action="from-file" data-cb-data=\'{"k":1}\' data-cb-prompt="File {{data.k}}">Go</button></body></html>'
    const abs = L.writePage(rel, html)
    return pathToFileURL(abs).href
  }

  test('enabled: a click from a file:// page is accepted and its state is polled', async () => {
    const L = await startListener({ env: { CB_ALLOW_FILE_ORIGIN: '1' } })
    try {
      const url = filePage(L, 'sub/file page.html')
      const { page: p, ctx } = await open(browser, url)
      try {
        await p.click('#go')
        const ev = await L.waitLine((l) => l.type === 'event')
        assert.equal(ev.servedPage, 'sub/file page.html')
        assert.equal(ev.body.action, 'from-file')
        assert.equal(ev.body.prompt, 'File {{data.k}}')
        assert.deepEqual(ev.body.data, { k: 1 })
        await waitAttr(p, '#go', 'data-cb-state', 'queued')
        L.writeStatus({ events: { [ev.id]: { id: ev.id, state: 'running', page: 'sub/file page.html', action: 'from-file' } } })
        await waitAttr(p, '#go', 'data-cb-state', 'running')
        L.writeStatus({ events: { [ev.id]: { id: ev.id, state: 'done', page: 'sub/file page.html', action: 'from-file' } } })
        await waitAttr(p, '#go', 'data-cb-state', 'done')
      } finally {
        await ctx.close()
      }
    } finally {
      await L.cleanup()
    }
  })

  test('enabled: cb-page meta names the page; reply text streams through fetch', async () => {
    const dirs = makeDirs()
    const L = await startListener({ dirs, env: { CB_ALLOW_FILE_ORIGIN: '1', CB_STREAM_DIR: dirs.streams } })
    try {
      // The file lives elsewhere (e.g. a copy); cb-page tells the client which artifact it is.
      filePage(L, 'named.html', { extra: '<meta name="cb-page" content="named.html">' })
      const copy = join(dirs.base, 'copy-of-named.html')
      copyFileSync(join(L.root, 'named.html'), copy)
      const url = pathToFileURL(copy).href
      const { page: p, ctx } = await open(browser, url)
      try {
        const id = await p.evaluate(async () => {
          window.__t = []
          const ev = await window.ArtifactCallbacks.send('ask')
          ev.on('text', (t) => window.__t.push(t))
          return ev.id
        })
        assert.equal((await L.waitLine((l) => l.type === 'event' && l.id === id)).servedPage, 'named.html')
        appendFileSync(join(dirs.streams, `${id}.ndjson`), JSON.stringify({ type: 'text', text: 'hi from Claude' }) + '\n' + JSON.stringify({ type: 'end' }) + '\n')
        await p.waitForFunction(() => window.__t.length === 1)
        assert.deepEqual(await p.evaluate(() => window.__t), ['hi from Claude'])
      } finally {
        await ctx.close()
      }
    } finally {
      await L.cleanup()
    }
  })

  test('disabled (default): the same page cannot even load the client, and sends nothing', async () => {
    const L = await startListener()
    try {
      const url = filePage(L, 'off.html')
      const ctx = await browser.newContext()
      try {
        const p = await ctx.newPage()
        await p.goto(url)
        // A file:// page is cross-site to the listener: without token mode client.js is refused.
        await L.waitLine((l) => l.type === 'rejected' && l.reason === 'sec-fetch-site' && l.path === '/_cb/client.js')
        assert.equal(await p.evaluate(() => typeof window.ArtifactCallbacks), 'undefined')
        await p.click('#go')
        await sleep(300)
        await L.marker()
        assert.equal(events(L).length, 0)
        assert.equal(await attr(p, '#go', 'data-cb-state'), null)
      } finally {
        await ctx.close()
      }
    } finally {
      await L.cleanup()
    }
  })

  test('enabled but no token meta: nothing is sent', async () => {
    const L = await startListener({ env: { CB_ALLOW_FILE_ORIGIN: '1' } })
    try {
      const url = filePage(L, 'notoken.html', { token: false })
      const { page: p, ctx } = await open(browser, url)
      try {
        await p.click('#go')
        await waitAttr(p, '#go', 'data-cb-state', 'rejected')
        await sleep(200)
        await L.marker()
        assert.equal(events(L).length, 0)
      } finally {
        await ctx.close()
      }
    } finally {
      await L.cleanup()
    }
  })

  test('enabled, wrong token: 403 auth and no event', async () => {
    const L = await startListener({ env: { CB_ALLOW_FILE_ORIGIN: '1' } })
    try {
      const url = filePage(L, 'wrong.html', { token: false, extra: `<meta name="cb-token" content="${'0'.repeat(64)}">` })
      const { page: p, ctx } = await open(browser, url)
      try {
        await p.click('#go')
        await waitAttr(p, '#go', 'data-cb-state', 'rejected')
        await L.waitLine((l) => l.type === 'rejected' && l.reason === 'auth' && l.origin === 'null')
        assert.equal(events(L).length, 0)
      } finally {
        await ctx.close()
      }
    } finally {
      await L.cleanup()
    }
  })
})

