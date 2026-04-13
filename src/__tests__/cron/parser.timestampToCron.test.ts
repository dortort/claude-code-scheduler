import { describe, it, expect } from 'vitest';
import { timestampToCron } from '../../cron/parser.js';

describe('timestampToCron', () => {
  it('converts a future UTC timestamp to a cron expression', () => {
    expect(timestampToCron('2027-04-01T09:30:00Z')).toBe('30 9 1 4 *');
  });

  it('converts Christmas midnight UTC to a cron expression', () => {
    expect(timestampToCron('2026-12-25T00:00:00Z')).toBe('0 0 25 12 *');
  });

  it('throws on a past timestamp', () => {
    expect(() => timestampToCron('2020-01-01T00:00:00Z')).toThrow('Timestamp must be in the future');
  });

  it('throws on an invalid timestamp string', () => {
    expect(() => timestampToCron('not-a-date')).toThrow('Invalid timestamp');
  });

  it('throws on an empty string', () => {
    expect(() => timestampToCron('')).toThrow('Invalid timestamp');
  });
});
