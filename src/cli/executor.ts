/**
 * Shared task executor. Reads config at runtime, applies locking/timeout/logging,
 * and runs claude. Handles both direct and worktree execution modes.
 *
 * Invoked by the OS scheduler (launchd/cron) via:
 *   ~/.claude/bin/claude-scheduler-run <taskId>
 *
 * This replaces per-task wrapper scripts with a single executor that reads
 * task configuration from ~/.claude/schedules.json at runtime.
 */

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { loadConfig, findTask, getLogsDir, getHistoryPath } from '../config.js';
import { recordExecution } from '../history/index.js';
import { ensureLogsDir, getLogPaths, readLog } from '../logs/index.js';
import {
  commitAndPush,
  removeWorktree,
  getWorktreePath,
  generateWorktreeName,
  deriveWorktreeBranchName,
} from '../vcs/index.js';
import type { ScheduledTask } from '../types.js';

// --- Lock Management ---

async function fileMtime(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return Math.floor(s.mtimeMs / 1000);
  } catch {
    return 0;
  }
}

async function acquireLock(taskId: string, timeout: number): Promise<string> {
  const lockDir = `/tmp/claude-scheduler-${taskId}.lock`;

  try {
    await mkdir(lockDir);
  } catch {
    // Lock exists — check if stale
    const now = Math.floor(Date.now() / 1000);
    const mtime = await fileMtime(lockDir);
    const age = now - mtime;

    if (age > timeout + 60) {
      // Check if holding process is alive
      try {
        const pidStr = await readFile(path.join(lockDir, 'pid'), 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0);
            // Process is alive — skip
            throw new Error(`Task ${taskId} still running (PID ${pid}), skipping.`);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
            // Process is dead — stale lock
          }
        }
      } catch (e) {
        if ((e as Error).message.includes('skipping')) throw e;
        // No PID file or unreadable — treat as stale
      }

      // Remove stale lock and re-acquire
      await rm(lockDir, { recursive: true, force: true });
      try {
        await mkdir(lockDir);
      } catch {
        throw new Error(`Task ${taskId} already running, skipping.`);
      }
    } else {
      throw new Error(`Task ${taskId} already running, skipping.`);
    }
  }

  // Write PID file
  await writeFile(path.join(lockDir, 'pid'), String(process.pid), 'utf-8');
  return lockDir;
}

async function releaseLock(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

// --- Process Execution ---

interface SpawnResult {
  exitCode: number;
  timedOut: boolean;
}

function spawnClaude(
  command: string,
  options: {
    cwd: string;
    skipPermissions: boolean;
    env?: Record<string, string>;
    stdoutPath: string;
    stderrPath: string;
    timeout: number;
    appendSystemPrompt?: string;
    worktreeName?: string;
  },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const stdoutFd = openSync(options.stdoutPath, 'w');
    const stderrFd = openSync(options.stderrPath, 'w');

    const args = ['-p'];
    if (options.worktreeName) {
      args.push('--worktree', options.worktreeName);
    }
    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }
    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    args.push(command);

    const childEnv = { ...process.env, ...(options.env ?? {}) };
    const child = spawn('claude', args, {
      cwd: options.cwd,
      env: childEnv,
      stdio: ['ignore', stdoutFd, stderrFd],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, options.timeout * 1000);

    child.on('close', (code) => {
      clearTimeout(timer);
      closeSync(stdoutFd);
      closeSync(stderrFd);
      resolve({ exitCode: code ?? 1, timedOut });
    });

    child.on('error', () => {
      clearTimeout(timer);
      closeSync(stdoutFd);
      closeSync(stderrFd);
      resolve({ exitCode: 1, timedOut: false });
    });
  });
}

// --- Status Markers ---

async function writeStatus(logsDir: string, taskId: string, status: string): Promise<void> {
  await writeFile(path.join(logsDir, `${taskId}.status`), status, 'utf-8');
}

// --- Direct Execution ---

async function buildMemoryContext(
  task: ScheduledTask,
  stdoutPath: string,
): Promise<string | undefined> {
  const memory = task.execution.memory;
  if (!memory?.enabled) return undefined;

  const maxLines = memory.maxLines ?? 200;
  const maxChars = memory.maxChars ?? 4000;

  try {
    const prevOutput = await readLog(stdoutPath, maxLines);
    if (!prevOutput.trim()) return undefined;

    const truncated = prevOutput.length > maxChars
      ? '...(truncated)\n' + prevOutput.slice(-maxChars)
      : prevOutput;

    return (
      '[SCHEDULER CONTEXT] This is a recurring scheduled task. ' +
      'The output from your previous run is shown below. ' +
      'Focus on new or changed items only. Do not re-report items from the previous output.\n\n' +
      '--- Previous Run Output ---\n' + truncated + '\n--- End Previous Output ---'
    );
  } catch {
    return undefined;
  }
}

async function runDirect(
  task: ScheduledTask,
  logsDir: string,
): Promise<SpawnResult> {
  const logPaths = getLogPaths(logsDir, task.id, process.platform);
  const stdoutPath = logPaths.stdout ?? logPaths.combined ?? path.join(logsDir, `${task.id}.out.log`);
  const stderrPath = logPaths.stderr ?? path.join(logsDir, `${task.id}.err.log`);

  // Read previous output BEFORE createWriteStream truncates the file
  const appendSystemPrompt = await buildMemoryContext(task, stdoutPath);

  return spawnClaude(task.execution.command, {
    cwd: task.execution.workingDirectory,
    skipPermissions: task.execution.skipPermissions,
    env: task.execution.env,
    stdoutPath,
    stderrPath,
    timeout: task.execution.timeout,
    appendSystemPrompt,
  });
}

