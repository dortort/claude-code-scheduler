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
  error?: string;
}

export async function remove(args: RemoveArgs): Promise<RemoveResult> {
  if (!args.id) {
    return {
      success: false,
      configSaved: false,
      osUnregistered: false,
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
      error: `Task not found: ${args.id}`,
    };
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
      error: (err as Error).message,
    };
  }

  return {
    success: true,
    taskId: task.id,
    taskName: task.name,
    configSaved: true,
    osUnregistered: true,
  };
}
