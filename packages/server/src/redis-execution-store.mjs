import { createHash } from 'node:crypto';
import { ExecutionStoreError, validateExecutionRecord, validateExecutionTransition, validateExecutionConstraints,
  copyExecutionValue, validExecutionId, executionWalletKey } from './execution-store.mjs';
import { createRedisRestCommand } from './redis-rest.mjs';

const fail = code => { throw new ExecutionStoreError(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const terminal = row => ['COMPLETE', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(row.status);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const normalized = (chain, value) => chain.startsWith('eip155:') ? value.toLowerCase() : value;

// Only small per-record index deltas are written. Transaction/delivery claims
// never expire; cancelled/expired orders and terminal wallet reservations release.
function claims(row) {
  const result = [], add = (kind, value) => result.push(`${kind}:${digest(value)}`);
  if (!terminal(row)) add('wallet', executionWalletKey(row));
  if (!['CANCELLED', 'EXPIRED'].includes(row.status)) {
    const relay = row.plan.actions[0]?.payload?.relay;
    const orders = [...(relay ? [relay.orderId] : []), ...(row.plan.providerRoute ? [row.plan.providerRoute.requestId,
      ...row.plan.actions.flatMap(action => action.payload.validation?.protocol?.orderId ? [action.payload.validation.protocol.orderId] : [])] : [])];
    for (const order of new Set(orders)) add('order', order);
  }
  const delivery = row.destinationReceipt ?? (row.status === 'COMPLETE' && row.receipt?.destinationCredit ? row.receipt : null);
  if (delivery) add('delivery', JSON.stringify([delivery.chainId, normalized(delivery.chainId, delivery.transactionHash)]));
  for (const submission of row.submissions) add('transaction', JSON.stringify([row.plan.source.chainId, normalized(row.plan.source.chainId, submission.hash)]));
  return result;
}

const guard = `
local function typename(key) local value=redis.call('TYPE',key); if type(value)=='table' then return value.ok else return value end end
for i=1,4 do if redis.call('PTTL',KEYS[i])>=0 then return 'EXECUTION_STORE_INTEGRITY_FAILED' end end
for i=1,3 do local kind=typename(KEYS[i]); if kind~='none' and kind~='hash' then return 'EXECUTION_STORE_INTEGRITY_FAILED' end end
local ownerKind=typename(KEYS[4]); if ownerKind~='none' and ownerKind~='set' then return 'EXECUTION_STORE_INTEGRITY_FAILED' end
local config=redis.call('HGET',KEYS[3],'config')
if config and config~=ARGV[1] then return 'EXECUTION_STORE_CONFIG_INVALID' end
if not config and (redis.call('HLEN',KEYS[1])~=0 or redis.call('HLEN',KEYS[2])~=0 or redis.call('SCARD',KEYS[4])~=0 or redis.call('HLEN',KEYS[3])~=0) then return 'EXECUTION_STORE_INTEGRITY_FAILED' end
local bytes=tonumber(redis.call('HGET',KEYS[3],'bytes') or '0')
if not bytes or bytes<0 or (config and not redis.call('HGET',KEYS[3],'bytes')) then return 'EXECUTION_STORE_INTEGRITY_FAILED' end
`;

const writeScript = guard + `
local id=ARGV[2]; local expected=ARGV[3]; local next=ARGV[4]
local old=redis.call('HGET',KEYS[1],id)
if expected=='' then if old then return 0 end else if not old or old~=expected then return 0 end end
local oldClaims=cjson.decode(ARGV[5]); local nextClaims=cjson.decode(ARGV[6])
for _,field in ipairs(oldClaims) do if redis.call('HGET',KEYS[2],field)~=id then return 'EXECUTION_STORE_INTEGRITY_FAILED' end end
local oldActive=ARGV[7]=='1'; local nextActive=ARGV[8]=='1'
if (redis.call('SISMEMBER',KEYS[4],id)==1)~=oldActive then return 'EXECUTION_STORE_INTEGRITY_FAILED' end
for _,field in ipairs(nextClaims) do
 local holder=redis.call('HGET',KEYS[2],field)
 if holder and holder~=id then
  local kind=string.match(field,'^([^:]+):')
  if kind=='wallet' then if expected=='' then return 0 else return 'EXECUTION_WALLET_RESERVED' end end
  if kind=='order' then return 'EXECUTION_ORDER_REUSED' end
  if kind=='delivery' then return 'EXECUTION_DELIVERY_REUSED' end
  return 'EXECUTION_TRANSACTION_REUSED'
 end
end
if expected=='' and redis.call('HLEN',KEYS[1])>=tonumber(ARGV[9]) then return 'EXECUTION_STORE_CAPACITY' end
local nextBytes=bytes+string.len(next)-(old and string.len(old) or 0)
if nextBytes<0 then return 'EXECUTION_STORE_INTEGRITY_FAILED' end
if nextBytes>tonumber(ARGV[10]) then return 'EXECUTION_STORE_CAPACITY' end
-- All validation and key-type checks precede mutations: Lua errors cannot roll back.
for _,field in ipairs(oldClaims) do redis.call('HDEL',KEYS[2],field) end
for _,field in ipairs(nextClaims) do redis.call('HSET',KEYS[2],field,id) end
redis.call('HSET',KEYS[1],id,next)
if nextActive then redis.call('SADD',KEYS[4],id) else redis.call('SREM',KEYS[4],id) end
redis.call('HSET',KEYS[3],'config',ARGV[1],'bytes',tostring(nextBytes))
return 1
`;
const getScript = guard + `return redis.call('HGET',KEYS[1],ARGV[2])`;
const activeScript = guard + `
local result={}
for _,id in ipairs(redis.call('SMEMBERS',KEYS[4])) do
 local row=redis.call('HGET',KEYS[1],id)
 if not row then return 'EXECUTION_STORE_INTEGRITY_FAILED' end
 table.insert(result,row)
end
return result
`;

/** Shared Redis must be durable, private, and configured without eviction/TTL.
 * All apps using a source wallet must share the same database and namespace.
 * A network-ambiguous write poisons this instance. Reopen, read durable state,
 * and recover through the normal coordinator; never re-sign/retry blindly.
 * Redis Lua atomically compares the complete previous row and updates indexes.
 */
export async function createRedisExecutionStore(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key =>
    !['url', 'token', 'command', 'namespace', 'maxRecords', 'maxRecordBytes', 'maxStoreBytes'].includes(key))) fail('EXECUTION_STORE_CONFIG_INVALID');
  const namespace = options.namespace ?? 'instinct-router-execution:v1';
  const maxRecords = options.maxRecords ?? 1000000, maxRecordBytes = options.maxRecordBytes ?? 262144, maxStoreBytes = options.maxStoreBytes ?? 1073741824;
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(namespace) ||
    !integer(maxRecords, 1, 1000000) || !integer(maxRecordBytes, 1024, 1048576) || !integer(maxStoreBytes, maxRecordBytes, 17179869184) ||
    options.command !== undefined && typeof options.command !== 'function') fail('EXECUTION_STORE_CONFIG_INVALID');
  let command;
  try { command = options.command ?? createRedisRestCommand({ url: options.url, token: options.token }); }
  catch { fail('EXECUTION_STORE_CONFIG_INVALID'); }
  const root = `{${namespace}}`, records = `${root}:records`, indexes = `${root}:claims`, meta = `${root}:meta`;
  const config = JSON.stringify({ version: 1, maxRecords, maxRecordBytes, maxStoreBytes });
  const ownerKey = owner => `${root}:owner:${digest(owner)}`;
  let poisoned = false, closed = false;
  const live = () => { if (closed || poisoned) fail(poisoned ? 'EXECUTION_STORE_POISONED' : 'EXECUTION_STORE_CLOSED'); };
  const run = async (script, owner, args, writing = false) => {
    live();
    let result;
    try { result = await command(['EVAL', script, '4', records, indexes, meta, ownerKey(owner), config, ...args.map(String)]); }
    catch { if (writing) poisoned = true; fail(writing ? 'EXECUTION_STORE_WRITE_UNCERTAIN' : 'EXECUTION_STORE_UNAVAILABLE'); }
    if (typeof result === 'string' && result.startsWith('EXECUTION_')) fail(result);
    return result;
  };
  const decode = async raw => {
    if (raw === null) return null;
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > maxRecordBytes) throw new Error();
      const row = await validateExecutionRecord(JSON.parse(raw), maxRecordBytes);
      validateExecutionConstraints([row]);
      if (JSON.stringify(row) !== raw) throw new Error();
      return row;
    } catch { fail('EXECUTION_STORE_INTEGRITY_FAILED'); }
  };
  const write = async (old, next) => {
    const result = await run(writeScript, next.ownerId, [next.id, old ? JSON.stringify(old) : '', JSON.stringify(next),
      JSON.stringify(old ? claims(old) : []), JSON.stringify(claims(next)), old && !terminal(old) ? '1' : '0',
      terminal(next) ? '0' : '1', maxRecords, maxStoreBytes], true);
    if (result !== 0 && result !== 1) { poisoned = true; fail('EXECUTION_STORE_WRITE_UNCERTAIN'); }
    return result === 1;
  };
  const get = async id => {
    live(); if (!validExecutionId(id)) fail('EXECUTION_RECORD_INVALID');
    const row = await decode(await run(getScript, '', [id]));
    if (row && row.id !== id) fail('EXECUTION_STORE_INTEGRITY_FAILED');
    return row;
  };
  return Object.freeze({
    async insert(value) {
      live(); const snapshot = copyExecutionValue(value, maxRecordBytes);
      const next = await validateExecutionRecord(snapshot, maxRecordBytes); validateExecutionConstraints([next]);
      if (next.revision !== 0 || next.status !== 'READY' || next.nextAction !== 0 || next.submissions.length) fail('EXECUTION_RECORD_INVALID');
      return write(null, next);
    },
    get,
    async findActive(ownerId) {
      live(); if (!validExecutionId(ownerId)) fail('EXECUTION_RECORD_INVALID');
      const values = await run(activeScript, ownerId, []);
      if (!Array.isArray(values) || values.length > maxRecords) fail('EXECUTION_STORE_INTEGRITY_FAILED');
      const rows = await Promise.all(values.map(decode));
      if (rows.some(row => !row || row.ownerId !== ownerId || terminal(row))) fail('EXECUTION_STORE_INTEGRITY_FAILED');
      validateExecutionConstraints(rows);
      return rows.sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    },
    async compareAndSwap(id, revision, value) {
      live(); if (!validExecutionId(id) || !integer(revision, 0, Number.MAX_SAFE_INTEGER)) fail('EXECUTION_RECORD_INVALID');
      const snapshot = copyExecutionValue(value, maxRecordBytes);
      const old = await get(id);
      if (!old || old.revision !== revision) return false;
      const next = await validateExecutionRecord(snapshot, maxRecordBytes);
      validateExecutionTransition(old, next); validateExecutionConstraints([next]);
      return write(old, next);
    },
    async close() { closed = true; },
  });
}
