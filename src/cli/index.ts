/**
 * CLI entry point for claude-scheduler.
 * Invoked by skills as: node ./dist/cli/index.js <subcommand> [args]
 * Uses Node 18+ built-in util.parseArgs (no external dependencies).
 */

import { parseArgs } from 'node:util';
import { init } from './commands/init.js';
import { sync } from './commands/sync.js';

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand) {
    console.error('Usage: claude-scheduler <subcommand> [options]');
    console.error('Subcommands: init, sync, add, remove, update, migrate, validate-schedule, humanize');
    process.exit(1);
  }

  try {
    switch (subcommand) {
      case 'init': {
        const result = await init();
        console.log(JSON.stringify(result));
        process.exitCode = result.success ? 0 : 1;
        break;
      }

      case 'sync': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            id: { type: 'string' },
            config: { type: 'string' },
          },
          strict: false,
        });

        // Dynamic import to avoid loading platform code eagerly
        const { registerTask } = await import('./platform.js');
        const result = await sync(registerTask, {
          taskId: values.id as string | undefined,
          configPath: values.config as string | undefined,
        });
        console.log(JSON.stringify(result));
        process.exitCode = result.success ? 0 : 1;
        break;
      }

      case 'add': {
        const { add } = await import('./commands/add.js');
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            name: { type: 'string' },
            cron: { type: 'string' },
            command: { type: 'string' },
            'working-directory': { type: 'string' },
            timeout: { type: 'string' },
            'skip-permissions': { type: 'boolean', default: false },
            description: { type: 'string' },
            memory: { type: 'boolean', default: false },
          },
          strict: false,
        });
        const result = await add({
          name: values.name as string,
          cron: values.cron as string,
          command: values.command as string,
          workingDirectory: values['working-directory'] as string,
          timeout: values.timeout ? parseInt(values.timeout as string, 10) : undefined,
          skipPermissions: values['skip-permissions'] as boolean,
          description: values.description as string | undefined,
          memory: values.memory as boolean,
        });
        console.log(JSON.stringify(result));
        process.exitCode = result.success ? 0 : 1;
        break;
      }

      case 'remove': {
        const { remove } = await import('./commands/remove.js');
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            id: { type: 'string' },
          },
          strict: false,
        });
        const result = await remove({ id: values.id as string });
        console.log(JSON.stringify(result));
        process.exitCode = result.success ? 0 : 1;
        break;
      }

      case 'update': {
        const { update } = await import('./commands/update.js');
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            id: { type: 'string' },
            cron: { type: 'string' },
            command: { type: 'string' },
            timeout: { type: 'string' },
            enabled: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            memory: { type: 'string' },
          },
          strict: false,
        });
        const result = await update({
          id: values.id as string,
          cron: values.cron as string | undefined,
          command: values.command as string | undefined,
          timeout: values.timeout ? parseInt(values.timeout as string, 10) : undefined,
          enabled: values.enabled !== undefined ? values.enabled === 'true' : undefined,
          name: values.name as string | undefined,
          description: values.description as string | undefined,
          memory: values.memory !== undefined ? values.memory === 'true' : undefined,
        });
        console.log(JSON.stringify(result));
        process.exitCode = result.success ? 0 : 1;
        break;
      }

      case 'migrate': {
        const { migrate } = await import('./commands/migrate.js');
        const result = await migrate();
        console.log(JSON.stringify(result));
        process.exitCode = result.success ? 0 : 1;
        break;
      }

      case 'validate-schedule': {
        const { validateSchedule } = await import('./commands/validate-schedule.js');
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            input: { type: 'string' },
          },
          strict: false,
        });
        if (!values.input) {
          console.error(JSON.stringify({ error: 'Missing --input flag' }));
          process.exit(1);
        }
        const result = validateSchedule(values.input as string);
        console.log(JSON.stringify(result));
        process.exitCode = 'error' in result ? 1 : 0;
        break;
      }

      case 'humanize': {
        const { humanize } = await import('./commands/humanize.js');
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            tasks: { type: 'string' },
          },
          strict: false,
        });
        if (!values.tasks) {
          console.error(JSON.stringify({ error: 'Missing --tasks flag' }));
          process.exit(1);
        }
        const tasks = JSON.parse(values.tasks as string);
        const result = humanize(tasks);
        console.log(JSON.stringify(result));
        break;
      }

      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: (err as Error).message }));
    process.exit(1);
  }
}

main();
