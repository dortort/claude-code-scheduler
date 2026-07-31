/**
 * E2E: drive the scheduler plugin's slash commands through a real Claude agent
 * via agentry, and assert on the agent's textual reply.
 *
 * Each scenario redirects the scheduler's global state to its sandbox via
 * CLAUDE_SCHEDULER_STATE_DIR (see helpers.runOpts), so empty/populated states
 * are deterministic and isolated from the real ~/.claude.
 *
 * Local-only (not in CI). Requires the `claude` CLI. Run: `npm run test:e2e`.
 * The mutating `/scheduler:add` command is intentionally not covered here — it
 * performs real OS registration (launchd/cron) that the state dir can't isolate.
 */
import { test } from 'agentry';
import { runOpts, agentText, assertContainsAny, assertNotContains } from './helpers.js';
import { seedPopulated } from './fixtures.js';

test.describe('E2E Scheduler Commands', () => {
  test.describe('Empty State', () => {
    test('/scheduler:status — reports no tasks', async ({ agent, workspace }) => {
      const out = agentText(await agent.run('/scheduler:status', runOpts(workspace)));
      assertContainsAny(out, ['none configured', 'no tasks', '0 tasks', 'no scheduled']);
      assertContainsAny(out, ['macos', 'darwin', 'launchd', 'mac']);
    });

    test('/scheduler:list — reports no tasks', async ({ agent, workspace }) => {
      const out = agentText(await agent.run('/scheduler:list', runOpts(workspace)));
      assertContainsAny(out, ['no scheduled tasks', 'no tasks', '0 tasks', 'none']);
      assertContainsAny(out, ['/scheduler:add', 'add', 'create', 'schedule']);
    });

    test('/scheduler:history — reports no history', async ({ agent, workspace }) => {
      const out = agentText(await agent.run('/scheduler:history', runOpts(workspace)));
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
      const out = agentText(await agent.run('/scheduler:status', runOpts(workspace)));
      assertContainsAny(out, ['e2e-daily-review', 'E2E Daily Review']);
      assertNotContains(out, ['none configured']);
    });

    test('/scheduler:list — shows task with schedule', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      const out = agentText(await agent.run('/scheduler:list', runOpts(workspace)));
      assertContainsAny(out, ['E2E Daily Review', 'e2e-daily-review']);
      assertContainsAny(out, ['daily', '9:00', '9 am', '09:00', '0 9 * * *']);
    });

    test('/scheduler:history — shows execution records', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      const out = agentText(await agent.run('/scheduler:history', runOpts(workspace)));
      assertContainsAny(out, ['e2e-daily-review', 'E2E Daily Review', 'success', 'failure', 'execution']);
    });

    test('/scheduler:logs e2e-daily-review — shows log content', async ({ agent, workspace }) => {
      await seedPopulated(workspace);
      const out = agentText(await agent.run('/scheduler:logs e2e-daily-review', runOpts(workspace)));
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
      const out = agentText(await agent.run('/scheduler:logs nonexistent-task', runOpts(workspace)));
      assertContainsAny(out, ['not found', 'no task', 'no logs', 'does not exist', 'unknown']);
    });
  });
});
