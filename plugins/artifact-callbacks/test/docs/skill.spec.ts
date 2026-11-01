// SKILL.md: its front matter, and that what it teaches matches client.js.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_DIR, read, section, codeBlocks, tableRows, firstCode, frontMatter,
  cbAttributes, cbMetaNames, clientSurface
} from './helpers.ts'

const skill = read(PLUGIN_DIR, 'skills', 'interactive-artifacts', 'SKILL.md')
const client = clientSurface(read(PLUGIN_DIR, 'sidecar', 'client.js'))
const ACTION = /^[a-z0-9_-]{1,40}$/
const PLACEHOLDER = /\{\{\s*([^}|]*?)\s*(\|\s*json\s*)?\}\}/g

/** The HTML of the "Complete example" section. */
function examplePage () {
  const blocks = codeBlocks(section(skill, 'Complete example')).filter((b) => b.lang === 'html')
  assert.equal(blocks.length, 1, 'one html block in Complete example')
  return blocks[0].code
}

/** Every html code block in the skill, the example included. */
const htmlBlocks = codeBlocks(skill).filter((b) => b.lang === 'html').map((b) => b.code)

describe('SKILL.md front matter', () => {
  const fm = frontMatter(skill)

  test('parses and has exactly name and description', () => {
    assert.deepEqual(Object.keys(fm).sort(), ['description', 'name'])
  })

  test('name is the folder name', () => {
    assert.equal(fm.name, 'interactive-artifacts')
  })

  test('description says when to use it and fits the length limit', () => {
    assert.ok(fm.description.length >= 100 && fm.description.length <= 1024, `length ${fm.description.length}`)
    assert.match(fm.description, /^Use when/)
    for (const word of ['HTML', 'Artifact Callbacks', 'data-cb-', 'Interactive artifacts are live in this session']) {
      assert.ok(fm.description.includes(word), `description mentions ${word}`)
    }
  })

  test('the trigger phrase is what the compose section actually says', () => {
    const status = read(PLUGIN_DIR, 'hooks', 'lib', 'status.ts')
    assert.ok(status.includes("'Interactive artifacts are live in this session."), 'compose text opens with the trigger phrase')
    assert.ok(status.includes('interactive-artifacts skill'), 'compose text names the skill')
  })
})

