# Product Requirements Document: Claude Code Scheduler

**Version:** 0.1.0
**Status:** Implemented
**Last Updated:** 2026-02-25

---

## 1. Overview

### 1.1 Product Summary

Claude Code Scheduler is a Claude Code plugin that enables developers to schedule recurring and one-time AI-assisted tasks using native OS schedulers. It bridges Claude Code's interactive capabilities with automated, unattended execution via cron expressions and natural language scheduling.

### 1.2 Problem Statement

Developers perform repetitive AI-assisted workflows daily -- code reviews, dependency audits, test suite monitoring, documentation updates. Currently, each requires manual invocation of Claude Code. There is no way to:

- Automate these workflows on a schedule
- Run Claude Code tasks unattended (overnight, weekends)
- Isolate automated changes in separate git branches for review

### 1.3 Target Users

- **Individual developers** automating personal workflows
- **Tech leads** scheduling recurring code quality tasks
- **DevOps engineers** integrating AI-assisted monitoring into CI/CD-adjacent workflows

### 1.4 Success Metrics

| Metric | Target |
|--------|--------|
| Task creation success rate | >95% (valid config -> registered scheduler) |
| Cross-platform parity | Feature parity across macOS and Linux (Windows deferred to v0.2.0) |
| Scheduled execution reliability | >99% trigger accuracy (OS scheduler dependent) |

---

## 2. Core Features

### 2.1 Task Scheduling

#### 2.1.1 Schedule Creation

**Description:** Users create scheduled tasks via natural language or cron expressions through the `/schedule-add` command.

**Functional Requirements:**

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-1.1 | Accept cron expressions (5-field standard format) | P0 | Done |
| FR-1.2 | Accept natural language schedules ("daily at 9am") | P0 | Done |
| FR-1.3 | Support one-time triggers via discriminated union (`type: "cron"` or `type: "once"`) | P0 | Done |
| FR-1.4 | Generate unique task IDs via `crypto.randomUUID()`, validated by regex `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` | P0 | Done |
| FR-1.5 | Validate cron expressions via `croner` library before registration | P0 | Done |
| FR-1.6 | Show next N run times before confirming | P1 | Done |
| FR-1.7 | Support timezone configuration (IANA format) | P1 | Done (crontab TZ= prefix; launchd uses system tz) |

**User Flow:**
```
User: "schedule a daily code review at 9am"
  -> Plugin parses NL to cron: 0 9 * * *
  -> Asks for command/prompt to execute
  -> Asks about autonomous execution (skipPermissions)
  -> Optionally asks about worktree isolation
  -> Shows confirmation with next 3 run times
  -> Generates wrapper script
  -> Registers with OS scheduler
  -> Returns task ID
```

#### 2.1.2 Task Execution Modes

**Description:** Tasks execute in one of two modes based on configuration.

| Mode | `skipPermissions` | Behavior |
|------|-------------------|----------|
| Read-only | `false` (default) | Claude runs with standard permission prompts; limited to analysis/reporting |
| Autonomous | `true` | Claude runs with `--dangerously-skip-permissions`; can edit files, run commands, make git operations |

**Security constraint:** `skipPermissions` can only be set in the global config (`~/.claude/schedules.json`). Project-level configs have this flag stripped during merge.

#### 2.1.3 Git Worktree Isolation

**Description:** For autonomous tasks, changes can be isolated in a separate git worktree/branch.

**Functional Requirements:**

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-2.1 | Create git worktree with unique branch per execution | P0 | Done |
| FR-2.2 | Execute Claude in worktree directory | P0 | Done |
| FR-2.3 | Auto-commit changes with descriptive message | P0 | Done |
| FR-2.4 | Push to configurable remote (default: origin) | P0 | Done |
| FR-2.5 | Clean up worktree after successful push | P1 | Done |
| FR-2.6 | Configurable branch prefix (default: "claude-task/") | P2 | Done |

**Worktree Execution Flow:**
```
OS scheduler triggers wrapper script
  -> flock concurrency guard (skip if already running)
  -> Create worktree: git worktree add <path> -b <branchPrefix><shortId>-<timestamp>
  -> cd <worktree>
  -> Execute: claude -p '<prompt>' [--dangerously-skip-permissions]
  -> Stage tracked files only: git add -u (NOT git add -A)
  -> Commit: git commit -m "Claude scheduled task: <name>"
  -> Push: git push -u <remote> <branch>
  -> Cleanup: git worktree remove <path> --force
  -> trap handler cleans up on signal/error
```

