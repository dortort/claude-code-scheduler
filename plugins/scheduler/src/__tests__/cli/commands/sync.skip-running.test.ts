/**
 * Tests for sync: skip re-registering tasks whose job is currently running.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTask, createEmptyConfig, addTask, type SchedulesConfig } from '../../../index.js';

const configStore = vi.hoisted((): { current: SchedulesConfig | null } => ({ current: null }));

vi.mock('../../../cli/platform.js', () => ({
  registerTask: vi.fn(),
  unregisterTask: vi.fn(),
}));

vi.mock('../../../cli/commands/init.js', () => ({
  ensureExecutorInstalled: vi.fn(),
  getShimPath: vi.fn(),
  resolveClaudeBin: vi.fn(),
}));

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    getGlobalSchedulesPath: vi.fn(),
    getLogsDir: vi.fn(),
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
  };
});

import { sync } from '../../../cli/commands/sync.js';
import * as initMod from '../../../cli/commands/init.js';
import * as configMod from '../../../config.js';

function makeCronTask(name: string) {
  return createTask({
    name,
    trigger: { type: 'cron', expression: '0 7 * * *', timezone: 'UTC' },
    execution: { command: 'echo hi', workingDirectory: '/tmp' },
  });
}

describe('sync: skip tasks with a running job', () => {
  beforeEach(() => {
    configStore.current = createEmptyConfig();
    vi.mocked(initMod.ensureExecutorInstalled).mockResolvedValue({
      success: true,
      executorPath: '/fake/executor',
      shimPath: '/fake/shim',
      cliShimPath: '/fake/cli-shim',
    });
    vi.mocked(initMod.getShimPath).mockReturnValue('/fake/shim');
    vi.mocked(initMod.resolveClaudeBin).mockResolvedValue(undefined);
    vi.mocked(configMod.getGlobalSchedulesPath).mockReturnValue('/fake/config.json');
    vi.mocked(configMod.getLogsDir).mockReturnValue('/tmp');
    vi.mocked(configMod.loadConfig).mockImplementation(async () => configStore.current as SchedulesConfig);
    vi.mocked(configMod.saveConfig).mockImplementation(async (_path, cfg) => {
      configStore.current = cfg as SchedulesConfig;
    });
  });

  it('does not re-register a task whose job is running, and syncs the rest', async () => {
    const running = makeCronTask('running-task');
    const idle = makeCronTask('idle-task');
    configStore.current = addTask(addTask(createEmptyConfig(), running), idle);

    const register = vi.fn().mockResolvedValue(undefined);
    const isTaskRunning = vi.fn(async (taskId: string) => taskId === running.id);

    const result = await sync(register, { isTaskRunning });

    expect(result.success).toBe(true);
    expect(result.synced).toEqual([idle.id]);
    expect(result.skipped).toEqual([running.id]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: idle.id }), '/fake/shim');
    expect(register).not.toHaveBeenCalledWith(expect.objectContaining({ id: running.id }), expect.anything());
  });

  it('registers all tasks when none are running', async () => {
    const a = makeCronTask('a');
    const b = makeCronTask('b');
    configStore.current = addTask(addTask(createEmptyConfig(), a), b);

    const register = vi.fn().mockResolvedValue(undefined);
    const isTaskRunning = vi.fn().mockResolvedValue(false);

    const result = await sync(register, { isTaskRunning });

    expect(result.synced).toEqual([a.id, b.id]);
    expect(result.skipped).toEqual([]);
    expect(register).toHaveBeenCalledTimes(2);
  });
});
