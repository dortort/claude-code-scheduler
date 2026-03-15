/**
 * E2E test fixtures: temp directory setup with sample data.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Create a temp project directory with no `.claude/` dir (empty state).
 */
export async function createEmptyProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-e2e-empty-'));
}

/**
 * Create a temp project directory populated with sample scheduler data.
 */
export async function createPopulatedProject(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-e2e-pop-'));
  const claudeDir = path.join(tmpDir, '.claude');
  const logsDir = path.join(claudeDir, 'logs');

  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  // schedules.json with one sample task
  const schedulesConfig = {
    version: 1,
    tasks: [
      {
        id: 'e2e-daily-review',
        name: 'E2E Daily Review',
        enabled: true,
        trigger: {
          type: 'cron',
          expression: '0 9 * * *',
          timezone: 'local',
        },
        execution: {
          command: 'Review recent commits',
          workingDirectory: tmpDir,
          timeout: 300,
          skipPermissions: false,
        },
        tags: [],
        createdAt: '2026-01-15T10:00:00.000Z',
        updatedAt: '2026-01-15T10:00:00.000Z',
      },
    ],
  };
  await fs.writeFile(
    path.join(claudeDir, 'schedules.json'),
    JSON.stringify(schedulesConfig, null, 2),
    'utf-8',
  );

  // execution-history.jsonl with one success and one failure record
  const successRecord = {
    id: 'exec-001',
    taskId: 'e2e-daily-review',
    taskName: 'E2E Daily Review',
    project: tmpDir,
    startedAt: '2026-01-16T09:00:00.000Z',
    completedAt: '2026-01-16T09:01:30.000Z',
    status: 'success',
    triggeredBy: 'scheduled',
    duration: 90000,
    exitCode: 0,
  };
  const failureRecord = {
    id: 'exec-002',
    taskId: 'e2e-daily-review',
    taskName: 'E2E Daily Review',
    project: tmpDir,
    startedAt: '2026-01-17T09:00:00.000Z',
    completedAt: '2026-01-17T09:00:45.000Z',
    status: 'failure',
    triggeredBy: 'scheduled',
    duration: 45000,
    exitCode: 1,
    error: 'Command exited with code 1',
  };
  const historyContent =
    JSON.stringify(successRecord) + '\n' + JSON.stringify(failureRecord) + '\n';
  await fs.writeFile(
    path.join(claudeDir, 'execution-history.jsonl'),
    historyContent,
    'utf-8',
  );

  // Log files for e2e-daily-review
  await fs.writeFile(
    path.join(logsDir, 'e2e-daily-review.out.log'),
    'Reviewing recent commits for project\nFound 3 commits in the last 24 hours\nReview complete\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(logsDir, 'e2e-daily-review.err.log'),
    'Warning: large diff detected in commit abc123\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(logsDir, 'e2e-daily-review.status'),
    'success',
    'utf-8',
  );

  return tmpDir;
}

/**
 * Clean up a temp project directory.
 */
export async function cleanupProject(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
