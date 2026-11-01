import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCatalog, managedPlugins, publishedRelease } from './marketplace.mjs';

const catalog = JSON.parse(readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
checkCatalog(catalog);
const scratch = mkdtempSync(join(tmpdir(), 'marketplace-install-'));
const env = { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, 'config') };

try {
  // This checkout deliberately contains unreleased builds. Installs must use the
  // catalog's published sources, even when newer source is present beside it.
  const marketplace = join(scratch, 'marketplace');
  mkdirSync(join(marketplace, '.claude-plugin'), { recursive: true });
  writeFileSync(join(marketplace, '.claude-plugin/marketplace.json'), JSON.stringify(catalog));
  for (const name of managedPlugins) {
    const local = join(marketplace, 'plugins', name);
    mkdirSync(join(local, '.claude-plugin'), { recursive: true });
    writeFileSync(join(local, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '99.0.0' }));
    writeFileSync(join(local, 'unreleased-local-build'), 'Must not be installed');

    const entry = catalog.plugins.find(plugin => plugin.name === name);
    const released = publishedRelease(name, entry.version);
    if (entry.source.source === 'git-subdir') {
      assert.equal(entry.source.sha, released.sha, `${name} pin must match its published release tag`);
    }
  }
  execFileSync('claude', ['plugin', 'marketplace', 'add', marketplace], { env, stdio: 'inherit' });
  for (const name of managedPlugins) {
    execFileSync('claude', ['plugin', 'install', `${name}@${catalog.name}`], { env, stdio: 'inherit' });
  }
  const installed = JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { env, encoding: 'utf8' }));
  for (const name of managedPlugins) {
    const entry = catalog.plugins.find(plugin => plugin.name === name);
    const plugin = installed.find(plugin => plugin.id === `${name}@${catalog.name}`);
    assert(plugin, `${name} must be installed`);
    assert.equal(plugin.version, entry.version);
    assert.equal(plugin.enabled, true);
    assert(!plugin.errors?.length, JSON.stringify(plugin.errors));
    assert(!existsSync(join(plugin.installPath, 'unreleased-local-build')));
    const manifest = JSON.parse(readFileSync(join(plugin.installPath, '.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, entry.version);
    execFileSync('claude', ['plugin', 'validate', plugin.installPath], { env, stdio: 'pipe' });
    if (name === 'scheduler') {
      execFileSync(process.execPath, [join(plugin.installPath, 'dist/cli/index.js'),
        'validate-schedule', '--input', '0 9 * * 1-5'], { env, stdio: 'inherit' });
    } else {
      assert(existsSync(join(plugin.installPath, 'sidecar/listener.ts')));
    }
    console.log(`Verified published ${name}@${plugin.version}; local unreleased source was not installed`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
