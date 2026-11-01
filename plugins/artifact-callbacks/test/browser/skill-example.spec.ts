// The complete example page in the interactive-artifacts skill, served by a
// real listener and clicked in Chromium: every wired control must produce the
// event the skill says it does, with its template accepted from disk.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { launch, startListener, events, settledEvents, open, waitAttr, waitFor } from './helpers.ts'
import type { Browser, Line, Listener, Page } from './helpers.ts'
import { PLUGIN_DIR, read, section, codeBlocks } from '../docs/helpers.ts'

const skill = read(PLUGIN_DIR, 'skills', 'interactive-artifacts', 'SKILL.md')
const html = codeBlocks(section(skill, 'Complete example')).find((b: { lang: string }) => b.lang === 'html')!.code

let browser: Browser, L: Listener
before(async () => {
  browser = await launch()
  L = await startListener()
  L.writePage('triage.html', html)
})
after(async () => {
  await browser.close()
  await L.cleanup()
})

async function clickAndGet (p: Page, selector: string): Promise<Line> {
  const m = events(L).length
  await p.click(selector)
  await waitFor(() => events(L).length > m, { what: 'event' })
  const evs = (await settledEvents(L)).slice(m)
  assert.equal(evs.length, 1, 'exactly one event')
  return evs[0]
}

test('the example page loads the client without errors', async () => {
  const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
  try {
    assert.equal(await p.evaluate(() => typeof window.ArtifactCallbacks.send), 'function')
    assert.deepEqual(p.__errors || [], [])
  } finally { await ctx.close() }
})

test('Fix sends its data and a template the listener accepts', async () => {
  const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
  try {
    const ev = await clickAndGet(p, 'li:first-child button[data-cb-action="fix"]')
    assert.equal(ev.servedPage, 'triage.html')
    assert.equal(ev.body.action, 'fix')
    assert.deepEqual(ev.body.data, { test: 'test_auth_refresh', file: 'tests/auth.py' })
    assert.equal(ev.body.label, 'Fix')
    assert.equal(ev.body.prompt, 'Fix the failing test {{data.test}} in {{data.file}}, then update triage.html.')
    await waitAttr(p, 'li:first-child button[data-cb-action="fix"]', 'data-cb-state', 'queued')
  } finally { await ctx.close() }
})

test('Skip sends without a prompt', async () => {
  const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
  try {
    const ev = await clickAndGet(p, 'li:nth-child(2) button[data-cb-action="skip"]')
    assert.equal(ev.body.action, 'skip')
    assert.deepEqual(ev.body.data, { test: 'test_cart_total' })
    assert.equal(ev.body.prompt, undefined)
  } finally { await ctx.close() }
})

test('the bulk form sends the checked tests as an array and the notes', async () => {
  const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
  try {
    await p.check('input[value="test_cart_total"]')
    await p.fill('textarea[name="notes"]', 'cart first')
    const ev = await clickAndGet(p, 'form[data-cb-action="fix-selected"] button')
    assert.equal(ev.body.action, 'fix-selected')
    assert.deepEqual(ev.body.data, { tests: ['test_cart_total'], notes: 'cart first' })
    assert.equal(ev.body.label, 'Fix selected')
    assert.match(ev.body.prompt, /^Fix these failing tests one by one: \{\{data\.tests \| json\}\}/)
  } finally { await ctx.close() }
})

test('Re-run tests uses its data-cb-label', async () => {
  const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
  try {
    const ev = await clickAndGet(p, 'button[data-cb-action="regenerate"]')
    assert.equal(ev.body.label, 'Re-run tests')
    assert.equal(ev.body.prompt, 'Re-run the test suite and rewrite triage.html with the current failures.')
  } finally { await ctx.close() }
})

test('Quarantine all asks first: dismissing sends nothing, accepting sends', async () => {
  const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
  try {
    const dialogs: string[] = []
    p.once('dialog', (d) => { dialogs.push(d.message()); d.dismiss() })
    const m = events(L).length
    await p.click('button[data-cb-action="quarantine-all"]')
    assert.equal((await settledEvents(L)).length, m, 'no event after Cancel')
    assert.deepEqual(dialogs, ['Mark every failing test as skipped in CI?'])

    p.once('dialog', (d) => d.accept())
    const ev = await clickAndGet(p, 'button[data-cb-action="quarantine-all"]')
    assert.equal(ev.body.action, 'quarantine-all')
  } finally { await ctx.close() }
})

test('the page reloads when an event is done (reload-on-done pattern)', async () => {
  const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
  try {
    await p.evaluate(() => { window.__marker = 1 })
    const ev = await clickAndGet(p, 'li:nth-child(2) button[data-cb-action="fix"]')
    L.writeStatus({ events: { [ev.id]: { id: ev.id, state: 'done', turnStartedAt: 1, turnEndedAt: 2, note: null } } })
    await p.waitForFunction(() => window.__marker === undefined, null, { timeout: 5000 })
    await p.waitForFunction(() => !!window.ArtifactCallbacks)
  } finally { await ctx.close() }
})
