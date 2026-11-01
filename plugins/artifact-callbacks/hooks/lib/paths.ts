// Path helpers. The hooks module has no `path` module, so these join with
// `/`, which every platform's file APIs accept.

export const DEFAULT_ARTIFACTS_DIR = '.claude/artifacts'
export const RUN_ROOT = '.claude/.artifact-callbacks'

export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/** Joins path parts with `/`, collapsing duplicate separators between them. */
export function join(...parts: string[]): string {
  const kept = parts.filter(p => p !== '')
  if (kept.length === 0) return ''
  return kept
    .map((p, i) => {
      let s = p
      if (i > 0) s = s.replace(/^[\\/]+/, '')
      if (i < kept.length - 1) s = s.replace(/[\\/]+$/, '')
      return s
    })
    .join('/')
}

/** The artifacts folder for a session: the option, relative to cwd unless absolute. */
export function artifactsDir(cwd: string, option: unknown): string {
  const raw = typeof option === 'string' && option.trim() !== '' ? option.trim() : DEFAULT_ARTIFACTS_DIR
  const clean = raw.replace(/[\\/]+$/, '')
  return isAbsolute(clean) ? clean : join(cwd, clean)
}

/** Ids from the engine are used as folder names: keep them to a safe alphabet. */
export function safeSegment(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return s === '' ? 'session' : s
}

/** The per-session run folder, outside the artifacts folder. */
export function runDir(cwd: string, sessionId: string): string {
  return join(cwd, RUN_ROOT, safeSegment(sessionId))
}

/**
 * A page as the person types it for `/callbacks open|trust|untrust`:
 * a leading `/a/` or `/` dropped, `.html` added when it names no extension.
 * Undefined for something that cannot be a page (`..`, a dotfile, empty).
 */
export function normalizePage(input: string): string | undefined {
  let page = input.trim().replace(/\\/g, '/')
  const marker = page.match(/^https?:\/\/[^/]+\/a\/(.*)$/)
  if (marker?.[1] !== undefined) page = decodeSafe(marker[1])
  page = page.replace(/^\/?a\//, '').replace(/^\/+/, '')
  if (page === '') return undefined
  const segments = page.split('/')
  if (segments.some(s => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return undefined
  if (page.includes('\0')) return undefined
  const last = segments[segments.length - 1] ?? ''
  if (!last.includes('.')) page = `${page}.html`
  return page
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
