/**
 * Platform scheduler factory.
 * Detects the current platform and returns the appropriate scheduler module.
 */

export class PlatformNotSupportedError extends Error {
  constructor(platform: string) {
    super(`Platform "${platform}" is not supported. Supported platforms: darwin, linux.`);
    this.name = 'PlatformNotSupportedError';
  }
}

export interface PlatformScheduler {
  platform: string;
}

/**
 * Get the scheduler for the given platform.
 * Throws PlatformNotSupportedError for unsupported platforms (win32, freebsd, etc.).
 */
export function getSchedulerForPlatform(platform: string): PlatformScheduler {
  switch (platform) {
    case 'darwin':
      return { platform: 'darwin' };
    case 'linux':
      return { platform: 'linux' };
    default:
      throw new PlatformNotSupportedError(platform);
  }
}
