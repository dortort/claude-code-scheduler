/**
 * macOS (launchd) scheduler implementation.
 * Generates plist files and manages launchctl registration.
 */

import path from 'node:path';
import os from 'node:os';
import type { SchedulerTask } from './base.js';

export interface DarwinSchedulerTask extends SchedulerTask {
  wrapperScriptPath: string;
  programArgs?: string[];
  runAtLoad?: boolean;
  timezone?: string;
}

export interface CalendarInterval {
  Month?: number;
  Day?: number;
  Weekday?: number;
  Hour?: number;
  Minute?: number;
}

export const LABEL_PREFIX = 'com.claude-scheduler';

export interface AdjustResult {
  intervals: CalendarInterval[];
  crossesDayBoundary: boolean;
}

/**
 * Compute the offset in minutes to convert a wall-clock time in `targetTz`
 * to the equivalent wall-clock time in the system-local timezone.
 *
 * Positive result means system-local is ahead of targetTz
 * (e.g. target=America/New_York, system=UTC → +300 during EST).
 */
export function computeTimezoneOffsetMinutes(targetTz: string): number {
  const now = new Date();

  // Extract full date+time parts to account for day boundaries
  const fmt = (tz?: string) => new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    ...(tz ? { timeZone: tz } : {}),
  });

  const toMinutesSinceEpochDay = (parts: Intl.DateTimeFormatPart[]) => {
    const day = parseInt(parts.find(p => p.type === 'day')!.value, 10);
    const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    return day * 1440 + h * 60 + m;
  };

  const localMinutes = toMinutesSinceEpochDay(fmt().formatToParts(now));
  const targetMinutes = toMinutesSinceEpochDay(fmt(targetTz).formatToParts(now));

  return localMinutes - targetMinutes;
}

/**
 * Adjust CalendarInterval entries by a timezone offset in minutes.
 * Returns the adjusted intervals and a flag indicating if any interval
 * with a Day field required a day-boundary crossing.
 */
export function adjustCalendarIntervalsForTimezone(
  intervals: CalendarInterval[],
  offsetMinutes: number,
): AdjustResult {
  if (offsetMinutes === 0) return { intervals, crossesDayBoundary: false };

  let crossesDayBoundary = false;

  const adjusted = intervals.map(interval => {
    const result: CalendarInterval = { ...interval };

    // Adjust minutes
    const currentMinute = result.Minute ?? 0;
    const totalMinutes = currentMinute + (offsetMinutes % 60);
    let hourCarry = 0;

    if (totalMinutes >= 60) {
      result.Minute = totalMinutes - 60;
      hourCarry = 1;
    } else if (totalMinutes < 0) {
      result.Minute = totalMinutes + 60;
      hourCarry = -1;
    } else {
      result.Minute = totalMinutes;
    }

    // Only set Minute if original had it
    if (interval.Minute === undefined) delete result.Minute;

    // Adjust hours
    const hourOffset = Math.trunc(offsetMinutes / 60) + hourCarry;
    if (result.Hour !== undefined) {
      const newHour = result.Hour + hourOffset;
      let dayDelta = 0;

      if (newHour >= 24) {
        result.Hour = newHour - 24;
        dayDelta = 1;
      } else if (newHour < 0) {
        result.Hour = newHour + 24;
        dayDelta = -1;
      } else {
        result.Hour = newHour;
      }

      if (dayDelta !== 0) {
        // Adjust Weekday if present
        if (result.Weekday !== undefined) {
          result.Weekday = ((result.Weekday + dayDelta) % 7 + 7) % 7;
        }

        // Adjust Day if present — this is approximate for day-of-month schedules
        if (result.Day !== undefined) {
          crossesDayBoundary = true;
          const newDay = result.Day + dayDelta;
          if (newDay < 1) {
            // Wrap to previous month
            result.Day = 28;
            if (result.Month !== undefined) {
              result.Month = result.Month === 1 ? 12 : result.Month - 1;
            }
          } else if (newDay > 28) {
            // Wrap to next month
            result.Day = 1;
            if (result.Month !== undefined) {
              result.Month = result.Month === 12 ? 1 : result.Month + 1;
            }
          } else {
            result.Day = newDay;
          }
        }
      }
    }

    return result;
  });

  return { intervals: adjusted, crossesDayBoundary };
}

// Maximum number of CalendarInterval entries before falling back to StartInterval
const MAX_CALENDAR_ENTRIES = 24;

/**
 * Generate the launchctl label for a task.
 */
export function getLaunchctlLabel(taskId: string): string {
  return `${LABEL_PREFIX}.${taskId}`;
}

/**
 * Get the plist file path for a task.
 */
