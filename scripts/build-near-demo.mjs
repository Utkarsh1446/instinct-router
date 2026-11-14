import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await import('./build.mjs');
const source = join(root, 'examples', 'near-intents');
const output = join(root, 'dist', 'near-intents');
const core = join(output, 'core');
await mkdir(core, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'units.js', 'presets.js', 'audit.js']) {
  await cp(join(source, file), join(output, file));
}
const data = join(source, 'data');
if ((await stat(data).catch(() => null))?.isDirectory()) await cp(data, join(output, 'data'), { recursive: true });
for (const file of await readdir(join(root, 'packages', 'core', 'dist'))) {
  if (file.endsWith('.js')) await cp(join(root, 'packages', 'core', 'dist', file), join(core, file));
}
console.log('Static NEAR Intents demo: dist/near-intents');
