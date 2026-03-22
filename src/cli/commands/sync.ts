/**
 * Sync command: reconcile OS scheduler registrations from config.
 * Re-registers all enabled tasks with the OS scheduler pointing to the shared executor.
 */

import { loadConfig, getGlobalSchedulesPath } from '../../config.js';
import { getShimPath, ensureExecutorInstalled } from './init.js';
import type { ScheduledTask } from '../../types.js';

export interface SyncResult {
  success: boolean;
  synced: string[];
  skipped: string[];
  errors: Array<{ taskId: string; error: string }>;
}

export interface OSRegistration {
  register(task: ScheduledTask, shimPath: string): Promise<void>;
  unregister(taskId: string): Promise<void>;
}

/**
 * Sync all enabled tasks with the OS scheduler.
 * Uses the provided registration functions for testability.
 */
export async function sync(
  register: (task: ScheduledTask, shimPath: string) => Promise<void>,
  options?: { taskId?: string; configPath?: string },
): Promise<SyncResult> {
  const configPath = options?.configPath ?? getGlobalSchedulesPath();
  const config = await loadConfig(configPath);

  // Ensure executor is installed
  const initResult = await ensureExecutorInstalled();
  if (!initResult.success) {
    return {
      success: false,
      synced: [],
      skipped: [],
      errors: [{ taskId: '*', error: `Failed to install executor: ${initResult.error}` }],
    };
  }

  const shimPath = getShimPath();
  const synced: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ taskId: string; error: string }> = [];

  const tasks = options?.taskId
    ? config.tasks.filter(t => t.id === options.taskId)
    : config.tasks;

  for (const task of tasks) {
    if (!task.enabled) {
      skipped.push(task.id);
      continue;
    }

    try {
      await register(task, shimPath);
      synced.push(task.id);
    } catch (err) {
      errors.push({ taskId: task.id, error: (err as Error).message });
    }
  }

  return {
    success: errors.length === 0,
    synced,
    skipped,
    errors,
  };
}
