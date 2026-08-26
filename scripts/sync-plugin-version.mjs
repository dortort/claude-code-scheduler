import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const manifestPath = join(root, '.claude-plugin', 'plugin.json');
const manifest = readFileSync(manifestPath, 'utf8');
const current = JSON.parse(manifest).version;
const check = process.argv.includes('--check');

if (current === pkgVersion) {
  process.exit(0);
}

if (check) {
  console.error(
    `.claude-plugin/plugin.json version "${current}" does not match package.json "${pkgVersion}". Run: npm run sync-version`,
  );
  process.exit(1);
}

writeFileSync(manifestPath, manifest.replace(/("version":\s*")[^"]*(")/, `$1${pkgVersion}$2`));
console.log(`Synced .claude-plugin/plugin.json to ${pkgVersion}`);
