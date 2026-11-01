// The plugin README against the spec, plugin.json, package.json and the hooks module.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_DIR, REPO_DIR, read, readJson, section, tableRows, firstCode, allCode, existsSync, join } from './helpers.ts'
import type { PackageJson, PluginManifest } from './helpers.ts'

const readme = read(PLUGIN_DIR, 'README.md')
const spec = read(PLUGIN_DIR, 'docs', 'SPEC.md')
const manifest = readJson<PluginManifest>(PLUGIN_DIR, '.claude-plugin', 'plugin.json')
const pkg = readJson<PackageJson>(PLUGIN_DIR, 'package.json')

/** Subcommand words in a cell like "`pause` / `resume`", "`open <page>`" or "*(none)*". */
function subcommandWords (cell: string): string[] {
  if (/\(none\)/.test(cell)) return ['']
  return allCode(cell).map((c) => c.replace(/^\/callbacks\s*/, '').split(/\s+/)[0])
}

/** The minimum Node version from package.json engines, e.g. "22.18". */
function minNode (): string {
  const m = /^>=(\d+)\.(\d+)\.0$/.exec(pkg.engines?.node ?? '')
  assert.ok(m, `engines.node is ">=x.y.0", got ${pkg.engines?.node}`)
  return `${m[1]}.${m[2]}`
}

const specSubcommands = tableRows(section(spec, 'Configuration, packaging and commands').split('**Slash command** `/callbacks`')[1])
  .flatMap((r) => subcommandWords(r[0]))
const readmeSubcommands = tableRows(section(readme, '`/callbacks`')).flatMap((r) => subcommandWords(r[0]))

describe('README /callbacks', () => {
  test('the spec lists the subcommands this suite expects to parse', () => {
    assert.deepEqual([...specSubcommands].sort(),
      ['', 'open', 'pause', 'resume', 'rotate', 'start', 'stop', 'trust', 'untrust'].sort())
  })

  test('documents exactly the subcommands the spec lists', () => {
    assert.deepEqual([...new Set(readmeSubcommands)].sort(), [...new Set(specSubcommands)].sort())
  })

  test('subcommands that take a page say so', () => {
    for (const row of tableRows(section(readme, '`/callbacks`'))) {
      const cmd = firstCode(row[0]) ?? ''
      const word = subcommandWords(row[0])[0]
      if (['open', 'trust', 'untrust'].includes(word)) assert.match(cmd, /<page>$/, cmd)
    }
  })

  test('the hooks module handles every documented subcommand', () => {
    const src = read(PLUGIN_DIR, 'hooks', 'lib', 'controller.ts')
    for (const word of new Set(readmeSubcommands)) {
      assert.ok(src.includes(`case '${word}':`), `controller handles "${word || '(none)'}"`)
    }
  })
})

describe('README options', () => {
  const rows = tableRows(section(readme, 'Options'))
  const documented = new Map(rows.map((r) => [firstCode(r[0]) ?? '', r]))

  test('plugin.json has no runtime option: Node is the only listener runtime', () => {
    assert.ok(!('runtime' in manifest.userConfig), 'plugin.json userConfig.runtime is gone')
    assert.ok(!documented.has('runtime'), 'README documents no runtime option')
    assert.doesNotMatch(readme, /`runtime`/, 'README never names a runtime option')
  })

  test('every userConfig option is documented with its default', () => {
    for (const [key, o] of Object.entries(manifest.userConfig)) {
      const row = documented.get(key)
      assert.ok(row, `README documents option ${key}`)
      assert.equal(firstCode(row[2]), String(o.default), `${key} default`)
      if (o.options) {
        assert.deepEqual(allCode(row[1]).sort(), o.options.map(String).sort(), `${key} values`)
      } else {
        const types: Record<string, string | RegExp> = { number: 'number', boolean: 'boolean', string: /path|string/ }
        const type = types[o.type]
        assert.ok(type !== undefined, `${key} has a known type`)
        if (typeof type === 'string') assert.equal(row[1], type, `${key} type`)
        else assert.match(row[1], type, `${key} type`)
      }
    }
  })

  test('documents no option that plugin.json lacks', () => {
    assert.equal(documented.size, rows.length, 'no option documented twice')
    for (const key of documented.keys()) assert.ok(key in manifest.userConfig, `${key} is in plugin.json`)
  })

  test('every option in the spec is in plugin.json', () => {
    const specKeys = tableRows(section(spec, 'Configuration, packaging and commands').split('**Options**')[1])
      .map((r) => firstCode(r[0]) ?? '')
    assert.ok(specKeys.length >= 6)
    for (const key of specKeys) assert.ok(key in manifest.userConfig, `${key} is in plugin.json`)
  })
})

