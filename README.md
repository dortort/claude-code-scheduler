# @dortort/scheduler

[![CI](https://github.com/dortort/claude-code-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/dortort/claude-code-scheduler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)

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
claude plugin install @dortort/scheduler
```

Or for local development:

```bash
claude --plugin-dir /path/to/claude-code-scheduler
```

## Commands

| Command | Description |
|---------|-------------|
| `/scheduler:add` | Add a new scheduled task (NL or cron) |
| `/scheduler:list` | List all configured tasks with status |
| `/scheduler:remove` | Remove a task by ID or name |
| `/scheduler:status` | Health check for the scheduling system |
| `/scheduler:run` | Manually trigger a task |
| `/scheduler:logs` | View stdout/stderr logs for a task |
| `/scheduler:history` | View execution history with filters |

## Skill

Say "schedule a daily code review at 9am" and the plugin will guide you through setup using the `/scheduler:add` command.

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
npm test            # 258 unit/integration tests
npm run test:e2e    # 9 E2E tests via Claude CLI subprocess (~9 min)
npm run lint        # ESLint with typescript-eslint
npm run typecheck   # Type checking only
npm run build       # TypeScript compilation
npm run test:coverage  # Tests with coverage report
```

CI runs automatically on every push and PR to `main` (lint, typecheck, test on Node 18+22, build).

### Testing

The test suite has two tiers:

- **Unit/Integration** (`npm test`) — 258 fast tests covering library functions with no external dependencies.
- **E2E** (`npm run test:e2e`) — 9 subprocess tests that invoke each plugin command through `claude --plugin-dir`. Requires the `claude` CLI to be installed and takes ~9 minutes. Skipped automatically if the CLI is not available. E2E tests use temp directories with fixture data and assert on output patterns (not exact strings) to handle Claude's non-deterministic phrasing.

### Releasing

Publishing is automated via GitHub Actions when a [GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github) is created. The release workflow requires:

- An `npm` environment configured in the repository settings
- An `NPM_TOKEN` secret with publish access

### Branch Protection (Recommended)

Enable branch protection on `main` requiring these status checks to pass:
- Lint
- Typecheck
- Test (Node 18)
- Test (Node 22)
- Build

## License

MIT
