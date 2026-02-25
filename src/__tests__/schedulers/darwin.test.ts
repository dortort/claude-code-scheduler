import { describe, it, expect } from 'vitest';
import {
  generatePlist,
  cronToCalendarInterval,
  getPlistPath,
  getLaunchctlLabel,
  type DarwinSchedulerTask,
} from '../../schedulers/darwin.js';

const sampleTask: DarwinSchedulerTask = {
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
};

describe('getLaunchctlLabel', () => {
  it('generates a namespaced label', () => {
    const label = getLaunchctlLabel('daily-review');
    expect(label).toBe('com.claude-scheduler.daily-review');
  });
});

describe('getPlistPath', () => {
  it('returns path in LaunchAgents', () => {
    const plistPath = getPlistPath('daily-review');
    expect(plistPath).toContain('LaunchAgents');
    expect(plistPath).toContain('com.claude-scheduler.daily-review.plist');
  });
});

describe('cronToCalendarInterval', () => {
  it('converts simple daily cron (0 9 * * *)', () => {
    const intervals = cronToCalendarInterval('0 9 * * *');
    expect(intervals).toEqual([{ Hour: 9, Minute: 0 }]);
  });

  it('converts hourly cron (0 * * * *)', () => {
    const intervals = cronToCalendarInterval('0 * * * *');
    expect(intervals).toEqual([{ Minute: 0 }]);
  });

  it('converts weekly cron with day of week (0 10 * * 1)', () => {
    const intervals = cronToCalendarInterval('0 10 * * 1');
    expect(intervals).toEqual([{ Weekday: 1, Hour: 10, Minute: 0 }]);
  });

  it('converts monthly cron (0 0 1 * *)', () => {
    const intervals = cronToCalendarInterval('0 0 1 * *');
    expect(intervals).toEqual([{ Day: 1, Hour: 0, Minute: 0 }]);
  });

  it('handles multi-value minutes with expansion (*/15 * * * *)', () => {
    // Step values must expand to multiple intervals or fall back to StartInterval
    const result = cronToCalendarInterval('*/15 * * * *');
    // Should return null (needs StartInterval fallback) or expanded intervals
    if (result === null) {
      // StartInterval fallback path
      expect(result).toBeNull();
    } else {
      // Expanded to multiple CalendarInterval entries
      expect(result.length).toBe(4); // 0, 15, 30, 45
    }
  });

  it('handles comma-separated values (0 9,17 * * *)', () => {
    const intervals = cronToCalendarInterval('0 9,17 * * *');
    expect(intervals).toHaveLength(2);
    expect(intervals).toContainEqual({ Hour: 9, Minute: 0 });
    expect(intervals).toContainEqual({ Hour: 17, Minute: 0 });
  });

  it('returns null for unsupported complex expressions', () => {
    // Range with step that produces too many entries
    const result = cronToCalendarInterval('*/1 * * * *');
    // Every minute - too many entries, should fall back
    expect(result).toBeNull();
  });
});

describe('generatePlist', () => {
  it('generates valid XML', () => {
    const plist = generatePlist(sampleTask);
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('<plist version="1.0">');
  });

  it('includes the label', () => {
    const plist = generatePlist(sampleTask);
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('com.claude-scheduler.daily-review');
  });

  it('includes the wrapper script path', () => {
    const plist = generatePlist(sampleTask);
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain('/home/user/.claude/logs/daily-review.sh');
  });

  it('includes stdout and stderr log paths', () => {
    const plist = generatePlist(sampleTask);
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain('.out.log');
    expect(plist).toContain('.err.log');
  });

  it('includes CalendarInterval for simple cron', () => {
    const plist = generatePlist(sampleTask);
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toContain('<key>Hour</key>');
    expect(plist).toContain('<integer>9</integer>');
  });

  it('uses StartInterval fallback for high-frequency step values', () => {
    const task: DarwinSchedulerTask = {
      ...sampleTask,
      cronExpression: '*/2 * * * *',
    };
    const plist = generatePlist(task);
    // 30 entries exceeds MAX_CALENDAR_ENTRIES, falls back to StartInterval
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>120</integer>'); // 2 * 60
  });

  it('uses CalendarInterval for low-frequency step values', () => {
    const task: DarwinSchedulerTask = {
      ...sampleTask,
      cronExpression: '*/15 * * * *',
    };
    const plist = generatePlist(task);
    // 4 entries fits in CalendarInterval
    expect(plist).toContain('<key>StartCalendarInterval</key>');
  });

  it('escapes XML special characters in paths', () => {
    const task: DarwinSchedulerTask = {
      ...sampleTask,
      wrapperScriptPath: '/home/user/.claude/logs/task & "test".sh',
    };
    const plist = generatePlist(task);
    expect(plist).toContain('&amp;');
    expect(plist).toContain('&quot;');
  });

  it('generates one-time task plist without CalendarInterval', () => {
    const task: DarwinSchedulerTask = {
      ...sampleTask,
      cronExpression: undefined,
      runAtLoad: true,
    };
    const plist = generatePlist(task);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).not.toContain('StartCalendarInterval');
  });
});
