/**
 * Tests for sync command: handles .done markers for once-tasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, createEmptyConfig, addTask, type SchedulesConfig } from '../../../index.js';

const configStore = vi.hoisted((): { current: SchedulesConfig | null } => ({ current: null }));
const logsDirStore = vi.hoisted((): { current: string } => ({ current: '/tmp' }));

vi.mock('../../../cli/platform.js', () => ({
  registerTask: vi.fn(),
  unregisterTask: vi.fn(),
}));

vi.mock('../../../cli/commands/init.js', () => ({
  ensureExecutorInstalled: vi.fn().mockResolvedValue({ success: true }),
  getShimPath: vi.fn().mockReturnValue('/fake/shim'),
}));

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    getGlobalSchedulesPath: vi.fn().mockReturnValue('/fake/config.json'),
    getLogsDir: vi.fn(() => logsDirStore.current),
    loadConfig: vi.fn(async () => configStore.current),
    saveConfig: vi.fn(async (_path: string, cfg: SchedulesConfig) => {
      configStore.current = cfg;
    }),
  };
});

import { syncOnce } from '../../../cli/commands/sync.js';
import * as platform from '../../../cli/platform.js';
import * as configMod from '../../../config.js';

function makeOnceTask() {
  return createTask({
    name: 'once-test',
    trigger: { type: 'once', timestamp: '2099-06-01T12:00:00Z' },
    execution: { command: 'echo done', workingDirectory: '/tmp' },
  });
}

describe('sync: once-task .done marker handling', () => {
  const tmpDir = path.join(os.tmpdir(), `sync-once-test-${process.pid}`);

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    logsDirStore.current = tmpDir;
    configStore.current = createEmptyConfig();

    vi.mocked(configMod.loadConfig).mockImplementation(async () => configStore.current as SchedulesConfig);
    vi.mocked(configMod.saveConfig).mockImplementation(async (_path, cfg) => {
      configStore.current = cfg as SchedulesConfig;
    });
    vi.mocked(configMod.getGlobalSchedulesPath).mockReturnValue('/fake/config.json');
    vi.mocked(configMod.getLogsDir).mockImplementation(() => logsDirStore.current);
    vi.mocked(platform.unregisterTask).mockResolvedValue(undefined);
    vi.mocked(platform.registerTask).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads .done marker, disables task in config, calls unregisterTask, removes marker', async () => {
    const task = makeOnceTask();
    configStore.current = addTask(createEmptyConfig(), task);

    // Create .done marker
    const doneFile = path.join(tmpDir, `${task.id}.done`);
    await writeFile(doneFile, '', 'utf-8');

    await syncOnce({ configPath: '/fake/config.json', logsDir: tmpDir });

    // Task should be disabled
    const savedConfig = configStore.current as SchedulesConfig;
    const savedTask = savedConfig.tasks.find(t => t.id === task.id);
    expect(savedTask?.enabled).toBe(false);

    // unregisterTask should have been called
    expect(platform.unregisterTask).toHaveBeenCalledWith(task.id);

    // .done file should be removed
    let exists = true;
    try { await stat(doneFile); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it('ignores .done files for tasks not in config', async () => {
    // No tasks in config
    const doneFile = path.join(tmpDir, 'unknown-task-id.done');
    await writeFile(doneFile, '', 'utf-8');

    // Should not throw
    await expect(syncOnce({ configPath: '/fake/config.json', logsDir: tmpDir })).resolves.not.toThrow();
  });
});
