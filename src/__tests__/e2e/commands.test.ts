/**
 * E2E tests: invoke scheduler plugin commands via Claude CLI subprocess.
 *
 * These tests require the `claude` CLI to be installed.
 * They are skipped automatically if it is not available.
 */

import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

import {
  runSchedulerCommand,
  assertContainsAny,
  assertNotContains,
  checkClaudeAvailable,
} from './helpers.js';
import {
  createEmptyProject,
  createPopulatedProject,
  cleanupProject,
} from './fixtures.js';

describe('E2E Scheduler Commands', { timeout: 120_000 }, () => {
  let claudeAvailable = false;

  beforeAll(async () => {
    claudeAvailable = await checkClaudeAvailable();
    if (!claudeAvailable) {
      console.warn('Claude CLI not found — skipping E2E tests');
    }
  });

  describe('Empty State', () => {
    let projectDir: string;

    beforeAll(async () => {
      if (!claudeAvailable) return;
      projectDir = await createEmptyProject();
    });

    afterAll(async () => {
      if (projectDir) await cleanupProject(projectDir);
    });

    it('/scheduler:status — reports no tasks', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand('status', projectDir);
      const output = result.stdout + result.stderr;
      assertContainsAny(output, ['none configured', 'no tasks', '0 tasks', 'no scheduled']);
      assertContainsAny(output, ['macos', 'darwin', 'launchd', 'mac']);
    });

    it('/scheduler:list — reports no tasks', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand('list', projectDir);
      const output = result.stdout + result.stderr;
      assertContainsAny(output, ['no scheduled tasks', 'no tasks', '0 tasks', 'none']);
      assertContainsAny(output, ['/scheduler:add', 'add', 'create', 'schedule']);
    });

    it('/scheduler:history — reports no history', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand('history', projectDir);
      const output = result.stdout + result.stderr;
      assertContainsAny(output, [
        'no execution history',
        'no history',
        "haven't been executed",
        'no executions',
        'no records',
        'none',
      ]);
    });
  });

  describe('Populated State', () => {
    let projectDir: string;

    beforeAll(async () => {
      if (!claudeAvailable) return;
      projectDir = await createPopulatedProject();
    });

    afterAll(async () => {
      if (projectDir) await cleanupProject(projectDir);
    });

    it('/scheduler:status — shows task info', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand('status', projectDir);
      const output = result.stdout + result.stderr;
      assertContainsAny(output, ['e2e-daily-review', 'E2E Daily Review']);
      assertNotContains(output, ['none configured']);
    });

    it('/scheduler:list — shows task with schedule', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand('list', projectDir);
      const output = result.stdout + result.stderr;
      assertContainsAny(output, ['E2E Daily Review', 'e2e-daily-review']);
      assertContainsAny(output, ['daily', '9:00', '9 am', '09:00', '0 9 * * *']);
    });

    it('/scheduler:history — runs without error', async ({ skip }) => {
      if (!claudeAvailable) skip();
      // Note: history reads from ~/.claude/execution-history.jsonl (global only),
      // so project-level fixture data is not visible to this command.
      // We verify the command completes and produces recognizable output.
      const result = await runSchedulerCommand('history', projectDir);
      const output = result.stdout + result.stderr;
      assertContainsAny(output, [
        // If global history exists, it shows records
        'execution', 'history', 'run',
        // If no global history, it reports empty state
        'no execution history', "haven't been executed", 'no history',
      ]);
    });

    it('/scheduler:logs e2e-daily-review — shows log content', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand('logs', projectDir, 'e2e-daily-review');
      const output = result.stdout + result.stderr;
      assertContainsAny(output, [
        'Reviewing recent commits',
        'Found 3 commits',
        'Review complete',
        'recent commits for project',
      ]);
      assertNotContains(output, ['not found', 'no logs']);
    });

    it('/scheduler:logs nonexistent-task — reports not found', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand('logs', projectDir, 'nonexistent-task');
      const output = result.stdout + result.stderr;
      assertContainsAny(output, ['not found', 'no task', 'no logs', 'does not exist', 'unknown']);
    });
  });

  describe('Mutating Commands', () => {
    let projectDir: string;

    beforeEach(async () => {
      if (!claudeAvailable) return;
      projectDir = await createEmptyProject();
    });

    afterEach(async () => {
      if (projectDir) await cleanupProject(projectDir);
    });

    it('/scheduler:add — creates a task', async ({ skip }) => {
      if (!claudeAvailable) skip();
      const result = await runSchedulerCommand(
        'add',
        projectDir,
        'Schedule a task called "E2E Nightly" to run "Check updates" every day at 11pm',
      );
      const output = result.stdout + result.stderr;
      assertContainsAny(output, ['created', 'added', 'scheduled', 'success', 'registered']);
      // Verify the output references the task name or schedule
      assertContainsAny(output, ['nightly', 'E2E Nightly', 'check updates', '11', '23:00']);
    });
  });
});
