---
allowed-tools:
  - Read
  - Bash(node -e *)
  - Bash(echo $PATH)
  - Bash(launchctl load *)
  - Bash(launchctl unload *)
  - Bash(launchctl list *)
  - Bash(uname -s)
  - Bash(crontab *)
---

# /add

Add a new scheduled task. Accepts a natural language schedule or a cron expression.

## Data Sources

| Data | Path |
|------|------|
| Global config | `~/.claude/schedules.json` |
| Wrapper scripts | `~/.claude/logs/<taskId>.sh` |
| macOS plist | `~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist` |
| Linux crontab markers | `# claude-scheduler:<taskId>:begin` … `# claude-scheduler:<taskId>:end` |

Config format:
```json
{ "version": 1, "tasks": [ { "id": "...", "name": "...", "enabled": true, "trigger": { "type": "cron", "expression": "...", "timezone": "local" }, "execution": { "command": "...", "workingDirectory": "...", "timeout": 300, "skipPermissions": false }, "tags": [], "createdAt": "...", "updatedAt": "..." } ] }
```

## Behavior

### Step 1 — Parse input

From the user's input, determine:
- **Task name**: A short kebab-case identifier (e.g., `daily-code-review`)
- **Schedule**: Natural language (e.g., "every day at 9am") or cron expression (e.g., `0 9 * * *`)
- **Command**: The natural-language prompt for Claude to execute (NOT a slash command)
- **Working directory**: Defaults to the current project directory (resolved to absolute path)
- **Timeout**: Defaults to 300 seconds
- **skipPermissions**: Defaults to false. Only settable for global config tasks.

### Step 2 — Validate schedule and compute next runs

Run a single `node -e` call to validate and humanize the schedule:

```bash
SCHEDULE_INPUT='<user schedule text or cron>' node -e "
const { naturalLanguageToCron, validateCron, getNextRuns, CRON_PRESETS } = require('./dist/cron/parser.js');
const { cronToHuman } = require('./dist/cron/humanizer.js');
const input = process.env.SCHEDULE_INPUT.trim();
let cron = input;
// Try natural language first
const nlResult = naturalLanguageToCron(input);
if (nlResult) { cron = nlResult; }
// Try presets
if (CRON_PRESETS[input.toLowerCase()]) { cron = CRON_PRESETS[input.toLowerCase()]; }
// Validate
const v = validateCron(cron);
if (!v.valid) { console.log(JSON.stringify({ error: v.error })); process.exit(1); }
const human = cronToHuman(cron);
const nextRuns = getNextRuns(cron, 3).map(d => d.toISOString());
console.log(JSON.stringify({ cron, human, nextRuns }));
"
```

If validation fails, show the error and ask the user to correct the schedule.

### Step 3 — Show confirmation and wait

Display:

```
New Scheduled Task

Name:             <task-name>
Schedule:         <human-readable> (<cron expression>)
Command:          <prompt text>
Working directory: <absolute path>
Timeout:          <N>s
Skip permissions: yes / no

Next 3 runs:
  1. <formatted date>
  2. <formatted date>
  3. <formatted date>
```

**Wait for user confirmation before proceeding.** Do not execute any writes until the user confirms.

### Step 4 — On confirmation, execute ALL of the following in one turn

Do NOT pause between sub-steps. Execute the entire sequence.

**CRITICAL: All file writes MUST use `node -e` via the Bash tool, NOT the Write tool.**
The Write tool's operations are tracked by Claude Code and rolled back when a conversation
ends or is cancelled. Bash writes go directly to the filesystem and persist permanently.

#### 4a — Generate task ID and capture PATH

Run in parallel:
```bash
node -e "console.log(require('crypto').randomUUID())"
```
```bash
echo $PATH
```

#### 4b — Write config

Use a `node -e` call (NOT the Write tool — Bash writes are immune to session rollback):

```bash
TASK_JSON='<JSON object below>' node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(process.env.HOME, '.claude', 'schedules.json');
let config;
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch { config = { version: 1, tasks: [] }; }
const task = JSON.parse(process.env.TASK_JSON);
config.tasks.push(task);
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log('Config written: ' + configPath);
"
```

Where `TASK_JSON` is the JSON-stringified task object:

