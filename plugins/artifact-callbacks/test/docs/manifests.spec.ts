// marketplace.json and plugin.json: shapes, and that they point at real files.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { PLUGIN_DIR, REPO_DIR, readJson, read, existsSync, join, shippedFiles } from './helpers.ts'
import type { PackageJson, PluginManifest } from './helpers.ts'

interface MarketplaceEntry {
  name: string
  description?: string
  source: string | { source: string, [key: string]: unknown }
}

interface Marketplace {
  name: string
  owner?: { name?: unknown }
  plugins: MarketplaceEntry[]
}

const SOURCE_KEYS: Record<string, string[]> = { npm: ['package'], github: ['repo'], url: ['url'], 'git-subdir': ['url', 'path'] }

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

describe('release metadata', () => {
  for (const name of ['artifact-callbacks', 'artifact-callbacks-channel']) {
    test(`${name} keeps its manifest, dev package, lockfile and release notes aligned`, () => {
      const root = join(REPO_DIR, 'plugins', name)
      const manifest = readJson<PluginManifest>(root, '.claude-plugin', 'plugin.json')
      const pkg = readJson<PackageJson>(root, 'package.json')
      const lock = readJson<{ version: string; packages: Record<string, { version: string }> }>(root, 'package-lock.json')
      assert.match(manifest.version, SEMVER)
      for (const version of [pkg.version, lock.version, lock.packages['']?.version]) {
        assert.equal(version, manifest.version, `${name} version metadata`)
      }
      const notes = read(root, 'releases', `${manifest.version}.md`)
      assert.ok(notes.trim().length > 0, `${name} has release notes`)
    })
  }
})

describe('marketplace.json', () => {
  const m = readJson<Marketplace>(REPO_DIR, '.claude-plugin', 'marketplace.json')

  test('has a name, an owner and a list of plugins', () => {
    assert.match(m.name, NAME)
    assert.equal(typeof m.owner?.name, 'string')
    assert.ok(Array.isArray(m.plugins) && m.plugins.length > 0)
  })

  test('every entry has a unique kebab-case name, a description and a known source shape', () => {
    const names = new Set<string>()
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
        const src = p.source
        assert.ok(src.source in SOURCE_KEYS, `${p.name}: unknown source kind ${src.source}`)
        for (const k of SOURCE_KEYS[src.source]) assert.equal(typeof src[k], 'string', `${p.name}: source.${k}`)
      }
    }
  })

  test('every relative source is a plugin folder whose manifest has the same name', () => {
    for (const p of m.plugins) {
      if (typeof p.source !== 'string') continue
      const dir = join(REPO_DIR, p.source)
      assert.ok(statSync(dir).isDirectory(), `${p.source} is a folder`)
      const manifest = readJson<PluginManifest>(dir, '.claude-plugin', 'plugin.json')
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
      const name = readJson<PluginManifest>(REPO_DIR, 'plugins', dir, '.claude-plugin', 'plugin.json').name
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
  const p = readJson<PluginManifest>(PLUGIN_DIR, '.claude-plugin', 'plugin.json')

  test('names the plugin, a semver version, a description and the MIT license', () => {
    assert.equal(p.name, 'artifact-callbacks')
    assert.match(p.version, SEMVER)
    assert.ok(typeof p.description === 'string' && p.description.length > 10)
    assert.equal(p.license, 'MIT')
  })

  test('its version matches the dev package.json', () => {
    assert.equal(p.version, readJson<PackageJson>(PLUGIN_DIR, 'package.json').version)
  })

  test('types points at the PluginState declaration', () => {
    assert.equal(typeof p.types, 'string')
    const file = join(PLUGIN_DIR, p.types as string)
    assert.ok(existsSync(file), p.types)
    assert.match(read(file), /interface PluginState\b[\s\S]*'artifact-callbacks'/)
  })

  test('hooks.json names hooks modules that exist', () => {
    const h = readJson<{ modules: string[] }>(PLUGIN_DIR, 'hooks', 'hooks.json')
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

  test('has no runtime option', () => {
    assert.ok(!('runtime' in p.userConfig), 'userConfig.runtime')
  })
})

describe('shipped files', () => {
  const files = shippedFiles()

  test('are the plugin sources, not dev tooling', () => {
    for (const f of ['.claude-plugin/plugin.json', 'README.md', 'hooks/register.tsx', 'sidecar/listener.ts',
      'sidecar/lib.ts', 'sidecar/client.js', 'skills/interactive-artifacts/SKILL.md']) {
      assert.ok(files.includes(f), `ships ${f}`)
    }
    assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('node_modules/') || f === 'package.json'))
  })

  test('mention Python nowhere and contain no Python or .mjs sources', () => {
    for (const f of files) {
      assert.doesNotMatch(f, /\.(py|pyc|mjs|cjs)$/, `${f} is not a Python or .mjs source`)
      assert.doesNotMatch(read(PLUGIN_DIR, f), /python|py -3|listener\.py\b|listener\.mjs\b/i, `${f} mentions Python or an old listener`)
    }
  })

  test('the only JavaScript file is the browser client, and it is type-checked', () => {
    assert.deepEqual(files.filter((f) => /\.(js|mjs|cjs)$/.test(f)), ['sidecar/client.js'])
    assert.match(read(PLUGIN_DIR, 'sidecar', 'client.js'), /^(\/\/[^\n]*\n)*\/\/ @ts-check\n/)
  })
})

describe('package.json engines', () => {
  const pkg = readJson<PackageJson>(PLUGIN_DIR, 'package.json')

  test('requires the Node that runs .ts files without flags', () => {
    assert.equal(pkg.engines?.node, '>=22.18.0')
  })

  test('matches what the docs and the hooks module say', () => {
    const min = (pkg.engines?.node ?? '').replace(/^>=/, '')
    const short = min.replace(/\.0$/, '')
    assert.ok(read(PLUGIN_DIR, 'hooks', 'lib', 'host.ts').includes(`MIN_NODE = '${min}'`), 'host.ts MIN_NODE')
    assert.ok(read(PLUGIN_DIR, 'docs', 'SPEC.md').includes(`Node ${short} or later`), 'SPEC.md')
    assert.ok(read(PLUGIN_DIR, 'docs', 'CONTRACT.md').includes(`"node": ">=${min}"`), 'CONTRACT.md')
    assert.ok(read(PLUGIN_DIR, 'README.md').includes(`Node.js >= ${short}`), 'README.md')
    assert.ok(read(PLUGIN_DIR, 'skills', 'interactive-artifacts', 'SKILL.md').includes(`Node.js ${short} or later`), 'SKILL.md')
  })
})
