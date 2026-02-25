/**
 * Shared scheduler utilities and types.
 * Platform-specific schedulers (darwin, linux) build on these.
 */

import path from 'node:path';

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
 * Get the path to the wrapper script for a task.
 * Wrapper scripts are stored alongside log files.
 */
export function getExecutionCommand(task: SchedulerTask): string {
  return path.join(task.logsDir, `${task.id}.sh`);
}

/**
 * Get the cron expression for a task, if it has one.
 */
export function getCronExpression(task: SchedulerTask): string | undefined {
  return task.cronExpression;
}
