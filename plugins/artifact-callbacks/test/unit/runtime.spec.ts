// The shipped sources run as-is on the Node that runs this suite: the listener
// starts from its .ts file with no warning on stderr, and client.js stays a
// type-checked plain script.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StdoutLine } from '../../sidecar/lib.ts'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('package.json requires the Node that runs .ts files without flags', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')) as { engines?: { node?: string } }
  assert.equal(pkg.engines?.node, '>=22.18.0')
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  assert.ok(major > 22 || (major === 22 && minor >= 18), `this suite runs on Node ${process.versions.node}`)
})

test('`node sidecar/listener.ts` prints a ready line and nothing on stderr', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cb-runtime-'))
  const root = join(base, 'artifacts')
  mkdirSync(root)
  // Only what a session passes: no NODE_OPTIONS or other flags from this test runner.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CB_PORT: '0',
    CB_ROOT: root,
    CB_STATUS_FILE: join(base, 'status.json'),
    CB_SECRET: randomBytes(32).toString('hex')
  }
  const child = spawn(process.execPath, ['sidecar/listener.ts'], { cwd: PLUGIN_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => { stderr += d })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready line; stderr: ${stderr}`)), 10_000)
      child.stdout.on('data', (d: string) => {
        stdout += d
        const nl = stdout.indexOf('\n')
        if (nl >= 0) { clearTimeout(timer); resolve(stdout.slice(0, nl)) }
      })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${stdout} ${stderr}`)) })
    })
    const ready = JSON.parse(first) as StdoutLine
    assert.equal(ready.type, 'ready')
    assert.ok(ready.type === 'ready' && ready.port > 0 && ready.pid === child.pid)
    // Give a late warning (they are printed asynchronously) a moment to show up.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.doesNotMatch(stderr, /ExperimentalWarning/)
    assert.equal(stderr, '')
  } finally {
    child.kill('SIGTERM')
    await exited
    rmSync(base, { recursive: true, force: true })
  }
})

test('only hooks/ holds *.test.ts(x): `claude plugin test` runs every one in the folder', () => {
  const stray = readdirSync(PLUGIN_DIR, { recursive: true, encoding: 'utf8' })
    .filter((p) => !p.split(sep).some((s) => s === 'node_modules' || s.startsWith('.')))
    .filter((p) => /\.test\.tsx?$/.test(p) && !p.startsWith('hooks' + sep))
  assert.deepEqual(stray, [], 'name node:test suites *.spec.ts')
})

test('client.js is a type-checked plain script', () => {
  const src = readFileSync(join(PLUGIN_DIR, 'sidecar', 'client.js'), 'utf8')
  assert.ok(src.startsWith('// @ts-check\n'), 'first line is // @ts-check (npm run typecheck covers it)')
  assert.doesNotMatch(src, /^\s*(import|export)\s/m, 'a classic script: no module syntax')
})
