import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(extensionRoot, '..');
const runtimeRoot = path.join(extensionRoot, 'runtime');

export const RUNTIME_ASSETS = [
  'codex-router.ps1',
  'run-parallel-workers.ps1',
  'run-gemini-worker.ps1',
  'orchestration-common.ps1',
  'filesystem-policy.ps1',
  'bounded-process-runner.ps1',
  'dashboard-dependency-bootstrap.ps1',
  'toolchain.ps1',
  'router-plan.schema.json',
  'model-tiers.json',
  'gemini-dashboard/scripts/router-bootstrap.ps1',
];

export async function prepareRuntime() {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  for (const relativePath of RUNTIME_ASSETS) {
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(runtimeRoot, relativePath);
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error(`Runtime asset is not a file: ${relativePath}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await prepareRuntime();
}
