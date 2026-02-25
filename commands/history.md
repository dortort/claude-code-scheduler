---
allowed-tools:
  - Read
  - Glob
  - Bash(node -e *)
---

# /history

View execution history for scheduled tasks.

## Behavior

1. Load execution history using `getRecentExecutions()` from `src/history/index.ts`.

2. Apply filters based on user input:
   - **Task ID or name**: Filter to a specific task
   - **Status**: Filter by success/failure/timeout
   - **Limit**: Number of records to show (default: 20)

3. For each execution record, display:
   - **Task ID** and **name**
   - **Started at**: Formatted timestamp
   - **Duration**: Formatted duration (via `formatDuration()`)
   - **Status**: success / failure / timeout
   - **Exit code** (if applicable)
   - **Commit SHA** (if worktree mode produced changes)

4. Show summary statistics:
   - Total executions in the displayed period
   - Success rate
   - Average duration

5. If no history exists, inform the user that no tasks have been executed yet.

## Examples

User: "Show execution history"
User: "History for daily-review"
User: "Show failed executions"
User: "Last 5 task runs"
