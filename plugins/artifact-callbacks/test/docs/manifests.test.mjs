// marketplace.json and plugin.json: shapes, and that they point at real files.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { PLUGIN_DIR, REPO_DIR, readJson, read, existsSync, join } from './helpers.mjs'

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

describe('marketplace.json', () => {
  const m = readJson(REPO_DIR, '.claude-plugin', 'marketplace.json')

  test('has a name, an owner and a list of plugins', () => {
    assert.match(m.name, NAME)
    assert.equal(typeof m.owner?.name, 'string')
    assert.ok(Array.isArray(m.plugins) && m.plugins.length > 0)
  })

  test('every entry has a unique kebab-case name, a description and a known source shape', () => {
    const names = new Set()
    for (const p of m.plugins) {
      assert.match(p.name, NAME, `name of ${JSON.stringify(p)}`)
      assert.ok(!names.has(p.name), `duplicate entry ${p.name}`)
      names.add(p.name)
      assert.ok(typeof p.description === 'string' && p.description.length > 10, `${p.name} description`)
      if (typeof p.source === 'string') {
        assert.match(p.source, /^\.\/[^\s]+$/, `${p.name}: a string source is a ./relative path`)
        assert.ok(!p.source.split('/').includes('..'), `${p.name}: source stays inside the repository`)
      } else {
        assert.equal(typeof p.source, 'object', `${p.name} source`)
        const kinds = { npm: ['package'], github: ['repo'], url: ['url'], 'git-subdir': ['url', 'path'] }
        assert.ok(p.source.source in kinds, `${p.name}: unknown source kind ${p.source.source}`)
        for (const k of kinds[p.source.source]) assert.equal(typeof p.source[k], 'string', `${p.name}: source.${k}`)
      }
    }
  })

  test('every relative source is a plugin folder whose manifest has the same name', () => {
    for (const p of m.plugins.filter((x) => typeof x.source === 'string')) {
      const dir = join(REPO_DIR, p.source)
      assert.ok(statSync(dir).isDirectory(), `${p.source} is a folder`)
      const manifest = readJson(dir, '.claude-plugin', 'plugin.json')
      assert.equal(manifest.name, p.name, `${p.source} manifest name`)
    }
  })

  test('lists artifact-callbacks from its folder', () => {
    const e = m.plugins.find((p) => p.name === 'artifact-callbacks')
    assert.ok(e, 'artifact-callbacks entry')
    assert.equal(e.source, './plugins/artifact-callbacks')
  })

  test('lists every plugins/artifact-callbacks* folder that has a manifest', () => {
    for (const dir of ['artifact-callbacks', 'artifact-callbacks-channel']) {
      if (!existsSync(join(REPO_DIR, 'plugins', dir, '.claude-plugin', 'plugin.json'))) continue
      const name = readJson(REPO_DIR, 'plugins', dir, '.claude-plugin', 'plugin.json').name
      assert.ok(m.plugins.some((p) => p.name === name && p.source === `./plugins/${dir}`), `${dir} is listed`)
    }
  })

  test('the root README lists every marketplace plugin', () => {
    const readme = read(REPO_DIR, 'README.md')
    for (const p of m.plugins) {
      assert.ok(readme.includes(`| \`${p.name}\` |`), `${p.name} in the README table`)
      assert.ok(readme.includes(`claude plugin install ${p.name}@${m.name}`), `${p.name} install line`)
    }
  })
})

describe('plugin.json', () => {
  const p = readJson(PLUGIN_DIR, '.claude-plugin', 'plugin.json')

  test('names the plugin, a semver version, a description and the MIT license', () => {
    assert.equal(p.name, 'artifact-callbacks')
    assert.match(p.version, SEMVER)
    assert.ok(typeof p.description === 'string' && p.description.length > 10)
    assert.equal(p.license, 'MIT')
  })

  test('its version matches the dev package.json', () => {
    assert.equal(p.version, readJson(PLUGIN_DIR, 'package.json').version)
  })

  test('types points at the PluginState declaration', () => {
    assert.equal(typeof p.types, 'string')
    const file = join(PLUGIN_DIR, p.types)
    assert.ok(existsSync(file), p.types)
    assert.match(read(file), /interface PluginState\b[\s\S]*'artifact-callbacks'/)
  })

  test('hooks.json names hooks modules that exist', () => {
    const h = readJson(PLUGIN_DIR, 'hooks', 'hooks.json')
    assert.ok(Array.isArray(h.modules) && h.modules.length > 0)
    for (const mod of h.modules) assert.ok(existsSync(join(PLUGIN_DIR, 'hooks', mod)), mod)
  })

  test('every userConfig option has a known type, a title, a description and a default of that type', () => {
    const entries = Object.entries(p.userConfig || {})
    assert.ok(entries.length > 0)
    for (const [key, o] of entries) {
      assert.match(key, /^[a-z][A-Za-z0-9]*$/, key)
      assert.ok(['string', 'number', 'boolean'].includes(o.type), `${key} type`)
      assert.ok(typeof o.title === 'string' && o.title, `${key} title`)
      assert.ok(typeof o.description === 'string' && o.description, `${key} description`)
      assert.equal(typeof o.default, o.type, `${key} default`)
      if (o.options !== undefined) {
        assert.ok(Array.isArray(o.options) && o.options.length > 1, `${key} options`)
        assert.ok(o.options.includes(o.default), `${key} default is one of its options`)
      }
    }
  })

  test('the plugin ships the interactive-artifacts skill', () => {
    assert.ok(existsSync(join(PLUGIN_DIR, 'skills', 'interactive-artifacts', 'SKILL.md')))
  })
})
