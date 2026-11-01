/**
 * Execution history management using append-only JSONL storage.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionHistoryRecord } from '../types.js';

/**
 * Append an execution record to the JSONL history file.
 */
export async function recordExecution(
  historyPath: string,
  record: ExecutionHistoryRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(historyPath, line, 'utf-8');
}

export interface QueryOptions {
  taskId?: string;
  taskName?: string;
  project?: string;
  status?: string;
  limit?: number;
}

/**
 * Query recent executions from the JSONL history file.
 * Returns records sorted by startedAt (newest first).
 * Skips corrupted lines gracefully.
 */
export async function getRecentExecutions(
  historyPath: string,
  options?: QueryOptions,
): Promise<ExecutionHistoryRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(historyPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.trim().split('\n').filter(l => l.length > 0);
  const records: ExecutionHistoryRecord[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as ExecutionHistoryRecord;
      records.push(record);
    } catch {
      // Skip corrupted lines
    }
  }

  // Apply filters
  let filtered = records;

  if (options?.taskId) {
    filtered = filtered.filter(r => r.taskId === options.taskId);
  }
  if (options?.taskName) {
    filtered = filtered.filter(r => r.taskName === options.taskName);
  }
  if (options?.project) {
    filtered = filtered.filter(r => r.project === options.project);
  }
  if (options?.status) {
    filtered = filtered.filter(r => r.status === options.status);
  }

  // Sort by startedAt descending (newest first)
  filtered.sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  // Apply limit
  if (options?.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

/**
 * Clean up history, keeping only the last maxRecords entries.
 */
export async function cleanup(
  historyPath: string,
  maxRecords: number,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(historyPath, 'utf-8');
  } catch {
    return; // File doesn't exist
  }

  const lines = content.trim().split('\n').filter(l => l.length > 0);
  if (lines.length <= maxRecords) return;

  // Parse all records, sort by startedAt, keep newest
  const records: { line: string; startedAt: number }[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as ExecutionHistoryRecord;
      records.push({ line, startedAt: new Date(record.startedAt).getTime() });
    } catch {
      // Drop corrupted lines during cleanup
    }
  }

  records.sort((a, b) => b.startedAt - a.startedAt);
  const kept = records.slice(0, maxRecords);
  // Write back in chronological order (oldest first)
  kept.reverse();

  await fs.writeFile(historyPath, kept.map(r => r.line).join('\n') + '\n', 'utf-8');
}
