import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig } from '../config.js';
import { createEmptyConfig } from '../types.js';
import { ZodError } from 'zod';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-lenient-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadConfig lenient schema', () => {
  it('loads config with edge-case cron expression successfully', async () => {
    // An unusual but potentially parseable expression — loadConfig should NOT wipe it
    const configPath = path.join(tmpDir, 'schedules.json');
    const rawConfig = {
      version: 1,
      tasks: [{
        id: 'task-edge',
        name: 'Edge Task',
        enabled: true,
        trigger: { type: 'cron', expression: '@yearly', timezone: 'local' },
        execution: {
          command: 'echo hi',
          workingDirectory: '/tmp/test',
          timeout: 300,
          skipPermissions: false,
        },
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    await fs.writeFile(configPath, JSON.stringify(rawConfig));
    const config = await loadConfig(configPath);
    // Lenient schema: does NOT reject non-standard cron expressions
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].id).toBe('task-edge');
  });

  it('loads config with relative workingDirectory successfully', async () => {
    const configPath = path.join(tmpDir, 'schedules.json');
    const rawConfig = {
      version: 1,
      tasks: [{
        id: 'task-rel',
        name: 'Relative Task',
        enabled: true,
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'local' },
        execution: {
          command: 'echo hi',
          workingDirectory: './relative/path',
          timeout: 300,
          skipPermissions: false,
        },
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    await fs.writeFile(configPath, JSON.stringify(rawConfig));
    const config = await loadConfig(configPath);
    // Lenient schema: does NOT reject relative paths
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].execution.workingDirectory).toBe('./relative/path');
  });

  it('returns empty config for structurally invalid JSON', async () => {
    const configPath = path.join(tmpDir, 'schedules.json');
    await fs.writeFile(configPath, 'not valid json {{{');
    const config = await loadConfig(configPath);
    expect(config).toEqual(createEmptyConfig());
  });

  it('returns empty config for missing file', async () => {
    const configPath = path.join(tmpDir, 'nonexistent.json');
    const config = await loadConfig(configPath);
    expect(config).toEqual(createEmptyConfig());
  });
});

describe('saveConfig strict schema', () => {
  it('throws ZodError for invalid cron expression', async () => {
    const configPath = path.join(tmpDir, 'schedules.json');
    const config = {
      version: 1 as const,
      tasks: [{
        id: 'task-bad',
        name: 'Bad Task',
        enabled: true,
        trigger: { type: 'cron' as const, expression: 'not-a-cron', timezone: 'local' },
        execution: {
          command: 'echo hi',
          workingDirectory: '/tmp/test',
          timeout: 300,
          skipPermissions: false,
        },
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    };
    await expect(saveConfig(configPath, config)).rejects.toThrow(ZodError);
  });

  it('saves valid config successfully', async () => {
    const configPath = path.join(tmpDir, 'schedules.json');
    const config = createEmptyConfig();
    await expect(saveConfig(configPath, config)).resolves.toBeUndefined();
  });
});
