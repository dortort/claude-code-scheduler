// The CI workflow runs every suite the plugin has.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_DIR, REPO_DIR, read, readJson, join } from './helpers.mjs'

const wf = read(join(REPO_DIR, '.github', 'workflows', 'artifact-callbacks.yml'))
const scripts = readJson(PLUGIN_DIR, 'package.json').scripts

describe('artifact-callbacks workflow', () => {
  test('is path-filtered to the artifact-callbacks plugins on push and pull request', () => {
    assert.match(wf, /^ {2}push:\n[\s\S]*?paths:\n\s+- 'plugins\/artifact-callbacks\*\/\*\*'/m)
    assert.match(wf, /^ {2}pull_request:\n[\s\S]*?paths:\n\s+- 'plugins\/artifact-callbacks\*\/\*\*'/m)
  })

  test('runs every test:* npm script except the local python shortcut', () => {
    for (const name of Object.keys(scripts).filter((s) => s.startsWith('test:'))) {
      if (name === 'test:conformance:python') continue // CI sets CB_LISTENER_CMD per OS instead
      const claude = /^claude plugin (\w+) \.$/.exec(scripts[name])
      if (claude) {
        // Run from the repository root over every artifact-callbacks* plugin folder.
        assert.ok(wf.includes(`claude plugin ${claude[1]} "$dir"`), `workflow runs ${scripts[name]} (${name})`)
        continue
      }
      assert.ok(wf.includes(`npm run ${name}\n`), `workflow runs npm run ${name}`)
    }
  })

  test('runs the conformance suite against the Python listener on all three OSes', () => {
    assert.match(wf, /CB_LISTENER_CMD: python sidecar\/listener\.py/)
    assert.match(wf, /node --test test\/conformance\/\*\.test\.mjs/)
    assert.match(wf, /os: \[ubuntu-latest, macos-latest, windows-latest\]/)
    assert.match(wf, /python-version: \['3\.8', '3\.12'\]/)
  })

  test('runs the node suites on Node 18 and 22', () => {
    assert.match(wf, /node-version: \[18, 22\]/)
  })

  test('installs Chromium only in CI and validates and tests the plugin with Claude Code', () => {
    assert.match(wf, /npx playwright install --with-deps chromium/)
    assert.match(wf, /npm install -g @anthropic-ai\/claude-code/)
    assert.match(wf, /claude plugin validate \.\n/)
    assert.match(wf, /claude plugin validate "\$dir"/)
    assert.match(wf, /claude plugin test "\$dir"/)
  })

  test('the package test script runs every suite', () => {
    for (const s of ['test:unit', 'test:conformance', 'test:browser', 'test:docs']) {
      assert.ok(scripts.test.includes(`npm run ${s}`), s)
    }
  })
})
