// Real-session end-to-end: a real interactive Claude Code session (in tmux) with
// this mod loaded through --plugin-dir, driven by real Chromium through the
// listener the mod spawned. Assertions read the session transcript
// (~/.claude/projects/<slug>/*.jsonl), the page's data-cb-state and the
// terminal; none of them depend on what the model chooses to say, except the
// compose check, which asks for one number the system prompt section names.
//
// Skips (with the reason) when tmux, Playwright's Chromium, `claude`, or model
// access is unavailable. See test/e2e/README.md for how to run it and the
// evidence from a manual run.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, otherServer } from '../browser/helpers.ts'
import type { Browser, BrowserContext, Page } from '../browser/helpers.ts'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SESSION = 'cb-e2e'
// A tmux server of its own, so the suite never touches the person's sessions,
// with scrollback deep enough to hold the whole run.
const SOCKET = `cb-e2e-${process.pid}`
const STEP_MS = 180_000

// Variables a host session (a cloud container, or a Claude Code session running
// this suite) exports to its children. Left in place they would make the nested
// session believe it is that host: CLAUDE_CODE_REMOTE=true turns the mod off by
// design (a remote machine's loopback is not the user's browser), as do the
// SSH_* variables of a suite started over SSH (its browser runs on this machine),
// and the session id would make it write into the host's transcript.
const HOST_VARS = [
  'CLAUDE_CODE_REMOTE',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_AUTO_BACKGROUND_TASKS',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'SSH_TTY',
]

function sessionEnv (): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of HOST_VARS) delete env[name]
  return env
}

function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function has (cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

/** Why the suite cannot run here, or undefined when it can. */
async function unavailable (): Promise<string | undefined> {
  if (process.platform === 'win32') return 'needs tmux, which Windows does not have'
  if (!has('tmux', ['-V'])) return 'tmux is not installed'
  if (!has('claude', ['--version'])) return '`claude` is not on PATH'
  let browser: Browser | undefined
  try {
    browser = await launch()
  } catch (err) {
    return `Playwright Chromium is unavailable: ${String(err).split('\n')[0]}`
  } finally {
    await browser?.close()
  }
  const probe = realpathSync.native(mkdtempSync(join(tmpdir(), 'cb-e2e-probe-')))
  try {
    // Only a successful run's stdout counts: a failed run's error message quotes the
    // command line, prompt and all, so it would contain the expected word too.
    const why = await new Promise<string | undefined>((resolve) => {
      const child = execFile('claude', ['-p', 'Reply with the single word pong in capitals.'], { cwd: probe, env: sessionEnv(), timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) resolve(`exit ${String(err.code ?? err.signal)}: ${(stderr || stdout).trim().slice(0, 200)}`)
        else resolve(stdout.includes('PONG') ? undefined : `unexpected reply: ${stdout.trim().slice(0, 200)}`)
      })
      // Close stdin, or claude -p waits 3 s for piped input and its warning about
      // that becomes the reported reason instead of the real error.
      child.stdin?.end()
    })
    if (why !== undefined) return `no model access from a nested claude (${why})`
  } finally {
    rmSync(probe, { recursive: true, force: true })
    rmSync(projectDir(probe), { recursive: true, force: true })
  }
  return undefined
}

// ---- tmux -----------------------------------------------------------------

function tmux (...args: string[]): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' })
}

/** The visible screen plus scrollback, wrapped lines joined. */
function pane (): string {
  return tmux('capture-pane', '-p', '-J', '-t', SESSION, '-S', '-')
}

/** The last screenful only (the band, the prompt and the status line live here). */
function screen (): string {
  return tmux('capture-pane', '-p', '-J', '-t', SESSION)
}

function keys (...k: string[]): void {
  tmux('send-keys', '-t', SESSION, ...k)
}

async function type (text: string): Promise<void> {
  tmux('send-keys', '-t', SESSION, '-l', text)
  await sleep(800)
  keys('Enter')
}

