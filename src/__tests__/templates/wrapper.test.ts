import { describe, it, expect } from 'vitest';
import {
  generateDirectWrapper,
  generateWorktreeWrapper,
  type WrapperOptions,
  type WorktreeWrapperOptions,
} from '../../templates/wrapper.js';

const baseOptions: WrapperOptions = {
  taskId: 'task-abc123',
  taskName: 'Daily Review',
  command: 'Review the latest commits',
  workingDirectory: '/home/user/project',
  timeout: 300,
  skipPermissions: false,
  logsDir: '/home/user/.claude/logs',
  userPath: '/usr/local/bin:/usr/bin:/bin',
};

describe('generateDirectWrapper', () => {
  it('generates a valid bash script', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain('#!/bin/bash');
  });

  it('sets PATH from captured user PATH', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain('PATH="/usr/local/bin:/usr/bin:/bin"');
  });

  it('changes to the working directory', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain("cd '/home/user/project'");
  });

  it('includes timeout enforcement', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain('300');
    // Should have a timeout mechanism (kill after grace period)
    expect(script).toMatch(/timeout|kill/);
  });

  it('includes flock concurrency guard', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain('flock');
    expect(script).toContain('task-abc123');
  });

  it('invokes claude -p with escaped command', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain('claude');
    expect(script).toContain('-p');
    expect(script).toContain('Review the latest commits');
  });

  it('does NOT include --dangerously-skip-permissions by default', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).not.toContain('--dangerously-skip-permissions');
  });

  it('includes --dangerously-skip-permissions when skipPermissions=true', () => {
    const script = generateDirectWrapper({ ...baseOptions, skipPermissions: true });
    expect(script).toContain('--dangerously-skip-permissions');
  });

  it('writes stdout and stderr to log files', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain('.out.log');
    expect(script).toContain('.err.log');
  });

  it('writes a status marker file on completion', () => {
    const script = generateDirectWrapper(baseOptions);
    expect(script).toContain('.status');
    expect(script).toContain('success');
    expect(script).toContain('failure');
  });

  it('properly escapes commands with single quotes', () => {
    const script = generateDirectWrapper({
      ...baseOptions,
      command: "Review yesterday's commits",
    });
    // Should use shellEscape technique
    expect(script).toContain("'\\''");
  });

  it('properly escapes commands with shell metacharacters', () => {
    const script = generateDirectWrapper({
      ...baseOptions,
      command: 'test $HOME && rm -rf /',
    });
    // Should be wrapped in single quotes (prevents expansion)
    expect(script).toContain("'test $HOME && rm -rf /'");
  });
});

describe('generateWorktreeWrapper', () => {
  const worktreeOptions: WorktreeWrapperOptions = {
    ...baseOptions,
    repoPath: '/home/user/project',
    branchPrefix: 'claude-task/',
    remoteName: 'origin',
  };

  it('generates a valid bash script', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('#!/bin/bash');
  });

  it('creates a git worktree', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('git worktree add');
  });

  it('includes branch prefix in worktree creation', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('claude-task/');
  });

  it('runs claude in the worktree directory', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('claude');
    expect(script).toContain('-p');
  });

  it('commits with git add -u (not -A)', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('git add -u');
    expect(script).not.toMatch(/git add -A/);
  });

  it('pushes to the configured remote', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('git push');
    expect(script).toContain('origin');
  });

  it('cleans up worktree on success', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('git worktree remove');
  });

  it('includes a trap handler for cleanup on signals', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('trap');
  });

  it('includes flock concurrency guard', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('flock');
  });

  it('includes timeout enforcement', () => {
    const script = generateWorktreeWrapper(worktreeOptions);
    expect(script).toContain('300');
  });

  it('escapes remote name', () => {
    const script = generateWorktreeWrapper({ ...worktreeOptions, remoteName: 'my-remote' });
    expect(script).toContain("'my-remote'");
  });
});
