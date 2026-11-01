// Declarative data-cb-* wiring in real Chromium against a real listener.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildStatus, serializeStatus } from '../../hooks/lib/status.ts'
import { launch, startListener, page, events, settledEvents, open, waitAttr, attr, waitFor } from './helpers.ts'
import type { Browser, Listener } from './helpers.ts'

let browser: Browser, L: Listener
before(async () => {
  browser = await launch()
  L = await startListener()
})
after(async () => {
  await browser.close()
  await L.cleanup()
})

/** Index of events so far, so each test only looks at its own. */
function mark () {
  return events(L).length
}

describe('buttons and links', () => {
  test('clicking a wired button emits exactly one event with page, action, data, label and prompt', async () => {
    L.writePage('triage.html', page(`
      <ul><li>test_auth_refresh
        <button id="fix" data-cb-action="fix"
          data-cb-data='{"test":"test_auth_refresh","file":"tests/auth.py"}'
          data-cb-prompt="Fix the failing test {{data.test}} in {{data.file}} &amp; update triage.html.">
          Fix   this
        </button></li></ul>`))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/triage.html`)
    try {
      await p.click('#fix')
      await waitFor(() => events(L).length > m, { what: 'event' })
      const evs = (await settledEvents(L)).slice(m)
      assert.equal(evs.length, 1)
      const ev = evs[0]
      assert.equal(ev.servedPage, 'triage.html')
      assert.equal(ev.body.page, 'triage.html')
      assert.equal(ev.body.action, 'fix')
      assert.deepEqual(ev.body.data, { test: 'test_auth_refresh', file: 'tests/auth.py' })
      assert.equal(ev.body.label, 'Fix this')
      assert.equal(ev.body.prompt, 'Fix the failing test {{data.test}} in {{data.file}} & update triage.html.')
      assert.match(ev.body.idempotencyKey, /^[0-9a-f-]{16,}$/)
      await waitAttr(p, '#fix', 'data-cb-state', 'queued')
      assert.equal(await attr(p, '#fix', 'data-cb-event'), ev.id)
      await p.waitForSelector('[data-cb-toast]')
      assert.match(String(await p.locator('[data-cb-toast]').first().textContent()), /Sent to Claude: Fix this/)
      assert.deepEqual(p.__errors || [], [])
    } finally {
      await ctx.close()
    }
  })

  test('data-cb-label overrides the text; links are wired and do not navigate', async () => {
    L.writePage('links.html', page(`
      <a id="lnk" href="/elsewhere" data-cb-action="open-item" data-cb-label="Open #7" data-cb-data='{"n":7}'>open</a>`))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/links.html`)
    try {
      await p.click('#lnk')
      await waitFor(() => events(L).length > m, { what: 'event' })
      const [ev] = events(L).slice(m)
      assert.equal(ev.body.action, 'open-item')
      assert.equal(ev.body.label, 'Open #7')
      assert.deepEqual(ev.body.data, { n: 7 })
      assert.equal(ev.body.prompt, undefined)
      assert.equal(new URL(p.url()).pathname, '/a/links.html')
    } finally {
      await ctx.close()
    }
  })

  test('invalid data-cb-data sends nothing and says so', async () => {
    L.writePage('bad.html', page('<button id="b" data-cb-action="x" data-cb-data="{oops">X</button>'))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/bad.html`)
    try {
      await p.click('#b')
      await p.waitForSelector('[data-cb-toast="error"]')
      assert.equal((await settledEvents(L)).length, m)
      assert.equal(await attr(p, '#b', 'data-cb-state'), null)
    } finally {
      await ctx.close()
    }
  })

  test('a double click sends one event', async () => {
    L.writePage('dbl.html', page('<button id="d" data-cb-action="once">Once</button>'))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/dbl.html`)
    try {
      await p.dblclick('#d')
      await p.click('#d')
      await waitFor(() => events(L).length > m, { what: 'event' })
      assert.equal((await settledEvents(L, 500)).length - m, 1)
    } finally {
      await ctx.close()
    }
  })
})

