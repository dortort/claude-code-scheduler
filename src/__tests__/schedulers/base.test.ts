import { describe, it, expect } from 'vitest';
import {
  getExecutionCommand,
  getCronExpression,
  type SchedulerTask,
} from '../../schedulers/base.js';

const sampleTask: SchedulerTask = {
  id: 'daily-review',
  name: 'Daily Review',
  command: 'Review the latest commits',
  workingDirectory: '/home/user/project',
  timeout: 300,
  skipPermissions: false,
  logsDir: '/home/user/.claude/logs',
  userPath: '/usr/local/bin:/usr/bin:/bin',
  cronExpression: '0 9 * * *',
};

describe('getExecutionCommand', () => {
  it('returns shared executor shim path with task ID', () => {
    const cmd = getExecutionCommand(sampleTask);
    expect(cmd).toContain('daily-review');
    expect(cmd).toContain('claude-scheduler-run');
  });

  it('uses ~/.claude/bin/ as base for executor location', () => {
    const cmd = getExecutionCommand(sampleTask);
    expect(cmd).toContain('.claude/bin/claude-scheduler-run');
  });
});

describe('getCronExpression', () => {
  it('returns cron expression for cron tasks', () => {
    const expr = getCronExpression(sampleTask);
    expect(expr).toBe('0 9 * * *');
  });

  it('returns undefined for tasks without cron', () => {
    const task: SchedulerTask = { ...sampleTask, cronExpression: undefined };
    const expr = getCronExpression(task);
    expect(expr).toBeUndefined();
  });
});
