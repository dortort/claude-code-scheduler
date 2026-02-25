---
allowed-tools:
  - Read
  - Glob
  - Bash(node -e *)
---

# /schedule-logs

View stdout and stderr logs for a scheduled task.

## Behavior

1. Find the task using `findTask()` from `src/config.ts`:
   - First tries exact ID match
   - Falls back to case-insensitive name match

2. Determine log file paths using `getLogPaths()` from `src/logs/index.ts`:
   - **macOS**: Separate `.out.log` (stdout) and `.err.log` (stderr) files
   - **Linux**: Combined `.log` file

3. Read and display the log contents:
   - By default, show the last 50 lines
   - If the user requests "full" or "all", show the complete log
   - Show both stdout and stderr (separately labeled on macOS)

4. Also show the status marker file content if it exists (`.status`).

5. If no logs exist, inform the user that the task hasn't been executed yet.

## Examples

User: "Show logs for daily-review"
User: "View the output of my last scheduled run"
User: "Show full logs for 'Code Review'"
