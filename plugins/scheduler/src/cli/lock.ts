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
    if (!output) return false;

    const processStart = new Date(output).getTime();
    if (isNaN(processStart)) return false;

    return Math.abs(processStart - lockStartTime) < 5000;
  } catch {
    return false;
  }
}

/**
 * Report whether a live, identity-verified executor currently holds this
 * task's lock. Used by sync to avoid unloading/reloading a task's OS
 * registration while its job is mid-run — which would tear down the running
 * claude process. A dead or unverifiable lock reports false so a stale lock
 * never blocks re-registration indefinitely.
 */
export async function isTaskRunning(taskId: string): Promise<boolean> {
  const pid = await readLockPid(taskId);
  if (pid === null) return false;

  if (!(await verifyProcessIdentity(pid, taskId))) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killRunningTask(taskId: string): Promise<boolean> {
  const lockPath = getLockPath(taskId);
  const pid = await readLockPid(taskId);

  if (pid === null) return false;

  // Verify this is our executor process, not a PID-reuse collision.
  // If identity can't be verified, leave the lock intact to prevent
  // duplicate executions — the executor's releaseLock() will clean up.
  const isOurs = await verifyProcessIdentity(pid, taskId);
  if (!isOurs) {
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

  // Poll for exit with 200ms intervals, up to 10 seconds.
  // Do NOT force-kill (SIGKILL) — the executor may be in post-child cleanup
  // (commitAndPush, removeWorktree) which must complete to avoid leaking
  // worktrees. The top-level SIGTERM handler sets process.exitCode and lets
  // finally blocks finish naturally.
  const deadline = Date.now() + 10000;
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

  if (!alive) {
    await rm(lockPath, { recursive: true, force: true });
  }
  // If still alive after 10s, the executor is cleaning up — leave it running.
  // The lock will be released by the executor's own releaseLock() in its finally block.
  return true;
}
