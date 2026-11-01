/**
 * Tests for isTaskRunning: does a live, identity-verified executor hold the lock?
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { getLockPath, isTaskRunning } from '../../cli/lock.js';

let counter = 0;
const created: string[] = [];
const children: ChildProcess[] = [];

function uniqueTaskId(): string {
  const id = `lock-test-${process.pid}-${counter++}`;
  created.push(getLockPath(id));
  return id;
}

async function writeLock(taskId: string, pid: number, startTime?: number): Promise<void> {
  const dir = getLockPath(taskId);
  await mkdir(dir, { recursive: true });
  if (startTime !== undefined) {
    await writeFile(path.join(dir, 'startTime'), String(startTime), 'utf-8');
  }
  await writeFile(path.join(dir, 'pid'), String(pid), 'utf-8');
}

function spawnLiveChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && !child.killed) child.kill('SIGKILL');
  }
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('isTaskRunning', () => {
  it('returns false when no lock exists', async () => {
    expect(await isTaskRunning(uniqueTaskId())).toBe(false);
  });

  it('returns false when the lock has no startTime (unverifiable)', async () => {
    const taskId = uniqueTaskId();
    await writeLock(taskId, process.pid); // alive pid, but no startTime
    expect(await isTaskRunning(taskId)).toBe(false);
  });

  it('returns false when the locked process is dead', async () => {
    const taskId = uniqueTaskId();
    const child = spawnLiveChild();
    const pid = child.pid!;
    const startTime = Date.now();
    child.kill('SIGKILL');
    await waitUntilDead(pid);
    await writeLock(taskId, pid, startTime);
    expect(await isTaskRunning(taskId)).toBe(false);
  });

  it('returns true for a live, identity-verified process', async () => {
    const taskId = uniqueTaskId();
    const child = spawnLiveChild();
    const startTime = Date.now();
    await new Promise(r => setTimeout(r, 100)); // let ps see the process
    await writeLock(taskId, child.pid!, startTime);

    expect(await isTaskRunning(taskId)).toBe(true);

    child.kill('SIGKILL');
    await waitUntilDead(child.pid!);
    expect(await isTaskRunning(taskId)).toBe(false);
  });
});
