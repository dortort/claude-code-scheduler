# Releasing plugins

Each plugin has an independent version and release tag. The marketplace distributes
Artifact Callbacks directly from this repository; neither variant is published to npm.

## Artifact Callbacks

For the plugin being changed:

1. Bump `version` in its `.claude-plugin/plugin.json`, `package.json`, and both
   version fields in `package-lock.json`. Claude uses the plugin manifest's version
   to detect updates; changes under an unchanged version may not reach existing users.
2. Add `plugins/<plugin>/releases/<version>.md` describing the shipped changes,
   requirements, and how to update. Keep the channel's research-preview restrictions
   explicit. The channel MCP server reads its version from the plugin manifest.
3. Open a PR and let Artifact Callbacks CI pass before merging.
4. After merging, wait for the **Artifact Callbacks** workflow on `main` to pass.
   If the current commit did not trigger it, run that workflow manually on `main` first.
   Run **Release Artifact Callbacks** in GitHub Actions and select the plugin, or use:

   ```bash
   gh workflow run artifact-release.yml --repo dortort/claude-plugins --ref main \
     -f plugin=artifact-callbacks
   gh workflow run artifact-release.yml --repo dortort/claude-plugins --ref main \
     -f plugin=artifact-callbacks-channel
   ```

Run only the command for each plugin whose version changed. The workflow refuses
non-`main` refs, checks the CI result and matching versions, and requires release
notes. It creates `<plugin>--v<version>` at the checked commit, for example
`artifact-callbacks--v0.1.1` and `artifact-callbacks-channel--v0.1.1`, with separate
GitHub release notes. Existing releases are not overwritten. These releases do not
replace the repository's latest scheduler release.

The marketplace tracks `main`, so merged changes are available before the release
notes are published. Users refresh and update with:

```bash
claude plugin marketplace update dortort
claude plugin update artifact-callbacks@dortort
# Or, for the channel alternative:
claude plugin update artifact-callbacks-channel@dortort
```

Reload plugins or restart Claude after updating. Enable only one variant per session.
Publishing a channel release does not add it to Anthropic's channel allowlist;
the documented development flag or an organization allowlist is still required.

## Scheduler

The scheduler is published to npm from `plugins/scheduler`. Its `scheduler--v<version>`
GitHub release triggers the npm workflow. Follow the
[scheduler release instructions](plugins/scheduler/README.md#releasing).
