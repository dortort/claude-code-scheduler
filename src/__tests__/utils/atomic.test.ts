import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic } from '../../utils/atomic.js';

describe('writeFileAtomic', () => {
  const tmpDir = path.join(os.tmpdir(), `atomic-test-${process.pid}`);

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes content to a new file', async () => {
    const target = path.join(tmpDir, 'new.txt');
    await writeFileAtomic(target, 'hello');
    expect(await readFile(target, 'utf-8')).toBe('hello');
  });

  it('overwrites an existing file', async () => {
    const target = path.join(tmpDir, 'existing.txt');
    await writeFile(target, 'old', 'utf-8');
    await writeFileAtomic(target, 'new');
    expect(await readFile(target, 'utf-8')).toBe('new');
  });

  it('applies the requested mode', async () => {
    const target = path.join(tmpDir, 'exec.sh');
    await writeFileAtomic(target, '#!/bin/bash\n', { mode: 0o755 });
    const mode = (await stat(target)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('leaves no temp file behind on success', async () => {
    const target = path.join(tmpDir, 'clean.txt');
    await writeFileAtomic(target, 'data');
    const leftovers = (await readdir(tmpDir)).filter(f => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('cleans up the temp file and rejects when the target dir is missing', async () => {
    const target = path.join(tmpDir, 'missing-subdir', 'file.txt');
    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    const leftovers = (await readdir(tmpDir)).filter(f => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
