/**
 * CLI migrate command: re-register existing tasks to use the shared executor
 * and remove old per-task wrapper scripts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, getGlobalSchedulesPath, getLogsDir } from '../../config.js';
import { ensureExecutorInstalled, getShimPath } from './init.js';
import { registerTask } from '../platform.js';

export interface MigrateResult {
  success: boolean;
  migrated: string[];
  skipped: string[];
  removedScripts: string[];
  errors: Array<{ taskId: string; error: string }>;
}

export async function migrate(): Promise<MigrateResult> {
  const initResult = await ensureExecutorInstalled();
  if (!initResult.success) {
    return {
      success: false,
      migrated: [],
      skipped: [],
      removedScripts: [],
      errors: [{ taskId: '*', error: `Failed to install executor: ${initResult.error}` }],
    };
  }

  const configPath = getGlobalSchedulesPath();
  const config = await loadConfig(configPath);
  const shimPath = getShimPath();
  const logsDir = getLogsDir();

  const migrated: string[] = [];
  const skipped: string[] = [];
  const removedScripts: string[] = [];
  const errors: Array<{ taskId: string; error: string }> = [];

  for (const task of config.tasks) {
    if (!task.enabled) {
      skipped.push(task.id);
      continue;
    }

    // Re-register with OS scheduler pointing to shared executor
    try {
      await registerTask(task, shimPath);
      migrated.push(task.id);
    } catch (err) {
      errors.push({ taskId: task.id, error: (err as Error).message });
    }

    // Remove old per-task wrapper script if it exists
    const oldScript = path.join(logsDir, `${task.id}.sh`);
    try {
      await fs.unlink(oldScript);
      removedScripts.push(oldScript);
    } catch {
      // Script doesn't exist — already migrated or never created
    }
  }

  return {
    success: errors.length === 0,
    migrated,
    skipped,
    removedScripts,
    errors,
  };
}
