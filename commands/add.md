---
allowed-tools:
  - Read
  - Bash(~/.claude/bin/claude-scheduler-cli *)
  - Bash(echo $PATH)
  - Bash(launchctl list *)
  - Bash(crontab -l *)
---

# /add

Add a new scheduled task. Accepts a natural language schedule or a cron expression.

## Behavior

### Step 1 — Parse input

From the user's input, determine:
- **Task name**: A short kebab-case identifier (e.g., `daily-code-review`)
- **Schedule**: Natural language (e.g., "every day at 9am") or cron expression (e.g., `0 9 * * *`)
- **Command**: The natural-language prompt for Claude to execute (NOT a slash command)
- **Working directory**: Defaults to the current project directory (resolved to absolute path)
- **Timeout**: Defaults to 300 seconds
- **skipPermissions**: Defaults to true for scheduled tasks (headless execution cannot prompt for permissions). Set to false only if the user explicitly requests permission checks. If set to false, show a warning in the confirmation step: "Note: this task may hang if it encounters a permission prompt during unattended execution."
- **Memory**: If the task is a recurring monitoring, checking, or alerting task (not a full report or summary), set `--memory` to enable run-to-run context. This injects the previous run's output so Claude focuses on new/changed items only. Show the inferred value in the confirmation table.

### Step 2 — Validate schedule and compute next runs

Run a single `node -e` call to validate and humanize the schedule:

```bash
~/.claude/bin/claude-scheduler-cli validate-schedule --input '<user schedule text or cron>'
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
Memory:           yes / no (inferred from task type)

Next 3 runs:
  1. <formatted date>
  2. <formatted date>
  3. <formatted date>
```

**Wait for user confirmation before proceeding.** Do not execute any writes until the user confirms.

### Step 4 — On confirmation, create the task

Run a single CLI call that handles config, OS registration, and executor installation atomically:

```bash
~/.claude/bin/claude-scheduler-cli add \
  --name '<task-name>' \
  --cron '<cron expression>' \
  --command '<prompt text>' \
  --working-directory '<absolute path>' \
  --timeout <N>
```

Add `--skip-permissions` if the user requested autonomous execution.
Add `--memory` if the task benefits from run-to-run context (monitoring/checking tasks).
Add `--description '<brief description>'` if appropriate.

The CLI returns JSON: `{ "success": true, "task": { "id": "...", "name": "..." }, "configSaved": true, "osRegistered": true }`

If `success` is false, show the error from the JSON response.

### Step 5 — Verify registration

**macOS:**
```bash
launchctl list | grep com.claude-scheduler.<taskId>
```

**Linux:**
```bash
crontab -l | grep claude-scheduler.<taskId>
```

### Step 6 — Report success

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
- Working directory must be an absolute path.

## Examples

User: "Schedule a daily code review at 9am"
User: "Add a task to run 'Summarize git log for the past day' every weekday at 5pm"
User: "Schedule 'Check for dependency updates' with cron 0 8 * * 1"
