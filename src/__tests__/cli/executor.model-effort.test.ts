/**
 * Tests for per-task model and effort selection (issue #7).
 *
 * Unit: buildClaudeArgs only includes --model / --effort when they are set.
 * Integration: the flags reach the spawned claude process in the right order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { buildClaudeArgs, spawnClaudeWithAuthRetry } from '../../cli/executor.js';

describe('buildClaudeArgs', () => {
  it('omits --model and --effort when neither is set', () => {
    const args = buildClaudeArgs('do work', { skipPermissions: false });
    expect(args).toEqual(['-p', 'do work']);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('adds --model when set', () => {
    const args = buildClaudeArgs('do work', { skipPermissions: false, model: 'sonnet' });
    expect(args).toEqual(['-p', '--model', 'sonnet', 'do work']);
  });

  it('adds --effort when set', () => {
    const args = buildClaudeArgs('do work', { skipPermissions: false, effort: 'medium' });
    expect(args).toEqual(['-p', '--effort', 'medium', 'do work']);
  });

  it('accepts a full model ID, not just an alias', () => {
    const args = buildClaudeArgs('do work', { skipPermissions: false, model: 'claude-sonnet-5-5' });
    expect(args).toEqual(['-p', '--model', 'claude-sonnet-5-5', 'do work']);
  });

  it('places both flags before the command and alongside the other flags', () => {
    const args = buildClaudeArgs('do work', {
      skipPermissions: true,
      worktreeName: 'task-abc',
      appendSystemPrompt: 'ctx',
      model: 'haiku',
      effort: 'low',
    });
    expect(args).toEqual([
      '-p',
      '--worktree', 'task-abc',
      '--append-system-prompt', 'ctx',
      '--model', 'haiku',
      '--effort', 'low',
      '--dangerously-skip-permissions',
      'do work',
    ]);
    // The prompt is always the last argument
    expect(args[args.length - 1]).toBe('do work');
  });

  it('treats undefined values the same as unset', () => {
    const args = buildClaudeArgs('do work', { skipPermissions: false, model: undefined, effort: undefined });
    expect(args).toEqual(['-p', 'do work']);
  });
});

describe('spawnClaude passes --model and --effort to the child', () => {
  let tmpDir: string;
  let stdoutPath: string;
  let stderrPath: string;
  let claudeBin: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `executor-model-effort-${process.pid}-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    stdoutPath = path.join(tmpDir, 'out.log');
    stderrPath = path.join(tmpDir, 'err.log');
    // Fake claude that prints its argv, one per line
    claudeBin = path.join(tmpDir, 'claude');
    await writeFile(claudeBin, '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function argvSeenByChild(): Promise<string[]> {
    return (await readFile(stdoutPath, 'utf-8')).split('\n').filter((l) => l.length > 0);
  }

  it('sends the flags when set on the task', async () => {
    const result = await spawnClaudeWithAuthRetry('triage issues', {
      cwd: tmpDir,
      skipPermissions: true,
      stdoutPath,
      stderrPath,
      timeout: 30,
      claudeBin,
      model: 'sonnet',
      effort: 'medium',
    });

    expect(result.exitCode).toBe(0);
    expect(await argvSeenByChild()).toEqual([
      '-p', '--model', 'sonnet', '--effort', 'medium', '--dangerously-skip-permissions', 'triage issues',
    ]);
  });

  it('sends no model/effort flags when the task leaves them unset', async () => {
    const result = await spawnClaudeWithAuthRetry('triage issues', {
      cwd: tmpDir,
      skipPermissions: false,
      stdoutPath,
      stderrPath,
      timeout: 30,
      claudeBin,
    });

    expect(result.exitCode).toBe(0);
    expect(await argvSeenByChild()).toEqual(['-p', 'triage issues']);
  });
});
