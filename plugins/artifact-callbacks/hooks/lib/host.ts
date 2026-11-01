// Host facts: the platform, whether Node is new enough to run the sidecar,
// how to open a URL, and the restart schedule.

export type Platform = 'darwin' | 'linux' | 'win32'

/** The platform from what the host reports: `OS` and `uname -s`. */
export function platformFrom(osVar: string | undefined, uname: string | undefined): Platform {
  if (osVar === 'Windows_NT') return 'win32'
  const u = (uname ?? '').trim().toLowerCase()
  if (u.startsWith('darwin')) return 'darwin'
  if (u.startsWith('mingw') || u.startsWith('msys') || u.startsWith('cygwin')) return 'win32'
  return 'linux'
}

/** The oldest Node that runs `sidecar/listener.ts` (type stripping on by default). */
export const MIN_NODE = '22.18.0'
/** The command whose output says which Node is on PATH. */
export const NODE_PROBE: readonly string[] = ['node', '--version']

type Version = readonly [number, number, number]

/** `v22.18.0` (or `22.18.0`) as numbers; undefined for anything else. */
export function parseNodeVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/.exec(text.trim())
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function isAtLeast(v: Version, min: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (v[i]! !== min[i]!) return v[i]! > min[i]!
  }
  return true
}

/** Why the listener cannot start, as a stable code. */
export type NodeProblem = 'node-missing' | 'node-too-old'

/** The outcome of running `node --version`. */
export type NodeCheck =
  | { isOk: true; version: string }
  | { isOk: false; problem: NodeProblem; found: string | null }

/**
 * Judges the result of `node --version`: `undefined` when the command could
 * not run at all. A non-zero exit or output that is not a version counts as
 * no usable Node; `found` keeps what it printed for the person.
 */
export function checkNode(result: { exitCode: number; stdout: string } | undefined): NodeCheck {
  if (!result || result.exitCode !== 0) return { isOk: false, problem: 'node-missing', found: null }
  const printed = result.stdout.trim()
  const version = parseNodeVersion(printed)
  if (!version) return { isOk: false, problem: 'node-missing', found: printed === '' ? null : printed.slice(0, 40) }
  const shown = `v${version.join('.')}`
  const min = parseNodeVersion(MIN_NODE) as Version
  return isAtLeast(version, min) ? { isOk: true, version: shown } : { isOk: false, problem: 'node-too-old', found: shown }
}

/** The listener's down reason for a failed check: the code, then words with the found and minimum versions. */
export function nodeReason(check: Extract<NodeCheck, { isOk: false }>): string {
  if (check.problem === 'node-too-old') return `node-too-old: found Node ${check.found}, need >= ${MIN_NODE}`
  if (check.found !== null) return `node-missing: \`node --version\` printed "${check.found}", need Node >= ${MIN_NODE}`
  return `node-missing: no node on PATH, need Node >= ${MIN_NODE}`
}

/** The sidecar's argv: Node runs the TypeScript listener directly. */
export function listenerArgv(pluginRoot: string): string[] {
  return ['node', `${pluginRoot}/sidecar/listener.ts`]
}

/** The argv that opens `url` in the default browser. */
export function openCommand(platform: Platform, url: string): string[] {
  if (platform === 'darwin') return ['open', url]
  if (platform === 'win32') return ['cmd', '/c', 'start', '""', url]
  return ['xdg-open', url]
}

/** Waits before restart 1, 2 and 3 of a crashed sidecar. */
export const BACKOFF_MS: readonly number[] = [1000, 5000, 30000]
export const MAX_RESTARTS = BACKOFF_MS.length
/** A listener up this long counts as healthy again: its restart count resets. */
export const HEALTHY_MS = 60_000

/** The wait before restart number `restarts + 1`; undefined once it gives up. */
export function backoffDelay(restarts: number): number | undefined {
  return BACKOFF_MS[restarts]
}

/** A random hex string of `bytes` bytes from the CSPRNG. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}
