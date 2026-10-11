import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewHash, validateRequest } from '@instinct/router-core';
import { createRedisExecutionStore } from '../src/redis-execution-store.mjs';
import { createRedisRestCommand } from '../src/redis-rest.mjs';
import { createRecoverableRedisExecutionStore } from '../src/recoverable-redis-execution-store.mjs';

const exec = promisify(execFile), sender = '0x' + 'a1'.repeat(20), other = '0x' + '22'.repeat(20);
const tx = '0x' + 'a1'.repeat(32), tx2 = '0x' + 'b2'.repeat(32), order = '0x' + 'ab'.repeat(32);
const clone = structuredClone;
async function fixture(id = 'p1', ownerId = 'app1.user', wallet = sender, orderId) {
  const source = { chainId: 'eip155:8453', address: '0x' + '00'.repeat(20), decimals: 18 };
  const destination = { chainId: source.chainId, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
  const request = validateRequest({ requestId: id, source, destination, sender: wallet, recipient: other, amountRaw: '1000',
    slippageBps: 50, maxFeeBps: 100, maxPriceImpactBps: 100, maxCompletionMs: 10000, deadlineMs: Date.now() + 60000,
    optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 }, nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: '10' }] });
  const plan = { routeId: 'route1', quoteIds: ['q1'], source, destination, sender: request.sender, recipient: request.recipient,
    amountRaw: '1000', minimumOutRaw: '995', expiresAtMs: request.deadlineMs, nativeCosts: [{ chainId: source.chainId, amountRaw: '5' }],
    actions: [{ id: 'deposit', chainId: source.chainId, payload: { to: 'reviewed-contract', amountRaw: '1000', ...(orderId ? { relay: { orderId } } : {}) } }] };
  return { id, ownerId, request: clone(request), plan, reviewHash: await reviewHash({ request, plan }),
    revision: 0, status: 'READY', nextAction: 0, claimedActionId: null, submissions: [] };
}
const claim = row => ({ ...clone(row), revision: row.revision + 1, status: 'CLAIMED', claimedActionId: 'deposit' });
const submit = (row, hash = tx) => ({ ...clone(row), revision: row.revision + 1, status: 'SUBMITTED', submissions: [{ actionId: 'deposit', hash }] });
const cancel = row => ({ ...clone(row), revision: row.revision + 1, status: 'CANCELLED' });
const complete = row => ({ ...clone(row), revision: row.revision + 1, status: 'COMPLETE', nextAction: 1, claimedActionId: null,
  receipt: { chainId: row.plan.source.chainId, transactionHash: row.submissions[0].hash, blockNumberRaw: '1', blockHash: '0x' + 'ef'.repeat(32),
    observedAtMs: Date.now(), confirmations: 12, destinationCredit: { asset: row.plan.destination, recipient: row.plan.recipient, amountRaw: '995' } } });
async function crossChainFixture(id, wallet, orderId) {
  const row = await fixture(id, 'app.' + id, wallet, orderId);
  const destination = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  row.plan.destination = row.request.destination = destination;
  row.plan.recipient = row.request.recipient = '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
  row.plan.quoteIds = ['relay:' + orderId];
  row.reviewHash = await reviewHash({ request: row.request, plan: row.plan }); return row;
}
function crossChainComplete(row) {
  const result = complete(row); delete result.receipt.destinationCredit;
  const encode = length => {
    let number = BigInt('0x' + 'ab'.repeat(length)), text = ''; const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    while (number) { text = alphabet[Number(number % 58n)] + text; number /= 58n; } return text;
  };
  result.destinationReceipt = { chainId: row.plan.destination.chainId, transactionHash: encode(64), blockNumberRaw: '200', blockHash: encode(32),
    observedAtMs: Date.now(), commitment: 'finalized', destinationCredit: { asset: row.plan.destination, recipient: row.plan.recipient, amountRaw: '995' },
    attribution: { provider: 'relay', requestId: row.plan.quoteIds[0].slice(6), sourceTransactionHash: row.submissions[0].hash } };
  return result;
}
async function save(store, row, next) { assert.equal(await store.compareAndSwap(row.id, row.revision, next), true); return next; }

