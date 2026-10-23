import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
function check(file) {
  const checked = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status || 1);
}
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(file);
    else if (entry.name.endsWith('.mjs')) check(file);
  }
}
for (const name of ['index.mjs', 'server.mjs']) check(join(root, name));
for (const directory of ['bin', 'src', 'scripts', 'test', 'dev']) await checkDirectory(join(root, directory));
process.stdout.write('All MCP 2 JavaScript files parse successfully.\n');
