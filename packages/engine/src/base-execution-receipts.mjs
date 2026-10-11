/** Independent receipt attribution for the exact reviewed single-transaction swap. */
import { BASE_V3 } from '@instinct/router-core';
import { baseExecutionPrimitives as p } from './base-readiness.mjs';
import { ExecutionEngineError, fail, swapTerms } from './base-execution-checks.mjs';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const quantity = value => p.quantity(value);
const topicAddress = value => {
  if (typeof value !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(value)) fail('EXECUTION_RECEIPT_INVALID');
  return '0x' + value.slice(-40).toLowerCase();
};
function logsNet(receipt, recipient, pool) {
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 512) fail('EXECUTION_RECEIPT_INVALID');
  let net = 0n, attributed = 0n; const seen = new Set();
  for (const log of receipt.logs) {
    if (!plain(log) || !equal(log.transactionHash, receipt.transactionHash) || !equal(log.blockHash, receipt.blockHash) ||
      log.blockNumber !== receipt.blockNumber || log.removed !== false || !Array.isArray(log.topics) || log.topics.length > 4 ||
      log.topics.some(topic => !hash(topic)) || typeof log.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(log.address) ||
      typeof log.data !== 'string' || !/^0x(?:[0-9a-f]{2}){0,32768}$/i.test(log.data)) fail('EXECUTION_RECEIPT_INVALID');
    const index = quantity(log.logIndex).toString();
    if (seen.has(index)) fail('EXECUTION_RECEIPT_INVALID'); seen.add(index);
    if (!equal(log.address, BASE_V3.usdc) || !equal(log.topics[0], TRANSFER)) continue;
    if (log.topics.length !== 3 || !/^0x[0-9a-f]{64}$/i.test(log.data)) fail('EXECUTION_RECEIPT_INVALID');
    const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]), units = BigInt(log.data);
    if (to === recipient) { net += units; if (from === pool) attributed += units; }
    if (from === recipient) net -= units;
  }
  return { net, attributed };
}
function membership(block, receipt, tx, expectedHash) {
  const index = quantity(receipt.transactionIndex);
  if (index !== quantity(tx.transactionIndex) || index > 4095n || !Array.isArray(block.transactions) ||
    block.transactions.length > 4096 || block.transactions.some(value => !hash(value)) ||
    !equal(block.transactions[Number(index)], expectedHash) || block.transactions.filter(value => equal(value, expectedHash)).length !== 1)
    fail('EXECUTION_RECEIPT_BINDING_MISMATCH');
}
export function createBaseReceiptVerifier(checks, { now = Date.now } = {}) {
  return { async confirm(plan, action, transactionHash, signal) {
    if (!hash(transactionHash)) fail('INVALID_TRANSACTION_HASH');
    plan = structuredClone(plan); action = structuredClone(action);
    const terms = swapTerms(plan, action), expectedHash = transactionHash.toLowerCase();
    return checks.runBound(async inner => {
      const [receipt] = await checks.read([{ method: 'eth_getTransactionReceipt', params: [expectedHash] }], inner);
      const [chain, tx, head] = await checks.read([{ method: 'eth_chainId', params: [] },
        { method: 'eth_getTransactionByHash', params: [expectedHash] },
        { method: 'eth_blockNumber', params: [] }], inner);
      if (chain !== '0x2105') fail('EXECUTION_CHAIN_MISMATCH');
      if (receipt === null || tx === null) throw new ExecutionEngineError('RECEIPT_PENDING', 202);
      if (!plain(receipt) || !plain(tx) || !equal(receipt.transactionHash, expectedHash) || !equal(tx.hash, expectedHash) ||
        !hash(receipt.blockHash) || !equal(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber ||
        tx.from?.toLowerCase() !== plan.sender || tx.to?.toLowerCase() !== terms.tx.to || tx.input !== terms.tx.data ||
        quantity(tx.value) !== BigInt(plan.amountRaw) || quantity(tx.chainId) !== 8453n || tx.type !== '0x2' ||
        !Array.isArray(tx.accessList) || tx.accessList.length || quantity(tx.gas) < 21000n || quantity(tx.gas) > terms.gas ||
        quantity(tx.maxFeePerGas) === 0n || quantity(tx.maxFeePerGas) > terms.maxFee ||
        quantity(tx.maxPriorityFeePerGas) > quantity(tx.maxFeePerGas) || quantity(tx.maxPriorityFeePerGas) > terms.priority ||
        !equal(receipt.from, tx.from) || !equal(receipt.to, tx.to) || receipt.type !== '0x2') fail('EXECUTION_RECEIPT_BINDING_MISMATCH');
      const number = quantity(receipt.blockNumber), current = quantity(head);
      if (number > BigInt(Number.MAX_SAFE_INTEGER) || current > BigInt(Number.MAX_SAFE_INTEGER)) fail('EXECUTION_RECEIPT_INVALID');
      if (current < number || current - number + 1n < 12n) throw new ExecutionEngineError('RECEIPT_PENDING', 202);
      const [canonical] = await checks.read([{ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }], inner);
      if (!plain(canonical) || !equal(canonical.hash, receipt.blockHash) || canonical.number !== receipt.blockNumber) fail('EXECUTION_REORG');
      membership(canonical, receipt, tx, expectedHash);
      const output = { success: false, routeId: plan.routeId, actionId: action.id, transactionHash,
        evidence: { chainId: BASE_V3.chainId, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, confirmations: Number(current - number + 1n),
          attribution: 'EXACT_REVIEWED_ROUTER_TRANSACTION_AND_SAME_TRANSACTION_RECIPIENT_TRANSFER_LOGS' } };
      const receiptProof = { chainId: BASE_V3.chainId, transactionHash, blockNumberRaw: number.toString(),
        blockHash: receipt.blockHash.toLowerCase(), observedAtMs: now(), confirmations: Number(current - number + 1n) };
      if (!Number.isSafeInteger(receiptProof.observedAtMs) || receiptProof.observedAtMs < 0) fail('EXECUTION_RECEIPT_INVALID');
      if (receipt.status === '0x0') {
        const [last] = await checks.read([{ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }], inner);
        if (!plain(last) || !equal(last.hash, receipt.blockHash) || last.number !== receipt.blockNumber) fail('EXECUTION_REORG');
        membership(last, receipt, tx, expectedHash);
        return { ...output, confirmedFailure: true, receipt: receiptProof };
      }
      if (receipt.status !== '0x1') fail('EXECUTION_RECEIPT_INVALID');
      const block = { blockHash: receipt.blockHash.toLowerCase(), requireCanonical: true };
      await checks.identities(block, plan.sender, terms.pool, terms.poolFeePips, inner);
      const gas = quantity(receipt.gasUsed), effective = quantity(receipt.effectiveGasPrice), l1 = quantity(receipt.l1Fee);
      if (gas < 21000n || gas > quantity(tx.gas) || effective > quantity(tx.maxFeePerGas) || effective === 0n) fail('EXECUTION_ACTUAL_FEE_EXCEEDED');
      // Historical canonical oracle, never a fabricated zero operator fee.
      const [operatorWord, last] = await checks.read([p.call(p.ORACLE, '0x275aedd2' + gas.toString(16).padStart(64, '0'), block),
        { method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }], inner);
      const operator = p.integerWord(operatorWord), actual = gas * effective + l1 + operator;
      if (receipt.operatorFee !== undefined && quantity(receipt.operatorFee) !== operator) fail('EXECUTION_ACTUAL_FEE_MISMATCH');
      if (actual > terms.nativeCap || !plain(last) || !equal(last.hash, receipt.blockHash) || last.number !== receipt.blockNumber)
        fail('EXECUTION_ACTUAL_FEE_EXCEEDED');
      membership(last, receipt, tx, expectedHash);
      const credit = logsNet(receipt, plan.recipient, terms.pool);
      if (credit.net < terms.minimum || credit.attributed < terms.minimum) fail('DESTINATION_CREDIT_REQUIRED');
      return { ...output, success: true, receipt: { ...receiptProof, actualNativeFeeRaw: actual.toString(),
          destinationCredit: { asset: plan.destination, recipient: plan.recipient, amountRaw: credit.net.toString() } }, destinationCredit: { asset: plan.destination, recipient: plan.recipient, amountRaw: credit.net.toString() },
        evidence: { ...output.evidence, actualNativeFeeRaw: actual.toString(), contractAndImplementationPinsVerified: true,
          receivedFromReviewedPoolRaw: credit.attributed.toString(), canonicalRecheck: true } };
    }, signal);
  } };
}