**Key decision:** `git add -u` is used by default (not `-A`) to avoid staging untracked files that could contain secrets. Sensitive file patterns (.env, .pem, .key, credentials, etc.) are also detected.

#### 2.1.4 Platform-Specific Scheduler Integration

**Description:** Tasks are registered with the OS-native scheduler, not a custom daemon.

| Platform | Scheduler | Mechanism | Status |
|----------|-----------|-----------|--------|
| macOS | launchd | XML plist in `~/Library/LaunchAgents/` | Done |
| Linux | crontab | Cron entries with marker comments | Done |
| Windows | Task Scheduler | `schtasks` entries | Deferred to v0.2.0 |

**Rationale:** Native schedulers are more reliable than a custom daemon, survive reboots, and don't require a background process.

**macOS details:**
- Plist label: `com.claude-scheduler.<taskId>`
- Simple cron -> `StartCalendarInterval` (multiple dicts for multi-value fields)
- Step values with >24 expansions -> `StartInterval` fallback (seconds)
- One-time tasks use `RunAtLoad: true` without CalendarInterval
- XML escaping for all user-provided values (`& < > " '`)

**Linux details:**
- Marker comments: `# claude-scheduler:<taskId>:begin` / `:end`
- `PATH=` environment line in each entry block
- Optional `TZ=` prefix for timezone support
- Idempotent: replaces existing entry for same task ID

### 2.2 Task Management

#### 2.2.1 Available Commands

| Command | Description |
|---------|-------------|
| `/schedule-add` | Create a new scheduled task |
| `/schedule-list` | View all scheduled tasks with status and next run |
| `/schedule-remove` | Remove a scheduled task and unregister from OS |
| `/schedule-status` | Check scheduler health and sync status |
| `/schedule-run` | Manually trigger a task |
| `/schedule-logs` | View execution stdout/stderr logs |
| `/schedule-history` | View execution history with filters |

### 2.3 Configuration

#### 2.3.1 Config Locations

| Scope | Path | Trust Level |
|-------|------|-------------|
| Global | `~/.claude/schedules.json` | Trusted (user-owned) |
| Project | `<project>/.claude/schedules.json` | Untrusted (repo-sourced) |

**Merge behavior:** Global config wins on ID collision. Project tasks with colliding IDs are silently dropped with a stderr warning. `skipPermissions` is always stripped from project-level tasks.

#### 2.3.2 Config Schema (`schedules.json`)

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "alphanumeric-with-dots-hyphens-underscores",
      "name": "Human-readable name",
      "description": "Optional description",
      "enabled": true,
      "trigger": {
        "type": "cron",
        "expression": "0 9 * * 1-5",
        "timezone": "America/New_York"
      },
      "execution": {
        "command": "Natural language prompt for Claude",
        "workingDirectory": "/absolute/path/to/project",
        "timeout": 300,
        "env": {},
        "skipPermissions": false,
        "worktree": {
          "enabled": false,
          "branchPrefix": "claude-task/",
          "remoteName": "origin"
        }
      },
      "tags": [],
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601"
    }
  ]
}
```

**Key constraints:**
- `command` must be a natural-language prompt (slash commands not supported in scheduled execution)
- `workingDirectory` must be an absolute path (resolved at creation time)
- `env` keys are validated against a blocklist (PATH, HOME, USER, SHELL, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, NODE_OPTIONS, NODE_PATH, PYTHONPATH)
- Task IDs must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`

### 2.4 Logging and History

#### 2.4.1 Log Files

| File | Location | Content |
|------|----------|---------|
| stdout | `~/.claude/logs/<id>.out.log` | Claude's standard output (macOS) |
| stderr | `~/.claude/logs/<id>.err.log` | Claude's error output (macOS) |
| combined | `~/.claude/logs/<id>.log` | Combined output (Linux) |
| status | `~/.claude/logs/<id>.status` | Execution result marker (success/failure) |
| wrapper | `~/.claude/logs/<id>.sh` | Generated wrapper script |

**Log rotation:** Files rotate at configurable threshold, renamed to `.1` (single rotated copy).

#### 2.4.2 Execution History

