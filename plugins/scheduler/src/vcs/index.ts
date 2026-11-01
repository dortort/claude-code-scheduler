/**
 * Git VCS operations: worktree management, commit, push.
 * Uses dependency injection for exec to enable testing without real git.
 */

import path from 'node:path';
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

/**
 * Resolve the path where Claude CLI creates a worktree for the given name.
 */
export function getWorktreePath(repoRoot: string, name: string): string {
  return path.join(repoRoot, '.claude', 'worktrees', name);
}

/**
 * Generate a short worktree name for the --worktree CLI flag.
 */
export function generateWorktreeName(taskId: string): string {
  const shortId = taskId.slice(0, 8);
  const timestamp = Math.floor(Date.now() / 1000);
  return `task-${shortId}-${timestamp}`;
}

/**
 * Derive the actual git branch name that Claude CLI creates for a worktree.
 * Claude CLI names branches as {repoBasename}-{worktreeName}.
 */
export function deriveWorktreeBranchName(repoRoot: string, worktreeName: string): string {
  return `${path.basename(repoRoot)}-${worktreeName}`;
}

export interface CommitAndPushOptions {
  worktreePath: string;
  message: string;
  remoteName: string;
  branchName: string;
  sensitiveFilePolicy?: 'block' | 'warn' | 'allow';
  exec?: ExecFn;
}

export interface CommitAndPushResult {
  success: boolean;
  hadChanges: boolean;
  commitSha?: string;
  pushed: boolean;
  error?: string;
  sensitiveFilesDetected?: string[];
}

/**
 * Stage tracked changes, commit, and push. Uses git add -u (not -A) by default.
 * Enforces sensitiveFilePolicy before committing.
 * Returns a result object instead of throwing on failure.
 */
export async function commitAndPush(options: CommitAndPushOptions): Promise<CommitAndPushResult> {
  const exec = options.exec ?? defaultExec;
  const cwd = { cwd: options.worktreePath };
  const policy = options.sensitiveFilePolicy ?? 'block';

  try {
    // Stage tracked files only (not untracked - safer default)
    await exec('git', ['add', '-u'], cwd);

    // Detect sensitive files in the index
    const diffResult = await exec('git', ['diff', '--cached', '--name-only'], cwd);
    const stagedFiles = diffResult.stdout.split('\n').map(f => f.trim()).filter(Boolean);
    const sensitiveFiles = stagedFiles.filter(f => isSensitiveFile(f));

    if (sensitiveFiles.length > 0) {
      if (policy === 'block') {
        for (const file of sensitiveFiles) {
          console.warn(`[claude-scheduler] Blocking sensitive file from commit: ${file}`);
          await exec('git', ['reset', 'HEAD', file], cwd);
        }
      } else if (policy === 'warn') {
        for (const file of sensitiveFiles) {
          console.warn(`[claude-scheduler] Warning: sensitive file staged for commit: ${file}`);
        }
      }
      // 'allow' -- proceed silently
    }

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

    // Build sensitiveFilesDetected for result (block and warn only)
    const detectedField = (policy !== 'allow' && sensitiveFiles.length > 0)
      ? { sensitiveFilesDetected: sensitiveFiles }
      : {};

    // Push
    try {
      await exec('git', ['push', '-u', options.remoteName, options.branchName], cwd);
      return { success: true, hadChanges: true, commitSha, pushed: true, ...detectedField };
    } catch (pushErr) {
      return {
        success: false,
        hadChanges: true,
        commitSha,
        pushed: false,
        error: pushErr instanceof Error ? pushErr.message : 'Push failed',
        ...detectedField,
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
export async function removeWorktree(
  worktreePath: string,
  options?: { cwd?: string; exec?: ExecFn },
): Promise<void> {
  const exec = options?.exec ?? defaultExec;
  const cwdOpt = options?.cwd ? { cwd: options.cwd } : undefined;
  try {
    await exec('git', ['worktree', 'remove', worktreePath, '--force'], cwdOpt);
  } catch {
    // Retry once after a short delay
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      await exec('git', ['worktree', 'remove', worktreePath, '--force'], cwdOpt);
    } catch {
      // Final failure - log but don't throw
      console.warn(`[claude-scheduler] Failed to remove worktree: ${worktreePath}`);
    }
  }
}
