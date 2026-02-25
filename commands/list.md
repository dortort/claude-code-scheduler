---
allowed-tools:
  - Read
  - Glob
  - Bash(node -e *)
---

# /list

List all scheduled tasks with their status, schedule, and next run time.

## Behavior

1. Load the merged configuration using `loadMergedConfig()` from `src/config.ts`:
   - Global tasks from `~/.claude/schedules.json`
   - Project tasks from `.claude/schedules.json` (if in a project directory)

2. For each task, display:
   - **ID** and **name**
   - **Source**: global or project
   - **Enabled**: yes/no
   - **Schedule**: Human-readable description (via `cronToHuman()`)
   - **Next run**: Formatted next execution time (via `getNextRuns()`)
   - **Last status**: From execution history (success/failure/timeout)
   - **Working directory**
   - **Worktree mode**: yes/no

3. Format as a readable table or list.

4. If no tasks exist, inform the user and suggest using `/scheduler:add`.

## Examples

User: "List my scheduled tasks"
User: "Show all schedules"
User: "What tasks are scheduled?"
