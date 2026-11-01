import { describe, it, expect } from 'vitest';
import {
  ScheduledTaskSchema,
  SchedulesConfigSchema,
  ExecutionHistoryRecordSchema,
  TriggerSchema,
  ExecutionConfigSchema,
  createTask,
  createEmptyConfig,
  BLOCKED_ENV_VARS,
} from '../types.js';

describe('TriggerSchema', () => {
  it('accepts cron trigger', () => {
    const trigger = { type: 'cron' as const, expression: '0 9 * * 1-5', timezone: 'local' };
    expect(TriggerSchema.parse(trigger)).toEqual(trigger);
  });

  it('accepts once trigger', () => {
    const trigger = { type: 'once' as const, timestamp: '2026-03-01T09:00:00.000Z', timezone: 'local' };
    expect(TriggerSchema.parse(trigger)).toEqual(trigger);
  });

  it('rejects unknown trigger type', () => {
    const trigger = { type: 'interval', seconds: 60 };
    expect(() => TriggerSchema.parse(trigger)).toThrow();
  });

  it('rejects once trigger with invalid timestamp', () => {
    const trigger = { type: 'once' as const, timestamp: 'not-a-date', timezone: 'local' };
    expect(() => TriggerSchema.parse(trigger)).toThrow();
  });
});

describe('ExecutionConfigSchema', () => {
  const validExecution = {
    command: 'Review the latest commits',
    workingDirectory: '/home/user/project',
    timeout: 300,
    skipPermissions: false,
  };

  it('accepts valid execution config', () => {
    const result = ExecutionConfigSchema.parse(validExecution);
    expect(result.command).toBe('Review the latest commits');
  });

  it('rejects blocked env var PATH', () => {
    expect(() => ExecutionConfigSchema.parse({
      ...validExecution,
      env: { PATH: '/evil/path' },
    })).toThrow();
  });

  it('rejects blocked env var LD_PRELOAD', () => {
    expect(() => ExecutionConfigSchema.parse({
      ...validExecution,
      env: { LD_PRELOAD: '/evil.so' },
    })).toThrow();
  });

  it('rejects blocked env var NODE_OPTIONS', () => {
    expect(() => ExecutionConfigSchema.parse({
      ...validExecution,
      env: { NODE_OPTIONS: '--require /evil.js' },
    })).toThrow();
  });

  it('rejects blocked env var DYLD_INSERT_LIBRARIES', () => {
    expect(() => ExecutionConfigSchema.parse({
      ...validExecution,
      env: { DYLD_INSERT_LIBRARIES: '/evil.dylib' },
    })).toThrow();
  });

  it('accepts safe env vars', () => {
    const result = ExecutionConfigSchema.parse({
      ...validExecution,
      env: { MY_VAR: 'value', GITHUB_TOKEN: 'ghp_xxx' },
    });
    expect(result.env).toEqual({ MY_VAR: 'value', GITHUB_TOKEN: 'ghp_xxx' });
  });

  it('rejects empty command', () => {
    expect(() => ExecutionConfigSchema.parse({
      ...validExecution,
      command: '',
    })).toThrow();
  });

  it('applies default values', () => {
    const result = ExecutionConfigSchema.parse({
      command: 'test',
      workingDirectory: '/tmp',
    });
    expect(result.timeout).toBe(300);
    expect(result.skipPermissions).toBe(false);
  });
});