// Exercise the actual Lua interpreter and Redis atomicity, not a JS imitation.
// Local integration suite skips when Redis binaries are absent; REST tests run everywhere.
async function redis(t) {
  try { await exec('redis-server', ['--version']); await exec('redis-cli', ['--version']); }
  catch { t.skip('Redis integration tests require redis-server and redis-cli'); return null; }
  const directory = await mkdtemp(join(tmpdir(), 'ir-redis-')), socket = join(directory, 'redis.sock');
  const process = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => process.once('exit', resolve));
  t.after(async () => { process.kill(); await exited; await rm(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis start timed out')), 5000);
    process.once('error', reject); process.once('exit', () => reject(new Error('Redis exited before ready')));
    process.stdout.on('data', chunk => { if (chunk.toString().includes('ready to accept connections') || chunk.toString().includes('Ready to accept connections')) { clearTimeout(timer); resolve(); } });
  });
  const command = async args => {
    const { stdout } = await exec('redis-cli', ['-s', socket, '--json', ...args.map(String)], { maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(stdout); if (typeof result === 'string' && result.startsWith('error:')) throw new Error('REDIS_COMMAND_FAILED'); return result;
  };
  return { command, open: options => createRedisExecutionStore({ command, ...options }) };
}

test('Redis REST validates HTTPS, sends authenticated commands once, and hides transport details', async () => {
  assert.throws(() => createRedisRestCommand({ url: 'http://redis.invalid', token: 'private' }), /CONFIG_INVALID/);
  let count = 0;
  const command = createRedisRestCommand({ url: 'https://redis.invalid', token: 'private', fetch: async (url, options) => {
    count++; assert.equal(url, 'https://redis.invalid/'); assert.equal(options.headers.Authorization, 'Bearer private');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.deepEqual(JSON.parse(options.body), ['GET', 'key']);
    return { ok: true, json: async () => ({ result: null }) };
  } });
  assert.equal(await command(['GET', 'key']), null); assert.equal(count, 1);
  for (const response of [() => { throw new Error('private url token'); }, () => ({ ok: false }), () => ({ ok: true, json: async () => ({ error: 'private' }) })]) {
    let calls = 0; const faulty = createRedisRestCommand({ url: 'https://redis.invalid', token: 'private', fetch: async () => { calls++; return response(); } });
    await assert.rejects(faulty(['EVAL', 'script']), error => error.message === 'REDIS_REST_UNAVAILABLE'); assert.equal(calls, 1);
  }
});

test('competing Redis instances reserve wallets across applications and allow a single claim', async t => {
  const r = await redis(t); if (!r) return;
  const a = await r.open(), b = await r.open(), first = await fixture(), second = await fixture('second', 'app2.user', sender.toUpperCase().replace('0X', '0x'));
  const results = await Promise.all([a.insert(first), b.insert(second)]); assert.equal(results.filter(Boolean).length, 1);
  const row = results[0] ? first : second;
  assert.equal(await b.findActive('missing.owner'), null);
  assert.equal((await b.findActive(row.ownerId)).id, row.id);
  const claims = await Promise.all([a.compareAndSwap(row.id, 0, claim(row)), b.compareAndSwap(row.id, 0, claim(row))]);
  assert.equal(claims.filter(Boolean).length, 1);
  const read = await b.get(row.id); read.plan.amountRaw = '999'; assert.equal((await a.get(row.id)).plan.amountRaw, '1000');
  await a.close(); const reopened = await r.open(); assert.equal((await reopened.get(row.id)).status, 'CLAIMED');
  assert.equal(await reopened.insert(await fixture('blocked', 'app3.user')), false);
  await assert.rejects(reopened.compareAndSwap(row.id, 1, { ...clone(await b.get(row.id)), revision: 2, status: 'READY', claimedActionId: null }), /TRANSITION_INVALID/);
});

test('Redis cancellation releases wallet/order while completion retains replay indexes', async t => {
  const r = await redis(t); if (!r) return;
  const a = await r.open(), b = await r.open(), first = await fixture('first', 'app1.user', sender, order);
  assert.equal(await a.insert(first), true);
  await assert.rejects(b.insert(await fixture('duplicate', 'app2.user', other, order)), /ORDER_REUSED/);
  await save(a, first, cancel(first)); assert.equal(await b.findActive(first.ownerId), null);
  let next = await fixture('next', 'app2.user', sender, order); assert.equal(await b.insert(next), true);
  next = await save(b, next, claim(next)); next = await save(b, next, submit(next)); next = await save(b, next, complete(next));
  assert.equal(await a.findActive(next.ownerId), null);
  await assert.rejects(a.insert(await fixture('completed-order', 'app3.user', other, order)), /ORDER_REUSED/);
  let replay = await fixture('replay', 'app3.user', other); await a.insert(replay); replay = await save(a, replay, claim(replay));
  await assert.rejects(b.compareAndSwap(replay.id, replay.revision, submit(replay, tx.toUpperCase().replace('0X', '0x'))), /TRANSACTION_REUSED/);
  assert.equal((await a.get(replay.id)).status, 'CLAIMED');
  assert.equal(await r.command(['PTTL', '{instinct-router-execution:v1}:records']), -1);
  assert.equal(await r.command(['PTTL', '{instinct-router-execution:v1}:claims']), -1);
});

test('Redis destination replay indexes reject delivery reuse independently of source transactions', async t => {
  const r = await redis(t); if (!r) return;
  const a = await r.open(); let first = await crossChainFixture('first', sender, order);
  await a.insert(first); first = await save(a, first, claim(first)); first = await save(a, first, submit(first)); await save(a, first, crossChainComplete(first));
  let next = await crossChainFixture('next', other, '0x' + 'bc'.repeat(32)); await a.insert(next); next = await save(a, next, claim(next)); next = await save(a, next, submit(next, tx2));
  await assert.rejects(a.compareAndSwap(next.id, next.revision, crossChainComplete(next)), /DELIVERY_REUSED/);
  assert.equal((await a.get(next.id)).status, 'SUBMITTED');
});

test('Redis expired previews release orders, snapshot inputs, and reject hidden fields before commands', async t => {
  const r = await redis(t); if (!r) return;
  const a = await r.open(); const row = await fixture('expired', 'app1.user', sender, order);
  row.plan.expiresAtMs = Date.now() - 1; row.reviewHash = await reviewHash({ request: row.request, plan: row.plan });
  const expected = clone(row), pending = a.insert(row); row.plan.amountRaw = '999'; assert.equal(await pending, true);
  assert.deepEqual(await a.get(row.id), expected);
  await save(a, expected, { ...clone(expected), revision: 1, status: 'EXPIRED' });
  assert.equal(await a.insert(await fixture('replacement', 'app2.user', sender, order)), true);
  let called = 0; const hidden = await fixture('hidden', 'app3.user', other);
  Object.defineProperty(hidden, 'request', { enumerable: true, get() { called++; return {}; } });
  await assert.rejects(a.insert(hidden), /RECORD_INVALID/); assert.equal(called, 0);
});

test('an ambiguous applied Redis write poisons the writer and reopens with its durable claim', async t => {
  const r = await redis(t); if (!r) return;
  let fault = false;
  const a = await createRedisExecutionStore({ command: async args => { const result = await r.command(args); if (fault) throw new Error('lost response'); return result; } });
  const row = await fixture(); await a.insert(row); fault = true;
  await assert.rejects(a.compareAndSwap(row.id, 0, claim(row)), /STORE_UNAVAILABLE/); // fault during the pre-CAS read has no mutation
  fault = false;
  let writes = 0; const uncertain = await createRedisExecutionStore({ command: async args => {
    const result = await r.command(args); if (args[1].includes('local id=ARGV[2]')) { writes++; throw new Error('lost write response'); } return result;
  } });
  await assert.rejects(uncertain.compareAndSwap(row.id, 0, claim(row)), /WRITE_UNCERTAIN/);
  await assert.rejects(uncertain.get(row.id), /POISONED/); assert.equal(writes, 1);
  const recovered = await r.open(); assert.equal((await recovered.get(row.id)).status, 'CLAIMED');
  assert.equal(await recovered.compareAndSwap(row.id, 0, claim(row)), false);
  assert.equal(await recovered.insert(await fixture('blocked')), false);
});

test('Redis detects corrupt rows, wrong key types, TTLs and capacity without partial mutations', async t => {
  const r = await redis(t); if (!r) return;
  const a = await r.open({ maxRecords: 1 }); let row = await fixture(); await a.insert(row); row = await save(a, row, cancel(row));
  await assert.rejects(a.insert(await fixture('full')), /STORE_CAPACITY/); assert.equal(await a.get('full'), null);
  await assert.rejects((await r.open()).get(row.id), /STORE_CONFIG_INVALID/);
  await r.command(['HSET', '{instinct-router-execution:v1}:records', row.id, '{}']);
  await assert.rejects(a.get(row.id), /STORE_INTEGRITY_FAILED/);
  const b = await r.open({ namespace: 'wrongtype' }); await r.command(['SET', '{wrongtype}:claims', 'unexpected']);
  await assert.rejects(b.insert(await fixture()), /STORE_INTEGRITY_FAILED/); assert.equal(await r.command(['EXISTS', '{wrongtype}:records']), 0);
  const c = await r.open({ namespace: 'ttl' }); await c.insert(await fixture()); await r.command(['PEXPIRE', '{ttl}:claims', 60000]);
  await assert.rejects(c.get('p1'), /STORE_INTEGRITY_FAILED/);
});

test('cached serverless journal replaces an uncertain writer only on future calls without replay', async t => {
  const r = await redis(t); if (!r) return;
  let drop = false, writes = 0;
  const store = await createRecoverableRedisExecutionStore({ command: async args => {
    const writing = args[1].includes('local id=ARGV[2]');
    if (writing) writes++;
    const result = await r.command(args);
    if (writing && drop) { drop = false; throw new Error('lost response after commit'); }
    return result;
  } });
  const row = await fixture(), expected = clone(row), inserted = store.insert(row); row.plan.amountRaw = '999';
  assert.equal(await inserted, true); drop = true;
  await assert.rejects(store.compareAndSwap(expected.id, 0, claim(expected)), /WRITE_UNCERTAIN/);
  assert.equal(writes, 2); // exactly one insertion and one claim attempt
  assert.equal((await store.get(expected.id)).status, 'CLAIMED');
  assert.equal((await store.findActive(expected.ownerId)).status, 'CLAIMED');
  assert.equal(await store.compareAndSwap(expected.id, 0, claim(expected)), false); assert.equal(writes, 2);
  assert.equal(await store.insert(await fixture('blocked')), false); assert.equal(writes, 3);
  const claimed = await store.get(expected.id);
  const recovery = { ...clone(claimed), revision: claimed.revision + 1, status: 'RECOVERY_REQUIRED' };
  assert.equal(await store.compareAndSwap(expected.id, claimed.revision, recovery), true);
  assert.equal((await store.findActive(expected.ownerId)).status, 'RECOVERY_REQUIRED');
  await store.close(); await assert.rejects(store.get(expected.id), /STORE_CLOSED/);
});
