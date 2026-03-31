import { readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function getLockPath(taskId: string): string {
  return `/tmp/claude-scheduler-${taskId}.lock`;
}

async function readLockNumber(taskId: string, file: string): Promise<number | null> {
  try {
    const str = await readFile(path.join(getLockPath(taskId), file), 'utf-8');
    const n = parseInt(str.trim(), 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export async function readLockPid(taskId: string): Promise<number | null> {
  return readLockNumber(taskId, 'pid');
}

async function readLockStartTime(taskId: string): Promise<number | null> {
  return readLockNumber(taskId, 'startTime');
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/**
 * Verify that the process at `pid` was started at approximately the same
 * time as recorded in the lock file. This prevents killing an unrelated
 * process that reused the PID after a crash or reboot.
 *
 * Returns false (don't kill) if the lock has no startTime, since legacy
 * locks from before this change can't be verified and may have reused PIDs.
 */
async function verifyProcessIdentity(pid: number, taskId: string): Promise<boolean> {
  const lockStartTime = await readLockStartTime(taskId);
  if (lockStartTime === null) return false;

  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) return true;

    const processStart = new Date(output).getTime();
    if (isNaN(processStart)) return true;

    return Math.abs(processStart - lockStartTime) < 5000;
  } catch {
    return true;
  }
}

export async function killRunningTask(taskId: string): Promise<boolean> {
  const lockPath = getLockPath(taskId);
  const pid = await readLockPid(taskId);

  if (pid === null) return false;

  // Verify this is our executor process, not a PID-reuse collision
  const isOurs = await verifyProcessIdentity(pid, taskId);
  if (!isOurs) {
    await rm(lockPath, { recursive: true, force: true });
    return false;
  }

  // Check if process is still alive after identity verification
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (errnoCode(e) === 'ESRCH') {
      await rm(lockPath, { recursive: true, force: true });
      return false;
    }
    if (errnoCode(e) === 'EPERM') {
      throw new Error(`Permission denied when checking process ${pid} for task ${taskId}`, { cause: e });
    }
    throw e;
  }

  // Send SIGTERM to the executor process only (not process group).
  // The executor has SIGTERM handlers that kill its child claude process
  // and allow finally blocks (worktree cleanup) to execute.
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (errnoCode(e) === 'EPERM') {
      throw new Error(`Permission denied when killing process ${pid} for task ${taskId}`, { cause: e });
    }
  }

  // Poll for exit with 200ms intervals, up to 5 seconds
  const deadline = Date.now() + 5000;
  let alive = true;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
  }

  // Force kill if still alive
  if (alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      if (errnoCode(e) === 'EPERM') {
        throw new Error(`Permission denied when sending SIGKILL to process ${pid} for task ${taskId}`, { cause: e });
      }
    }
    // Brief yield for kernel to reap
    await new Promise(r => setTimeout(r, 100));
  }

  // Clean up stale lock
  await rm(lockPath, { recursive: true, force: true });
  return true;
}
