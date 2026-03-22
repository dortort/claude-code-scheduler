---
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(node -e *)
  - Bash(chmod +x *)
  - Bash(mkdir -p *)
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

Do NOT pause between sub-steps. Execute the entire sequence:

#### 4a — Generate task ID and capture PATH

Run in parallel:
```bash
node -e "console.log(require('crypto').randomUUID())"
```
```bash
echo $PATH
```

#### 4b — Write config

Read `~/.claude/schedules.json` (or treat as `{ "version": 1, "tasks": [] }` if missing).
Append the new task to the `tasks` array and write the file:

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

#### 4c — Write wrapper script

Write the wrapper script to `~/.claude/logs/<taskId>.sh`. Ensure `~/.claude/logs/` exists first (`mkdir -p`).

The wrapper script template (substitute all `<variables>`):

```bash
#!/bin/bash
# Claude Code Scheduler - Direct Wrapper
# Task: <taskId> (<taskName>)
set -euo pipefail

export PATH="<captured PATH>"

mkdir -p '<logsDir>'
cd '<workingDirectory>'

LOCKFILE='/tmp/claude-scheduler-<taskId>.lock'
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "Task <taskId> is already running, skipping." >&2
  exit 0
fi

TIMEOUT=<timeout>
CLAUDE_PID=""

cleanup() {
  if [ -n "$CLAUDE_PID" ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
    kill -TERM "$CLAUDE_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  fi
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

Then: `chmod +x ~/.claude/logs/<taskId>.sh`

#### 4d — Register with OS scheduler

**macOS** — write a plist and load it:

Write to `~/Library/LaunchAgents/com.claude-scheduler.<taskId>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-scheduler.<taskId></string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string><absolute path to wrapper script></string>
  </array>
  <key>StandardOutPath</key>
  <string><logsDir>/<taskId>.out.log</string>
  <key>StandardErrorPath</key>
  <string><logsDir>/<taskId>.err.log</string>
  <SCHEDULE_SECTION>
</dict>
</plist>
```

For `<SCHEDULE_SECTION>`, generate it via `node -e`:

```bash
CRON='<cron expression>' node -e "
const { cronToCalendarInterval } = require('./dist/schedulers/darwin.js');
const intervals = cronToCalendarInterval(process.env.CRON);
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
  console.log(xml);
} else {
  // step-based fallback
  const m = process.env.CRON.match(/^\*\/(\d+) \* \* \* \*$/);
  if (m) console.log('  <key>StartInterval</key>\n  <integer>' + (parseInt(m[1])*60) + '</integer>');
  else console.log('  <key>StartCalendarInterval</key>\n  <array>\n    <dict>\n      <key>Minute</key>\n      <integer>0</integer>\n    </dict>\n  </array>');
}
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
