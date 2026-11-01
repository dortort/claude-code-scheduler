import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  ScheduledTaskSchemaStrict,
  SchedulesConfigSchemaStrict,
  createTask,
} from '../types.js';

const validTask = {
  id: 'task-1',
  name: 'Test Task',
  enabled: true,
  trigger: { type: 'cron' as const, expression: '0 9 * * *', timezone: 'local' },
  execution: {
    command: 'echo hello',
    workingDirectory: '/tmp/test',
    timeout: 300,
    skipPermissions: false,
  },
  tags: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('ScheduledTaskSchemaStrict', () => {
  it('accepts valid cron expression and absolute path', () => {
    expect(() => ScheduledTaskSchemaStrict.parse(validTask)).not.toThrow();
  });

  it('rejects invalid cron expression', () => {
    const task = {
      ...validTask,
      trigger: { type: 'cron' as const, expression: 'not-a-cron', timezone: 'local' },
    };
    expect(() => ScheduledTaskSchemaStrict.parse(task)).toThrow(ZodError);
  });

  it('rejects relative workingDirectory', () => {
    const task = {
      ...validTask,
      execution: { ...validTask.execution, workingDirectory: './relative/path' },
    };
    expect(() => ScheduledTaskSchemaStrict.parse(task)).toThrow(ZodError);
  });

  it('rejects bare relative workingDirectory', () => {
    const task = {
      ...validTask,
      execution: { ...validTask.execution, workingDirectory: 'relative' },
    };
    expect(() => ScheduledTaskSchemaStrict.parse(task)).toThrow(ZodError);
  });
});

describe('SchedulesConfigSchemaStrict', () => {
  it('accepts valid config', () => {
    const config = { version: 1 as const, tasks: [validTask] };
    expect(() => SchedulesConfigSchemaStrict.parse(config)).not.toThrow();
  });

  it('rejects config with invalid cron expression', () => {
    const config = {
      version: 1 as const,
      tasks: [{
        ...validTask,
        trigger: { type: 'cron' as const, expression: 'bad-cron', timezone: 'local' },
      }],
    };
    expect(() => SchedulesConfigSchemaStrict.parse(config)).toThrow(ZodError);
  });
});

describe('createTask() strict validation', () => {
  it('throws ZodError for invalid cron expression', () => {
    expect(() => createTask({
      name: 'Test',
      trigger: { type: 'cron', expression: 'not-a-cron', timezone: 'local' },
      execution: { command: 'echo hi', workingDirectory: '/tmp/test' },
    })).toThrow(ZodError);
  });

  it('throws ZodError for relative workingDirectory', () => {
    expect(() => createTask({
      name: 'Test',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'local' },
      execution: { command: 'echo hi', workingDirectory: './relative' },
    })).toThrow(ZodError);
  });

  it('succeeds with valid cron and absolute path', () => {
    expect(() => createTask({
      name: 'Test',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'local' },
      execution: { command: 'echo hi', workingDirectory: '/tmp/test' },
    })).not.toThrow();
  });

  it('succeeds with once trigger (no cron validation)', () => {
    expect(() => createTask({
      name: 'Test',
      trigger: { type: 'once', timestamp: '2030-01-01T00:00:00.000Z', timezone: 'local' },
      execution: { command: 'echo hi', workingDirectory: '/tmp/test' },
    })).not.toThrow();
  });
});
