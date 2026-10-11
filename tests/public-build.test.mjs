import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPublic, browserAssets, sdkAssets } from '../scripts/build-public.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'router-public-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('public build exposes only allowlisted browser assets and one publishable value', async t => {
  const outputDirectory = await fixture(t);
  await writeFile(join(outputDirectory, 'old-private-journal.json'), 'stale-secret');
  const secret = 'private_do_not_publish_7db86';
  const env = { ROUTER_PUBLIC_APP_KEY: 'public_build_fixture_key', ROUTER_APPS_JSON: secret, RELAY_API_KEY: secret, PRIVATE_KEY: secret };
  await buildPublic({env, outputDirectory});
  assert.deepEqual((await readdir(outputDirectory)).sort(), [...browserAssets, 'sdk', 'demo-config.json'].sort());
  assert.deepEqual((await readdir(join(outputDirectory, 'sdk'))).sort(), [...sdkAssets].sort());
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, 'demo-config.json'), 'utf8')), {baseUrl: '', publishableKey: env.ROUTER_PUBLIC_APP_KEY});
  const files = [...browserAssets, 'demo-config.json', ...sdkAssets.map(name => `sdk/${name}`)];
  const contents = new Map();
  for (const name of files) {
    const source = await readFile(join(outputDirectory, name), 'utf8'); contents.set(name, source);
    assert.ok(!source.includes(secret), `${name} contains private environment data`);
    assert.doesNotMatch(source, /router_test_public_instinct|http:\/\/127\.0\.0\.1:879[12]/);
    // Every static ES module dependency must exist in the published tree.
    for (const match of source.matchAll(/^(?:import|export)\s+[^\n]*?from\s*['"]([^'"]+)['"]/gm)) {
      const dependency = new URL(match[1], `https://router.example/${name}`).pathname.slice(1);
      assert.ok(files.includes(dependency), `${name} imports unpublished ${dependency}`);
    }
  }
  await buildPublic({env, outputDirectory});
  for (const [name, source] of contents) assert.equal(await readFile(join(outputDirectory, name), 'utf8'), source);
});

test('build rejects missing or malformed public credentials without exposing inputs', async t => {
  const outputDirectory = await fixture(t);
  for (const value of [undefined, '', 'short', 'sensitive+invalid-value']) {
    await assert.rejects(buildPublic({env: {ROUTER_PUBLIC_APP_KEY: value}, outputDirectory}), error => {
      assert.match(error.message, /Set ROUTER_PUBLIC_APP_KEY/);
      if (value) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

const appSource = (await readFile(new URL('../examples/browser/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
test('browser uses same-origin public config and preserves separate local API config', async () => {
  class Element extends EventTarget {
    children = []; dataset = {};
  }
  for (const [baseUrl, expected] of [['', 'https://router.example'], ['http://127.0.0.1:8791', 'http://127.0.0.1:8791']]) {
    const nodes = new Map(), requests = []; let options;
    const document = {getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }};
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('document', 'window', 'fetch', 'createRouterClient', 'initTokenSelection', 'selectedToken', 'initWalletUi', 'initAssetBalances', appSource)(
      document, {location: {origin: 'https://router.example'}}, async (...args) => { requests.push(args); return {ok: true, json: async () => ({baseUrl, publishableKey: 'public_fixture_key'})}; },
      value => { options = value; return {getConfig: async () => ({assets: []})}; }, () => {}, () => {}, () => ({}), () => {});
    assert.deepEqual(requests, [['/demo-config.json', {cache: 'no-store'}]]);
    assert.deepEqual(options, {baseUrl: expected, publishableKey: 'public_fixture_key'});
  }
});

test('local example retains legacy config endpoint and serves static config URL', async () => {
  const source = await readFile(new URL('../scripts/example-server.mjs', import.meta.url), 'utf8');
  assert.match(source, /req\.url === '\/demo-config' \|\| req\.url === '\/demo-config\.json'/);
});
