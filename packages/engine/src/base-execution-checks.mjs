/** Fixed-terms Base swap preflight. No key, signature, send, state override or repricing. */
import { createHash } from 'node:crypto';
import { BASE_V3 } from '@instinct/router-core';
import { BaseReadinessError, baseExecutionPrimitives as p } from './base-readiness.mjs';
const word = value => (typeof value === 'string' && value.startsWith('0x') ? value.slice(2) : BigInt(value).toString(16)).padStart(64, '0');
const hex = value => '0x' + value.toString(16);
const HASH = /^[a-f0-9]{64}$/, ADDRESS = /^0x[a-f0-9]{40}$/;
export class ExecutionEngineError extends Error {
  constructor(code, status = 409) { super(code); this.name = 'ExecutionEngineError'; this.code = code; this.status = status; }
}
export const fail = code => { throw new ExecutionEngineError(code); };
/** Preserve only validated numeric economics for the host's public limit error.
 * Never attach provider responses, URLs, calldata or credentials. */
export function enforceEconomicLimits(request, feeBps, priceImpactBps) {
  const limits = { feeBps, priceImpactBps, maxFeeBps: request.maxFeeBps, maxPriceImpactBps: request.maxPriceImpactBps };
  if (Object.entries(limits).some(([key, value]) => !(key === 'maxFeeBps' && value === null) &&
    (!Number.isSafeInteger(value) || value < 0))) fail('EXECUTION_ECONOMIC_LIMIT');
  if ((request.maxFeeBps !== null && feeBps > request.maxFeeBps) || priceImpactBps > request.maxPriceImpactBps) {
    const error = new ExecutionEngineError('EXECUTION_ECONOMIC_LIMIT');
    error.economicLimits = Object.freeze(limits);
    throw error;
  }
}
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const uint = value => p.quantity(value);
const result = row => p.result(row);
const call = (to, data, block) => p.call(to, data, block);
const codeHash = value => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2}){100,32768}$/.test(value)) fail('EXECUTION_CODE_MISMATCH');
  return createHash('sha256').update(Buffer.from(value.slice(2), 'hex')).digest('hex');
};
const addressWord = value => {
  const raw = p.integerWord(value); if (raw >= 1n << 160n || raw === 0n) fail('EXECUTION_IDENTITY_MISMATCH');
  return hex(raw).slice(0, 2) + raw.toString(16).padStart(40, '0');
};
function pinsFor(input) {
  if (!plain(input)) fail('EXECUTION_PINS_REQUIRED');
  const contracts = [[p.ROUTER, { codeSha256: p.ROUTER_SHA256 }], [BASE_V3.weth, input.weth],
    [BASE_V3.usdc, input.usdc], [p.ORACLE, input.oracle], [BASE_V3.factory, input.factory]];
  for (const [address, pin] of contracts) {
    if (!plain(pin) || !HASH.test(pin.codeSha256)) fail('EXECUTION_PINS_REQUIRED');
    if (pin.implementation !== undefined) {
      const impl = pin.implementation;
      if (!plain(impl) || !/^0x[0-9a-f]{64}$/.test(impl.slot) || !ADDRESS.test(impl.address) ||
        BigInt(impl.address) <= 2n || !HASH.test(impl.codeSha256)) fail('EXECUTION_PINS_REQUIRED');
    }
    if ([BASE_V3.usdc, p.ORACLE].includes(address) && !pin.implementation) fail('EXECUTION_PINS_REQUIRED');
  }
  return structuredClone(contracts);
}
export function swapTerms(plan, action) {
  if (!plain(plan) || !plain(action) || action.chainId !== BASE_V3.chainId || action.id !== 'base-uniswap-swap' ||
    action.payload?.type !== 'EVM_TRANSACTION' || !plain(action.payload.transaction)) fail('EXECUTION_BINDING_MISMATCH');
  const request = p.validate({ source: plan.source, destination: plan.destination, amountRaw: plan.amountRaw,
    sender: plan.sender, recipient: plan.recipient, slippageBps: 0 });
  const match = /^base-v3:([0-9]+):(0x[0-9a-f]{40}):([0-9]+)$/.exec(plan.quoteIds?.[0] ?? '');
  if (!match || plan.quoteIds.length !== 1 || ![100, 200, 300, 400, 500, 3000, 10000].includes(Number(match[1])) ||
    BigInt(match[2]) <= 2n || !Number.isSafeInteger(plan.expiresAtMs) || plan.expiresAtMs < 0) fail('EXECUTION_BINDING_MISMATCH');
  if (typeof plan.minimumOutRaw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(plan.minimumOutRaw) || BigInt(plan.minimumOutRaw) >= 1n << 256n)
    fail('EXECUTION_BINDING_MISMATCH');
  const tx = action.payload.transaction, deadlineSeconds = Math.floor(plan.expiresAtMs / 1000);
  if (tx.chainId !== '0x2105' || tx.type !== '0x2' || tx.from !== request.sender || tx.to !== p.ROUTER ||
    tx.value !== hex(BigInt(request.amountRaw)) || !Array.isArray(tx.accessList) || tx.accessList.length ||
    tx.data !== p.transactionData(request, { poolFeePips: Number(match[1]), minimumOutRaw: plan.minimumOutRaw }, deadlineSeconds) ||
    Object.keys(tx).some(key => !['chainId', 'type', 'from', 'to', 'value', 'data', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList'].includes(key)))
    fail('EXECUTION_BINDING_MISMATCH');
  const gas = uint(tx.gas), maxFee = uint(tx.maxFeePerGas), priority = uint(tx.maxPriorityFeePerGas);
  if (gas < 21000n || gas > p.MAX_GAS || maxFee === 0n || maxFee > p.MAX_FEE || priority > maxFee) fail('EXECUTION_FEE_BOUND');
  const nativeCap = plan.nativeCosts?.find(cost => cost.chainId === BASE_V3.chainId)?.amountRaw;
  if (typeof nativeCap !== 'string' || !/^[1-9][0-9]{0,77}$/.test(nativeCap)) fail('EXECUTION_FEE_BOUND');
  return { request, tx: structuredClone(tx), pool: match[2], poolFeePips: Number(match[1]), deadlineSeconds,
    minimum: BigInt(plan.minimumOutRaw), gas, maxFee, priority, nativeCap: BigInt(nativeCap) };
}
export function createBaseExecutionChecks({ fetch: wire = globalThis.fetch, now = Date.now, pins } = {}) {
  if (typeof wire !== 'function' || typeof now !== 'function') fail('INVALID_EXECUTION_CONFIG');
  let serial = 0, active = 0;
  const contracts = () => pinsFor(pins);
  async function runBound(operation, signal = new AbortController().signal) {
    if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') fail('INVALID_EXECUTION_INPUT');
    if (signal.aborted) fail('EXECUTION_CANCELLED'); if (active >= 4) fail('EXECUTION_BUSY'); active++;
    const controller = new AbortController(), cutoff = performance.now() + 8000;
    let reject;
    const stopped = new Promise((_, no) => { reject = no; });
    const stop = code => { controller.abort(); reject(new ExecutionEngineError(code)); };
    const cancel = () => stop('EXECUTION_CANCELLED'); signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('EXECUTION_TIMEOUT'), 8000);
    const work = Promise.resolve().then(() => operation(controller.signal)).then(value => {
      if (controller.signal.aborted || performance.now() >= cutoff) fail('EXECUTION_TIMEOUT'); return value;
    }).finally(() => { active--; });
    try { return await Promise.race([work, stopped]); }
    catch (error) {
      if (error instanceof ExecutionEngineError) throw error;
      if (['READINESS_RPC_BUSY', 'READINESS_RPC_TRANSPORT_UNAVAILABLE', 'READINESS_RPC_HISTORY_UNAVAILABLE'].includes(error?.code)) fail(error.code);
      const unavailable = new ExecutionEngineError('EXECUTION_EVIDENCE_UNAVAILABLE');
      if (error instanceof BaseReadinessError && /^READINESS_[A-Z_]+$/.test(error.code)) unavailable.evidenceCode = error.code;
      throw unavailable;
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  const read = async (calls, signal) => (await p.rpc(wire, calls, signal, ++serial)).map(result);
  async function identities(block, sender, pool, fee, signal) {
    const list = contracts(), calls = list.flatMap(([address, pin]) => [{ method: 'eth_getCode', params: [address, block] },
      ...(pin.implementation ? [{ method: 'eth_getStorageAt', params: [address, pin.implementation.slot, block] },
        { method: 'eth_getCode', params: [pin.implementation.address, block] }] : [])]);
    calls.push({ method: 'eth_getCode', params: [sender, block] },
      call(p.ROUTER, '0xc45a0155', block), call(p.ROUTER, '0x4aa4a4fc', block),
      call(BASE_V3.factory, '0x1698ee82' + word(BASE_V3.weth) + word(BASE_V3.usdc) + word(fee), block),
      call(BASE_V3.weth, '0x313ce567', block), call(BASE_V3.usdc, '0x313ce567', block),
      call(pool, '0xc45a0155', block), call(pool, '0x0dfe1681', block), call(pool, '0xd21220a7', block), call(pool, '0xddca3f43', block));
    const values = await read(calls, signal); let index = 0;
    for (const [_address, pin] of list) {
      if (codeHash(values[index++]) !== pin.codeSha256) fail('EXECUTION_CODE_MISMATCH');
      if (pin.implementation && (addressWord(values[index++]) !== pin.implementation.address || codeHash(values[index++]) !== pin.implementation.codeSha256))
        fail('EXECUTION_IMPLEMENTATION_MISMATCH');
    }
    const tail = values.slice(index);
    if (tail[0] !== '0x') fail('EXECUTION_WALLET_UNSUPPORTED');
    const expected = [BASE_V3.factory, BASE_V3.weth, pool];
    expected.forEach((address, i) => { if (addressWord(tail[i + 1]) !== address) fail('EXECUTION_IDENTITY_MISMATCH'); });
    if (p.integerWord(tail[4]) !== 18n || p.integerWord(tail[5]) !== 6n || addressWord(tail[6]) !== BASE_V3.factory ||
      addressWord(tail[7]) !== BASE_V3.weth || addressWord(tail[8]) !== BASE_V3.usdc || p.integerWord(tail[9]) !== BigInt(fee))
      fail('EXECUTION_IDENTITY_MISMATCH');
  }
  return { validatePins: contracts, runBound, read, identities,
    async preflight(plan, action, signal) {
      plan = structuredClone(plan); action = structuredClone(action);
      const terms = swapTerms(plan, action);
      return runBound(async inner => {
        const started = now();
        if (!Number.isSafeInteger(started) || started < 0) fail('INVALID_EXECUTION_CONFIG');
        if (started >= plan.expiresAtMs) fail('EXECUTION_REVIEW_EXPIRED');
        const [chain, latest] = await read([{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['latest', false] }], inner);
        if (chain !== '0x2105') fail('EXECUTION_CHAIN_MISMATCH');
        const header = p.blockHeader(latest, now()), block = { blockHash: header.hash, requireCanonical: true };
        await identities(block, plan.sender, terms.pool, terms.poolFeePips, inner);
        const [balance, simulated, estimate, spot] = await read([{ method: 'eth_getBalance', params: [plan.sender, block] },
          { method: 'eth_call', params: [terms.tx, block] }, { method: 'eth_estimateGas', params: [terms.tx, block] },
          call(terms.pool, '0x3850c7bd', block)], inner);
        const output = p.simulatedOutput(simulated), gas = uint(estimate);
        if (output < terms.minimum || gas < 21000n || gas > terms.gas || header.baseFee + terms.priority > terms.maxFee)
          fail('EXECUTION_SIMULATION_FAILED');
        if (typeof spot !== 'string' || !/^0x[0-9a-f]{448}$/.test(spot)) fail('EXECUTION_POOL_STATE_INVALID');
        const sqrt = BigInt('0x' + spot.slice(2, 66));
        if (sqrt === 0n || sqrt >= 1n << 160n || BigInt('0x' + spot.slice(-64)) !== 1n) fail('EXECUTION_POOL_STATE_INVALID');
        const [fjord, isthmus, l1, operator, canonical] = await read([call(p.ORACLE, '0x960e3a23', block), call(p.ORACLE, '0x105d0b81', block),
          call(p.ORACLE, '0xf1c7a58b' + word((terms.tx.data.length - 2) / 2 + 512), block),
          call(p.ORACLE, '0x275aedd2' + word(terms.gas), block), { method: 'eth_getBlockByNumber', params: [header.number, false] }], inner);
        if (p.integerWord(fjord) !== 1n || p.integerWord(isthmus) !== 1n || p.integerWord(l1) === 0n) fail('EXECUTION_FEES_UNKNOWN');
        const total = terms.gas * terms.maxFee + p.integerWord(l1) * 2n + p.integerWord(operator);
        if (total > terms.nativeCap) fail('EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED');
        if (uint(balance) < BigInt(plan.amountRaw) + total) fail('EXECUTION_NATIVE_BALANCE_INSUFFICIENT');
        if (!plain(canonical) || canonical.hash !== header.hash || canonical.number !== header.number) fail('EXECUTION_REORG');
        const completed = now();
        if (!Number.isSafeInteger(completed) || completed < started || completed >= plan.expiresAtMs || completed - header.timestamp > 12000) fail('EXECUTION_REVIEW_EXPIRED');
        return { ready: true, observedAtMs: completed, nativeFeeReserveRaw: total.toString(), simulatedOutputRaw: output.toString(),
          sqrtPriceX96: sqrt.toString(), blockHash: header.hash, blockNumber: header.number };
      }, signal);
    },
  };
}
