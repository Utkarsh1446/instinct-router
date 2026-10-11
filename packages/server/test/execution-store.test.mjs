import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { reviewHash, validateRequest } from '@instinct/router-core';
import { createFileExecutionStore } from '../src/execution-store.mjs';

const sender = '0x' + 'a1'.repeat(20), other = '0x' + '22'.repeat(20);
const tx = '0x' + 'a1'.repeat(32), secondTx = '0x' + 'b2'.repeat(32);
const clone = structuredClone;
async function fixture(id = 'p1', ownerId = 'app1.user', wallet = sender, actionCount = 1) {
  const source = { chainId: 'eip155:8453', address: '0x' + '00'.repeat(20), decimals: 18 };
  const destination = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
  const request = validateRequest({ requestId: id, source, destination, sender: wallet, recipient: '0x2222222222222222222222222222222222222222', amountRaw: '1000',
    slippageBps: 50, maxFeeBps: 100, maxPriceImpactBps: 100, maxCompletionMs: 10000, deadlineMs: Date.now() + 60000,
    optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 }, nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: '10' }] });
  const plan = { routeId: 'route1', quoteIds: ['q1'], source, destination, sender: request.sender, recipient: request.recipient,
    amountRaw: '1000', minimumOutRaw: '995', expiresAtMs: request.deadlineMs, nativeCosts: [{ chainId: source.chainId, amountRaw: '5' }],
    actions: Array.from({ length: actionCount }, (_, i) => ({ id: i ? 'deposit' : actionCount === 1 ? 'deposit' : 'approve',
      chainId: source.chainId, payload: { to: 'locally-reviewed-contract', amountRaw: '1000' } })) };
  return { id, ownerId, request: clone(request), plan, reviewHash: await reviewHash({ request, plan }),
    revision: 0, status: 'READY', nextAction: 0, claimedActionId: null, submissions: [] };
}
const claim = row => ({ ...clone(row), revision: row.revision + 1, status: 'CLAIMED', claimedActionId: row.plan.actions[row.nextAction].id });
const submit = (row, hash = tx) => ({ ...clone(row), revision: row.revision + 1, status: 'SUBMITTED',
  submissions: [...clone(row.submissions), { actionId: row.claimedActionId, hash }] });
const confirm = row => ({ ...clone(row), revision: row.revision + 1,
  status: row.nextAction + 1 === row.plan.actions.length ? 'COMPLETE' : 'READY', nextAction: row.nextAction + 1, claimedActionId: null });
