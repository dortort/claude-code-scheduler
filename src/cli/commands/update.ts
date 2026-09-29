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
import { registerTask, unregisterTask } from '../platform.js';
import { getShimPath } from './init.js';
import { EFFORT_LEVELS, type ScheduledTask, type EffortLevel } from '../../types.js';

export interface UpdateArgs {
  id: string;
  cron?: string;
  command?: string;
  timeout?: number;
  enabled?: boolean;
  name?: string;
  description?: string;
  memory?: boolean;
  /** Model alias or ID for `claude --model`. Empty string clears it (user's default applies). */
  model?: string;
  /** Effort level for `claude --effort`. Empty string clears it (user's default applies). */
  effort?: string;
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

  const effort = args.effort?.trim();
  if (effort !== undefined && effort !== '' && !isEffortLevel(effort)) {
    return {
      success: false,
      configSaved: false,
      osReregistered: false,
      error: `Invalid --effort "${args.effort}". Must be one of: ${EFFORT_LEVELS.join(', ')}`,
    };
  }
  const model = args.model?.trim();

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

  if (
    args.command !== undefined || args.timeout !== undefined || args.memory !== undefined ||
    model !== undefined || effort !== undefined
  ) {
    updates.execution = {
      ...existing.execution,
      ...(args.command !== undefined ? { command: args.command } : {}),
      ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
      ...(args.memory !== undefined ? { memory: { enabled: args.memory, maxLines: 200, maxChars: 4000 } } : {}),
      // An empty value clears the field so the user's Claude defaults apply again.
      ...(model !== undefined ? { model: model || undefined } : {}),
      ...(effort !== undefined ? { effort: (effort || undefined) as EffortLevel | undefined } : {}),
    };
  }

  const updated = updateTask(config, existing.id, updates);
  await saveConfig(configPath, updated);

  // Sync with OS scheduler based on enabled/cron changes
  const cronChanged = args.cron !== undefined;
  let osReregistered = false;

  if (args.enabled === false) {
    // Disabling: unregister from OS scheduler
    try {
      await unregisterTask(existing.id);
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
  } else if (args.enabled === true || cronChanged) {
    // Enabling or cron changed: register with OS scheduler
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

function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}
