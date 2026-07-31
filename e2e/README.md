# Scheduler E2E (agentry)

End-to-end tests that drive the scheduler's slash commands through a **real Claude
agent** using [agentry](https://github.com/dortort/agentry) ("Playwright for AI
Agents"), then assert on the agent's reply. These replace the old Vitest-subprocess
suite.

This is a **self-contained pnpm project**, deliberately isolated from the repo's
npm-managed root so `npm ci` in CI never has to resolve agentry's `workspace:*`
dependencies. It is **local-only** and never runs in CI.

## Prerequisites

- The `claude` CLI on your `PATH`, authenticated.
- `pnpm`.
- A sibling checkout of agentry at `../agentry`, built once:
  ```bash
  cd ../agentry && pnpm install && pnpm -r build
  ```
  agentry is linked via `file:` in `package.json`; the `pnpm.overrides` there
  rewrite its internal `workspace:*` deps to the sibling paths.

## Running

From the repo root:

```bash
npm run test:e2e          # installs e2e deps, then runs all scenarios (live)
```

Or from this directory:

```bash
pnpm install
pnpm test                                   # all scenarios
pnpm exec tsx node_modules/agentry/src/bin.ts test --mode dry          # $0 discovery check
pnpm exec tsx node_modules/agentry/src/bin.ts test --grep "not found"  # one scenario
```

`agentry.config.ts` runs in `live` mode (real agent, ~$0.04/scenario). No cassettes
are recorded or committed.

## How it works

- `commands.agentry.ts` — the scenarios (`test`/`test.describe` from `agentry`).
- `fixtures.ts` — seeds a scenario's isolated state dir with sample scheduler data.
- `helpers.ts` — `SCHEDULER_ROOT` (the `--plugin-dir` target), `runOpts()`, and
  tolerant text assertions over the agent's reply.

Each scenario gets a fresh sandbox as its working directory; `agent.run(cmd, opts)`
spawns `claude --plugin-dir <repo-root> -p <cmd>` so the scheduler plugin is loaded.

### State isolation (determinism)

The scheduler otherwise reads **global** state from `~/.claude` and
`~/Library/LaunchAgents`, which a cwd sandbox can't isolate. To make the scenarios
deterministic, each run sets **`CLAUDE_SCHEDULER_STATE_DIR`** (via agentry's per-run
`env`) to a `state/` subdir of the sandbox — the read commands (`status`, `list`,
`history`, `logs`) resolve their paths from it, and the fixtures seed into it. This
is auth-safe: it does **not** touch `$HOME`, so the `claude` CLI keeps its normal
credentials (unlike a `$HOME` remap, which drops OAuth auth).

Not isolated by the state dir: OS registration (`~/Library/LaunchAgents`, launchctl).
The read commands only consult those cosmetically, and the assertions don't depend on
them.

### Not covered: mutating commands

`/scheduler:add` (and the other mutating commands) are intentionally **not** exercised
here: they perform real OS registration (launchd/cron) and executor installation that
`CLAUDE_SCHEDULER_STATE_DIR` can't relocate, so running them would mutate the host.
They remain covered by the unit/integration suite (`npm test`).
