---
allowed-tools:
  - Read
  - Glob
  - Bash(launchctl list *)
  - Bash(crontab -l)
  - Bash(ls ~/Library/LaunchAgents/com.claude-scheduler.*.plist *)
  - Bash(uname -s)
---

# /status

Show the health status of the scheduling system and individual tasks.

## Data Sources

All checks use these exact paths — do NOT read any source files:

| Data | Path |
|------|------|
| Global config | `~/.claude/schedules.json` |
| Project config | `.claude/schedules.json` (optional, only if present) |
| Execution history | `~/.claude/execution-history.jsonl` |
| macOS plist files | `~/Library/LaunchAgents/com.claude-scheduler.*.plist` |

Config format (`schedules.json`):
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "...", "enabled": true, "trigger": { "cron": "..." }, "workingDirectory": "..." } ] }
```

History format (`execution-history.jsonl`): one JSON object per line, fields: `taskId`, `taskName`, `status` (`success`|`failure`|`timeout`), `startedAt`, `finishedAt`.

macOS plist label format: `com.claude-scheduler.<taskId>`

## Behavior

### Step 1 — Run all checks in parallel

Issue ALL of the following reads/commands simultaneously in one batch:

1. `Read ~/.claude/schedules.json` (global config)
2. `Read .claude/schedules.json` (project config — ignore if missing)
3. `Bash: tail -20 ~/.claude/execution-history.jsonl 2>/dev/null || echo NO_HISTORY`
4. `Bash: ls ~/Library/LaunchAgents/com.claude-scheduler.*.plist 2>/dev/null || echo NO_PLISTS` (macOS)
   OR `Bash: crontab -l 2>/dev/null | grep '#claude-scheduler' || echo NO_ENTRIES` (Linux — check with `uname -s` first if platform is unknown)
5. `Bash: launchctl list 2>/dev/null | grep com.claude-scheduler || echo NO_ENTRIES` (macOS only)

### Step 2 — Derive the task list

Merge global + project tasks (project tasks override global tasks with the same `id`).

### Step 3 — Empty state (no tasks)

If the merged task list is empty or both config files are missing, output:

```
Scheduler Status

Platform:         macOS (launchd)   [or Linux (cron)]
System scheduler: available

Tasks: none configured

No tasks are currently scheduled.
Run /scheduler:add to create your first task.
```

Then stop — do not attempt further per-task checks.

### Step 4 — Per-task status table

For each task, determine:

- **Enabled**: `task.enabled` true/false
- **Schedule**: `task.trigger.cron` value
- **OS registered**: plist file exists for this `taskId` (macOS) or crontab entry present (Linux)
- **Last run**: most recent history record for this `taskId`; show status + relative time, or "never"
- **Sync**: "in-sync" if config+OS both present and enabled matches; "out-of-sync" if mismatch; "missing" if in config but not registered

Output a table:

```
Task              Enabled  Schedule        OS Registered  Last Run          Sync
────────────────  ───────  ──────────────  ─────────────  ────────────────  ──────────
<name>            yes      every day 2am   yes            success 3h ago    in-sync
```

### Step 5 — Issues and remediation

Report any issues found:

- **Not registered**: task in config but no plist/crontab entry → suggest re-running `/scheduler:add`
- **Orphaned**: plist/crontab entry with no matching config task → suggest manual removal or `/scheduler:remove`
- **Executor missing**: shared executor at `~/.claude/bin/claude-scheduler-run` does not exist → suggest running `/scheduler:add` to reinstall
- **Recent failures**: last execution status is `failure` or `timeout` → show taskId and suggest `/scheduler:logs <id>`
- **Out-of-sync**: enabled flag differs between config and OS registration → suggest `/scheduler:add` to re-sync

If no issues, output: `No issues found.`

## Examples

User: "Check scheduler status"
User: "Are my scheduled tasks working?"
User: "Schedule health check"
