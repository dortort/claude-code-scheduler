import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getGlobalSchedulesPath,
  getProjectSchedulesPath,
  getLogsDir,
  getSessionIdPath,
  loadConfig,
  saveConfig,
  loadMergedConfig,
  addTask,
  updateTask,
  removeTask,
  findTask,
} from '../config.js';
import { createTask, createEmptyConfig, type SchedulesConfig, type ScheduledTask } from '../types.js';

let tmpDir: string;

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const base = createTask({
    name: overrides.name ?? 'Test Task',
    trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'local' },
    execution: {
      command: 'test prompt',
      workingDirectory: '/tmp/test',
    },
  });
  return { ...base, ...overrides };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('path functions', () => {
  it('getGlobalSchedulesPath returns ~/.claude/schedules.json', () => {
    const result = getGlobalSchedulesPath();
    expect(result).toContain('.claude');
    expect(result).toContain('schedules.json');
  });

  it('getProjectSchedulesPath returns project/.claude/schedules.json', () => {
    const result = getProjectSchedulesPath('/home/user/project');
    expect(result).toBe('/home/user/project/.claude/schedules.json');
  });

  it('getLogsDir returns ~/.claude/logs', () => {
    const result = getLogsDir();
    expect(result).toContain('.claude');
    expect(result).toContain('logs');
  });

  it('getSessionIdPath returns correct path', () => {
    const result = getSessionIdPath('abc123');
    expect(result).toContain('logs');
    expect(result).toContain('abc123.session');
  });

  it('getSessionIdPath rejects path traversal', () => {
    expect(() => getSessionIdPath('../../../etc/passwd')).toThrow();
  });

  it('getSessionIdPath rejects shell metacharacters', () => {
    expect(() => getSessionIdPath('task;rm -rf /')).toThrow();
  });
});