describe('ScheduledTaskSchema', () => {
  const validTask = {
    id: 'abc123-def456',
    name: 'Daily Review',
    enabled: true,
    trigger: { type: 'cron' as const, expression: '0 9 * * 1-5', timezone: 'local' },
    execution: {
      command: 'Review code',
      workingDirectory: '/home/user/project',
      timeout: 300,
      skipPermissions: false,
    },
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts valid task', () => {
    const result = ScheduledTaskSchema.parse(validTask);
    expect(result.id).toBe('abc123-def456');
  });

  it('rejects task ID with path traversal', () => {
    expect(() => ScheduledTaskSchema.parse({
      ...validTask,
      id: '../../etc/passwd',
    })).toThrow();
  });

  it('rejects task ID with shell metacharacters', () => {
    expect(() => ScheduledTaskSchema.parse({
      ...validTask,
      id: 'task;rm -rf /',
    })).toThrow();
  });

  it('rejects task ID starting with dot', () => {
    expect(() => ScheduledTaskSchema.parse({
      ...validTask,
      id: '.hidden-task',
    })).toThrow();
  });

  it('rejects task ID starting with hyphen', () => {
    expect(() => ScheduledTaskSchema.parse({
      ...validTask,
      id: '-flag-task',
    })).toThrow();
  });

  it('accepts task ID with dots hyphens underscores', () => {
    const result = ScheduledTaskSchema.parse({
      ...validTask,
      id: 'daily-review.v2_final',
    });
    expect(result.id).toBe('daily-review.v2_final');
  });

  it('accepts UUID format task ID', () => {
    const result = ScheduledTaskSchema.parse({
      ...validTask,
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('accepts task with optional description', () => {
    const result = ScheduledTaskSchema.parse({
      ...validTask,
      description: 'A detailed description',
    });
    expect(result.description).toBe('A detailed description');
  });

  it('accepts task with worktree config', () => {
    const result = ScheduledTaskSchema.parse({
      ...validTask,
      execution: {
        ...validTask.execution,
        worktree: {
          enabled: true,
          branchPrefix: 'claude-task/',
          remoteName: 'origin',
        },
      },
    });
    expect(result.execution.worktree?.enabled).toBe(true);
  });
});

describe('ExecutionHistoryRecordSchema', () => {
  const validRecord = {
    id: 'exec-001',
    taskId: 'task-001',
    taskName: 'Daily Review',
    project: '/home/user/project',
    startedAt: '2026-01-01T09:00:00.000Z',
    status: 'success' as const,
    triggeredBy: 'cron',
  };

  it('accepts valid record', () => {
    const result = ExecutionHistoryRecordSchema.parse(validRecord);
    expect(result.status).toBe('success');
  });

  it('accepts all status values', () => {
    for (const status of ['success', 'failure', 'timeout', 'skipped', 'running']) {
      const result = ExecutionHistoryRecordSchema.parse({ ...validRecord, status });
      expect(result.status).toBe(status);
    }
  });

  it('accepts optional fields', () => {
    const result = ExecutionHistoryRecordSchema.parse({
      ...validRecord,
      completedAt: '2026-01-01T09:05:00.000Z',
      duration: 300000,
      output: 'some output',
      error: 'some error',
      exitCode: 0,
      cronExpression: '0 9 * * 1-5',
      worktreePath: '/tmp/worktree',
      worktreeBranch: 'claude-task/daily',
      worktreePushed: true,
    });
    expect(result.duration).toBe(300000);
  });

  it('accepts v0.2.0 session fields', () => {
    const result = ExecutionHistoryRecordSchema.parse({
      ...validRecord,
      sessionId: 'sess_abc123',
      sessionExpiry: '2026-01-04T09:00:00.000Z',
      executedCommand: 'claude -p "review code"',
    });
    expect(result.sessionId).toBe('sess_abc123');
  });

  it('rejects invalid sessionExpiry format', () => {
    expect(() => ExecutionHistoryRecordSchema.parse({
      ...validRecord,
      sessionExpiry: 'not-a-date',
    })).toThrow();
  });
});

describe('SchedulesConfigSchema', () => {
  it('accepts valid config', () => {
    const config = {
      version: 1,
      tasks: [],
    };
    const result = SchedulesConfigSchema.parse(config);
    expect(result.version).toBe(1);
    expect(result.tasks).toEqual([]);
  });

  it('accepts config with settings', () => {
    const config = {
      version: 1,
      tasks: [],
      settings: {
        defaultTimezone: 'America/New_York',
        logRetentionDays: 30,
        maxExecutionHistory: 100,
      },
    };
    const result = SchedulesConfigSchema.parse(config);
    expect(result.settings?.logRetentionDays).toBe(30);
  });

  it('applies default settings', () => {
    const config = { version: 1, tasks: [] };
    const result = SchedulesConfigSchema.parse(config);
    expect(result.settings).toBeUndefined();
  });
});

describe('createTask', () => {
  it('creates a task with generated id and timestamps', () => {
    const task = createTask({
      name: 'Test Task',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'local' },
      execution: {
        command: 'test prompt',
        workingDirectory: '/tmp',
      },
    });
    expect(task.id).toBeDefined();
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.name).toBe('Test Task');
    expect(task.enabled).toBe(true);
    expect(task.tags).toEqual([]);
    expect(task.createdAt).toBeDefined();
    expect(task.updatedAt).toBeDefined();
  });

  it('validates the created task against schema', () => {
    const task = createTask({
      name: 'Test Task',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'local' },
      execution: {
        command: 'test',
        workingDirectory: '/tmp',
      },
    });
    expect(() => ScheduledTaskSchema.parse(task)).not.toThrow();
  });
});

describe('createEmptyConfig', () => {
  it('returns a valid empty config', () => {
    const config = createEmptyConfig();
    expect(config.version).toBe(1);
    expect(config.tasks).toEqual([]);
    expect(() => SchedulesConfigSchema.parse(config)).not.toThrow();
  });
});

describe('BLOCKED_ENV_VARS', () => {
  it('includes critical security-sensitive variables', () => {
    expect(BLOCKED_ENV_VARS).toContain('PATH');
    expect(BLOCKED_ENV_VARS).toContain('HOME');
    expect(BLOCKED_ENV_VARS).toContain('LD_PRELOAD');
    expect(BLOCKED_ENV_VARS).toContain('LD_LIBRARY_PATH');
    expect(BLOCKED_ENV_VARS).toContain('DYLD_LIBRARY_PATH');
    expect(BLOCKED_ENV_VARS).toContain('DYLD_INSERT_LIBRARIES');
    expect(BLOCKED_ENV_VARS).toContain('NODE_OPTIONS');
    expect(BLOCKED_ENV_VARS).toContain('NODE_PATH');
    expect(BLOCKED_ENV_VARS).toContain('PYTHONPATH');
    expect(BLOCKED_ENV_VARS).toContain('USER');
    expect(BLOCKED_ENV_VARS).toContain('SHELL');
  });
});
