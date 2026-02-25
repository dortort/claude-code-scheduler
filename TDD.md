# Technical Design Document: Claude Code Scheduler

**Version:** 0.1.0
**Status:** Implemented
**Last Updated:** 2026-02-25

---

## 1. System Architecture

### 1.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Claude Code Plugin Interface                  │
│                                                                  │
│  .claude-plugin/plugin.json    commands/*.md    skills/SKILL.md  │
│  (plugin registration)        (7 slash commands) (NL trigger)    │
├──────────────────────────────────────────────────────────────────┤
│                        TypeScript Library                        │
│                                                                  │
│  ┌────────────┐  ┌────────────────┐  ┌─────────────────────┐   │
│  │  types.ts   │  │   config.ts    │  │   cron/parser.ts    │   │
│  │ Zod schemas │  │ load/save/merge│  │ validate, NL parse  │   │
│  │ createTask  │  │ trust boundary │  │ croner + cronstrue  │   │
│  └────────────┘  └────────────────┘  └─────────────────────┘   │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────────────────────┐    │
│  │ templates/        │  │ schedulers/                       │    │
│  │ wrapper.ts        │  │ base.ts (shared utilities)        │    │
│  │ generateDirect()  │  │ darwin.ts (plist, CalendarInterval)│    │
│  │ generateWorktree()│  │ linux.ts (crontab, markers)       │    │
│  └──────────────────┘  │ index.ts (factory, detection)     │    │
│                         └──────────────────────────────────┘    │
│                                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌──────────┐  │
│  │ logs/    │  │ history/     │  │ vcs/      │  │ utils/   │  │
│  │ read     │  │ JSONL append │  │ worktree  │  │ shell.ts │  │
│  │ append   │  │ query/filter │  │ commit    │  │ exec.ts  │  │
│  │ rotate   │  │ cleanup      │  │ push      │  │          │  │
│  └──────────┘  └──────────────┘  └───────────┘  └──────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    OS Native Schedulers                           │
│                                                                  │
│  macOS: ~/Library/LaunchAgents/com.claude-scheduler.<id>.plist   │
│  Linux: crontab entries with # claude-scheduler:<id>:begin/end   │
│  Windows: PlatformNotSupportedError (deferred to v0.2.0)        │
│                                                                  │
│                         triggers                                 │
│                           │                                      │
│                           ▼                                      │
│              /bin/bash ~/.claude/logs/<id>.sh                    │
│              (generated wrapper script with flock, timeout, etc.) │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 Module Dependency Graph

```
index.ts (public API re-exports)
  ├── types.ts (Zod schemas, factory functions, BLOCKED_ENV_VARS)
  ├── config.ts (load/save/merge, trust boundary enforcement)
  │     └── types.ts
  ├── cron/parser.ts (croner validation, NL-to-cron, presets)
  ├── cron/humanizer.ts (cronstrue wrapper, date/duration formatting)
  ├── templates/wrapper.ts (bash script generators)
  │     └── utils/shell.ts
  ├── schedulers/index.ts (platform detection, factory)
  ├── schedulers/base.ts (shared utilities)
  ├── schedulers/darwin.ts (plist generation, cronToCalendarInterval)
  ├── schedulers/linux.ts (crontab line generation, markers)
  ├── logs/index.ts (read/append/rotate/cleanup)
  ├── history/index.ts (JSONL record/query/cleanup)
  ├── vcs/index.ts (git worktree, commit, push, sensitive file detection)
  │     └── utils/exec.ts
  └── utils/shell.ts (shellEscape, sanitizeForComment, validation patterns)
      utils/exec.ts (thin child_process wrapper, ExecError)
```

### 1.3 External Dependencies

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| `croner` | ^8.1.2 | Cron expression parsing and validation | MIT |
| `cronstrue` | ^2.52.0 | Cron-to-human-readable conversion | MIT |
| `zod` | ^3.24.1 | Runtime schema validation for all data structures | MIT |

**Removed from original spec:**
- `execa` -- replaced by `src/utils/exec.ts`, a thin wrapper (~50 lines) over `child_process.execFile`/`spawn`
- `fs-extra` -- replaced by native `fs/promises` (`mkdir({recursive: true})`, `readFile`, `writeFile`)

**Dev dependencies:** `typescript ^5.7.2`, `vitest ^3.x`, `@types/node`

---

## 2. Data Structures

### 2.1 Core Types (Zod Schemas)

All types are defined in `src/types.ts` with Zod schemas for runtime validation.

#### ScheduledTask

```typescript
{
  id: string;                    // regex: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
  name: string;                  // min 1 char
  description?: string;
  enabled: boolean;              // default true
  trigger:
    | { type: "cron"; expression: string; timezone?: string }
    | { type: "once"; timestamp: string; timezone?: string };
  execution: {
    command: string;             // Natural-language prompt (NOT slash commands)
    workingDirectory: string;    // Must be absolute path
    timeout: number;             // Seconds, default 300
    env?: Record<string, string>;// Validated against BLOCKED_ENV_VARS
    skipPermissions: boolean;    // Default false, stripped from project configs
    worktree?: {
      enabled: boolean;
      branchPrefix: string;      // Default "claude-task/"
      remoteName: string;        // Default "origin"
    };
  };
  tags: string[];                // Default []
  createdAt: string;             // ISO-8601
  updatedAt: string;             // ISO-8601
}
```

**Trigger type:** Discriminated union via `z.discriminatedUnion('type', [...])`.

**Env blocklist:** `BLOCKED_ENV_VARS = ['PATH', 'HOME', 'USER', 'SHELL', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH']`

#### ExecutionHistoryRecord

```typescript
{
  taskId: string;
  taskName: string;              // Denormalized for efficient querying
  project: string;               // Working directory
  startedAt: string;             // ISO-8601
  finishedAt?: string;           // ISO-8601
  durationMs?: number;
  status: string;                // "success" | "failure" | "timeout" | "skipped"
  exitCode?: number;
  trigger: string;               // "scheduled" | "manual"
  error?: string;
  // v0.2.0 placeholders (optional, accepted but not populated):
  sessionId?: string;
  sessionExpiry?: string;
  executedCommand?: string;
}
```

### 2.2 Configuration Files

#### schedules.json

```typescript
{
  version: 1;                    // Schema version
  tasks: ScheduledTask[];
}
```

**Merge behavior:** `loadMergedConfig(projectPath, globalPath)` loads both, global wins on ID collision, `skipPermissions` stripped from project tasks.

#### execution-history.jsonl

One JSON object per line, append-only. Corrupted lines are silently skipped during reads.

---

## 3. Component Design

### 3.1 Shell Utilities (`utils/shell.ts`)

#### shellEscape(str)

The primary injection defense. Wraps strings in single quotes, which prevents all shell expansion.

```
Algorithm:
  1. Replace every ' with '\'' (end quote, escaped literal quote, start quote)
  2. Wrap result in single quotes

Examples:
  "foo"            -> "'foo'"
  "it's"           -> "'it'\''s'"
  "$HOME"          -> "'$HOME'" (no expansion)
  "; rm -rf /"     -> "'; rm -rf /'"
```

#### Other utilities

- `sanitizeForComment(str)` -- strips `$\`#\\|&<>`, replaces newlines
- `isSafeIdentifier(str)` -- validates `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`
- `GIT_REF_PATTERN`, `GIT_REMOTE_PATTERN`, `SAFE_PATH_PATTERN` -- validation regexes

### 3.2 Exec Utility (`utils/exec.ts`)

Thin wrapper over `child_process`:
- `exec(command, args, options?)` -- returns `Promise<ExecResult>` with stdout, stderr, exitCode
- Uses `execFile` for simple commands, `spawn` when stdin is needed
- Throws `ExecError` with exitCode, stdout, stderr on failure
- No shell interpretation (args passed directly to execFile)

### 3.3 Configuration Layer (`config.ts`)

| Function | Description |
|----------|-------------|
| `getGlobalSchedulesPath()` | Returns `~/.claude/schedules.json` |
| `getSessionIdPath(taskId)` | Returns session file path (validates ID first) |
| `loadConfig(path)` | Validates via Zod, returns empty config on any error |
| `saveConfig(path, config)` | Validates before writing |
| `loadMergedConfig(projectPath, globalPath?)` | Global wins on ID collision, strips skipPermissions |
| `addTask(config, task)` | Immutable; throws on duplicate ID |
| `updateTask(config, id, updates)` | Immutable; auto-updates `updatedAt` |
| `removeTask(config, id)` | Immutable; throws if not found |
| `findTask(config, idOrName)` | Searches by ID then case-insensitive name |

### 3.4 Cron Layer (`cron/`)

#### Parser (`parser.ts`)

| Function | Purpose |
|----------|---------|
| `validateCron(expr)` | Validates via `croner`, returns `{valid, error?, expression?}` |
| `getNextRuns(expr, count, tz?)` | Returns next N run `Date` objects |
| `naturalLanguageToCron(input)` | Regex cascade: presets -> "every N minutes" -> "daily at X" -> "every weekday at X" -> "every <day> at X" |
| `CRON_PRESETS` | Map: hourly, daily, weekly, monthly, weekdays |

#### Humanizer (`humanizer.ts`)

| Function | Purpose |
|----------|---------|
| `cronToHuman(expr)` | cronstrue wrapper with fallback |
| `formatDate(date)` | ISO string to readable format |
| `formatDuration(ms)` | Milliseconds to "1h 2m 3s" |
| `formatRelativeTime(date)` | "5 minutes ago" / "in 2 hours" |

### 3.5 Execution Wrapper Templates (`templates/wrapper.ts`)

Two generators that produce self-contained bash scripts:

#### `generateDirectWrapper(options: WrapperOptions)`

Non-worktree execution. Script includes:
1. `#!/bin/bash` + `set -euo pipefail`
2. `export PATH="<captured-user-path>"`
3. `mkdir -p <logsDir>`
4. `cd <workingDirectory>` (shell-escaped)
5. `flock -n` on `/tmp/claude-scheduler-<taskId>.lock`
6. `claude -p <escaped-command> [--dangerously-skip-permissions]` as background process
7. Timeout enforcement via polling loop + `kill -TERM` / `kill -KILL`
8. stdout/stderr redirection to `.out.log` / `.err.log`
9. Status marker file (success/failure/timeout)
10. `trap cleanup EXIT INT TERM`

#### `generateWorktreeWrapper(options: WorktreeWrapperOptions)`

Adds git worktree lifecycle around the direct wrapper:
1. All of the above, plus:
2. `git worktree add <path> -b <branchPrefix><shortId>-<timestamp>`
3. `cd <worktree>`
4. Claude execution in worktree
5. `git add -u` (tracked files only, NOT `-A`)
6. `git commit -m "Claude scheduled task: <name>"`
7. `git push -u <remote> <branch>`
8. `git worktree remove <path> --force`
9. Trap handler cleans up worktree on signal/error

### 3.6 Platform Schedulers (`schedulers/`)

#### Base (`base.ts`)

Shared utilities (not an abstract class):
- `getExecutionCommand(task)` -- returns wrapper script path
- `getCronExpression(task)` -- returns cron expression or undefined
- `SchedulerTask` interface

#### Darwin (`darwin.ts`)

- `getLaunchctlLabel(taskId)` -- `com.claude-scheduler.<taskId>`
- `getPlistPath(taskId)` -- `~/Library/LaunchAgents/<label>.plist`
- `cronToCalendarInterval(expr)` -- converts 5-field cron to CalendarInterval dicts
  - Simple fields -> single CalendarInterval entry
  - Multi-value (comma) -> multiple entries (cartesian product)
  - Step values with <=24 expansions -> expanded CalendarInterval entries
  - Step values with >24 expansions -> returns `null` (StartInterval fallback)
- `generatePlist(task)` -- full XML plist with:
  - Label, ProgramArguments (`/bin/bash`, script path)
  - StandardOutPath, StandardErrorPath
  - StartCalendarInterval or StartInterval
  - RunAtLoad for one-time tasks
  - XML escaping for all user values (`& < > " '`)

#### Linux (`linux.ts`)

- `generateCrontabLine(task)` -- produces a marker-wrapped block:
  ```
  # claude-scheduler:<id>:begin
  PATH=<userPath>
  [TZ=<timezone>] <cron> /bin/bash <wrapperScript>
  # claude-scheduler:<id>:end
  ```
- `parseCrontabMarkers(crontab)` -- extracts task IDs from existing crontab
- `buildCrontabContent(existing, task, removeId?)` -- idempotent add/replace/remove

#### Factory (`index.ts`)

- `getSchedulerForPlatform(platform)` -- returns `{platform: "darwin"|"linux"}`
- `PlatformNotSupportedError` for win32 and other platforms

### 3.7 Logging Layer (`logs/index.ts`)

| Function | Description |
|----------|-------------|
| `ensureLogsDir(dir)` | `mkdir({recursive: true})` |
| `getLogPaths(dir, taskId, platform)` | darwin: `.out.log`/`.err.log`; linux: `.log` |
| `readLog(path, lastLines?)` | Full file or last N lines |
| `appendLog(path, message)` | Timestamped `[ISO] message` entries |
| `rotateLog(path, maxBytes)` | Rename to `.1`, create fresh empty file |
| `cleanupOldLogs(dir, retentionDays)` | Delete `.log` and `.log.1` files older than cutoff |

### 3.8 History Layer (`history/index.ts`)

| Function | Description |
|----------|-------------|
| `recordExecution(path, record)` | Append JSON line |
| `getRecentExecutions(path, options?)` | Filter by taskId/taskName/project/status, sort newest first, limit |
| `cleanup(path, maxRecords)` | Parse all, sort by startedAt, keep newest N, rewrite |

Corrupted lines are silently skipped in all read operations.

### 3.9 VCS Layer (`vcs/index.ts`)

| Function | Description |
|----------|-------------|
| `isGitRepo(dirPath, exec?)` | `git rev-parse --is-inside-work-tree` |
| `createWorktree(options)` | `git worktree add <path> -b <branch>` |
| `commitAndPush(options)` | `git add -u` -> status -> commit -> push; returns result object (never throws) |
| `removeWorktree(path, exec?)` | `git worktree remove --force`; retries once after 500ms; never throws |
| `isSensitiveFile(filename)` | Checks against `SENSITIVE_FILE_PATTERNS` |
| `generateBranchName(prefix, taskId)` | `<prefix>task-<shortId>-<timestamp>` |

Dependency injection: all git functions accept optional `exec` parameter for testing.

---

## 4. Security Architecture

### 4.1 Threat Model

```
TRUSTED (user-controlled):
├── ~/.claude/schedules.json (global config)
├── ~/.claude/logs/* (logs and wrapper scripts)
└── User input via /scheduler:add

UNTRUSTED (repo-controlled):
├── <project>/.claude/schedules.json (project config)
├── Source files read during scheduled tasks
└── Git remote responses
```

### 4.2 Defense-in-Depth Layers (All Built into v0.1.0)

```
Layer 1: Zod Schema Validation
  - Task ID regex, env blocklist, type constraints
Layer 2: Input Sanitization
  - shellEscape (single-quote wrapping), xmlEscape, sanitizeForComment
Layer 3: Trust Boundary Enforcement
  - Global wins on ID collision
  - skipPermissions stripped from project configs
Layer 4: Safe Git Operations
  - git add -u (not -A), sensitive file pattern detection
Layer 5: Execution Isolation
  - flock concurrency guard, timeout with SIGTERM/SIGKILL
  - Worktree isolation for automated changes
Layer 6: Claude Code Permission System
  - --dangerously-skip-permissions is opt-in, global-only
```

### 4.3 Attack Surface Mitigations

| Attack | Status | Defense |
|--------|--------|---------|
| Shell injection | Mitigated | `shellEscape()` single-quote wrapping on all user values |
| XML injection | Mitigated | `xmlEscape()` in plist generation |
| Path traversal | Mitigated | Task ID regex `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` |
| Env var injection | Mitigated | Blocklist: PATH, HOME, LD_PRELOAD, etc. |
| Config privilege escalation | Mitigated | Project configs can't set skipPermissions |
| Secret exposure via git | Mitigated | `git add -u` + sensitive file patterns |
| Prompt injection | Unmitigated | Deferred to v0.2.0 (adversarial pattern detection) |

---

## 5. Test Strategy

### 5.1 Test Framework

- **Framework:** Vitest ^3.x
- **Config:** `vitest.config.ts` with `passWithNoTests: true`, `restoreMocks: true`
- **Pattern:** `src/__tests__/**/*.test.ts`
- **Run:** `npm test` (vitest run)

### 5.2 Test Coverage (v0.1.0 -- 258 tests across 15 files)

| Test File | Tests | Module |
|-----------|-------|--------|
| `utils/shell.test.ts` | 32 | Shell escaping, validation patterns |
| `utils/exec.test.ts` | 6 | Exec wrapper, ExecError |
| `types.test.ts` | 33 | Zod schemas, factory functions, security validations |
| `config.test.ts` | 33 | Load/save/merge, trust boundary, CRUD |
| `cron/parser.test.ts` | 27 | Cron validation, NL parsing, presets |
| `cron/humanizer.test.ts` | 14 | Human-readable, formatting utilities |
| `logs/index.test.ts` | 15 | Read, append, rotate, cleanup |
| `history/index.test.ts` | 14 | Record, query, filter, cleanup, corrupted lines |
| `vcs/index.test.ts` | 16 | Git operations with mock exec, sensitive files |
| `templates/wrapper.test.ts` | 23 | Direct + worktree wrapper generation |
| `schedulers/base.test.ts` | 4 | Shared utilities |
| `schedulers/darwin.test.ts` | 18 | Plist, CalendarInterval, StartInterval fallback |
| `schedulers/linux.test.ts` | 11 | Crontab line, markers, idempotent add/replace/remove |
| `schedulers/index.test.ts` | 5 | Factory, PlatformNotSupportedError |
| `integration/lifecycle.test.ts` | 7 | Full lifecycle, cross-module integration |

### 5.3 TDD Discipline

All production code was developed test-first (Red-Green-Refactor):

1. **RED:** Write failing tests for the next module
2. **GREEN:** Implement minimal code to pass all tests
3. **REFACTOR:** Clean up while keeping tests green
4. **VERIFY:** Full suite (`npm test`) + typecheck (`tsc --noEmit`) after each phase

### 5.4 Testing Patterns

- **Dependency injection:** VCS layer accepts `ExecFn` parameter; tests inject mock exec
- **Temp directories:** Config and history tests use `fs.mkdtemp` for isolated filesystem
- **Mock exec factory:** `mockExec(responses)` maps command patterns to stdout/stderr/error
- **Integration test:** Full lifecycle through the public API surface (`src/index.ts`)

---

## 6. Build and Deployment

### 6.1 Build Pipeline

```bash
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run (258 tests)
```

### 6.2 Package Distribution

```json
{
  "files": ["dist", ".claude-plugin", "commands", "skills"]
}
```

The package is distributed as a Claude Code plugin via npm. Users install it and `.claude-plugin/plugin.json` registers it with Claude Code.

### 6.3 Platform Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | >= 18.0.0 |
| TypeScript | ^5.7.2 |
| Claude Code CLI | Latest (must be in PATH) |
| OS | macOS 12+ (launchd), Linux (crontab) |

---

## 7. Future Work (v0.2.0+)

### Session Resume
- Capture session ID from `claude -p --output-format json`
- Store in execution history record
- New `/schedule-resume` command
- Session validity checking (72h TTL)

### Windows Support
- `schtasks` integration via PowerShell
- PowerShell escaping (`'` -> `''`)
- Task path: `\ClaudeScheduler\<id>`

### Security Hardening
- Adversarial prompt pattern detection
- Audit logging of executed commands
- Command allowlist mode (opt-in)

### Plugin Lifecycle
- `/schedule-cleanup` command for uninstall
- Upgrade migration for schema version changes
