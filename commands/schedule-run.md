---
allowed-tools:
  - Read
  - Glob
  - Bash(node -e *)
  - Bash(/bin/bash *)
---

# /schedule-run

Manually trigger a scheduled task for immediate execution.

## Behavior

1. Find the task using `findTask()` from `src/config.ts`:
   - First tries exact ID match
   - Falls back to case-insensitive name match

2. Show the task details:
   - Task name and ID
   - Command that will be executed
   - Working directory
   - Timeout setting

3. On confirmation:
   - Execute the wrapper script directly (bypassing the OS scheduler)
   - Stream output in real-time if possible
   - Record the execution in history using `recordExecution()` from `src/history/index.ts`
   - Report the result (success/failure/timeout)

4. If the task is not found, inform the user and suggest `/schedule-list`.

## Important constraints

- This runs the task's wrapper script, which includes timeout enforcement and concurrency guard.
- If the task is already running (flock held), the execution will be skipped with a message.

## Examples

User: "Run the daily-review task now"
User: "Trigger daily-review manually"
User: "Execute 'Code Review' immediately"