describe('data-cb-confirm', () => {
  test('accept sends, cancel does not', async () => {
    L.writePage('confirm.html', page('<button id="del" data-cb-action="delete" data-cb-confirm="Really delete?">Delete</button>'))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/confirm.html`)
    try {
      const messages: string[] = []
      p.once('dialog', (d) => { messages.push(d.message()); d.dismiss() })
      await p.click('#del')
      assert.equal((await settledEvents(L)).length, m)
      assert.equal(await attr(p, '#del', 'data-cb-state'), null)
      p.once('dialog', (d) => { messages.push(d.message()); d.accept() })
      await p.click('#del')
      await waitFor(() => events(L).length > m, { what: 'event' })
      assert.equal((await settledEvents(L)).length - m, 1)
      assert.deepEqual(messages, ['Really delete?', 'Really delete?'])
    } finally {
      await ctx.close()
    }
  })
})

describe('forms', () => {
  test('submitting a form sends named fields as data, merged over data-cb-data', async () => {
    L.writePage('form.html', page(`
      <form id="f" data-cb-action="file-bug" data-cb-data='{"source":"triage","title":"overridden"}'>
        <input name="title" value="Crash on save">
        <textarea name="body">line1
line2</textarea>
        <input type="checkbox" name="urgent" checked>
        <input type="checkbox" name="notify">
        <input type="checkbox" name="tags" value="ui" checked>
        <input type="checkbox" name="tags" value="db">
        <input type="checkbox" name="tags" value="api" checked>
        <input type="radio" name="sev" value="low">
        <input type="radio" name="sev" value="high" checked>
        <input type="radio" name="none" value="a">
        <select name="owner"><option>ann</option><option selected>bob</option></select>
        <select name="labels" multiple><option selected>x</option><option>y</option><option selected>z</option></select>
        <input name="secret" value="skip me" disabled>
        <fieldset disabled><input name="infs" value="skip too"></fieldset>
        <input type="file" name="upload">
        <input name="unnamed-not" value="kept">
        <input value="no name">
        <button name="via" value="submit-a" type="submit">File bug</button>
        <button name="other" value="submit-b" type="submit">Other</button>
      </form>`))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/form.html`)
    try {
      await p.click('button[name=via]')
      await waitFor(() => events(L).length > m, { what: 'event' })
      const [ev] = events(L).slice(m)
      assert.equal(ev.body.action, 'file-bug')
      assert.equal(ev.body.label, 'File bug')
      assert.deepEqual(ev.body.data, {
        source: 'triage',
        title: 'Crash on save',
        body: 'line1\nline2',
        urgent: true,
        notify: false,
        tags: ['ui', 'api'],
        sev: 'high',
        none: null,
        owner: 'bob',
        labels: ['x', 'z'],
        'unnamed-not': 'kept',
        via: 'submit-a'
      })
      await waitAttr(p, '#f', 'data-cb-state', 'queued')
      assert.equal(new URL(p.url()).pathname, '/a/form.html')
    } finally {
      await ctx.close()
    }
  })

  test('pressing Enter in a field submits; data-cb-label wins for forms', async () => {
    L.writePage('form2.html', page(`
      <form id="f" data-cb-action="search" data-cb-label="Search">
        <input id="q" name="q"><button>Go</button>
      </form>`))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/form2.html`)
    try {
      await p.fill('#q', 'flaky tests')
      await p.press('#q', 'Enter')
      await waitFor(() => events(L).length > m, { what: 'event' })
      const [ev] = events(L).slice(m)
      assert.deepEqual(ev.body.data, { q: 'flaky tests' })
      assert.equal(ev.body.label, 'Search')
    } finally {
      await ctx.close()
    }
  })
})

describe('data-cb-state lifecycle from status.json', () => {
  test('queued → running → done, then a new click is allowed', async () => {
    L.writePage('state.html', page('<button id="s" data-cb-action="work">Work</button>'))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/state.html`)
    try {
      await p.click('#s')
      await waitFor(() => events(L).length > m, { what: 'event' })
      const id = events(L)[m].id
      await waitAttr(p, '#s', 'data-cb-state', 'queued')
      assert.equal(await attr(p, '#s', 'aria-busy'), 'true')
      L.writeStatus({ queueDepth: 1, events: { [id]: { id, state: 'awaiting-approval', page: 'state.html', action: 'work' } } })
      await waitAttr(p, '#s', 'data-cb-detail', 'awaiting-approval')
      assert.equal(await attr(p, '#s', 'data-cb-state'), 'queued')
      // still in flight: clicks are ignored
      await p.click('#s')
      L.writeStatus({ events: { [id]: { id, state: 'running', page: 'state.html', action: 'work', turnStartedAt: Date.now() } } })
      await waitAttr(p, '#s', 'data-cb-state', 'running')
      assert.equal(await attr(p, '#s', 'data-cb-detail'), null)
      await p.click('#s')
      L.writeStatus({ events: { [id]: { id, state: 'done', page: 'state.html', action: 'work', turnStartedAt: 1, turnEndedAt: 2 } } })
      await waitAttr(p, '#s', 'data-cb-state', 'done')
      assert.equal(await attr(p, '#s', 'aria-busy'), null)
      await p.waitForSelector('[data-cb-toast="ok"]')
      assert.equal((await settledEvents(L)).length - m, 1)
      await p.click('#s')
      await waitFor(() => events(L).length > m + 1, { what: 'second event' })
      await waitAttr(p, '#s', 'data-cb-state', 'queued')
    } finally {
      await ctx.close()
    }
  })

  test('rejected by the mod → rejected', async () => {
    L.writePage('rej.html', page('<button id="r" data-cb-action="nope">Nope</button>'))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/rej.html`)
    try {
      await p.click('#r')
      await waitFor(() => events(L).length > m, { what: 'event' })
      const id = events(L)[m].id
      L.writeStatus({ events: { [id]: { id, state: 'rejected', page: 'rej.html', action: 'nope' } } })
      await waitAttr(p, '#r', 'data-cb-state', 'rejected')
      assert.equal(await attr(p, '#r', 'data-cb-detail'), null)
    } finally {
      await ctx.close()
    }
  })

  test('expired → rejected with detail expired', async () => {
    L.writePage('exp.html', page('<button id="e" data-cb-action="slow">Slow</button>'))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/exp.html`)
    try {
      await p.click('#e')
      await waitFor(() => events(L).length > m, { what: 'event' })
      const id = events(L)[m].id
      L.writeStatus({ events: { [id]: { id, state: 'expired', page: 'exp.html', action: 'slow' } } })
      await waitAttr(p, '#e', 'data-cb-detail', 'expired')
      assert.equal(await attr(p, '#e', 'data-cb-state'), 'rejected')
      await p.waitForSelector('[data-cb-toast="error"]')
      assert.match(String(await p.locator('[data-cb-toast="error"]').textContent()), /Expired/)
    } finally {
      await ctx.close()
    }
  })

  test('paused → rejected with detail dropped, reason paused, and a toast', async () => {
    L.writePage('paused.html', page('<button id="p" data-cb-action="x">X</button>'))
    const { page: p, ctx } = await open(browser, `${L.origin}/a/paused.html`)
    try {
      L.writeStatus({ paused: true })
      await p.click('#p')
      await waitAttr(p, '#p', 'data-cb-state', 'rejected')
      assert.equal(await attr(p, '#p', 'data-cb-detail'), 'dropped')
      assert.equal(await attr(p, '#p', 'data-cb-reason'), 'paused')
      await p.waitForSelector('[data-cb-toast="error"]')
      assert.match(String(await p.locator('[data-cb-toast="error"]').textContent()), /paused/)
      await L.waitLine((l) => l.type === 'dropped' && l.reason === 'paused' && l.servedPage === 'paused.html')
    } finally {
      L.writeStatus({ paused: false })
      await ctx.close()
    }
  })

  for (const reason of ['paused', 'queue-full'] as const) {
    test(`accepted by the listener, then dropped by the mod (${reason}): the page names the reason`, async () => {
      // The race: status.json said not paused and not full when the listener answered
      // 202, but the mod was paused (or full) by the time it read the event line.
      const file = `late-${reason}.html`
      L.writePage(file, page('<button id="r" data-cb-action="x">X</button>'))
      const m = mark()
      const { page: p, ctx } = await open(browser, `${L.origin}/a/${file}`)
      try {
        await p.click('#r')
        await waitFor(() => events(L).length > m, { what: 'event' })
        const ev = events(L)[m]
        const rec = {
          id: String(ev.id), state: 'dropped' as const, page: file, action: 'x', label: 'X', receivedAt: 1,
          turnStartedAt: null, turnEndedAt: null, note: reason, coalescedInto: null, expiresAt: null, turnId: null, dataKey: '{}'
        }
        // What the mod writes, through its own serializer.
        L.writeStatus(serializeStatus(buildStatus({ paused: reason === 'paused', queue: [], events: [rec] })))
        await waitAttr(p, '#r', 'data-cb-detail', 'dropped')
        assert.equal(await attr(p, '#r', 'data-cb-state'), 'rejected')
        assert.equal(await attr(p, '#r', 'data-cb-reason'), reason)
        await p.waitForSelector('[data-cb-toast="error"]')
        const text = String(await p.locator('[data-cb-toast="error"]').textContent())
        assert.match(text, reason === 'paused' ? /paused/ : /too many events are already waiting/)
        assert.doesNotMatch(text, /\(dropped\)/)
      } finally {
        L.writeStatus({ paused: false })
        await ctx.close()
      }
    })
  }
})

