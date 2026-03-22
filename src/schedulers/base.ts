/**
 * Shared scheduler utilities and types.
 * Platform-specific schedulers (darwin, linux) build on these.
 */

import path from 'node:path';
import os from 'node:os';

export interface SchedulerTask {
  id: string;
  name: string;
  command: string;
  workingDirectory: string;
  timeout: number;
  skipPermissions: boolean;
  logsDir: string;
  userPath: string;
  cronExpression?: string;
}

/**
 * Get the path to the shared executor shim.
 */
export function getShimPath(): string {
  return path.join(os.homedir(), '.claude', 'bin', 'claude-scheduler-run');
}

/**
 * Get the execution command for the OS scheduler to invoke.
 * Returns the shared executor shim path with the task ID as argument.
 */
export function getExecutionCommand(task: SchedulerTask): string {
  return `${getShimPath()} ${task.id}`;
}

/**
 * Get the cron expression for a task, if it has one.
 */
export function getCronExpression(task: SchedulerTask): string | undefined {
  return task.cronExpression;
}
