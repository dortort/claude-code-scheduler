// Startup, configuration errors, binding, and exit conditions.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  startListener, makeDirs, freePort, waitFor, pidAlive, sleep, request, PLUGIN_DIR, LISTENER_CMD
} from './harness.mjs'

describe('ready line', () => {
  test('random port: ready line is the first stdout line, nothing else is printed', async () => {
    const L = await startListener()
    try {
      assert.equal(L.raw.length, 1)
      const ready = L.lines[0]
      assert.deepEqual(Object.keys(ready).sort(), ['pid', 'port', 'type'])
      assert.equal(ready.type, 'ready')
      assert.ok(Number.isInteger(ready.port) && ready.port > 0 && ready.port < 65536)
      assert.equal(ready.pid, L.child.pid)
      const r = await L.req({ path: '/_cb/health' })
      assert.equal(r.status, 200)
    } finally {
      await L.cleanup()
    }
  })

  test('two listeners with CB_PORT=0 get different ports', async () => {
    const A = await startListener()
    const B = await startListener()
    try {
      assert.notEqual(A.port, B.port)
    } finally {
      await A.cleanup()
      await B.cleanup()
    }
  })

  test('fixed port is honoured', async () => {
    const port = await freePort()
    const L = await startListener({ env: { CB_PORT: String(port) } })
    try {
      assert.equal(L.port, port)
    } finally {
      await L.cleanup()
    }
  })

  test('binds 127.0.0.1 only', async () => {
    const L = await startListener()
    try {
      // ::1 (IPv6 loopback) must not answer.
      const err = await new Promise((resolve) => {
        const s = net.connect({ host: '::1', port: L.port })
        s.once('connect', () => { s.destroy(); resolve(null) })
        s.once('error', resolve)
      })
      assert.ok(err, 'listener must not accept on ::1')
    } finally {
      await L.cleanup()
    }
  })
})

describe('configuration errors', () => {
  async function expectError (env, reason, code, dirs) {
    const L = await startListener({ env, wait: false, dirs })
    try {
      const exit = await L.exited
      const errLine = L.lines.find((l) => l.type === 'error')
      assert.ok(errLine, `expected error line, got ${L.raw.join('|')} ${L.stderr}`)
      assert.equal(errLine.reason, reason)
      assert.equal(typeof errLine.message, 'string')
      assert.ok(!L.lines.some((l) => l.type === 'ready'))
      if (code !== undefined) assert.equal(exit.code, code)
      else assert.notEqual(exit.code, 0)
      return errLine
    } finally {
      await L.cleanup()
    }
  }

  test('port in use → error/port-in-use, exit 2', async () => {
    const blocker = net.createServer()
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    try {
      await expectError({ CB_PORT: String(blocker.address().port) }, 'port-in-use', 2)
    } finally {
      blocker.close()
    }
  })

  test('missing root → error/root-missing', async () => {
    const dirs = makeDirs()
    await expectError({ CB_ROOT: join(dirs.base, 'nope') }, 'root-missing', undefined, dirs)
  })

  test('root that is a file → error/root-missing', async () => {
    const dirs = makeDirs()
    await expectError({ CB_ROOT: dirs.statusFile + '.file' }, 'root-missing', undefined, dirs)
  })

  test('short secret → error/bad-config and the secret is not echoed', async () => {
    const line = await expectError({ CB_SECRET: 'abcdef' }, 'bad-config')
    assert.ok(!line.message.includes('abcdef'))
  })

  test('non-hex secret → error/bad-config', async () => {
    await expectError({ CB_SECRET: 'z'.repeat(64) }, 'bad-config')
  })

  test('missing secret → error/bad-config', async () => {
    await expectError({ CB_SECRET: undefined }, 'bad-config')
  })

  test('bad port → error/bad-config', async () => {
    await expectError({ CB_PORT: 'abc' }, 'bad-config')
    await expectError({ CB_PORT: '70000' }, 'bad-config')
  })

  test('missing status file variable → error/bad-config', async () => {
    await expectError({ CB_STATUS_FILE: undefined }, 'bad-config')
  })
})

describe('exit conditions', () => {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    test(`exits on ${sig}`, async () => {
      const L = await startListener()
      try {
        L.child.kill(sig)
        await Promise.race([L.exited, sleep(3000).then(() => { throw new Error('did not exit') })])
        assert.ok(!pidAlive(L.pid))
      } finally {
        await L.cleanup()
      }
    })
  }

  test('exits when its stdout pipe is closed (EPIPE on the next line)', async () => {
    const L = await startListener()
    try {
      L.child.stdout.destroy()
      // Provoke a stdout line: a bad-Host request is always reported.
      await L.req({ path: '/_cb/health', host: 'evil.example' }).catch(() => {})
      await Promise.race([L.exited, sleep(5000).then(() => { throw new Error('did not exit after EPIPE') })])
    } finally {
      await L.cleanup()
    }
  })

  test('exits when its parent process dies (orphaned)', async () => {
    const dirs = makeDirs()
    // An intermediate parent spawns the listener and pipes its stdout up to us.
    const script = `
      const { spawn } = require('child_process')
      const argv = JSON.parse(process.argv[1])
      const c = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] })
      setInterval(() => {}, 1000)
    `
    const env = {
      ...process.env,
      CB_PORT: '0',
      CB_ROOT: dirs.root,
      CB_STATUS_FILE: dirs.statusFile,
      CB_SECRET: 'ab'.repeat(32)
    }
    const parent = spawn(process.execPath, ['-e', script, JSON.stringify(LISTENER_CMD)], { cwd: PLUGIN_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    parent.stdout.on('data', (d) => { out += d })
    try {
      const ready = await waitFor(() => {
        const line = out.split('\n').find((l) => l.includes('"ready"'))
        return line && JSON.parse(line)
      }, { timeout: 10000, what: 'ready from grandchild' })
      assert.ok(pidAlive(ready.pid))
      parent.kill('SIGKILL')
      await waitFor(() => !pidAlive(ready.pid), { timeout: 6000, what: 'orphaned listener to exit' })
      // Our end of its stdout is still open, so it exited because of the parent.
    } finally {
      parent.kill('SIGKILL')
    }
  })

  test('tolerates a missing status.json (health reports not paused)', async () => {
    const L = await startListener()
    try {
      const r = await request({ port: L.port, path: '/_cb/health' })
      assert.deepEqual(r.json, { ok: true, paused: false })
    } finally {
      await L.cleanup()
    }
  })
})
