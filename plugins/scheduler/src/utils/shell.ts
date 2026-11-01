/**
 * Shell escaping and sanitization utilities.
 * Primary injection defense for all user-provided strings embedded in shell commands.
 */

/**
 * Wraps a string in single quotes, escaping internal single quotes.
 * Single quotes prevent all shell expansion: variable substitution, command substitution, globbing.
 *
 * Algorithm: replace every ' with '\'' (end quote, escaped literal quote, start quote), wrap in single quotes.
 */
export function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Strips shell metacharacters for safe inclusion in bash comments.
 * Replaces newlines with spaces.
 */
export function sanitizeForComment(str: string): string {
  return str
    .replace(/[$`#\\|&<>]/g, '')
    .replace(/\n/g, ' ');
}

/**
 * Validates that a string is a safe identifier (no path traversal, no shell metacharacters).
 * Must start with alphanumeric, then allow alphanumeric, dots, hyphens, underscores.
 */
export function isSafeIdentifier(str: string): boolean {
  if (str.length === 0) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(str);
}

/** Valid git branch names, tags */
export const GIT_REF_PATTERN = /^[a-zA-Z0-9/_.-]+$/;

/** Valid git remote names */
export const GIT_REMOTE_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** Safe filesystem paths */
export const SAFE_PATH_PATTERN = /^[a-zA-Z0-9/_. ~-]+$/;
