import { describe, it, expect, vi } from 'vitest';
import {
  isGitRepo,
  createWorktree,
  commitAndPush,
  removeWorktree,
  isSensitiveFile,
  SENSITIVE_FILE_PATTERNS,
  type ExecFn,
} from '../../vcs/index.js';

// Mock exec function factory
function mockExec(responses: Record<string, { stdout?: string; stderr?: string; error?: Error }>): ExecFn {
  return async (command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`;
    // Find matching response by prefix
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.startsWith(pattern) || key.includes(pattern)) {
        if (response.error) throw response.error;
        return {
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
          exitCode: 0,
        };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

describe('isGitRepo', () => {
  it('returns true for a git repo', async () => {
    const exec = mockExec({
      'git rev-parse': { stdout: 'true\n' },
    });
    expect(await isGitRepo('/some/path', exec)).toBe(true);
  });

  it('returns false when git fails', async () => {
    const exec = mockExec({
      'git rev-parse': { error: new Error('not a git repo') },
    });
    expect(await isGitRepo('/some/path', exec)).toBe(false);
  });
});

describe('createWorktree', () => {
  it('creates worktree with correct branch name', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await createWorktree({
      repoPath: '/repo',
      worktreePath: '/tmp/worktree',
      branchName: 'claude-task/test-abc-123',
      exec,
    });

    // Should call git worktree add
    const worktreeCall = calls.find(c => c.includes('worktree'));
    expect(worktreeCall).toBeDefined();
    expect(worktreeCall).toContain('add');
    expect(worktreeCall).toContain('/tmp/worktree');
  });
});

describe('commitAndPush', () => {
  it('returns success with commit SHA on clean flow', async () => {
    const exec = mockExec({
      'git add': { stdout: '' },
      'git status': { stdout: 'M file.ts\n' },
      'git commit': { stdout: '' },
      'git rev-parse': { stdout: 'abc123def\n' },
      'git push': { stdout: '' },
    });

    const result = await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'Claude task: test',
      remoteName: 'origin',
      branchName: 'claude-task/test',
      exec,
    });

    expect(result.success).toBe(true);
    expect(result.commitSha).toBe('abc123def');
    expect(result.pushed).toBe(true);
    expect(result.hadChanges).toBe(true);
  });

  it('returns hadChanges=false when no changes', async () => {
    const exec = mockExec({
      'git add': { stdout: '' },
      'git status': { stdout: '' },
    });

    const result = await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'Claude task: test',
      remoteName: 'origin',
      branchName: 'claude-task/test',
      exec,
    });

    expect(result.success).toBe(true);
    expect(result.hadChanges).toBe(false);
    expect(result.pushed).toBe(false);
  });

  it('returns success=false on push failure', async () => {
    const exec = mockExec({
      'git add': { stdout: '' },
      'git status': { stdout: 'M file.ts\n' },
      'git commit': { stdout: '' },
      'git rev-parse': { stdout: 'abc123\n' },
      'git push': { error: new Error('remote rejected') },
    });

    const result = await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'Claude task: test',
      remoteName: 'origin',
      branchName: 'claude-task/test',
      exec,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('remote rejected');
    expect(result.hadChanges).toBe(true);
    expect(result.pushed).toBe(false);
  });

  it('uses git add -u by default (not -A)', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('--porcelain')) return { stdout: 'M file.ts\n', stderr: '', exitCode: 0 };
      if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'test',
      remoteName: 'origin',
      branchName: 'test',
      exec,
    });

    const addCall = calls.find(c => c[0] === 'git' && c.includes('add'));
    expect(addCall).toBeDefined();
    expect(addCall).toContain('-u');
    expect(addCall).not.toContain('-A');
  });
});

describe('removeWorktree', () => {
  it('calls git worktree remove', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await removeWorktree('/tmp/worktree', exec);

    const removeCall = calls.find(c => c.includes('remove'));
    expect(removeCall).toBeDefined();
    expect(removeCall).toContain('/tmp/worktree');
  });

  it('retries once on failure', async () => {
    let callCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      callCount++;
      if (callCount === 1 && args.includes('remove')) {
        throw new Error('lock file');
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    await removeWorktree('/tmp/worktree', exec);
    expect(callCount).toBe(2);
  });

  it('does not throw on final failure', async () => {
    const exec: ExecFn = async () => {
      throw new Error('permanently locked');
    };

    // Should not throw - just logs warning
    await expect(removeWorktree('/tmp/worktree', exec)).resolves.not.toThrow();
  });
});

describe('isSensitiveFile', () => {
  it('detects .env files', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.local')).toBe(true);
    expect(isSensitiveFile('.env.production')).toBe(true);
  });

  it('detects key files', () => {
    expect(isSensitiveFile('server.pem')).toBe(true);
    expect(isSensitiveFile('private.key')).toBe(true);
    expect(isSensitiveFile('id_rsa')).toBe(true);
    expect(isSensitiveFile('id_ed25519')).toBe(true);
  });

  it('detects credential files', () => {
    expect(isSensitiveFile('credentials.json')).toBe(true);
    expect(isSensitiveFile('.npmrc')).toBe(true);
  });

  it('detects certificate files', () => {
    expect(isSensitiveFile('cert.p12')).toBe(true);
    expect(isSensitiveFile('cert.pfx')).toBe(true);
  });

  it('allows normal files', () => {
    expect(isSensitiveFile('index.ts')).toBe(false);
    expect(isSensitiveFile('package.json')).toBe(false);
    expect(isSensitiveFile('README.md')).toBe(false);
  });
});

describe('SENSITIVE_FILE_PATTERNS', () => {
  it('contains key patterns', () => {
    expect(SENSITIVE_FILE_PATTERNS.length).toBeGreaterThan(5);
  });
});
