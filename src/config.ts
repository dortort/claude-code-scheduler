/**
 * Configuration layer for schedule management.
 * Handles load/save/merge of schedules.json files with trust boundary enforcement.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  SchedulesConfigSchema,
  SchedulesConfigSchemaStrict,
  createEmptyConfig,
  type SchedulesConfig,
  type ScheduledTask,
} from './types.js';
import { isSafeIdentifier } from './utils/shell.js';

// --- Path Resolution ---

export function getGlobalSchedulesPath(): string {
  return path.join(os.homedir(), '.claude', 'schedules.json');
}

export function getProjectSchedulesPath(projectPath: string): string {
  return path.join(projectPath, '.claude', 'schedules.json');
}

export function getLogsDir(): string {
  return path.join(os.homedir(), '.claude', 'logs');
}

export function getHistoryPath(): string {
  return path.join(os.homedir(), '.claude', 'execution-history.jsonl');
}

/**
 * Get the session ID file path for a task.
 * Validates taskId to prevent path traversal.
 */
export function getSessionIdPath(taskId: string): string {
  if (!isSafeIdentifier(taskId)) {
    throw new Error(`Invalid task ID: ${taskId}`);
  }
  return path.join(getLogsDir(), `${taskId}.session`);
}

// --- Load / Save ---

/**
 * Load config from a file path. Returns empty config on any error (missing, corrupt, invalid).
 */
export async function loadConfig(filePath: string): Promise<SchedulesConfig> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return SchedulesConfigSchema.parse(data);
  } catch {
    return createEmptyConfig();
  }
}

/**
 * Save config to a file path. Validates before writing. Creates parent dirs if needed.
 * Uses temp-file-then-rename for atomic writes (no partial writes on crash).
 */
export async function saveConfig(filePath: string, config: SchedulesConfig): Promise<void> {
  // Validate before writing (strict: rejects invalid cron + relative paths)
  SchedulesConfigSchemaStrict.parse(config);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.schedules.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpPath, filePath);
}

// --- Merge ---

interface MergedConfigResult {
  global: SchedulesConfig;
  project: SchedulesConfig;
  merged: SchedulesConfig;
}

/**
 * Load and merge global + project configs.
 * Trust boundary enforcement:
 * - Global tasks always win on ID collision (project tasks with colliding IDs are dropped)
 * - skipPermissions is stripped from all project tasks
 */
export async function loadMergedConfig(
  projectPath: string,
  globalPath?: string,
): Promise<MergedConfigResult> {
  const resolvedGlobalPath = globalPath ?? getGlobalSchedulesPath();
  const projectConfigPath = getProjectSchedulesPath(projectPath);

  const global = await loadConfig(resolvedGlobalPath);
  const project = await loadConfig(projectConfigPath);

  // Collect global task IDs
  const globalTaskIds = new Set(global.tasks.map(t => t.id));

  // Sanitize project tasks: strip skipPermissions, drop colliding IDs
  const sanitizedProjectTasks: ScheduledTask[] = [];
  for (const task of project.tasks) {
    if (globalTaskIds.has(task.id)) {
      // Global wins on ID collision - silently drop project task
      console.warn(`[claude-scheduler] Project task "${task.name}" (${task.id}) dropped: collides with global task ID`);
      continue;
    }
    // Strip skipPermissions from project tasks (trust boundary)
    if (task.execution.skipPermissions) {
      console.warn(`[claude-scheduler] Stripping skipPermissions from project task "${task.name}"`);
    }
    sanitizedProjectTasks.push({
      ...task,
      execution: {
        ...task.execution,
        skipPermissions: false,
      },
    });
  }

  const merged: SchedulesConfig = {
    version: 1,
    tasks: [...global.tasks, ...sanitizedProjectTasks],
    settings: global.settings ?? project.settings,
  };

  return { global, project, merged };
}

// --- CRUD Operations ---

/**
 * Add a task to config. Throws if task ID already exists.
 * Returns a new config (does not mutate).
 */
export function addTask(config: SchedulesConfig, task: ScheduledTask): SchedulesConfig {
  if (config.tasks.some(t => t.id === task.id)) {
    throw new Error(`Duplicate task ID: ${task.id}`);
  }
  return {
    ...config,
    tasks: [...config.tasks, task],
  };
}

/**
 * Update a task in config. Throws if task not found. Auto-updates `updatedAt`.
 * Returns a new config (does not mutate).
 */
export function updateTask(
  config: SchedulesConfig,
  taskId: string,
  updates: Partial<Pick<ScheduledTask, 'name' | 'description' | 'enabled' | 'trigger' | 'execution' | 'tags'>>,
): SchedulesConfig {
  const index = config.tasks.findIndex(t => t.id === taskId);
  if (index === -1) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const updated: ScheduledTask = {
    ...config.tasks[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  const tasks = [...config.tasks];
  tasks[index] = updated;
  return { ...config, tasks };
}

/**
 * Remove a task from config. Throws if task not found.
 * Returns a new config (does not mutate).
 */
export function removeTask(config: SchedulesConfig, taskId: string): SchedulesConfig {
  const index = config.tasks.findIndex(t => t.id === taskId);
  if (index === -1) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return {
    ...config,
    tasks: config.tasks.filter(t => t.id !== taskId),
  };
}

/**
 * Find a task by ID or name (case-insensitive). ID match takes priority.
 */
export function findTask(config: SchedulesConfig, idOrName: string): ScheduledTask | undefined {
  // Try ID match first
  const byId = config.tasks.find(t => t.id === idOrName);
  if (byId) return byId;

  // Fall back to case-insensitive name match
  const lowerSearch = idOrName.toLowerCase();
  return config.tasks.find(t => t.name.toLowerCase() === lowerSearch);
}
