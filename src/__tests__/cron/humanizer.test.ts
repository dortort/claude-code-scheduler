import { describe, it, expect } from 'vitest';
import {
  cronToHuman,
  formatDate,
  formatDuration,
  formatRelativeTime,
} from '../../cron/humanizer.js';

describe('cronToHuman', () => {
  it('describes every-minute cron', () => {
    const result = cronToHuman('* * * * *');
    expect(result.toLowerCase()).toContain('minute');
  });

  it('describes daily cron', () => {
    const result = cronToHuman('0 9 * * *');
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it('describes weekday cron', () => {
    const result = cronToHuman('0 9 * * 1-5');
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns fallback for invalid cron', () => {
    const result = cronToHuman('invalid');
    expect(result).toBeDefined();
  });
});

describe('formatDate', () => {
  it('formats a date object', () => {
    const date = new Date('2026-01-15T09:00:00.000Z');
    const result = formatDate(date);
    expect(result).toContain('2026');
  });

  it('formats an ISO string', () => {
    const result = formatDate('2026-01-15T09:00:00.000Z');
    expect(result).toContain('2026');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds to human-readable', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('formats hours', () => {
    expect(formatDuration(3661000)).toBe('1h 1m 1s');
  });
});

describe('formatRelativeTime', () => {
  it('formats recent time as "just now"', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toContain('just now');
  });

  it('formats minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinAgo)).toContain('5');
    expect(formatRelativeTime(fiveMinAgo)).toContain('minute');
  });

  it('formats hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo)).toContain('2');
    expect(formatRelativeTime(twoHoursAgo)).toContain('hour');
  });

  it('formats days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo)).toContain('3');
    expect(formatRelativeTime(threeDaysAgo)).toContain('day');
  });
});
