// Host facts: the platform, which runtime runs the sidecar, how to open a
// URL, and the restart schedule.

export type Platform = 'darwin' | 'linux' | 'win32'
export type RuntimeOption = 'auto' | 'node' | 'python3'
export type RuntimeName = 'node' | 'python3'

export function parseRuntime(value: unknown): RuntimeOption {
  return value === 'node' || value === 'python3' ? value : 'auto'
}

/** The platform from what the host reports: `OS` and `uname -s`. */
export function platformFrom(osVar: string | undefined, uname: string | undefined): Platform {
  if (osVar === 'Windows_NT') return 'win32'
  const u = (uname ?? '').trim().toLowerCase()
  if (u.startsWith('darwin')) return 'darwin'
  if (u.startsWith('mingw') || u.startsWith('msys') || u.startsWith('cygwin')) return 'win32'
  return 'linux'
}

export type RuntimeCandidate = {
  name: RuntimeName
  /** The command that proves the runtime is there (exit code 0). */
  probe: readonly string[]
  /** The sidecar's argv for this runtime. */
  argv: (pluginRoot: string) => string[]
}

const NODE: RuntimeCandidate = {
  name: 'node',
  probe: ['node', '--version'],
  argv: root => ['node', `${root}/sidecar/listener.mjs`],
}

const PYTHON: RuntimeCandidate = {
  name: 'python3',
  probe: ['python3', '--version'],
  argv: root => ['python3', `${root}/sidecar/listener.py`],
}

const PY_LAUNCHER: RuntimeCandidate = {
  name: 'python3',
  probe: ['py', '-3', '--version'],
  argv: root => ['py', '-3', `${root}/sidecar/listener.py`],
}

/** The runtimes to try, in order, for the `runtime` option on a platform. */
export function runtimeCandidates(option: RuntimeOption, platform: Platform): RuntimeCandidate[] {
  const python = platform === 'win32' ? PY_LAUNCHER : PYTHON
  if (option === 'node') return [NODE]
  if (option === 'python3') return [python]
  return [NODE, python]
}

/** Why no runtime could be used, in words for the status line. */
export function noRuntimeReason(option: RuntimeOption): string {
  if (option === 'node') return 'node not found (runtime option is "node")'
  if (option === 'python3') return 'python3 not found (runtime option is "python3")'
  return 'neither node nor python3 found'
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
