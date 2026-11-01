// Shared parsing helpers for the docs suites: they read the repository's
// Markdown, JSON and client.js as text and pull out the facts the docs claim.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const REPO_DIR = join(PLUGIN_DIR, '..', '..')

export function read (...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8')
}

/** Parsed JSON; callers narrow it with a cast to the shape they check. */
export function readJson<T = any> (...parts: string[]): T {
  return JSON.parse(read(...parts)) as T
}

export { existsSync, join }

/** One `userConfig` entry of plugin.json. */
export interface UserConfigOption {
  type: string
  title?: string
  description?: string
  default?: unknown
  options?: unknown[]
}

/** The parts of plugin.json the docs suites read. */
export interface PluginManifest {
  name: string
  version: string
  description?: string
  license?: string
  types?: string
  userConfig: Record<string, UserConfigOption>
}

/** The parts of package.json the docs suites read. */
export interface PackageJson {
  version: string
  engines?: { node?: string }
  scripts: Record<string, string>
}

/**
 * Files the plugin ships, relative to the plugin folder with `/` separators:
 * everything under it except dev-only folders (node_modules, test) and files
 * (package.json, the lockfile, tsconfig*.json).
 */
export function shippedFiles (): string[] {
  const skipDirs = new Set(['node_modules', 'test', '.git'])
  const skipFiles = /^(package\.json|package-lock\.json|tsconfig(\.[\w-]+)?\.json)$/
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (!skipDirs.has(name)) walk(full)
      } else if (!(dir === PLUGIN_DIR && skipFiles.test(name))) {
        out.push(relative(PLUGIN_DIR, full).split(sep).join('/'))
      }
    }
  }
  walk(PLUGIN_DIR)
  return out.sort()
}

/**
 * The text of the Markdown section that starts with the heading `title`
 * (any level), up to the next heading of the same or a higher level.
 * Headings inside fenced code blocks are ignored.
 */
export function section (md: string, title: string): string {
  const lines = md.split('\n')
  let fence = false
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    if (start >= 0 && m[1].length <= level) return lines.slice(start + 1, i).join('\n')
    if (start < 0 && m[2] === title) {
      start = i
      level = m[1].length
    }
  }
  if (start < 0) throw new Error(`no section titled "${title}"`)
  return lines.slice(start + 1).join('\n')
}

export interface CodeBlock { lang: string, code: string }

/** Fenced code blocks: [{ lang, code }]. */
export function codeBlocks (md: string): CodeBlock[] {
  const out: CodeBlock[] = []
  const re = /^(```|~~~)([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) out.push({ lang: m[2].trim(), code: m[3] })
  return out
}

/**
 * Rows of the first Markdown table in `md`, as arrays of trimmed cell
 * strings (header row excluded). Escaped pipes (`\|`) stay inside a cell.
 */
export function tableRows (md: string): string[][] {
  const lines = md.split('\n')
  const start = lines.findIndex((l, i) => /^\s*\|/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || ''))
  if (start < 0) throw new Error('no table found')
  const rows: string[][] = []
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '')
      .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
    rows.push(cells)
  }
  return rows
}

/** Text between the first pair of backticks in `cell`, or null. */
export function firstCode (cell: string): string | null {
  const m = /`([^`]*)`/.exec(cell)
  return m ? m[1] : null
}

/** All backticked spans in `cell`. */
export function allCode (cell: string): string[] {
  return [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1])
}

/**
 * A minimal YAML front-matter reader for SKILL.md: `key: value` lines,
 * plain or quoted scalars. Throws on anything it does not understand, so a
 * malformed header fails the suite instead of passing silently.
 */
export function frontMatter (md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md)
  if (!m) throw new Error('no front matter')
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (!kv) throw new Error(`unparsable front matter line: ${line}`)
    let v = kv[2].trim()
    if (v.startsWith('"')) {
      v = JSON.parse(v) as string
    } else if (v.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(v)) throw new Error(`bad single-quoted value: ${line}`)
      v = v.slice(1, -1).replace(/''/g, "'")
    } else if (/^[>|[{&*!%@`]/.test(v) || /:\s/.test(v) || /\s#/.test(v)) {
      throw new Error(`value needs quoting or is not a plain scalar: ${line}`)
    }
    if (Object.prototype.hasOwnProperty.call(out, kv[1])) throw new Error(`duplicate key ${kv[1]}`)
    out[kv[1]] = v
  }
  return out
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }

export interface CbAttribute { tag: string, name: string, value: string }

/** `data-cb-*` attributes in HTML start tags: [{ tag, name, value }]. */
export function cbAttributes (html: string): CbAttribute[] {
  const out: CbAttribute[] = []
  const tags = html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+))?)*)\s*\/?>/g)
  for (const t of tags) {
    for (const a of t[2].matchAll(/\s+([^\s=>/]+)(?:\s*=\s*('[^']*'|"[^"]*"|[^\s>]+))?/g)) {
      const name = a[1].toLowerCase()
      if (!name.startsWith('data-cb-')) continue
      let value = a[2] === undefined ? '' : a[2]
      if (/^['"]/.test(value)) value = value.slice(1, -1)
      value = value.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ENTITY[e])
      out.push({ tag: t[1].toLowerCase(), name, value })
    }
  }
  return out
}

/** `<meta name="cb-…">` names used in HTML. */
export function cbMetaNames (html: string): string[] {
  return [...html.matchAll(/<meta\s+name="(cb-[a-z-]+)"/g)].map((m) => m[1])
}

export interface ClientSurface {
  reads: Set<string>
  writes: Set<string>
  metas: Set<string>
  api: Set<string>
  handle: Set<string>
  events: Set<string>
}

/** What client.js reads from and writes to the page, found by reading its source. */
export function clientSurface (src: string): ClientSurface {
  const reads = new Set<string>()
  const writes = new Set<string>()
  for (const m of src.matchAll(/\.(get|has)Attribute\('(data-cb-[a-z-]+)'\)/g)) reads.add(m[2])
  for (const m of src.matchAll(/\[(data-cb-[a-z-]+)\]/g)) reads.add(m[1])
  for (const m of src.matchAll(/\.(set|remove)Attribute\('(data-cb-[a-z-]+)'/g)) writes.add(m[2])
  const metas = new Set([...src.matchAll(/meta\('(cb-[a-z-]+)'\)/g)].map((m) => m[1]))
  const api = new Set<string>()
  const obj = /\b(?:window|cbWindow)\.ArtifactCallbacks = \{([\s\S]*?)\n {2}\}/.exec(src)
  if (obj) for (const m of obj[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) api.add(m[1])
  // Handle's public methods: the class body's method definitions (`    name (`).
  const cls = /\n {2}class Handle \{\n([\s\S]*?)\n {2}\}\n/.exec(src)
  const handle = new Set(cls ? [...cls[1].matchAll(/^ {4}([A-Za-z]\w*) \(/gm)].map((m) => m[1]).filter((n) => n !== 'constructor') : [])
  const events = new Set<string>()
  const l = /this\._l = \{([^}]*)\}/.exec(src)
  if (l) for (const m of l[1].matchAll(/([a-z]+)\s*:/g)) events.add(m[1])
  return { reads, writes, metas, api, handle, events }
}
