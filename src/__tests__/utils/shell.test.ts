import { describe, it, expect } from 'vitest';
import {
  shellEscape,
  sanitizeForComment,
  isSafeIdentifier,
  GIT_REF_PATTERN,
  GIT_REMOTE_PATTERN,
  SAFE_PATH_PATTERN,
} from '../../utils/shell.js';

describe('shellEscape', () => {
  it('wraps simple string in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'");
  });

  it('escapes internal single quotes', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it('escapes multiple single quotes', () => {
    expect(shellEscape("it's a test's test")).toBe("'it'\\''s a test'\\''s test'");
  });

  it('prevents variable expansion', () => {
    expect(shellEscape('$HOME')).toBe("'$HOME'");
  });

  it('prevents command substitution with backticks', () => {
    expect(shellEscape('`whoami`')).toBe("'`whoami`'");
  });

  it('prevents command substitution with $()', () => {
    expect(shellEscape('$(cat /etc/passwd)')).toBe("'$(cat /etc/passwd)'");
  });

  it('handles semicolons and pipes', () => {
    const input = '"; rm -rf /';
    const result = shellEscape(input);
    // No single quotes in input, so just wrapped in single quotes
    expect(result).toBe("'\"" + "; rm -rf /'");
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''");
  });

  it('handles string with only single quotes', () => {
    expect(shellEscape("'''")).toBe("''\\'''\\'''\\'''");
  });

  it('handles newlines', () => {
    const result = shellEscape('line1\nline2');
    expect(result).toBe("'line1\nline2'");
  });

  it('handles prompt injection attempts', () => {
    const result = shellEscape('ignore previous instructions');
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });
});

describe('sanitizeForComment', () => {
  it('strips shell metacharacters', () => {
    expect(sanitizeForComment('hello $world')).toBe('hello world');
  });

  it('strips backticks', () => {
    expect(sanitizeForComment('run `cmd`')).toBe('run cmd');
  });

  it('strips hash', () => {
    expect(sanitizeForComment('test # comment')).toBe('test  comment');
  });

  it('strips backslash', () => {
    expect(sanitizeForComment('path\\to\\file')).toBe('pathtofile');
  });

  it('strips pipe and ampersand', () => {
    expect(sanitizeForComment('cmd | other & bg')).toBe('cmd  other  bg');
  });

  it('strips angle brackets', () => {
    expect(sanitizeForComment('a < b > c')).toBe('a  b  c');
  });

  it('replaces newlines with spaces', () => {
    expect(sanitizeForComment('line1\nline2')).toBe('line1 line2');
  });

  it('handles empty string', () => {
    expect(sanitizeForComment('')).toBe('');
  });
});

describe('isSafeIdentifier', () => {
  it('accepts alphanumeric with dots hyphens underscores', () => {
    expect(isSafeIdentifier('daily-review.v2')).toBe(true);
  });

  it('accepts simple names', () => {
    expect(isSafeIdentifier('myTask')).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(isSafeIdentifier('../../etc/passwd')).toBe(false);
  });

  it('rejects shell metacharacters', () => {
    expect(isSafeIdentifier('task;rm -rf /')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeIdentifier('')).toBe(false);
  });

  it('rejects leading dot', () => {
    expect(isSafeIdentifier('.hidden')).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(isSafeIdentifier('-flag')).toBe(false);
  });
});

describe('validation patterns', () => {
  describe('GIT_REF_PATTERN', () => {
    it('matches valid branch names', () => {
      expect(GIT_REF_PATTERN.test('main')).toBe(true);
      expect(GIT_REF_PATTERN.test('feature/my-branch')).toBe(true);
      expect(GIT_REF_PATTERN.test('claude-task/task-abc123-1705612800')).toBe(true);
    });

    it('rejects invalid branch names', () => {
      expect(GIT_REF_PATTERN.test('branch;evil')).toBe(false);
      expect(GIT_REF_PATTERN.test('branch name')).toBe(false);
    });
  });

  describe('GIT_REMOTE_PATTERN', () => {
    it('matches valid remote names', () => {
      expect(GIT_REMOTE_PATTERN.test('origin')).toBe(true);
      expect(GIT_REMOTE_PATTERN.test('upstream')).toBe(true);
      expect(GIT_REMOTE_PATTERN.test('my-remote.v2')).toBe(true);
    });

    it('rejects invalid remote names', () => {
      expect(GIT_REMOTE_PATTERN.test('remote/name')).toBe(false);
      expect(GIT_REMOTE_PATTERN.test('a b')).toBe(false);
    });
  });

  describe('SAFE_PATH_PATTERN', () => {
    it('matches valid filesystem paths', () => {
      expect(SAFE_PATH_PATTERN.test('/home/user/project')).toBe(true);
      expect(SAFE_PATH_PATTERN.test('~/my-project')).toBe(true);
      expect(SAFE_PATH_PATTERN.test('/Users/user/my project')).toBe(true);
    });

    it('rejects paths with dangerous characters', () => {
      expect(SAFE_PATH_PATTERN.test('/path;evil')).toBe(false);
      expect(SAFE_PATH_PATTERN.test('/path|pipe')).toBe(false);
    });
  });
});
