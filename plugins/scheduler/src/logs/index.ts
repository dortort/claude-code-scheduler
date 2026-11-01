/**
 * Log file management for scheduled task execution.
 * Handles reading, writing, rotation, and cleanup.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface LogPaths {
  stdout?: string;
  stderr?: string;
  combined?: string;
}

/**
 * Ensure the logs directory exists.
 */
export async function ensureLogsDir(logsDir: string): Promise<void> {
  await fs.mkdir(logsDir, { recursive: true });
}

/**
 * Get log file paths for a task based on platform.
 */
export function getLogPaths(logsDir: string, taskId: string, platform: string): LogPaths {
  if (platform === 'darwin') {
    return {
      stdout: path.join(logsDir, `${taskId}.out.log`),
      stderr: path.join(logsDir, `${taskId}.err.log`),
    };
  }
  // Linux, Windows use combined log
  return {
    combined: path.join(logsDir, `${taskId}.log`),
  };
}

/**
 * Read a log file. Returns empty string if file doesn't exist.
 * If lastLines is specified, returns only the last N lines.
 */
export async function readLog(logPath: string, lastLines?: number): Promise<string> {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    if (lastLines === undefined) return content;

    const lines = content.trimEnd().split('\n');
    return lines.slice(-lastLines).join('\n') + '\n';
  } catch {
    return '';
  }
}

/**
 * Append a timestamped entry to a log file.
 */
export async function appendLog(logPath: string, message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, entry, 'utf-8');
}

/**
 * Rotate a log file if it exceeds maxBytes.
 * Renames current to .1, creates fresh empty file.
 * Keeps only 1 rotated copy.
 */
export async function rotateLog(logPath: string, maxBytes: number): Promise<void> {
  try {
    const stat = await fs.stat(logPath);
    if (stat.size <= maxBytes) return;

    // Rename current to .1 (overwrites existing .1)
    await fs.rename(logPath, logPath + '.1');
    // Create fresh empty file
    await fs.writeFile(logPath, '', 'utf-8');
  } catch {
    // File doesn't exist or other error - nothing to rotate
  }
}

/**
 * Remove log files older than retentionDays.
 */
export async function cleanupOldLogs(logsDir: string, retentionDays: number): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.log') && !entry.name.endsWith('.log.1')) continue;

      const filePath = path.join(logsDir, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath);
      }
    }
  } catch {
    // Directory doesn't exist - nothing to clean
  }
}
