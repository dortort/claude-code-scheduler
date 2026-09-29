/**
 * Tests for add/update command --model and --effort support (issue #7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmptyConfig, EFFORT_LEVELS, type SchedulesConfig } from '../../../index.js';

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
import { update } from '../../../cli/commands/update.js';
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
  vi.mocked(platform.unregisterTask).mockResolvedValue(undefined);
  vi.mocked(initMod.ensureExecutorInstalled).mockResolvedValue({ success: true, shimPath: '/fake/shim' } as unknown as Awaited<ReturnType<typeof initMod.ensureExecutorInstalled>>);
  vi.mocked(initMod.getShimPath).mockReturnValue('/fake/shim');
});

const baseArgs = {
  name: 'triage',
  cron: '0 9 * * *',
  command: 'Triage new issues',
  workingDirectory: '/tmp',
};

function savedTask() {
  return (configStore.current as SchedulesConfig).tasks[0];
}

describe('add command: --model / --effort', () => {
  it('stores model and effort on the task', async () => {
    const result = await add({ ...baseArgs, model: 'sonnet', effort: 'medium' });
    expect(result.success).toBe(true);
    expect(savedTask().execution.model).toBe('sonnet');
    expect(savedTask().execution.effort).toBe('medium');
  });

  it('leaves model and effort unset when not provided', async () => {
    const result = await add(baseArgs);
    expect(result.success).toBe(true);
    expect(savedTask().execution.model).toBeUndefined();
    expect(savedTask().execution.effort).toBeUndefined();
  });

  it('treats a blank --model as unset', async () => {
    const result = await add({ ...baseArgs, model: '   ' });
    expect(result.success).toBe(true);
    expect(savedTask().execution.model).toBeUndefined();
  });

  it.each(EFFORT_LEVELS)('accepts effort level "%s"', async (level) => {
    const result = await add({ ...baseArgs, effort: level });
    expect(result.success).toBe(true);
    expect(savedTask().execution.effort).toBe(level);
  });

  it('rejects an unknown effort level without saving', async () => {
    const result = await add({ ...baseArgs, effort: 'ultra' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid --effort');
    expect(result.error).toContain('low, medium, high, xhigh, max');
    expect((configStore.current as SchedulesConfig).tasks).toHaveLength(0);
    expect(platform.registerTask).not.toHaveBeenCalled();
  });
});

describe('update command: --model / --effort', () => {
  it('sets model and effort on an existing task', async () => {
    await add(baseArgs);
    const { id } = savedTask();

    const result = await update({ id, model: 'opus', effort: 'high' });
    expect(result.success).toBe(true);
    expect(savedTask().execution.model).toBe('opus');
    expect(savedTask().execution.effort).toBe('high');
    // No schedule change, so no OS re-registration
    expect(result.osReregistered).toBe(false);
  });

  it('keeps model and effort when updating unrelated fields', async () => {
    await add({ ...baseArgs, model: 'sonnet', effort: 'low' });
    const { id } = savedTask();

    await update({ id, timeout: 600 });
    expect(savedTask().execution.timeout).toBe(600);
    expect(savedTask().execution.model).toBe('sonnet');
    expect(savedTask().execution.effort).toBe('low');
  });

  it('removes model with --clear-model and leaves effort alone', async () => {
    await add({ ...baseArgs, model: 'sonnet', effort: 'low' });
    const { id } = savedTask();

    const result = await update({ id, clearModel: true });
    expect(result.success).toBe(true);
    expect(savedTask().execution).not.toHaveProperty('model');
    expect(savedTask().execution.effort).toBe('low');
  });

  it('removes effort with --clear-effort and leaves model alone', async () => {
    await add({ ...baseArgs, model: 'sonnet', effort: 'low' });
    const { id } = savedTask();

    const result = await update({ id, clearEffort: true });
    expect(result.success).toBe(true);
    expect(savedTask().execution).not.toHaveProperty('effort');
    expect(savedTask().execution.model).toBe('sonnet');
  });

  it('removes both with --clear-model and --clear-effort together', async () => {
    await add({ ...baseArgs, model: 'sonnet', effort: 'low' });
    const { id } = savedTask();

    const result = await update({ id, clearModel: true, clearEffort: true });
    expect(result.success).toBe(true);
    expect(savedTask().execution).not.toHaveProperty('model');
    expect(savedTask().execution).not.toHaveProperty('effort');
  });

  it('clearing a field that is already unset succeeds', async () => {
    await add(baseArgs);
    const { id } = savedTask();

    const result = await update({ id, clearModel: true, clearEffort: true });
    expect(result.success).toBe(true);
    expect(savedTask().execution).not.toHaveProperty('model');
    expect(savedTask().execution).not.toHaveProperty('effort');
  });

  it('rejects an empty --model and points at --clear-model', async () => {
    await add({ ...baseArgs, model: 'sonnet' });
    const { id } = savedTask();

    const result = await update({ id, model: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('--clear-model');
    expect(savedTask().execution.model).toBe('sonnet');
  });

  it('rejects --model together with --clear-model', async () => {
    await add({ ...baseArgs, model: 'sonnet' });
    const { id } = savedTask();

    const result = await update({ id, model: 'opus', clearModel: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('both --model and --clear-model');
    expect(savedTask().execution.model).toBe('sonnet');
  });

  it('rejects --effort together with --clear-effort', async () => {
    await add({ ...baseArgs, effort: 'low' });
    const { id } = savedTask();

    const result = await update({ id, effort: 'high', clearEffort: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('both --effort and --clear-effort');
    expect(savedTask().execution.effort).toBe('low');
  });

  it('rejects an unknown effort level without saving', async () => {
    await add({ ...baseArgs, effort: 'low' });
    const { id } = savedTask();

    const result = await update({ id, effort: 'maximum' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid --effort');
    expect(savedTask().execution.effort).toBe('low');
  });
});
