/**
 * Tests for update command enable/disable OS scheduler sync.
 * enable=false  → unregisterTask (not registerTask)
 * enable=true   → registerTask (not unregisterTask)
 * cron-only     → registerTask (existing behavior)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTask, createEmptyConfig, addTask, type SchedulesConfig } from '../../../index.js';

// Hoist config store so it's accessible in mock factories (vi.mock is hoisted)
const configStore = vi.hoisted((): { current: SchedulesConfig | null } => ({ current: null }));

// Mock platform to intercept register/unregister calls
vi.mock('../../../cli/platform.js', () => ({
  registerTask: vi.fn(),
  unregisterTask: vi.fn(),
}));

// Mock init to avoid shimPath FS lookups
vi.mock('../../../cli/commands/init.js', () => ({
  getShimPath: vi.fn().mockReturnValue('/fake/shim'),
}));

// Mock config module — use configStore for in-memory state
vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    getGlobalSchedulesPath: vi.fn().mockReturnValue('/fake/config.json'),
    loadConfig: vi.fn(async () => configStore.current),
    saveConfig: vi.fn(async (_path: string, cfg: SchedulesConfig) => {
      configStore.current = cfg;
    }),
  };
});

import { update } from '../../../cli/commands/update.js';
import * as platform from '../../../cli/platform.js';
import * as configMod from '../../../config.js';

function makeTask(enabled = true) {
  return createTask({
    name: 'test-task',
    trigger: { type: 'cron', expression: '0 9 * * *' },
    execution: { command: 'Do stuff', workingDirectory: '/tmp' },
    enabled,
  });
}

beforeEach(() => {
  // Reset config store
  configStore.current = createEmptyConfig();

  // Re-apply mock implementations since restoreMocks:true resets them each test
  vi.mocked(configMod.loadConfig).mockImplementation(async () => configStore.current as SchedulesConfig);
  vi.mocked(configMod.saveConfig).mockImplementation(async (_path, cfg) => {
    configStore.current = cfg as SchedulesConfig;
  });
  vi.mocked(configMod.getGlobalSchedulesPath).mockReturnValue('/fake/config.json');
  vi.mocked(platform.registerTask).mockResolvedValue(undefined);
  vi.mocked(platform.unregisterTask).mockResolvedValue(undefined);
});

describe('update command: enable/disable OS scheduler sync', () => {
  it('disable: enabled=false calls unregisterTask, not registerTask', async () => {
    const task = makeTask(true);
    configStore.current = addTask(createEmptyConfig(), task);

    const result = await update({ id: task.id, enabled: false });

    expect(result.success).toBe(true);
    expect(platform.unregisterTask).toHaveBeenCalledOnce();
    expect(platform.unregisterTask).toHaveBeenCalledWith(task.id);
    expect(platform.registerTask).not.toHaveBeenCalled();
    expect(result.osReregistered).toBe(true);
  });

  it('enable: enabled=true calls registerTask, not unregisterTask', async () => {
    const task = makeTask(false);
    configStore.current = addTask(createEmptyConfig(), task);

    const result = await update({ id: task.id, enabled: true });

    expect(result.success).toBe(true);
    expect(platform.registerTask).toHaveBeenCalledOnce();
    expect(platform.unregisterTask).not.toHaveBeenCalled();
    expect(result.osReregistered).toBe(true);
  });

  it('disable then enable: task is re-registered on the second update', async () => {
    const task = makeTask(true);
    configStore.current = addTask(createEmptyConfig(), task);

    await update({ id: task.id, enabled: false });
    expect(platform.unregisterTask).toHaveBeenCalledOnce();
    expect(platform.registerTask).not.toHaveBeenCalled();

    vi.clearAllMocks();
    // Re-apply after clearAllMocks
    vi.mocked(platform.registerTask).mockResolvedValue(undefined);
    vi.mocked(platform.unregisterTask).mockResolvedValue(undefined);

    await update({ id: task.id, enabled: true });
    expect(platform.registerTask).toHaveBeenCalledOnce();
    expect(platform.unregisterTask).not.toHaveBeenCalled();
  });

  it('disable already-disabled: idempotent, unregisterTask called without error', async () => {
    const task = makeTask(false);
    configStore.current = addTask(createEmptyConfig(), task);

    const result = await update({ id: task.id, enabled: false });

    expect(result.success).toBe(true);
    expect(platform.unregisterTask).toHaveBeenCalledOnce();
    expect(platform.registerTask).not.toHaveBeenCalled();
  });

  it('enable with schedule change: enabled=true + cron change → single registerTask call', async () => {
    const task = makeTask(false);
    configStore.current = addTask(createEmptyConfig(), task);

    const result = await update({ id: task.id, enabled: true, cron: '0 10 * * *' });

    expect(result.success).toBe(true);
    expect(platform.registerTask).toHaveBeenCalledOnce();
    expect(platform.unregisterTask).not.toHaveBeenCalled();
  });

  it('disable with schedule change: enabled=false + cron change → unregisterTask called (disable takes priority)', async () => {
    const task = makeTask(true);
    configStore.current = addTask(createEmptyConfig(), task);

    const result = await update({ id: task.id, enabled: false, cron: '0 10 * * *' });

    expect(result.success).toBe(true);
    expect(platform.unregisterTask).toHaveBeenCalledOnce();
    expect(platform.registerTask).not.toHaveBeenCalled();
  });
});
