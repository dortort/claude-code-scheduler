---
allowed-tools:
  - Read
  - Bash(node -e *)
  - Bash(node ./dist/cli/index.js *)
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

If a new schedule is provided, validate it:

```bash
SCHEDULE_INPUT='<new schedule>' node -e "
const { naturalLanguageToCron, validateCron, CRON_PRESETS } = require('./dist/cron/parser.js');
const { cronToHuman } = require('./dist/cron/humanizer.js');
const input = process.env.SCHEDULE_INPUT.trim();
let cron = input;
const nlResult = naturalLanguageToCron(input);
if (nlResult) { cron = nlResult; }
if (CRON_PRESETS[input.toLowerCase()]) { cron = CRON_PRESETS[input.toLowerCase()]; }
const v = validateCron(cron);
if (!v.valid) { console.log(JSON.stringify({ error: v.error })); process.exit(1); }
console.log(JSON.stringify({ cron, human: cronToHuman(cron) }));
"
```

### Step 3 — Confirm changes

Show the current and new values for each changed field. Ask for confirmation.

### Step 4 — Apply changes

```bash
node ./dist/cli/index.js update \
  --id '<taskId>' \
  [--cron '<new cron>'] \
  [--command '<new command>'] \
  [--timeout <N>] \
  [--name '<new name>'] \
  [--description '<new description>']
```

The CLI returns JSON with `success`, `taskId`, `configSaved`, and `osReregistered` fields.
The OS scheduler is re-registered only when the cron expression changes.

### Step 5 — Report

`Task "<name>" updated successfully.`

## Examples

User: "Change the daily-review schedule to 10am"
User: "Update the command for hourly-check"
User: "Set timeout to 600 for daily-review"
