# Agent instructions

The `dortort` Claude Code marketplace: the catalog is `.claude-plugin/marketplace.json`,
and the plugins maintained here live under `plugins/`. Before changing a plugin, read
the development section of its README.

## Distribution

Users install the release pinned in `.claude-plugin/marketplace.json`. Merging source
changes and publishing a release both leave that pin where it is. A release reaches
users only through a separate promotion PR, prepared with
`node scripts/marketplace.mjs promote <plugin> <version>` and described in
[RELEASING.md](RELEASING.md). A release task ends with that promotion PR opened, or
reported to the user as the remaining step.

Move the `scheduler`, `artifact-callbacks` and `artifact-callbacks-channel` pins with
the promote command, which verifies the release before writing the entry. The
`dortort` entry belongs to the separately maintained `dortort/skills` repository and
keeps its own source.

## Working in the repository

- Each plugin is its own npm package with its own lockfile; run npm commands from that
  plugin's directory. The repository root has no `package.json`: the scripts in
  `scripts/` use only Node built-ins and run with plain `node`.
- Commit subjects use conventional commits, scoped to the plugin or area and lowercase
  after the colon: `fix(artifact-callbacks): …`, `ci(marketplace): …`,
  `docs(releases): …`.
