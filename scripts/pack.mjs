import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import './build.mjs';
const root = new URL('../', import.meta.url);
const destination = new URL('../artifacts/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['core', 'engine', 'server', 'sdk']) {
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destination.pathname],
    { cwd: new URL(`packages/${name}/`, root), stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`Packaging ${name} failed.`);
  console.log(result.stdout.toString().trim());
}
