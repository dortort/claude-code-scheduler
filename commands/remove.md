---
allowed-tools:
  - Read
  - Bash(node -e *)
  - Bash(launchctl *)
  - Bash(crontab *)
  - Bash(rm *)
---

# /remove

Remove a scheduled task by ID or name.

## Data Sources

| Data | Path |
|------|------|
| Global config | `~/.claude/schedules.json` |
| Project config | `.claude/schedules.json` (optional) |
| macOS plist | `~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist` |
| Wrapper script | `~/.claude/logs/<taskId>.sh` |
| Linux crontab markers | `# claude-scheduler:<taskId>:begin` … `# claude-scheduler:<taskId>:end` |

Config format:
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "...", "enabled": true, "trigger": { "cron": "..." }, "execution": { "workingDirectory": "..." } } ] }
```

## Behavior

### Step 1 — Find the task

Read `~/.claude/schedules.json` (and `.claude/schedules.json` if present) directly as JSON — no `node -e` needed.
Match input against task `id` (exact) or `name` (case-insensitive).

If not found: `Task "<input>" not found. Run /scheduler:list to see available tasks.`

Note which config file the task came from (global or project) — this determines which file to update in step 3.

### Step 2 — Confirm

Show the task name, ID, schedule cron, and working directory. Ask for confirmation before removing.

### Step 3 — Remove OS registration

**macOS** (run in sequence):
```bash
launchctl unload ~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist
rm -f ~/.claude/logs/<taskId>.sh
```

**Linux** — rebuild crontab without the task's marker block using the compiled module:
```bash
TASK_ID=<taskId> node -e "
const { buildCrontabContent } = require('./dist/schedulers/linux.js');
const { execSync } = require('child_process');
const current = execSync('crontab -l 2>/dev/null || echo \"\"').toString();
const updated = buildCrontabContent(current, null, process.env.TASK_ID);
require('fs').writeFileSync('/tmp/crontab-new', updated);
execSync('crontab /tmp/crontab-new');
console.log('crontab updated');
"
rm -f ~/.claude/logs/<taskId>.sh
```

### Step 4 — Remove from config

```bash
CONFIG_PATH=~/.claude/schedules.json TASK_ID=<taskId> node -e "
const { loadConfig, removeTask, saveConfig } = require('./dist/config.js');
const p = process.env.CONFIG_PATH;
loadConfig(p).then(cfg => {
  removeTask(cfg, process.env.TASK_ID);
  return saveConfig(p, cfg);
}).then(() => console.log('removed'));
"
```

Use the config path from step 1 (global or project).

### Step 5 — Report

`Task "<name>" removed successfully.`

## Examples

User: "Remove the daily-review task"
User: "Delete schedule daily-review"
User: "Unschedule 'Code Review'"
