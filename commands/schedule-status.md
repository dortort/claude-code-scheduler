---
allowed-tools:
  - Read
  - Glob
  - Bash(launchctl list *)
  - Bash(crontab -l)
  - Bash(node -e *)
---

# /schedule-status

Show the health status of the scheduling system and individual tasks.

## Behavior

1. Detect the current platform (macOS/Linux).

2. Check system-level health:
   - **macOS**: Verify launchd is running, list registered claude-scheduler plist files
   - **Linux**: Verify crontab access, list claude-scheduler entries

3. For each configured task, check:
   - **Config status**: Task exists in config file
   - **OS registration**: Task is registered with the OS scheduler
   - **Wrapper script**: Script file exists and is executable
   - **Last execution**: Status from history (success/failure/timeout/never-run)
   - **Sync status**: Config matches OS registration (in-sync/out-of-sync/missing)

4. Report any issues:
   - Tasks in config but not registered with OS
   - OS entries without matching config (orphaned)
   - Missing or non-executable wrapper scripts
   - Recent failures or timeouts

5. Suggest remediation for any issues found.

## Examples

User: "Check scheduler status"
User: "Are my scheduled tasks working?"
User: "Schedule health check"