describe('SKILL.md against client.js', () => {
  test('client.js exposes the surface this suite reads', () => {
    for (const a of ['data-cb-action', 'data-cb-data', 'data-cb-prompt', 'data-cb-confirm']) assert.ok(client.reads.has(a), a)
    assert.ok(client.writes.has('data-cb-state'))
    assert.ok(client.api.has('send') && client.api.has('onDone'))
  })

  test('the complete example page only uses attributes client.js reads', () => {
    const attrs = cbAttributes(examplePage())
    assert.ok(attrs.length > 10)
    for (const a of attrs) assert.ok(client.reads.has(a.name), `${a.name} on <${a.tag}> is read by client.js`)
  })

  test('every html snippet only writes attributes client.js reads', () => {
    for (const html of htmlBlocks) {
      for (const a of cbAttributes(html)) assert.ok(client.reads.has(a.name), `${a.name} in ${html.slice(0, 60)}`)
    }
  })

  test('every html snippet uses valid actions, JSON-object data and known placeholders', () => {
    for (const html of htmlBlocks) {
      for (const a of cbAttributes(html)) {
        if (a.name === 'data-cb-action') assert.match(a.value, ACTION, a.value)
        if (a.name === 'data-cb-data') {
          const v = JSON.parse(a.value)
          assert.ok(v && typeof v === 'object' && !Array.isArray(v), a.value)
        }
        if (a.name === 'data-cb-prompt') {
          assert.ok([...a.value].length <= 2000, 'prompt within 2000 code points')
          for (const [, name] of a.value.matchAll(PLACEHOLDER)) {
            assert.match(name, /^(label|action|page|data(\.[A-Za-z0-9_-]+)*)$/, `placeholder {{${name}}}`)
          }
        }
        if (a.name === 'data-cb-label') assert.ok([...a.value].length <= 200)
      }
    }
  })

  test('placeholders in the example name keys its controls send', () => {
    const html = examplePage()
    // Per start tag: keys from data-cb-data plus named fields when it is a form.
    for (const m of html.matchAll(/<(button|form|a)\b[^>]*data-cb-prompt="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)) {
      const tag = m[0].slice(0, m[0].indexOf('>') + 1)
      const keys = new Set()
      const data = /data-cb-data='([^']*)'/.exec(tag)
      if (data) for (const k of Object.keys(JSON.parse(data[1]))) keys.add(k)
      if (m[1] === 'form') for (const [, n] of m[3].matchAll(/\bname="([^"]+)"/g)) keys.add(n)
      for (const [, name] of m[2].matchAll(PLACEHOLDER)) {
        if (name.startsWith('data.')) assert.ok(keys.has(name.split('.')[1]), `{{${name}}} is sent by ${tag}`)
      }
    }
  })

  test('meta tags in snippets are ones client.js reads', () => {
    for (const html of htmlBlocks) {
      for (const name of cbMetaNames(html)) assert.ok(client.metas.has(name), name)
    }
  })

  test('the attribute reference documents every attribute client.js reads', () => {
    const rows = tableRows(section(skill, 'Attribute reference')).map((r) => firstCode(r[0]))
    const readable = [...client.reads].filter((a) => !client.writes.has(a))
    assert.deepEqual(rows.sort(), readable.sort())
  })

  test('the state table documents every data-cb-* attribute client.js sets on controls', () => {
    const rows = tableRows(section(skill, 'While an event is in flight: `data-cb-state`')).map((r) => firstCode(r[0]))
    for (const a of client.writes) {
      if (a.startsWith('data-cb-toast')) continue // the toast's own markup
      assert.ok(rows.includes(a), `${a} documented`)
    }
  })

  test('the state values listed match what client.js maps to', () => {
    const src = read(PLUGIN_DIR, 'sidecar', 'client.js')
    const found = /var ELEMENT_STATE = \{([\s\S]*?)\}/.exec(src)
    assert.ok(found, 'client.js has ELEMENT_STATE')
    const map = found[1]
    const shown = new Set([...map.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]))
    const row = tableRows(section(skill, 'While an event is in flight: `data-cb-state`'))
      .find((r) => firstCode(r[0]) === 'data-cb-state')
    assert.ok(row, 'the state table has a data-cb-state row')
    assert.deepEqual([...row[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort(), [...shown].sort())
  })

  test('the imperative API section names only functions client.js has', () => {
    const js = codeBlocks(section(skill, 'Imperative API')).filter((b) => b.lang === 'js').map((b) => b.code).join('\n')
    for (const [, fn] of js.matchAll(/ArtifactCallbacks\.([A-Za-z]\w*)/g)) assert.ok(client.api.has(fn), `ArtifactCallbacks.${fn}`)
    for (const [, fn] of js.matchAll(/\bev\.([A-Za-z]\w*)/g)) {
      assert.ok(client.handle.has(fn) || ['id', 'state', 'reason', 'done'].includes(fn), `ev.${fn}`)
    }
    for (const [, type] of js.matchAll(/\.on\('([a-z]+)'/g)) assert.ok(client.events.has(type), `event ${type}`)
  })

  test('the file:// section names every meta tag the client reads', () => {
    const text = section(skill, 'file:// pages (token mode)') + section(skill, 'While an event is in flight: `data-cb-state`')
    for (const name of client.metas) assert.ok(text.includes(`name="${name}"`), `${name} documented`)
  })

  test('the file:// section names the tool the mod registers for page tokens', () => {
    const named = /PAGE_TOKEN_TOOL = '([a-z_]+)'/.exec(read(PLUGIN_DIR, 'hooks', 'lib', 'token.ts'))
    assert.ok(named, 'token.ts names PAGE_TOKEN_TOOL')
    const tool = named[1]
    assert.ok(section(skill, 'file:// pages (token mode)').includes(`\`${tool}\` tool`), `SKILL.md names ${tool}`)
    assert.ok(read(PLUGIN_DIR, 'README.md').includes(`\`${tool}\` tool`), `README names ${tool}`)
    const tags = read(PLUGIN_DIR, 'hooks', 'lib', 'token.ts')
    for (const name of cbMetaNames(section(skill, 'file:// pages (token mode)'))) {
      assert.ok(tags.includes(`<meta name="${name}"`), `the tool returns ${name}`)
    }
  })

  test('the security section covers untrusted prompts and destructive actions', () => {
    const sec = section(skill, 'Security rules')
    assert.match(sec, /untrusted content in `data-cb-prompt`/)
    assert.match(sec, /Confirm destructive actions/)
    assert.match(sec, /data-cb-confirm/)
  })

  test('the patterns section covers checklists, choose-one, forms, regenerate and reload on done', () => {
    const p = section(skill, 'Patterns')
    for (const name of ['Checklist', 'Choose one', 'Forms', 'Regenerate this page', 'Reload on done']) {
      assert.ok(p.includes(name), name)
    }
  })
})

describe('SKILL.md listener requirements', () => {
  test('names the TypeScript listener, the Node minimum and the down reasons', () => {
    assert.ok(skill.includes('node sidecar/listener.ts'))
    assert.match(skill, /Node\.js \d+\.\d+ or later/)
    for (const code of ['node-missing', 'node-too-old']) assert.ok(skill.includes(`\`${code}\``), code)
    assert.doesNotMatch(skill, /python|listener\.mjs|`runtime`/i)
  })
})
