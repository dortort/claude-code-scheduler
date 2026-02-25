---
allowed-tools:
  - Read
  - Bash(tail *)
  - Bash(cat *)
---

# /logs

View stdout and stderr logs for a scheduled task.

## Data Sources

| Data | Path pattern |
|------|--------------|
| Global config | `~/.claude/schedules.json` |
| Project config | `.claude/schedules.json` (optional) |
| stdout log (macOS) | `~/.claude/logs/<taskId>.out.log` |
| stderr log (macOS) | `~/.claude/logs/<taskId>.err.log` |
| combined log (Linux) | `~/.claude/logs/<taskId>.log` |
| status marker | `~/.claude/logs/<taskId>.status` |

Config format:
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "..." } ] }
```

Status marker content examples: `success`, `failure:exit-1`, `failure:timeout`

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` (and `.claude/schedules.json` if present) directly as JSON — no `node -e` needed.
Match the user's input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`

### Step 2 — Read logs in parallel

With the resolved `<taskId>`, issue all reads simultaneously:

**macOS:**
1. `Bash: tail -50 ~/.claude/logs/<taskId>.out.log 2>/dev/null || echo NO_STDOUT`
2. `Bash: tail -50 ~/.claude/logs/<taskId>.err.log 2>/dev/null || echo NO_STDERR`
3. `Bash: cat ~/.claude/logs/<taskId>.status 2>/dev/null || echo NO_STATUS`

**Linux:** replace steps 1+2 with:
1. `Bash: tail -50 ~/.claude/logs/<taskId>.log 2>/dev/null || echo NO_LOG`

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
