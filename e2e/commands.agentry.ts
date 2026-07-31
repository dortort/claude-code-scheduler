/**
 * E2E: drive the scheduler plugin's slash commands through a real Claude agent
 * via agentry, and assert on the agent's textual reply.
 *
 * Local-only (not in CI). Requires the `claude` CLI. Run: `npm run test:e2e`.
 */
import { test } from 'agentry';
import { RUN_OPTS, agentText, assertContainsAny, assertNotContains } from './helpers.js';
import { seedPopulated } from './fixtures.js';

test.describe('E2E Scheduler Commands', () => {
  test.describe('Empty State', () => {
    test('/scheduler:status — reports no tasks', async ({ agent }) => {
      const out = agentText(await agent.run('/scheduler:status', RUN_OPTS));
      assertContainsAny(out, ['none configured', 'no tasks', '0 tasks', 'no scheduled']);
      assertContainsAny(out, ['macos', 'darwin', 'launchd', 'mac']);
    });

    test('/scheduler:list — reports no tasks', async ({ agent }) => {
      const out = agentText(await agent.run('/scheduler:list', RUN_OPTS));
      assertContainsAny(out, ['no scheduled tasks', 'no tasks', '0 tasks', 'none']);
      assertContainsAny(out, ['/scheduler:add', 'add', 'create', 'schedule']);
    });

    test('/scheduler:history — reports no history', async ({ agent }) => {
      const out = agentText(await agent.run('/scheduler:history', RUN_OPTS));
      assertContainsAny(out, [
        'no execution history',
        'no history',
        "haven't been executed",
        'no executions',
        'no records',
        'none',
      ]);
    });
  });

  test.describe('Populated State', () => {
    test('/scheduler:status — shows task info', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      const out = agentText(await agent.run('/scheduler:status', RUN_OPTS));
      assertContainsAny(out, ['e2e-daily-review', 'E2E Daily Review']);
      assertNotContains(out, ['none configured']);
    });

    test('/scheduler:list — shows task with schedule', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      const out = agentText(await agent.run('/scheduler:list', RUN_OPTS));
      assertContainsAny(out, ['E2E Daily Review', 'e2e-daily-review']);
      assertContainsAny(out, ['daily', '9:00', '9 am', '09:00', '0 9 * * *']);
    });

    test('/scheduler:history — runs without error', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      // history reads from ~/.claude/execution-history.jsonl (global only), so the
      // project fixture is not visible here — just verify recognizable output.
      const out = agentText(await agent.run('/scheduler:history', RUN_OPTS));
      assertContainsAny(out, [
        'execution',
        'history',
        'run',
        'no execution history',
        "haven't been executed",
        'no history',
      ]);
    });

    test('/scheduler:logs e2e-daily-review — shows log content', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      const out = agentText(await agent.run('/scheduler:logs e2e-daily-review', RUN_OPTS));
      assertContainsAny(out, [
        'Reviewing recent commits',
        'Found 3 commits',
        'Review complete',
        'recent commits for project',
      ]);
      assertNotContains(out, ['not found', 'no logs']);
    });

    test('/scheduler:logs nonexistent-task — reports not found', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      const out = agentText(await agent.run('/scheduler:logs nonexistent-task', RUN_OPTS));
      assertContainsAny(out, ['not found', 'no task', 'no logs', 'does not exist', 'unknown']);
    });
  });

  test.describe('Mutating Commands', () => {
    test('/scheduler:add — creates a task', async ({ agent }) => {
      const out = agentText(
        await agent.run(
          '/scheduler:add Schedule a task called "E2E Nightly" to run "Check updates" every day at 11pm',
          RUN_OPTS,
        ),
      );
      assertContainsAny(out, ['created', 'added', 'scheduled', 'success', 'registered']);
      assertContainsAny(out, ['nightly', 'E2E Nightly', 'check updates', '11', '23:00']);
    });
  });
});
