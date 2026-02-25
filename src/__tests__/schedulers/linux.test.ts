import { describe, it, expect } from 'vitest';
import {
  generateCrontabLine,
  parseCrontabMarkers,
  buildCrontabContent,
  type LinuxSchedulerTask,
} from '../../schedulers/linux.js';

const sampleTask: LinuxSchedulerTask = {
  id: 'daily-review',
  name: 'Daily Review',
  command: 'Review the latest commits',
  workingDirectory: '/home/user/project',
  timeout: 300,
  skipPermissions: false,
  logsDir: '/home/user/.claude/logs',
  userPath: '/usr/local/bin:/usr/bin:/bin',
  cronExpression: '0 9 * * *',
  wrapperScriptPath: '/home/user/.claude/logs/daily-review.sh',
  timezone: undefined,
};

describe('generateCrontabLine', () => {
  it('generates a crontab entry with cron expression and wrapper path', () => {
    const line = generateCrontabLine(sampleTask);
    expect(line).toContain('0 9 * * *');
    expect(line).toContain('/home/user/.claude/logs/daily-review.sh');
  });

  it('includes marker comments for identification', () => {
    const line = generateCrontabLine(sampleTask);
    expect(line).toContain('# claude-scheduler:daily-review:begin');
    expect(line).toContain('# claude-scheduler:daily-review:end');
  });

  it('includes TZ= prefix when timezone is set', () => {
    const task: LinuxSchedulerTask = {
      ...sampleTask,
      timezone: 'America/New_York',
    };
    const line = generateCrontabLine(task);
    expect(line).toContain('TZ=America/New_York');
  });

  it('does not include TZ= when timezone is undefined', () => {
    const line = generateCrontabLine(sampleTask);
    expect(line).not.toContain('TZ=');
  });

  it('includes PATH in the environment', () => {
    const line = generateCrontabLine(sampleTask);
    expect(line).toContain('PATH=');
    expect(line).toContain('/usr/local/bin:/usr/bin:/bin');
  });
});

describe('parseCrontabMarkers', () => {
  it('extracts task IDs from marker comments', () => {
    const crontab = [
      '# claude-scheduler:task-a:begin',
      '0 9 * * * /path/to/script.sh',
      '# claude-scheduler:task-a:end',
      '',
      '# claude-scheduler:task-b:begin',
      '30 17 * * 5 /other/script.sh',
      '# claude-scheduler:task-b:end',
    ].join('\n');

    const ids = parseCrontabMarkers(crontab);
    expect(ids).toContain('task-a');
    expect(ids).toContain('task-b');
    expect(ids).toHaveLength(2);
  });

  it('returns empty for crontab with no markers', () => {
    const crontab = '0 9 * * * /some/other/job\n';
    const ids = parseCrontabMarkers(crontab);
    expect(ids).toHaveLength(0);
  });
});

describe('buildCrontabContent', () => {
  it('adds a new task entry to empty crontab', () => {
    const result = buildCrontabContent('', sampleTask);
    expect(result).toContain('# claude-scheduler:daily-review:begin');
    expect(result).toContain('0 9 * * *');
    expect(result).toContain('# claude-scheduler:daily-review:end');
  });

  it('preserves existing non-scheduler entries', () => {
    const existing = '0 * * * * /usr/bin/custom-job\n';
    const result = buildCrontabContent(existing, sampleTask);
    expect(result).toContain('/usr/bin/custom-job');
    expect(result).toContain('claude-scheduler:daily-review');
  });

  it('replaces existing entry for the same task ID (idempotent)', () => {
    const existing = [
      '# claude-scheduler:daily-review:begin',
      '0 8 * * * /old/path.sh',
      '# claude-scheduler:daily-review:end',
    ].join('\n');

    const result = buildCrontabContent(existing, sampleTask);
    // Should have the new entry, not the old one
    expect(result).toContain(sampleTask.wrapperScriptPath);
    expect(result).not.toContain('/old/path.sh');
    // Only one begin marker for this task
    const beginCount = (result.match(/claude-scheduler:daily-review:begin/g) || []).length;
    expect(beginCount).toBe(1);
  });

  it('removes a task entry when task is null', () => {
    const existing = [
      '# claude-scheduler:daily-review:begin',
      '0 9 * * * /path/to/script.sh',
      '# claude-scheduler:daily-review:end',
      '0 * * * * /usr/bin/custom-job',
    ].join('\n');

    const result = buildCrontabContent(existing, null, 'daily-review');
    expect(result).not.toContain('claude-scheduler:daily-review');
    expect(result).toContain('/usr/bin/custom-job');
  });
});
