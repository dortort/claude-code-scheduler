/**
 * CLI remove command: remove a task from config + unregister from OS scheduler.
 */

import {
  loadConfig,
  saveConfig,
  removeTask,
  findTask,
  getGlobalSchedulesPath,
} from '../../config.js';
import { killRunningTask } from '../lock.js';
import { unregisterTask } from '../platform.js';

export interface RemoveArgs {
  id: string;
}

export interface RemoveResult {
  success: boolean;
  taskId?: string;
  taskName?: string;
  configSaved: boolean;
  osUnregistered: boolean;
  processKilled: boolean;
  error?: string;
}

export async function remove(args: RemoveArgs): Promise<RemoveResult> {
  if (!args.id) {
    return {
      success: false,
      configSaved: false,
      osUnregistered: false,
      processKilled: false,
      error: 'Missing required argument: --id',
    };
  }

  const configPath = getGlobalSchedulesPath();
  const config = await loadConfig(configPath);
  const task = findTask(config, args.id);

  if (!task) {
    return {
      success: false,
      configSaved: false,
      osUnregistered: false,
      processKilled: false,
      error: `Task not found: ${args.id}`,
    };
  }

  // Kill any running process for this task
  let processKilled = false;
  try {
    processKilled = await killRunningTask(task.id);
  } catch {
    // Best-effort: don't fail removal if process kill fails
  }

  // Remove from config
  const updated = removeTask(config, task.id);
  await saveConfig(configPath, updated);

  // Unregister from OS
  try {
    await unregisterTask(task.id);
  } catch (err) {
    return {
      success: false,
      taskId: task.id,
      taskName: task.name,
      configSaved: true,
      osUnregistered: false,
      processKilled,
      error: (err as Error).message,
    };
  }

  return {
    success: true,
    taskId: task.id,
    taskName: task.name,
    configSaved: true,
    osUnregistered: true,
    processKilled,
  };
}
