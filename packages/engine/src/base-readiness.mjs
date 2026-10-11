import { createHash, randomUUID } from 'node:crypto';
import { BASE_V3, createUniswapV3Adapter } from '@instinct/router-core';

// Official Base SwapRouter02 1.3.1 deployed artifact, with canonical constructor immutables.
// Artifact bytecode matches exactly after WETH/factory/positionManager substitutions.
const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481';
const ROUTER_SHA256 = 'cdd0e7bce67f3b8cc4a3f517beaa9afa00ea25ee7b6c6ff14a60898228289ef6';
const ORACLE = '0x420000000000000000000000000000000000000f';
const MAX_BODY = 262144, MAX_GAS = 2000000n, MAX_FEE = 100000000000n;
const codes = {
  INVALID_READINESS_INPUT: 'Use canonical Base native ETH to USDC with explicit public wallet addresses.',
  READINESS_BUSY: 'Readiness checks are busy. Retry after pending checks finish.',
  READINESS_CANCELLED: 'Readiness check was cancelled.', READINESS_TIMEOUT: 'Readiness check exceeded its time budget.',
  READINESS_RPC_UNAVAILABLE: 'Base RPC evidence is unavailable. Refresh the check.',
  READINESS_RPC_TRANSPORT_UNAVAILABLE: 'The configured Base read endpoint is unavailable.',
  READINESS_RPC_BUSY: 'The configured Base read endpoint is temporarily busy.',
  READINESS_INVALID_RPC: 'Base RPC returned invalid evidence.', READINESS_CHAIN_MISMATCH: 'RPC network identity did not match Base.',
  READINESS_CODE_MISMATCH: 'The canonical contract bytecode or immutable bindings did not match.',
  READINESS_TOKEN_MISMATCH: 'Canonical token details did not match.', READINESS_STALE: 'Evidence expired. Refresh the check.',
  READINESS_REORG: 'The observed block changed. Refresh the check.', READINESS_QUOTE_UNAVAILABLE: 'A fresh pool quote is unavailable.',
  READINESS_SIMULATION_FAILED: 'The locally prepared swap did not simulate successfully.',
  READINESS_OUTPUT_MISMATCH: 'Simulation output did not match the pinned-block quote.',
  READINESS_FEES_UNKNOWN: 'Complete native fee estimates are unavailable.',
  READINESS_INSUFFICIENT_FUNDS: 'The public wallet balance cannot cover the input and estimated native fee budget.',
  READINESS_WALLET_UNSUPPORTED: 'This check supports accounts with no deployed code. Contract and delegated wallets require a separately validated execution path.',
};
export class BaseReadinessError extends Error {
  constructor(code) { super(codes[code] ?? codes.READINESS_RPC_UNAVAILABLE); this.name = 'BaseReadinessError'; this.code = code; }
}
const fail = code => { throw new BaseReadinessError(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const word = value => (typeof value === 'string' && value.startsWith('0x') ? value.slice(2) : BigInt(value).toString(16)).padStart(64, '0');
const hex = value => '0x' + value.toString(16);
function quantity(value, maximum = (1n << 256n) - 1n) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value)) fail('READINESS_INVALID_RPC');
  const result = BigInt(value); if (result > maximum) fail('READINESS_INVALID_RPC'); return result;
}
function integerWord(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) fail('READINESS_INVALID_RPC');
  return BigInt(value);
}
function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || BigInt(value) <= 2n) fail('INVALID_READINESS_INPUT');
  return value.toLowerCase();
}
function validate(input) {
  const allowed = ['source', 'destination', 'amountRaw', 'sender', 'recipient', 'slippageBps'];
  if (!plain(input) || Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(input, key))) fail('INVALID_READINESS_INPUT');
  for (const [key, expected, decimals] of [['source', BASE_V3.native, 18], ['destination', BASE_V3.usdc, 6]]) {
    const asset = input[key];
    if (!plain(asset) || Object.keys(asset).length !== 3 || !['chainId', 'address', 'decimals'].every(k => Object.hasOwn(asset, k)) ||
      asset.chainId !== BASE_V3.chainId || typeof asset.address !== 'string' || asset.address.toLowerCase() !== expected || asset.decimals !== decimals) fail('INVALID_READINESS_INPUT');
  }
  if (typeof input.amountRaw !== 'string' || !/^[1-9][0-9]{0,76}$/.test(input.amountRaw) || BigInt(input.amountRaw) >= 1n << 255n ||
    !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 9999) fail('INVALID_READINESS_INPUT');
  return { source: { chainId: BASE_V3.chainId, address: BASE_V3.native, decimals: 18 },
    destination: { chainId: BASE_V3.chainId, address: BASE_V3.usdc, decimals: 6 }, amountRaw: input.amountRaw,
    sender: address(input.sender), recipient: address(input.recipient), slippageBps: input.slippageBps };
}
function strictJson(text) {
  const stack = [], tokens = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{' || token === '[') { if (stack.length >= 16) fail('READINESS_INVALID_RPC'); stack.push(token === '{' ? new Set() : null); }
    else if (token === '}' || token === ']') stack.pop();
    else if (/^\s*:/.test(text.slice(match.index + token.length))) {
      const key = JSON.parse(token), keys = stack.at(-1);
      if (!keys || keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('READINESS_INVALID_RPC'); keys.add(key);
    }
  }
  try { return JSON.parse(text); } catch { fail('READINESS_INVALID_RPC'); }
}
async function rpc(wire, calls, signal, serial) {
  if (signal.aborted) fail('READINESS_CANCELLED');
  const batch = calls.map((call, i) => ({ jsonrpc: '2.0', id: `ready-${serial}-${i}`, ...call }));
  let response;
  try {
    response = await wire(BASE_V3.rpc, { method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(batch) });
    if (signal.aborted) fail('READINESS_CANCELLED');
    if (!response.ok || response.redirected || response.url && ![BASE_V3.rpc, BASE_V3.rpc + '/'].includes(response.url)) fail('READINESS_RPC_UNAVAILABLE');
    const size = response.headers.get('content-length');
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BODY) || !response.body?.getReader) fail('READINESS_INVALID_RPC');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, chunks = 0, text = '';
    const stop = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      while (true) {
        if (signal.aborted) fail('READINESS_CANCELLED');
        const part = await reader.read(); if (signal.aborted) fail('READINESS_CANCELLED'); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BODY || ++chunks > 4096) fail('READINESS_INVALID_RPC');
        text += decoder.decode(part.value, { stream: true });
        if (chunks % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      text += decoder.decode();
    } finally { signal.removeEventListener('abort', stop); void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const rows = strictJson(text), seen = new Map();
    if (!Array.isArray(rows) || rows.length !== batch.length) fail('READINESS_INVALID_RPC');
    for (const row of rows) {
      if (!plain(row) || row.jsonrpc !== '2.0' || typeof row.id !== 'string' || !batch.some(call => call.id === row.id) || seen.has(row.id) ||
        Object.hasOwn(row, 'result') === Object.hasOwn(row, 'error')) fail('READINESS_INVALID_RPC');
      if (Object.hasOwn(row, 'error')) {
        if (!plain(row.error) || !Number.isSafeInteger(row.error.code) || typeof row.error.message !== 'string' || row.error.message.length > 512) fail('READINESS_INVALID_RPC');
        seen.set(row.id, { unavailable: true }); // No raw errors, revert strings, URLs or data escape.
      } else seen.set(row.id, { result: row.result });
    }
    return batch.map(call => seen.get(call.id));
  } catch (error) {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    if (signal.aborted) fail('READINESS_CANCELLED');
    if (error instanceof BaseReadinessError) throw error;
    fail('READINESS_RPC_UNAVAILABLE');
  }
}
const call = (to, data, block) => ({ method: 'eth_call', params: [{ to, data, gas: '0x1e8480' }, block] });
function result(row, code = 'READINESS_RPC_UNAVAILABLE') { if (row.unavailable) fail(code); return row.result; }
function codeHash(row) {
  const code = result(row);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2}){100,32768}$/.test(code)) fail('READINESS_CODE_MISMATCH');
  return createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
}
function blockHeader(value, now) {
  if (!plain(value) || typeof value.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.hash) || /^0x0{64}$/.test(value.hash)) fail('READINESS_INVALID_RPC');
  const number = hex(quantity(value.number)), timestamp = Number(quantity(value.timestamp, BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)))) * 1000;
  const baseFee = quantity(value.baseFeePerGas, MAX_FEE);
  if (!Number.isSafeInteger(timestamp) || timestamp > now + 2000 || now - timestamp > 12000 || baseFee === 0n) fail('READINESS_STALE');
  return { number, hash: value.hash, timestamp, baseFee };
}
/** Deadline-protected local exactInputSingle plus refundETH; no provider calldata. */
function transactionData(request, quote, deadlineSeconds) {
  const swap = '04e45aaf' + word(BASE_V3.weth) + word(BASE_V3.usdc) + word(quote.poolFeePips) + word(request.recipient) +
    word(request.amountRaw) + word(quote.minimumOutRaw) + word(0);
  const refund = '12210e8a', tuple = data => word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  const a = tuple(swap), b = tuple(refund);
  return '0x5ae401dc' + word(deadlineSeconds) + word(64) + word(2) + word(64) + word(64 + a.length / 2) + a + b;
}
function simulatedOutput(value) {
  // Canonical bytes[] containing exactly one uint256 return and one empty refund return.
  if (typeof value !== 'string' || !/^0x[0-9a-f]{448}$/.test(value)) fail('READINESS_INVALID_RPC');
  const words = Array.from({ length: 7 }, (_, i) => BigInt('0x' + value.slice(2 + i * 64, 66 + i * 64)));
  if (words[0] !== 32n || words[1] !== 2n || words[2] !== 64n || words[3] !== 128n || words[4] !== 32n || words[6] !== 0n) fail('READINESS_INVALID_RPC');
  return words[5];
}
export function createBaseReadiness({ fetch: wire = globalThis.fetch, now = Date.now } = {}) {
  if (typeof wire !== 'function' || typeof now !== 'function') fail('INVALID_READINESS_INPUT');
  const adapter = createUniswapV3Adapter({ fetch: wire, clock: now, pricingTtlMs: 10000 });
  let serial = 0, active = 0;
  return { async inspect(input, parentSignal = new AbortController().signal) {
    const request = validate(input), started = now();
    if (!Number.isSafeInteger(started) || started < 0) fail('INVALID_READINESS_INPUT');
    if (!parentSignal || typeof parentSignal.aborted !== 'boolean' || typeof parentSignal.addEventListener !== 'function' ||
      typeof parentSignal.removeEventListener !== 'function') fail('INVALID_READINESS_INPUT');
    const report = { status: 'BLOCKED', executionReady: false, requiresWalletSignature: true, readOnly: true,
      transactionPrepared: false, checkedAtMs: started, validUntilMs: started, request, quote: null, evidence: {},
      fees: { complete: false, estimateOnly: true, gasEstimateRaw: null, gasLimitRaw: null, maxFeePerGasRaw: null,
        maxPriorityFeePerGasRaw: null, l2BudgetRaw: null, l1FeeUpperBoundRaw: null, l1BudgetRaw: null,
        operatorFeeBudgetRaw: null, totalNativeBudgetRaw: null, balanceRaw: null }, blockers: [] };
    const blocked = code => ({ ...report, status: 'BLOCKED', transactionPrepared: false, transaction: undefined,
      blockers: [{ code, message: codes[code] ?? codes.READINESS_RPC_UNAVAILABLE }] });
    if (parentSignal.aborted) return blocked('READINESS_CANCELLED');
    if (active >= 4) return blocked('READINESS_BUSY');
    active++;
    const controller = new AbortController(); let timeout = false;
    let rejectBound;
    const bound = new Promise((_, reject) => { rejectBound = reject; });
    const stop = code => { controller.abort(); rejectBound(new BaseReadinessError(code)); };
    const cancel = () => stop('READINESS_CANCELLED');
    parentSignal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timeout = true; stop('READINESS_TIMEOUT'); }, 8000);
    const run = async () => {
      const deadlineMs = started + 8000, id = randomUUID();
      const quote = await adapter.quote({ request: { requestId: id, ...request, maxFeeBps: 10000, maxPriceImpactBps: 10000,
        maxCompletionMs: 60000, deadlineMs, optimization: { objective: 'BEST_OUTPUT', maxOutputShortfallBps: 0 } },
        leg: { index: 0, capabilityId: 'base-readiness', adapterId: 'uniswap-v3', kind: 'SWAP', source: request.source,
          destination: request.destination, validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true,
          amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false }, amountRaw: request.amountRaw,
        sender: request.sender, recipient: request.recipient, slippageBps: request.slippageBps, deadlineMs,
        transportDeadlineMs: deadlineMs, signal: controller.signal });
      report.quote = { poolAddress: quote.poolAddress, poolFeePips: quote.poolFeePips, expectedOutputRaw: quote.expectedOutRaw,
        minimumOutputRaw: quote.minimumOutRaw, blockNumber: quote.blockNumber, blockHash: quote.blockHash, pricingValidUntilMs: quote.pricingValidUntilMs };
      const block = { blockHash: quote.blockHash, requireCanonical: true };
      const proof = await rpc(wire, [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByHash', params: [quote.blockHash, false] },
        ...[ROUTER, BASE_V3.weth, BASE_V3.usdc, ORACLE].map(to => ({ method: 'eth_getCode', params: [to, block] })),
        call(ROUTER, '0xc45a0155', block), call(ROUTER, '0x4aa4a4fc', block),
        call(BASE_V3.weth, '0x313ce567', block), call(BASE_V3.usdc, '0x313ce567', block),
        { method: 'eth_getBalance', params: [request.sender, block] }, { method: 'eth_maxPriorityFeePerGas', params: [] },
        { method: 'eth_getCode', params: [request.sender, block] }], controller.signal, ++serial);
      if (result(proof[0]) !== '0x2105') fail('READINESS_CHAIN_MISMATCH');
      const header = blockHeader(result(proof[1]), now());
      if (header.hash !== quote.blockHash || header.number !== quote.blockNumber) fail('READINESS_REORG');
      const hashes = proof.slice(2, 6).map(codeHash);
      if (hashes[0] !== ROUTER_SHA256 || integerWord(result(proof[6])) !== BigInt(BASE_V3.factory) || integerWord(result(proof[7])) !== BigInt(BASE_V3.weth)) fail('READINESS_CODE_MISMATCH');
      if (integerWord(result(proof[8])) !== 18n || integerWord(result(proof[9])) !== 6n) fail('READINESS_TOKEN_MISMATCH');
      if (result(proof[12]) !== '0x') fail('READINESS_WALLET_UNSUPPORTED');
      const balance = quantity(result(proof[10])), priority = quantity(result(proof[11], 'READINESS_FEES_UNKNOWN'), MAX_FEE);
      report.fees.balanceRaw = balance.toString();
      if (balance < BigInt(request.amountRaw)) fail('READINESS_INSUFFICIENT_FUNDS');
      const maxFee = header.baseFee * 2n + priority;
      if (maxFee > MAX_FEE) fail('READINESS_FEES_UNKNOWN');
      const validUntilMs = Math.min(deadlineMs, quote.pricingValidUntilMs), deadlineSeconds = Math.floor(validUntilMs / 1000);
      const transaction = { chainId: 8453, type: '0x2', from: request.sender, to: ROUTER,
        data: transactionData(request, quote, deadlineSeconds), value: hex(BigInt(request.amountRaw)),
        accessList: [], maxFeePerGas: hex(maxFee), maxPriorityFeePerGas: hex(priority) };
      report.evidence = { chainId: BASE_V3.chainId, blockNumber: header.number, blockHash: header.hash,
        blockTimestampMs: header.timestamp, router: ROUTER, factory: BASE_V3.factory, wrappedNative: BASE_V3.weth, usdc: BASE_V3.usdc,
        oracle: ORACLE, codeSha256: { router: hashes[0], wrappedNative: hashes[1], usdc: hashes[2], oracle: hashes[3] },
        routerArtifactVerified: true, immutableBindingsVerified: true, senderCodeEmpty: true,
        tokenAndOracleCodeBasis: 'CANONICAL_ADDRESSES_WITH_OBSERVED_CODE_NOT_INDEPENDENT_IMPLEMENTATION_ATTESTATION',
        simulationBasis: 'PINNED_BLOCK_CALL_RETURN_NOT_INDEPENDENT_RECIPIENT_BALANCE_DELTA',
        simulationOutputRaw: null, canonicalRecheck: false,
        deadlineSeconds, calldataBuiltLocally: true };
      const simulated = await rpc(wire, [{ method: 'eth_call', params: [{ ...transaction, chainId: '0x2105', gas: hex(MAX_GAS) }, block] },
        { method: 'eth_estimateGas', params: [{ ...transaction, chainId: '0x2105', gas: hex(MAX_GAS) }, block] }], controller.signal, ++serial);
      const output = simulatedOutput(result(simulated[0], 'READINESS_SIMULATION_FAILED'));
      if (output.toString() !== quote.expectedOutRaw || output < BigInt(quote.minimumOutRaw)) fail('READINESS_OUTPUT_MISMATCH');
      const estimate = quantity(result(simulated[1], 'READINESS_SIMULATION_FAILED'), MAX_GAS);
      if (estimate < 21000n) fail('READINESS_SIMULATION_FAILED');
      const gasLimit = (estimate * 150n + 99n) / 100n;
      if (gasLimit > MAX_GAS) fail('READINESS_FEES_UNKNOWN');
      transaction.gas = hex(gasLimit);
      report.evidence.simulationOutputRaw = output.toString();
      Object.assign(report.fees, { gasEstimateRaw: estimate.toString(), gasLimitRaw: gasLimit.toString(),
        maxFeePerGasRaw: maxFee.toString(), maxPriorityFeePerGasRaw: priority.toString(), l2BudgetRaw: (gasLimit * maxFee).toString() });
      // Empty-access-list EIP1559 transaction: 512 bytes safely covers all fixed/RLP
      // fields up to uint256. Oracle adds its own signature-size allowance.
      const unsignedSizeUpper = (transaction.data.length - 2) / 2 + 512;
      const feeProof = await rpc(wire, [call(ORACLE, '0x960e3a23', block), call(ORACLE, '0x105d0b81', block),
        call(ORACLE, '0xf1c7a58b' + word(unsignedSizeUpper), block), call(ORACLE, '0x275aedd2' + word(gasLimit), block),
        { method: 'eth_getBlockByNumber', params: [header.number, false] }], controller.signal, ++serial);
      if (integerWord(result(feeProof[0], 'READINESS_FEES_UNKNOWN')) !== 1n || integerWord(result(feeProof[1], 'READINESS_FEES_UNKNOWN')) !== 1n) fail('READINESS_FEES_UNKNOWN');
      const l1 = integerWord(result(feeProof[2], 'READINESS_FEES_UNKNOWN')), operator = integerWord(result(feeProof[3], 'READINESS_FEES_UNKNOWN'));
      if (l1 === 0n || l1 > 10n ** 18n || operator > 10n ** 18n) fail('READINESS_FEES_UNKNOWN');
      const finalHeader = blockHeader(result(feeProof[4]), now());
      if (finalHeader.hash !== header.hash || finalHeader.number !== header.number) fail('READINESS_REORG');
      const completed = now();
      if (!Number.isSafeInteger(completed) || completed < started || completed >= deadlineSeconds * 1000 || controller.signal.aborted) fail('READINESS_STALE');
      const l2 = gasLimit * maxFee, l1Budget = l1 * 2n, total = l2 + l1Budget + operator;
      report.evidence.simulationOutputRaw = output.toString(); report.evidence.canonicalRecheck = true;
      report.fees = { complete: true, estimateOnly: true, gasEstimateRaw: estimate.toString(), gasLimitRaw: gasLimit.toString(),
        maxFeePerGasRaw: maxFee.toString(), maxPriorityFeePerGasRaw: priority.toString(), l2BudgetRaw: l2.toString(),
        l1FeeUpperBoundRaw: l1.toString(), l1BudgetRaw: l1Budget.toString(), operatorFeeBudgetRaw: operator.toString(),
        totalNativeBudgetRaw: total.toString(), requiredBalanceRaw: (BigInt(request.amountRaw) + total).toString(), balanceRaw: balance.toString(),
        unsignedTxSizeUpperBytes: unsignedSizeUpper, basis: 'PINNED_BLOCK_ORACLE_ESTIMATES_WITH_L2_150_PERCENT_GAS_AND_L1_2X_RESERVE',
        limitation: 'The oracle size bound is a practical compression estimate, not a guaranteed final fee. Fees and state must be refreshed before signing.' };
      if (balance < BigInt(request.amountRaw) + total) fail('READINESS_INSUFFICIENT_FUNDS');
      report.status = 'READY_FOR_REVIEW'; report.validUntilMs = deadlineSeconds * 1000;
      report.checkedAtMs = completed; report.transaction = transaction; report.transactionPrepared = true;
      return structuredClone(report);
    };
    const work = run().finally(() => { active--; });
    try { return await Promise.race([work, bound]); }
    catch (error) {
      const code = timeout ? 'READINESS_TIMEOUT' : parentSignal.aborted ? 'READINESS_CANCELLED' :
        error instanceof BaseReadinessError ? error.code : 'READINESS_QUOTE_UNAVAILABLE';
      return structuredClone(blocked(code));
    } finally { clearTimeout(timer); parentSignal.removeEventListener('abort', cancel); }
  } };
}
// Internal execution building blocks; callers still cannot choose RPC endpoints.
export const baseExecutionPrimitives = Object.freeze({ ROUTER, ROUTER_SHA256, ORACLE, MAX_GAS, MAX_FEE,
  rpc, call, result, codeHash, blockHeader, quantity, integerWord, transactionData, simulatedOutput, validate, strictJson });
