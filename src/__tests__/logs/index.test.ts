import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureLogsDir,
  getLogPaths,
  readLog,
  appendLog,
  rotateLog,
  cleanupOldLogs,
} from '../../logs/index.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-logs-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ensureLogsDir', () => {
  it('creates the logs directory if it does not exist', async () => {
    const logsDir = path.join(tmpDir, 'logs');
    await ensureLogsDir(logsDir);
    const stat = await fs.stat(logsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent', async () => {
    const logsDir = path.join(tmpDir, 'logs');
    await ensureLogsDir(logsDir);
    await ensureLogsDir(logsDir);
    const stat = await fs.stat(logsDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('getLogPaths', () => {
  it('returns stdout and stderr paths for macOS', () => {
    const paths = getLogPaths('/logs', 'task-1', 'darwin');
    expect(paths.stdout).toBe('/logs/task-1.out.log');
    expect(paths.stderr).toBe('/logs/task-1.err.log');
    expect(paths.combined).toBeUndefined();
  });

  it('returns combined path for Linux', () => {
    const paths = getLogPaths('/logs', 'task-1', 'linux');
    expect(paths.combined).toBe('/logs/task-1.log');
    expect(paths.stdout).toBeUndefined();
    expect(paths.stderr).toBeUndefined();
  });
});

describe('readLog', () => {
  it('reads full log file', async () => {
    const logPath = path.join(tmpDir, 'test.log');
    await fs.writeFile(logPath, 'line1\nline2\nline3\n');
    const content = await readLog(logPath);
    expect(content).toBe('line1\nline2\nline3\n');
  });

  it('reads last N lines', async () => {
    const logPath = path.join(tmpDir, 'test.log');
    await fs.writeFile(logPath, 'line1\nline2\nline3\nline4\nline5\n');
    const content = await readLog(logPath, 2);
    expect(content.trim().split('\n')).toHaveLength(2);
  });

  it('returns empty string for missing file', async () => {
    const content = await readLog(path.join(tmpDir, 'nonexistent.log'));
    expect(content).toBe('');
  });
});

describe('appendLog', () => {
  it('appends timestamped entry to log', async () => {
    const logPath = path.join(tmpDir, 'test.log');
    await appendLog(logPath, 'test message');
    const content = await fs.readFile(logPath, 'utf-8');
    expect(content).toContain('test message');
    expect(content).toContain('[');  // timestamp bracket
  });

  it('creates file if it does not exist', async () => {
    const logPath = path.join(tmpDir, 'new.log');
    await appendLog(logPath, 'first entry');
    const content = await fs.readFile(logPath, 'utf-8');
    expect(content).toContain('first entry');
  });

  it('appends to existing content', async () => {
    const logPath = path.join(tmpDir, 'test.log');
    await appendLog(logPath, 'entry1');
    await appendLog(logPath, 'entry2');
    const content = await fs.readFile(logPath, 'utf-8');
    expect(content).toContain('entry1');
    expect(content).toContain('entry2');
  });
});

describe('rotateLog', () => {
  it('rotates file exceeding max size', async () => {
    const logPath = path.join(tmpDir, 'big.log');
    // Write more than the threshold
    const bigContent = 'x'.repeat(100);
    await fs.writeFile(logPath, bigContent);

    await rotateLog(logPath, 50); // 50-byte threshold for testing

    // Original should be empty/truncated
    const newContent = await fs.readFile(logPath, 'utf-8');
    expect(newContent.length).toBe(0);

    // Rotated file should exist
    const rotatedContent = await fs.readFile(logPath + '.1', 'utf-8');
    expect(rotatedContent).toBe(bigContent);
  });

  it('does nothing when file is under threshold', async () => {
    const logPath = path.join(tmpDir, 'small.log');
    await fs.writeFile(logPath, 'small');

    await rotateLog(logPath, 1000);

    // No rotated file
    await expect(fs.access(logPath + '.1')).rejects.toThrow();
  });

  it('overwrites existing rotated file', async () => {
    const logPath = path.join(tmpDir, 'test.log');
    await fs.writeFile(logPath + '.1', 'old rotated');
    await fs.writeFile(logPath, 'x'.repeat(100));

    await rotateLog(logPath, 50);

    const rotated = await fs.readFile(logPath + '.1', 'utf-8');
    expect(rotated).not.toBe('old rotated');
  });
});

describe('cleanupOldLogs', () => {
  it('removes log files older than retention days', async () => {
    const logPath = path.join(tmpDir, 'old.log');
    await fs.writeFile(logPath, 'old content');
    // Set mtime to 60 days ago
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await fs.utimes(logPath, oldDate, oldDate);

    await cleanupOldLogs(tmpDir, 30);

    await expect(fs.access(logPath)).rejects.toThrow();
  });

  it('preserves recent log files', async () => {
    const logPath = path.join(tmpDir, 'recent.log');
    await fs.writeFile(logPath, 'recent content');

    await cleanupOldLogs(tmpDir, 30);

    const content = await fs.readFile(logPath, 'utf-8');
    expect(content).toBe('recent content');
  });
});
