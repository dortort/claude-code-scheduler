/**
 * Atomic file writes: write to a temp file in the same directory, then rename
 * over the target. A concurrent reader (e.g. launchd exec'ing a shim while a
 * sync rewrites it) always sees either the whole old file or the whole new
 * one, never a truncated or half-written file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface WriteFileAtomicOptions {
  mode?: number;
}

// Distinguishes concurrent writes to the same target from within one process,
// so their temp files never collide.
let writeCounter = 0;

export async function writeFileAtomic(
  filePath: string,
  content: string,
  options?: WriteFileAtomicOptions,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${writeCounter++}`);

  const writeOptions = options?.mode !== undefined ? { mode: options.mode } : undefined;

  try {
    await fs.writeFile(tmpPath, content, writeOptions);
    // rename is atomic on the same filesystem; the temp file shares the target's
    // directory so this never crosses a filesystem boundary.
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
