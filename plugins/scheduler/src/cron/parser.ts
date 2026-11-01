/**
 * Cron expression parsing, validation, and natural language conversion.
 * Uses the croner library for cron parsing/validation.
 */

import { Cron } from 'croner';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a 5-field cron expression.
 */
export function validateCron(expression: string): ValidationResult {
  if (!expression || expression.trim().length === 0) {
    return { valid: false, error: 'Empty cron expression' };
  }

  // Reject 6-field (with seconds) or invalid field counts
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { valid: false, error: `Expected 5 fields, got ${fields.length}` };
  }

  try {
    // Croner validates on construction
    new Cron(expression);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid cron expression',
    };
  }
}

/**
 * Get the next N run times for a cron expression.
 */
export function getNextRuns(expression: string, count: number, timezone?: string): Date[] {
  const options: Record<string, unknown> = {};
  if (timezone && timezone !== 'local') {
    options.timezone = timezone;
  }

  const cron = new Cron(expression, options);
  const runs: Date[] = [];
  let next = cron.nextRun();

  while (next && runs.length < count) {
    runs.push(next);
    next = cron.nextRun(new Date(next.getTime() + 1000));
  }

  return runs;
}

/**
 * Get the next single run time for a cron expression.
 */
export function getNextRun(expression: string, timezone?: string): Date {
  const runs = getNextRuns(expression, 1, timezone);
  return runs[0];
}

// --- Natural Language Parsing ---

const DAY_MAP: Record<string, string> = {
  sunday: '0', sun: '0',
  monday: '1', mon: '1',
  tuesday: '2', tue: '2',
  wednesday: '3', wed: '3',
  thursday: '4', thu: '4',
  friday: '5', fri: '5',
  saturday: '6', sat: '6',
};

function parseHour(timeStr: string): number | undefined {
  const match = timeStr.match(/(\d{1,2})\s*(am|pm)?/i);
  if (!match) return undefined;

  let hour = parseInt(match[1], 10);
  const meridiem = match[2]?.toLowerCase();

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23) return undefined;
  return hour;
}

/**
 * Convert natural language schedule description to a cron expression.
 * Returns undefined if the input doesn't match any known pattern.
 */
export function naturalLanguageToCron(input: string): string | undefined {
  const lower = input.toLowerCase().trim();

  // Check presets first
  for (const [name, expr] of Object.entries(CRON_PRESETS)) {
    if (lower === name) return expr;
  }

  // "every minute"
  if (/^every\s+minute$/.test(lower)) {
    return '* * * * *';
  }

  // "every N minutes"
  const everyNMin = lower.match(/^every\s+(\d+)\s+minutes?$/);
  if (everyNMin) {
    const n = parseInt(everyNMin[1], 10);
    if (n >= 1 && n <= 59) return `*/${n} * * * *`;
  }

  // "daily at Xam/pm"
  const dailyAt = lower.match(/^daily\s+at\s+(.+)$/);
  if (dailyAt) {
    const hour = parseHour(dailyAt[1]);
    if (hour !== undefined) return `0 ${hour} * * *`;
  }

  // "every weekday at Xam/pm"
  const weekdayAt = lower.match(/^every\s+weekday\s+at\s+(.+)$/);
  if (weekdayAt) {
    const hour = parseHour(weekdayAt[1]);
    if (hour !== undefined) return `0 ${hour} * * 1-5`;
  }

  // "every <day> at Xam/pm"
  const dayAt = lower.match(/^every\s+(\w+)\s+at\s+(.+)$/);
  if (dayAt) {
    const dayNum = DAY_MAP[dayAt[1]];
    if (dayNum !== undefined) {
      const hour = parseHour(dayAt[2]);
      if (hour !== undefined) return `0 ${hour} * * ${dayNum}`;
    }
  }

  return undefined;
}

/**
 * Convert a future ISO timestamp to a one-time cron expression.
 * Uses UTC field extraction. Throws if the timestamp is invalid or in the past.
 */
export function timestampToCron(isoTimestamp: string, timezone?: string): string {
  // timezone parameter reserved for future use (currently uses UTC)
  void timezone;
  const date = new Date(isoTimestamp);
  if (isNaN(date.getTime())) throw new Error('Invalid timestamp');
  if (date.getTime() <= Date.now()) throw new Error('Timestamp must be in the future');
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  return `${minute} ${hour} ${day} ${month} *`;
}

/**
 * Named cron presets for common schedules.
 */
export const CRON_PRESETS: Record<string, string> = {
  hourly: '0 * * * *',
  daily: '0 9 * * *',
  weekly: '0 9 * * 1',
  monthly: '0 9 1 * *',
  weekdays: '0 9 * * 1-5',
};
