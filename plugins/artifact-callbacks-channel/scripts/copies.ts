// The files this plugin carries as byte-identical copies of the mod's own
// (plugins/artifact-callbacks). The channel build spawns the SAME listener, so
// the whole sidecar folder is copied; the prompt template and the reply-stream
// serializer are shared so events read and stream exactly as in the mod.
// scripts/sync-sidecar.ts writes them; test/drift.spec.ts fails when they differ.
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This plugin's folder. */
export const CHANNEL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The mod's folder, the source of every copy. */
export const MOD_DIR = resolve(CHANNEL_DIR, '..', 'artifact-callbacks')

/** Folders copied whole: every file in the source, nothing else in the copy. */
export const COPIED_DIRS: readonly { from: string; to: string }[] = [
  { from: 'sidecar', to: 'sidecar' },
]

/** Single files copied from the mod, as [source, copy] relative to each plugin. */
export const COPIED_FILES: readonly { from: string; to: string }[] = [
  { from: 'hooks/lib/template.ts', to: 'server/shared/template.ts' },
  { from: 'hooks/lib/stream.ts', to: 'server/shared/stream.ts' },
]

export interface Copy { source: string; target: string; rel: string }

/** Every file to copy, with absolute paths, sorted by its path in this plugin. */
export function copies (): Copy[] {
  const out: Copy[] = []
  for (const d of COPIED_DIRS) {
    for (const name of readdirSync(join(MOD_DIR, d.from)).sort()) {
      out.push({ source: join(MOD_DIR, d.from, name), target: join(CHANNEL_DIR, d.to, name), rel: `${d.to}/${name}` })
    }
  }
  for (const f of COPIED_FILES) {
    out.push({ source: join(MOD_DIR, f.from), target: join(CHANNEL_DIR, f.to), rel: f.to })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** Files in a copied folder of this plugin that the mod no longer has. */
export function strays (): string[] {
  const out: string[] = []
  for (const d of COPIED_DIRS) {
    const wanted = new Set(readdirSync(join(MOD_DIR, d.from)))
    let have: string[] = []
    try {
      have = readdirSync(join(CHANNEL_DIR, d.to))
    } catch {
      have = []
    }
    for (const name of have.sort()) if (!wanted.has(name)) out.push(`${d.to}/${name}`)
  }
  return out
}