async function until<T> (what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = STEP_MS): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined && v !== false) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- screen ---\n${screen()}`)
    await sleep(250)
  }
}

/** Runs /callbacks <args> and returns the command's output from the screen. */
async function callbacks (args = ''): Promise<string> {
  const marker = `/callbacks${args ? ` ${args}` : ''}`
  const before = pane().split(`❯ ${marker}`).length
  await type(marker)
  return until(`output of ${marker}`, () => {
    const parts = pane().split(`❯ ${marker}`)
    if (parts.length <= before) return undefined
    const out = parts[parts.length - 1] ?? ''
    return out.includes('⎿') ? out.split('\n────')[0] : undefined
  }, 20_000)
}

// ---- transcript -------------------------------------------------------------

interface Entry {
  type?: string
  isMeta?: boolean
  timestamp?: string
  origin?: { kind?: string; name?: string }
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> }
}

function projectDir (cwd: string): string {
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function text (e: Entry): string {
  const c = e.message?.content
  if (typeof c === 'string') return c
  return (c ?? []).map((p) => (p.type === 'text' ? p.text ?? '' : '')).join('')
}

let project = ''

function transcript (): Entry[] {
  const dir = projectDir(project)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const newest = files.map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (newest === undefined) return []
  return readFileSync(newest, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as Entry]
    } catch {
      return []
    }
  })
}

function pluginMessages (): Entry[] {
  return transcript().filter((e) => e.type === 'user' && !e.isMeta && e.origin?.kind === 'plugin' && e.origin.name === 'artifact-callbacks')
}

function eventContexts (): Entry[] {
  return transcript().filter((e) => e.type === 'user' && e.isMeta === true && text(e).startsWith('Artifact Callbacks: the raw event'))
}

// ---- page -----------------------------------------------------------------

const NONCE = Math.random().toString(36).slice(2, 10)

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>E2E</title>
<script src="/_cb/client.js" defer></script>
<button id="a" data-cb-action="fix" data-cb-data='{"marker":"a-${NONCE}"}'
  data-cb-prompt="Reply with only the word OK and nothing else. (marker {{data.marker}})">Fix A</button>
<button id="b" data-cb-action="skip" data-cb-data='{"marker":"b-${NONCE}"}'
  data-cb-prompt="Reply with only the word OK and nothing else. (marker {{data.marker}})">Skip B</button>
`

interface Tracked { page: Page; seen: string[] }

/** Opens the page in a fresh context and records every state the button shows. */
async function openPage (browser: Browser, url: string, selector: string): Promise<{ ctx: BrowserContext; t: Tracked }> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(url)
  await page.waitForFunction(() => !!window.ArtifactCallbacks)
  // A one-word reply's turn lasts about a second; at the default backoff the
  // client can poll straight past `running`. Poll fast so every state shows.
  await page.evaluate(() => { window.ArtifactCallbacks.config.pollMinMs = 80; window.ArtifactCallbacks.config.pollMaxMs = 200 })
  const t: Tracked = { page, seen: [] }
  const tick = setInterval(() => {
    page.evaluate((s: string) => {
      const el = document.querySelector(s)
      return el ? `${el.getAttribute('data-cb-state') ?? '-'}/${el.getAttribute('data-cb-detail') ?? '-'}` : 'gone'
    }, selector).then((s) => {
      if (t.seen[t.seen.length - 1] !== s) t.seen.push(s)
    }, () => {})
  }, 50)
  ctx.close = ((close) => async () => { clearInterval(tick); await close() })(ctx.close.bind(ctx))
  return { ctx, t }
}

function stateOf (t: Tracked): string {
  return t.seen[t.seen.length - 1] ?? ''
}

// ---- the suite ----------------------------------------------------------------

const reason = await unavailable()

