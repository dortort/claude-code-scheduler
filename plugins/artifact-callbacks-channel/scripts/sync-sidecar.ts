// Copies the mod's sidecar (and the shared prompt and stream helpers) into this
// plugin, byte for byte. Run it after changing any of them in
// plugins/artifact-callbacks, then commit the copies:
//
//   node scripts/sync-sidecar.ts           write the copies, delete strays
//   node scripts/sync-sidecar.ts --check   exit 1 and list what differs
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNEL_DIR, copies, strays } from './copies.ts'

/** Paths (relative to this plugin) whose copy is missing or differs. */
export function drift (): string[] {
  const out: string[] = []
  for (const c of copies()) {
    let have: Buffer | undefined
    try {
      have = readFileSync(c.target)
    } catch {
      have = undefined
    }
    if (!have || !have.equals(readFileSync(c.source))) out.push(c.rel)
  }
  return [...out, ...strays()]
}

export function sync (): string[] {
  const changed = drift()
  for (const c of copies()) {
    mkdirSync(dirname(c.target), { recursive: true })
    writeFileSync(c.target, readFileSync(c.source))
  }
  for (const rel of strays()) rmSync(join(CHANNEL_DIR, rel))
  return changed
}

/** Run as a script? import.meta.url is resolved through symlinks (macOS /var is
 *  /private/var) and argv[1] is not, so compare real paths. */
function isMain (): boolean {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  if (process.argv.includes('--check')) {
    const out = drift()
    if (out.length > 0) {
      process.stderr.write(`Out of sync with plugins/artifact-callbacks (run node scripts/sync-sidecar.ts):\n${out.map((p) => `  ${p}\n`).join('')}`)
      process.exit(1)
    }
    process.stdout.write('In sync.\n')
  } else {
    const changed = sync()
    process.stdout.write(changed.length === 0 ? 'Already in sync.\n' : `Updated:\n${changed.map((p) => `  ${p}\n`).join('')}`)
  }
}
