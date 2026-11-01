import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'scheduler-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

try {
  run(npm, ['pack', '--pack-destination', scratch], root);
  const archives = readdirSync(scratch).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'Expected one packed scheduler archive');
  run('tar', ['-xzf', join(scratch, archives[0]), '-C', scratch], root);

  const unpacked = join(scratch, 'package');
  const pkg = readJson(join(unpacked, 'package.json'));
  const manifest = readJson(join(unpacked, '.claude-plugin', 'plugin.json'));
  const lock = readJson(join(unpacked, 'npm-shrinkwrap.json'));
  assert.equal(manifest.version, pkg.version, 'Packed plugin version must match npm version');
  assert.equal(lock.version, pkg.version, 'Packed lockfile version must match npm version');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);

  // Install outside the checkout, with lifecycle scripts disabled as in Claude Code.
  run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], unpacked);
  run(process.execPath, [
    join(unpacked, 'dist', 'cli', 'index.js'),
    'validate-schedule', '--input', '0 9 * * 1-5',
  ], unpacked);
  run(process.execPath, ['--input-type=module', '-e', 'await import("./dist/index.js")'], unpacked);
  console.log(`Verified @dortort/scheduler@${pkg.version} from its packed archive`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
