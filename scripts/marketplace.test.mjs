import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkCatalog, pinRelease } from './marketplace.mjs';

const original = JSON.parse(readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'));
const sha = 'a'.repeat(40);
const pinned = ['scheduler', 'artifact-callbacks', 'artifact-callbacks-channel']
  .reduce((catalog, name) => pinRelease(catalog, name, { version: '1.2.3', sha }), original);

test('accepts release pins without tying them to the moving source versions', () => {
  checkCatalog(pinned);
});

test('rejects a moving npm version, branch, relative source, and missing commit', () => {
  for (const mutate of [
    catalog => { catalog.plugins.find(p => p.name === 'scheduler').source.version = 'latest'; },
    catalog => { catalog.plugins.find(p => p.name === 'artifact-callbacks').source.ref = 'main'; },
    catalog => { catalog.plugins.find(p => p.name === 'artifact-callbacks').source = './plugins/artifact-callbacks'; },
    catalog => { delete catalog.plugins.find(p => p.name === 'artifact-callbacks').source.sha; },
    catalog => { catalog.plugins.find(p => p.name === 'artifact-callbacks').source.path = 'plugins/artifact-callbacks-channel'; },
  ]) {
    const candidate = structuredClone(pinned);
    mutate(candidate);
    assert.throws(() => checkCatalog(candidate));
  }
});

test('promotion changes only the selected plugin and preserves the external skills source', () => {
  const promoted = pinRelease(pinned, 'artifact-callbacks', { version: '1.2.4', sha: 'b'.repeat(40) });
  checkCatalog(promoted);
  for (const entry of pinned.plugins) {
    if (entry.name !== 'artifact-callbacks') {
      assert.deepEqual(promoted.plugins.find(p => p.name === entry.name), entry);
    }
  }
  assert.equal(pinned.plugins.find(p => p.name === 'artifact-callbacks').version, '1.2.3');
});

test('rejects unsupported plugins and non-exact versions', () => {
  assert.throws(() => pinRelease(pinned, 'dortort', { version: '1.0.0', sha }));
  assert.throws(() => pinRelease(pinned, 'scheduler', { version: '^1.2.3', sha }));
});
