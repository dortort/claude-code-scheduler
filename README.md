# dortort Claude plugins

The `dortort` marketplace for Claude Code plugins, mods, and agent skills.

## Install

```bash
claude plugin marketplace add dortort/claude-plugins
claude plugin install scheduler@dortort
claude plugin install dortort@dortort
claude plugin install artifact-callbacks@dortort
```

Install any of them:

| Plugin | Purpose | Source | Commands |
| --- | --- | --- | --- |
| `scheduler` | Recurring and one-time AI tasks with native OS schedulers | [`@dortort/scheduler`](https://www.npmjs.com/package/@dortort/scheduler) | `/scheduler:add`, `/scheduler:list`, and more |
| `dortort` | NotebookLM, Terraform, YouTube, and image generation skills | [`dortort/skills`](https://github.com/dortort/skills) | `/dortort:<skill-name>` |
| `artifact-callbacks` | Clicks on HTML pages Claude writes become follow-up prompts in the running session (loopback only) | [`plugins/artifact-callbacks`](plugins/artifact-callbacks) | `/callbacks` |

The scheduler requires Node.js >= 18, the Claude Code CLI, and macOS or Linux.
See its [documentation](plugins/scheduler/README.md) for commands and configuration.
Artifact Callbacks is a mod that needs Node.js >= 18 or Python >= 3.8; see its
[documentation](plugins/artifact-callbacks/README.md).
Skills remain in their own repository so they can also be copied or used with other
tools that support their format and dependencies.

## Repository layout

```text
.claude-plugin/marketplace.json   Marketplace catalog
plugins/
  scheduler/                    @dortort/scheduler source and plugin manifest
  artifact-callbacks/           Artifact Callbacks mod (hooks module, sidecar, skill)
```

Claude-specific plugins and mods live under `plugins/`. The marketplace installs
the scheduler's published npm package, which includes compiled JavaScript, rather
than its unbuilt source directory. Its npm name remains `@dortort/scheduler`.
The skills entry references `dortort/skills` directly. Artifact Callbacks ships no
build step, so its entry is a relative path to its folder.

## Development

```bash
cd plugins/scheduler
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

From the repository root, validate the marketplace and load the built scheduler:

```bash
claude plugin validate .
claude plugin validate plugins/scheduler
claude --plugin-dir ./plugins/scheduler
```

For Artifact Callbacks, see its [development notes](plugins/artifact-callbacks/README.md#development):

```bash
cd plugins/artifact-callbacks
npm test
npm run test:docs
claude plugin validate .
claude plugin test .
```

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