export function getPlistPath(taskId: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${getLaunchctlLabel(taskId)}.plist`);
}

/**
 * Escape a string for safe inclusion in XML.
 */
function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse a single cron field into numeric values.
 * Returns null if the field is too complex (too many expansions).
 */
function parseCronField(field: string, min: number, max: number): number[] | null {
  if (field === '*') return [];

  const values: number[] = [];

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4], 10);
      const rangeStart = stepMatch[2] ? parseInt(stepMatch[2], 10) : min;
      const rangeEnd = stepMatch[3] ? parseInt(stepMatch[3], 10) : max;
      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.push(i);
      }
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    } else {
      values.push(parseInt(part, 10));
    }
  }

  return values;
}

/**
 * Convert a 5-field cron expression to launchd CalendarInterval entries.
 * Returns null if the expression can't be reasonably represented (falls back to StartInterval).
 */
export function cronToCalendarInterval(expression: string): CalendarInterval[] | null {
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField, dayField, monthField, weekdayField] = parts;

  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const days = parseCronField(dayField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const weekdays = parseCronField(weekdayField, 0, 6);

  if (!minutes || !hours || !days || !months || !weekdays) return null;

  // Estimate total entries by expanding all combinations
  const minuteValues = minutes.length === 0 ? [undefined] : minutes;
  const hourValues = hours.length === 0 ? [undefined] : hours;
  const dayValues = days.length === 0 ? [undefined] : days;
  const monthValues = months.length === 0 ? [undefined] : months;
  const weekdayValues = weekdays.length === 0 ? [undefined] : weekdays;

  const totalEntries = minuteValues.length * hourValues.length * dayValues.length *
    monthValues.length * weekdayValues.length;

  if (totalEntries > MAX_CALENDAR_ENTRIES) return null;

  const intervals: CalendarInterval[] = [];

  for (const month of monthValues) {
    for (const day of dayValues) {
      for (const weekday of weekdayValues) {
        for (const hour of hourValues) {
          for (const minute of minuteValues) {
            const interval: CalendarInterval = {};
            if (month !== undefined) interval.Month = month;
            if (day !== undefined) interval.Day = day;
            if (weekday !== undefined) interval.Weekday = weekday;
            if (hour !== undefined) interval.Hour = hour;
            if (minute !== undefined) interval.Minute = minute;
            intervals.push(interval);
          }
        }
      }
    }
  }

  return intervals;
}

/**
 * Compute StartInterval (in seconds) from a step-based cron expression.
 * Used as fallback when CalendarInterval can't represent the schedule.
 */
function computeStartInterval(expression: string): number | null {
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField] = parts;

  // Only handle simple */N patterns for minutes
  const minuteStep = minuteField.match(/^\*\/(\d+)$/);
  if (minuteStep && hourField === '*') {
    return parseInt(minuteStep[1], 10) * 60;
  }

  return null;
}

/**
 * Render a CalendarInterval dict entry as plist XML.
 */
function renderCalendarInterval(interval: CalendarInterval): string {
  const lines: string[] = ['      <dict>'];
  for (const [key, value] of Object.entries(interval)) {
    if (value !== undefined) {
      lines.push(`        <key>${key}</key>`);
      lines.push(`        <integer>${value}</integer>`);
    }
  }
  lines.push('      </dict>');
  return lines.join('\n');
}

/**
 * Generate a launchd plist file for a scheduled task.
 */
export function generatePlist(task: DarwinSchedulerTask): string {
  const label = getLaunchctlLabel(task.id);
  const escapedScript = xmlEscape(task.wrapperScriptPath);
  const outLog = xmlEscape(path.join(task.logsDir, `${task.id}.out.log`));
  const errLog = xmlEscape(path.join(task.logsDir, `${task.id}.err.log`));

  let scheduleSection = '';

  if (task.runAtLoad) {
    scheduleSection = `  <key>RunAtLoad</key>
  <true/>`;
  } else if (task.cronExpression) {
    let intervals = cronToCalendarInterval(task.cronExpression);

    if (intervals && task.timezone) {
      const offsetMinutes = computeTimezoneOffsetMinutes(task.timezone);
      if (offsetMinutes !== 0) {
        const { intervals: adjusted, crossesDayBoundary } =
          adjustCalendarIntervalsForTimezone(intervals, offsetMinutes);
        intervals = adjusted;
        if (crossesDayBoundary) {
          // Day-of-month schedules with cross-day timezone offsets use approximate day (clamped to 1-28).
          // This is a known limitation of launchd's CalendarInterval which has no timezone support.
          console.warn(
            `Task ${task.id}: timezone offset crosses day boundary for day-of-month schedule; ` +
            `adjusted day is approximate. For exact timing, use system-local timezone.`,
          );
        }
      }
    }

    if (intervals) {
      const intervalXml = intervals.map(renderCalendarInterval).join('\n');
      scheduleSection = `  <key>StartCalendarInterval</key>
  <array>
${intervalXml}
  </array>`;
    } else {
      // Fall back to StartInterval for step-based expressions
      const seconds = computeStartInterval(task.cronExpression);
      if (seconds) {
        scheduleSection = `  <key>StartInterval</key>
  <integer>${seconds}</integer>`;
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  ${task.programArgs
    ? `<array>\n${task.programArgs.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')}\n  </array>`
    : `<array>
    <string>/bin/bash</string>
    <string>${escapedScript}</string>
  </array>`}
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
${scheduleSection}
</dict>
</plist>
`;
}
