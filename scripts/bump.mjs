#!/usr/bin/env node
/**
 * Release helper for dsh-plugin-closure-board.
 *
 * The version lives in two places - package.json (what DSH and npm read) and the
 * VERSION constant in lib/client.js (what the panel prints, because the plugin
 * list can show a stale manifest). They drifted once; this keeps them together.
 *
 *   node scripts/bump.mjs --check        verify they agree (exit 1 on drift)
 *   node scripts/bump.mjs 0.3.0          rewrite both, commit, tag
 *   node scripts/bump.mjs 0.3.0 --push   ...and push the branch and tag
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const clientPath = join(root, 'lib', 'client.js');

const readVersions = () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const client = readFileSync(clientPath, 'utf8');
  const match = client.match(/const VERSION = "([^"]+)";/);
  return { pkg: pkg.version, client: match ? match[1] : undefined };
};

const args = process.argv.slice(2);
const check = args.includes('--check');
const push = args.includes('--push');
const target = args.find((arg) => !arg.startsWith('-'));

if (check || !target) {
  const { pkg, client } = readVersions();
  const ok = pkg !== undefined && pkg === client;
  console.log('package.json  ' + (pkg ?? '(missing)'));
  console.log('client.js     ' + (client ?? '(missing)'));
  console.log(ok ? 'in sync' : 'DRIFT');
  process.exit(ok ? 0 : 1);
}

if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error('version must look like 0.2.16, got: ' + target);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = target;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const client = readFileSync(clientPath, 'utf8').replace(/const VERSION = "[^"]+";/, 'const VERSION = "' + target + '";');
writeFileSync(clientPath, client, 'utf8');

const run = (...argv) => execFileSync('git', argv, { cwd: root, stdio: 'inherit' });
run('add', '-A');
run('-c', 'user.name=' + (process.env.GIT_AUTHOR_NAME || 'RXHai'), '-c', 'user.email=' + (process.env.GIT_AUTHOR_EMAIL || '1683035688@qq.com'), 'commit', '-m', 'chore(release): ' + target);
run('tag', '-a', 'v' + target, '-m', 'v' + target);
if (push) {
  run('push');
  run('push', 'origin', 'v' + target);
}
console.log('');
console.log(target + ' committed and tagged' + (push ? ' and pushed' : '; run: git push && git push origin v' + target));