describe('real interactive session', { skip: reason ?? false, timeout: 20 * 60_000 }, () => {
  let browser: Browser
  let port = 0
  let base = ''

  before(async () => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cb-e2e-')))
    execFileSync('git', ['init', '-q', project])
    mkdirSync(join(project, '.claude', 'artifacts'), { recursive: true })
    writeFileSync(join(project, '.claude', 'artifacts', 'e2e.html'), PAGE)
    const unset = HOST_VARS.map((n) => `-u ${n}`).join(' ')
    const conf = join(project, 'e2e.tmux.conf')
    writeFileSync(conf, 'set -g history-limit 100000\n')
    tmux('-f', conf, 'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
      `cd '${project}' && env ${unset} claude --plugin-dir '${PLUGIN_DIR}'; sleep 600`)
    // First-run screens: theme, security notes, folder trust. Each is answered
    // the way a person would; the loop ends when the mod's status line shows.
    port = await until('the listener status line', () => {
      const s = screen()
      const up = /callbacks :(\d+)/.exec(s)
      if (up) return Number(up[1])
      if (s.includes('Select login method')) throw new Error('the nested claude is not logged in, though the access probe passed')
      if (/❯ No, exit/.test(s) && s.includes('Yes, I trust this folder')) keys('Down')
      else if (/❯ Yes, I trust this folder/.test(s)) keys('Enter')
      else if (s.includes('Choose the text style') || s.includes('Press Enter to continue')) keys('Enter')
      return undefined
    }, 90_000)
    base = `http://127.0.0.1:${port}`
    browser = await launch()
  })

  after(async () => {
    await browser?.close()
    // Quit claude first and wait for it: it writes its transcript and project
    // files on the way out, which would land after the cleanup below.
    let pids: number[] = []
    try {
      const shell = tmux('display-message', '-p', '-t', SESSION, '#{pane_pid}').trim()
      pids = execFileSync('pgrep', ['-P', shell], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
    } catch {}
    try { tmux('kill-server') } catch {}
    const gone = (pid: number): boolean => { try { process.kill(pid, 0); return false } catch { return true } }
    const end = Date.now() + 15_000
    while (Date.now() < end && !pids.every(gone)) await sleep(200)
    if (project) {
      rmSync(project, { recursive: true, force: true })
      rmSync(projectDir(project), { recursive: true, force: true })
    }
  })

  test('listener is up: status line and /callbacks', async () => {
    assert.match(screen(), new RegExp(`callbacks :${port} · 0 queued`))
    const out = await callbacks()
    assert.match(out, new RegExp(`Listener: up at http://127\\.0\\.0\\.1:${port}/ \\(pid \\d+, node v\\d+\\.\\d+\\.\\d+\\)`))
    assert.match(out, /confirm: first-per-page/)
    const health = await fetch(`${base}/_cb/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, paused: false })
  })

  test('the compose section reaches the model', async () => {
    const n = transcript().length
    await type('Look only at your system prompt, use no tools: what port do interactive artifacts use? Reply with only the number.')
    const reply = await until('an assistant reply', () => {
      const later = transcript().slice(n).filter((e) => e.type === 'assistant').map(text).join('')
      return later.trim() ? later : undefined
    })
    assert.match(reply, new RegExp(`\\b${port}\\b`))
  })

  test('first click waits on the confirm band; Run starts a new framed turn; page shows queued → running → done', async () => {
    const before = pluginMessages().length
    const { ctx, t } = await openPage(browser, `${base}/a/e2e.html`, '#a')
    try {
      await t.page.click('#a')
      await until('awaiting-approval on the page', () => stateOf(t) === 'queued/awaiting-approval', 20_000)
      await until('the confirm band', () => screen().includes('e2e.html sent "Fix A" (action: fix)'), 20_000)
      assert.match(screen(), /\[ Run \] \[ Discard \] Run trusts this page for the session/)
      await sleep(1500)
      assert.equal(pluginMessages().length, before, 'nothing is submitted before Run')
      keys('C-x'); await sleep(300); keys('Tab'); await sleep(500)
      keys('Enter')
      await until('done on the page', () => stateOf(t).startsWith('done/'))
      const states = t.seen.map((s) => s.split('/')[0])
      const order = ['queued', 'running', 'done'].map((s) => states.indexOf(s))
      assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > (order[k - 1] ?? -1))), `states seen: ${t.seen.join(' → ')}`)
      const msgs = pluginMessages()
      assert.equal(msgs.length, before + 1)
      const msg = text(msgs[msgs.length - 1] ?? {})
      assert.match(msg, /^The artifact-callbacks plugin sent a message:/)
      assert.ok(msg.includes(`(marker "a-${NONCE}")`), msg)
      const ctxText = text(eventContexts().at(-1) ?? {})
      const raw = JSON.parse(ctxText.slice(ctxText.indexOf('{'))) as { id: string; servedPage: string; body: { action: string; data: { marker: string } } }
      assert.equal(raw.servedPage, 'e2e.html')
      assert.equal(raw.body.action, 'fix')
      assert.deepEqual(raw.body.data, { marker: `a-${NONCE}` })
      const out = await callbacks()
      assert.match(out, /Trusted pages: e2e\.html/)
      assert.match(out, new RegExp(`${raw.id}  e2e\\.html → fix  done`))
    } finally {
      await ctx.close()
    }
  })

  test('a click during a busy turn is queued and runs after it', async () => {
    const before = pluginMessages().length
    const { ctx, t } = await openPage(browser, `${base}/a/e2e.html`, '#b')
    try {
      await type('Without using any tools, write the numbers from 1 to 300 separated by spaces, then the word END.')
      await until('a busy turn', () => screen().includes('esc to interrupt'), 60_000)
      await t.page.click('#b')
      await until('queued on the page', () => stateOf(t) === 'queued/-', 10_000)
      assert.ok(screen().includes('esc to interrupt'), 'the busy turn is still running')
      assert.match(screen(), /callbacks :\d+ · 1 queued/)
      await until('done on the page', () => stateOf(t).startsWith('done/'))
      assert.deepEqual(t.seen.map((s) => s.split('/')[0]).filter((s, i, a) => s !== a[i - 1]), ['-', 'queued', 'running', 'done'])
      const entries = transcript()
      const numbersAt = entries.findIndex((e) => e.type === 'assistant' && /\b300\b/.test(text(e)))
      const eventAt = entries.findIndex((e) => e.origin?.kind === 'plugin' && text(e).includes(`(marker "b-${NONCE}")`))
      assert.ok(numbersAt >= 0 && eventAt > numbersAt, `busy reply at ${numbersAt}, event at ${eventAt}`)
      assert.equal(pluginMessages().length, before + 1)
    } finally {
      await ctx.close()
    }
  })

  test('a cross-origin page cannot trigger anything', async () => {
    const before = pluginMessages().length
    const target = base
    const evil = await otherServer({
      '/': `<!doctype html><body><script>
        window.results = {};
        (async () => {
          const body = JSON.stringify({ v: 1, action: 'evil', page: 'e2e.html' })
          try { const r = await fetch('${target}/_cb/event', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body }); results.json = r.status } catch (e) { results.json = 'blocked' }
          try { const r = await fetch('${target}/_cb/event', { method: 'POST', credentials: 'include', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body }); results.text = r.type } catch (e) { results.text = 'blocked' }
          results.done = true
        })()
      </script>`,
    })
    const ctx = await browser.newContext()
    try {
      // The same browser holds a valid cb_session cookie for the listener.
      const real = await ctx.newPage()
      await real.goto(`${base}/a/e2e.html`)
      const p = await ctx.newPage()
      await p.goto(`http://127.0.0.1:${evil.port}/`)
      await p.waitForFunction(() => (window as unknown as { results: { done?: boolean } }).results.done === true, undefined, { timeout: 15_000 })
      const results = await p.evaluate(() => (window as unknown as { results: Record<string, unknown> }).results)
      assert.equal(results.json, 'blocked', 'the JSON POST dies at the preflight')
      await sleep(3000)
      assert.equal(pluginMessages().length, before)
      assert.doesNotMatch(await callbacks(), /→ evil/)
    } finally {
      await ctx.close()
      await evil.close()
    }
  })

  test('/callbacks pause drops events and names the dropped control', async () => {
    const before = pluginMessages().length
    assert.match(await callbacks('pause'), /Paused/)
    await until('the paused status line', () => /callbacks :\d+ · paused/.test(screen()), 10_000)
    const { ctx, t } = await openPage(browser, `${base}/a/e2e.html`, '#a')
    try {
      await t.page.click('#a')
      await until('dropped on the page', () => stateOf(t) === 'rejected/dropped', 10_000)
      await sleep(3000)
      assert.equal(pluginMessages().length, before)
      assert.match(await callbacks(), /e2e\.html → fix {2}dropped \(paused\)/)
    } finally {
      await ctx.close()
      assert.match(await callbacks('resume'), /Resumed|resum/i)
    }
  })
})

