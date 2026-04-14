/**
 * Sync command: reconcile OS scheduler registrations from config.
 * Re-registers all enabled tasks with the OS scheduler pointing to the shared executor.
 */

import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, saveConfig, updateTask, getGlobalSchedulesPath, getLogsDir } from '../../config.js';
import { getShimPath, ensureExecutorInstalled, resolveClaudeBin } from './init.js';
import { unregisterTask } from '../platform.js';
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
  let config = await loadConfig(configPath);

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

  // Re-resolve claude binary path on every sync so it stays current
  // across upgrades, reinstalls, and PATH changes.
  const claudeBin = await resolveClaudeBin();
  if (claudeBin && config.settings?.claudeBin !== claudeBin) {
    const defaults = { defaultTimezone: 'local', logRetentionDays: 30, maxExecutionHistory: 100 };
    config = {
      ...config,
      settings: { ...defaults, ...config.settings, claudeBin },
    };
    await saveConfig(configPath, config);
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

/**
 * Process .done markers left by once-task executor runs.
 * Disables the task in config, unregisters from OS, and removes the marker.
 */
export async function syncOnce(options?: { configPath?: string; logsDir?: string }): Promise<void> {
  const logsDir = options?.logsDir ?? getLogsDir();
  const configPath = options?.configPath ?? getGlobalSchedulesPath();

  let files: string[];
  try {
    files = await readdir(logsDir);
  } catch {
    return; // No logs dir yet
  }

  const doneFiles = files.filter(f => f.endsWith('.done'));
  if (doneFiles.length === 0) return;

  let config = await loadConfig(configPath);

  for (const file of doneFiles) {
    const taskId = file.replace(/\.done$/, '');
    const task = config.tasks.find(t => t.id === taskId);

    if (task) {
      config = updateTask(config, taskId, { enabled: false });
      await saveConfig(configPath, config);
      try {
        await unregisterTask(taskId);
      } catch {
        // Ignore — may already be unregistered
      }
    }

    // Always remove the marker
    await unlink(path.join(logsDir, file)).catch(() => {});
  }
}
