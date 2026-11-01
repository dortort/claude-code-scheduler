/**
 * Platform-aware task registration.
 * Bridges ScheduledTask to platform-specific scheduler modules (darwin/linux).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec as defaultExec } from '../utils/exec.js';
import { writeFileAtomic } from '../utils/atomic.js';
import { getLogsDir } from '../config.js';
import {
  generatePlist,
  getPlistPath,
  LABEL_PREFIX,
  type DarwinSchedulerTask,
} from '../schedulers/darwin.js';
import {
  buildCrontabContent,
  type LinuxSchedulerTask,
} from '../schedulers/linux.js';
import { timestampToCron } from '../cron/parser.js';
import { getCliShimPath } from './commands/init.js';
import type { ScheduledTask } from '../types.js';

/**
 * Register a task with the OS scheduler, pointing to the shared executor shim.
 */
export async function registerTask(task: ScheduledTask, shimPath: string): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    await registerDarwin(task, shimPath);
  } else if (platform === 'linux') {
    await registerLinux(task, shimPath);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Unregister a task from the OS scheduler.
 */
export async function unregisterTask(taskId: string): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    await unregisterDarwin(taskId);
  } else if (platform === 'linux') {
    await unregisterLinux(taskId);
  }
}

// --- Darwin (macOS) ---

async function registerDarwin(task: ScheduledTask, shimPath: string): Promise<void> {
  const logsDir = getLogsDir();
  const cronExpr = task.trigger.type === 'cron' ? task.trigger.expression : undefined;

  const darwinTask: DarwinSchedulerTask = {
    id: task.id,
    name: task.name,
    command: task.execution.command,
    workingDirectory: task.execution.workingDirectory,
    timeout: task.execution.timeout,
    skipPermissions: task.execution.skipPermissions,
    logsDir,
    userPath: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    wrapperScriptPath: shimPath,
    programArgs: ['/bin/bash', shimPath, task.id],
    cronExpression: cronExpr,
    runAtLoad: task.trigger.type === 'once',
    timezone: task.trigger.timezone !== 'local' ? task.trigger.timezone : undefined,
  };

  const plistContent = generatePlist(darwinTask);
  const plistPath = getPlistPath(task.id);

  // Unload existing if present (ignore errors)
  try {
    await defaultExec('launchctl', ['unload', plistPath]);
  } catch { /* not loaded */ }

  await writeFileAtomic(plistPath, plistContent);
  await defaultExec('launchctl', ['load', plistPath]);

  // Ensure daily auto-sync job exists when registering timezone-aware tasks
  if (darwinTask.timezone) {
    await ensureTzSyncJob();
  }
}

async function unregisterDarwin(taskId: string): Promise<void> {
  const plistPath = getPlistPath(taskId);
  try {
    await defaultExec('launchctl', ['unload', plistPath]);
  } catch { /* not loaded */ }
  try {
    await fs.unlink(plistPath);
  } catch { /* doesn't exist */ }
}

const TZ_SYNC_LABEL = `${LABEL_PREFIX}.tz-sync`;

function getTzSyncPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${TZ_SYNC_LABEL}.plist`);
}

/**
 * Register a daily auto-sync launchd job that re-registers timezone-aware tasks.
 * Runs at 3am local time daily to catch DST transitions.
 */
async function ensureTzSyncJob(): Promise<void> {
  const cliShimPath = getCliShimPath();
  const logsDir = getLogsDir();
  const plistPath = getTzSyncPlistPath();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${TZ_SYNC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${cliShimPath}</string>
    <string>sync</string>
  </array>
  <key>StandardOutPath</key>
  <string>${logsDir}/tz-sync.out.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/tz-sync.err.log</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Hour</key>
      <integer>3</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
  </array>
</dict>
</plist>
`;

  try {
    await defaultExec('launchctl', ['unload', plistPath]);
  } catch { /* not loaded */ }

  await writeFileAtomic(plistPath, plist);
  await defaultExec('launchctl', ['load', plistPath]);
}

/**
 * Remove the daily auto-sync launchd job.
 */
export async function removeTzSyncJob(): Promise<void> {
  const plistPath = getTzSyncPlistPath();
  try {
    await defaultExec('launchctl', ['unload', plistPath]);
  } catch { /* not loaded */ }
  try {
    await fs.unlink(plistPath);
  } catch { /* doesn't exist */ }
}

// --- Linux ---

async function registerLinux(task: ScheduledTask, shimPath: string): Promise<void> {
  const logsDir = getLogsDir();
  const cronExpr = task.trigger.type === 'cron'
    ? task.trigger.expression
    : task.trigger.type === 'once'
      ? timestampToCron(task.trigger.timestamp)
      : undefined;

  const linuxTask: LinuxSchedulerTask = {
    id: task.id,
    name: task.name,
    command: task.execution.command,
    workingDirectory: task.execution.workingDirectory,
    timeout: task.execution.timeout,
    skipPermissions: task.execution.skipPermissions,
    logsDir,
    userPath: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    wrapperScriptPath: `${shimPath} ${task.id}`,
    cronExpression: cronExpr,
    timezone: task.trigger.timezone !== 'local' ? task.trigger.timezone : undefined,
  };

  let existingCrontab = '';
  try {
    const result = await defaultExec('crontab', ['-l']);
    existingCrontab = result.stdout;
  } catch { /* no crontab */ }

  const newCrontab = buildCrontabContent(existingCrontab, linuxTask);
  const tmpFile = `/tmp/crontab-scheduler-${process.pid}`;
  await fs.writeFile(tmpFile, newCrontab, 'utf-8');
  await defaultExec('crontab', [tmpFile]);
  await fs.unlink(tmpFile);
}

async function unregisterLinux(taskId: string): Promise<void> {
  let existingCrontab: string;
  try {
    const result = await defaultExec('crontab', ['-l']);
    existingCrontab = result.stdout;
  } catch { return; /* no crontab */ }

  const newCrontab = buildCrontabContent(existingCrontab, null, taskId);
  const tmpFile = `/tmp/crontab-scheduler-${process.pid}`;
  await fs.writeFile(tmpFile, newCrontab, 'utf-8');
  await defaultExec('crontab', [tmpFile]);
  await fs.unlink(tmpFile);
}
