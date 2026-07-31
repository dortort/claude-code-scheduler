import type { Sandbox } from 'agentry';
import { STATE_SUBDIR } from './helpers.js';

/**
 * Seed a sandbox's isolated state dir (CLAUDE_SCHEDULER_STATE_DIR) with the
 * sample data the "populated" scenarios expect: one task (`e2e-daily-review`),
 * a two-record execution history, and its log files.
 */
export async function seedPopulated(workspace: Sandbox): Promise<void> {
  const dir = workspace.dir;
  const p = (rel: string) => `${STATE_SUBDIR}/${rel}`;

  const schedulesConfig = {
    version: 1,
    tasks: [
      {
        id: 'e2e-daily-review',
        name: 'E2E Daily Review',
        enabled: true,
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'local' },
        execution: {
          command: 'Review recent commits',
          workingDirectory: dir,
          timeout: 300,
          skipPermissions: false,
        },
        tags: [],
        createdAt: '2026-01-15T10:00:00.000Z',
        updatedAt: '2026-01-15T10:00:00.000Z',
      },
    ],
  };
  await workspace.write(p('schedules.json'), JSON.stringify(schedulesConfig, null, 2));

  const successRecord = {
    id: 'exec-001',
    taskId: 'e2e-daily-review',
    taskName: 'E2E Daily Review',
    project: dir,
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
    project: dir,
    startedAt: '2026-01-17T09:00:00.000Z',
    completedAt: '2026-01-17T09:00:45.000Z',
    status: 'failure',
    triggeredBy: 'scheduled',
    duration: 45000,
    exitCode: 1,
    error: 'Command exited with code 1',
  };
  await workspace.write(
    p('execution-history.jsonl'),
    `${JSON.stringify(successRecord)}\n${JSON.stringify(failureRecord)}\n`,
  );

  await workspace.write(
    p('logs/e2e-daily-review.out.log'),
    'Reviewing recent commits for project\nFound 3 commits in the last 24 hours\nReview complete\n',
  );
  await workspace.write(
    p('logs/e2e-daily-review.err.log'),
    'Warning: large diff detected in commit abc123\n',
  );
  await workspace.write(p('logs/e2e-daily-review.status'), 'success');
}
