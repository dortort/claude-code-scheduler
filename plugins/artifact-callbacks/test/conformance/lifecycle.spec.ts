// Startup, configuration errors, binding, and exit conditions.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  startListener, makeDirs, freePort, waitFor, pidAlive, sleep, request, PLUGIN_DIR, LISTENER_CMD
} from './harness.ts'
import type { Dirs, Line, StartOptions } from './harness.ts'
import type { AddressInfo } from 'node:net'

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
  async function expectError (env: StartOptions['env'], reason: string, code?: number, dirs?: Dirs): Promise<Line> {
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
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    try {
      await expectError({ CB_PORT: String((blocker.address() as AddressInfo).port) }, 'port-in-use', 2)
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
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
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

describe('restart keeps open tabs working (CB_SERVED_FILE)', () => {
  const PAGE = '<!doctype html><button data-cb-action="fix" data-cb-prompt="Fix it">Fix</button>'

  /** A listener on the same dirs, port and secret as a killed one, as the mod restarts it. */
  async function restartLike (dirs: Dirs, port: number, secret: string, servedFile: string | undefined) {
    return startListener({ dirs, env: { CB_PORT: String(port), CB_SECRET: secret, CB_SERVED_FILE: servedFile } })
  }

  test('a tab opened before a crash still sends events after the restart, templates included', async () => {
    const dirs = makeDirs()
    const servedFile = join(dirs.run, 'served-pages.json')
    const A = await startListener({ dirs, env: { CB_SERVED_FILE: servedFile } })
    let B: Awaited<ReturnType<typeof startListener>> | undefined
    try {
      await A.serve('p.html', PAGE)
      await A.serve('sub/q.html', PAGE)
      assert.equal((await A.post({ v: 1, action: 'fix' })).status, 202)
      await A.stop() // SIGKILL: no chance to write anything on the way out
      B = await restartLike(dirs, A.port, A.secret, servedFile)
      assert.equal(B.cookieValue, A.cookieValue, 'same secret and port: the tab keeps a valid cookie')
      // The old tab: same cookie, Referer from before the restart, never re-served by B.
      const r = await B.post({ v: 1, action: 'fix', prompt: 'Fix it' })
      assert.equal(r.status, 202, r.body)
      const r2 = await B.post({ v: 1, action: 'fix' }, { page: 'sub/q.html' })
      assert.equal(r2.status, 202, r2.body)
      const ev = await B.waitLine((l) => l.type === 'event' && l.servedPage === 'sub/q.html')
      assert.equal(ev.body.page, 'sub/q.html')
      // Pages never served by either stay refused.
      B.writePage('never.html', PAGE)
      const r3 = await B.post({ v: 1, action: 'fix' }, { page: 'never.html' })
      assert.equal(r3.status, 403)
    } finally {
      await A.cleanup()
      await B?.cleanup()
    }
  })

  test('without CB_SERVED_FILE a restarted listener knows no pages (403 page)', async () => {
    const dirs = makeDirs()
    const A = await startListener({ dirs })
    let B: Awaited<ReturnType<typeof startListener>> | undefined
    try {
      await A.serve('p.html', PAGE)
      await A.stop()
      B = await restartLike(dirs, A.port, A.secret, undefined)
      assert.equal((await B.post({ v: 1, action: 'fix' })).status, 403)
    } finally {
      await A.cleanup()
      await B?.cleanup()
    }
  })

  test('the file holds only served HTML pages; a broken or hostile file is ignored entry by entry', async () => {
    const dirs = makeDirs()
    const servedFile = join(dirs.run, 'served-pages.json')
    writeFileSync(servedFile, JSON.stringify({ v: 1, pages: ['ok.html', '../x.html', '.hidden.html', 'a.png', 7, 'sub//y.html'] }))
    const L = await startListener({ dirs, env: { CB_SERVED_FILE: servedFile } })
    try {
      for (const page of ['ok.html', 'x.html', 'hidden.html']) L.writePage(page, PAGE)
      assert.equal((await L.post({ v: 1, action: 'fix' }, { page: 'ok.html' })).status, 202)
      assert.equal((await L.post({ v: 1, action: 'fix' }, { page: 'x.html' })).status, 403)
      await L.serve('x.html')
      await L.req({ path: '/a/ok.html' })
      await L.serve('x.html')
      assert.deepEqual(JSON.parse(readFileSync(servedFile, 'utf8')), { v: 1, pages: ['ok.html', 'x.html'] })
      // An unparsable file at startup means an empty set, not a crash.
      writeFileSync(servedFile, '{not json')
      await L.stop()
      const M = await startListener({ dirs, env: { CB_PORT: String(L.port), CB_SECRET: L.secret, CB_SERVED_FILE: servedFile } })
      try {
        assert.equal((await M.post({ v: 1, action: 'fix' }, { page: 'ok.html' })).status, 403)
      } finally {
        await M.stop()
      }
    } finally {
      await L.cleanup()
    }
  })

  test('a relative CB_SERVED_FILE is error/bad-config', async () => {
    const L = await startListener({ env: { CB_SERVED_FILE: 'served-pages.json' }, wait: false })
    try {
      const exit = await L.exited
      assert.equal(exit.code, 1)
      assert.deepEqual(L.lines.map((l) => [l.type, l.reason]), [['error', 'bad-config']])
    } finally {
      await L.cleanup()
    }
  })
})
