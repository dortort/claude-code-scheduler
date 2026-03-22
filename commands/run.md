---
allowed-tools:
  - Read
  - Bash(node -e *)
  - Bash(/bin/bash *)
---

# /run

Manually trigger a scheduled task for immediate execution.

## Data Sources

| Data | Path |
|------|------|
| Global config | `~/.claude/schedules.json` |
| Project config | `.claude/schedules.json` (optional) |
| Wrapper script | `~/.claude/logs/<taskId>.sh` |
| Execution history | `~/.claude/execution-history.jsonl` |
| stdout log | `~/.claude/logs/<taskId>.out.log` |
| stderr log | `~/.claude/logs/<taskId>.err.log` |

Config format:
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "...", "execution": { "command": "...", "workingDirectory": "...", "timeout": 300 } } ] }
```

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` (and `.claude/schedules.json` if present) directly as JSON — no `node -e` needed.
Match input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`

If wrapper script `~/.claude/logs/<taskId>.sh` does not exist:
`Wrapper script missing for "<name>". Run /scheduler:add to recreate it.`

### Step 2 — Confirm

Show: task name, ID, command, working directory, timeout. Ask for confirmation.

### Step 3 — Execute

Note the start time, then run:

```bash
/bin/bash ~/.claude/logs/<taskId>.sh
EXIT_CODE=$?
```

The wrapper script handles timeout enforcement, mkdir-based concurrency guard, and log writing.
If the task is already running, it exits with: `Task <taskId> is already running, skipping.`

### Step 4 — Record history

```bash
RECORD_JSON='{"taskId":"...","taskName":"...","status":"success","startedAt":"<ISO>","finishedAt":"<ISO>","exitCode":0}' \
HISTORY_PATH=~/.claude/execution-history.jsonl \
node -e "
const { recordExecution } = require('./dist/history/index.js');
const record = JSON.parse(process.env.RECORD_JSON);
recordExecution(process.env.HISTORY_PATH, record).then(() => console.log('recorded'));
"
```

Set `status` to `success` (exit 0), `failure` (non-zero exit), or `timeout` (if the wrapper timed out).

### Step 5 — Report

```
Task "<name>" completed — <status> in <duration>

Logs:
  stdout: ~/.claude/logs/<taskId>.out.log
  stderr: ~/.claude/logs/<taskId>.err.log
```

## Important constraints

- This runs the wrapper script directly, bypassing the OS scheduler.
- If the task is already running (lock held), execution is skipped automatically.

## Examples

User: "Run the daily-review task now"
User: "Trigger daily-review manually"
User: "Execute 'Code Review' immediately"
