/**
 * Git VCS operations: worktree management, commit, push.
 * Uses dependency injection for exec to enable testing without real git.
 */

import { exec as defaultExec, type ExecResult } from '../utils/exec.js';

export type ExecFn = (command: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;

// --- Sensitive File Detection ---

export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env($|\.)/,          // .env, .env.local, .env.production
  /\.pem$/,                // SSL certificates
  /\.key$/,                // Private keys
  /\.secret$/,             // Secret files
  /^id_rsa/,               // SSH RSA keys
  /^id_ed25519/,           // SSH Ed25519 keys
  /^id_ecdsa/,             // SSH ECDSA keys
  /^credentials\./,        // credentials.json, etc.
  /^\.npmrc$/,             // npm auth tokens
  /\.p12$/,                // PKCS#12 certificates
  /\.pfx$/,                // PFX certificates
  /\.sqlite$/,             // SQLite databases
  /\.db$/,                 // Database files
];

/**
 * Check if a filename matches sensitive file patterns.
 */
export function isSensitiveFile(filename: string): boolean {
  const basename = filename.split('/').pop() ?? filename;
  return SENSITIVE_FILE_PATTERNS.some(pattern => pattern.test(basename));
}

// --- Git Operations ---

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(dirPath: string, exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dirPath });
    return true;
  } catch {
    return false;
  }
}

export interface CreateWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  exec?: ExecFn;
}

/**
 * Create a git worktree with a new branch.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<void> {
  const exec = options.exec ?? defaultExec;
  await exec('git', ['worktree', 'add', options.worktreePath, '-b', options.branchName], {
    cwd: options.repoPath,
  });
}

export interface CommitAndPushOptions {
  worktreePath: string;
  message: string;
  remoteName: string;
  branchName: string;
  exec?: ExecFn;
}

export interface CommitAndPushResult {
  success: boolean;
  hadChanges: boolean;
  commitSha?: string;
  pushed: boolean;
  error?: string;
}

/**
 * Stage tracked changes, commit, and push. Uses `git add -u` (not `-A`) by default.
 * Returns a result object instead of throwing on failure.
 */
export async function commitAndPush(options: CommitAndPushOptions): Promise<CommitAndPushResult> {
  const exec = options.exec ?? defaultExec;
  const cwd = { cwd: options.worktreePath };

  try {
    // Stage tracked files only (not untracked - safer default)
    await exec('git', ['add', '-u'], cwd);

    // Check if there are staged changes
    const status = await exec('git', ['status', '--porcelain'], cwd);
    if (status.stdout.trim().length === 0) {
      return { success: true, hadChanges: false, pushed: false };
    }

    // Commit
    await exec('git', ['commit', '-m', options.message], cwd);

    // Get commit SHA
    const shaResult = await exec('git', ['rev-parse', 'HEAD'], cwd);
    const commitSha = shaResult.stdout.trim();

    // Push
    try {
      await exec('git', ['push', '-u', options.remoteName, options.branchName], cwd);
      return { success: true, hadChanges: true, commitSha, pushed: true };
    } catch (pushErr) {
      return {
        success: false,
        hadChanges: true,
        commitSha,
        pushed: false,
        error: pushErr instanceof Error ? pushErr.message : 'Push failed',
      };
    }
  } catch (err) {
    return {
      success: false,
      hadChanges: false,
      pushed: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Remove a git worktree. Retries once after 500ms on failure (handles file lock races).
 * Does not throw on final failure.
 */
export async function removeWorktree(worktreePath: string, exec: ExecFn = defaultExec): Promise<void> {
  try {
    await exec('git', ['worktree', 'remove', worktreePath, '--force']);
  } catch {
    // Retry once after a short delay
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      await exec('git', ['worktree', 'remove', worktreePath, '--force']);
    } catch {
      // Final failure - log but don't throw
      console.warn(`[claude-scheduler] Failed to remove worktree: ${worktreePath}`);
    }
  }
}

/**
 * Generate a branch name for a worktree execution.
 */
export function generateBranchName(prefix: string, taskId: string): string {
  const shortId = taskId.slice(0, 8);
  const timestamp = Math.floor(Date.now() / 1000);
  return `${prefix}task-${shortId}-${timestamp}`;
}
