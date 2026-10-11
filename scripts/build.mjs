import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const src = new URL('../packages/core/src/', import.meta.url);
const dist = new URL('../packages/core/dist/', import.meta.url);
await mkdir(dist, { recursive: true });
for (const file of await readdir(src)) {
 if (!file.endsWith('.ts')) continue;
 const content = stripTypeScriptTypes(await readFile(new URL(file, src), 'utf8'), { mode: 'strip', sourceUrl: file });
 await writeFile(new URL(file.replace(/\.ts$/, '.js'), dist), content);
}
console.log('Built portable router core JavaScript.');
