---
allowed-tools:
  - Read
  - Bash(node ./dist/cli/index.js *)
  - Bash(launchctl list *)
  - Bash(crontab -l *)
---

# /remove

Remove a scheduled task by ID or name.

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` (and `.claude/schedules.json` if present) directly as JSON.
Match input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`

### Step 2 — Confirm

Show the task name, ID, schedule cron, and working directory. Ask for confirmation before removing.

### Step 3 — Remove the task

Run a single CLI call that handles config removal and OS deregistration atomically:

```bash
node ./dist/cli/index.js remove --id '<taskId>'
```

The CLI returns JSON: `{ "success": true, "taskId": "...", "taskName": "...", "configSaved": true, "osUnregistered": true }`

If `success` is false, show the error from the JSON response.

### Step 4 — Report

`Task "<name>" removed successfully.`

## Examples

User: "Remove the daily-review task"
User: "Delete schedule daily-review"
User: "Unschedule 'Code Review'"
