// Chromium end to end: a click in a real page reaches the session as a channel
// notification, callbacks_reply text streams into the page (handle.on('text')),
// and callbacks_done turns the button's data-cb-state to done.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { listenerInfo, startServer, waitFor, writePage } from '../helpers.ts'
import type { Client } from '../helpers.ts'

// Playwright is the preinstalled global, not a dev dependency: type the slice used here.
interface Page {
  goto (url: string): Promise<unknown>
  click (selector: string): Promise<void>
  evaluate<R> (fn: () => R | Promise<R>): Promise<R>
  waitForFunction (fn: () => unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>
  getAttribute (selector: string, name: string): Promise<string | null>
}
interface Browser { newPage (): Promise<Page>; close (): Promise<void> }
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch (): Promise<Browser> } }

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>triage</title>
<script src="/_cb/client.js"></script></head><body>
<button id="fix" data-cb-action="fix" data-cb-data='{"test":"test_auth"}'>Fix this</button>
<script>
  window.__text = []
  window.__states = []
</script></body></html>`

let browser: Browser
let c: Client
before(async () => {
  browser = await chromium.launch()
  c = startServer()
  writePage(c.project, 'triage.html', PAGE)
  await c.initialize()
})
after(async () => {
  await browser.close()
  await c.close()
})

async function openPage (port: number): Promise<Page> {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/a/triage.html`)
  await page.waitForFunction(() => !!(window as any).ArtifactCallbacks)
  await page.evaluate(() => {
    const w = window as any
    w.ArtifactCallbacks.config.pollMinMs = 80
    w.ArtifactCallbacks.config.pollMaxMs = 200
  })
  return page
}

describe('channel build in a browser', () => {
  test('a click arrives as a notification; callbacks_done turns the button done', async () => {
    const { port } = await listenerInfo(c)
    const page = await openPage(port)
    const before = c.channel().length
    await page.click('#fix')
    const n = await waitFor(() => c.channel()[before], 'the channel notification')
    const id = n.params.meta.event_id as string
    assert.deepEqual(n.params.meta, { event_id: id, page: 'triage.html', action: 'fix' })
    assert.match(n.params.content, /The user clicked "Fix this" \(action: fix\) on triage\.html\./)
    assert.match(n.params.content, /"test": "test_auth"/)
    await page.waitForFunction(() => document.getElementById('fix')?.getAttribute('data-cb-state') === 'running')
    await c.tool('callbacks_done', { event_id: id })
    await page.waitForFunction(() => document.getElementById('fix')?.getAttribute('data-cb-state') === 'done')
  })

  test('callbacks_reply text streams to handle.on("text"); done resolves the handle', async () => {
    const { port } = await listenerInfo(c)
    const page = await openPage(port)
    const before = c.channel().length
    await page.evaluate(async () => {
      const w = window as any
      const ev = await w.ArtifactCallbacks.send('explain', { why: 'flaky' }, { label: 'Explain' })
      ev.on('text', (t: string) => w.__text.push(t))
      ev.on('state', (s: string) => w.__states.push(s))
      w.__done = ev.done.then((h: any) => 'resolved:' + h.state + ':' + h.note, (h: any) => 'rejected:' + h.state)
    })
    const n = await waitFor(() => c.channel()[before], 'the channel notification')
    const id = n.params.meta.event_id as string
    await c.tool('callbacks_reply', { event_id: id, text: 'Fixing test_auth… ' })
    await page.waitForFunction(() => (window as any).__text.length === 1)
    await c.tool('callbacks_reply', { event_id: id, text: 'done.' })
    await page.waitForFunction(() => (window as any).__text.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).__text), ['Fixing test_auth… ', 'done.'])
    await c.tool('callbacks_done', { event_id: id, note: 'explained' })
    assert.equal(await page.evaluate(() => (window as any).__done), 'resolved:done:explained')
    const states = await page.evaluate(() => (window as any).__states as string[])
    assert.equal(states.at(-1), 'done')
    assert.ok(states.includes('running'))
  })
})
