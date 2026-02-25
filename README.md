# claude-code-scheduler

A Claude Code plugin for scheduling recurring and one-time AI-assisted tasks using native OS schedulers (launchd on macOS, crontab on Linux).

## Features

- **Natural language scheduling** — "every weekday at 9am", "daily at 5pm", "every Monday at 10am"
- **Cron expressions** — standard 5-field cron syntax with full validation
- **One-time tasks** — schedule a task to run once at a specific time
- **Worktree isolation** — run tasks in isolated git worktrees to avoid interfering with your working copy
- **Execution history** — JSONL-based history with filtering by status, task, and project
- **Log management** — stdout/stderr capture with rotation and cleanup
- **Security built-in** — env blocklist, sensitive file detection, shell escaping, trust boundary enforcement

## Requirements

- Node.js >= 18
- Claude Code CLI (`claude`)
- macOS (launchd) or Linux (crontab)

## Installation

Install as a Claude Code plugin:

```bash
claude plugin install claude-code-scheduler
```

Or for local development:

```bash
claude --plugin-dir /path/to/claude-code-scheduler
```

## Commands

| Command | Description |
|---------|-------------|
| `/schedule-add` | Add a new scheduled task (NL or cron) |
| `/schedule-list` | List all configured tasks with status |
| `/schedule-remove` | Remove a task by ID or name |
| `/schedule-status` | Health check for the scheduling system |
| `/schedule-run` | Manually trigger a task |
| `/schedule-logs` | View stdout/stderr logs for a task |
| `/schedule-history` | View execution history with filters |

## Skill

Say "schedule a daily code review at 9am" and the plugin will guide you through setup using the `/schedule-add` command.

## Architecture

```
src/
  types.ts              Zod schemas, task factory, validation
  config.ts             Config load/save/merge with trust boundaries
  index.ts              Public API re-exports
  cron/
    parser.ts           Cron validation, NL-to-cron, next runs
    humanizer.ts        Cron-to-human-readable, date/duration formatting
  logs/
    index.ts            Log dir management, rotation, cleanup
  history/
    index.ts            JSONL execution history, querying, cleanup
  vcs/
    index.ts            Git worktree lifecycle, sensitive file detection
  templates/
    wrapper.ts          Bash wrapper script generation (direct + worktree)
  schedulers/
    base.ts             Shared scheduler utilities
    darwin.ts           macOS launchd plist generation
    linux.ts            Linux crontab management with markers
    index.ts            Platform detection factory
  utils/
    shell.ts            Shell escaping, input sanitization
    exec.ts             Thin child_process wrapper with DI
```

## Configuration

Tasks are stored in JSON config files:

- **Global**: `~/.claude/schedules.json` — your personal tasks
- **Project**: `<project>/.claude/schedules.json` — shared team tasks

Global config takes precedence on ID collision. Project configs cannot set `skipPermissions`.

## Development

```bash
npm install
npm test          # 258 tests
npm run build     # TypeScript compilation
npm run typecheck # Type checking only
```

## License

MIT
