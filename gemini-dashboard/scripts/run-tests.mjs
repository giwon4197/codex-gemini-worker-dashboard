import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await discover(relative));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(relative);
  }
  return files;
}
const files = [...await discover('app'), ...await discover('lib'), ...await discover('../packages/orchestrator-core')].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
for (const file of files) console.log(file);
console.log(`Discovered test file count = ${files.length}`);
if (files.length < 15) {
  console.error('Expected at least the 15 baseline test files.');
  process.exit(1);
}
// Node itself expands test path globs, even with shell:false. Escape literal
// brackets so App Router dynamic segments are included on Windows as well.
const argumentsForFiles = files.map(file => file.replace(/[[\]]/g, char => `[${char}]`));
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...argumentsForFiles], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
if (result.error) console.error(result.error);
console.log(`Test runner exit code = ${result.status ?? 1}`);
process.exit(result.status ?? 1);
