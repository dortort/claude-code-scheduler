---
allowed-tools:
  - Read
  - Bash(node ./dist/cli/index.js *)
---

# /disable

Disable a scheduled task without removing it.

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` directly as JSON.
Match input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`
If already disabled: `Task "<name>" is already disabled.`

### Step 2 — Disable

```bash
node ./dist/cli/index.js update --id '<taskId>' --enabled false
```

### Step 3 — Report

`Task "<name>" disabled. Use /scheduler:enable to re-enable it.`
