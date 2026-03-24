---
allowed-tools:
  - Read
  - Bash(~/.claude/bin/claude-scheduler-cli *)
---

# /enable

Enable a disabled scheduled task.

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` directly as JSON.
Match input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`
If already enabled: `Task "<name>" is already enabled.`

### Step 2 — Enable

```bash
~/.claude/bin/claude-scheduler-cli update --id '<taskId>' --enabled true
```

### Step 3 — Report

`Task "<name>" enabled. It will run on its next scheduled time.`