describe('stale tab', () => {
  test('a template that changed on disk gets 409, the page asks to reload, and reloading fixes it', async () => {
    L.writePage('stale.html', page('<button id="t" data-cb-action="go" data-cb-prompt="Old template">Go</button>'))
    const m = mark()
    const { page: p, ctx } = await open(browser, `${L.origin}/a/stale.html`)
    try {
      L.writePage('stale.html', page('<button id="t" data-cb-action="go" data-cb-prompt="New template">Go</button>'))
      await p.click('#t')
      await waitAttr(p, '#t', 'data-cb-state', 'rejected')
      assert.equal(await attr(p, '#t', 'data-cb-reason'), 'template-changed')
      const toast = p.locator('[data-cb-toast="error"]')
      await toast.waitFor()
      assert.match(String(await toast.textContent()), /changed.*Reload/s)
      await L.waitLine((l) => l.type === 'rejected' && l.reason === 'template-changed')
      assert.equal((await settledEvents(L)).length, m)
      await Promise.all([p.waitForEvent('load'), p.click('[data-cb-toast-action]')])
      await p.waitForFunction(() => !!window.ArtifactCallbacks)
      await p.click('#t')
      await waitFor(() => events(L).length > m, { what: 'event after reload' })
      assert.equal(events(L)[m].body.prompt, 'New template')
    } finally {
      await ctx.close()
    }
  })
})
