/**
 * Core type definitions using Zod schemas.
 * All data structures are validated at every load/save boundary.
 */

import { z } from 'zod';
import crypto from 'node:crypto';

// --- Environment Variable Security ---

export const BLOCKED_ENV_VARS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
] as const;

function validateEnvVars(env: Record<string, string>): boolean {
  for (const key of Object.keys(env)) {
    if (BLOCKED_ENV_VARS.includes(key as typeof BLOCKED_ENV_VARS[number])) {
      return false;
    }
  }
  return true;
}

// --- Trigger Schemas ---

const CronTriggerSchema = z.object({
  type: z.literal('cron'),
  expression: z.string().min(1),
  timezone: z.string().default('local'),
});

const OnceTriggerSchema = z.object({
  type: z.literal('once'),
  timestamp: z.string().datetime(),
  timezone: z.string().default('local'),
});

export const TriggerSchema = z.discriminatedUnion('type', [
  CronTriggerSchema,
  OnceTriggerSchema,
]);

export type Trigger = z.infer<typeof TriggerSchema>;

// --- Worktree Config ---

const WorktreeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  basePath: z.string().optional(),
  branchPrefix: z.string().optional(), // Deprecated: branch naming controlled by Claude CLI --worktree
  remoteName: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'Remote name must be alphanumeric with dots, hyphens, underscores').default('origin'),
});

// --- Execution Config ---

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxLines: z.number().int().positive().default(200),
  maxChars: z.number().int().positive().default(4000),
});

export const ExecutionConfigSchema = z.object({
  command: z.string().min(1, 'Command must not be empty'),
  workingDirectory: z.string().min(1),
  timeout: z.number().int().positive().default(300),
  env: z.record(z.string(), z.string()).optional().refine(
    (env) => env === undefined || validateEnvVars(env),
    { message: `Environment variables must not include blocked keys: ${BLOCKED_ENV_VARS.join(', ')}` },
  ),
  skipPermissions: z.boolean().default(false),
  worktree: WorktreeConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
});

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

// --- Scheduled Task ---

/** Task ID pattern: must start with alphanumeric, then allow alphanumeric, dots, hyphens, underscores */
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const ScheduledTaskSchema = z.object({
  id: z.string()
    .min(1)
    .max(128)
    .regex(TASK_ID_PATTERN, 'Task ID must start with alphanumeric and contain only alphanumeric, dots, hyphens, underscores'),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  trigger: TriggerSchema,
  execution: ExecutionConfigSchema,
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

// --- Execution History Record ---

export const ExecutionHistoryRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  taskName: z.string().min(1),
  project: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: z.enum(['success', 'failure', 'timeout', 'skipped', 'running']),
  triggeredBy: z.string().min(1),
  duration: z.number().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().int().optional(),
  cronExpression: z.string().optional(),
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  worktreePushed: z.boolean().optional(),
  // v0.2.0 session resume fields (deferred, but schema-ready)
  sessionId: z.string().optional(),
  sessionExpiry: z.string().datetime().optional(),
  executedCommand: z.string().optional(),
});

export type ExecutionHistoryRecord = z.infer<typeof ExecutionHistoryRecordSchema>;

// --- Schedules Config ---

const SettingsSchema = z.object({
  defaultTimezone: z.string().default('local'),
  logRetentionDays: z.number().int().positive().default(30),
  maxExecutionHistory: z.number().int().positive().default(100),
});

export const SchedulesConfigSchema = z.object({
  version: z.literal(1),
  tasks: z.array(ScheduledTaskSchema),
  settings: SettingsSchema.optional(),
});

export type SchedulesConfig = z.infer<typeof SchedulesConfigSchema>;

// --- Factory Functions ---

export interface CreateTaskInput {
  name: string;
  description?: string;
  trigger: Trigger;
  execution: {
    command: string;
    workingDirectory: string;
    timeout?: number;
    env?: Record<string, string>;
    skipPermissions?: boolean;
    worktree?: {
      enabled: boolean;
      basePath?: string;
      branchPrefix?: string;
      remoteName?: string;
    };
    memory?: {
      enabled: boolean;
      maxLines?: number;
      maxChars?: number;
    };
  };
  tags?: string[];
}

/**
 * Creates a new ScheduledTask with generated ID and timestamps.
 */
export function createTask(input: CreateTaskInput): ScheduledTask {
  const now = new Date().toISOString();
  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description,
    enabled: true,
    trigger: input.trigger,
    execution: {
      command: input.execution.command,
      workingDirectory: input.execution.workingDirectory,
      timeout: input.execution.timeout ?? 300,
      env: input.execution.env,
      skipPermissions: input.execution.skipPermissions ?? false,
      worktree: input.execution.worktree ? {
        enabled: input.execution.worktree.enabled,
        basePath: input.execution.worktree.basePath,
        branchPrefix: input.execution.worktree.branchPrefix,
        remoteName: input.execution.worktree.remoteName ?? 'origin',
      } : undefined,
      memory: input.execution.memory ? {
        enabled: input.execution.memory.enabled,
        maxLines: input.execution.memory.maxLines ?? 200,
        maxChars: input.execution.memory.maxChars ?? 4000,
      } : undefined,
    },
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  // Validate the created task
  return ScheduledTaskSchema.parse(task);
}

/**
 * Creates an empty, valid SchedulesConfig.
 */
export function createEmptyConfig(): SchedulesConfig {
  return {
    version: 1,
    tasks: [],
  };
}
