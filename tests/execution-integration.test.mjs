import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createQuoteService, createExecutionEngine } from '@instinct/router-engine';
import { createRouterApi, createFileExecutionStore } from '@instinct/router-server';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { createExecutionController } from '@instinct/router-sdk';
import { BASE_V3 } from '@instinct/router-core';
import { fixture, input, pins, OWNER, TXHASH } from '../packages/engine/test/fixtures/base-execution.mjs';

// Public test-only identity. All chain responses and wallet submissions below
// are simulated; the only network surface is this test's ephemeral loopback API.
const account = privateKeyToAccount('0x' + '03'.repeat(32));
const sender = account.address.toLowerCase();
const app = { id: 'integration', publishableKey: 'integration_public_0123456789',
  serverKey: 'integration_server_0123456789', allowedOrigins: ['https://integration.example'], rateLimitPerMinute: 1000 };

test('actual SDK, API, durable store and recipe recover after restart and verify exact recipient credit without resending', async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'router-execution-integration-'));
  const f = fixture();
  f.mutate((rows, calls) => rows.map((row, i) => calls[i].method === 'eth_getTransactionReceipt' && row.result ?
    { ...row, result: { ...row.result, from: sender } } : row));
  const wire = (url, init) => {
    // Only translate the fixture's EOA code query, preserving all transaction,
    // pool, simulation, fee, canonical-header and receipt validation.
    const calls = JSON.parse(init.body).map(call => call.method === 'eth_getCode' && call.params[0] === sender ?
      { ...call, params: [OWNER, ...call.params.slice(1)] } : call);
    return f.wire(url, { ...init, body: JSON.stringify(calls) });
  };
  let api, store, client, sends = 0;
  const storageRows = new Map(), storage = { getItem: key => storageRows.get(key) ?? null, setItem: (key, value) => storageRows.set(key, value) };
  const wallet = { getAccount: async () => ({ chainId: BASE_V3.chainId, address: sender }),
    signMessage: message => account.signMessage({ message }),
    sendTransaction: async tx => { sends++; f.setTransaction(tx); return TXHASH; } };
  const close = async () => {
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); api = undefined; }
    if (store) { await store.close(); store = undefined; }
  };
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const start = async () => {
    store = await createFileExecutionStore({ directory: join(dir, 'journal') });
    const engine = createExecutionEngine({ fetch: wire, executionPins: pins, rpcEndpoints: { base: [BASE_V3.rpc] } });
    api = createRouterApi({ service: createQuoteService({ fetch: wire }), apps: [app], execution: { engine, store } });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    client = createRouterServerClient({ baseUrl: 'http://127.0.0.1:' + api.address().port, serverKey: app.serverKey });
    return createExecutionController({ client, wallet, storage });
  };
  let controller = await start();
  assert.equal((await client.getConfig()).execution.enabled, true);
  await controller.proveOwnership();
  const review = await controller.prepare({ ...input(), sender });
  assert.equal(review.status, 'READY');
  assert.equal(review.plan.actions[0].payload, undefined);
  const submitted = await controller.execute(review, async (record, action) => {
    assert.equal(record.reviewHash, review.reviewHash);
    assert.equal(action.payload.transaction.from, sender);
    assert.equal(action.payload.transaction.value, '0x2d79883d2000');
    return true;
  });
  assert.equal(submitted.status, 'SUBMITTED');
  assert.equal(sends, 1);
  await close(); controller = await start();
  await assert.rejects(controller.resume(), error => error.code === 'WALLET_SESSION_REQUIRED');
  await controller.proveOwnership();
  const complete = await controller.resume();
  assert.equal(complete.status, 'COMPLETE');
  assert.equal(complete.receipt.transactionHash, TXHASH);
  assert.equal(complete.receipt.destinationCredit.recipient, input().recipient);
  assert.equal(complete.receipt.destinationCredit.amountRaw, '100003');
  assert.ok(BigInt(complete.receipt.actualNativeFeeRaw) > 0n);
  assert.ok(complete.timeline.completedAtMs >= complete.timeline.submittedAtMs);
  assert.equal((await controller.resume()).revision, complete.revision);
  assert.equal(sends, 1, 'Recovery and repeat status checks must never send another transaction');
});
