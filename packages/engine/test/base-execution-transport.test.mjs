import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_V3 } from '@instinct/router-core';
import { createBaseExecutionTransport } from '../src/base-execution-transport.mjs';
import { baseExecutionPrimitives as p, BaseReadinessError } from '../src/base-readiness.mjs';
import { createExecutionEngine } from '../src/execution-engine.mjs';
import { fixture, pins, input, BLOCKHASH, TXHASH } from './fixtures/base-execution.mjs';
import { relayPrepared, relayRequest } from './fixtures/relay-execution.mjs';
import { createRelayBaseSolExecution } from '../src/relay-base-sol-execution.mjs';
const endpoints = ['https://primary.example/', 'https://alternate.example/'];
const calls = [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['latest', false] }];
const reply = (init, fn = () => '0x2105') => new Response(JSON.stringify(JSON.parse(init.body).map(call => ({ jsonrpc: '2.0', id: call.id, result: fn(call) }))));
const read = (transport, batch = calls, signal) => transport.run(async (index, inner) =>
  (await p.rpc(transport.transports[index], batch, inner, 1)).map(p.result), signal);
test('reviewed endpoints are trusted-only HTTPS config and logical batches preserve every bound read with at most three calls', async () => {
  for (const bad of [[], ['http://example.com'], ['https://a.example/#secret'], ['https://u:p@a.example'], ['https://a.example', 'https://a.example']])
    assert.throws(() => createBaseExecutionTransport(async () => {}, bad), /INVALID_EXECUTION_CONFIG/);
  const seen = [], batch = Array.from({ length: 8 }, (_, i) => ({ method: 'eth_call', params: [{ to: input().sender, data: '0x' + i }, { blockHash: BLOCKHASH, requireCanonical: true }] }));
  const transport = createBaseExecutionTransport(async (url, init) => { seen.push({ url, rows: JSON.parse(init.body) }); return reply(init, call => call.params[0].data); }, endpoints);
  assert.deepEqual(await read(transport, batch), batch.map(call => call.params[0].data));
  assert.deepEqual(seen.map(entry => entry.rows.length), [3, 3, 2]);
  assert.deepEqual(seen.flatMap(entry => entry.rows.map(({ jsonrpc, id, ...call }) => call)), batch);
  assert.ok(seen.every(entry => entry.url === endpoints[0]));
});
test('transport failure retries the entire operation on alternate without carrying prior block or fee evidence', async () => {
  const f = fixture(), seen = []; let observing = false, primaryUnavailable = false;
  const engine = createExecutionEngine({ now: f.now, executionPins: pins,
    rpcEndpoints: { base: [BASE_V3.rpc, 'https://base.drpc.org'] }, fetch: async (url, init) => {
      const rows = JSON.parse(init.body); seen.push({ url, methods: rows.map(row => row.method), rows });
      if (observing && url.startsWith(BASE_V3.rpc) && (primaryUnavailable || rows.some(row => row.params[0]?.data === '0x960e3a23'))) {
        primaryUnavailable = true; return new Response('', { status: 403 });
      }
      const response = await f.wire(url, init), values = await response.json();
      if (observing && url.startsWith(BASE_V3.rpc)) for (const value of values) if (value.result?.hash === BLOCKHASH) value.result.hash = TXHASH;
      return new Response(JSON.stringify(values));
    } });
  const prepared = await engine.prepare(input()), plan = await engine.recipes[0].verify(prepared.request, prepared.candidate);
  observing = true; seen.length = 0;
  const result = await engine.verifier.preflight(plan, plan.actions[0]);
  assert.equal(result.blockHash, BLOCKHASH);
  const alternate = seen.filter(entry => entry.url.startsWith('https://base.drpc.org'));
  assert.ok(alternate[0].methods.includes('eth_chainId')); assert.ok(alternate[0].methods.includes('eth_getBlockByNumber'));
  assert.ok(alternate.some(entry => entry.rows.some(row => row.method === 'eth_getCode')));
  assert.ok(alternate.some(entry => entry.rows.some(row => row.method === 'eth_getBalance')));
  assert.ok(alternate.some(entry => entry.rows.some(row => row.params[0]?.data?.startsWith('0x275aedd2'))));
  assert.ok(alternate.flatMap(entry => entry.rows).filter(row => row.params[1]?.blockHash).every(row => row.params[1].blockHash === BLOCKHASH));
  assert.deepEqual(plan.minimumOutRaw, prepared.candidate.minimumOutputRaw);
});
test('all validated busy envelopes get at most one exact retry and then a whole-operation fallback', async () => {
  const seen = [];
  const transport = createBaseExecutionTransport(async (url, init) => {
    seen.push({ url, batch: JSON.parse(init.body) });
    return url === endpoints[0] ? new Response(JSON.stringify(JSON.parse(init.body).map(call => ({ jsonrpc: '2.0', id: call.id,
      error: { code: -32007, message: '[Exceeded request limit per second]' } })))) : reply(init);
  }, endpoints);
  assert.deepEqual(await read(transport), ['0x2105', '0x2105']);
  assert.deepEqual(seen.map(entry => entry.url), [endpoints[0], endpoints[0], endpoints[1]]);
  assert.deepEqual(seen[0].batch, seen[1].batch);
});
test('mixed busy/semantic replies, malformed IDs/UTF8 and revert errors never trigger an alternate', async () => {
  for (const fault of ['mixed', 'id', 'duplicate', 'revert', 'utf8', 'redirect']) {
    let fetches = 0;
    const transport = createBaseExecutionTransport(async (_url, init) => {
      fetches++; const batch = JSON.parse(init.body), rows = batch.map(call => ({ jsonrpc: '2.0', id: call.id, result: null }));
      if (fault === 'mixed') rows[1] = { jsonrpc: '2.0', id: batch[1].id, error: { code: -32007, message: 'Rate limit reached' } };
      if (fault === 'id') rows[0].id = 'other';
      if (fault === 'duplicate') rows[1].id = rows[0].id;
      if (fault === 'revert') rows[0] = { jsonrpc: '2.0', id: batch[0].id, error: { code: 3, message: 'execution reverted' } };
      if (fault === 'utf8') return new Response(new Uint8Array([0xc3, 0x28]));
      const response = new Response(JSON.stringify(rows));
      if (fault === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }, endpoints);
    const operation = transport.run(async (index, signal) => {
      const rows = (await p.rpc(transport.transports[index], calls, signal, 1)).map(p.result);
      if (rows.some(value => value !== '0x2105')) throw new BaseReadinessError('READINESS_CHAIN_MISMATCH');
      return rows;
    });
    await assert.rejects(operation); assert.equal(fetches, 1, fault);
  }
});
test('whole semantic chain/fund/pin failure does not hide behind an available alternate', async () => {
  for (const fault of ['chain', 'funds', 'implementation']) {
    const f = fixture(); let alternate = 0;
    const engine = createExecutionEngine({ now: f.now, executionPins: pins,
      rpcEndpoints: { base: [BASE_V3.rpc, 'https://base.drpc.org'] }, fetch: async (url, init) => {
        if (url.startsWith('https://base.drpc.org')) alternate++;
        const response = await f.wire(url, init), values = await response.json(), batch = JSON.parse(init.body);
        values.forEach((row, i) => {
          if (fault === 'chain' && batch[i].method === 'eth_chainId') row.result = '0x1';
          if (fault === 'funds' && batch[i].method === 'eth_getBalance') row.result = '0x1';
          if (fault === 'implementation' && batch[i].method === 'eth_getStorageAt') row.result = '0x' + '0'.repeat(63) + '1';
        }); return new Response(JSON.stringify(values));
      } });
    await assert.rejects(engine.prepare(input())); assert.equal(alternate, 0, fault);
  }
});
test('partial logical code results cannot be discarded when the next chunk transport fails', async () => {
  let callsMade = 0, alternate = 0;
  const transport = createBaseExecutionTransport(async (url, init) => {
    callsMade++; if (url === endpoints[1]) alternate++;
    return callsMade === 1 ? reply(init, () => '0x') : new Response('', { status: 403 });
  }, endpoints);
  const batch = Array.from({ length: 5 }, () => ({ method: 'eth_getCode', params: [input().destination.address, { blockHash: BLOCKHASH, requireCanonical: true }] }));
  await assert.rejects(read(transport, batch), error => error.code === 'READINESS_RPC_UNAVAILABLE');
  assert.equal(callsMade, 2); assert.equal(alternate, 0);
});
test('shared eight-second deadline never starts fallback after expiry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = createBaseExecutionTransport(async () => {}, endpoints); let invoked = 0;
  const pending = transport.run(async (_index, signal) => {
    invoked++; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new BaseReadinessError('READINESS_RPC_TRANSPORT_UNAVAILABLE');
  });
  t.mock.timers.tick(8000); await assert.rejects(pending, /EXECUTION_TIMEOUT/); assert.equal(invoked, 1);
});
test('absolute elapsed deadline rejects late ready/error and late alternate without waiting for timer dispatch', async () => {
  for (const fault of ['late-ready', 'late-error', 'late-alternate']) {
    let stamp = 100, invoked = 0;
    const transport = createBaseExecutionTransport(async () => {}, endpoints, { monotonic: () => stamp });
    const pending = transport.run(async index => {
      invoked++;
      if (fault === 'late-ready') { stamp += 8001; return 'ready'; }
      if (fault === 'late-error') { stamp += 8001; throw new BaseReadinessError('READINESS_RPC_TRANSPORT_UNAVAILABLE'); }
      stamp += index === 0 ? 7900 : 101;
      if (index === 0) throw new BaseReadinessError('READINESS_RPC_TRANSPORT_UNAVAILABLE');
      return 'ready';
    });
    await assert.rejects(pending, /EXECUTION_TIMEOUT/); assert.equal(invoked, fault === 'late-alternate' ? 2 : 1);
  }
});
test('aborting a read cannot release an ignored-transport lease and admit unbounded new work', async () => {
  const held = [], transport = createBaseExecutionTransport((_url, init) => new Promise(resolve => held.push(() => resolve(reply(init)))), endpoints);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const batch = JSON.stringify([{ jsonrpc: '2.0', id: 'r1', ...calls[0] }]);
  const pending = controllers.map(controller => transport.transports[0](BASE_V3.rpc, { method: 'POST', body: batch, signal: controller.signal }));
  controllers.forEach(controller => controller.abort());
  await assert.rejects(transport.transports[1](BASE_V3.rpc, { method: 'POST', body: batch, signal: new AbortController().signal }), /EXECUTION_BUSY/);
  held.forEach(resolve => resolve()); for (const request of pending) await assert.rejects(request, /configured Base|cancelled/i);
});
test('three independent chunks start before any chunk result is released', async () => {
  const held = []; let began;
  const barrier = new Promise(resolve => { began = resolve; });
  const transport = createBaseExecutionTransport((_url, init) => new Promise(resolve => {
    held.push(() => resolve(reply(init))); if (held.length === 3) began();
  }), endpoints);
  const batch = Array.from({ length: 9 }, () => calls[0]), pending = read(transport, batch);
  await barrier; assert.equal(held.length, 3);
  held.forEach(resolve => resolve()); assert.equal((await pending).length, 9);
});
test('global six-request leases remain held across abort-ignoring chunks and queued cancellations', async () => {
  const held = []; let began;
  const barrier = new Promise(resolve => { began = resolve; });
  const transport = createBaseExecutionTransport((_url, init) => new Promise(resolve => {
    held.push(() => resolve(reply(init))); if (held.length === 6) began();
  }), endpoints);
  const batch = JSON.stringify(Array.from({ length: 9 }, (_, id) => ({ jsonrpc: '2.0', id: `r${id}`, ...calls[0] })));
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const pending = controllers.map(controller => transport.transports[0](BASE_V3.rpc, { method: 'POST', body: batch, signal: controller.signal }));
  const rejected = pending.map(operation => assert.rejects(operation, /cancelled/i));
  await barrier; controllers.forEach(controller => controller.abort());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(held.length, 6);
  held.forEach(resolve => resolve()); await Promise.all(rejected);
  assert.equal(held.length, 6, 'cancelled queued requests never enter the transport');
});
test('whole fallback cannot start until every failed primary chunk has actually settled', async () => {
  let release, entered;
  const barrier = new Promise(resolve => { entered = resolve; }); let primaryCalls = 0, alternateCalls = 0, lastPrimarySettled = false;
  const transport = createBaseExecutionTransport(async (url, init) => {
    if (url === endpoints[1]) { assert.equal(lastPrimarySettled, true); alternateCalls++; return reply(init); }
    primaryCalls++;
    if (primaryCalls === 1) return new Response('', { status: 403 });
    entered(); return new Promise(resolve => { release = () => { lastPrimarySettled = true; resolve(new Response('', { status: 403 })); }; });
  }, endpoints);
  const pending = read(transport, Array.from({ length: 6 }, () => calls[0]));
  await barrier; await new Promise(resolve => setImmediate(resolve)); assert.equal(alternateCalls, 0);
  release(); assert.equal((await pending).length, 6); assert.equal(alternateCalls, 2);
});
test('prepare allowance is bounded to eleven seconds while the default remains eight seconds', async () => {
  for (const timeoutMs of [undefined, 11000]) {
    let stamp = 0;
    const transport = createBaseExecutionTransport(async () => {}, endpoints, { monotonic: () => stamp });
    const pending = transport.run(async () => { stamp = 9000; return 'ready'; }, undefined,
      timeoutMs === undefined ? undefined : { timeoutMs });
    if (timeoutMs === undefined) await assert.rejects(pending, /EXECUTION_TIMEOUT/);
    else assert.equal(await pending, 'ready');
  }
  const transport = createBaseExecutionTransport(async () => {}, endpoints);
  for (const timeoutMs of [0, -1, 11001, Infinity, 8000.5, '11000'])
    await assert.rejects(transport.run(async () => 'ready', undefined, { timeoutMs }), /INVALID_EXECUTION_CONFIG/);
});
test('caller timeout retains abort-ignoring transport leases and never starts an alternate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = []; let alternate = 0, holding = true;
  const transport = createBaseExecutionTransport((url, init) => {
    if (url === endpoints[1]) alternate++;
    if (!holding) return reply(init);
    return new Promise(resolve => held.push(() => resolve(reply(init))));
  }, endpoints);
  const pending = Array.from({ length: 4 }, () => read(transport));
  const rejected = pending.map(operation => assert.rejects(operation, /EXECUTION_TIMEOUT/));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(held.length, 4);
  t.mock.timers.tick(8000); await Promise.all(rejected);
  await assert.rejects(transport.transports[1](BASE_V3.rpc, {
    method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 'held', ...calls[0] }]),
    signal: new AbortController().signal,
  }), /EXECUTION_BUSY/);
  assert.equal(alternate, 0);
  held.forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alternate, 0);
  holding = false;
  assert.deepEqual(await read(transport), ['0x2105', '0x2105']);
});
test('Relay preparation permits nine-second combined checks while a later claim still times out at eight', async t => {
  const x = await relayPrepared({ sourceUsdc: true }), request = relayRequest(x.f, { sourceUsdc: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let quoted, checked, claimed, releaseQuote, releaseCheck, releaseClaim, heads = 0, claimPhase = false;
  const quoteStarted = new Promise(resolve => { quoted = resolve; });
  const checkStarted = new Promise(resolve => { checked = resolve; });
  const claimStarted = new Promise(resolve => { claimed = resolve; });
  const engine = createExecutionEngine({ now: x.f.now,
    executionPins: { ...pins, relay: { ...x.pins, solanaSolverSigners: [request.recipient] } },
    rpcEndpoints: { base: [BASE_V3.rpc] },
    fetch: async (url, init) => {
      if (url.endsWith('/quote/v2')) return new Promise(resolve => {
        releaseQuote = async () => resolve(await x.wire(url, init)); quoted();
      });
      const batch = JSON.parse(init.body);
      if (batch.some(call => call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest')) {
        heads++;
        if (claimPhase) return new Promise(resolve => {
          releaseClaim = async () => resolve(await x.wire(BASE_V3.rpc, init)); claimed();
        });
        if (heads === 2) return new Promise(resolve => {
          releaseCheck = async () => resolve(await x.wire(BASE_V3.rpc, init)); checked();
        });
      }
      return x.wire(BASE_V3.rpc, init);
    },
  });
  const { amountRaw, deadlineMs, ...fields } = request;
  const pending = engine.prepare({ ...fields, amount: '0.1' });
  await quoteStarted; t.mock.timers.tick(6000); await releaseQuote();
  await checkStarted; t.mock.timers.tick(3000); await releaseCheck();
  const prepared = await pending;
  assert.equal(prepared.candidate.executionReady, true);
  assert.equal(prepared.candidate.minimumOutputRaw, '99500');
  const plan = await engine.recipes.find(recipe => recipe.id === prepared.candidate.legQuotes[0].executableRecipeId)
    .verify(prepared.request, prepared.candidate);
  claimPhase = true;
  const claim = engine.verifier.preflight(plan, plan.actions[0]);
  const rejected = assert.rejects(claim, /EXECUTION_TIMEOUT/);
  await claimStarted; t.mock.timers.tick(8000); await rejected;
  await releaseClaim(); await new Promise(resolve => setImmediate(resolve));
});
const archiveMessage = 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode';
const receiptCall = { method: 'eth_getTransactionReceipt', params: [TXHASH] };
test('exact historical receipt denial starts a complete fresh approval proof on the alternate without retrying primary', async () => {
  const x = await relayPrepared({ sourceUsdc: true }), seen = [];
  const transport = createBaseExecutionTransport(async (url, init) => {
    const batch = JSON.parse(init.body); seen.push({ url, batch });
    if (url === endpoints[0]) return new Response(JSON.stringify(batch.map(call => ({ jsonrpc: '2.0', id: call.id,
      error: { code: -32602, message: archiveMessage } }))));
    return x.wire(BASE_V3.rpc, init);
  }, endpoints);
  const bundles = transport.transports.map(fetch => createRelayBaseSolExecution({
    fetch, now: x.f.now, pins: x.pins, basePins: x.basePins,
  }));
  const result = await transport.run((index, signal) => bundles[index].confirm(x.plan, x.action, TXHASH, signal));
  assert.equal(result.success, true); assert.equal(result.receipt.transactionHash, TXHASH);
  assert.equal(result.destinationCredit, undefined);
  const primary = seen.filter(row => row.url === endpoints[0]), alternate = seen.filter(row => row.url === endpoints[1]);
  assert.equal(primary.length, 1); assert.deepEqual(primary[0].batch.map(({ method }) => method), ['eth_getTransactionReceipt']);
  assert.deepEqual(alternate[0].batch.map(({ method }) => method), ['eth_getTransactionReceipt']);
  const calls = alternate.flatMap(row => row.batch), methods = new Set(calls.map(call => call.method));
  for (const method of ['eth_chainId', 'eth_getTransactionByHash', 'eth_blockNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call'])
    assert.ok(methods.has(method), method);
  assert.ok(calls.filter(call => call.method === 'eth_getBlockByNumber').length >= 2);
  assert.ok(calls.filter(call => call.params[1]?.blockHash).every(call => call.params[1].blockHash === BLOCKHASH));
});
test('archive classification cannot discard mixed evidence, unknown errors, malformed IDs, wrong methods or invalid hash params', async () => {
  for (const fault of ['mixed', 'split-mixed', 'unknown', 'wrong-method', 'wrong-id', 'duplicate', 'invalid-hash', 'extra-param']) {
    let alternate = 0;
    const batch = fault === 'mixed' ? [receiptCall, calls[0]] : fault === 'split-mixed' ? [calls[0], calls[0], calls[0], receiptCall] :
      fault === 'wrong-method' ? [{ method: 'eth_getBlockByHash', params: [TXHASH] }] :
      fault === 'invalid-hash' ? [{ ...receiptCall, params: ['bad-hash'] }] :
      fault === 'extra-param' ? [{ ...receiptCall, params: [TXHASH, 'latest'] }] : [receiptCall];
    const transport = createBaseExecutionTransport(async (url, init) => {
      if (url === endpoints[1]) { alternate++; return reply(init); }
      const sent = JSON.parse(init.body);
      const rows = sent.map(call => call.method === 'eth_chainId' ? { jsonrpc: '2.0', id: call.id, result: '0x2105' } :
        { jsonrpc: '2.0', id: call.id, error: { code: -32602, message: fault === 'unknown' ? 'invalid params' : archiveMessage } });
      if (fault === 'wrong-id') rows[0].id = 'forged-id';
      if (fault === 'duplicate') rows.push(rows[0]);
      return new Response(JSON.stringify(rows));
    }, endpoints);
    await assert.rejects(read(transport, batch), undefined, fault);
    assert.equal(alternate, 0, fault);
  }
});
test('a successful receipt followed by the wrong chain fails closed without trying an alternate', async () => {
  const x = await relayPrepared({ sourceUsdc: true }); let alternate = 0, receiptReads = 0;
  const transport = createBaseExecutionTransport(async (url, init) => {
    if (url === endpoints[1]) alternate++;
    const batch = JSON.parse(init.body);
    if (batch.some(call => call.method === 'eth_getTransactionReceipt')) receiptReads++;
    const response = await x.wire(BASE_V3.rpc, init), rows = await response.json();
    rows.forEach(row => { if (batch.find(call => call.id === row.id)?.method === 'eth_chainId') row.result = '0x1'; });
    return new Response(JSON.stringify(rows));
  }, endpoints);
  const bundles = transport.transports.map(fetch => createRelayBaseSolExecution({ fetch, now: x.f.now, pins: x.pins, basePins: x.basePins }));
  await assert.rejects(transport.run((index, signal) => bundles[index].confirm(x.plan, x.action, TXHASH, signal)), /EXECUTION_CHAIN_MISMATCH/);
  assert.equal(receiptReads, 1); assert.equal(alternate, 0);
});