describe('loadConfig', () => {
  it('loads a valid config file', async () => {
    const configPath = path.join(tmpDir, 'schedules.json');
    const config: SchedulesConfig = { version: 1, tasks: [] };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await loadConfig(configPath);
    expect(result.version).toBe(1);
    expect(result.tasks).toEqual([]);
  });

  it('returns empty config on missing file', async () => {
    const configPath = path.join(tmpDir, 'nonexistent.json');
    const result = await loadConfig(configPath);
    expect(result.version).toBe(1);
    expect(result.tasks).toEqual([]);
  });

  it('returns empty config on corrupt JSON', async () => {
    const configPath = path.join(tmpDir, 'bad.json');
    await fs.writeFile(configPath, 'not json at all {{{');

    const result = await loadConfig(configPath);
    expect(result.version).toBe(1);
    expect(result.tasks).toEqual([]);
  });

  it('returns empty config on invalid schema', async () => {
    const configPath = path.join(tmpDir, 'invalid.json');
    await fs.writeFile(configPath, JSON.stringify({ version: 999, tasks: 'not-array' }));

    const result = await loadConfig(configPath);
    expect(result.version).toBe(1);
    expect(result.tasks).toEqual([]);
  });

  it('loads config with tasks', async () => {
    const task = makeTask();
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    const configPath = path.join(tmpDir, 'schedules.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await loadConfig(configPath);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].name).toBe('Test Task');
  });
});

describe('saveConfig', () => {
  it('saves a valid config', async () => {
    const configPath = path.join(tmpDir, 'schedules.json');
    const config: SchedulesConfig = { version: 1, tasks: [] };

    await saveConfig(configPath, config);

    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
  });

  it('creates parent directories if needed', async () => {
    const configPath = path.join(tmpDir, 'deep', 'nested', 'schedules.json');
    const config: SchedulesConfig = { version: 1, tasks: [] };

    await saveConfig(configPath, config);

    const raw = await fs.readFile(configPath, 'utf-8');
    expect(JSON.parse(raw).version).toBe(1);
  });

  it('validates before writing', async () => {
    const configPath = path.join(tmpDir, 'schedules.json');
    const badConfig = { version: 999, tasks: [] } as unknown as SchedulesConfig;

    await expect(saveConfig(configPath, badConfig)).rejects.toThrow();
  });
});

describe('addTask', () => {
  it('adds a task to config', () => {
    const config = createEmptyConfig();
    const task = makeTask();
    const result = addTask(config, task);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe(task.id);
  });

  it('throws on duplicate task ID', () => {
    const task = makeTask();
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    expect(() => addTask(config, task)).toThrow(/duplicate/i);
  });

  it('does not mutate original config', () => {
    const config = createEmptyConfig();
    const task = makeTask();
    addTask(config, task);
    expect(config.tasks).toHaveLength(0);
  });
});

describe('updateTask', () => {
  it('updates task fields', () => {
    const task = makeTask();
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    const result = updateTask(config, task.id, { name: 'Updated Name' });
    expect(result.tasks[0].name).toBe('Updated Name');
  });

  it('auto-updates updatedAt', () => {
    const task = makeTask();
    // Force an old timestamp so the update is guaranteed to differ
    task.updatedAt = '2020-01-01T00:00:00.000Z';
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    const result = updateTask(config, task.id, { name: 'Updated' });
    expect(result.tasks[0].updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('throws on nonexistent task', () => {
    const config = createEmptyConfig();
    expect(() => updateTask(config, 'nonexistent', { name: 'x' })).toThrow(/not found/i);
  });

  it('does not mutate original config', () => {
    const task = makeTask();
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    updateTask(config, task.id, { name: 'Updated' });
    expect(config.tasks[0].name).toBe('Test Task');
  });
});

describe('removeTask', () => {
  it('removes a task by ID', () => {
    const task = makeTask();
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    const result = removeTask(config, task.id);
    expect(result.tasks).toHaveLength(0);
  });

  it('throws on nonexistent task', () => {
    const config = createEmptyConfig();
    expect(() => removeTask(config, 'nonexistent')).toThrow(/not found/i);
  });

  it('does not mutate original config', () => {
    const task = makeTask();
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    removeTask(config, task.id);
    expect(config.tasks).toHaveLength(1);
  });
});

describe('findTask', () => {
  it('finds task by exact ID', () => {
    const task = makeTask({ name: 'My Task' });
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    const found = findTask(config, task.id);
    expect(found?.name).toBe('My Task');
  });

  it('finds task by name (case-insensitive)', () => {
    const task = makeTask({ name: 'Daily Review' });
    const config: SchedulesConfig = { version: 1, tasks: [task] };
    const found = findTask(config, 'daily review');
    expect(found?.id).toBe(task.id);
  });

  it('returns undefined for no match', () => {
    const config = createEmptyConfig();
    expect(findTask(config, 'nonexistent')).toBeUndefined();
  });

  it('prefers ID match over name match', () => {
    const task1 = makeTask({ name: 'abc123' });
    const task2 = makeTask({ name: 'Other' });
    // If task2's ID happens to match the search term and task1's name also matches
    const config: SchedulesConfig = { version: 1, tasks: [task1, task2] };
    const found = findTask(config, task2.id);
    expect(found?.id).toBe(task2.id);
  });
});

describe('loadMergedConfig', () => {
  it('returns global tasks when no project config', async () => {
    const globalDir = path.join(tmpDir, 'global');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(path.join(globalDir, '.claude'), { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });

    const task = makeTask({ name: 'Global Task' });
    await fs.writeFile(
      path.join(globalDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [task] }),
    );

    const result = await loadMergedConfig(projectDir, path.join(globalDir, '.claude', 'schedules.json'));
    expect(result.merged.tasks).toHaveLength(1);
    expect(result.merged.tasks[0].name).toBe('Global Task');
  });

  it('merges global and project tasks', async () => {
    const globalDir = path.join(tmpDir, 'global');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(path.join(globalDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });

    const globalTask = makeTask({ name: 'Global Task' });
    const projectTask = makeTask({ name: 'Project Task' });

    await fs.writeFile(
      path.join(globalDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [globalTask] }),
    );
    await fs.writeFile(
      path.join(projectDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [projectTask] }),
    );

    const result = await loadMergedConfig(projectDir, path.join(globalDir, '.claude', 'schedules.json'));
    expect(result.merged.tasks).toHaveLength(2);
  });

  it('global wins on ID collision', async () => {
    const globalDir = path.join(tmpDir, 'global');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(path.join(globalDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });

    const sharedId = 'shared-task-id';
    const globalTask = makeTask({ id: sharedId, name: 'Global Version' });
    const projectTask = makeTask({ id: sharedId, name: 'Project Version' });

    await fs.writeFile(
      path.join(globalDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [globalTask] }),
    );
    await fs.writeFile(
      path.join(projectDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [projectTask] }),
    );

    const result = await loadMergedConfig(projectDir, path.join(globalDir, '.claude', 'schedules.json'));
    expect(result.merged.tasks).toHaveLength(1);
    expect(result.merged.tasks[0].name).toBe('Global Version');
  });

  it('strips skipPermissions from project tasks', async () => {
    const globalDir = path.join(tmpDir, 'global');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(path.join(globalDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });

    const projectTask = makeTask({ name: 'Sneaky Task' });
    projectTask.execution.skipPermissions = true;

    await fs.writeFile(
      path.join(globalDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [] }),
    );
    await fs.writeFile(
      path.join(projectDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [projectTask] }),
    );

    const result = await loadMergedConfig(projectDir, path.join(globalDir, '.claude', 'schedules.json'));
    const found = result.merged.tasks.find(t => t.name === 'Sneaky Task');
    expect(found?.execution.skipPermissions).toBe(false);
  });

  it('preserves skipPermissions in global tasks', async () => {
    const globalDir = path.join(tmpDir, 'global');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(path.join(globalDir, '.claude'), { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });

    const globalTask = makeTask({ name: 'Trusted Task' });
    globalTask.execution.skipPermissions = true;

    await fs.writeFile(
      path.join(globalDir, '.claude', 'schedules.json'),
      JSON.stringify({ version: 1, tasks: [globalTask] }),
    );

    const result = await loadMergedConfig(projectDir, path.join(globalDir, '.claude', 'schedules.json'));
    expect(result.merged.tasks[0].execution.skipPermissions).toBe(true);
  });
});
