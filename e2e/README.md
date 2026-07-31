# Scheduler E2E (agentry)

End-to-end tests that drive the scheduler's slash commands through a **real Claude
agent** using [agentry](https://github.com/dortort/agentry), then assert on the
agent's reply. These replace the old Vitest-subprocess suite.

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

`agentry.config.ts` runs in `live` mode (real agent, small cost per scenario). No
cassettes are recorded or committed.

## How it works

- `commands.agentry.ts` — the scenarios (`test`/`test.describe` from `agentry`).
- `fixtures.ts` — seeds a scenario's sandbox with sample scheduler data.
- `helpers.ts` — `SCHEDULER_ROOT` (the `--plugin-dir` target), shared run options,
  and tolerant text assertions over the agent's reply.

Each scenario gets a fresh sandbox as its working directory; `agent.run(cmd, …)`
spawns `claude --plugin-dir <repo-root> -p <cmd>` so the scheduler plugin is loaded.

## Caveat: global state

The scheduler reads **global** state from `~/.claude/` and `~/Library/LaunchAgents/`
in addition to the project directory. agentry's sandbox isolates only the working
directory, so:

- Empty-state scenarios assume the machine has **no** pre-existing scheduled tasks.
- Commands that read only global state (e.g. execution logs/history) do not see the
  per-scenario sandbox fixtures.

Making these fully deterministic would require isolating `$HOME` for the agent run
(a possible follow-up in agentry, guarding against breaking the CLI's own auth).
