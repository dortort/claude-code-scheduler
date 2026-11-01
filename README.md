# dortort Claude plugins

The `dortort` marketplace for Claude Code plugins, mods, and agent skills.

## Install

```bash
claude plugin marketplace add dortort/claude-plugins
claude plugin install scheduler@dortort
claude plugin install dortort@dortort
# Choose ONE Artifact Callbacks variant; do not enable both in the same session.
claude plugin install artifact-callbacks@dortort
# Or use the research-preview channel alternative:
claude plugin install artifact-callbacks-channel@dortort
```

Install any of them:

| Plugin | Purpose | Source | Commands |
| --- | --- | --- | --- |
| `scheduler` | Recurring and one-time AI tasks with native OS schedulers | [`@dortort/scheduler`](https://www.npmjs.com/package/@dortort/scheduler) | `/scheduler:add`, `/scheduler:list`, and more |
| `dortort` | NotebookLM, Terraform, YouTube, and image generation skills | [`dortort/skills`](https://github.com/dortort/skills) | `/dortort:<skill-name>` |
| `artifact-callbacks` | Clicks on HTML pages Claude writes become follow-up prompts in the running session (loopback only) | [`plugins/artifact-callbacks`](plugins/artifact-callbacks) | `/callbacks` |
| `artifact-callbacks-channel` | The same, as a research-preview channel: clicks arrive as `<channel>` messages through the same listener | [`plugins/artifact-callbacks-channel`](plugins/artifact-callbacks-channel) | Tools `callbacks_done`, `callbacks_reply`, `callbacks_pause` and more |

The scheduler requires Node.js >= 18, the Claude Code CLI, and macOS or Linux.
See its [documentation](plugins/scheduler/README.md) for commands and configuration.
Artifact Callbacks is a mod that needs Node.js >= 22.18, which runs its TypeScript
listener directly (no build step, no Python). Use Claude Code **2.1.287+ in the
terminal**, or **2.1.286+ in Desktop's Code tab**; see its
[documentation](plugins/artifact-callbacks/README.md). Its channel build (an MCP server on the
same Node, loaded with `claude --dangerously-load-development-channels
plugin:artifact-callbacks-channel@dortort`) is a research-preview alternative for sessions
where mods don't load, or when clicks should reach Claude mid-turn; see
[Mod or channel build?](plugins/artifact-callbacks/README.md#mod-or-channel-build) and its
[documentation](plugins/artifact-callbacks-channel/README.md).
Skills remain in their own repository so they can also be copied or used with other
tools that support their format and dependencies.

## Repository layout

```text
.claude-plugin/marketplace.json   Marketplace catalog
plugins/
  scheduler/                    @dortort/scheduler source and plugin manifest
  artifact-callbacks/           Artifact Callbacks mod, TypeScript on Node >= 22.18
    hooks/                      hooks module (register.tsx, lib/*.ts, *.test.ts suites)
    sidecar/                    loopback listener (listener.ts, lib.ts) and browser client.js
    skills/                     interactive-artifacts authoring skill
    test/                       node:test suites (*.spec.ts) and docs checks
  artifact-callbacks-channel/   channel build: stdio MCP server (server/), synced copy of the listener (sidecar/)
```

Claude-specific plugins and mods live under `plugins/`. The marketplace installs
the scheduler's published npm package, which includes compiled JavaScript, rather
than its unbuilt source directory. Its npm name remains `@dortort/scheduler`.
The skills entry references the independently maintained `dortort/skills` repository
directly. The callback variants ship their TypeScript sources as they are (Node >=
22.18 runs them without a build step). Their entries use released Git subdirectories,
pinned by release tag and full commit SHA.

The three plugins maintained here install exact published releases: the scheduler pins
an npm version, and both callback variants pin a tag and commit. Merging development
changes does not advance those pins. A release is made available to marketplace users
by merging a separate catalog promotion PR; see [Releasing plugins](RELEASING.md).

## Development

```bash
cd plugins/scheduler
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

From the repository root, validate the release pins and marketplace, then load the built scheduler:

```bash
node scripts/marketplace.mjs check
node --test scripts/marketplace.test.mjs
claude plugin validate .
claude plugin validate plugins/scheduler
claude --plugin-dir ./plugins/scheduler
```

For Artifact Callbacks, see its [development notes](plugins/artifact-callbacks/README.md#development):

```bash
cd plugins/artifact-callbacks
npm ci
npm run typecheck
npm test
npm run validate
npm run test:hooks
```

The channel build has its own [development notes](plugins/artifact-callbacks-channel/README.md#develop)
(`npm ci`, `npm run typecheck`, `npm test`, `npm run validate` in `plugins/artifact-callbacks-channel`).

CI and npm publishing for the scheduler run from `plugins/scheduler`. See the scheduler's
[release instructions](plugins/scheduler/README.md#releasing) before publishing.

## Existing checkouts

This repository was previously `dortort/claude-code-scheduler`. Update your remote:

```bash
git remote set-url origin https://github.com/dortort/claude-plugins.git
```

Source, tests, and scheduler documentation now live under `plugins/scheduler`.
Update local `--plugin-dir` paths to that directory and build there before use.

## License

[MIT](LICENSE)

## Releases

See the [release process](RELEASING.md) for independent plugin versions, tags, and release notes.
