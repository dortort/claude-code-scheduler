import { describe, it, expect, vi } from 'vitest';
import {
  generatePlist,
  cronToCalendarInterval,
  getPlistPath,
  getLaunchctlLabel,
  adjustCalendarIntervalsForTimezone,
  computeTimezoneOffsetMinutes,
  type DarwinSchedulerTask,
  type CalendarInterval,
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

  it('generates identical plist when timezone is undefined (regression guard)', () => {
    const withoutTz = generatePlist(sampleTask);
    const withLocalTz: DarwinSchedulerTask = { ...sampleTask, timezone: undefined };
    const withLocal = generatePlist(withLocalTz);
    expect(withoutTz).toBe(withLocal);
  });
});

describe('computeTimezoneOffsetMinutes', () => {
  it('returns a number', () => {
    const offset = computeTimezoneOffsetMinutes('America/New_York');
    expect(typeof offset).toBe('number');
  });

  it('returns 0 for same timezone as system local', () => {
    // Get the system timezone via Intl
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = computeTimezoneOffsetMinutes(systemTz);
    expect(offset).toBe(0);
  });

  it('produces consistent relative offsets between two timezones', () => {
    // Tokyo is UTC+9 (no DST), NY is UTC-5 (EST) or UTC-4 (EDT).
    // Tokyo is 13h (EDT) or 14h (EST) ahead of NY.
    // computeTimezoneOffsetMinutes returns (local - target).
    // (local - NY) - (local - Tokyo) = Tokyo - NY = 13*60 or 14*60
    const toTokyo = computeTimezoneOffsetMinutes('Asia/Tokyo');
    const toNY = computeTimezoneOffsetMinutes('America/New_York');
    const tokyoAheadOfNY = toNY - toTokyo;
    expect(tokyoAheadOfNY).toBeGreaterThanOrEqual(13 * 60);
    expect(tokyoAheadOfNY).toBeLessThanOrEqual(14 * 60);
  });

  it('stays correct when the instant straddles a month boundary (regression)', () => {
    // At 2026-07-31T23:30Z it is still Jul 31 in UTC/NY but already Aug 1 in Tokyo,
    // so a day-of-month-only calc jumps 31 -> 1 and injects a ~30-day error.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T23:30:00Z'));
    try {
      const toTokyo = computeTimezoneOffsetMinutes('Asia/Tokyo');
      const toNY = computeTimezoneOffsetMinutes('America/New_York');
      const tokyoAheadOfNY = toNY - toTokyo;
      expect(tokyoAheadOfNY).toBeGreaterThanOrEqual(13 * 60);
      expect(tokyoAheadOfNY).toBeLessThanOrEqual(14 * 60);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('adjustCalendarIntervalsForTimezone', () => {
  it('returns intervals unchanged when offset is 0', () => {
    const intervals: CalendarInterval[] = [{ Hour: 9, Minute: 0 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, 0);
    expect(result.intervals).toEqual([{ Hour: 9, Minute: 0 }]);
    expect(result.crossesDayBoundary).toBe(false);
  });

  it('adjusts hours forward with positive offset (no wrap)', () => {
    const intervals: CalendarInterval[] = [{ Hour: 9, Minute: 0 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, 300); // +5 hours
    expect(result.intervals).toEqual([{ Hour: 14, Minute: 0 }]);
    expect(result.crossesDayBoundary).toBe(false);
  });

  it('adjusts hours backward with negative offset (no wrap)', () => {
    const intervals: CalendarInterval[] = [{ Hour: 14, Minute: 0 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, -300); // -5 hours
    expect(result.intervals).toEqual([{ Hour: 9, Minute: 0 }]);
    expect(result.crossesDayBoundary).toBe(false);
  });

  it('wraps hour forward past 23 and adjusts Weekday', () => {
    const intervals: CalendarInterval[] = [{ Hour: 23, Minute: 0, Weekday: 1 }]; // Monday 23:00
    const result = adjustCalendarIntervalsForTimezone(intervals, 300); // +5 hours
    expect(result.intervals).toEqual([{ Hour: 4, Minute: 0, Weekday: 2 }]); // Tuesday 04:00
    expect(result.crossesDayBoundary).toBe(false);
  });

  it('wraps hour backward below 0 and adjusts Weekday', () => {
    const intervals: CalendarInterval[] = [{ Hour: 1, Minute: 0, Weekday: 0 }]; // Sunday 01:00
    const result = adjustCalendarIntervalsForTimezone(intervals, -300); // -5 hours
    expect(result.intervals).toEqual([{ Hour: 20, Minute: 0, Weekday: 6 }]); // Saturday 20:00
    expect(result.crossesDayBoundary).toBe(false);
  });

  it('wraps Weekday from Saturday forward to Sunday', () => {
    const intervals: CalendarInterval[] = [{ Hour: 23, Minute: 0, Weekday: 6 }]; // Saturday 23:00
    const result = adjustCalendarIntervalsForTimezone(intervals, 120); // +2 hours
    expect(result.intervals).toEqual([{ Hour: 1, Minute: 0, Weekday: 0 }]); // Sunday 01:00
  });

  it('handles fractional offset (India +5:30)', () => {
    const intervals: CalendarInterval[] = [{ Hour: 9, Minute: 0 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, 330); // +5h30m
    expect(result.intervals).toEqual([{ Hour: 14, Minute: 30 }]);
  });

  it('handles minute overflow from fractional offset', () => {
    const intervals: CalendarInterval[] = [{ Hour: 9, Minute: 45 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, 330); // +5h30m
    // 45 + 30 = 75 → Minute: 15, hourCarry: 1 → 9 + 5 + 1 = 15
    expect(result.intervals).toEqual([{ Hour: 15, Minute: 15 }]);
  });

  it('sets crossesDayBoundary when Day field wraps forward', () => {
    const intervals: CalendarInterval[] = [{ Hour: 23, Minute: 0, Day: 15 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, 300); // +5 hours
    expect(result.intervals).toEqual([{ Hour: 4, Minute: 0, Day: 16 }]);
    expect(result.crossesDayBoundary).toBe(true);
  });

  it('clamps Day to 28 and adjusts Month when Day wraps below 1', () => {
    const intervals: CalendarInterval[] = [{ Hour: 1, Minute: 0, Day: 1, Month: 3 }]; // Mar 1 01:00
    const result = adjustCalendarIntervalsForTimezone(intervals, -300); // -5 hours
    expect(result.intervals).toEqual([{ Hour: 20, Minute: 0, Day: 28, Month: 2 }]); // Feb 28 20:00
    expect(result.crossesDayBoundary).toBe(true);
  });

  it('wraps Month from January to December when Day wraps below 1', () => {
    const intervals: CalendarInterval[] = [{ Hour: 1, Minute: 0, Day: 1, Month: 1 }]; // Jan 1 01:00
    const result = adjustCalendarIntervalsForTimezone(intervals, -300); // -5 hours
    expect(result.intervals).toEqual([{ Hour: 20, Minute: 0, Day: 28, Month: 12 }]); // Dec 28 20:00
    expect(result.crossesDayBoundary).toBe(true);
  });

  it('wraps Day forward past 28 and adjusts Month', () => {
    const intervals: CalendarInterval[] = [{ Hour: 23, Minute: 0, Day: 28, Month: 2 }]; // Feb 28 23:00
    const result = adjustCalendarIntervalsForTimezone(intervals, 300); // +5 hours
    expect(result.intervals).toEqual([{ Hour: 4, Minute: 0, Day: 1, Month: 3 }]); // Mar 1 04:00
    expect(result.crossesDayBoundary).toBe(true);
  });

  it('wraps Month from December to January when Day wraps forward', () => {
    const intervals: CalendarInterval[] = [{ Hour: 23, Minute: 0, Day: 28, Month: 12 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, 300);
    expect(result.intervals).toEqual([{ Hour: 4, Minute: 0, Day: 1, Month: 1 }]);
    expect(result.crossesDayBoundary).toBe(true);
  });

  it('does not set crossesDayBoundary for Weekday-only wrap (no Day)', () => {
    const intervals: CalendarInterval[] = [{ Hour: 23, Minute: 0, Weekday: 3 }];
    const result = adjustCalendarIntervalsForTimezone(intervals, 120);
    expect(result.crossesDayBoundary).toBe(false);
  });

  it('adjusts multiple intervals independently', () => {
    const intervals: CalendarInterval[] = [
      { Hour: 9, Minute: 0 },
      { Hour: 17, Minute: 0 },
    ];
    const result = adjustCalendarIntervalsForTimezone(intervals, 300);
    expect(result.intervals).toEqual([
      { Hour: 14, Minute: 0 },
      { Hour: 22, Minute: 0 },
    ]);
  });
});
