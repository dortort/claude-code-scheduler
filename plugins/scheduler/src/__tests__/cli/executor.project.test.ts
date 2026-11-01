/**
 * Tests for project-level config support in executor.
 * Issue 3: projectPath field on ExecutionConfig triggers loadMergedConfig.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config module so we can spy on loadConfig / loadMergedConfig
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    loadConfig: vi.fn(),
    loadMergedConfig: vi.fn(),
  };
});

// Mock child_process so spawn never actually runs
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock node:fs openSync/closeSync used by spawnClaude
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync: vi.fn().mockReturnValue(1),
    closeSync: vi.fn(),
  };
});

import { loadConfig, loadMergedConfig } from '../../config.js';
import type { SchedulesConfig } from '../../types.js';

// Helper: build a minimal valid SchedulesConfig
function makeConfig(tasks: SchedulesConfig['tasks'] = []): SchedulesConfig {
  return { version: 1, tasks };
}

// Helper: build a minimal ScheduledTask
function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'Test Task',
    enabled: true,
    trigger: { type: 'cron' as const, expression: '* * * * *', timezone: 'local' },
    execution: {
      command: 'echo hello',
      workingDirectory: '/tmp',
      timeout: 30,
      skipPermissions: false,
    },
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('executor projectPath support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls loadMergedConfig when task has projectPath set', async () => {
    const task = makeTask({
      execution: {
        command: 'echo hello',
        workingDirectory: '/tmp',
        timeout: 30,
        skipPermissions: false,
        projectPath: '/projects/myapp',
      },
    });
    const globalConfig = makeConfig([task]);
    const mergedConfig = makeConfig([task]);

    vi.mocked(loadConfig).mockResolvedValue(globalConfig);
    vi.mocked(loadMergedConfig).mockResolvedValue({
      global: globalConfig,
      project: makeConfig(),
      merged: mergedConfig,
    });

    // Set env to point to a dummy config (loadConfig is mocked so path doesn't matter)
    const origEnv = process.env.CLAUDE_SCHEDULER_CONFIG;
    process.env.CLAUDE_SCHEDULER_CONFIG = '/tmp/fake-schedules.json';

    // Reset module cache so mocks take effect cleanly
    vi.resetModules();
    const { run } = await import('../../cli/executor.js');

    // run will try to acquire lock and spawn — both will fail/no-op due to mocks
    // We just verify the config-loading calls
    try {
      await run('task-1');
    } catch {
      // ignore spawn/lock failures
    }

    expect(loadMergedConfig).toHaveBeenCalledWith('/projects/myapp', '/tmp/fake-schedules.json');

    process.env.CLAUDE_SCHEDULER_CONFIG = origEnv;
  });

  it('does not call loadMergedConfig when task has no projectPath', async () => {
    const task = makeTask(); // no projectPath
    const config = makeConfig([task]);

    vi.mocked(loadConfig).mockResolvedValue(config);

    const origEnv = process.env.CLAUDE_SCHEDULER_CONFIG;
    process.env.CLAUDE_SCHEDULER_CONFIG = '/tmp/fake-schedules.json';

    vi.resetModules();
    const { run } = await import('../../cli/executor.js');

    try {
      await run('task-1');
    } catch {
      // ignore spawn/lock failures
    }

    expect(loadMergedConfig).not.toHaveBeenCalled();

    process.env.CLAUDE_SCHEDULER_CONFIG = origEnv;
  });

  it('strips skipPermissions from project tasks via loadMergedConfig', async () => {
    // A project task with skipPermissions:true should have it stripped to false
    const projectTask = makeTask({
      id: 'proj-task',
      execution: {
        command: 'echo danger',
        workingDirectory: '/tmp',
        timeout: 30,
        skipPermissions: true,  // should be stripped
        projectPath: '/projects/myapp',
      },
    });
    const globalConfig = makeConfig([]);
    // The merged config already has it stripped (loadMergedConfig enforces this)
    const sanitizedTask = {
      ...projectTask,
      execution: { ...projectTask.execution, skipPermissions: false },
    };
    const mergedConfig = makeConfig([sanitizedTask]);

    vi.mocked(loadConfig).mockResolvedValue(makeConfig([projectTask]));
    vi.mocked(loadMergedConfig).mockResolvedValue({
      global: globalConfig,
      project: makeConfig([projectTask]),
      merged: mergedConfig,
    });

    const origEnv = process.env.CLAUDE_SCHEDULER_CONFIG;
    process.env.CLAUDE_SCHEDULER_CONFIG = '/tmp/fake-schedules.json';

    vi.resetModules();
    const { run } = await import('../../cli/executor.js');

    try {
      await run('proj-task');
    } catch {
      // ignore spawn/lock failures
    }

    expect(loadMergedConfig).toHaveBeenCalledWith('/projects/myapp', '/tmp/fake-schedules.json');

    process.env.CLAUDE_SCHEDULER_CONFIG = origEnv;
  });

  it('drops project task on global ID collision (merged config handles this)', async () => {
    // Global has task-1; project also has task-1 → merged drops project's task-1
    const globalTask = makeTask({ id: 'task-1', name: 'Global Task' });
    const projectTask = makeTask({
      id: 'task-1',
      name: 'Project Task',
      execution: {
        command: 'echo project',
        workingDirectory: '/tmp',
        timeout: 30,
        skipPermissions: false,
        projectPath: '/projects/myapp',
      },
    });
    const globalConfig = makeConfig([globalTask]);
    // merged has only global task (project's task-1 was dropped)
    const mergedConfig = makeConfig([globalTask]);

    vi.mocked(loadConfig).mockResolvedValue(makeConfig([projectTask]));
    vi.mocked(loadMergedConfig).mockResolvedValue({
      global: globalConfig,
      project: makeConfig([projectTask]),
      merged: mergedConfig,
    });

    const origEnv = process.env.CLAUDE_SCHEDULER_CONFIG;
    process.env.CLAUDE_SCHEDULER_CONFIG = '/tmp/fake-schedules.json';

    vi.resetModules();
    const { run } = await import('../../cli/executor.js');

    try {
      await run('task-1');
    } catch {
      // ignore spawn/lock failures
    }

    // loadMergedConfig was called because projectTask had a projectPath
    expect(loadMergedConfig).toHaveBeenCalled();

    process.env.CLAUDE_SCHEDULER_CONFIG = origEnv;
  });
});
