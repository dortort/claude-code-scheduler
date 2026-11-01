// The channel build runs the mod's own listener: the sidecar folder (and the
// shared prompt and stream helpers) must stay byte-identical copies.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNEL_DIR, MOD_DIR, copies, strays } from '../scripts/copies.ts'

function check (channelDir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(channelDir, 'scripts', 'sync-sidecar.ts'), '--check'], { encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

/** A throwaway copy of both plugins, laid out as in the repository, reached
 *  through a symlinked folder the way macOS reaches its temp dir (/var is
 *  /private/var), so the script's run-as-main check meets an unresolved argv. */
function sandbox (): { mod: string; channel: string } {
  const real = mkdtempSync(join(tmpdir(), 'cb-drift-'))
  const root = join(real, 'via-link')
  mkdirSync(join(real, 'target'))
  symlinkSync(join(real, 'target'), root, 'dir')
  const mod = join(root, 'artifact-callbacks')
  const channel = join(root, 'artifact-callbacks-channel')
  cpSync(join(MOD_DIR, 'sidecar'), join(mod, 'sidecar'), { recursive: true })
  cpSync(join(MOD_DIR, 'hooks', 'lib'), join(mod, 'hooks', 'lib'), { recursive: true })
  for (const d of ['scripts', 'sidecar', 'server']) cpSync(join(CHANNEL_DIR, d), join(channel, d), { recursive: true })
  return { mod, channel }
}

describe('sidecar copies', () => {
  test('every copied file is byte-identical to the mod\'s', () => {
    const list = copies()
    assert.ok(list.some((c) => c.rel === 'sidecar/listener.ts'))
    assert.ok(list.some((c) => c.rel === 'sidecar/client.js'))
    for (const c of list) assert.ok(readFileSync(c.target).equals(readFileSync(c.source)), `${c.rel} differs from the mod; run node scripts/sync-sidecar.ts`)
    assert.deepEqual(strays(), [])
    assert.deepEqual(readdirSync(join(CHANNEL_DIR, 'sidecar')).sort(), readdirSync(join(MOD_DIR, 'sidecar')).sort())
  })

  test('the check script passes on the repository', () => {
    const r = check(CHANNEL_DIR)
    assert.equal(r.status, 0, r.out)
  })

  test('the check fails on a changed, missing or extra file, and sync repairs it', () => {
    const { mod, channel } = sandbox()
    appendFileSync(join(mod, 'sidecar', 'listener.ts'), '\n// changed in the mod\n')
    writeFileSync(join(channel, 'server', 'shared', 'stream.ts'), 'stale')
    writeFileSync(join(channel, 'sidecar', 'old.ts'), 'gone from the mod')
    const bad = check(channel)
    assert.equal(bad.status, 1)
    assert.match(bad.out, /sidecar\/listener\.ts/)
    assert.match(bad.out, /server\/shared\/stream\.ts/)
    assert.match(bad.out, /sidecar\/old\.ts/)
    const fix = spawnSync(process.execPath, [join(channel, 'scripts', 'sync-sidecar.ts')], { encoding: 'utf8' })
    assert.equal(fix.status, 0, fix.stderr)
    assert.equal(check(channel).status, 0)
    assert.match(readFileSync(join(channel, 'sidecar', 'listener.ts'), 'utf8'), /changed in the mod/)
  })
})
