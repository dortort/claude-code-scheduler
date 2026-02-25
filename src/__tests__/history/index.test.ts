import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  recordExecution,
  getRecentExecutions,
  cleanup,
} from '../../history/index.js';
import type { ExecutionHistoryRecord } from '../../types.js';

let tmpDir: string;
let historyPath: string;

function makeRecord(overrides: Partial<ExecutionHistoryRecord> = {}): ExecutionHistoryRecord {
  return {
    id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task-001',
    taskName: 'Test Task',
    project: '/tmp/test',
    startedAt: new Date().toISOString(),
    status: 'success',
    triggeredBy: 'manual',
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-history-test-'));
  historyPath = path.join(tmpDir, 'execution-history.jsonl');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('recordExecution', () => {
  it('creates history file and appends record', async () => {
    const record = makeRecord();
    await recordExecution(historyPath, record);

    const content = await fs.readFile(historyPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.taskId).toBe('task-001');
  });

  it('appends to existing file', async () => {
    await recordExecution(historyPath, makeRecord({ id: 'exec-1' }));
    await recordExecution(historyPath, makeRecord({ id: 'exec-2' }));

    const content = await fs.readFile(historyPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('stores executedCommand field', async () => {
    const record = makeRecord({ executedCommand: 'claude -p "review code"' });
    await recordExecution(historyPath, record);

    const content = await fs.readFile(historyPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.executedCommand).toBe('claude -p "review code"');
  });

  it('stores sessionId field', async () => {
    const record = makeRecord({ sessionId: 'sess_abc123' });
    await recordExecution(historyPath, record);

    const content = await fs.readFile(historyPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.sessionId).toBe('sess_abc123');
  });
});

describe('getRecentExecutions', () => {
  it('returns empty array for missing file', async () => {
    const results = await getRecentExecutions(historyPath);
    expect(results).toEqual([]);
  });

  it('returns all records', async () => {
    await recordExecution(historyPath, makeRecord({ id: 'exec-1' }));
    await recordExecution(historyPath, makeRecord({ id: 'exec-2' }));

    const results = await getRecentExecutions(historyPath);
    expect(results).toHaveLength(2);
  });

  it('returns records sorted by startedAt (newest first)', async () => {
    await recordExecution(historyPath, makeRecord({
      id: 'exec-old',
      startedAt: '2026-01-01T00:00:00.000Z',
    }));
    await recordExecution(historyPath, makeRecord({
      id: 'exec-new',
      startedAt: '2026-02-01T00:00:00.000Z',
    }));

    const results = await getRecentExecutions(historyPath);
    expect(results[0].id).toBe('exec-new');
    expect(results[1].id).toBe('exec-old');
  });

  it('filters by taskId', async () => {
    await recordExecution(historyPath, makeRecord({ taskId: 'task-A' }));
    await recordExecution(historyPath, makeRecord({ taskId: 'task-B' }));

    const results = await getRecentExecutions(historyPath, { taskId: 'task-A' });
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe('task-A');
  });

  it('filters by status', async () => {
    await recordExecution(historyPath, makeRecord({ status: 'success' }));
    await recordExecution(historyPath, makeRecord({ status: 'failure' }));

    const results = await getRecentExecutions(historyPath, { status: 'failure' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('failure');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await recordExecution(historyPath, makeRecord({ id: `exec-${i}` }));
    }

    const results = await getRecentExecutions(historyPath, { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('skips corrupted lines gracefully', async () => {
    await recordExecution(historyPath, makeRecord({ id: 'exec-good' }));
    await fs.appendFile(historyPath, 'this is not json\n');
    await recordExecution(historyPath, makeRecord({ id: 'exec-also-good' }));

    const results = await getRecentExecutions(historyPath);
    expect(results).toHaveLength(2);
  });
});

describe('cleanup', () => {
  it('keeps only the last N records', async () => {
    for (let i = 0; i < 10; i++) {
      await recordExecution(historyPath, makeRecord({
        id: `exec-${i}`,
        startedAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
      }));
    }

    await cleanup(historyPath, 5);

    const results = await getRecentExecutions(historyPath);
    expect(results).toHaveLength(5);
  });

  it('does nothing when under the limit', async () => {
    await recordExecution(historyPath, makeRecord({ id: 'exec-1' }));
    await recordExecution(historyPath, makeRecord({ id: 'exec-2' }));

    await cleanup(historyPath, 10);

    const results = await getRecentExecutions(historyPath);
    expect(results).toHaveLength(2);
  });

  it('handles missing file gracefully', async () => {
    await expect(cleanup(historyPath, 5)).resolves.not.toThrow();
  });
});
