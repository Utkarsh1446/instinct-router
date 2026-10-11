import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = new URL('../', import.meta.url).pathname;
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('packed modules work outside the workspace without aliases, credentials, or app checkout dependencies', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-consumer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifacts = join(dir, 'artifacts'); await mkdir(artifacts);
  const dependencies = {};
  for (const name of ['core', 'engine', 'server', 'sdk']) {
    const details = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], join(root, 'packages', name)))[0];
    for (const file of details.files) assert.doesNotMatch(file.path, /(?:^|\/)(?:\.dev|node_modules|test|tests)\/|provider-keys|burner|\.env/);
    dependencies['@instinct/router-' + name] = 'file:' + join(artifacts, details.filename);
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
  // Resolve the real archive dependency graph from the workspace installation's
  // npm cache. This test never contacts a registry or runs package scripts.
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
  const sample = `
    import assert from 'node:assert/strict';
    import { RouterRuntime, WalletExecutionCoordinator } from '@instinct/router-core';
    import { createQuoteService, createExecutionEngine } from '@instinct/router-engine';
    import { createRouterApi, createFileExecutionStore } from '@instinct/router-server';
    import { createRouterClient, createExecutionController, createEvmWallet } from '@instinct/router-sdk';
    import { createRouterServerClient } from '@instinct/router-sdk/server';
    assert.equal(typeof RouterRuntime, 'function'); assert.equal(typeof WalletExecutionCoordinator, 'function');
    const service = createQuoteService(); assert.equal(service.config().capabilities.walletExecution, false);
    assert.equal(createExecutionEngine().capabilities().walletExecution, false);
    assert.equal(typeof createExecutionController, 'function'); assert.equal(typeof createEvmWallet, 'function');
    const api = createRouterApi({service, apps:[{id:'consumer',publishableKey:'public_consumer_key',serverKey:'server_consumer_key',allowedOrigins:['https://app.example']}]});
    api.close();
    const client = createRouterClient({baseUrl:'https://router.example',publishableKey:'public_consumer_key'});
    assert.equal(typeof client.quote,'function'); assert.equal(typeof client.quoteStream,'function'); assert.equal(typeof client.inspectExecution,'function'); assert.equal(typeof createFileExecutionStore,'function');
    assert.equal(typeof createRouterServerClient({baseUrl:'https://router.example',serverKey:'server_consumer_key'}).getQuote,'function');
    console.log('Package import smoke passed.');
  `;
  assert.match(run(process.execPath, ['--input-type=module', '--eval', sample], dir), /smoke passed/);
  const compiler = process.env.ROUTER_TSC_PATH ?? join(root, '../Instinct/node_modules/typescript/lib/tsc.js');
  const nodeTypes = process.env.ROUTER_NODE_TYPES_PATH ?? join(root, '../Instinct/node_modules/@types');
  try { await access(compiler); await access(join(nodeTypes, 'node')); }
  catch { t.diagnostic('TypeScript consumer check omitted: set ROUTER_TSC_PATH and ROUTER_NODE_TYPES_PATH to existing tools.'); return; }
  await writeFile(join(dir, 'consumer.ts'), `
    import { RouterRuntime, type RouterRequest } from '@instinct/router-core';
    import { createQuoteService, createExecutionEngine } from '@instinct/router-engine';
    import { createRouterApi, createFileExecutionStore } from '@instinct/router-server';
    import { createRouterClient, type QuoteRequest } from '@instinct/router-sdk';
    import { createRouterServerClient } from '@instinct/router-sdk/server';
    const api = createRouterApi({service:createQuoteService(),apps:[{id:'consumer',publishableKey:'public_consumer_key',serverKey:'server_consumer_key',allowedOrigins:['https://app.example']}]});
    api.close(); const runtime: typeof RouterRuntime = RouterRuntime;
    const client = createRouterClient({baseUrl:'https://router.example',publishableKey:'public_consumer_key'});
    const serverClient = createRouterServerClient({baseUrl:'https://router.example',serverKey:'server_consumer_key'});
    async function quote(request: QuoteRequest) { const result = await client.quote(request); const raw: string | undefined = result.candidates[0]?.minimumOutputRaw; return {raw, quoteId:result.quoteId}; }
    async function progressive(request: QuoteRequest) {
      return client.quoteStream(request, { onCandidate(candidate, metadata) {
        const raw: string = candidate.minimumOutputRaw; const provisional: true = metadata.provisional;
        void raw; void provisional;
      } });
    }
    async function inspect(request: import('@instinct/router-sdk').InspectionRequest) {
      const result = await client.inspectExecution(request); const readOnly: true = result.readOnly; return readOnly;
    }
    const durable: Promise<import('@instinct/router-server').FileExecutionStore> = createFileExecutionStore({directory:'/unused-typecheck-only'});
    const execution = createExecutionEngine();
    async function executionContract(input: import('@instinct/router-sdk').ExecutionInput, walletToken: string) {
      const prepared = await client.prepareExecution(input, {walletToken});
      const state: string = prepared.execution.status;
      const receipt = prepared.execution.receipt;
      const native: string | undefined = receipt?.actualNativeFeeRaw;
      return {state, native};
    }
    void execution; void executionContract;
    void durable; void inspect; void runtime; void serverClient; void quote; void progressive; const coreShape: Partial<RouterRequest> = {amountRaw:'1'}; void coreShape;
  `);
  run(process.execPath, [compiler, '--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2023,DOM', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', '--typeRoots', nodeTypes, 'consumer.ts'], dir);
  t.diagnostic('Strict TypeScript consumer check passed; archive dependencies installed offline from the existing cache.');
});
