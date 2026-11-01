/**
 * Tests for executor output capture.
 *
 * Tier 1: Unit — verifies fd-based output capture with a mock command
 * Tier 2: Integration — verifies full executor pipeline with a fake claude script
 * Tier 3: E2E — verifies actual claude -p output capture (skipped if CLI unavailable)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// --- Tier 1: Unit — fd-based output capture ---

describe('output capture: fd redirect', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTmpDir('fd-capture');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('captures stdout to file via fd redirect', async () => {
    const stdoutPath = path.join(tmpDir, 'stdout.log');
    const stdoutFd = openSync(stdoutPath, 'w');

    const result = await new Promise<number>((resolve) => {
      const child = spawn('echo', ['hello from fd redirect'], {
        stdio: ['ignore', stdoutFd, 'ignore'],
      });
      child.on('close', (code) => {
        closeSync(stdoutFd);
        resolve(code ?? 1);
      });
    });

    expect(result).toBe(0);
    const content = await readFile(stdoutPath, 'utf-8');
    expect(content.trim()).toBe('hello from fd redirect');
  });

  it('captures stderr to file via fd redirect', async () => {
    const stderrPath = path.join(tmpDir, 'stderr.log');
    const stderrFd = openSync(stderrPath, 'w');

    await new Promise<void>((resolve) => {
      const child = spawn('bash', ['-c', 'echo "error output" >&2'], {
        stdio: ['ignore', 'ignore', stderrFd],
      });
      child.on('close', () => {
        closeSync(stderrFd);
        resolve();
      });
    });

    const content = await readFile(stderrPath, 'utf-8');
    expect(content.trim()).toBe('error output');
  });

  it('creates empty file when command produces no output', async () => {
    const stdoutPath = path.join(tmpDir, 'empty.log');
    const stdoutFd = openSync(stdoutPath, 'w');

    await new Promise<void>((resolve) => {
      const child = spawn('true', [], {
        stdio: ['ignore', stdoutFd, 'ignore'],
      });
      child.on('close', () => {
        closeSync(stdoutFd);
        resolve();
      });
    });

    const content = await readFile(stdoutPath, 'utf-8');
    expect(content).toBe('');
  });

  it('captures multiline output correctly', async () => {
    const stdoutPath = path.join(tmpDir, 'multi.log');
    const stdoutFd = openSync(stdoutPath, 'w');

    await new Promise<void>((resolve) => {
      const child = spawn('bash', ['-c', 'echo "line 1"; echo "line 2"; echo "line 3"'], {
        stdio: ['ignore', stdoutFd, 'ignore'],
      });
      child.on('close', () => {
        closeSync(stdoutFd);
        resolve();
      });
    });

    const content = await readFile(stdoutPath, 'utf-8');
    expect(content).toContain('line 1');
    expect(content).toContain('line 2');
    expect(content).toContain('line 3');
  });
});

// --- Tier 2: Integration — fake claude script ---

describe('output capture: fake claude integration', () => {
  let tmpDir: string;
  let fakeBinDir: string;

  beforeEach(async () => {
    tmpDir = await mkTmpDir('fake-claude');
    fakeBinDir = path.join(tmpDir, 'bin');
    await mkdir(fakeBinDir, { recursive: true });

    // Create a fake claude script that mimics claude -p behavior
    // Skips -p and all --flags (with values for known flags), echoes the remaining prompt
    const fakeClaude = path.join(fakeBinDir, 'claude');
    await writeFile(fakeClaude, `#!/bin/bash
shift  # skip -p
while [[ "$1" == --* ]]; do
  case "$1" in
    --dangerously-skip-permissions) shift ;;  # boolean flag, no value
    *) shift; shift ;;  # flag + value
  esac
done
echo "Response to: $*"
`, { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('captures fake claude output via fd redirect', async () => {
    const stdoutPath = path.join(tmpDir, 'stdout.log');
    const stderrPath = path.join(tmpDir, 'stderr.log');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');

    const fakeClaude = path.join(fakeBinDir, 'claude');

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(fakeClaude, ['-p', 'Check my email'], {
        stdio: ['ignore', stdoutFd, stderrFd],
        env: { ...process.env },
      });
      child.on('close', (code) => {
        closeSync(stdoutFd);
        closeSync(stderrFd);
        resolve(code ?? 1);
      });
    });

    expect(exitCode).toBe(0);
    const content = await readFile(stdoutPath, 'utf-8');
    expect(content.trim()).toBe('Response to: Check my email');
  });

  it('captures output with --dangerously-skip-permissions flag', async () => {
    const stdoutPath = path.join(tmpDir, 'stdout-skip.log');
    const stderrPath = path.join(tmpDir, 'stderr-skip.log');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');

    const fakeClaude = path.join(fakeBinDir, 'claude');

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(fakeClaude, ['-p', '--dangerously-skip-permissions', 'Run task'], {
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      child.on('close', (code) => {
        closeSync(stdoutFd);
        closeSync(stderrFd);
        resolve(code ?? 1);
      });
    });

    expect(exitCode).toBe(0);
    const content = await readFile(stdoutPath, 'utf-8');
    expect(content.trim()).toBe('Response to: Run task');
  });

  it('captures output with --append-system-prompt flag', async () => {
    const stdoutPath = path.join(tmpDir, 'stdout-ctx.log');
    const stderrPath = path.join(tmpDir, 'stderr-ctx.log');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');

    const fakeClaude = path.join(fakeBinDir, 'claude');

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(fakeClaude, [
        '-p', '--append-system-prompt', 'Previous context here', 'Check email',
      ], {
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      child.on('close', (code) => {
        closeSync(stdoutFd);
        closeSync(stderrFd);
        resolve(code ?? 1);
      });
    });

    expect(exitCode).toBe(0);
    const content = await readFile(stdoutPath, 'utf-8');
    expect(content.trim()).toBe('Response to: Check email');
  });
});

// --- Tier 3: E2E — actual claude -p output capture ---

describe('output capture: claude -p E2E', () => {
  let tmpDir: string;
  let claudeAvailable: boolean;

  beforeEach(async () => {
    tmpDir = await mkTmpDir('claude-e2e');

    // Check if claude CLI is available
    claudeAvailable = await new Promise<boolean>((resolve) => {
      const child = spawn('claude', ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('claude -p produces non-empty stdout via fd redirect', async () => {
    if (!claudeAvailable) {
      console.log('Skipping: claude CLI not available');
      return;
    }

    const stdoutPath = path.join(tmpDir, 'e2e-stdout.log');
    const stderrPath = path.join(tmpDir, 'e2e-stderr.log');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('claude', ['-p', 'Respond with exactly: OUTPUT_CAPTURE_TEST_OK'], {
        stdio: ['ignore', stdoutFd, stderrFd],
        env: { ...process.env },
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, 60000);

      child.on('close', (code) => {
        clearTimeout(timer);
        closeSync(stdoutFd);
        closeSync(stderrFd);
        resolve(code ?? 1);
      });

      child.on('error', () => {
        clearTimeout(timer);
        closeSync(stdoutFd);
        closeSync(stderrFd);
        resolve(1);
      });
    });

    expect(exitCode).toBe(0);

    const content = await readFile(stdoutPath, 'utf-8');
    // The key assertion: stdout must be non-empty (not 0 or 1 bytes)
    // This catches the v2.1.83 regression where claude -p produced empty stdout
    expect(content.length).toBeGreaterThan(1);
    expect(content.trim().length).toBeGreaterThan(0);
  }, 90000); // 90s timeout for API call
});

// --- Helpers ---

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `executor-output-${prefix}-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
