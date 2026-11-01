// The plugin README against the spec, plugin.json and the hooks module.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_DIR, read, readJson, section, tableRows, firstCode, allCode, existsSync, join } from './helpers.mjs'

const readme = read(PLUGIN_DIR, 'README.md')
const spec = read(PLUGIN_DIR, 'docs', 'SPEC.md')
const manifest = readJson(PLUGIN_DIR, '.claude-plugin', 'plugin.json')

/** Subcommand words in a cell like "`pause` / `resume`", "`open <page>`" or "*(none)*". */
function subcommandWords (cell) {
  if (/\(none\)/.test(cell)) return ['']
  return allCode(cell).map((c) => c.replace(/^\/callbacks\s*/, '').split(/\s+/)[0])
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
      const cmd = firstCode(row[0])
      const word = subcommandWords(row[0])[0]
      if (['open', 'trust', 'untrust'].includes(word)) assert.match(cmd, /<page>$/, cmd)
    }
  })

  test('the hooks module handles every documented subcommand', () => {
    const file = join(PLUGIN_DIR, 'hooks', 'lib', 'controller.ts')
    const src = existsSync(file) ? read(file) : read(PLUGIN_DIR, 'hooks', 'register.tsx')
    for (const word of new Set(readmeSubcommands)) {
      assert.ok(src.includes(`case '${word}':`), `controller handles "${word || '(none)'}"`)
    }
  })
})

describe('README options', () => {
  const rows = tableRows(section(readme, 'Options'))
  const documented = new Map(rows.map((r) => [firstCode(r[0]), r]))

  test('every userConfig option is documented with its default', () => {
    for (const [key, o] of Object.entries(manifest.userConfig)) {
      const row = documented.get(key)
      assert.ok(row, `README documents option ${key}`)
      assert.equal(firstCode(row[2]), String(o.default), `${key} default`)
      if (o.options) {
        assert.deepEqual(allCode(row[1]).sort(), [...o.options].sort(), `${key} values`)
      } else {
        const type = { number: 'number', boolean: 'boolean', string: /path|string/ }[o.type]
        if (typeof type === 'string') assert.equal(row[1], type, `${key} type`)
        else assert.match(row[1], type, `${key} type`)
      }
    }
  })

  test('documents no option that plugin.json lacks', () => {
    for (const key of documented.keys()) assert.ok(key in manifest.userConfig, `${key} is in plugin.json`)
  })

  test('every option in the spec is in plugin.json', () => {
    const specKeys = tableRows(section(spec, 'Configuration, packaging and commands').split('**Options**')[1])
      .map((r) => firstCode(r[0]))
    assert.ok(specKeys.length >= 7)
    for (const key of specKeys) assert.ok(key in manifest.userConfig, `${key} is in plugin.json`)
  })
})

describe('README', () => {
  test('install lines name the plugin and the marketplace', () => {
    const m = readJson(PLUGIN_DIR, '..', '..', '.claude-plugin', 'marketplace.json')
    assert.ok(readme.includes(`claude plugin install ${manifest.name}@${m.name}`))
    assert.ok(readme.includes(`/plugin install ${manifest.name} --marketplace dortort/claude-plugins`))
  })

  test('relative links point at files that exist', () => {
    for (const [, target] of readme.matchAll(/\]\(((?!https?:|#)[^)#\s]+)(#[^)]*)?\)/g)) {
      assert.ok(existsSync(join(PLUGIN_DIR, target)), `link target ${target}`)
    }
  })

  test('every npm script it mentions exists', () => {
    const scripts = readJson(PLUGIN_DIR, 'package.json').scripts
    for (const [, name] of readme.matchAll(/npm run ([a-z:-]+)/g)) assert.ok(name in scripts, `npm run ${name}`)
  })

  test('the hand-written example uses only wired attributes and a valid action', () => {
    const block = section(readme, 'Writing pages by hand')
    assert.match(block, /<script src="\/_cb\/client\.js" defer><\/script>/)
    for (const [, action] of block.matchAll(/data-cb-action="([^"]*)"/g)) assert.match(action, /^[a-z0-9_-]{1,40}$/)
  })
})
