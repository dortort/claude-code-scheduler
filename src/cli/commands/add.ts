/**
 * CLI add command: create a task + register with OS scheduler atomically.
 */

import {
  loadConfig,
  saveConfig,
  addTask,
  getGlobalSchedulesPath,
} from '../../config.js';
import { createTask } from '../../types.js';
import { ensureExecutorInstalled, getShimPath } from './init.js';
import { registerTask } from '../platform.js';

export interface AddArgs {
  name: string;
  cron: string;
  command: string;
  workingDirectory: string;
  timeout?: number;
  skipPermissions?: boolean;
  description?: string;
  memory?: boolean;
}

export interface AddResult {
  success: boolean;
  task?: { id: string; name: string };
  configSaved: boolean;
  osRegistered: boolean;
  error?: string;
}

export async function add(args: AddArgs): Promise<AddResult> {
  if (!args.name || !args.cron || !args.command || !args.workingDirectory) {
    return {
      success: false,
      configSaved: false,
      osRegistered: false,
      error: 'Missing required arguments: --name, --cron, --command, --working-directory',
    };
  }

  // Ensure executor is installed
  const initResult = await ensureExecutorInstalled();
  if (!initResult.success) {
    return {
      success: false,
      configSaved: false,
      osRegistered: false,
      error: `Failed to install executor: ${initResult.error}`,
    };
  }

  const task = createTask({
    name: args.name,
    description: args.description,
    trigger: { type: 'cron', expression: args.cron, timezone: 'local' },
    execution: {
      command: args.command,
      workingDirectory: args.workingDirectory,
      timeout: args.timeout ?? 300,
      skipPermissions: args.skipPermissions ?? false,
      memory: args.memory ? { enabled: true } : undefined,
    },
  });

  const configPath = getGlobalSchedulesPath();
  const config = await loadConfig(configPath);
  const updated = addTask(config, task);
  await saveConfig(configPath, updated);

  try {
    await registerTask(task, getShimPath());
  } catch (err) {
    return {
      success: false,
      task: { id: task.id, name: task.name },
      configSaved: true,
      osRegistered: false,
      error: (err as Error).message,
    };
  }

  return {
    success: true,
    task: { id: task.id, name: task.name },
    configSaved: true,
    osRegistered: true,
  };
}