- Append-only JSONL file at `~/.claude/execution-history.jsonl`
- Records: task ID, name, project, status, duration, trigger source, exit code
- Queryable by status, task ID, task name, project
- Sorted by startedAt (newest first)
- Auto-cleanup keeps last N records
- Corrupted lines skipped gracefully

### 2.5 Execution Wrapper

Each task gets a generated bash wrapper script that handles:

1. **PATH restoration** - Embeds the user's PATH captured at registration time
2. **Working directory** - `cd` to the absolute working directory
3. **Concurrency guard** - `flock -n` prevents parallel execution of the same task
4. **Timeout enforcement** - Background process with kill after timeout + grace period
5. **Claude invocation** - `claude -p '<escaped-prompt>'` with optional `--dangerously-skip-permissions`
6. **Log routing** - stdout and stderr to separate files
7. **Status marker** - Writes success/failure to `.status` file
8. **Signal handling** - `trap` cleans up on EXIT, INT, TERM

---

## 3. Non-Functional Requirements

### 3.1 Security (Built-in, Not Bolted-on)

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| NFR-S1 | All user input shell-escaped via single-quote wrapping before embedding in commands | P0 | Done |
| NFR-S2 | XML special characters escaped in launchd plist generation | P0 | Done |
| NFR-S3 | Task IDs restricted to safe filesystem characters (`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`) | P0 | Done |
| NFR-S4 | Project-level configs cannot set `skipPermissions: true` (stripped during merge) | P0 | Done |
| NFR-S5 | Environment variable blocklist prevents PATH/HOME/LD_PRELOAD injection | P0 | Done |
| NFR-S6 | Worktree mode uses `git add -u` (not `-A`) to avoid staging secrets | P0 | Done |
| NFR-S7 | Sensitive file pattern detection (.pem, .key, .env, credentials, etc.) | P1 | Done |
| NFR-S8 | Global config wins on ID collision (project can't override global tasks) | P0 | Done |

### 3.2 Reliability

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| NFR-R1 | Graceful handling of missing/corrupt schedules.json (fallback to empty config) | P0 | Done |
| NFR-R2 | Log rotation to prevent disk exhaustion | P1 | Done |
| NFR-R3 | History cleanup based on configurable retention | P1 | Done |
| NFR-R4 | Worktree removal retries once after 500ms (handles file lock races) | P1 | Done |
| NFR-R5 | flock concurrency guard prevents duplicate executions | P0 | Done |

### 3.3 Compatibility

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| NFR-C1 | macOS 12+ (launchd) | P0 | Done |
| NFR-C2 | Linux with crontab | P0 | Done |
| NFR-C3 | Windows 10+ with Task Scheduler | P1 | Deferred to v0.2.0 |
| NFR-C4 | Node.js >= 18.0.0 | P0 | Done |
| NFR-C5 | Claude Code CLI in PATH | P0 | Done |

---

## 4. Dependencies

### 4.1 Production Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `croner` | ^8.1.2 | Cron expression parsing and validation |
| `cronstrue` | ^2.52.0 | Cron-to-human-readable conversion |
| `zod` | ^3.24.1 | Runtime schema validation for all data structures |

### 4.2 Removed Dependencies (vs original spec)

| Package | Reason for Removal |
|---------|--------------------|
| `execa` | Replaced by thin `child_process` wrapper (~50 lines); avoids ESM-only dep issues |
| `fs-extra` | Replaced by `fs/promises`; `mkdir({recursive: true})`, `readFile`, `writeFile` suffice |

### 4.3 Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.7.2 | Compiler |
| `vitest` | ^3.x | Test framework |
| `@types/node` | Latest | Node.js type definitions |

---

## 5. Data Model

### 5.1 Entity Relationship

```
SchedulesConfig (1) ──── has many ──── ScheduledTask (N)
                                            │
                                            │ executes as
                                            ▼
                                    ExecutionHistoryRecord (N)
```

### 5.2 File Layout

```
~/.claude/
├── schedules.json              # Global task definitions
├── execution-history.jsonl     # Append-only execution log
└── logs/
    ├── <task-id>.out.log       # stdout (macOS)
    ├── <task-id>.err.log       # stderr (macOS)
    ├── <task-id>.log           # combined (Linux)
    ├── <task-id>.status        # Execution result marker
    └── <task-id>.sh            # Generated wrapper script

<project>/.claude/
└── schedules.json              # Project-level task definitions

~/Library/LaunchAgents/         # macOS only
└── com.claude-scheduler.<id>.plist
```

---

## 6. Release Plan

### v0.1.0 (Current)
- Core scheduling (cron + natural language + one-time triggers)
- macOS (launchd) and Linux (crontab) scheduler integration
- Worktree isolation with `git add -u` and sensitive file detection
- Execution wrapper with timeout, flock concurrency guard, logging
- Configuration with trust boundary enforcement
- Execution history (append-only JSONL)
- 7 slash commands + 1 NL skill
- 258 tests across 15 test files

### v0.2.0 (Next)
- Windows support (schtasks)
- Session resume (`/schedule-resume`, session ID capture)
- Security hardening: adversarial prompt detection, audit logging
- Plugin lifecycle: upgrade migration, `/schedule-cleanup`

### v0.3.0 (Future)
- Task templates (pre-built common workflows)
- Webhook notifications on task completion/failure
- Dashboard view of all scheduled tasks and their status
- Task chaining (run task B after task A succeeds)

---

## 7. Appendix

### 7.1 Cron Expression Quick Reference

```
* * * * *
| | | | |
| | | | +-- Day of week (0-6, Sun=0)
| | | +---- Month (1-12)
| | +------ Day of month (1-31)
| +-------- Hour (0-23)
+---------- Minute (0-59)
```

### 7.2 Natural Language Patterns Supported

| Input | Cron | Notes |
|-------|------|-------|
| "every minute" | `* * * * *` | |
| "every 15 minutes" | `*/15 * * * *` | |
| "hourly" | `0 * * * *` | Preset |
| "daily" | `0 9 * * *` | Preset (9am) |
| "daily at 9am" | `0 9 * * *` | |
| "daily at 5pm" | `0 17 * * *` | |
| "every weekday at 9am" | `0 9 * * 1-5` | |
| "every Monday at 10am" | `0 10 * * 1` | |
| "weekly" | `0 9 * * 1` | Preset (Monday 9am) |
| "monthly" | `0 9 1 * *` | Preset (1st at 9am) |

### 7.3 Architectural Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Module system | ESM | Node 18+ stable, `"type": "module"` |
| D2 | Process execution | `child_process` builtins | Drop execa; thin wrapper over `execFile`/`spawn` |
| D3 | Filesystem | `fs/promises` | Drop fs-extra; native APIs suffice |
| D4 | Windows | Defer to v0.2.0 | Underspecified; stub with `PlatformNotSupportedError` |
| D5 | Session resume | Defer to v0.2.0 | Unverified assumption about `claude -p` session output |
| D6 | One-time tasks | `type: "once"` trigger | Discriminated union with `timestamp` field |
| D7 | Version | Start at v0.1.0 | Nothing existed prior |
| D8 | Error handling | Plain Error + Zod | No custom error hierarchy |
| D9 | Config merge | Global wins on ID collision | Project configs add-only |
| D10 | Security | Built-in per phase | Not a separate hardening phase |
| D11 | Concurrency | `flock` in wrapper script | Prevents parallel execution |
| D12 | Testability | Dependency injection for exec | Tests inject mock exec |
| D13 | Working directory | Resolve to absolute at creation | Store absolute path |
| D14 | Git staging | `git add -u` (not `-A`) | Avoids staging secrets |
| D15 | Timeout | Wrapper script with kill | Background + timeout + SIGTERM/SIGKILL |
| D16 | PATH | Capture at registration | Embed in every plist/crontab entry |
| D17 | Command field | Natural-language prompt only | Slash commands not supported in scheduled execution |

### 7.4 Glossary

| Term | Definition |
|------|------------|
| **Task** | A scheduled unit of work with trigger, execution config, and metadata |
| **Trigger** | When a task should fire -- `cron` (recurring) or `once` (one-time) |
| **Execution** | What happens when a task fires (prompt, working directory, permissions) |
| **Worktree** | An isolated git working directory on a separate branch |
| **Wrapper script** | Generated bash script that handles PATH, timeout, flock, logging, and Claude invocation |
| **skipPermissions** | Flag that enables fully autonomous Claude execution (`--dangerously-skip-permissions`) |
| **CalendarInterval** | launchd's cron equivalent; specifies Minute/Hour/Day/Month/Weekday in a plist dict |
| **Marker comment** | Comment block `# claude-scheduler:<id>:begin/end` used to identify crontab entries |
| **flock** | POSIX file locking used as a concurrency guard (one execution per task at a time) |