```json
{
  "id": "<generated-uuid>",
  "name": "<task-name>",
  "description": "<brief description>",
  "enabled": true,
  "trigger": {
    "type": "cron",
    "expression": "<cron>",
    "timezone": "local"
  },
  "execution": {
    "command": "<prompt text>",
    "workingDirectory": "<absolute path>",
    "timeout": <N>,
    "skipPermissions": <true|false>
  },
  "tags": [],
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

Shell-escape the JSON by wrapping in single quotes with internal `'` replaced by `'\''`.

#### 4c — Write wrapper script

Use a `node -e` call (NOT the Write tool — Bash writes are immune to session rollback).

Build the wrapper script content by substituting all `<variables>` into the template below, then write it via `node -e`:

```bash
#!/bin/bash
# Claude Code Scheduler - Direct Wrapper
# Task: <taskId> (<taskName>)
set -euo pipefail

export PATH="<captured PATH>"

mkdir -p '<logsDir>'
cd '<workingDirectory>'

LOCKFILE='/tmp/claude-scheduler-<taskId>.lock'
TIMEOUT=<timeout>

# Portable stat: Linux syntax first (GNU stat -f returns filesystem info, not file mtime)
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

if ! mkdir "$LOCKFILE" 2>/dev/null; then
  if [ -d "$LOCKFILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(file_mtime "$LOCKFILE") ))
    if [ "$LOCK_AGE" -gt $(( TIMEOUT + 60 )) ]; then
      LOCK_PID=$(cat "$LOCKFILE/pid" 2>/dev/null)
      if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "Task <taskId> still running (PID $LOCK_PID), skipping." >&2
        exit 0
      fi
      rm -rf "$LOCKFILE"
      mkdir "$LOCKFILE" 2>/dev/null || { echo "Task <taskId> already running, skipping." >&2; exit 0; }
    else
      echo "Task <taskId> already running, skipping." >&2
      exit 0
    fi
  fi
fi
echo $$ > "$LOCKFILE/pid"

CLAUDE_PID=""

cleanup() {
  if [ -n "$CLAUDE_PID" ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
    kill -TERM "$CLAUDE_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  fi
  rm -rf "$LOCKFILE"
}
trap cleanup EXIT INT TERM

claude -p '<shell-escaped command>'<skipPermissionsFlag> \
  >"<logsDir>/<taskId>.out.log" \
  2>"<logsDir>/<taskId>.err.log" &
CLAUDE_PID=$!

wait_with_timeout() {
  local pid=$1
  local timeout=$2
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
  return $?
}

if wait_with_timeout "$CLAUDE_PID" "$TIMEOUT"; then
  EXIT_CODE=$?
else
  kill -TERM "$CLAUDE_PID" 2>/dev/null || true
  sleep 5
  kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  echo "failure:timeout" > "<logsDir>/<taskId>.status"
  exit 1
fi

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "success" > "<logsDir>/<taskId>.status"
else
  echo "failure:exit-$EXIT_CODE" > "<logsDir>/<taskId>.status"
fi

exit $EXIT_CODE
```

Where:
- `<logsDir>` = `~/.claude/logs` (use absolute path `$HOME/.claude/logs`)
- `<skipPermissionsFlag>` = ` --dangerously-skip-permissions` if enabled, empty string otherwise
- Shell-escape the command by wrapping in single quotes with internal `'` replaced by `'\''`

Then write the script and set permissions via `node -e` (NOT the Write tool):

```bash
SCRIPT_CONTENT='<shell-escaped script content>' SCRIPT_PATH='<absolute path to ~/.claude/logs/<taskId>.sh>' node -e "
const fs = require('fs');
const path = require('path');
fs.mkdirSync(path.dirname(process.env.SCRIPT_PATH), { recursive: true });
fs.writeFileSync(process.env.SCRIPT_PATH, process.env.SCRIPT_CONTENT);
fs.chmodSync(process.env.SCRIPT_PATH, 0o755);
console.log('Wrapper written: ' + process.env.SCRIPT_PATH);
"
```

#### 4d — Register with OS scheduler

**macOS** — write a plist and load it.

Use a `node -e` call to write `~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist` (NOT the Write tool — Bash writes are immune to session rollback):

Generate the schedule section and write the complete plist in a single `node -e` call:

```bash
CRON='<cron expression>' TASK_ID='<taskId>' SCRIPT_PATH='<absolute wrapper script path>' LOGS_DIR='<absolute logsDir>' PLIST_PATH='<absolute path to ~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist>' node -e "
const fs = require('fs');
const path = require('path');
const { cronToCalendarInterval } = require('./dist/schedulers/darwin.js');

const intervals = cronToCalendarInterval(process.env.CRON);
let scheduleSection;
if (intervals) {
  let xml = '  <key>StartCalendarInterval</key>\n  <array>\n';
  for (const iv of intervals) {
    xml += '    <dict>\n';
    for (const [k,v] of Object.entries(iv)) {
      xml += '      <key>' + k + '</key>\n      <integer>' + v + '</integer>\n';
    }
    xml += '    </dict>\n';
  }
  xml += '  </array>';
  scheduleSection = xml;
} else {
  const m = process.env.CRON.match(/^\*\/(\d+) \* \* \* \*$/);
  if (m) scheduleSection = '  <key>StartInterval</key>\n  <integer>' + (parseInt(m[1])*60) + '</integer>';
  else scheduleSection = '  <key>StartCalendarInterval</key>\n  <array>\n    <dict>\n      <key>Minute</key>\n      <integer>0</integer>\n    </dict>\n  </array>';
}

const plist = '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>com.claude-scheduler.' + process.env.TASK_ID + '</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/bin/bash</string>\n    <string>' + process.env.SCRIPT_PATH + '</string>\n  </array>\n  <key>StandardOutPath</key>\n  <string>' + process.env.LOGS_DIR + '/' + process.env.TASK_ID + '.out.log</string>\n  <key>StandardErrorPath</key>\n  <string>' + process.env.LOGS_DIR + '/' + process.env.TASK_ID + '.err.log</string>\n' + scheduleSection + '\n</dict>\n</plist>\n';

fs.mkdirSync(path.dirname(process.env.PLIST_PATH), { recursive: true });
fs.writeFileSync(process.env.PLIST_PATH, plist);
console.log('Plist written: ' + process.env.PLIST_PATH);
"
```

Then register:
```bash
launchctl load ~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist
```

**Linux** — add a crontab entry:
```bash
TASK_ID='<taskId>' CRON='<cron expression>' SCRIPT='<wrapper script path>' node -e "
const { execSync } = require('child_process');
const current = execSync('crontab -l 2>/dev/null || echo \"\"').toString();
const marker = '# claude-scheduler:' + process.env.TASK_ID;
const entry = marker + ':begin\n' + process.env.CRON + ' /bin/bash ' + process.env.SCRIPT + '\n' + marker + ':end';
const updated = current.trimEnd() + '\n' + entry + '\n';
require('fs').writeFileSync('/tmp/crontab-new', updated);
execSync('crontab /tmp/crontab-new');
console.log('crontab updated');
"
```

#### 4e — Verify registration

**macOS:**
```bash
launchctl list | grep com.claude-scheduler.<taskId>
```

**Linux:**
```bash
crontab -l | grep claude-scheduler.<taskId>
```

### Step 5 — Report success

```
Task "<name>" scheduled successfully.

ID:       <taskId>
Schedule: <human-readable> (<cron>)
Next run: <next run date>

Use /scheduler:logs <name> to check output after the first run.
Use /scheduler:run <name> to trigger it manually.
```

## Important constraints

- The `command` field must be a natural-language prompt, NOT a slash command. Slash commands are not supported in scheduled execution.
- The `skipPermissions` flag can only be set in the global config (`~/.claude/schedules.json`), never from project-level configs.
- Task IDs are UUIDs generated via `crypto.randomUUID()`.
- Working directory must be an absolute path.
- Shell-escape all user-provided strings embedded in the wrapper script (single-quote wrapping with `'` → `'\''`).
- XML-escape strings in the plist (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`).

## Examples

User: "Schedule a daily code review at 9am"
User: "Add a task to run 'Summarize git log for the past day' every weekday at 5pm"
User: "Schedule 'Check for dependency updates' with cron 0 8 * * 1"
