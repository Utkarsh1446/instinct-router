/** Single-host durable execution state. The filesystem owner is trusted.
 * A crashed/uncertain writer leaves its lock for explicit operator recovery.
 * This component has no wallet, HTTP, signing or broadcasting capability. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { reviewHash, validateRequest, sameAsset, rawAmount, validateDestinationReceipt, validateProviderManagedPlan, isConfirmedBaseUsdcApprovalPrefix, executionHash, isRecoverableUnsubmittedSolanaClaim, validateSolanaClaimExpiryEvidence } from '@instinct/router-core';

export class ExecutionStoreError extends Error {
  constructor(code) { super(code); this.name = 'ExecutionStoreError'; this.code = code; }
}
const fail = code => { throw new ExecutionStoreError(code); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const chain = value => typeof value === 'string' && /^[a-z0-9-]{3,8}:[A-Za-z0-9_-]{1,64}$/.test(value) &&
  (!value.startsWith('eip155:') || /^[1-9][0-9]*$/.test(value.slice(7)));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
const canon = value => JSON.stringify(value);
const normalizedHash = (chainId, value) => chainId.startsWith('eip155:') ? value.toLowerCase() : value;
const walletKey = row => canon([row.plan.source.chainId, normalizedHash(row.plan.source.chainId, row.request.sender)]);

// Shared by the file and Redis adapters so durable backends enforce identical
// record, transition, and within-record replay invariants.
export { record as validateExecutionRecord, transition as validateExecutionTransition,
  constraints as validateExecutionConstraints, copy as copyExecutionValue,
  validId as validExecutionId, walletKey as executionWalletKey };

/** Copy without invoking getters or accepting hidden/non-JSON state. */
function copy(value, byteLimit, nodeLimit = 20000) {
  let nodes = 0, bytes = 0;
  const visit = (item, depth) => {
    if (++nodes > nodeLimit || depth > 32) fail('EXECUTION_RECORD_LIMIT');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item); if (bytes > byteLimit) fail('EXECUTION_RECORD_LIMIT'); return item;
    }
    if (!item || typeof item !== 'object' || Object.getOwnPropertySymbols(item).length ||
        ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item))) fail('EXECUTION_RECORD_INVALID');
    if (Array.isArray(item)) {
      if (item.length > nodeLimit - nodes) fail('EXECUTION_RECORD_LIMIT');
      if (Object.keys(item).length !== item.length || Object.getOwnPropertyNames(item).length !== item.length + 1) fail('EXECUTION_RECORD_INVALID');
      const result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!Object.hasOwn(descriptor ?? {}, 'value')) fail('EXECUTION_RECORD_INVALID');
        result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    const result = {};
    if (Object.getOwnPropertyNames(item).length !== Object.keys(item).length) fail('EXECUTION_RECORD_INVALID');
    for (const key of Object.keys(item).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(descriptor ?? {}, 'value')) fail('EXECUTION_RECORD_INVALID');
      bytes += Buffer.byteLength(key); if (bytes > byteLimit) fail('EXECUTION_RECORD_LIMIT');
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(canon(result)) > byteLimit) fail('EXECUTION_RECORD_LIMIT');
  return result;
}
function asset(value) {
  if (!exact(value, ['chainId', 'address', 'decimals']) || !chain(value.chainId) || !text(value.address) ||
      !integer(value.decimals, 0, 255)) fail('EXECUTION_RECORD_INVALID');
  if (value.chainId.startsWith('eip155:') && !/^0x[0-9a-fA-F]{40}$/.test(value.address)) fail('EXECUTION_RECORD_INVALID');
}
function transactionHash(chainId, value) {
  if (!executionHash(chainId, value, 'transaction')) fail('EXECUTION_RECORD_INVALID');
}
async function record(value, limit) {
  const row = copy(value, limit);
  if (Object.keys(row).some(key => !['id', 'ownerId', 'revision', 'status', 'reviewHash', 'request', 'plan', 'nextAction', 'claimedActionId', 'submissions', 'timeline', 'receipt', 'destinationReceipt', 'unsubmittedExpiry'].includes(key)) || !['id', 'ownerId', 'revision', 'status', 'reviewHash', 'request', 'plan', 'nextAction', 'claimedActionId', 'submissions'].every(key => Object.hasOwn(row, key)) ||
      !validId(row.id) || !validId(row.ownerId) || !integer(row.revision, 0, Number.MAX_SAFE_INTEGER) ||
      !['READY', 'CLAIMED', 'SUBMITTED', 'COMPLETE', 'RECOVERY_REQUIRED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(row.status) ||
      typeof row.reviewHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.reviewHash)) fail('EXECUTION_RECORD_INVALID');
  try {
    const request = validateRequest(row.request, 0), plan = row.plan;
    if (canon(copy(request, limit)) !== canon(row.request) || !request.nativeFeeBudgets?.length ||
        !exact(plan, ['routeId', 'quoteIds', 'source', 'destination', 'sender', 'recipient', 'amountRaw', 'minimumOutRaw', 'expiresAtMs', 'nativeCosts', 'actions', ...(plan.providerRoute === undefined ? [] : ['providerRoute'])]) ||
        typeof plan.routeId !== 'string' || !plan.routeId.length || plan.routeId.length > 512 ||
        !Array.isArray(plan.quoteIds) || !plan.quoteIds.length || plan.quoteIds.length > 8 ||
        plan.quoteIds.some(id => typeof id !== 'string' || !id.length || id.length > 512) ||
        !integer(plan.expiresAtMs, 1, request.deadlineMs)) fail('EXECUTION_RECORD_INVALID');
    asset(plan.source); asset(plan.destination); rawAmount(plan.amountRaw, true); rawAmount(plan.minimumOutRaw, true);
    if (!sameAsset(plan.source, request.source) || !sameAsset(plan.destination, request.destination) ||
        plan.sender !== request.sender || plan.recipient !== request.recipient || plan.amountRaw !== request.amountRaw ||
        !Array.isArray(plan.nativeCosts) || plan.nativeCosts.length > 16) fail('EXECUTION_RECORD_INVALID');
    const costs = new Map();
    for (const cost of plan.nativeCosts) {
      if (!exact(cost, ['chainId', 'amountRaw']) || !chain(cost.chainId)) fail('EXECUTION_RECORD_INVALID');
      costs.set(cost.chainId, (costs.get(cost.chainId) ?? 0n) + BigInt(rawAmount(cost.amountRaw)));
    }
    for (const [id, amount] of costs) {
      const cap = request.nativeFeeBudgets.find(cap => cap.chainId === id);
      if (!cap || cap.maxAmountRaw !== null && amount > BigInt(cap.maxAmountRaw)) fail('EXECUTION_RECORD_INVALID');
    }
    if (!Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > 8 ||
        new Set(plan.actions.map(action => action.id)).size !== plan.actions.length) fail('EXECUTION_RECORD_INVALID');
    for (const action of plan.actions) if (!exact(action, ['id', 'chainId', 'payload']) || !validId(action.id) ||
        action.chainId !== plan.source.chainId || !action.payload || Array.isArray(action.payload) || typeof action.payload !== 'object')
      fail('EXECUTION_RECORD_INVALID');
    validateProviderManagedPlan(plan);
    if (!integer(row.nextAction, 0, plan.actions.length) || !Array.isArray(row.submissions) || row.submissions.length > plan.actions.length)
      fail('EXECUTION_RECORD_INVALID');
    for (let i = 0; i < row.submissions.length; i++) {
      const submission = row.submissions[i];
      if (!exact(submission, ['actionId', 'hash']) || submission.actionId !== plan.actions[i].id) fail('EXECUTION_RECORD_INVALID');
      transactionHash(plan.actions[i].chainId, submission.hash);
    }
    const current = plan.actions[row.nextAction]?.id, count = row.submissions.length;
    const stateValid = ['CANCELLED', 'EXPIRED'].includes(row.status) ? (row.nextAction === 0 && count === 0 && row.claimedActionId === null || isConfirmedBaseUsdcApprovalPrefix(row)) : row.status === 'COMPLETE' ? row.nextAction === plan.actions.length && count === row.nextAction && row.claimedActionId === null
      : row.status === 'FAILED' ? row.nextAction < plan.actions.length && count === row.nextAction + 1 && row.claimedActionId === current
      : row.nextAction < plan.actions.length && (row.status === 'READY' ? row.claimedActionId === null && count === row.nextAction
        : row.status === 'CLAIMED' ? row.claimedActionId === current && count === row.nextAction
          : row.status === 'SUBMITTED' ? row.claimedActionId === current && count === row.nextAction + 1
            : row.claimedActionId === null && count === row.nextAction || row.claimedActionId === current &&
              [row.nextAction, row.nextAction + 1].includes(count));
    if (row.timeline !== undefined) {
      const timing = row.timeline, fields = ['preparedAtMs', 'claimedAtMs', 'submittedAtMs', 'completedAtMs', 'failedAtMs'];
      if (!timing || Array.isArray(timing) || Object.keys(timing).some(key => !fields.includes(key)) ||
        !integer(timing.preparedAtMs, 0, Number.MAX_SAFE_INTEGER) || Object.values(timing).some(value => !integer(value, timing.preparedAtMs, Number.MAX_SAFE_INTEGER)) ||
        timing.claimedAtMs !== undefined && timing.submittedAtMs !== undefined && timing.claimedAtMs > timing.submittedAtMs ||
        timing.completedAtMs !== undefined && row.status !== 'COMPLETE' || timing.failedAtMs !== undefined && row.status !== 'FAILED') fail('EXECUTION_RECORD_INVALID');
    }
    if (row.receipt !== undefined) {
      const receipt = row.receipt, keys = ['chainId', 'transactionHash', 'blockNumberRaw', 'blockHash', 'observedAtMs', 'confirmations'];
      if (!['COMPLETE', 'FAILED'].includes(row.status) || !receipt || Array.isArray(receipt) ||
          keys.some(key => !Object.hasOwn(receipt, key)) || Object.keys(receipt).some(key => ![...keys, 'destinationCredit', 'actualNativeFeeRaw'].includes(key)) ||
          receipt.chainId !== plan.source.chainId || normalizedHash(receipt.chainId, receipt.transactionHash) !== normalizedHash(receipt.chainId, row.submissions.at(-1)?.hash) ||
          typeof receipt.blockNumberRaw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(receipt.blockNumberRaw) || !text(receipt.blockHash) ||
          !executionHash(receipt.chainId, receipt.blockHash, 'block') ||
          !integer(receipt.observedAtMs, 0, Number.MAX_SAFE_INTEGER) || !integer(receipt.confirmations, 1, Number.MAX_SAFE_INTEGER)) fail('EXECUTION_RECORD_INVALID');
      transactionHash(receipt.chainId, receipt.transactionHash);
      if (plan.providerRoute && receipt.confirmations < plan.providerRoute.sourceConfirmations) fail('EXECUTION_RECORD_INVALID');
      if (receipt.actualNativeFeeRaw !== undefined) rawAmount(receipt.actualNativeFeeRaw);
      if (row.status === 'FAILED' && receipt.destinationCredit !== undefined) fail('EXECUTION_RECORD_INVALID');
      if (row.status === 'COMPLETE' && plan.source.chainId === plan.destination.chainId && row.destinationReceipt === undefined) {
        const credit = receipt.destinationCredit;
        if (!exact(credit, ['asset', 'recipient', 'amountRaw']) || !sameAsset(credit.asset, plan.destination) || credit.recipient !== plan.recipient ||
          BigInt(rawAmount(credit.amountRaw, true)) < BigInt(plan.minimumOutRaw)) fail('EXECUTION_RECORD_INVALID');
        asset(credit.asset);
      }
    }
    if (row.destinationReceipt !== undefined && (row.status !== 'COMPLETE' || plan.source.chainId === plan.destination.chainId && !plan.providerRoute)) fail('EXECUTION_RECORD_INVALID');
    if (row.status === 'COMPLETE' && (plan.source.chainId !== plan.destination.chainId || row.destinationReceipt !== undefined)) validateDestinationReceipt(row.destinationReceipt,plan,row.receipt);
    if (row.status === 'COMPLETE' && plan.providerRoute && !row.receipt) fail('EXECUTION_RECORD_INVALID');
    if (row.status === 'FAILED' && row.receipt === undefined) fail('EXECUTION_RECORD_INVALID');
    if (row.unsubmittedExpiry !== undefined) {
      if(row.status!=='EXPIRED'||row.nextAction!==0||row.claimedActionId!==null||row.submissions.length) fail('EXECUTION_RECORD_INVALID');
      validateSolanaClaimExpiryEvidence(row,row.unsubmittedExpiry);
    }
    if (!stateValid || await reviewHash({ request: row.request, plan }) !== row.reviewHash) fail('EXECUTION_RECORD_INVALID');
  } catch (error) { if (error instanceof ExecutionStoreError) throw error; fail('EXECUTION_RECORD_INVALID'); }
  return row;
}
function transition(old, next) {
  if (old.id !== next.id || old.ownerId !== next.ownerId || old.reviewHash !== next.reviewHash ||
      canon(old.request) !== canon(next.request) || canon(old.plan) !== canon(next.plan) || next.revision !== old.revision + 1)
    fail('EXECUTION_TRANSITION_INVALID');
  if (old.receipt !== undefined && canon(old.receipt) !== canon(next.receipt)) fail('EXECUTION_TRANSITION_INVALID');
  if (old.destinationReceipt !== undefined && canon(old.destinationReceipt) !== canon(next.destinationReceipt)) fail('EXECUTION_TRANSITION_INVALID');
  if (old.timeline !== undefined && (next.timeline === undefined || Object.keys(old.timeline).some(key => next.timeline[key] !== old.timeline[key]))) fail('EXECUTION_TRANSITION_INVALID');
  if (next.timeline !== undefined) {
    const allowed = { CLAIMED: 'claimedAtMs', SUBMITTED: 'submittedAtMs', COMPLETE: 'completedAtMs', FAILED: 'failedAtMs' }[next.status];
    if (Object.keys(next.timeline).some(key => old.timeline?.[key] === undefined && key !== allowed && key !== 'preparedAtMs')) fail('EXECUTION_TRANSITION_INVALID');
  }
  if(old.unsubmittedExpiry!==undefined&&canon(old.unsubmittedExpiry)!==canon(next.unsubmittedExpiry)) fail('EXECUTION_TRANSITION_INVALID');
  const recovered=isRecoverableUnsubmittedSolanaClaim(old)&&next.status==='EXPIRED'&&next.claimedActionId===null&&next.nextAction===0&&next.submissions.length===0&&old.plan.expiresAtMs<=Date.now()&&next.unsubmittedExpiry!==undefined;
  if(recovered) validateSolanaClaimExpiryEvidence(next,next.unsubmittedExpiry,Date.now(),true);
  if(old.unsubmittedExpiry===undefined&&next.unsubmittedExpiry!==undefined&&!recovered) fail('EXECUTION_TRANSITION_INVALID');
  const unchanged = canon(old.submissions) === canon(next.submissions), same = old.nextAction === next.nextAction;
  const appended = next.submissions.length === old.submissions.length + 1 &&
    canon(next.submissions.slice(0, -1)) === canon(old.submissions);
  const claim = old.status === 'READY' && next.status === 'CLAIMED' && same && unchanged;
  const submit = ['CLAIMED', 'RECOVERY_REQUIRED'].includes(old.status) && old.claimedActionId !== null &&
    old.submissions.length === old.nextAction && next.status === 'SUBMITTED' && same && appended && next.claimedActionId === old.claimedActionId;
  const uncertain = ['CLAIMED', 'SUBMITTED', 'RECOVERY_REQUIRED'].includes(old.status) && next.status === 'RECOVERY_REQUIRED' &&
    same && unchanged && next.claimedActionId === old.claimedActionId;
  const advance = ['SUBMITTED', 'RECOVERY_REQUIRED'].includes(old.status) && old.claimedActionId !== null &&
    old.submissions.length === old.nextAction + 1 && unchanged && next.nextAction === old.nextAction + 1 &&
    next.claimedActionId === null && (next.nextAction === next.plan.actions.length ? next.status === 'COMPLETE'
      : ['READY', 'RECOVERY_REQUIRED'].includes(next.status));
  const abandon = old.status === 'READY' && (old.nextAction === 0 && old.submissions.length === 0 || isConfirmedBaseUsdcApprovalPrefix(old)) && old.claimedActionId === null &&
    ['CANCELLED', 'EXPIRED'].includes(next.status) && same && unchanged && next.claimedActionId === null &&
    (next.status !== 'EXPIRED' || old.plan.expiresAtMs <= Date.now());
  const failed = ['SUBMITTED', 'RECOVERY_REQUIRED'].includes(old.status) && old.claimedActionId !== null && old.submissions.length === old.nextAction + 1 &&
    next.status === 'FAILED' && same && unchanged && next.claimedActionId === old.claimedActionId && next.receipt !== undefined;
  if (!claim && !submit && !uncertain && !advance && !abandon && !failed && !recovered) fail('EXECUTION_TRANSITION_INVALID');
}
function constraints(rows) {
  const ids = new Set(), wallets = new Set(), transactions = new Set(), deliveries = new Set(), relayOrders = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) fail('EXECUTION_STATE_INVALID'); ids.add(row.id);
    const wallet = walletKey(row);
    if (!['COMPLETE', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(row.status)) { if (wallets.has(wallet)) fail('EXECUTION_WALLET_RESERVED'); wallets.add(wallet); }
    const relay = row.plan.actions[0]?.payload?.relay;
    if (!['CANCELLED','EXPIRED'].includes(row.status)) {
      const orderIds = [...(relay ? [relay.orderId] : []), ...(row.plan.providerRoute ? [row.plan.providerRoute.requestId,
        ...row.plan.actions.flatMap(action => action.payload.validation?.protocol?.orderId ? [action.payload.validation.protocol.orderId] : [])] : [])];
      for (const key of new Set(orderIds)) {
        if (typeof key !== 'string' || !/^0x[0-9a-f]{64}$/.test(key) || relayOrders.has(key)) fail('EXECUTION_ORDER_REUSED');
        relayOrders.add(key);
      }
    }
    // Atomic same-chain credit is a delivery too. It cannot later be recycled
    // as a separate provider-associated payout, including across verification modes.
    const delivery = row.destinationReceipt ?? (row.status === 'COMPLETE' && row.receipt?.destinationCredit ? row.receipt : null);
    if (delivery) {
      const key = canon([delivery.chainId,normalizedHash(delivery.chainId,delivery.transactionHash)]);
      if (deliveries.has(key)) fail('EXECUTION_DELIVERY_REUSED'); deliveries.add(key);
    }
    for (const submission of row.submissions) {
      const key = canon([row.plan.source.chainId, normalizedHash(row.plan.source.chainId, submission.hash)]);
      if (transactions.has(key)) fail('EXECUTION_TRANSACTION_REUSED'); transactions.add(key);
    }
  }
}
const privateStat = (stat, directory = false) => stat.uid === process.getuid() && (stat.mode & 0o777) === (directory ? 0o700 : 0o600) &&
  (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
async function ancestors(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('EXECUTION_STORE_UNSAFE_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}

/** Local POSIX filesystem only. Call close() to release a healthy writer lock.
 * No stale lock eviction, record eviction, re-signing, or automatic retry occurs. */
export async function createFileExecutionStore(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !['directory', 'maxRecords', 'maxRecordBytes', 'maxStoreBytes'].includes(key)) ||
      typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || options.directory.length > 4096 ||
      options.directory.includes('\0') || typeof process.getuid !== 'function') fail('EXECUTION_STORE_CONFIG_INVALID');
  const directory = path.resolve(options.directory);
  if (directory === path.parse(directory).root) fail('EXECUTION_STORE_CONFIG_INVALID');
  const maxRecords = options.maxRecords ?? 1000, maxRecordBytes = options.maxRecordBytes ?? 262144, maxStoreBytes = options.maxStoreBytes ?? 16777216;
  if (!integer(maxRecords, 1, 10000) || !integer(maxRecordBytes, 1024, 1048576) ||
      !integer(maxStoreBytes, maxRecordBytes, 67108864)) fail('EXECUTION_STORE_CONFIG_INVALID');
  let dir, lock, locked = false, poisoned = false, closed = false, closing = false;
  const lockPath = path.join(directory, 'writer.lock'), statePath = path.join(directory, 'state.json');
  const markerPath = path.join(directory, 'FORMAT'), marker = 'instinct-router-execution/v1';
  const lockText = canon({ pid: process.pid, token: randomBytes(24).toString('hex'), version: 1 });
  let directoryStat, lockStat, rows = [], generation = 0, disk = '', tail = Promise.resolve(), closeWork;
  const snapshotNodes = Math.min(maxRecords * 20000 + 10, 1000000);
  const live = () => { if (closed || poisoned) fail(poisoned ? 'EXECUTION_STORE_POISONED' : 'EXECUTION_STORE_CLOSED'); };
  const read = async (file, limit) => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!privateStat(stat) || stat.size > limit) fail('EXECUTION_STORE_INTEGRITY_FAILED');
      const buffer = Buffer.alloc(stat.size + 1); let size = 0;
      while (size < buffer.length) {
        const part = await handle.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead;
      }
      if (size !== stat.size || (await handle.stat()).size !== stat.size) fail('EXECUTION_STORE_INTEGRITY_FAILED');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } finally { await handle.close(); }
  };
  const guard = async (checkDisk = true) => {
    try {
      await ancestors(directory);
      const current = await fs.lstat(directory), holder = await fs.lstat(lockPath);
      if (!privateStat(current, true) || current.dev !== directoryStat.dev || current.ino !== directoryStat.ino ||
          !privateStat(holder) || holder.dev !== lockStat.dev || holder.ino !== lockStat.ino ||
          await read(lockPath, 512) !== lockText || await read(markerPath, 64) !== marker ||
          checkDisk && await read(statePath, maxStoreBytes) !== disk) fail('EXECUTION_STORE_INTEGRITY_FAILED');
    } catch { poisoned = true; fail('EXECUTION_STORE_INTEGRITY_FAILED'); }
  };
  const encoded = (values, version) => {
    const body = copy({ generation: version, records: values, version: 1 }, maxStoreBytes, snapshotNodes);
    const result = canon(copy({ ...body, sha256: hash(canon(body)) }, maxStoreBytes, snapshotNodes));
    if (Buffer.byteLength(result) > maxStoreBytes) fail('EXECUTION_STORE_CAPACITY'); return result;
  };
  const commit = async (values, version, initial = false) => {
    const nextDisk = encoded(values, version); if (!initial) await guard();
    let temporary;
    try {
      const filename = path.join(directory, '.snapshot-' + randomBytes(16).toString('hex') + '.tmp');
      temporary = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (!privateStat(await temporary.stat())) fail('EXECUTION_STORE_UNSAFE_PATH');
      await temporary.writeFile(nextDisk); await temporary.sync(); await temporary.close(); temporary = null;
      await fs.rename(filename, statePath); await dir.sync();
      rows = values; generation = version; disk = nextDisk;
    } catch { poisoned = true; fail('EXECUTION_STORE_WRITE_UNCERTAIN'); }
    finally { if (temporary) await temporary.close().catch(() => {}); }
  };
  const enqueue = operation => {
    if (closing) return Promise.reject(new ExecutionStoreError('EXECUTION_STORE_CLOSED'));
    const work = tail.then(async () => { live(); return operation(); });
    tail = work.catch(() => {}); return work;
  };
  try {
    await ancestors(directory);
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    directoryStat = await fs.lstat(directory);
    if (!privateStat(directoryStat, true)) fail('EXECUTION_STORE_UNSAFE_PATH');
    dir = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('EXECUTION_WRITER_LOCKED'); throw error; }
    locked = true; lockStat = await lock.stat();
    if (!privateStat(lockStat)) fail('EXECUTION_STORE_UNSAFE_PATH');
    await lock.writeFile(lockText); await lock.sync(); await dir.sync();
    const names = await fs.readdir(directory);
    for (const name of names) {
      if (!['writer.lock', 'state.json', 'FORMAT'].includes(name) && !/^\.snapshot-[0-9a-f]{32}\.tmp$/.test(name)) fail('EXECUTION_STORE_INTEGRITY_FAILED');
      if (!privateStat(await fs.lstat(path.join(directory, name)))) fail('EXECUTION_STORE_INTEGRITY_FAILED');
    }
    if (!names.includes('FORMAT')) {
      if (names.length !== 1) fail('EXECUTION_STORE_INTEGRITY_FAILED');
      const format = await fs.open(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await format.writeFile(marker); await format.sync(); } finally { await format.close(); }
      await dir.sync(); await commit([], 0, true);
    } else {
      if (await read(markerPath, 64) !== marker) fail('EXECUTION_STORE_INTEGRITY_FAILED');
      disk = await read(statePath, maxStoreBytes);
      const parsed = JSON.parse(disk), canonical = copy(parsed, maxStoreBytes, snapshotNodes);
      if (canon(canonical) !== disk || !exact(parsed, ['version', 'generation', 'records', 'sha256']) || parsed.version !== 1 ||
          !integer(parsed.generation, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(parsed.records) || parsed.records.length > maxRecords ||
          parsed.sha256 !== hash(canon(copy({ version: 1, generation: parsed.generation, records: parsed.records }, maxStoreBytes, snapshotNodes))))
        fail('EXECUTION_STORE_INTEGRITY_FAILED');
      for (let offset = 0; offset < parsed.records.length; offset += 16)
        rows.push(...await Promise.all(parsed.records.slice(offset, offset + 16).map(value => record(value, maxRecordBytes))));
      generation = parsed.generation;
      constraints(rows); await guard();
    }
  } catch (error) {
    await lock?.close().catch(() => {}); await dir?.close().catch(() => {});
    // Never delete an acquired lock after uncertain initialization or corrupt state.
    if (error instanceof ExecutionStoreError) throw error;
    fail(locked ? 'EXECUTION_STORE_INTEGRITY_FAILED' : 'EXECUTION_STORE_UNAVAILABLE');
  }
  return Object.freeze({
    async insert(value) {
      const snapshot = copy(value, maxRecordBytes);
      return enqueue(async () => {
        const next = await record(snapshot, maxRecordBytes); await guard();
        if (next.revision !== 0 || next.status !== 'READY' || next.nextAction !== 0 || next.submissions.length) fail('EXECUTION_RECORD_INVALID');
        if (rows.some(row => row.id === next.id || !['COMPLETE', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(row.status) && walletKey(row) === walletKey(next))) return false;
        if (rows.length >= maxRecords) fail('EXECUTION_STORE_CAPACITY');
        const updated = [...rows, next].sort((a, b) => a.id.localeCompare(b.id)); constraints(updated);
        await commit(updated, generation + 1); return true;
      });
    },
    findActive(ownerId) {
      if (!validId(ownerId)) return Promise.reject(new ExecutionStoreError('EXECUTION_RECORD_INVALID'));
      return enqueue(async () => { await guard(); return structuredClone(rows.find(row => row.ownerId === ownerId && !['COMPLETE', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(row.status)) ?? null); });
    },
    get(id) {
      if (!validId(id)) return Promise.reject(new ExecutionStoreError('EXECUTION_RECORD_INVALID'));
      return enqueue(async () => { await guard(); return structuredClone(rows.find(row => row.id === id) ?? null); });
    },
    async compareAndSwap(id, revision, value) {
      if (!validId(id) || !integer(revision, 0, Number.MAX_SAFE_INTEGER)) fail('EXECUTION_RECORD_INVALID');
      const snapshot = copy(value, maxRecordBytes);
      return enqueue(async () => {
        await guard(); const old = rows.find(row => row.id === id);
        if (!old || old.revision !== revision) return false;
        const next = await record(snapshot, maxRecordBytes); transition(old, next);
        const updated = rows.map(row => row.id === id ? next : row); constraints(updated);
        await commit(updated, generation + 1); return true;
      });
    },
    close() {
      if (closeWork) return closeWork; closing = true;
      closeWork = (async () => {
        await tail;
        try {
          live(); await guard(); await lock.close(); lock = null;
          await fs.unlink(lockPath); await dir.sync();
        } finally { closed = true; await lock?.close().catch(() => {}); await dir.close().catch(() => {}); }
      })();
      return closeWork;
    },
  });
}
