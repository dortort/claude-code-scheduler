---
allowed-tools:
  - Read
  - Bash(node -e *)
  - Bash(~/.claude/bin/claude-scheduler-run *)
  - Bash($HOME/.claude/bin/claude-scheduler-run *)
---

# /run

Manually trigger a scheduled task for immediate execution.

## Data Sources

| Data | Path |
|------|------|
| Global config | `~/.claude/schedules.json` |
| Project config | `.claude/schedules.json` (optional) |
| Shared executor | `~/.claude/bin/claude-scheduler-run` |
| Execution history | `~/.claude/execution-history.jsonl` |
| stdout log | `~/.claude/logs/<taskId>.out.log` |
| stderr log | `~/.claude/logs/<taskId>.err.log` |

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` (and `.claude/schedules.json` if present) directly as JSON.
Match input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`

If shared executor `~/.claude/bin/claude-scheduler-run` does not exist:
`Executor not installed. Run /scheduler:add to install it.`

### Step 2 — Confirm

Show: task name, ID, command, working directory, timeout. Ask for confirmation.

### Step 3 — Execute

Run the shared executor with the task ID:

```bash
~/.claude/bin/claude-scheduler-run <taskId>
```

The executor handles timeout enforcement, mkdir-based concurrency guard, log writing, and execution history recording.
If the task is already running, it exits with: `Task <taskId> already running, skipping.`

### Step 4 — Report

```
Task "<name>" completed — <status> in <duration>

Logs:
  stdout: ~/.claude/logs/<taskId>.out.log
  stderr: ~/.claude/logs/<taskId>.err.log
```

## Important constraints

- This runs the shared executor directly, bypassing the OS scheduler.
- If the task is already running (lock held), execution is skipped automatically.
- The executor records execution history automatically.

## Examples

User: "Run the daily-review task now"
User: "Trigger daily-review manually"
User: "Execute 'Code Review' immediately"
