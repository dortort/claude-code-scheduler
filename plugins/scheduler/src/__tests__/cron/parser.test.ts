import { describe, it, expect } from 'vitest';
import {
  validateCron,
  getNextRuns,
  getNextRun,
  naturalLanguageToCron,
  CRON_PRESETS,
} from '../../cron/parser.js';

describe('validateCron', () => {
  it('accepts standard 5-field cron', () => {
    expect(validateCron('0 9 * * 1-5').valid).toBe(true);
  });

  it('accepts every-minute cron', () => {
    expect(validateCron('* * * * *').valid).toBe(true);
  });

  it('accepts step values', () => {
    expect(validateCron('*/15 * * * *').valid).toBe(true);
  });

  it('accepts ranges', () => {
    expect(validateCron('0 9-17 * * 1-5').valid).toBe(true);
  });

  it('rejects invalid cron', () => {
    const result = validateCron('not a cron');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects 6-field cron (seconds)', () => {
    const result = validateCron('0 0 9 * * 1-5');
    expect(result.valid).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateCron('').valid).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(validateCron('60 * * * *').valid).toBe(false);
  });
});

describe('getNextRuns', () => {
  it('returns requested number of dates', () => {
    const runs = getNextRuns('* * * * *', 5);
    expect(runs).toHaveLength(5);
  });

  it('returns Date objects', () => {
    const runs = getNextRuns('0 9 * * *', 3);
    for (const run of runs) {
      expect(run).toBeInstanceOf(Date);
    }
  });

  it('returns dates in ascending order', () => {
    const runs = getNextRuns('0 9 * * *', 3);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].getTime()).toBeGreaterThan(runs[i - 1].getTime());
    }
  });

  it('returns future dates', () => {
    const now = Date.now();
    const runs = getNextRuns('* * * * *', 1);
    expect(runs[0].getTime()).toBeGreaterThanOrEqual(now);
  });
});

describe('getNextRun', () => {
  it('returns a single Date', () => {
    const run = getNextRun('0 9 * * *');
    expect(run).toBeInstanceOf(Date);
  });
});

describe('naturalLanguageToCron', () => {
  it('parses "every minute"', () => {
    expect(naturalLanguageToCron('every minute')).toBe('* * * * *');
  });

  it('parses "every 15 minutes"', () => {
    expect(naturalLanguageToCron('every 15 minutes')).toBe('*/15 * * * *');
  });

  it('parses "hourly"', () => {
    expect(naturalLanguageToCron('hourly')).toBe('0 * * * *');
  });

  it('parses "daily at 9am"', () => {
    expect(naturalLanguageToCron('daily at 9am')).toBe('0 9 * * *');
  });

  it('parses "daily at 3pm"', () => {
    expect(naturalLanguageToCron('daily at 3pm')).toBe('0 15 * * *');
  });

  it('parses "every weekday at 9am"', () => {
    expect(naturalLanguageToCron('every weekday at 9am')).toBe('0 9 * * 1-5');
  });

  it('parses "every Monday at 10am"', () => {
    expect(naturalLanguageToCron('every Monday at 10am')).toBe('0 10 * * 1');
  });

  it('parses "monthly"', () => {
    expect(naturalLanguageToCron('monthly')).toBe('0 9 1 * *');
  });

  it('returns undefined for unrecognized input', () => {
    expect(naturalLanguageToCron('every purple moon')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(naturalLanguageToCron('DAILY AT 9AM')).toBe('0 9 * * *');
  });

  it('parses "every 5 minutes"', () => {
    expect(naturalLanguageToCron('every 5 minutes')).toBe('*/5 * * * *');
  });

  it('parses day names correctly', () => {
    const days: Record<string, string> = {
      sunday: '0', monday: '1', tuesday: '2', wednesday: '3',
      thursday: '4', friday: '5', saturday: '6',
    };
    for (const [day, num] of Object.entries(days)) {
      const result = naturalLanguageToCron(`every ${day} at 9am`);
      expect(result).toBe(`0 9 * * ${num}`);
    }
  });
});

describe('CRON_PRESETS', () => {
  it('has standard presets', () => {
    expect(CRON_PRESETS).toHaveProperty('hourly');
    expect(CRON_PRESETS).toHaveProperty('daily');
    expect(CRON_PRESETS).toHaveProperty('weekly');
    expect(CRON_PRESETS).toHaveProperty('monthly');
  });

  it('preset values are valid cron expressions', () => {
    for (const expr of Object.values(CRON_PRESETS)) {
      expect(validateCron(expr).valid).toBe(true);
    }
  });
});
