import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'dortort/claude-plugins';
export const managedPlugins = ['scheduler', 'artifact-callbacks', 'artifact-callbacks-channel'];
const semver = /^\d+\.\d+\.\d+$/;
const commitSha = /^[a-f0-9]{40}$/;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(root, '.claude-plugin/marketplace.json');

export function checkCatalog(catalog) {
  for (const name of managedPlugins) {
    const entries = catalog.plugins.filter(entry => entry.name === name);
    assert.equal(entries.length, 1, `Expected one catalog entry for ${name}`);
    const { source, version } = entries[0];
    assert.equal(typeof version, 'string', `${name} needs an advertised release version`);
    assert.match(version, semver, `${name} needs an exact release version`);
    assert(source && typeof source === 'object', `${name} cannot install from the moving marketplace checkout`);
    if (name === 'scheduler') {
      assert.equal(source.source, 'npm');
      assert.equal(source.package, '@dortort/scheduler');
      assert.equal(source.version, version, 'Scheduler npm version must match its catalog version');
    } else {
      assert.equal(source.source, 'git-subdir');
      assert.equal(source.url, `https://github.com/${repository}.git`);
      assert.equal(source.path, `plugins/${name}`);
      assert.equal(source.ref, `${name}--v${version}`, `${name} must reference its release tag`);
      assert.equal(typeof source.sha, 'string', `${name} needs an immutable commit`);
      assert.match(source.sha, commitSha, `${name} needs a full commit SHA`);
    }
  }
}

function jsonCommand(command, args) {
  return JSON.parse(execFileSync(command, args, { encoding: 'utf8' }));
}

// Verify publication and read the plugin manifest from the release's actual commit.
export function publishedRelease(name, version) {
  assert(managedPlugins.includes(name), `Unsupported plugin: ${name}`);
  assert.match(version, semver, 'Expected an exact stable release version');
  const tag = `${name}--v${version}`;
  const release = jsonCommand('gh', ['release', 'view', tag, '--repo', repository,
    '--json', 'tagName,isDraft,isPrerelease']);
  assert.equal(release.tagName, tag);
  assert.equal(release.isDraft, false, 'Draft releases cannot be promoted');
  assert.equal(release.isPrerelease, false, 'Prereleases cannot be promoted to the stable catalog');
  const commit = jsonCommand('gh', ['api', `repos/${repository}/commits/${tag}`]);
  assert.match(commit.sha, commitSha);
  const file = jsonCommand('gh', ['api',
    `repos/${repository}/contents/plugins/${name}/.claude-plugin/plugin.json?ref=${commit.sha}`]);
  const manifest = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version, 'The released plugin manifest must match the release tag');
  if (name === 'scheduler') {
    const publishedVersion = jsonCommand('npm', ['view', `@dortort/scheduler@${version}`, 'version', '--json']);
    assert.equal(publishedVersion, version, 'Publish to npm before promoting the scheduler');
  }
  return { version, sha: commit.sha };
}

export function pinRelease(catalog, name, release) {
  assert(managedPlugins.includes(name), `Unsupported plugin: ${name}`);
  assert.match(release.version, semver);
  assert.match(release.sha, commitSha);
  const next = structuredClone(catalog);
  const entry = next.plugins.find(plugin => plugin.name === name);
  assert(entry, `Missing catalog entry: ${name}`);
  entry.version = release.version;
  entry.source = name === 'scheduler'
    ? { source: 'npm', package: '@dortort/scheduler', version: release.version }
    : { source: 'git-subdir', url: `https://github.com/${repository}.git`, path: `plugins/${name}`,
        ref: `${name}--v${release.version}`, sha: release.sha };
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, name, version, ...rest] = process.argv.slice(2);
  assert.equal(rest.length, 0, 'Unexpected arguments');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (command === 'check' && name === undefined) {
    checkCatalog(catalog);
    console.log('All three managed plugins are pinned to exact releases');
  } else if (command === 'promote' && name && version) {
    const next = pinRelease(catalog, name, publishedRelease(name, version));
    checkCatalog(next);
    writeFileSync(catalogPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Pinned ${name}@${version}. Review and commit the catalog change in a PR.`);
  } else {
    throw new Error('Usage: node scripts/marketplace.mjs check | promote <plugin> <version>');
  }
}