async function temporary(t, options = {}) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'router-execution-test-'));
  const directory = path.join(root, 'journal'), stores = [];
  t.after(async () => { for (const store of stores) await store.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const open = async () => { const store = await createFileExecutionStore({ directory, ...options }); stores.push(store); return store; };
  return { root, directory, open, store: await open() };
}
async function save(store, old, next) { assert.equal(await store.compareAndSwap(old.id, old.revision, next), true); return next; }

test('nullable caller limits persist with finite reserves and cannot cover unlisted chains', async t => {
  const f = await temporary(t), row = await fixture();
  row.request.maxFeeBps = null; row.request.nativeFeeBudgets[0].maxAmountRaw = null;
  row.reviewHash = await reviewHash({ request: row.request, plan: row.plan });
  assert.equal(await f.store.insert(row), true);
  await f.store.close(); const reopened = await f.open(); assert.deepEqual(await reopened.get(row.id), row);
  const malformed = await fixture('invalid', 'other-owner', other);
  malformed.request.maxFeeBps = null;
  malformed.request.nativeFeeBudgets = [{ chainId: 'eip155:1', maxAmountRaw: null }];
  malformed.reviewHash = await reviewHash({ request: malformed.request, plan: malformed.plan });
  await assert.rejects(reopened.insert(malformed), /EXECUTION_RECORD_INVALID/);
});

async function usdcApprovalFixture() {
  const row = await fixture('usdc', 'app1.user', sender, 2), spender = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  const source = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
  const destination = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  Object.assign(row.request, { source, destination, recipient: '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT' });
  Object.assign(row.plan, { source, destination, recipient: row.request.recipient, actions: [
    { id: 'relay-usdc-approve', chainId: source.chainId, payload: { type: 'EVM_TRANSACTION', transaction: {
      chainId: '0x2105', from: sender, to: source.address, value: '0x0', data: '0x095ea7b3' +
      spender.slice(2).padStart(64, '0') + BigInt(row.plan.amountRaw).toString(16).padStart(64, '0') } } },
    { id: 'relay-usdc-deposit', chainId: source.chainId, payload: { type: 'EVM_TRANSACTION' } },
  ] });
  row.reviewHash = await reviewHash({ request: row.request, plan: row.plan }); return row;
}

test('cancelled confirmed USDC approval retains its hash across restart and allows a fresh quote', async t => {
  const f = await temporary(t), row = await usdcApprovalFixture(); await f.store.insert(row);
  let current = await save(f.store, row, claim(row)); current = await save(f.store, current, submit(current));
  current = await save(f.store, current, confirm(current));
  current = await save(f.store, current, { ...clone(current), revision: current.revision + 1, status: 'CANCELLED' });
  assert.equal(current.nextAction, 1); assert.equal(current.submissions[0].hash, tx);
  await f.store.close(); const reopened = await f.open(); assert.deepEqual(await reopened.get(row.id), current);
  const next = await fixture('fresh'); assert.equal(await reopened.insert(next), true);
  const claimed = await save(reopened, next, claim(next));
  await assert.rejects(reopened.compareAndSwap(next.id, claimed.revision, submit(claimed, tx)), /TRANSACTION_REUSED/);
});

test('store never releases generic intermediate actions, forged approvals, or claimed funding steps', async t => {
  for (const variant of ['generic', 'unlimited', 'wrong-target', 'native-value', 'claimed']) {
    const f = await temporary(t), row = variant === 'generic' ? await fixture('p1', 'app1.user', sender, 2) : await usdcApprovalFixture();
    const txData = row.plan.actions[0].payload.transaction;
    if (variant === 'unlimited') txData.data = txData.data.slice(0, -64) + 'f'.repeat(64);
    if (variant === 'wrong-target') txData.to = '0x' + '77'.repeat(20);
    if (variant === 'native-value') txData.value = '0x1';
    row.reviewHash = await reviewHash({ request: row.request, plan: row.plan }); await f.store.insert(row);
    let current = await save(f.store, row, claim(row)); current = await save(f.store, current, submit(current));
    current = await save(f.store, current, confirm(current));
    if (variant === 'claimed') current = await save(f.store, current, claim(current));
    await assert.rejects(f.store.compareAndSwap(row.id, current.revision,
      { ...clone(current), revision: current.revision + 1, status: 'CANCELLED', claimedActionId: null }), /EXECUTION_(?:RECORD|TRANSITION)_INVALID/);
    assert.equal(await f.store.insert(await fixture('blocked')), false);
  }
});

test('durable request/review/actions and claims survive clean restart with private permissions', async t => {
  const f = await temporary(t), row = await fixture();
  assert.equal(await f.store.insert(row), true);
  const claimed = await save(f.store, row, claim(row));
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  for (const name of ['FORMAT', 'state.json', 'writer.lock']) assert.equal((await fs.stat(path.join(f.directory, name))).mode & 0o777, 0o600);
  await Promise.all([f.store.close(), f.store.close()]);
  const restarted = await f.open();
  assert.deepEqual(await restarted.get(row.id), claimed);
  assert.equal(await restarted.insert(await fixture('another', 'other-app')), false);
});

test('CAS serializes concurrent claims; returned and queued input snapshots are isolated', async t => {
  const f = await temporary(t), row = await fixture();
  const insertion = f.store.insert(row); row.plan.amountRaw = '999';
  assert.equal(await insertion, true);
  const original = await f.store.get(row.id); original.plan.actions[0].payload.amountRaw = 'changed';
  const saved = await f.store.get(row.id); assert.equal(saved.plan.actions[0].payload.amountRaw, '1000');
  const next = claim(saved);
  const writes = [f.store.compareAndSwap(row.id, 0, next), f.store.compareAndSwap(row.id, 0, next)];
  next.plan.actions[0].payload.amountRaw = 'changed-after-call';
  assert.deepEqual(await Promise.all(writes), [true, false]);
  assert.equal((await f.store.get(row.id)).plan.actions[0].payload.amountRaw, '1000');
  assert.equal(await f.store.compareAndSwap('missing', 0, claim(saved)), false);
});

test('wallet reservation spans apps and owners, and COMPLETE retains history while permitting a new plan', async t => {
  const f = await temporary(t), row = await fixture(); await f.store.insert(row);
  assert.equal(await f.store.insert(await fixture('other-app', 'app2.user', sender.toUpperCase().replace('0X', '0x'))), false);
  let current = await save(f.store, row, claim(row));
  current = await save(f.store, current, submit(current)); current = await save(f.store, current, confirm(current));
  assert.equal(await f.store.insert(await fixture('next', 'app2.user')), true);
  assert.deepEqual(await f.store.get(row.id), current);
  await f.store.close(); const reopened = await f.open(); assert.deepEqual(await reopened.get(row.id), current);
});

test('unknown signing stays reserved, late known hash recovers, and unclaimed positions cannot receive a hash', async t => {
  const f = await temporary(t), row = await fixture('p1', 'app1.user', sender, 2); await f.store.insert(row);
  let current = await save(f.store, row, claim(row));
  current = await save(f.store, current, { ...current, revision: current.revision + 1, status: 'RECOVERY_REQUIRED' });
  await assert.rejects(f.store.compareAndSwap(row.id, current.revision, { ...clone(current), revision: current.revision + 1, status: 'READY', claimedActionId: null }), /TRANSITION_INVALID/);
  assert.equal(await f.store.insert(await fixture('blocked')), false);
  current = await save(f.store, current, submit(current));
  current = await save(f.store, current, confirm(current));
  assert.equal(current.nextAction, 1); assert.equal(current.status, 'READY');
  await assert.rejects(f.store.compareAndSwap(row.id, current.revision, submit({ ...current, claimedActionId: 'deposit' }, secondTx)), /TRANSITION_INVALID/);
  current = await save(f.store, current, claim(current)); current = await save(f.store, current, submit(current, secondTx));
  current = await save(f.store, current, confirm(current)); assert.equal(current.status, 'COMPLETE');
});

test('original owner/request/plan/review and every prior submitted hash are immutable', async t => {
  const f = await temporary(t), row = await fixture(); await f.store.insert(row);
  for (const mutate of [r => { r.ownerId = 'attacker'; }, r => { r.plan.amountRaw = '999'; },
    r => { r.request.deadlineMs++; }, r => { r.reviewHash = 'f'.repeat(64); }, r => { r.revision += 2; },
    r => { r.status = 'COMPLETE'; r.nextAction = 1; r.claimedActionId = null; r.submissions = [{ actionId: 'deposit', hash: tx }]; }]) {
    const next = claim(row); mutate(next);
    await assert.rejects(f.store.compareAndSwap(row.id, 0, next), /EXECUTION_(?:RECORD|TRANSITION)_INVALID/);
    assert.equal((await f.store.get(row.id)).revision, 0);
  }
  let current = await save(f.store, row, claim(row)); current = await save(f.store, current, submit(current));
  const changed = { ...clone(current), revision: current.revision + 1, status: 'RECOVERY_REQUIRED' };
  changed.submissions[0].hash = secondTx;
  await assert.rejects(f.store.compareAndSwap(row.id, current.revision, changed), /TRANSITION_INVALID/);
});

test('transaction reuse is case-normalized and globally chain-scoped across retained terminal history', async t => {
  const f = await temporary(t), row = await fixture(); await f.store.insert(row);
  let current = await save(f.store, row, claim(row)); current = await save(f.store, current, submit(current));
  current = await save(f.store, current, confirm(current));
  const next = await fixture('p2'); await f.store.insert(next);
  const claimed = await save(f.store, next, claim(next));
  await assert.rejects(f.store.compareAndSwap(next.id, claimed.revision, submit(claimed, tx.toUpperCase().replace('0X', '0x'))), /TRANSACTION_REUSED/);
  assert.equal((await f.store.get(next.id)).status, 'CLAIMED');
  const distinct = await fixture('p3', 'app3.user', other); await f.store.insert(distinct);
  const otherClaim = await save(f.store, distinct, claim(distinct));
  await assert.rejects(f.store.compareAndSwap(distinct.id, otherClaim.revision, submit(otherClaim, tx)), /TRANSACTION_REUSED/);
});

test('record limits, incomplete schemas, hidden/getter data and false review hashes fail without mutation', async t => {
  const f = await temporary(t, { maxRecordBytes: 4096 }), row = await fixture();
  for (const mutate of [r => { delete r.request; }, r => { r.revision = 1; }, r => { r.unexpected = true; },
    r => { r.plan.nativeCosts[0].amountRaw = '11'; }, r => { r.plan.actions[0].chainId = 'eip155:1'; },
    r => { r.reviewHash = '0'.repeat(64); }, r => { r.plan.actions[0].payload.data = 'x'.repeat(5000); }]) {
    const invalid = clone(row); mutate(invalid); await assert.rejects(f.store.insert(invalid), /EXECUTION_RECORD_(?:INVALID|LIMIT)/);
  }
  let called = 0;
  const getter = clone(row); Object.defineProperty(getter.plan.actions[0].payload, 'getter', { enumerable: true, get() { called++; return 'secret'; } });
  await assert.rejects(f.store.insert(getter), /RECORD_INVALID/); assert.equal(called, 0);
  const array = clone(row); Object.defineProperty(array.plan.actions, '0', { enumerable: true, get() { called++; return {}; } });
  await assert.rejects(f.store.insert(array), /RECORD_INVALID/); assert.equal(called, 0);
  assert.equal(await f.store.get(row.id), null); assert.equal(await f.store.insert(row), true);
});

test('capacity never evicts a terminal execution or releases an active wallet', async t => {
  const f = await temporary(t, { maxRecords: 1 }), row = await fixture(); await f.store.insert(row);
  let current = await save(f.store, row, claim(row)); current = await save(f.store, current, submit(current));
  current = await save(f.store, current, confirm(current));
  await assert.rejects(f.store.insert(await fixture('p2')), /STORE_CAPACITY/);
  assert.equal((await f.store.get(row.id)).status, 'COMPLETE');
});

test('writer ownership refuses concurrent processes and never evicts a crash lock automatically', async t => {
  const f = await temporary(t); await assert.rejects(f.open(), /WRITER_LOCKED/); await f.store.close();
  const row = await fixture();
  const script = 'import {createFileExecutionStore} from ' + JSON.stringify(new URL('../src/execution-store.mjs', import.meta.url).href) +
    ';const s=await createFileExecutionStore({directory:process.argv[1]});await s.insert(JSON.parse(process.argv[2]));process.stdout.write("READY\\n");setInterval(()=>{},1000);';
  const child = spawn(process.execPath, ['--import', new URL('../../../scripts/workspace-loader.mjs', import.meta.url).pathname,
    '--input-type=module', '--eval', script, f.directory, JSON.stringify(row)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const started = once(child.stdout, 'data'), exited = once(child, 'exit');
  await started; await assert.rejects(f.open(), /WRITER_LOCKED/);
  child.kill('SIGKILL'); await exited;
  await assert.rejects(f.open(), /WRITER_LOCKED/);
  // Explicit operator action in this disposable fixture only; not automatic recovery.
  await fs.unlink(path.join(f.directory, 'writer.lock'));
  const recovered = await f.open(); assert.deepEqual(await recovered.get(row.id), row);
});

test('symlink directory, snapshot, hardlink and unsafe permissions fail closed', async t => {
  const f = await temporary(t), alias = path.join(f.root, 'alias');
  await fs.symlink(f.directory, alias);
  await assert.rejects(createFileExecutionStore({ directory: alias }), /UNSAFE_PATH/);
  await f.store.close();
  const external = path.join(f.root, 'external'); await fs.writeFile(external, '{}', { mode: 0o600 });
  await fs.unlink(path.join(f.directory, 'state.json')); await fs.symlink(external, path.join(f.directory, 'state.json'));
  await assert.rejects(f.open(), /INTEGRITY_FAILED/); assert.equal(await fs.readFile(external, 'utf8'), '{}');
  const g = await temporary(t); await fs.link(path.join(g.directory, 'state.json'), path.join(g.root, 'hardlink'));
  await assert.rejects(g.store.get('missing'), /INTEGRITY_FAILED/);
  const h = await temporary(t); await fs.chmod(path.join(h.directory, 'state.json'), 0o644);
  await assert.rejects(h.store.get('missing'), /INTEGRITY_FAILED/);
});

test('external snapshot replacement is detected before writes; an outer checksum cannot authorize altered terms', async t => {
  const f = await temporary(t), row = await fixture(); await f.store.insert(row);
  const filename = path.join(f.directory, 'state.json');
  await fs.writeFile(filename, 'corrupt', { mode: 0o600 });
  await assert.rejects(f.store.get(row.id), /INTEGRITY_FAILED/);
  await assert.rejects(f.store.insert(await fixture('another')), /POISONED/);
  const g = await temporary(t); await g.store.insert(row); await g.store.close();
  const data = JSON.parse(await fs.readFile(path.join(g.directory, 'state.json'), 'utf8'));
  data.records[0].plan.minimumOutRaw = '994';
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  data.sha256 = createHash('sha256').update(canonical({ generation: data.generation, records: data.records, version: 1 })).digest('hex');
  await fs.writeFile(path.join(g.directory, 'state.json'), canonical(data));
  await assert.rejects(g.open(), /RECORD_INVALID/);
});

test('an uncertain write reports no success, poisons the writer and preserves whichever complete snapshot reached disk', async t => {
  for (const renamed of [false, true]) {
    const f = await temporary(t), row = await fixture(); await f.store.insert(row);
    const rename = fs.rename;
    const mock = t.mock.method(fs, 'rename', async (...args) => {
      if (renamed) await rename(...args);
      throw new Error('private credential and filesystem path');
    });
    await assert.rejects(f.store.compareAndSwap(row.id, 0, claim(row)), error =>
      error.code === 'EXECUTION_STORE_WRITE_UNCERTAIN' && !error.message.includes('credential'));
    mock.mock.restore();
    await assert.rejects(f.store.get(row.id), /POISONED/); await assert.rejects(f.store.close(), /POISONED/);
    await assert.rejects(f.open(), /WRITER_LOCKED/);
    await fs.unlink(path.join(f.directory, 'writer.lock'));
    const recovered = await f.open();
    assert.equal((await recovered.get(row.id)).status, renamed ? 'CLAIMED' : 'READY');
    assert.equal(await recovered.insert(await fixture('another')), false);
  }
});
test('durable active-owner lookup excludes cancelled/expired previews and global hash reuse spans different wallets', async t => {
  const f = await temporary(t), row = await fixture(); await f.store.insert(row);
  assert.equal((await f.store.findActive(row.ownerId)).id, row.id);
  assert.equal(await f.store.findActive('wrong-owner'), null);
  const cancelled = { ...clone(row), revision: 1, status: 'CANCELLED' };
  await save(f.store, row, cancelled); assert.equal(await f.store.findActive(row.ownerId), null);
  let current = await fixture('p2'); await f.store.insert(current);
  current = await save(f.store, current, claim(current)); current = await save(f.store, current, submit(current));
  current = await save(f.store, current, confirm(current));
  let second = await fixture('p3', 'different-owner', other); await f.store.insert(second);
  second = await save(f.store, second, claim(second));
  await assert.rejects(f.store.compareAndSwap(second.id, second.revision, submit(second)), /TRANSACTION_REUSED/);
  await f.store.close(); const reopened = await f.open();
  assert.equal((await reopened.findActive('different-owner')).status, 'CLAIMED');
  assert.equal((await reopened.get('p1')).status, 'CANCELLED');
});
test('timeline and independently attributed terminal receipt survive restart and reject drift', async t => {
  const f = await temporary(t), row = await fixture();
  const stamp = Date.now(); row.timeline = { preparedAtMs: stamp }; await f.store.insert(row);
  let current = claim(row); current.timeline = { ...row.timeline, claimedAtMs: stamp + 1 };
  current = await save(f.store, row, current);
  const submitted = submit(current); submitted.timeline = { ...current.timeline, submittedAtMs: stamp + 2 };
  current = await save(f.store, current, submitted);
  const completed = confirm(current); completed.timeline = { ...current.timeline, completedAtMs: stamp + 3 };
  completed.receipt = { chainId: row.plan.source.chainId, transactionHash: tx, blockNumberRaw: '123', blockHash: '0x' + 'bc'.repeat(32),
    observedAtMs: stamp + 3, confirmations: 12, actualNativeFeeRaw: '3', destinationCredit: { asset: row.plan.destination, recipient: row.plan.recipient, amountRaw: '995' } };
  for (const mutate of [r => r.receipt.transactionHash = secondTx, r => r.receipt.destinationCredit.amountRaw = '994',
    r => r.timeline.preparedAtMs++, r => r.receipt.confirmations = 0, r => r.receipt.actualNativeFeeRaw = '-1']) {
    const altered = clone(completed); mutate(altered);
    await assert.rejects(f.store.compareAndSwap(current.id, current.revision, altered));
  }
  current = await save(f.store, current, completed); await f.store.close(); const reopened = await f.open();
  assert.deepEqual((await reopened.get(row.id)).receipt, completed.receipt);
  assert.deepEqual((await reopened.get(row.id)).timeline, completed.timeline);
});
test('FAILED requires original canonical source receipt with no destination credit before reservation release', async t => {
  const f = await temporary(t), row = await fixture(); await f.store.insert(row);
  let current = await save(f.store, row, claim(row)); current = await save(f.store, current, submit(current));
  const failed = { ...clone(current), revision: current.revision + 1, status: 'FAILED', receipt: {
    chainId: row.plan.source.chainId, transactionHash: tx, blockNumberRaw: '12', blockHash: '0x' + 'bc'.repeat(32), observedAtMs: Date.now(), confirmations: 12 } };
  await assert.rejects(f.store.compareAndSwap(current.id, current.revision, { ...failed, receipt: undefined }));
  await assert.rejects(f.store.compareAndSwap(current.id, current.revision, { ...failed, receipt: { ...failed.receipt,
    destinationCredit: { asset: row.plan.destination, recipient: row.plan.recipient, amountRaw: '995' } } }));
  await save(f.store, current, failed); assert.equal(await f.store.findActive(row.ownerId), null);
  assert.equal(await f.store.insert(await fixture('replacement')), true);
});

async function crossChainFixture(id='cross',wallet=sender,orderId='0x'+'ab'.repeat(32)) {
  const row=await fixture(id,'app.user.'+id,wallet);
  const destination={chainId:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',decimals:6};
  row.plan.destination=destination;row.request.destination=destination;
  row.plan.recipient=row.request.recipient='47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
  row.plan.quoteIds=['relay:'+orderId];row.plan.actions[0].payload.relay={orderId};
  row.reviewHash=await reviewHash({request:row.request,plan:row.plan});return row;
}
function crossChainComplete(row) {
  const result=confirm(row), sourceHash=row.submissions[0].hash;
  const encode=length=>{let number=BigInt('0x'+'ab'.repeat(length)),text='';const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    while(number){text=alphabet[Number(number%58n)]+text;number/=58n;}return text;};
  result.receipt={chainId:row.plan.source.chainId,transactionHash:sourceHash,blockNumberRaw:'100',blockHash:'0x'+'ef'.repeat(32),observedAtMs:Date.now(),confirmations:12};
  result.destinationReceipt={chainId:row.plan.destination.chainId,transactionHash:encode(64),blockNumberRaw:'200',blockHash:encode(32),observedAtMs:Date.now(),commitment:'finalized',
    destinationCredit:{asset:row.plan.destination,recipient:row.plan.recipient,amountRaw:'995'},
    attribution:{provider:'relay',requestId:row.plan.quoteIds[0].slice(6),sourceTransactionHash:sourceHash}};
  return result;
}
test('separate cross-chain receipts survive restart and source-only success is rejected',async t=>{
  const f=await temporary(t),row=await crossChainFixture();await f.store.insert(row);
  let current=await save(f.store,row,claim(row));current=await save(f.store,current,submit(current));
  const complete=crossChainComplete(current);
  for(const mutate of [r=>delete r.destinationReceipt,r=>delete r.receipt,r=>r.destinationReceipt.attribution.sourceTransactionHash=secondTx,
    r=>r.destinationReceipt.destinationCredit.recipient=other,r=>r.destinationReceipt.commitment='confirmed',r=>r.receipt.destinationCredit=r.destinationReceipt.destinationCredit]) {
    const bad=clone(complete);mutate(bad);await assert.rejects(f.store.compareAndSwap(row.id,current.revision,bad),/EXECUTION_RECORD_INVALID/);
  }
  await save(f.store,current,complete);await f.store.close();const reopened=await f.open();
  assert.deepEqual(await reopened.get(row.id),complete);
});
test('durable constraints prevent funding the same Relay order twice across different wallets',async t=>{
  const f=await temporary(t),row=await crossChainFixture();await f.store.insert(row);
  const duplicate=await crossChainFixture('duplicate',other);
  await assert.rejects(f.store.insert(duplicate),/EXECUTION_ORDER_REUSED/);
  assert.equal(await f.store.get('duplicate'),null);
});
test('a Solana payout cannot complete two separate cross-chain trades',async t=>{
  const f=await temporary(t),first=await crossChainFixture();await f.store.insert(first);
  let a=await save(f.store,first,claim(first));a=await save(f.store,a,submit(a));await save(f.store,a,crossChainComplete(a));
  const second=await crossChainFixture('second',other,'0x'+'bc'.repeat(32));await f.store.insert(second);
  let b=await save(f.store,second,claim(second));b=await save(f.store,b,submit(b,secondTx));
  await assert.rejects(f.store.compareAndSwap(b.id,b.revision,crossChainComplete(b)),/EXECUTION_DELIVERY_REUSED/);
  assert.equal((await f.store.get(b.id)).status,'SUBMITTED');
});
