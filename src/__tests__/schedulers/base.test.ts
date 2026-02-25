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
  it('returns path to wrapper script', () => {
    const cmd = getExecutionCommand(sampleTask);
    expect(cmd).toContain('daily-review');
    expect(cmd).toContain('.sh');
  });

  it('uses logsDir as base for wrapper script location', () => {
    const cmd = getExecutionCommand(sampleTask);
    // Wrapper scripts live alongside logs
    expect(cmd).toContain('/home/user/.claude/logs');
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
