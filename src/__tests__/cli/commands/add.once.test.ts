/**
 * Tests for add command --at (once-trigger) support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmptyConfig, type SchedulesConfig } from '../../../index.js';

const configStore = vi.hoisted((): { current: SchedulesConfig | null } => ({ current: null }));

vi.mock('../../../cli/platform.js', () => ({
  registerTask: vi.fn(),
  unregisterTask: vi.fn(),
}));

vi.mock('../../../cli/commands/init.js', () => ({
  ensureExecutorInstalled: vi.fn().mockResolvedValue({ success: true, shimPath: '/fake/shim' }),
  getShimPath: vi.fn().mockReturnValue('/fake/shim'),
}));

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

import { add } from '../../../cli/commands/add.js';
import * as platform from '../../../cli/platform.js';
import * as configMod from '../../../config.js';
import * as initMod from '../../../cli/commands/init.js';

beforeEach(() => {
  configStore.current = createEmptyConfig();
  vi.mocked(configMod.loadConfig).mockImplementation(async () => configStore.current as SchedulesConfig);
  vi.mocked(configMod.saveConfig).mockImplementation(async (_path, cfg) => {
    configStore.current = cfg as SchedulesConfig;
  });
  vi.mocked(configMod.getGlobalSchedulesPath).mockReturnValue('/fake/config.json');
  vi.mocked(platform.registerTask).mockResolvedValue(undefined);
  vi.mocked(initMod.ensureExecutorInstalled).mockResolvedValue({ success: true, shimPath: '/fake/shim' } as unknown as Awaited<ReturnType<typeof initMod.ensureExecutorInstalled>>);
  vi.mocked(initMod.getShimPath).mockReturnValue('/fake/shim');
});

// A timestamp well in the future
const FUTURE_TS = '2099-04-01T09:00:00Z';

describe('add command: --at once-trigger', () => {
  it('creates a task with trigger.type === "once" when --at is provided', async () => {
    const result = await add({
      name: 'test-once',
      at: FUTURE_TS,
      command: 'echo hi',
      workingDirectory: '/tmp',
    });

    expect(result.success).toBe(true);
    const tasks = (configStore.current as SchedulesConfig).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].trigger.type).toBe('once');
    if (tasks[0].trigger.type === 'once') {
      expect(tasks[0].trigger.timestamp).toBe(FUTURE_TS);
    }
  });

  it('calls registerTask after creating a once task', async () => {
    await add({
      name: 'test-once',
      at: FUTURE_TS,
      command: 'echo hi',
      workingDirectory: '/tmp',
    });

    expect(platform.registerTask).toHaveBeenCalledOnce();
  });

  it('returns error when both --cron and --at are provided', async () => {
    const result = await add({
      name: 'test',
      cron: '0 9 * * *',
      at: FUTURE_TS,
      command: 'echo hi',
      workingDirectory: '/tmp',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot.*both/i);
  });

  it('returns error when neither --cron nor --at is provided', async () => {
    const result = await add({
      name: 'test',
      command: 'echo hi',
      workingDirectory: '/tmp',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/--cron.*--at|--at.*--cron/i);
  });

  it('returns error when --at timestamp is in the past', async () => {
    const result = await add({
      name: 'test',
      at: '2020-01-01T00:00:00Z',
      command: 'echo hi',
      workingDirectory: '/tmp',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/future/i);
  });
});
