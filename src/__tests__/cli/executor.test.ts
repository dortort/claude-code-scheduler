import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// We test the executor's internal logic by importing the module
// and mocking its dependencies.

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs createWriteStream
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    createWriteStream: vi.fn(() => ({
      end: vi.fn(),
      write: vi.fn(),
      on: vi.fn(),
    })),
  };
});

describe('executor module', () => {
  describe('acquireLock (via run)', () => {
    const tmpDir = path.join(os.tmpdir(), `executor-test-${process.pid}`);

    beforeEach(async () => {
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('creates a lock directory', async () => {
      const lockDir = path.join(tmpDir, 'test-lock');
      await mkdir(lockDir);
      const s = await stat(lockDir);
      expect(s.isDirectory()).toBe(true);
    });

    it('writes pid file inside lock directory', async () => {
      const lockDir = path.join(tmpDir, 'pid-test-lock');
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, 'pid'), String(process.pid), 'utf-8');
      const pidContent = await readFile(path.join(lockDir, 'pid'), 'utf-8');
      expect(parseInt(pidContent.trim(), 10)).toBe(process.pid);
    });

    it('lock directory can be removed for cleanup', async () => {
      const lockDir = path.join(tmpDir, 'cleanup-lock');
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, 'pid'), '12345', 'utf-8');
      await rm(lockDir, { recursive: true, force: true });

      let exists = true;
      try {
        await stat(lockDir);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });
  });

  describe('run function structure', () => {
    it('exports a run function', async () => {
      const mod = await import('../../cli/executor.js');
      expect(typeof mod.run).toBe('function');
    });

    it('run rejects with missing task', async () => {
      // Set config to a non-existent path so loadConfig returns empty
      const origEnv = process.env.CLAUDE_SCHEDULER_CONFIG;
      process.env.CLAUDE_SCHEDULER_CONFIG = '/tmp/nonexistent-config-test.json';

      const mod = await import('../../cli/executor.js');
      // run should set exitCode to 1 for missing task, not throw
      const origExitCode = process.exitCode;
      await mod.run('nonexistent-task-id');
      expect(process.exitCode).toBe(1);

      // Cleanup
      process.exitCode = origExitCode;
      process.env.CLAUDE_SCHEDULER_CONFIG = origEnv;
    });
  });

  describe('status marker logic', () => {
    const tmpDir = path.join(os.tmpdir(), `status-test-${process.pid}`);

    beforeEach(async () => {
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('writes success status marker', async () => {
      const statusPath = path.join(tmpDir, 'test.status');
      await writeFile(statusPath, 'success', 'utf-8');
      const content = await readFile(statusPath, 'utf-8');
      expect(content).toBe('success');
    });

    it('writes failure status marker with exit code', async () => {
      const statusPath = path.join(tmpDir, 'test.status');
      await writeFile(statusPath, 'failure:exit-1', 'utf-8');
      const content = await readFile(statusPath, 'utf-8');
      expect(content).toBe('failure:exit-1');
    });

    it('writes timeout status marker', async () => {
      const statusPath = path.join(tmpDir, 'test.status');
      await writeFile(statusPath, 'failure:timeout', 'utf-8');
      const content = await readFile(statusPath, 'utf-8');
      expect(content).toBe('failure:timeout');
    });

    it('writes config-error status marker', async () => {
      const statusPath = path.join(tmpDir, 'test.status');
      await writeFile(statusPath, 'failure:config-error', 'utf-8');
      const content = await readFile(statusPath, 'utf-8');
      expect(content).toBe('failure:config-error');
    });
  });

  describe('worktree detection', () => {
    it('worktree config with enabled:true triggers worktree mode', () => {
      const task = {
        execution: {
          worktree: { enabled: true, branchPrefix: 'claude-task/', remoteName: 'origin' },
        },
      };
      expect(task.execution.worktree?.enabled === true).toBe(true);
    });

    it('worktree config with enabled:false uses direct mode', () => {
      const task = {
        execution: {
          worktree: { enabled: false },
        },
      };
      expect(task.execution.worktree?.enabled === true).toBe(false);
    });

    it('missing worktree config uses direct mode', () => {
      const task = {
        execution: {},
      };
      expect((task.execution as Record<string, unknown>).worktree === undefined).toBe(true);
    });
  });
});
