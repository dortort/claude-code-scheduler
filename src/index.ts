/**
 * Claude Code Scheduler - Public API
 * Re-exports all public functions and types for plugin consumers.
 */

// Types and schemas
export {
  createTask,
  createEmptyConfig,
  type ScheduledTask,
  type SchedulesConfig,
  type ExecutionHistoryRecord,
  type ExecutionConfig,
  type Trigger,
  type CreateTaskInput,
  BLOCKED_ENV_VARS,
} from './types.js';

// Configuration
export {
  getGlobalSchedulesPath,
  loadConfig,
  saveConfig,
  loadMergedConfig,
  addTask,
  updateTask,
  removeTask,
  findTask,
} from './config.js';

// Cron parsing and humanization
export {
  validateCron,
  getNextRuns,
  naturalLanguageToCron,
  CRON_PRESETS,
} from './cron/parser.js';

export {
  cronToHuman,
  formatDate,
  formatDuration,
  formatRelativeTime,
} from './cron/humanizer.js';

// Logging
export {
  ensureLogsDir,
  getLogPaths,
  readLog,
  appendLog,
  rotateLog,
  cleanupOldLogs,
} from './logs/index.js';

// Execution history
export {
  recordExecution,
  getRecentExecutions,
  cleanup as cleanupHistory,
} from './history/index.js';

// VCS
export {
  isGitRepo,
  createWorktree,
  commitAndPush,
  removeWorktree,
  isSensitiveFile,
  SENSITIVE_FILE_PATTERNS,
  generateBranchName,
} from './vcs/index.js';

// Shared executor
export { run as runTask } from './cli/executor.js';

// CLI commands
export { init, ensureExecutorInstalled, getShimPath, getExecutorPath } from './cli/commands/init.js';
export { registerTask, unregisterTask } from './cli/platform.js';

// Platform schedulers
export {
  getSchedulerForPlatform,
  PlatformNotSupportedError,
} from './schedulers/index.js';

export {
  getExecutionCommand,
  getCronExpression,
  type SchedulerTask,
} from './schedulers/base.js';

export {
  generatePlist,
  cronToCalendarInterval,
  getPlistPath,
  getLaunchctlLabel,
  type DarwinSchedulerTask,
} from './schedulers/darwin.js';

export {
  generateCrontabLine,
  parseCrontabMarkers,
  buildCrontabContent,
  type LinuxSchedulerTask,
} from './schedulers/linux.js';

// Shell utilities
export {
  shellEscape,
  sanitizeForComment,
  isSafeIdentifier,
  GIT_REF_PATTERN,
  GIT_REMOTE_PATTERN,
  SAFE_PATH_PATTERN,
} from './utils/shell.js';

// Exec utility
export {
  exec,
  ExecError,
  type ExecResult,
  type ExecOptions,
} from './utils/exec.js';
