/**
 * Tests for transient-auth-failure retry in spawnClaudeWithAuthRetry.
 *
 * A fake claude script with a persistent invocation counter lets us assert
 * exactly how many times claude is (re)spawned for each failure shape:
 *   - auth failure then success -> retries once, succeeds
 *   - persistent auth failure    -> stops at maxAttempts
 *   - non-auth failure           -> no retry
 *   - success first try          -> no retry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { spawnClaudeWithAuthRetry } from '../../cli/executor.js';

const FAST_DELAY_MS = 10; // keep the backoff negligible in tests

describe('spawnClaudeWithAuthRetry', () => {
  let tmpDir: string;
  let counterPath: string;
  let stdoutPath: string;
  let stderrPath: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `executor-auth-retry-${process.pid}-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    counterPath = path.join(tmpDir, 'count');
    stdoutPath = path.join(tmpDir, 'out.log');
    stderrPath = path.join(tmpDir, 'err.log');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Write a fake `claude` that increments counterPath on each invocation and
   * branches on the count: invocations listed in `authFailUntil` print an auth
   * error and exit 1; otherwise it runs `onSuccess` (default: succeed).
   */
  async function writeFakeClaude(opts: {
    authFailUntil: number; // fail invocations 1..N with a 401
    finalExitCode?: number; // exit code once it stops auth-failing
    finalStdout?: string;
  }): Promise<string> {
    const bin = path.join(tmpDir, 'claude');
    const finalExit = opts.finalExitCode ?? 0;
    const finalOut = opts.finalStdout ?? 'Response OK';
    await writeFile(
      bin,
      `#!/bin/bash
n=$(cat "${counterPath}" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "${counterPath}"
if [ "$n" -le ${opts.authFailUntil} ]; then
  echo "Failed to authenticate. API Error: 401 Invalid authentication credentials"
  exit 1
fi
echo "${finalOut}"
exit ${finalExit}
`,
      { mode: 0o755 },
    );
    return bin;
  }

  function baseOptions(claudeBin: string) {
    return {
      cwd: tmpDir,
      skipPermissions: false,
      stdoutPath,
      stderrPath,
      timeout: 30,
      claudeBin,
    };
  }

  async function invocationCount(): Promise<number> {
    return parseInt((await readFile(counterPath, 'utf-8')).trim(), 10);
  }

  it('retries once on a transient auth failure and then succeeds', async () => {
    const claudeBin = await writeFakeClaude({ authFailUntil: 1 });

    const result = await spawnClaudeWithAuthRetry(
      'do work',
      baseOptions(claudeBin),
      2,
      FAST_DELAY_MS,
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(await invocationCount()).toBe(2); // initial + 1 retry
    expect((await readFile(stdoutPath, 'utf-8')).trim()).toBe('Response OK');
  });

  it('stops at maxAttempts when the auth failure persists', async () => {
    const claudeBin = await writeFakeClaude({ authFailUntil: 99 });

    const result = await spawnClaudeWithAuthRetry(
      'do work',
      baseOptions(claudeBin),
      2,
      FAST_DELAY_MS,
    );

    expect(result.exitCode).toBe(1);
    expect(await invocationCount()).toBe(2); // bounded — does not loop forever
  });

  it('honors a higher maxAttempts before giving up', async () => {
    const claudeBin = await writeFakeClaude({ authFailUntil: 99 });

    const result = await spawnClaudeWithAuthRetry(
      'do work',
      baseOptions(claudeBin),
      3,
      FAST_DELAY_MS,
    );

    expect(result.exitCode).toBe(1);
    expect(await invocationCount()).toBe(3);
  });

  it('does not retry a non-auth failure', async () => {
    // Never auth-fails; first invocation exits 1 with unrelated output.
    const claudeBin = await writeFakeClaude({
      authFailUntil: 0,
      finalExitCode: 1,
      finalStdout: 'some other error',
    });

    const result = await spawnClaudeWithAuthRetry(
      'do work',
      baseOptions(claudeBin),
      2,
      FAST_DELAY_MS,
    );

    expect(result.exitCode).toBe(1);
    expect(await invocationCount()).toBe(1); // no retry for non-auth failures
  });

  it('does not retry a first-try success', async () => {
    const claudeBin = await writeFakeClaude({ authFailUntil: 0 });

    const result = await spawnClaudeWithAuthRetry(
      'do work',
      baseOptions(claudeBin),
      2,
      FAST_DELAY_MS,
    );

    expect(result.exitCode).toBe(0);
    expect(await invocationCount()).toBe(1);
  });
});
