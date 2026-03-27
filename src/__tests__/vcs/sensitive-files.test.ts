import { describe, it, expect, vi } from 'vitest';
import {
  commitAndPush,
  type ExecFn,
} from '../../vcs/index.js';

// Track all exec calls for assertions
function trackingExec(
  responses: Record<string, { stdout?: string; stderr?: string; error?: Error }>,
): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const key = `${command} ${args.join(' ')}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.startsWith(pattern) || key.includes(pattern)) {
        if (response.error) throw response.error;
        return { stdout: response.stdout ?? '', stderr: response.stderr ?? '', exitCode: 0 };
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { exec, calls };
}

describe('sensitiveFilePolicy: block (default)', () => {
  it('unstages .env and reports it in sensitiveFilesDetected', async () => {
    const { exec, calls } = trackingExec({
      'git add -u': {},
      'git status --porcelain': { stdout: 'M .env\nM README.md\n' },
      'git diff --cached --name-only': { stdout: '.env\nREADME.md\n' },
      'git reset HEAD .env': {},
      'git commit': {},
      'git rev-parse HEAD': { stdout: 'abc123\n' },
      'git push': {},
    });

    const result = await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'test commit',
      remoteName: 'origin',
      branchName: 'test-branch',
      sensitiveFilePolicy: 'block',
      exec,
    });

    // git reset HEAD .env must be called
    const resetCall = calls.find(c => c.includes('reset') && c.includes('.env'));
    expect(resetCall).toBeDefined();

    expect(result.sensitiveFilesDetected).toEqual(['.env']);
  });

  it('uses block as default when policy not specified', async () => {
    const { exec, calls } = trackingExec({
      'git add -u': {},
      'git status --porcelain': { stdout: 'M .env\n' },
      'git diff --cached --name-only': { stdout: '.env\n' },
      'git reset HEAD .env': {},
      'git commit': {},
      'git rev-parse HEAD': { stdout: 'abc123\n' },
      'git push': {},
    });

    await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'test commit',
      remoteName: 'origin',
      branchName: 'test-branch',
      exec,
    });

    const resetCall = calls.find(c => c.includes('reset') && c.includes('.env'));
    expect(resetCall).toBeDefined();
  });
});

describe('sensitiveFilePolicy: warn', () => {
  it('does NOT unstage but reports sensitiveFilesDetected', async () => {
    const { exec, calls } = trackingExec({
      'git add -u': {},
      'git status --porcelain': { stdout: 'M .env\nM README.md\n' },
      'git diff --cached --name-only': { stdout: '.env\nREADME.md\n' },
      'git commit': {},
      'git rev-parse HEAD': { stdout: 'abc123\n' },
      'git push': {},
    });

    const result = await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'test commit',
      remoteName: 'origin',
      branchName: 'test-branch',
      sensitiveFilePolicy: 'warn',
      exec,
    });

    // git reset must NOT be called
    const resetCall = calls.find(c => c.includes('reset'));
    expect(resetCall).toBeUndefined();

    expect(result.sensitiveFilesDetected).toEqual(['.env']);
  });
});

describe('sensitiveFilePolicy: allow', () => {
  it('does NOT unstage and does NOT report sensitiveFilesDetected', async () => {
    const { exec, calls } = trackingExec({
      'git add -u': {},
      'git status --porcelain': { stdout: 'M .env\nM README.md\n' },
      'git diff --cached --name-only': { stdout: '.env\nREADME.md\n' },
      'git commit': {},
      'git rev-parse HEAD': { stdout: 'abc123\n' },
      'git push': {},
    });

    const result = await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'test commit',
      remoteName: 'origin',
      branchName: 'test-branch',
      sensitiveFilePolicy: 'allow',
      exec,
    });

    const resetCall = calls.find(c => c.includes('reset'));
    expect(resetCall).toBeUndefined();

    expect(result.sensitiveFilesDetected).toBeUndefined();
  });
});

describe('no sensitive files staged', () => {
  it('all policies behave identically — no reset, no sensitiveFilesDetected', async () => {
    for (const policy of ['block', 'warn', 'allow'] as const) {
      const { exec, calls } = trackingExec({
        'git add -u': {},
        'git status --porcelain': { stdout: 'M README.md\nM src/index.ts\n' },
        'git diff --cached --name-only': { stdout: 'README.md\nsrc/index.ts\n' },
        'git commit': {},
        'git rev-parse HEAD': { stdout: 'abc123\n' },
        'git push': {},
      });

      const result = await commitAndPush({
        worktreePath: '/tmp/worktree',
        message: 'test commit',
        remoteName: 'origin',
        branchName: 'test-branch',
        sensitiveFilePolicy: policy,
        exec,
      });

      const resetCall = calls.find(c => c.includes('reset'));
      expect(resetCall, `policy=${policy} should not call reset`).toBeUndefined();
      expect(result.sensitiveFilesDetected, `policy=${policy} should have no sensitiveFilesDetected`).toBeUndefined();
    }
  });
});

describe('multiple sensitive files', () => {
  it('detects both .env and id_rsa, unstages both on block', async () => {
    const { exec, calls } = trackingExec({
      'git add -u': {},
      'git status --porcelain': { stdout: 'M .env\nM id_rsa\nM app.ts\n' },
      'git diff --cached --name-only': { stdout: '.env\nid_rsa\napp.ts\n' },
      'git reset HEAD .env': {},
      'git reset HEAD id_rsa': {},
      'git commit': {},
      'git rev-parse HEAD': { stdout: 'abc123\n' },
      'git push': {},
    });

    const result = await commitAndPush({
      worktreePath: '/tmp/worktree',
      message: 'test commit',
      remoteName: 'origin',
      branchName: 'test-branch',
      sensitiveFilePolicy: 'block',
      exec,
    });

    const resetEnv = calls.find(c => c.includes('reset') && c.includes('.env'));
    const resetKey = calls.find(c => c.includes('reset') && c.includes('id_rsa'));
    expect(resetEnv).toBeDefined();
    expect(resetKey).toBeDefined();

    expect(result.sensitiveFilesDetected).toEqual(expect.arrayContaining(['.env', 'id_rsa']));
    expect(result.sensitiveFilesDetected).toHaveLength(2);
  });
});
