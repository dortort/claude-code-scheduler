---
allowed-tools:
  - Read
  - Bash(tail *)
  - Bash(cat *)
---

# /logs

View stdout and stderr logs for a scheduled task.

## Data Sources

The state directory is `$CLAUDE_SCHEDULER_STATE_DIR` when set, otherwise
`~/.claude`; in Bash read it as `"${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}"`.

| Data | Path pattern |
|------|--------------|
| Global config | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/schedules.json` |
| Project config | `.claude/schedules.json` (optional) |
| stdout log (macOS) | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/logs/<taskId>.out.log` |
| stderr log (macOS) | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/logs/<taskId>.err.log` |
| combined log (Linux) | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/logs/<taskId>.log` |
| status marker | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/logs/<taskId>.status` |

Config format:
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "..." } ] }
```

Status marker content examples: `success`, `failure:exit-1`, `failure:timeout`

## Behavior

### Step 1 — Find the task

Read the config as JSON — no `node -e` needed:
- `Bash: cat "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/schedules.json" 2>/dev/null || echo NO_GLOBAL_CONFIG`
- `Bash: cat .claude/schedules.json 2>/dev/null || echo NO_PROJECT_CONFIG` (if present)

Match the user's input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`

### Step 2 — Read logs in parallel

With the resolved `<taskId>`, issue all reads simultaneously:

**macOS:**
1. `Bash: tail -50 "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/logs/<taskId>.out.log" 2>/dev/null || echo NO_STDOUT`
2. `Bash: tail -50 "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/logs/<taskId>.err.log" 2>/dev/null || echo NO_STDERR`
3. `Bash: cat "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/logs/<taskId>.status" 2>/dev/null || echo NO_STATUS`

**Linux:** replace steps 1+2 with:
1. `Bash: tail -50 "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/logs/<taskId>.log" 2>/dev/null || echo NO_LOG`

If the user requests "full" or "all", use `cat` instead of `tail -50`.

### Step 3 — Output

Show task name and ID as a header, then:
- **Status**: content of `.status` file (e.g. `success`, `failure:exit-1`, `failure:timeout`), or "not yet run"
- **Output** (stdout): log content, or "No output yet"
- **Errors** (stderr, macOS only): log content, or "No errors"

If no log files exist at all:
`No logs found for "<name>". The task may not have run yet.`

## Examples

User: "Show logs for daily-review"
User: "View the output of my last scheduled run"
User: "Show full logs for 'Code Review'"
