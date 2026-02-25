---
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash(npm run build)
  - Bash(node -e *)
---

# /add

Add a new scheduled task. Accepts a natural language schedule or a cron expression.

## Behavior

1. Parse the user's input to determine:
   - **Task name**: A short descriptive identifier
   - **Schedule**: Natural language (e.g., "every day at 9am") or cron expression (e.g., "0 9 * * *")
   - **Command**: The natural-language prompt for Claude to execute (NOT a slash command)
   - **Working directory**: Defaults to the current project directory (resolved to absolute path)
   - **Timeout**: Defaults to 300 seconds
   - **Worktree mode**: Optional git worktree isolation

2. Validate the schedule:
   - If natural language, convert to cron using `naturalLanguageToCron()` from `src/cron/parser.ts`
   - Validate the cron expression using `validateCron()`
   - Show the human-readable interpretation using `cronToHuman()` from `src/cron/humanizer.ts`

3. Show confirmation with:
   - Task name and generated ID
   - Human-readable schedule description
   - Next 3 scheduled runs (using `getNextRuns()`)
   - Working directory
   - Whether `--dangerously-skip-permissions` is enabled
   - Worktree configuration (if applicable)

4. On confirmation:
   - Create the task using `createTask()` from `src/types.ts`
   - Add to config using `addTask()` from `src/config.ts`
   - Generate the wrapper script using templates from `src/templates/wrapper.ts`
   - Register with the OS scheduler (launchd on macOS, crontab on Linux)
   - Report success with the task ID

## Important constraints

- The `command` field must be a natural-language prompt, NOT a slash command. Slash commands are not supported in scheduled execution.
- The `skipPermissions` flag can only be set in the global config (`~/.claude/schedules.json`), never from project-level configs.
- Task IDs must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`.
- Working directory must be an absolute path.

## Examples

User: "Schedule a daily code review at 9am"
User: "Add a task to run 'Summarize git log for the past day' every weekday at 5pm"
User: "Schedule 'Check for dependency updates' with cron 0 8 * * 1"
