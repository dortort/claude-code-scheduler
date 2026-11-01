import { describe, it, expect } from 'vitest';
import { getSchedulerForPlatform, PlatformNotSupportedError } from '../../schedulers/index.js';

describe('getSchedulerForPlatform', () => {
  it('returns darwin scheduler for macOS', () => {
    const scheduler = getSchedulerForPlatform('darwin');
    expect(scheduler.platform).toBe('darwin');
  });

  it('returns linux scheduler for Linux', () => {
    const scheduler = getSchedulerForPlatform('linux');
    expect(scheduler.platform).toBe('linux');
  });

  it('throws PlatformNotSupportedError for Windows', () => {
    expect(() => getSchedulerForPlatform('win32')).toThrow(PlatformNotSupportedError);
  });

  it('throws PlatformNotSupportedError for unknown platforms', () => {
    expect(() => getSchedulerForPlatform('freebsd')).toThrow(PlatformNotSupportedError);
  });

  it('PlatformNotSupportedError contains platform name', () => {
    try {
      getSchedulerForPlatform('win32');
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformNotSupportedError);
      expect((err as PlatformNotSupportedError).message).toContain('win32');
    }
  });
});
