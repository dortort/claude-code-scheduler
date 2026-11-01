// The CI workflow runs every suite the plugin has, on the Node versions the
// docs promise, and only through npm scripts that exist.
import { test, describe } from 'node:test'
import { readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { PLUGIN_DIR, REPO_DIR, read, readJson, join } from './helpers.ts'
import type { PackageJson } from './helpers.ts'

const wf = read(join(REPO_DIR, '.github', 'workflows', 'artifact-callbacks.yml'))
const pkg = readJson<PackageJson>(PLUGIN_DIR, 'package.json')
const scripts = pkg.scripts

/** The text of one job: from `  <name>:` under `jobs:` to the next job. */
function job (name: string): string {
  const jobs = wf.slice(wf.indexOf('\njobs:\n'))
  const m = new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][\\w-]*:\\n|$)`).exec(jobs)
  assert.ok(m, `workflow has a ${name} job`)
  return m[1]
}

describe('artifact-callbacks workflow', () => {
  test('is path-filtered to the artifact-callbacks plugins and itself on push and pull request', () => {
    for (const event of ['push', 'pull_request']) {
      const block = new RegExp(`^ {2}${event}:\\n([\\s\\S]*?)(?=^ {2}\\w)`, 'm').exec(wf)
      assert.ok(block, `${event} trigger`)
      assert.match(block[1], /- 'plugins\/artifact-callbacks\*\/\*\*'/, `${event} covers the plugin folders`)
      assert.match(block[1], /- '\.github\/workflows\/artifact-callbacks\.yml'/, `${event} covers the workflow`)
    }
  })

  test('every npm run in the workflow names a script that exists', () => {
    const used = [...wf.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1])
    assert.ok(used.length >= 5)
    for (const name of used) assert.ok(name in scripts, `package.json has script ${name}`)
  })

  test('runs every test:* npm script', () => {
    for (const name of Object.keys(scripts).filter((s) => s.startsWith('test:'))) {
      const claude = /^claude plugin (\w+) \.$/.exec(scripts[name])
      if (claude) {
        // Run from the repository root over every artifact-callbacks* plugin folder.
        assert.ok(wf.includes(`claude plugin ${claude[1]} "$dir"`), `workflow runs ${scripts[name]} (${name})`)
        continue
      }
      assert.ok(wf.includes(`npm run ${name}\n`), `workflow runs npm run ${name}`)
    }
  })

  test('the validate script is run too', () => {
    assert.equal(scripts.validate, 'claude plugin validate .')
    assert.ok(wf.includes('claude plugin validate "$dir"'))
  })

  test('typechecks the node sources and the hooks module after npm ci', () => {
    const j = job('typecheck')
    assert.match(j, /run: npm ci\n/)
    assert.match(j, /run: npm run typecheck\n/)
    assert.ok(j.indexOf('npm ci') < j.indexOf('npm run typecheck'))
    assert.match(scripts.typecheck, /-p tsconfig\.node\.json/, 'typecheck covers the node sources')
    assert.match(scripts.typecheck, /-p tsconfig\.json/, 'typecheck covers the hooks module')
  })

  test('runs the node suites on every OS and on the oldest and a current supported Node', () => {
    const j = job('node')
    assert.match(j, /runs-on: \$\{\{ matrix\.os \}\}/)
    assert.match(j, /os: \[ubuntu-latest, macos-latest, windows-latest\]/)
    assert.match(j, /node-version: \['22\.18\.0', '24'\]/)
    assert.match(j, /node-version: \$\{\{ matrix\.node-version \}\}/)
    assert.match(j, /npm run test:unit\n/)
    assert.match(j, /npm run test:conformance\n/)
  })

  test('the oldest Node in CI is the engines minimum', () => {
    const min = /^>=(\d+\.\d+\.\d+)$/.exec(pkg.engines?.node ?? '')
    assert.ok(min, 'engines.node is ">=x.y.z"')
    const versions = [...wf.matchAll(/node-version: (?:'([\d.]+)'|\[([^\]]*)\])/g)]
      .flatMap((m) => m[1] !== undefined ? [m[1]] : m[2].split(',').map((v) => v.trim().replace(/'/g, '')))
    assert.ok(versions.includes(min[1]), `CI runs Node ${min[1]}`)
    const lowest = versions.map((v) => v.split('.').map(Number)).sort((a, b) => (a[0] - b[0]) || ((a[1] ?? 0) - (b[1] ?? 0)))[0]
    assert.deepEqual(lowest.slice(0, 2), min[1].split('.').map(Number).slice(0, 2), 'nothing older than the minimum')
  })

  test('has no Python job, setup or listener', () => {
    assert.doesNotMatch(wf, /python/i)
    assert.doesNotMatch(wf, /listener\.py|\.mjs\b/)
  })

  test('installs Chromium only in CI and validates and tests the plugin with Claude Code', () => {
    const b = job('browser')
    assert.match(b, /runs-on: ubuntu-latest/)
    assert.match(b, /npx playwright install --with-deps chromium/)
    assert.match(b, /npm run test:browser\n/)
    const p = job('plugin')
    assert.match(p, /npm install -g @anthropic-ai\/claude-code/)
    assert.match(p, /claude plugin validate \.\n/)
    assert.match(p, /claude plugin validate "\$dir"/)
    assert.match(p, /claude plugin test "\$dir"/)
    assert.match(job('docs'), /npm run test:docs\n/)
  })

  test('the package test script runs every node suite', () => {
    for (const s of ['test:unit', 'test:conformance', 'test:browser', 'test:docs']) {
      assert.ok(scripts.test.includes(`npm run ${s}`), s)
    }
  })

  test('every test:* script that runs node --test matches at least one file', () => {
    for (const [name, cmd] of Object.entries(scripts)) {
      const m = /^node --test "([\w/-]+)\/\*(\.[\w.]+)"$/.exec(cmd)
      if (!m && cmd.startsWith('node --test')) assert.fail(`${name}: expected node --test "<dir>/*<ext>", got ${cmd}`)
      if (!m) continue
      const files = readdirSync(join(PLUGIN_DIR, m[1])).filter((f) => f.endsWith(m[2]))
      assert.ok(files.length > 0, `${name}: ${m[1]}/*${m[2]} matches files`)
    }
  })
})
