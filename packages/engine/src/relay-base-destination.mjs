/** Exact order-tagged native Base delivery. Provider hashes are discovery hints.
 * The filler need not be trusted: the canonical transaction itself pays the
 * reviewed EOA and names the signed order. ERC20 fills without order tags need
 * a separate settlement attestation and are deliberately not accepted here. */
import { BASE_V3, executionHash } from '@instinct/router-core';
import { baseExecutionPrimitives as p } from './base-readiness.mjs';
import { createBaseExecutionTransport } from './base-execution-transport.mjs';
import { fail } from './base-execution-checks.mjs';
import { computeRelayOrderId } from './relay-order.mjs';

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = x => executionHash(BASE_V3.chainId, x, 'transaction');
const address = x => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x) && BigInt(x) > 2n;
function intent(plan) {
  if (plan.source?.chainId !== SOL || plan.destination?.chainId !== BASE_V3.chainId ||
    plan.destination.address !== BASE_V3.native || plan.destination.decimals !== 18 || !address(plan.recipient) ||
    !/^[1-9][0-9]{0,77}$/.test(plan.minimumOutRaw)) fail('DESTINATION_RECIPE_UNSUPPORTED');
}
function header(value, now, fresh) {
  if (!value || !hash(value.hash)) fail('DESTINATION_EVIDENCE_INVALID');
  const number = p.quantity(value.number), timestamp = p.quantity(value.timestamp);
  if (number === 0n || timestamp * 1000n > BigInt(now + 2000) || fresh && timestamp * 1000n < BigInt(now - 60000))
    fail('DESTINATION_EVIDENCE_INVALID');
  return number;
}
export function verifyRelayBaseNativeDelivery(plan, transactionHash, tx, receipt, block, latest, recipientCode, now = Date.now()) {
  intent(plan);
  const meta = plan.actions?.at(-1)?.payload?.relay;
  const output = meta?.orderData?.output;
  if (!meta || !hash(meta.orderId) || !hash(meta.requestId) || computeRelayOrderId(meta.orderData) !== meta.orderId ||
    plan.quoteIds?.length !== 1 || plan.quoteIds[0] !== 'relay:' + meta.requestId || output.chainId !== 'base' ||
    output.payments?.length !== 1 || output.calls?.length !== 0 || output.extraData !== '0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f' ||
    !eq(output.payments[0].recipient, plan.recipient) || output.payments[0].currency !== BASE_V3.native ||
    output.payments[0].minimumAmount !== plan.minimumOutRaw) fail('DESTINATION_ORDER_ATTRIBUTION_REQUIRED');
  if (!hash(transactionHash) || !tx || !receipt || !eq(tx.hash, transactionHash) || !eq(receipt.transactionHash, transactionHash) ||
    !eq(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber || tx.transactionIndex !== receipt.transactionIndex ||
    !eq(tx.to, plan.recipient) || !eq(receipt.to, plan.recipient) || !address(tx.from) || !eq(tx.from, receipt.from) ||
    !eq(tx.input, meta.orderId) || p.quantity(tx.chainId) !== 8453n || p.quantity(receipt.status) !== 1n || recipientCode !== '0x')
    fail('DESTINATION_ORDER_ATTRIBUTION_REQUIRED');
  const number = header(block, now, false), head = header(latest, now, true), index = p.quantity(receipt.transactionIndex);
  if (block.number !== receipt.blockNumber || !eq(block.hash, receipt.blockHash) || head < number ||
    !Array.isArray(block.transactions) || block.transactions.length > 8192 || index >= BigInt(block.transactions.length) ||
    !eq(block.transactions[Number(index)], transactionHash) || block.transactions.filter(x => eq(x, transactionHash)).length !== 1)
    fail('DESTINATION_EVIDENCE_INVALID');
  const amount = p.quantity(tx.value), confirmations = Number(head - number + 1n);
  if (!Number.isSafeInteger(confirmations) || amount < BigInt(plan.minimumOutRaw)) fail('DESTINATION_CREDIT_REQUIRED');
  return {confirmations, destinationCredit: {asset: structuredClone(plan.destination), recipient: plan.recipient, amountRaw: amount.toString()}};
}

export function createRelayBaseDestinationVerifier({fetch: wire = globalThis.fetch, now = Date.now, rpcEndpoints} = {}) {
  const transport = createBaseExecutionTransport(wire, rpcEndpoints);
  let serial = 0;
  const read = async (fetch, calls, signal) => (await p.rpc(fetch, calls, signal, ++serial)).map(p.result);
  const verifier = {
    async inspect(request, signal) {
      intent({...request, minimumOutRaw: '1'});
      return transport.run(async (i, inner) => {
        const fetch = transport.transports[i];
        const [chain, block] = await read(fetch, [{method:'eth_chainId',params:[]}, {method:'eth_getBlockByNumber',params:['latest',false]}], inner);
        if (p.quantity(chain) !== 8453n) fail('READINESS_CHAIN_MISMATCH');
        header(block, now(), true);
        const [code, canonical] = await read(fetch, [{method:'eth_getCode',params:[request.recipient,{blockHash:block.hash,requireCanonical:true}]},
          {method:'eth_getBlockByNumber',params:[block.number,false]}], inner);
        if (code !== '0x') fail('DESTINATION_WALLET_UNSUPPORTED');
        if (!eq(canonical?.hash, block.hash) || canonical.number !== block.number) fail('DESTINATION_EVIDENCE_INVALID');
        return {chainId:BASE_V3.chainId, asset:structuredClone(request.destination), recipient:request.recipient, kind:'NATIVE_EOA'};
      }, signal);
    },
    async observe({plan, requestId, orderId, sourceTransactionHash, hashHint, signal}) {
      intent(plan);
      const meta = plan.actions?.at(-1)?.payload?.relay;
      if (meta?.requestId !== requestId || meta?.orderId !== orderId || !executionHash(SOL,sourceTransactionHash,'transaction'))
        fail('DESTINATION_ORDER_ATTRIBUTION_REQUIRED');
      if (!hash(hashHint)) return null;
      return transport.run(async (i, inner) => {
        const fetch = transport.transports[i];
        // Receipt-only reads allow the bounded transport to distinguish archive
        // service failures from malformed semantic evidence.
        const [receipt] = await read(fetch,[{method:'eth_getTransactionReceipt',params:[hashHint]}],inner);
        if (!receipt) return null;
        const [chain, tx, block, latest, code] = await read(fetch,[
          {method:'eth_chainId',params:[]}, {method:'eth_getTransactionByHash',params:[hashHint]},
          {method:'eth_getBlockByNumber',params:[receipt.blockNumber,false]}, {method:'eth_getBlockByNumber',params:['latest',false]},
          {method:'eth_getCode',params:[plan.recipient,{blockHash:receipt.blockHash,requireCanonical:true}]},
        ],inner);
        if (p.quantity(chain) !== 8453n) fail('READINESS_CHAIN_MISMATCH');
        const proof = verifyRelayBaseNativeDelivery(plan,hashHint,tx,receipt,block,latest,code,now());

        const [canonical] = await read(fetch,[{method:'eth_getBlockByNumber',params:[receipt.blockNumber,false]}],inner);
        if (!eq(canonical?.hash,receipt.blockHash) || canonical.number !== receipt.blockNumber ||
          !Array.isArray(canonical.transactions) || !eq(canonical.transactions[Number(p.quantity(receipt.transactionIndex))],hashHint))
          fail('DESTINATION_EVIDENCE_INVALID');
        return {success:true,destinationCredit:proof.destinationCredit,destinationReceipt:{chainId:BASE_V3.chainId,transactionHash:hashHint,
          blockNumberRaw:p.quantity(receipt.blockNumber).toString(),blockHash:receipt.blockHash,observedAtMs:now(),commitment:proof.confirmations >= 12 ? 'canonical' : 'confirmed',
          confirmations:proof.confirmations,destinationCredit:proof.destinationCredit,
          attribution:{provider:'relay',requestId,sourceTransactionHash}}};
      },signal);
    },
  };
  return Object.freeze({...verifier, async confirm(input) {
    const proof = await verifier.observe(input);
    return proof?.destinationReceipt?.commitment === 'canonical' ? proof : null;
  }});
}
