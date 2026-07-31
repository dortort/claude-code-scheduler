---
allowed-tools:
  - Read
  - Glob
  - Bash(cat *)
  - Bash(tail *)
  - Bash(~/.claude/bin/claude-scheduler-cli *)
---

# /list

List all scheduled tasks with their status, schedule, and next run time.

## Data Sources

All data comes from these exact paths — do NOT read any source files. The state
directory is `$CLAUDE_SCHEDULER_STATE_DIR` when set, otherwise `~/.claude`; in
Bash always read it as `"${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}"`.

| Data | Path |
|------|------|
| Global config | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/schedules.json` |
| Project config | `.claude/schedules.json` (optional) |
| Execution history | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/execution-history.jsonl` |

Config format:
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "...", "enabled": true, "trigger": { "cron": "0 9 * * *" }, "execution": { "command": "...", "workingDirectory": "...", "timeout": 300, "skipPermissions": false }, "worktree": null } ] }
```

History format: one JSON object per line — fields: `taskId`, `taskName`, `status` (`success`|`failure`|`timeout`), `startedAt`, `finishedAt`.

## Behavior

### Step 1 — Load all data in parallel

Issue simultaneously:
1. `Bash: cat "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/schedules.json" 2>/dev/null || echo NO_GLOBAL_CONFIG`
2. `Bash: cat .claude/schedules.json 2>/dev/null || echo NO_PROJECT_CONFIG` (ignore if missing)
3. `Bash: tail -50 "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/execution-history.jsonl" 2>/dev/null || echo NO_HISTORY`

### Step 2 — Derive merged task list

Merge global + project tasks. Global tasks win on ID collision. Tag each task with its source (`global` or `project`).

### Step 3 — Empty state

If the merged task list is empty, output:

```
No scheduled tasks found.
Run /scheduler:add to create your first task.
```

Then stop.

### Step 4 — Humanize cron expressions and compute next runs

Use a single call to the compiled CLI (never `src/`):

```bash
~/.claude/bin/claude-scheduler-cli humanize --tasks '[{"id":"...","cron":"...","timezone":"..."}]'
```

If that binary is not present, fall back to showing each task's raw cron
expression (e.g. `0 9 * * *`) and omit the next-run time.

### Step 5 — Output table

For each task display:
- **Name** and **ID**
- **Source**: global / project
- **Enabled**: yes / no
- **Schedule**: human-readable cron description from step 4
- **Next run**: use the `relativeTime` field from step 4 output directly — do not compute or reformat it
- **Last status**: from history — success / failure / timeout / never run
- **Working directory**
- **Worktree**: yes / no

## Examples

User: "List my scheduled tasks"
User: "Show all schedules"
User: "What tasks are scheduled?"
