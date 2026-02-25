---
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash(node -e *)
  - Bash(launchctl *)
  - Bash(crontab *)
---

# /remove

Remove a scheduled task by ID or name.

## Behavior

1. Find the task using `findTask()` from `src/config.ts`:
   - First tries exact ID match
   - Falls back to case-insensitive name match

2. Show the task details and ask for confirmation before removing.

3. On confirmation:
   - Unregister from the OS scheduler:
     - **macOS**: `launchctl unload` the plist, then delete the plist file
     - **Linux**: Remove the task's marker block from crontab
   - Remove the wrapper script file
   - Remove from the configuration using `removeTask()` from `src/config.ts`
   - Report success

4. If the task is not found, inform the user and suggest `/scheduler:list` to see available tasks.

## Examples

User: "Remove the daily-review task"
User: "Delete schedule daily-review"
User: "Unschedule 'Code Review'"
