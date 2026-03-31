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

  // Send SIGTERM to the executor process only (not process group).
  // The executor has a SIGTERM handler that kills its child claude process
  // and exits normally, allowing finally blocks (worktree cleanup) to run.
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

  // Don't remove the lock dir here — the executor's releaseLock() handles it
  // during graceful shutdown. Only clean up if the process is confirmed dead.
  try {
    process.kill(pid, 0);
  } catch {
    // Process is dead, safe to clean up stale lock
    await rm(lockPath, { recursive: true, force: true });
  }

  return true;
}
