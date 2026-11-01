// Reply streaming across components: the hooks module's serializer
// (hooks/lib/stream.ts) writes <run dir>/streams/<id>.ndjson the way the mod
// does (the whole file through `.tmp` and a rename, stream before status.json),
// the real listener replays and tails it on /_cb/events/<id>/stream, and the
// page's handle.on('text') receives the text in Chromium.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReplyStream, STREAM_TEXT_CAP } from '../../hooks/lib/stream.ts'
import { makeDirs } from '../conformance/harness.ts'
import { launch, open, page, sleep, startListener, waitFor } from './helpers.ts'
import type { Browser, Listener, TrackedPage } from './helpers.ts'

let browser: Browser
let L: Listener
before(async () => {
  browser = await launch()
  const dirs = makeDirs()
  L = await startListener({ dirs, env: { CB_STREAM_DIR: dirs.streams } })
  L.writePage('reply.html', page('<button id="b" data-cb-action="explain">Explain</button>'))
})
after(async () => {
  await browser.close()
  L.cleanup()
})

/** The mod's write: the whole serialized stream through `<file>.tmp` and a rename. */
function writeStream (id: string, s: ReplyStream): void {
  const file = join(L.dirs.streams, `${id}.ndjson`)
  writeFileSync(`${file}.tmp`, s.toString())
  renameSync(`${file}.tmp`, file)
}

function setState (id: string, state: string, extra: Record<string, unknown> = {}): void {
  L.writeStatus({ events: { [id]: { id, state, page: 'reply.html', action: 'ask', ...extra } } })
}

/** Sends an event from the page and listens for its text and states. */
async function sendAndListen (p: TrackedPage): Promise<string> {
  const id = await p.evaluate(async () => {
    window.__text = []
    window.__st = []
    const ev = await window.ArtifactCallbacks.send('ask', { q: 'why' })
    ev.on('text', (t) => window.__text.push(t))
    ev.on('state', (s) => window.__st.push(s))
    // What the page has when done resolves: the note and how many text pieces arrived.
    window.__done = ev.done.then((h) => `done:${h.note ?? ''}:${window.__text.length}`, (h: { state?: string }) => `rejected:${h.state ?? ''}`)
    return ev.id
  })
  assert.ok(id)
  return id
}

describe('reply streaming, hooks serializer → listener → page', () => {
  test('text deltas arrive in order as the mod rewrites the file; done ends the stream', async () => {
    const { page: p, ctx } = await open(browser, `${L.origin}/a/reply.html`)
    try {
      const id = await sendAndListen(p)
      const s = new ReplyStream()
      // turnStarted: state running in the stream, then in status.json.
      s.state('running')
      writeStream(id, s)
      setState(id, 'running', { turnStartedAt: Date.now() })
      await p.waitForFunction(() => window.__st.includes('running'))
      // turn.step text, flushed in batches like the 250 ms timer does.
      s.text('Because ')
      writeStream(id, s)
      await p.waitForFunction(() => window.__text.length === 1)
      s.text('tests ')
      s.text('are flaky.\nDone.')
      writeStream(id, s)
      await p.waitForFunction(() => window.__text.length === 3)
      // turnCompleted: done and end go to the stream first, then status.json.
      s.state('done')
      s.end()
      writeStream(id, s)
      setState(id, 'done', { note: 'ok' })
      assert.equal(await p.evaluate(() => window.__done), 'done:ok:3')
      assert.deepEqual(await p.evaluate(() => window.__text), ['Because ', 'tests ', 'are flaky.\nDone.'])
      assert.equal((await p.evaluate(() => window.__st)).at(-1), 'done')
      await sleep(500)
      assert.equal(await p.evaluate(() => window.__text.length), 3, 'no replay after end')
    } finally {
      await ctx.close()
    }
  })

  test('a page that subscribes late gets the text so far replayed, then the rest', async () => {
    const { page: p, ctx } = await open(browser, `${L.origin}/a/reply.html`)
    try {
      const id = await p.evaluate(async () => {
        window.__ev = await window.ArtifactCallbacks.send('ask', {})
        return window.__ev.id
      })
      assert.ok(id)
      const s = new ReplyStream()
      s.state('running')
      s.text('one ')
      s.text('two ')
      writeStream(id, s)
      setState(id, 'running')
      await p.evaluate(() => {
        window.__text = []
        window.__ev.on('text', (t) => window.__text.push(t))
      })
      await p.waitForFunction(() => window.__text.length === 2)
      s.text('three')
      s.state('done')
      s.end()
      writeStream(id, s)
      setState(id, 'done')
      await p.waitForFunction(() => window.__text.length === 3)
      assert.deepEqual(await p.evaluate(() => window.__text), ['one ', 'two ', 'three'])
    } finally {
      await ctx.close()
    }
  })

  test('an interrupted turn: the stream ends with done and the page keeps the partial text', async () => {
    const { page: p, ctx } = await open(browser, `${L.origin}/a/reply.html`)
    try {
      const id = await sendAndListen(p)
      const s = new ReplyStream()
      s.state('running')
      s.text('Starting to')
      writeStream(id, s)
      setState(id, 'running')
      await p.waitForFunction(() => window.__text.length === 1)
      s.state('done')
      s.end()
      writeStream(id, s)
      setState(id, 'done', { note: 'interrupted' })
      assert.equal(await p.evaluate(() => window.__done), 'done:interrupted:1')
      assert.deepEqual(await p.evaluate(() => window.__text), ['Starting to'])
    } finally {
      await ctx.close()
    }
  })

  test('text past the serializer cap is not streamed; done still waits for all the text before it', async () => {
    const { page: p, ctx } = await open(browser, `${L.origin}/a/reply.html`)
    try {
      const id = await sendAndListen(p)
      const s = new ReplyStream()
      s.state('running')
      assert.equal(s.text('x'.repeat(STREAM_TEXT_CAP - 3)), true)
      assert.equal(s.text('abcdef'), true)
      assert.equal(s.text('more'), false)
      assert.equal(s.truncated, true)
      s.state('done')
      s.end()
      writeStream(id, s)
      setState(id, 'done')
      assert.equal(await p.evaluate(() => window.__done), 'done::2', 'done waits for the open stream\'s text')
      const lens = await p.evaluate(() => window.__text.map((t) => t.length))
      assert.deepEqual(lens, [STREAM_TEXT_CAP - 3, 3])
      assert.equal(await p.evaluate(() => window.__text[1]), 'abc')
    } finally {
      await ctx.close()
    }
  })

  test('the declarative path: a clicked button follows the stream\'s states', async () => {
    const { page: p, ctx } = await open(browser, `${L.origin}/a/reply.html`)
    try {
      const before = L.lines.filter((l) => l.type === 'event').length
      await p.click('#b')
      const ev = await waitFor(() => L.lines.filter((l) => l.type === 'event')[before], { what: 'the click' })
      const id = ev.id as string
      const s = new ReplyStream()
      s.state('running')
      writeStream(id, s)
      setState(id, 'running')
      await p.waitForFunction(() => document.getElementById('b')?.getAttribute('data-cb-state') === 'running')
      s.state('done')
      s.end()
      writeStream(id, s)
      setState(id, 'done')
      await p.waitForFunction(() => document.getElementById('b')?.getAttribute('data-cb-state') === 'done')
    } finally {
      await ctx.close()
    }
  })
})
