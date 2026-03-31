import { readFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import path from 'node:path';

export function getLockPath(taskId: string): string {
  return `/tmp/claude-scheduler-${taskId}.lock`;
}

export async function readLockPid(taskId: string): Promise<number | null> {
  const lockPath = getLockPath(taskId);
  try {
    const pidStr = await readFile(path.join(lockPath, 'pid'), 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

async function readLockStartTime(taskId: string): Promise<number | null> {
  const lockPath = getLockPath(taskId);
  try {
    const str = await readFile(path.join(lockPath, 'startTime'), 'utf-8');
    const ts = parseInt(str.trim(), 10);
    if (isNaN(ts)) return null;
    return ts;
  } catch {
    return null;
  }
}

/**
 * Verify that the process at `pid` was started at approximately the same
 * time as recorded in the lock file. This prevents killing an unrelated
 * process that reused the PID after a crash or reboot.
 *
 * Falls back to true (allow kill) if start time can't be determined,
 * since older lock files may not have a startTime file.
 */
async function verifyProcessIdentity(pid: number, taskId: string): Promise<boolean> {
  const lockStartTime = await readLockStartTime(taskId);
  if (lockStartTime === null) return true; // legacy lock without startTime

  // Get process start time via ps (macOS/Linux)
  try {
    const { execSync } = await import('node:child_process');
    const output = execSync(`ps -o lstart= -p ${pid} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (!output) return true; // can't determine, allow kill

    const processStart = new Date(output).getTime();
    if (isNaN(processStart)) return true; // can't parse, allow kill

    // Allow 5-second tolerance for startup delay between lock write and ps
    return Math.abs(processStart - lockStartTime) < 5000;
  } catch {
    // ps failed (process may not exist) — let the caller handle via kill(pid, 0)
    return true;
  }
}

export async function killRunningTask(taskId: string): Promise<boolean> {
  const lockPath = getLockPath(taskId);
  const pid = await readLockPid(taskId);

  if (pid === null) return false;

  // Check if process is alive
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      await rm(lockPath, { recursive: true, force: true });
      return false;
    }
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`Permission denied when checking process ${pid} for task ${taskId}`, { cause: e });
    }
    throw e;
  }

  // Verify this is actually our executor process, not a PID-reuse collision
  const isOurs = await verifyProcessIdentity(pid, taskId);
  if (!isOurs) {
    // Stale lock with reused PID — clean up lock but don't kill
    await rm(lockPath, { recursive: true, force: true });
    return false;
  }

  // Send SIGTERM to the executor process only (not process group).
  // The executor has SIGTERM handlers that kill its child claude process
  // and allow finally blocks (worktree cleanup) to execute.
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`Permission denied when killing process ${pid} for task ${taskId}`, { cause: e });
    }
    // ESRCH: already dead, continue to cleanup
  }

  // Wait 5 seconds for graceful shutdown (executor needs time for worktree cleanup)
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check if still alive
  try {
    process.kill(pid, 0);
    // Still alive — force kill
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`Permission denied when sending SIGKILL to process ${pid} for task ${taskId}`, { cause: e });
      }
      // ESRCH: already dead
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    // Already dead — fine
  }

  // Clean up lock if process is confirmed dead
  try {
    process.kill(pid, 0);
  } catch {
    await rm(lockPath, { recursive: true, force: true });
  }

  return true;
}
