import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatNextRunTime } from '../../../cli/commands/humanize.js';

describe('formatNextRunTime', () => {
  beforeEach(() => {
    // Fix "now" to 2026-03-31 06:42:00 UTC (a Tuesday)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T06:42:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for undefined input', () => {
    expect(formatNextRunTime(undefined)).toBeNull();
  });

  it('returns "Today" when next run is same UTC date', () => {
    const next = new Date('2026-03-31T07:00:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('Today');
    expect(result).toContain('Tue');
    expect(result).toContain('7:00 AM UTC');
    expect(result).toContain('~in 18m');
  });

  it('returns "Tomorrow" when next run is next UTC date', () => {
    const next = new Date('2026-04-01T07:00:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('Tomorrow');
    expect(result).toContain('Wed');
    expect(result).toContain('7:00 AM UTC');
  });

  it('returns day name when next run is 2+ days away', () => {
    const next = new Date('2026-04-02T07:00:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('Thu');
    expect(result).not.toContain('Today');
    expect(result).not.toContain('Tomorrow');
  });

  it('formats PM times correctly', () => {
    const next = new Date('2026-03-31T15:30:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('3:30 PM UTC');
  });

  it('formats midnight as 12:00 AM', () => {
    const next = new Date('2026-04-01T00:00:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('12:00 AM UTC');
  });

  it('formats noon as 12:00 PM', () => {
    const next = new Date('2026-03-31T12:00:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('12:00 PM UTC');
  });

  it('shows ~in <1m for very near future', () => {
    const next = new Date('2026-03-31T06:42:30Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('~in <1m');
  });

  it('shows hours and minutes in delta', () => {
    const next = new Date('2026-03-31T09:12:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('~in 2h 30m');
  });

  it('shows days in delta for distant runs', () => {
    const next = new Date('2026-04-03T06:42:00Z');
    const result = formatNextRunTime(next);
    expect(result).toContain('~in 3d');
  });
});
