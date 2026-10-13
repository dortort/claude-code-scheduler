---
allowed-tools:
  - Read
  - Bash(~/.claude/bin/claude-scheduler-cli *)
---

# /edit

Modify an existing scheduled task's configuration.

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` directly as JSON.
Match input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`

### Step 2 — Determine changes

From the user's input, determine which fields to update:
- **Schedule**: New cron expression or natural language schedule
- **Command**: New prompt text
- **Timeout**: New timeout in seconds
- **Name**: New task name
- **Description**: New description
- **Memory**: Enable or disable run-to-run context (`--memory true` or `--memory false`)
- **Model**: Model alias or full ID for `claude --model` (`--model sonnet`). Use `--clear-model` to remove it and go back to the user's default.
- **Effort**: One of `low`, `medium`, `high`, `xhigh`, `max` for `claude --effort` (`--effort medium`). Use `--clear-effort` to remove it and go back to the user's default.

If a new schedule is provided, validate it:

```bash
~/.claude/bin/claude-scheduler-cli validate-schedule --input '<new schedule>'
```

### Step 3 — Confirm changes

Show the current and new values for each changed field. Ask for confirmation.

### Step 4 — Apply changes

```bash
~/.claude/bin/claude-scheduler-cli update \
  --id '<taskId>' \
  [--cron '<new cron>'] \
  [--command '<new command>'] \
  [--timeout <N>] \
  [--name '<new name>'] \
  [--description '<new description>'] \
  [--memory true|false] \
  [--model '<alias or ID>' | --clear-model] \
  [--effort <level> | --clear-effort]
```

The CLI returns JSON with `success`, `taskId`, `configSaved`, and `osReregistered` fields.
The OS scheduler is re-registered only when the cron expression changes.

### Step 5 — Report

`Task "<name>" updated successfully.`

## Examples

User: "Change the daily-review schedule to 10am"
User: "Update the command for hourly-check"
User: "Set timeout to 600 for daily-review"
User: "Run hourly-check on haiku at low effort"
User: "Reset the model for daily-review to my default"
