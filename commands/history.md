---
allowed-tools:
  - Bash(cat *)
  - Bash(tail *)
---

# /history

View execution history for scheduled tasks.

## Data Sources

The state directory is `$CLAUDE_SCHEDULER_STATE_DIR` when set, otherwise
`~/.claude`; in Bash read it as `"${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}"`.

| Data | Path |
|------|------|
| Execution history | `${CLAUDE_SCHEDULER_STATE_DIR:-~/.claude}/execution-history.jsonl` |

History record format (one JSON object per line):
```json
{ "taskId": "daily-review", "taskName": "Daily Review", "status": "success", "startedAt": "2024-01-01T09:00:00.000Z", "finishedAt": "2024-01-01T09:02:30.000Z", "exitCode": 0, "commitSha": null }
```

Fields: `taskId`, `taskName`, `status` (`success`|`failure`|`timeout`), `startedAt`, `finishedAt`, `exitCode` (optional), `commitSha` (optional — set when worktree mode produced a commit).

## Behavior

### Step 1 — Read history

```bash
cat "${CLAUDE_SCHEDULER_STATE_DIR:-$HOME/.claude}/execution-history.jsonl" 2>/dev/null || echo NO_HISTORY
```

### Step 2 — Empty state

If the file doesn't exist or contains no valid records, output:

```
No execution history found.
Tasks haven't been executed yet.
```

Then stop.

### Step 3 — Apply filters from user input

- **Task ID or name**: case-insensitive match on `taskId` or `taskName`
- **Status filter**: `success`, `failure`, or `timeout`
- **Limit**: default 20 most recent records

### Step 4 — Output

Sort records by `startedAt` descending (newest first). For each record display:
- **Task**: name (ID)
- **Started**: formatted timestamp + relative time (e.g. "3h ago")
- **Duration**: `finishedAt − startedAt` formatted (e.g. "2m 30s")
- **Status**: success / failure / timeout
- **Exit code**: if present and non-zero
- **Commit**: short SHA if present

Show a summary line at the bottom:
`X executions shown — Y% success rate — avg Zs duration`

## Examples

User: "Show execution history"
User: "History for daily-review"
User: "Show failed executions"
User: "Last 5 task runs"
