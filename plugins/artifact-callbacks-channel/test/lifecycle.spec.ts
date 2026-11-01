// The listener's life under the channel server: restart with backoff (keeping
// the port), staying down after repeated failures, and the server exiting (and
// taking the listener with it) when Claude Code closes its stdin.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAlive, listenerInfo, startServer, waitFor } from './helpers.ts'
import type { Client } from './helpers.ts'

const clients: Client[] = []
function start (env: Record<string, string> = {}): Client {
  const c = startServer({ env })
  clients.push(c)
  return c
}
after(async () => { await Promise.all(clients.map((c) => c.close())) })

/** A stand-in listener that records each start and fails at once. */
function failingListener (): { script: string; starts: () => number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'cb-fail-'))
  const log = join(dir, 'starts.log')
  const script = join(dir, 'fail.ts')
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(log)}, \`\${Date.now()} \${process.env.CB_PORT}\\n\`)`,
    "process.stdout.write(JSON.stringify({ type: 'error', reason: 'bad-config', message: 'test failure' }) + '\\n')",
    'process.exit(1)',
  ].join('\n'))
  return {
    script,
    starts: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => Number(l.split(' ')[0])) : [],
  }
}

describe('supervision', () => {
  test('a killed listener comes back on the same port', async () => {
    const c = start({ CB_CHANNEL_BACKOFF_MS: '50,100,200' })
    await c.initialize()
    const first = await listenerInfo(c)
    process.kill(first.pid, 'SIGKILL')
    await waitFor(async () => /restarting/.test((await c.tool('callbacks_status')).text) || !isAlive(first.pid), 'the exit to be seen')
    const second = await listenerInfo(c)
    assert.notEqual(second.pid, first.pid)
    assert.equal(second.port, first.port)
    assert.match(c.stderr(), /restarting in 50 ms/)
  })

  test('restarts back off, then the listener stays down and says why', async () => {
    const fake = failingListener()
    const c = start({ CB_CHANNEL_LISTENER: fake.script, CB_CHANNEL_BACKOFF_MS: '100,300,600' })
    const init = await c.initialize()
    assert.match(init.instructions, /listener is not up yet/)
    await waitFor(async () => /Listener down/.test((await c.tool('callbacks_status')).text), 'down', 10000)
    const starts = fake.starts()
    assert.equal(starts.length, 4)
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] ?? 0))
    assert.ok((gaps[0] ?? 0) >= 100 && (gaps[1] ?? 0) >= 300 && (gaps[2] ?? 0) >= 600, `gaps ${gaps.join(', ')}`)
    assert.ok((gaps[1] ?? 0) > (gaps[0] ?? 0) && (gaps[2] ?? 0) > (gaps[1] ?? 0), `gaps grow: ${gaps.join(', ')}`)
    const { text } = await c.tool('callbacks_status')
    assert.match(text, /Listener down: bad-config: test failure\./)
    assert.match(c.stderr(), /listener down after 3 restarts/)
    // Nothing more is started.
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(fake.starts().length, 4)
  })

  test('a fixed port that is taken: the listener stays down with port-in-use', async () => {
    const holder = start()
    await holder.initialize()
    const { port } = await listenerInfo(holder)
    const c = start({ CB_PORT: String(port), CB_CHANNEL_BACKOFF_MS: '20,20,20' })
    await waitFor(async () => /Listener down: port-in-use/.test((await c.tool('callbacks_status')).text), 'port-in-use')
  })
})

describe('exit', () => {
  test('closing stdin stops the listener and the server, and removes the run folder', async () => {
    const c = start()
    await c.initialize()
    const { pid } = await listenerInfo(c)
    const runBase = join(c.project, '.claude', '.artifact-callbacks')
    c.proc.stdin.end()
    const { code } = await c.exited
    assert.equal(code, 0)
    await waitFor(() => !isAlive(pid), 'the listener to exit')
    assert.deepEqual(existsSync(runBase) ? readdirSync(runBase) : [], [])
  })

  test('SIGTERM does the same', async () => {
    const c = start()
    await c.initialize()
    const { pid } = await listenerInfo(c)
    c.proc.kill('SIGTERM')
    assert.equal((await c.exited).code, 0)
    await waitFor(() => !isAlive(pid), 'the listener to exit')
  })

  test('a server killed outright still takes the listener with it (the listener watches its parent)', async () => {
    const c = start()
    await c.initialize()
    const { pid } = await listenerInfo(c)
    c.proc.kill('SIGKILL')
    await c.exited
    await waitFor(() => !isAlive(pid), 'the orphaned listener to exit', 5000)
  })

  test('nothing but MCP messages is written to stdout', async () => {
    const c = start()
    await c.initialize()
    await listenerInfo(c)
    for (const m of c.messages) assert.equal(m.jsonrpc, '2.0')
  })
})
