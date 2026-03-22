/**
 * Integration test: Full task lifecycle
 * create task -> add to config -> generate wrapper -> verify history -> verify logs -> cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Import from the public API surface (src/index.ts)
import {
  // Types
  createTask,
  createEmptyConfig,
  type ExecutionHistoryRecord,

  // Config
  loadConfig,
  saveConfig,
  addTask,
  removeTask,
  findTask,

  // Cron
  validateCron,
  cronToHuman,
  naturalLanguageToCron,
  getNextRuns,
  formatDuration,

  // Logs
  ensureLogsDir,
  getLogPaths,
  readLog,
  appendLog,
  rotateLog,

  // History
  recordExecution,
  getRecentExecutions,

  // VCS
  isSensitiveFile,

  // Schedulers
  getSchedulerForPlatform,
  PlatformNotSupportedError,

  // Shell utilities
  shellEscape,
  isSafeIdentifier,
} from '../../index.js';

describe('Task Lifecycle Integration', () => {
  let tmpDir: string;
  let configPath: string;
  let logsDir: string;
  let historyPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-integration-'));
    configPath = path.join(tmpDir, 'schedules.json');
    logsDir = path.join(tmpDir, 'logs');
    historyPath = path.join(tmpDir, 'history.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: create -> config -> wrapper -> history -> logs -> cleanup', async () => {
    // 1. Create a task
    const task = createTask({
      name: 'Integration Test Task',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      execution: {
        command: 'Review the latest commits',
        workingDirectory: tmpDir,
        timeout: 120,
      },
    });

    expect(task.id).toBeTruthy();
    expect(isSafeIdentifier(task.id)).toBe(true);

    // 2. Add to config
    let config = createEmptyConfig();
    config = addTask(config, task);
    await saveConfig(configPath, config);

    // 3. Reload and verify
    const loaded = await loadConfig(configPath);
    expect(loaded.tasks).toHaveLength(1);
    const found = findTask(loaded, 'Integration Test Task');
    expect(found).toBeDefined();
    expect(found!.id).toBe(task.id);

    // 4. Validate the cron expression
    const validation = validateCron('0 9 * * *');
    expect(validation.valid).toBe(true);

    // 5. Get human-readable description
    const human = cronToHuman('0 9 * * *');
    expect(human.toLowerCase()).toContain('9');

    // 6. Get next runs
    const nextRuns = getNextRuns('0 9 * * *', 3);
    expect(nextRuns).toHaveLength(3);

    // 7. Verify shared executor module is importable
    const { run } = await import('../../cli/executor.js');
    expect(typeof run).toBe('function');

    // 8. Ensure logs directory exists
    await ensureLogsDir(logsDir);

    // 9. Simulate execution logging
    const logPaths = getLogPaths(logsDir, task.id, 'darwin');
    expect(logPaths.stdout).toBeDefined();
    expect(logPaths.stderr).toBeDefined();

    await appendLog(logPaths.stdout!, 'Execution started');
    await appendLog(logPaths.stdout!, 'Reviewing commits...');
    await appendLog(logPaths.stdout!, 'Execution completed');

    const logContent = await readLog(logPaths.stdout!);
    expect(logContent).toContain('Execution started');
    expect(logContent).toContain('Execution completed');

    // 10. Read last N lines
    const lastLine = await readLog(logPaths.stdout!, 1);
    expect(lastLine).toContain('Execution completed');

    // 11. Record execution history
    const historyRecord: ExecutionHistoryRecord = {
      taskId: task.id,
      taskName: task.name,
      project: tmpDir,
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 5000,
      status: 'success',
      exitCode: 0,
      trigger: 'scheduled',
    };
    await recordExecution(historyPath, historyRecord);

    // 12. Query history
    const history = await getRecentExecutions(historyPath);
    expect(history).toHaveLength(1);
    expect(history[0].taskId).toBe(task.id);
    expect(history[0].status).toBe('success');

    // 13. Record a second execution (failure)
    const failRecord: ExecutionHistoryRecord = {
      taskId: task.id,
      taskName: task.name,
      project: tmpDir,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1200,
      status: 'failure',
      exitCode: 1,
      trigger: 'manual',
    };
    await recordExecution(historyPath, failRecord);

    // 14. Query with filter
    const failures = await getRecentExecutions(historyPath, { status: 'failure' });
    expect(failures).toHaveLength(1);
    expect(failures[0].trigger).toBe('manual');

    // 15. Remove task from config
    config = removeTask(loaded, task.id);
    expect(config.tasks).toHaveLength(0);

    // 16. Duration formatting
    const duration = formatDuration(5000);
    expect(duration).toContain('5s');
  });

  it('platform scheduler factory returns correct platform', () => {
    const darwin = getSchedulerForPlatform('darwin');
    expect(darwin.platform).toBe('darwin');

    const linux = getSchedulerForPlatform('linux');
    expect(linux.platform).toBe('linux');

    expect(() => getSchedulerForPlatform('win32')).toThrow(PlatformNotSupportedError);
  });

  it('sensitive file detection works across the API', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.production')).toBe(true);
    expect(isSensitiveFile('id_rsa')).toBe(true);
    expect(isSensitiveFile('index.ts')).toBe(false);
  });

  it('shell escaping prevents injection across the API', () => {
    const escaped = shellEscape("test'; rm -rf /; echo '");
    // Each original single quote is replaced with '\'' (end-quote, escaped-quote, start-quote)
    expect(escaped).toContain("'\\''");
    // Single-quote wrapping prevents expansion
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });

  it('natural language to cron conversion works', () => {
    const cron = naturalLanguageToCron('daily at 9am');
    expect(cron).toBeDefined();
    expect(cron).toBe('0 9 * * *');
  });

  it('corrupt config files degrade gracefully', async () => {
    // Write invalid JSON
    await fs.writeFile(configPath, '{ invalid json !!!', 'utf-8');
    const config = await loadConfig(configPath);
    // Should return empty config, not throw
    expect(config.tasks).toHaveLength(0);
  });

  it('log rotation works correctly', async () => {
    await ensureLogsDir(logsDir);
    const logFile = path.join(logsDir, 'test.log');

    // Write enough data to trigger rotation
    const bigContent = 'x'.repeat(100);
    await fs.writeFile(logFile, bigContent, 'utf-8');

    // Rotate at 50 bytes threshold
    await rotateLog(logFile, 50);

    // Original file should be empty now
    const newContent = await fs.readFile(logFile, 'utf-8');
    expect(newContent).toBe('');

    // Rotated file should exist
    const rotatedContent = await fs.readFile(logFile + '.1', 'utf-8');
    expect(rotatedContent).toBe(bigContent);
  });
});