describe('README Node requirement', () => {
  test('the requirements name the engines minimum and nothing older', () => {
    const v = minNode()
    const install = section(readme, 'Install')
    assert.ok(install.includes(`Node.js >= ${v}`), `Install names Node.js >= ${v}`)
    assert.ok(section(readme, 'Development').includes(`Node.js >= ${v}`), `Development names Node.js >= ${v}`)
    for (const [, named] of readme.matchAll(/Node(?:\.js)? >= ?(\d+(?:\.\d+)?)/g)) assert.equal(named, v, `README says Node >= ${named}`)
  })

  test('the root README states the same minimum', () => {
    const root = read(REPO_DIR, 'README.md')
    const block = root.slice(root.indexOf('Artifact Callbacks is a mod'))
    assert.match(block, new RegExp(`^Artifact Callbacks is a mod that needs Node\\.js >= ${minNode().replace('.', '\\.')}\\b`))
  })

  test('the hooks module checks for the same minimum', () => {
    assert.ok(read(PLUGIN_DIR, 'hooks', 'lib', 'host.ts').includes(`'${minNode()}.0'`), 'host.ts MIN_NODE')
  })

  test('the listener is the TypeScript file, run by node, and says what happens without Node', () => {
    assert.ok(existsSync(join(PLUGIN_DIR, 'sidecar', 'listener.ts')))
    assert.ok(readme.includes('node sidecar/listener.ts'), 'README names node sidecar/listener.ts')
    assert.doesNotMatch(readme, /listener\.(mjs|py)\b/)
    for (const code of ['node-missing', 'node-too-old']) {
      assert.ok(readme.includes(`\`${code}\``), `README explains ${code}`)
      assert.ok(read(PLUGIN_DIR, 'hooks', 'lib', 'host.ts').includes(code), `host.ts reports ${code}`)
    }
  })

  test('the development section lists npm ci, typecheck and every test script', () => {
    const dev = section(readme, 'Development')
    assert.match(dev, /^npm ci\b/m)
    assert.match(dev, /^npm test\b/m)
    for (const name of Object.keys(pkg.scripts).filter((s) => s === 'typecheck' || s === 'validate' || s.startsWith('test:'))) {
      assert.match(dev, new RegExp(`^npm run ${name}\\b`, 'm'), `Development lists npm run ${name}`)
    }
  })
})

describe('README', () => {
  test('install lines name the plugin and the marketplace', () => {
    const m = readJson<{ name: string }>(PLUGIN_DIR, '..', '..', '.claude-plugin', 'marketplace.json')
    assert.ok(readme.includes(`claude plugin install ${manifest.name}@${m.name}`))
    assert.ok(readme.includes(`/plugin install ${manifest.name} --marketplace dortort/claude-plugins`))
  })

  test('relative links point at files that exist', () => {
    for (const [, target] of readme.matchAll(/\]\(((?!https?:|#)[^)#\s]+)(#[^)]*)?\)/g)) {
      assert.ok(existsSync(join(PLUGIN_DIR, target)), `link target ${target}`)
    }
  })

  test('every npm script it mentions exists', () => {
    for (const [, name] of readme.matchAll(/npm run ([a-z0-9:-]+)/g)) assert.ok(name in pkg.scripts, `npm run ${name}`)
  })

  test('the hand-written example uses only wired attributes and a valid action', () => {
    const block = section(readme, 'Writing pages by hand')
    assert.match(block, /<script src="\/_cb\/client\.js" defer><\/script>/)
    for (const [, action] of block.matchAll(/data-cb-action="([^"]*)"/g)) assert.match(action, /^[a-z0-9_-]{1,40}$/)
  })
})
