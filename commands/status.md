---
allowed-tools:
  - Read
  - Glob
  - Bash(cat *)
  - Bash(tail *)
  - Bash(launchctl list *)
  - Bash(crontab -l)
  - Bash(ls ~/Library/LaunchAgents/com.claude-scheduler.*.plist *)
  - Bash(uname -s)
---

# /status

Show the health status of the scheduling system and individual tasks.

## Data Sources

All checks use these exact paths — do NOT read any source files. The state
directory is `$CLAUDE_SCHEDULER_STATE_DIR` when set, otherwise `~/.claude`; in
Bash always read it as `"${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}"`.

| Data | Path |
|------|------|
| Global config | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/schedules.json` |
| Project config | `.claude/schedules.json` (optional, only if present) |
| Execution history | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/execution-history.jsonl` |
| macOS plist files | `~/Library/LaunchAgents/com.claude-scheduler.*.plist` (OS-managed; always real home) |

Config format (`schedules.json`):
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "...", "enabled": true, "trigger": { "cron": "..." }, "workingDirectory": "..." } ] }
```

History format (`execution-history.jsonl`): one JSON object per line, fields: `taskId`, `taskName`, `status` (`success`|`failure`|`timeout`), `startedAt`, `finishedAt`.

macOS plist label format: `com.claude-scheduler.<taskId>`

## Behavior

### Step 1 — Run all checks in parallel

Issue ALL of the following reads/commands simultaneously in one batch:

1. `Bash: cat "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/schedules.json" 2>/dev/null || echo NO_GLOBAL_CONFIG` (global config)
2. `Bash: cat .claude/schedules.json 2>/dev/null || echo NO_PROJECT_CONFIG` (project config — ignore if missing)
3. `Bash: tail -20 "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/execution-history.jsonl" 2>/dev/null || echo NO_HISTORY`
4. `Bash: ls ~/Library/LaunchAgents/com.claude-scheduler.*.plist 2>/dev/null || echo NO_PLISTS` (macOS)
   OR `Bash: crontab -l 2>/dev/null | grep '#claude-scheduler' || echo NO_ENTRIES` (Linux — check with `uname -s` first if platform is unknown)
5. `Bash: launchctl list 2>/dev/null | grep com.claude-scheduler || echo NO_ENTRIES` (macOS only)

### Step 2 — Derive the task list

Merge global + project tasks (project tasks override global tasks with the same `id`).

### Step 3 — Empty state (no configured tasks)

If the merged task list is empty (or both config files are missing), the block
below is the PRIMARY output and MUST always be shown — even when orphaned OS
registrations exist. Never replace it with an issues-only report.

```
Scheduler Status

Platform:         macOS (launchd)   [or Linux (cron)]
System scheduler: available

Tasks: none configured

No tasks are currently scheduled.
Run /scheduler:add to create your first task.
```

You MAY append a brief "Orphaned registrations" note afterward if plist or
launchctl entries exist with no matching config, but the `Tasks: none configured`
line must appear first. Do not perform per-task status checks.

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
