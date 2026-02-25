/**
 * Linux (crontab) scheduler implementation.
 * Uses marker comments to identify and manage scheduler entries.
 */

import type { SchedulerTask } from './base.js';

export interface LinuxSchedulerTask extends SchedulerTask {
  wrapperScriptPath: string;
  timezone?: string;
}

const MARKER_PREFIX = 'claude-scheduler';

/**
 * Generate a complete crontab entry block for a task, wrapped in marker comments.
 */
export function generateCrontabLine(task: LinuxSchedulerTask): string {
  const lines: string[] = [];

  lines.push(`# ${MARKER_PREFIX}:${task.id}:begin`);

  // Environment variables
  lines.push(`PATH=${task.userPath}`);

  // Timezone prefix if set
  let cronLine = '';
  if (task.timezone) {
    cronLine += `TZ=${task.timezone} `;
  }

  // Cron expression + wrapper script
  cronLine += `${task.cronExpression} /bin/bash ${task.wrapperScriptPath}`;
  lines.push(cronLine);

  lines.push(`# ${MARKER_PREFIX}:${task.id}:end`);

  return lines.join('\n');
}

/**
 * Parse existing crontab content and extract task IDs managed by claude-scheduler.
 */
export function parseCrontabMarkers(crontab: string): string[] {
  const ids: string[] = [];
  const regex = new RegExp(`# ${MARKER_PREFIX}:([^:]+):begin`, 'g');
  let match;
  while ((match = regex.exec(crontab)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/**
 * Build new crontab content by adding/replacing/removing a task entry.
 *
 * - If task is provided, adds or replaces the entry for that task ID.
 * - If task is null and removeId is provided, removes that task's entry.
 * - Preserves all non-scheduler entries and entries for other tasks.
 */
export function buildCrontabContent(
  existingCrontab: string,
  task: LinuxSchedulerTask | null,
  removeId?: string,
): string {
  const targetId = task?.id ?? removeId;
  if (!targetId) return existingCrontab;

  // Split into lines and rebuild, skipping the target task's block
  const lines = existingCrontab.split('\n');
  const result: string[] = [];
  let insideTargetBlock = false;

  for (const line of lines) {
    if (line === `# ${MARKER_PREFIX}:${targetId}:begin`) {
      insideTargetBlock = true;
      continue;
    }
    if (line === `# ${MARKER_PREFIX}:${targetId}:end`) {
      insideTargetBlock = false;
      continue;
    }
    if (!insideTargetBlock) {
      result.push(line);
    }
  }

  // Remove trailing empty lines for clean output
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }

  // Add new task entry if we're adding/replacing (not just removing)
  if (task) {
    if (result.length > 0) {
      result.push(''); // blank separator
    }
    result.push(generateCrontabLine(task));
  }

  // Ensure trailing newline
  return result.join('\n') + '\n';
}
