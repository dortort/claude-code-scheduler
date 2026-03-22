/**
 * CLI update command: modify a task's config and re-register with OS if schedule changed.
 */

import {
  loadConfig,
  saveConfig,
  updateTask,
  findTask,
  getGlobalSchedulesPath,
} from '../../config.js';
import { registerTask } from '../platform.js';
import { getShimPath } from './init.js';
import type { ScheduledTask } from '../../types.js';

export interface UpdateArgs {
  id: string;
  cron?: string;
  command?: string;
  timeout?: number;
  enabled?: boolean;
  name?: string;
  description?: string;
}

export interface UpdateResult {
  success: boolean;
  taskId?: string;
  configSaved: boolean;
  osReregistered: boolean;
  error?: string;
}

export async function update(args: UpdateArgs): Promise<UpdateResult> {
  if (!args.id) {
    return {
      success: false,
      configSaved: false,
      osReregistered: false,
      error: 'Missing required argument: --id',
    };
  }

  const configPath = getGlobalSchedulesPath();
  const config = await loadConfig(configPath);
  const existing = findTask(config, args.id);

  if (!existing) {
    return {
      success: false,
      configSaved: false,
      osReregistered: false,
      error: `Task not found: ${args.id}`,
    };
  }

  // Build updates
  const updates: Partial<Pick<ScheduledTask, 'name' | 'description' | 'enabled' | 'trigger' | 'execution'>> = {};

  if (args.name !== undefined) updates.name = args.name;
  if (args.description !== undefined) updates.description = args.description;
  if (args.enabled !== undefined) updates.enabled = args.enabled;

  if (args.cron !== undefined) {
    updates.trigger = { type: 'cron', expression: args.cron, timezone: existing.trigger.timezone };
  }

  if (args.command !== undefined || args.timeout !== undefined) {
    updates.execution = {
      ...existing.execution,
      ...(args.command !== undefined ? { command: args.command } : {}),
      ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
    };
  }

  const updated = updateTask(config, existing.id, updates);
  await saveConfig(configPath, updated);

  // Re-register with OS only if schedule changed
  const scheduleChanged = args.cron !== undefined || args.enabled !== undefined;
  let osReregistered = false;

  if (scheduleChanged) {
    const updatedTask = findTask(updated, existing.id)!;
    try {
      await registerTask(updatedTask, getShimPath());
      osReregistered = true;
    } catch (err) {
      return {
        success: false,
        taskId: existing.id,
        configSaved: true,
        osReregistered: false,
        error: (err as Error).message,
      };
    }
  }

  return {
    success: true,
    taskId: existing.id,
    configSaved: true,
    osReregistered,
  };
}