// --- Worktree Execution ---

async function runWorktree(
  task: ScheduledTask,
  logsDir: string,
): Promise<SpawnResult & { worktreePath?: string; worktreeBranch?: string; pushed?: boolean }> {
  const wt = task.execution.worktree!;
  const repoPath = wt.basePath ?? task.execution.workingDirectory;
  const worktreeName = generateWorktreeName(task.id);
  const worktreePath = getWorktreePath(repoPath, worktreeName);
  const branchName = deriveWorktreeBranchName(repoPath, worktreeName);

  // Claude CLI creates the worktree via --worktree flag (no manual createWorktree needed)

  try {
    const logPaths = getLogPaths(logsDir, task.id, process.platform);
    const stdoutPath = logPaths.stdout ?? logPaths.combined ?? path.join(logsDir, `${task.id}.out.log`);
    const stderrPath = logPaths.stderr ?? path.join(logsDir, `${task.id}.err.log`);

    // Read previous output BEFORE createWriteStream truncates the file
    const appendSystemPrompt = await buildMemoryContext(task, stdoutPath);

    const result = await spawnClaude(task.execution.command, {
      cwd: repoPath,
      skipPermissions: task.execution.skipPermissions,
      env: task.execution.env,
      stdoutPath,
      stderrPath,
      timeout: task.execution.timeout,
      appendSystemPrompt,
      worktreeName,
    });

    let pushed = false;
    if (result.exitCode === 0) {
      const pushResult = await commitAndPush({
        worktreePath,
        message: `Claude scheduled task: ${task.name}`,
        remoteName: wt.remoteName,
        branchName,
      });
      pushed = pushResult.pushed;
    }

    return { ...result, worktreePath, worktreeBranch: branchName, pushed };
  } finally {
    await removeWorktree(worktreePath, { cwd: repoPath });
  }
}

// --- Main Entry Point ---

export async function run(taskId: string): Promise<void> {
  const configPath = process.env.CLAUDE_SCHEDULER_CONFIG
    ?? path.join(os.homedir(), '.claude', 'schedules.json');

  const config = await loadConfig(configPath);
  const task = findTask(config, taskId);

  if (!task) {
    const logsDir = getLogsDir();
    await ensureLogsDir(logsDir);
    await writeStatus(logsDir, taskId, 'failure:config-error');
    process.exitCode = 1;
    console.error(`Task not found: ${taskId}`);
    return;
  }

  if (!task.enabled) {
    console.error(`Task disabled: ${taskId}`);
    return;
  }

  // Restore PATH if stored
  if ((task as Record<string, unknown>).userPath) {
    process.env.PATH = (task as Record<string, unknown>).userPath as string;
  }

  // Set custom env vars
  if (task.execution.env) {
    for (const [key, value] of Object.entries(task.execution.env)) {
      process.env[key] = value;
    }
  }

  const logsDir = getLogsDir();
  await ensureLogsDir(logsDir);

  let lockDir: string;
  try {
    lockDir = await acquireLock(task.id, task.execution.timeout);
  } catch (err) {
    console.error((err as Error).message);
    return;
  }

  const startedAt = new Date().toISOString();

  try {
    const isWorktree = task.execution.worktree?.enabled === true;
    let result: SpawnResult & { worktreePath?: string; worktreeBranch?: string; pushed?: boolean };

    if (isWorktree) {
      result = await runWorktree(task, logsDir);
    } else {
      result = await runDirect(task, logsDir);
    }

    // Write status marker
    if (result.timedOut) {
      await writeStatus(logsDir, task.id, 'failure:timeout');
    } else if (result.exitCode === 0) {
      await writeStatus(logsDir, task.id, 'success');
    } else {
      await writeStatus(logsDir, task.id, `failure:exit-${result.exitCode}`);
    }

    // Record execution history
    const completedAt = new Date().toISOString();
    const status = result.timedOut ? 'timeout' as const
      : result.exitCode === 0 ? 'success' as const
        : 'failure' as const;

    await recordExecution(getHistoryPath(), {
      id: crypto.randomUUID(),
      taskId: task.id,
      taskName: task.name,
      project: task.execution.workingDirectory,
      startedAt,
      completedAt,
      status,
      triggeredBy: 'scheduler',
      duration: (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
      exitCode: result.exitCode,
      cronExpression: task.trigger.type === 'cron' ? task.trigger.expression : undefined,
      worktreePath: result.worktreePath,
      worktreeBranch: result.worktreeBranch,
      worktreePushed: result.pushed,
    });

    process.exitCode = result.exitCode;
  } finally {
    await releaseLock(lockDir);
  }
}

// CLI entry point
if (process.argv[1] && (
  process.argv[1].endsWith('executor.js') ||
  process.argv[1].endsWith('claude-scheduler-executor.js')
)) {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error('Usage: claude-scheduler-executor <taskId>');
    process.exit(1);
  }
  run(taskId).catch((err) => {
    console.error(`Executor error: ${err.message}`);
    process.exit(1);
  });
}
