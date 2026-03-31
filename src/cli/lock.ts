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

  // Send SIGTERM to process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`Permission denied when killing process group ${pid} for task ${taskId}`, { cause: e });
    }
    // ESRCH: already dead, continue to cleanup
  }

  // Wait 3 seconds
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check if still alive
  try {
    process.kill(pid, 0);
    // Still alive — send SIGKILL
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`Permission denied when sending SIGKILL to process group ${pid} for task ${taskId}`, { cause: e });
      }
      // ESRCH: already dead
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    // Already dead — fine
  }

  await rm(lockPath, { recursive: true, force: true });
  return true;
}
