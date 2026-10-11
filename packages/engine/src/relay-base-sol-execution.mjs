/** Bounded Base native deposit recipe. Never signs or broadcasts; provider data is compared to local ABI. */
import { createHash, randomUUID } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { BASE_V3 } from "@instinct/router-core";
import { baseExecutionPrimitives as p } from "./base-readiness.mjs";
import {
  createBaseExecutionChecks,
  fail,
  ExecutionEngineError,
  enforceEconomicLimits,
} from "./base-execution-checks.mjs";
import { tokenIdentity, exactTokenDeposit } from "./relay-token-identity.mjs";
import { computeRelayOrderId, solanaBytes } from "./relay-order.mjs";
export const RELAY_DIRECT_RECIPE = "relay-base-direct-v1";
export const RELAY_USDC_RECIPE = "relay-base-usdc-solana-usdc-v1";
export const RELAY_RECIPE = "relay-base-native-solana-usdc-v1";
export const RELAY_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
export const SOLANA_USDC = Object.freeze({
  chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
});
const REFUND_EXTRA =
  "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";
const APPROVAL_EVENT = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const USDC_DEPOSIT_EVENT = "0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1";
const USDC_DEPOSIT_GAS = 300000n;
const DEPOSIT_EVENT =
  "0x8032066556caf3967d8fec4ad22a2d9e1e9576556b2903a0fcd5b1fd201e3477";
const plain = (v) => v && Object.getPrototypeOf(v) === Object.prototype;
const eq = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (v) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const addr = (v) =>
  typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) && BigInt(v) > 2n;
const word = (v) =>
  (typeof v === "string" && v.startsWith("0x")
    ? v.slice(2)
    : BigInt(v).toString(16)
  ).padStart(64, "0");
const hex = (v) => "0x" + v.toString(16);
const uint = (v) => {
  if (
    typeof v !== "string" ||
    !/^(?:0|[1-9][0-9]{0,77})$/.test(v) ||
    BigInt(v) >= 1n << 256n
  )
    fail("RELAY_ORDER_INVALID");
  return BigInt(v);
};
const exact = (v, keys) => {
  if (
    !plain(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail("RELAY_ORDER_INVALID");
};
const codeHash = (v) => {
  if (typeof v !== "string" || !/^0x(?:[0-9a-f]{2}){100,32768}$/.test(v))
    fail("EXECUTION_CODE_MISMATCH");
  return createHash("sha256")
    .update(Buffer.from(v.slice(2), "hex"))
    .digest("hex");
};
export const relayDepositData = (sender, orderId) =>
  "0x49290c1c" + word(sender.toLowerCase()) + orderId.slice(2).toLowerCase();
export const relayUsdcApprovalData = (amount) =>
  "0x095ea7b3" + word(RELAY_DEPOSITORY) + word(uint(amount));
export const relayUsdcDepositData = (sender, amount, orderId) =>
  "0xe8017952" + word(sender.toLowerCase()) + word(BASE_V3.usdc) + word(uint(amount)) + orderId.slice(2).toLowerCase();
const usdcSource = (request) => !eq(request.source?.address, BASE_V3.native);
const approvalId = request => eq(request.source.address, BASE_V3.usdc) ? "relay-usdc-approve" : "relay-token-approve";
const depositId = request => usdcSource(request) ? eq(request.source.address, BASE_V3.usdc) ? "relay-usdc-deposit" : "relay-token-deposit" : "relay-native-deposit";
export const relayTokenDepositData = (sender, token, amount, orderId) =>
  "0xe8017952" + word(sender.toLowerCase()) + word(token) + word(uint(amount)) + orderId.slice(2).toLowerCase();
const depositData = (request, orderId) => usdcSource(request)
  ? relayTokenDepositData(request.sender, request.source.address, request.amountRaw, orderId)
  : relayDepositData(request.sender, orderId);
const expanded = request => request.destination.address !== SOLANA_USDC.address ||
  (usdcSource(request) && !eq(request.source.address, BASE_V3.usdc));
export async function verifyRelayOrderSignature(meta, pins, required = true) {
  if (meta.orderSignature === undefined && !required) return;
  if (typeof meta.orderSignature !== "string" || !/^0x[0-9a-f]{130}$/i.test(meta.orderSignature)) fail("RELAY_ORDER_SIGNATURE_REQUIRED");
  try {
    if (!eq(await recoverMessageAddress({ message: { raw: meta.orderId }, signature: meta.orderSignature }), pins.solver))
      fail("RELAY_ORDER_SIGNATURE_INVALID");
  } catch { fail("RELAY_ORDER_SIGNATURE_INVALID"); }
}
function pinsFor(pins) {
  if (
    !plain(pins) ||
    !plain(pins.depository) ||
    (pins.depository.address !== undefined &&
      !eq(pins.depository.address, RELAY_DEPOSITORY)) ||
    !/^([a-f0-9]{64})$/.test(pins.depository.codeSha256) ||
    !addr(pins.depository.owner) ||
    !addr(pins.depository.allocator) ||
    !addr(pins.solver)
  )
    fail("EXECUTION_PINS_REQUIRED");
  return pins;
}
export function verifyRelayOrder(raw, request, pins, now) {
  pinsFor(pins);
  const usdc = usdcSource(request), currency = request.source.address;
  if (request.source?.chainId !== BASE_V3.chainId || request.destination?.chainId !== SOLANA_USDC.chainId ||
    !Number.isSafeInteger(request.source.decimals) || request.source.decimals < 0 || request.source.decimals > 255 ||
    (!usdc && request.source.decimals !== 18) || (usdc && !addr(currency)) ||
    !Number.isSafeInteger(request.destination.decimals) || request.destination.decimals < 0 || request.destination.decimals > 255 ||
    (request.destination.address === "11111111111111111111111111111111" && request.destination.decimals !== 9)) fail("RELAY_ORDER_MISMATCH");
  solanaBytes(request.destination.address);
  const protocol = raw?.protocol?.v2,
    order = protocol?.orderData;
  exact(order, [
    "version",
    "solverChainId",
    "solver",
    "salt",
    "inputs",
    "output",
    "fees",
  ]);
  if (
    order.version !== "v1" ||
    order.solverChainId !== "base" ||
    !eq(order.solver, pins.solver) ||
    !hash(order.salt) ||
    !Array.isArray(order.inputs) ||
    order.inputs.length !== 1 ||
    !Array.isArray(order.fees) ||
    order.fees.length
  )
    fail("RELAY_ORDER_INVALID");
  const input = order.inputs[0];
  exact(input, ["payment", "refunds"]);
  exact(input.payment, ["chainId", "currency", "amount", "weight"]);
  if (
    input.payment.chainId !== "base" ||
    input.payment.currency !== currency ||
    input.payment.amount !== request.amountRaw ||
    input.payment.weight !== "1"
  )
    fail("RELAY_ORDER_MISMATCH");
  uint(input.payment.amount);
  const output = order.output;
  exact(output, ["chainId", "payments", "calls", "deadline", "extraData"]);
  if (
    output.chainId !== "solana" ||
    !Array.isArray(output.payments) ||
    output.payments.length !== 1 ||
    !Array.isArray(output.calls) ||
    output.calls.length ||
    output.extraData !== "0x" ||
    !Number.isSafeInteger(output.deadline) ||
    output.deadline * 1000 <= now ||
    output.deadline * 1000 > now + 604800000
  )
    fail("RELAY_ORDER_MISMATCH");
  const outgoing = output.payments[0];
  exact(outgoing, ["recipient", "currency", "minimumAmount", "expectedAmount"]);
  if (
    outgoing.recipient !== request.recipient ||
    outgoing.currency !== request.destination.address ||
    uint(outgoing.minimumAmount) <= 0n ||
    uint(outgoing.expectedAmount) < uint(outgoing.minimumAmount) ||
    uint(outgoing.minimumAmount) <
      (uint(outgoing.expectedAmount) * BigInt(10000 - request.slippageBps)) /
        10000n
  )
    fail("RELAY_ORDER_MISMATCH");
  solanaBytes(outgoing.recipient);
  if (!Array.isArray(input.refunds) || input.refunds.length !== 2)
    fail("RELAY_ORDER_MISMATCH");
  const seen = new Set();
  for (const refund of input.refunds) {
    exact(refund, [
      "chainId",
      "recipient",
      "currency",
      "minimumAmount",
      "deadline",
      "extraData",
    ]);
    if (
      !["base", "solana"].includes(refund.chainId) ||
      seen.has(refund.chainId) ||
      refund.minimumAmount !== "0" ||
      refund.deadline !== output.deadline
    )
      fail("RELAY_REFUND_MISMATCH");
    seen.add(refund.chainId);
    if (
      refund.chainId === "base"
        ? !eq(refund.recipient, request.sender) ||
          refund.currency !== currency ||
          !eq(refund.extraData, REFUND_EXTRA)
        : refund.recipient !== request.recipient ||
          refund.currency !== request.destination.address ||
          refund.extraData !== "0x"
    )
      fail("RELAY_REFUND_MISMATCH");
  }
  if (
    protocol.hubType !== "onchain" ||
    !hash(protocol.orderId) ||
    computeRelayOrderId(order) !== protocol.orderId.toLowerCase() ||
    !hash(raw.requestId)
  )
    fail("RELAY_ORDER_COMMITMENT_MISMATCH");
  const payment = protocol.paymentDetails;
  exact(payment, ["chainId", "depository", "currency", "amount"]);
  if (
    payment.chainId !== "base" ||
    !eq(payment.depository, RELAY_DEPOSITORY) ||
    payment.currency !== currency ||
    payment.amount !== request.amountRaw
  )
    fail("RELAY_ORDER_MISMATCH");
  const details = raw.details;
  if (
    !eq(details?.sender, request.sender) ||
    details?.recipient !== request.recipient ||
    details?.slippageTolerance?.total !== String(request.slippageBps)
  )
    fail("RELAY_ORDER_MISMATCH");
  for (const [value, chain, address, decimals, amount, minimum] of [
    [
      details.currencyIn,
      8453,
      currency,
      request.source.decimals,
      request.amountRaw,
      request.amountRaw,
    ],
    [
      details.currencyOut,
      792703809,
      request.destination.address,
      request.destination.decimals,
      outgoing.expectedAmount,
      outgoing.minimumAmount,
    ],
  ]) {
    if (
      value?.currency?.chainId !== chain ||
      value.currency.address !== address ||
      value.currency.decimals !== decimals ||
      value.amount !== amount ||
      value.minimumAmount !== minimum
    )
      fail("RELAY_ORDER_MISMATCH");
  }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > (usdc ? 2 : 1))
    fail("RELAY_SOURCE_RECIPE_UNSUPPORTED");
  if (raw.steps.length === 2) {
    const approval = raw.steps[0], approvalTx = approval?.items?.[0]?.data;
    if (approval?.id !== "approve" || approval.kind !== "transaction" || approval.items?.length !== 1 ||
      approval.items[0].status !== "incomplete" || approvalTx?.chainId !== 8453 ||
      !eq(approvalTx.from, request.sender) || !eq(approvalTx.to, request.source.address) ||
      !eq(approvalTx.data, relayUsdcApprovalData(request.amountRaw)) || approvalTx.value !== "0")
      fail("RELAY_APPROVAL_MISMATCH");
  }
  const step = raw.steps.at(-1);
  if (
    step.id !== "deposit" ||
    step.kind !== "transaction" ||
    step.requestId !== raw.requestId ||
    step.depositAddress !== "" ||
    !Array.isArray(step.items) ||
    step.items.length !== 1
  )
    fail("RELAY_SOURCE_RECIPE_UNSUPPORTED");
  const item = step.items[0],
    tx = item.data;
  if (
    item.status !== "incomplete" ||
    tx?.chainId !== 8453 ||
    !eq(tx.from, request.sender) ||
    !eq(tx.to, RELAY_DEPOSITORY) ||
    !eq(tx.data, depositData(request, protocol.orderId)) ||
    tx.value !== (usdc ? "0" : request.amountRaw) ||
    item.check?.method !== "GET" ||
    item.check.endpoint !== `/intents/status/v3?requestId=${raw.requestId}`
  )
    fail("RELAY_DEPOSIT_MISMATCH");
  return {
    requestId: raw.requestId.toLowerCase(),
    orderId: protocol.orderId.toLowerCase(),
    orderData: structuredClone(order),
    ...(protocol.orderSignature === undefined ? {} : { orderSignature: protocol.orderSignature }),
    expectedOutRaw: outgoing.expectedAmount,
    minimumOutRaw: outgoing.minimumAmount,
  };
}
function terms(plan, action, pins) {
  pinsFor(pins);
  const usdc = usdcSource(plan), approval = action?.id === approvalId(plan);
  const meta = action?.payload?.relay,
    tx = action?.payload?.transaction;
  if (
    !(usdc ? [approvalId(plan), depositId(plan)] : ["relay-native-deposit"]).includes(action?.id) ||
    action.chainId !== BASE_V3.chainId ||
    action.payload.type !== "EVM_TRANSACTION" ||
    !plain(meta) ||
    !hash(meta.requestId) ||
    !hash(meta.orderId) ||
    computeRelayOrderId(meta.orderData) !== meta.orderId ||
    plan.quoteIds?.length !== 1 ||
    plan.quoteIds[0] !== `relay:${meta.requestId}` ||
    plan.source?.chainId !== BASE_V3.chainId ||
    (!usdc && plan.source.address !== BASE_V3.native) ||
    (usdc && !addr(plan.source.address)) ||
    plan.destination?.chainId !== SOLANA_USDC.chainId ||
    !Number.isSafeInteger(plan.destination.decimals) || plan.destination.decimals < 0 || plan.destination.decimals > 255 ||
    (plan.destination.address === "11111111111111111111111111111111" && plan.destination.decimals !== 9) ||
    !Number.isSafeInteger(plan.source.decimals) || plan.source.decimals < 0 || plan.source.decimals > 255 ||
    (!usdc && plan.source.decimals !== 18) ||
    !addr(plan.sender) ||
    !Number.isSafeInteger(plan.expiresAtMs)
  )
    fail("EXECUTION_BINDING_MISMATCH");
  if (
    !plain(tx) ||
    Object.keys(tx).some(
      (k) =>
        ![
          "from",
          "to",
          "chainId",
          "type",
          "data",
          "value",
          "gas",
          "maxFeePerGas",
          "maxPriorityFeePerGas",
          "accessList",
        ].includes(k),
    ) ||
    tx.from !== plan.sender ||
    tx.to !== (approval ? plan.source.address : RELAY_DEPOSITORY) ||
    tx.chainId !== "0x2105" ||
    tx.type !== "0x2" ||
    tx.data !== (approval ? relayUsdcApprovalData(plan.amountRaw) : depositData(plan, meta.orderId)) ||
    tx.value !== (usdc ? "0x0" : hex(uint(plan.amountRaw))) ||
    !Array.isArray(tx.accessList) ||
    tx.accessList.length
  )
    fail("EXECUTION_BINDING_MISMATCH");
  const o = meta.orderData,
    output = o.output?.payments?.[0],
    input = o.inputs?.[0]?.payment;
  if (
    !eq(o.solver, pins.solver) ||
    o.solverChainId !== "base" ||
    input?.chainId !== "base" ||
    input.currency !== plan.source.address ||
    input.amount !== plan.amountRaw ||
    o.output?.chainId !== "solana" ||
    output?.recipient !== plan.recipient ||
    output.currency !== plan.destination.address ||
    output.minimumAmount !== plan.minimumOutRaw ||
    o.output.calls.length ||
    o.fees.length
  )
    fail("EXECUTION_BINDING_MISMATCH");
  solanaBytes(plan.recipient); solanaBytes(plan.destination.address);
  if (usdc && !eq(plan.source.address, BASE_V3.usdc) && (!plain(meta.tokenIdentity) ||
    meta.tokenIdentity.address !== plan.source.address || meta.tokenIdentity.decimals !== plan.source.decimals)) fail("EXECUTION_TOKEN_UNSUPPORTED");
  const gas = p.quantity(tx.gas),
    maxFee = p.quantity(tx.maxFeePerGas),
    priority = p.quantity(tx.maxPriorityFeePerGas),
    planCap = uint(
      plan.nativeCosts?.find((x) => x.chainId === BASE_V3.chainId)?.amountRaw,
    );
  if (
    gas < 21000n ||
    gas > p.MAX_GAS ||
    maxFee === 0n ||
    maxFee > p.MAX_FEE ||
    priority > maxFee ||
    planCap === 0n
  )
    fail("EXECUTION_FEE_BOUND");
  if (usdc) {
    if (!Array.isArray(plan.actions) || ![1,2].includes(plan.actions.length) ||
      plan.actions.at(-1)?.id !== depositId(plan) ||
      (plan.actions.length === 2 && plan.actions[0]?.id !== approvalId(plan)) ||
      plan.actions.filter(a => a.id === action.id).length !== 1 ||
      JSON.stringify(plan.actions.find(a => a.id === action.id)) !== JSON.stringify(action) ||
      plan.actions.some(a => JSON.stringify(a.payload?.relay) !== JSON.stringify(meta)) ||
      plan.actions.reduce((sum, a) => sum + uint(a.payload?.nativeFeeCapRaw), 0n) !== planCap ||
      plan.actions.some(a => uint(a.payload?.nativeFeeCapRaw) === 0n))
      fail("EXECUTION_BINDING_MISMATCH");
  }
  return { meta, tx, gas, maxFee, priority, planCap, cap: usdc ? uint(action.payload.nativeFeeCapRaw) : planCap, usdc, approval };
}
export function createRelayBaseSolExecution({
  fetch: wire = globalThis.fetch,
  now = Date.now,
  pins,
  basePins,
  destinationVerifier,
  apiKey,
} = {}) {
  if (
    apiKey !== undefined &&
    (typeof apiKey !== "string" || apiKey.length > 256 || /[\r\n]/.test(apiKey))
  )
    fail("INVALID_EXECUTION_CONFIG");
  const checks = createBaseExecutionChecks({
    fetch: wire,
    now,
    pins: basePins,
  });
  let serial = 0;
  // Local to this verifier/endpoint. Immutable historical evidence is reused
  // only after fresh exact transaction/receipt and canonical membership checks.
  const sourceProofs = new Map(), deliverySignatures = new Map();
  const memoKey = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const memoGet = (cache, key) => {
    const entry = cache.get(key);
    if (!entry || performance.now() >= entry.until) { cache.delete(key); return null; }
    return entry.value;
  };
  const memoPut = (cache, key, value) => {
    cache.delete(key);
    while (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, { until: performance.now() + 60000, value });
  };
  const read = async (calls, signal) =>
    (await p.rpc(wire, calls, signal, ++serial)).map((row) => p.result(row));
  async function identities(block, sender, signal, usdc = false, extraCalls = []) {
    pinsFor(pins);
    const oracle = basePins?.oracle;
    if (!plain(oracle) || !plain(oracle.implementation))
      fail("EXECUTION_PINS_REQUIRED");
    const impl = oracle.implementation;
    const token = basePins?.usdc, tokenImpl = token?.implementation;
    if (usdc && (!plain(token) || !plain(tokenImpl) || !addr(tokenImpl.address) ||
      !hash(tokenImpl.slot) || !/^[a-f0-9]{64}$/.test(token.codeSha256) || !/^[a-f0-9]{64}$/.test(tokenImpl.codeSha256)))
      fail("EXECUTION_PINS_REQUIRED");
    const values = await read(
      [
        { method: "eth_getCode", params: [RELAY_DEPOSITORY, block] },
        p.call(RELAY_DEPOSITORY, "0x8da5cb5b", block),
        p.call(RELAY_DEPOSITORY, "0xaa5dcecc", block),
        { method: "eth_getCode", params: [sender, block] },
        { method: "eth_getCode", params: [p.ORACLE, block] },
        { method: "eth_getStorageAt", params: [p.ORACLE, impl.slot, block] },
        { method: "eth_getCode", params: [impl.address, block] },
        ...(usdc ? [
          { method: "eth_getCode", params: [BASE_V3.usdc, block] },
          { method: "eth_getStorageAt", params: [BASE_V3.usdc, tokenImpl.slot, block] },
          { method: "eth_getCode", params: [tokenImpl.address, block] },
          p.call(BASE_V3.usdc, "0x313ce567", block),
        ] : []),
        ...extraCalls,
      ],
      signal,
    );
    if (
      codeHash(values[0]) !== pins.depository.codeSha256 ||
      !eq(values[1], "0x" + word(pins.depository.owner)) ||
      !eq(values[2], "0x" + word(pins.depository.allocator)) ||
      values[3] !== "0x" ||
      codeHash(values[4]) !== oracle.codeSha256 ||
      !eq(values[5], "0x" + word(impl.address)) ||
      codeHash(values[6]) !== impl.codeSha256 ||
      (usdc && (codeHash(values[7]) !== token.codeSha256 ||
        !eq(values[8], "0x" + word(tokenImpl.address)) ||
        codeHash(values[9]) !== tokenImpl.codeSha256 || p.integerWord(values[10]) !== 6n))
    )
      fail("EXECUTION_CODE_MISMATCH");
    return values.slice(usdc ? 11 : 7);
  }
  // One canonical snapshot shares upgrade flags across every reviewed action.
  async function reserves(transactions, header, block, signal) {
    const [fjord, isthmus, ...fees] = await read([
      p.call(p.ORACLE, "0x960e3a23", block),
      p.call(p.ORACLE, "0x105d0b81", block),
      ...transactions.flatMap(tx => [
        p.call(p.ORACLE, "0xf1c7a58b" + word((tx.data.length - 2) / 2 + 512), block),
        p.call(p.ORACLE, "0x275aedd2" + word(p.quantity(tx.gas)), block),
      ]),
    ], signal);
    if (p.integerWord(fjord) !== 1n || p.integerWord(isthmus) !== 1n)
      fail("EXECUTION_FEES_UNKNOWN");
    return transactions.map((tx, index) => {
      const l1 = p.integerWord(fees[index * 2]), operator = p.integerWord(fees[index * 2 + 1]);
      if (l1 === 0n || header.baseFee + p.quantity(tx.maxPriorityFeePerGas) > p.quantity(tx.maxFeePerGas))
        fail("EXECUTION_FEES_UNKNOWN");
      return p.quantity(tx.gas) * p.quantity(tx.maxFeePerGas) + 2n * l1 + operator;
    });
  }
  async function json(path, init, signal) {
    const response = await wire("https://api.relay.link" + path, {
      ...init,
      redirect: "error",
      credentials: "omit",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
    });
    if (!response.ok || response.redirected) fail("RELAY_EVIDENCE_UNAVAILABLE");
    if (response.url && response.url !== "https://api.relay.link" + path)
      fail("RELAY_EVIDENCE_UNAVAILABLE");
    const length = response.headers.get("content-length");
    if (
      (length !== null &&
        (!/^[0-9]+$/.test(length) || Number(length) > 262144)) ||
      !response.body?.getReader
    )
      fail("RELAY_EVIDENCE_UNAVAILABLE");
    const reader = response.body.getReader(),
      parts = [];
    const stop = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    let count = 0;
    try {
      while (true) {
        if (signal.aborted) fail("EXECUTION_CANCELLED");
        const part = await reader.read();
        if (signal.aborted) fail('EXECUTION_CANCELLED');
        if (part.done) break;
        count += part.value.byteLength;
        if (count > 262144 || parts.length >= 4096)
          fail("RELAY_EVIDENCE_UNAVAILABLE");
        parts.push(Buffer.from(part.value));
      }
      return p.strictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
      );
    } finally {
      signal.removeEventListener('abort', stop);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function inspectDestination(request, signal) {
    if (request.destination.address === SOLANA_USDC.address) return;
    if (typeof destinationVerifier?.inspect !== 'function') fail('DESTINATION_TOKEN_INSPECTION_REQUIRED');
    const result = await destinationVerifier.inspect(request, signal);
    if (result?.ready !== true) fail('DESTINATION_TOKEN_UNSUPPORTED');
  }
  async function preflight(plan, action, signal) {
    const t = terms(plan, action, pins);
    return checks.runBound(async (inner) => {
      if (now() >= plan.expiresAtMs) fail("EXECUTION_REVIEW_EXPIRED");
      await verifyRelayOrderSignature(t.meta, pins, expanded(plan));
      await inspectDestination(plan, inner);
      const [chain, latest] = await read(
        [
          { method: "eth_chainId", params: [] },
          { method: "eth_getBlockByNumber", params: ["latest", false] },
        ],
        inner,
      );
      if (chain !== "0x2105") fail("EXECUTION_CHAIN_MISMATCH");
      const header = p.blockHeader(latest, now()),
        block = { blockHash: header.hash, requireCanonical: true };
      if (t.usdc && !eq(plan.source.address, BASE_V3.usdc)) await tokenIdentity(read, plan.source, block, inner, t.meta.tokenIdentity);
      const futureDeposit = t.usdc && t.approval ? plan.actions.at(-1) : null,
        depositTerms = futureDeposit ? terms(plan, futureDeposit, pins) : null,
        simulationCanRunNow = !t.usdc || t.approval;
      const simulationCalls = [
        { method: "eth_call", params: [t.tx, block] },
        { method: "eth_estimateGas", params: [t.tx, block] },
      ];
      const snapshots = await Promise.allSettled([
        identities(block, plan.sender, inner, t.usdc && eq(plan.source.address, BASE_V3.usdc), [
          ...(t.usdc ? [
            p.call(plan.source.address, "0x70a08231" + word(plan.sender), block),
            p.call(plan.source.address, "0xdd62ed3e" + word(plan.sender) + word(RELAY_DEPOSITORY), block),
          ] : []),
          { method: "eth_getBalance", params: [plan.sender, block] },
          ...(simulationCanRunNow ? simulationCalls : []),
        ]),
        reserves([t.tx, ...(futureDeposit ? [futureDeposit.payload.transaction] : [])], header, block, inner),
      ]);
      // A whole-operation fallback must await every primary read. A semantic
      // failure from either snapshot must never be hidden by a transient sibling.
      const failures = snapshots.filter(snapshot => snapshot.status === 'rejected');
      if (failures.length) {
        const semantic = failures.find(snapshot => !['READINESS_RPC_BUSY', 'READINESS_RPC_TRANSPORT_UNAVAILABLE'].includes(snapshot.reason?.code));
        throw (semantic ?? failures[0]).reason;
      }
      const [state, feeReserves] = snapshots.map(snapshot => snapshot.value);
      if (t.usdc) {
        if (p.integerWord(state[0]) < uint(plan.amountRaw)) fail("EXECUTION_TOKEN_BALANCE_INSUFFICIENT");
        if (!t.approval && p.integerWord(state[1]) < uint(plan.amountRaw)) fail("EXECUTION_APPROVAL_REQUIRED");
      }
      const balanceIndex = t.usdc ? 2 : 0, balance = state[balanceIndex];
      // USDC deposit simulation remains gated by an actually observed sufficient allowance.
      const [simulated, estimate] = simulationCanRunNow ? state.slice(balanceIndex + 1) : await read(simulationCalls, inner);
      if (
        simulated !== (t.approval ? "0x" + word(1) : "0x") ||
        p.quantity(estimate) > t.gas || p.quantity(estimate) < 21000n
      ) fail("EXECUTION_SIMULATION_FAILED");
      if (feeReserves[0] > t.cap || (depositTerms && feeReserves[1] > depositTerms.cap))
        fail("EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED");
      const total = feeReserves.reduce((sum, fee) => sum + fee, 0n);
      if (total > t.planCap) fail("EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED");
      if (p.quantity(balance) < (t.usdc ? 0n : uint(plan.amountRaw)) + total)
        fail("EXECUTION_NATIVE_BALANCE_INSUFFICIENT");
      const [canonical] = await read(
        [{ method: "eth_getBlockByNumber", params: [header.number, false] }],
        inner,
      );
      if (
        canonical?.hash !== header.hash ||
        now() >= plan.expiresAtMs ||
        now() - header.timestamp > 12000
      )
        fail("EXECUTION_REORG");
      return {
        ready: true,
        nativeFeeReserveRaw: total.toString(),
        blockHash: header.hash,
        blockNumber: header.number,
        observedAtMs: now(),
      };
    }, signal);
  }
  return {
    validatePins() {
      pinsFor(pins);
      if (typeof destinationVerifier?.confirm !== "function")
        fail("EXECUTION_PINS_REQUIRED");
    },
    preflight,
    async release({ record }, signal) {
      if (!record || record.claimedActionId !== null || record.nextAction !== 1 ||
        !usdcSource(record.plan) || record.plan?.actions?.length !== 2 || record.plan.actions[0]?.id !== approvalId(record.plan) ||
        record.plan.actions[1]?.id !== depositId(record.plan) ||
        !Array.isArray(record.submissions) || record.submissions.length !== 1 ||
        record.submissions[0]?.actionId !== approvalId(record.plan)) return { ready: false };
      const result = await this.confirm(record.plan, record.plan.actions[0], record.submissions[0].hash, signal);
      return { ready: result.success === true && !result.confirmedFailure && !!result.receipt &&
        !result.destinationReceipt && !result.destinationCredit };
    },
    async prepare(request, signal) {
      pinsFor(pins);
      const started = now();
      return checks.runBound(async (inner) => {
        await inspectDestination(request, inner);
        const raw = await json(
          "/quote/v2",
          {
            method: "POST",
            body: JSON.stringify({
              user: request.sender,
              recipient: request.recipient,
              refundTo: request.sender,
              originChainId: 8453,
              destinationChainId: 792703809,
              originCurrency: request.source.address,
              destinationCurrency: request.destination.address,
              amount: request.amountRaw,
              tradeType: "EXACT_INPUT",
              slippageTolerance: String(request.slippageBps),
              indicativeQuote: false,
              useDepositAddress: false,
              includeProtocolData: true,
            }),
          },
          inner,
        );
        const meta = verifyRelayOrder(raw, request, pins, now());
        await verifyRelayOrderSignature(meta, pins, expanded(request));
        const [chain, latest, priority] = await read(
          [
            { method: "eth_chainId", params: [] },
            { method: "eth_getBlockByNumber", params: ["latest", false] },
            { method: "eth_maxPriorityFeePerGas", params: [] },
          ],
          inner,
        );
        if (chain !== "0x2105") fail("EXECUTION_CHAIN_MISMATCH");
        const header = p.blockHeader(latest, now()),
          block = { blockHash: header.hash, requireCanonical: true };
        const usdc = usdcSource(request);
        if (usdc && !eq(request.source.address, BASE_V3.usdc)) meta.tokenIdentity = await tokenIdentity(read, request.source, block, inner);
        const tokenState = await identities(block, request.sender, inner, usdc && eq(request.source.address, BASE_V3.usdc), usdc ? [
          p.call(request.source.address, "0x70a08231" + word(request.sender), block),
          p.call(request.source.address, "0xdd62ed3e" + word(request.sender) + word(RELAY_DEPOSITORY), block),
        ] : [{ method: 'eth_getBalance', params: [request.sender, block] }]);
        let needsApproval = false;
        if (usdc) {
          if (p.integerWord(tokenState[0]) < uint(request.amountRaw)) fail("EXECUTION_TOKEN_BALANCE_INSUFFICIENT");
          needsApproval = p.integerWord(tokenState[1]) < uint(request.amountRaw);
        } else if (p.quantity(tokenState[0]) < uint(request.amountRaw)) {
          fail('EXECUTION_NATIVE_BALANCE_INSUFFICIENT');
        }
        const tip = p.quantity(priority),
          maxFee = header.baseFee * 2n + tip;
        const tx = {
          from: request.sender,
          to: RELAY_DEPOSITORY,
          chainId: "0x2105",
          type: "0x2",
          data: depositData(request, meta.orderId),
          value: usdc ? "0x0" : hex(uint(request.amountRaw)),
          gas: hex(p.MAX_GAS),
          maxFeePerGas: hex(maxFee),
          maxPriorityFeePerGas: hex(tip),
          accessList: [],
        };
        // No state override: an unfunded allowance cannot truthfully simulate the deposit.
        const [sim, estimate] = needsApproval ? [null, hex(USDC_DEPOSIT_GAS)] : await read(
          [
            { method: "eth_call", params: [tx, block] },
            { method: "eth_estimateGas", params: [tx, block] },
          ],
          inner,
        );
        if (!needsApproval && sim !== "0x") fail("EXECUTION_SIMULATION_FAILED");
        const gas = p.quantity(estimate);
        if (
          gas < 21000n ||
          (gas * 3n) / 2n > p.MAX_GAS ||
          maxFee === 0n ||
          maxFee > p.MAX_FEE
        )
          fail("EXECUTION_FEE_BOUND");
        tx.gas = needsApproval ? hex(USDC_DEPOSIT_GAS) : hex((gas * 3n + 1n) / 2n);
        let approvalTx;
        if (needsApproval) {
          approvalTx = { ...tx, to: request.source.address, data: relayUsdcApprovalData(request.amountRaw), gas: hex(p.MAX_GAS) };
          const [approved, estimateApproval] = await read([
            { method: "eth_call", params: [approvalTx, block] },
            { method: "eth_estimateGas", params: [approvalTx, block] },
          ], inner);
          const estimated = p.quantity(estimateApproval);
          if (approved !== "0x" + word(1) || estimated < 21000n || (estimated * 3n + 1n) / 2n > p.MAX_GAS)
            fail("EXECUTION_SIMULATION_FAILED");
          approvalTx.gas = hex((estimated * 3n + 1n) / 2n);
        }
        const [rawDepositReserve, rawApprovalReserve = 0n] = await reserves([tx, ...(approvalTx ? [approvalTx] : [])], header, block, inner),
          rawNative = rawDepositReserve + rawApprovalReserve;
        const budget = request.nativeFeeBudgets?.find(x => x.chainId === BASE_V3.chainId);
        if (!budget || budget.maxAmountRaw !== null && rawNative > uint(budget.maxAmountRaw)) fail('EXECUTION_NATIVE_BUDGET_EXCEEDED');
        // Review a fixed, bounded allowance for changing L1/operator estimates.
        // User budgets cap the headroom; action allocations sum exactly to it.
        const padded = (rawNative * 125n + 99n) / 100n,
          userCap = budget.maxAmountRaw === null ? padded : uint(budget.maxAmountRaw), native = padded < userCap ? padded : userCap,
          depositReserve = rawDepositReserve + (native - rawNative) * rawDepositReserve / rawNative,
          approvalReserve = native - depositReserve;
        const pricingValidUntilMs = Math.min(
          started + 15000,
          request.deadlineMs,
          meta.orderData.output.deadline * 1000,
        );
        const action = {
          id: depositId(request),
          chainId: BASE_V3.chainId,
          payload: {
            type: "EVM_TRANSACTION",
            transaction: tx,
            ...(usdc ? { nativeFeeCapRaw: depositReserve.toString() } : {}),
            relay: {
              requestId: meta.requestId,
              orderId: meta.orderId,
              orderData: meta.orderData,
              ...(meta.orderSignature ? { orderSignature: meta.orderSignature } : {}),
              ...(meta.tokenIdentity ? { tokenIdentity: meta.tokenIdentity } : {}),
            },
          },
        };
        const plan = {
          routeId: `relay:${randomUUID()}`,
          quoteIds: [`relay:${meta.requestId}`],
          source: request.source,
          destination: request.destination,
          sender: request.sender,
          recipient: request.recipient,
          amountRaw: request.amountRaw,
          minimumOutRaw: meta.minimumOutRaw,
          expiresAtMs: Math.min(
            started + (usdc ? 90000 : 60000),
            request.deadlineMs,
            meta.orderData.output.deadline * 1000,
          ),
          nativeCosts: [
            { chainId: BASE_V3.chainId, amountRaw: native.toString() },
          ],
          actions: approvalTx ? [{ ...action, id: approvalId(request), payload: { ...action.payload, transaction: approvalTx, nativeFeeCapRaw: approvalReserve.toString() } }, action] : [action],
        };
        const decimal = (v) => {
          if (
            typeof v !== "string" ||
            !/^-?(?:0|[1-9][0-9]{0,18})(?:\.[0-9]{1,18})?$/.test(v)
          )
            fail("RELAY_ECONOMICS_INVALID");
          const negative = v[0] === "-";
          const [whole, fraction = ""] = (negative ? v.slice(1) : v).split(".");
          return (
            (negative ? -1n : 1n) *
            (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0")))
          );
        };
        const abs = (v) => (v < 0n ? -v : v),
          ceil = (n, d) => (n + d - 1n) / d;
        const inputUsd = decimal(raw.details.currencyIn.amountUsd),
          gasAmount = uint(raw.fees?.gas?.amount),
          gasUsd = decimal(raw.fees.gas.amountUsd);
        if (
          raw.fees.gas.currency?.chainId !== 8453 ||
          raw.fees.gas.currency.address !== BASE_V3.native ||
          raw.fees.gas.currency.decimals !== 18 ||
          inputUsd <= 0n ||
          gasAmount === 0n ||
          gasUsd < 0n ||
          raw.fees.app.amount !== "0"
        )
          fail("RELAY_ECONOMICS_INVALID");
        const feeUsd =
          ["execution", "relay", "app"].reduce(
            (sum, k) =>
              sum + abs(decimal(raw.details.expandedPriceImpact?.[k]?.usd)),
            0n,
          ) + ceil(gasUsd * native, gasAmount);
        const feeBps = Number(ceil(feeUsd * 10000n, inputUsd)),
          priceImpactBps = Number(
            ceil(
              abs(decimal(raw.details.swapImpact.percent)) * 100n,
              10n ** 18n,
            ),
          );
        enforceEconomicLimits(request, feeBps, priceImpactBps);
        return {
          plan,
          expectedOutRaw: meta.expectedOutRaw,
          minimumOutRaw: meta.minimumOutRaw,
          feeBps,
          priceImpactBps,
          pricingValidUntilMs,
          estimatedCompletionMs: 24000,
          quoteId: plan.quoteIds[0],
        };
      }, signal);
    },
    async confirm(plan, action, transactionHash, signal) {
      if (!hash(transactionHash)) fail("INVALID_TRANSACTION_HASH");
      const t = terms(plan, action, pins);
      await verifyRelayOrderSignature(t.meta, pins, expanded(plan));
      const expected = transactionHash.toLowerCase();
      const proofKey = memoKey([plan, action, expected, pins, basePins]);
      // Probe receipt capability before launching either proof. Archive-gated
      // endpoints can fail over without repeating an independent Solana proof.
      const [r] = await checks.runBound(inner =>
        read([{ method: "eth_getTransactionReceipt", params: [expected] }], inner), signal);
      const sourceWork = checks.runBound(async (inner) => {
        const [chain, tx, head] = await read(
          [
            { method: "eth_chainId", params: [] },
            { method: "eth_getTransactionByHash", params: [expected] },
            { method: "eth_blockNumber", params: [] },
          ],
          inner,
        );
        if (chain !== "0x2105") fail("EXECUTION_CHAIN_MISMATCH");
        if (!r || !tx) throw new ExecutionEngineError("RECEIPT_PENDING", 202);
        if (
          !eq(r.transactionHash, expected) ||
          !eq(tx.hash, expected) ||
          !hash(r.blockHash) ||
          !eq(tx.blockHash, r.blockHash) ||
          tx.blockNumber !== r.blockNumber ||
          !eq(tx.from, plan.sender) ||
          !eq(tx.to, t.tx.to) ||
          tx.input !== t.tx.data ||
          p.quantity(tx.value) !== p.quantity(t.tx.value) ||
          p.quantity(tx.chainId) !== 8453n ||
          tx.type !== "0x2" ||
          r.type !== "0x2" ||
          !eq(r.from, tx.from) ||
          !eq(r.to, tx.to) ||
          !Array.isArray(tx.accessList) ||
          tx.accessList.length ||
          p.quantity(tx.gas) > t.gas ||
          p.quantity(tx.maxFeePerGas) > t.maxFee ||
          p.quantity(tx.maxPriorityFeePerGas) > t.priority
        )
          fail("EXECUTION_RECEIPT_BINDING_MISMATCH");
        const height = p.quantity(r.blockNumber),
          confirmations = p.quantity(head) - height + 1n;
        if (
          height > BigInt(Number.MAX_SAFE_INTEGER) ||
          confirmations > BigInt(Number.MAX_SAFE_INTEGER)
        )
          fail("EXECUTION_RECEIPT_INVALID");
        if (confirmations < (t.approval ? 12n : 1n))
          throw new ExecutionEngineError("RECEIPT_PENDING", 202);
        const [canonical] = await read(
          [{ method: "eth_getBlockByNumber", params: [r.blockNumber, false] }],
          inner,
        );
        const index = p.quantity(r.transactionIndex);
        if (
          !eq(canonical?.hash, r.blockHash) ||
          canonical.number !== r.blockNumber ||
          index !== p.quantity(tx.transactionIndex) ||
          index > 4095n ||
          !Array.isArray(canonical.transactions) ||
          !eq(canonical.transactions[Number(index)], expected) ||
          canonical.transactions.filter((v) => eq(v, expected)).length !== 1
        )
          fail("EXECUTION_REORG");
        const receipt = {
          chainId: BASE_V3.chainId,
          transactionHash,
          blockNumberRaw: height.toString(),
          blockHash: r.blockHash.toLowerCase(),
          observedAtMs: now(),
          confirmations: Number(confirmations),
        };
        if (r.status === "0x0") {
          if (confirmations < 12n) throw new ExecutionEngineError("RECEIPT_PENDING", 202);
          const [last] = await read(
            [
              {
                method: "eth_getBlockByNumber",
                params: [r.blockNumber, false],
              },
            ],
            inner,
          );
          if (
            !eq(last?.hash, r.blockHash) ||
            last.number !== r.blockNumber ||
            !Array.isArray(last.transactions) ||
            !eq(last.transactions[Number(index)], expected) ||
            last.transactions.filter((v) => eq(v, expected)).length !== 1
          )
            fail("EXECUTION_REORG");
          return { receipt, confirmedFailure: true };
        }
        if (r.status !== "0x1") fail("EXECUTION_RECEIPT_INVALID");
        const block = {
          blockHash: r.blockHash.toLowerCase(),
          requireCanonical: true,
        };
        const fingerprint = memoKey([r, tx]);
        const cached = !t.approval && memoGet(sourceProofs, proofKey);
        if (cached?.fingerprint === fingerprint) {
          // The expensive historical identity/fee proof was already checked at
          // this exact immutable block. Recheck canonical membership again now.
          const [last] = await read([{ method: 'eth_getBlockByNumber', params: [r.blockNumber, false] }], inner);
          if (!eq(last?.hash, r.blockHash) || last.number !== r.blockNumber ||
            !Array.isArray(last.transactions) || !eq(last.transactions[Number(index)], expected) ||
            last.transactions.filter(value => eq(value, expected)).length !== 1) fail('EXECUTION_REORG');
          return { receipt: { ...receipt, actualNativeFeeRaw: cached.actualNativeFeeRaw } };
        }
        await identities(block, plan.sender, inner, t.usdc && eq(plan.source.address, BASE_V3.usdc));
        if (t.usdc && !eq(plan.source.address, BASE_V3.usdc)) await tokenIdentity(read, plan.source, block, inner, t.meta.tokenIdentity);
        const gas = p.quantity(r.gasUsed),
          effective = p.quantity(r.effectiveGasPrice),
          l1 = p.quantity(r.l1Fee);
        const [op, last] = await read(
          [
            p.call(p.ORACLE, "0x275aedd2" + word(gas), block),
            { method: "eth_getBlockByNumber", params: [r.blockNumber, false] },
          ],
          inner,
        );
        const operator = p.integerWord(op),
          actual = gas * effective + l1 + operator;
        if (
          gas < 21000n ||
          gas > p.quantity(tx.gas) ||
          effective === 0n ||
          effective > p.quantity(tx.maxFeePerGas) ||
          actual > t.cap ||
          (r.operatorFee !== undefined &&
            p.quantity(r.operatorFee) !== operator) ||
          !eq(last?.hash, r.blockHash) ||
          last.number !== r.blockNumber ||
          !Array.isArray(last.transactions) ||
          !eq(last.transactions[Number(index)], expected) ||
          last.transactions.filter((v) => eq(v, expected)).length !== 1
        )
          fail("EXECUTION_ACTUAL_FEE_EXCEEDED");
        const eventData =
          "0x" +
          word(plan.sender) +
          (t.usdc ? word(plan.source.address) : "") +
          word(uint(plan.amountRaw)) +
          t.meta.orderId.slice(2);
        if (
          !Array.isArray(r.logs) ||
          r.logs.length > 512 ||
          r.logs.filter(
            (l) =>
              eq(l.address, t.approval ? plan.source.address : RELAY_DEPOSITORY) &&
              l.removed === false &&
              eq(l.transactionHash, expected) &&
              eq(l.blockHash, r.blockHash) &&
              l.blockNumber === r.blockNumber &&
              Array.isArray(l.topics) &&
              l.topics.length === (t.approval ? 3 : 1) &&
              eq(l.topics[0], t.approval ? APPROVAL_EVENT : t.usdc ? USDC_DEPOSIT_EVENT : DEPOSIT_EVENT) &&
              (!t.approval || (eq(l.topics[1], "0x" + word(plan.sender)) && eq(l.topics[2], "0x" + word(RELAY_DEPOSITORY)))) &&
              eq(l.data, t.approval ? "0x" + word(uint(plan.amountRaw)) : eventData),
          ).length !== 1
        )
          fail(t.approval ? "RELAY_APPROVAL_EVENT_REQUIRED" : "RELAY_DEPOSIT_EVENT_REQUIRED");
        if (t.usdc && !t.approval && !eq(plan.source.address, BASE_V3.usdc)) exactTokenDeposit(r.logs, r, plan.source, plan.sender, RELAY_DEPOSITORY, plan.amountRaw);
        if (!t.approval) memoPut(sourceProofs, proofKey, { fingerprint, actualNativeFeeRaw: actual.toString() });
        return {
          receipt: { ...receipt, actualNativeFeeRaw: actual.toString() },
        };
      }, signal).catch(error => { sourceProofs.delete(proofKey); throw error; });
      const destinationWork = t.approval ? Promise.resolve(null) : checks.runBound(async inner => {
        const tried = new Set();
        const observe = async signature => {
          if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || tried.has(signature)) return null;
          tried.add(signature);
          try {
            const observing = typeof destinationVerifier.observe === 'function';
            const result = await (observing ? destinationVerifier.observe : destinationVerifier.confirm)
              .call(destinationVerifier, plan, transactionHash, signature, inner);
            if (result?.destinationReceipt && result.destinationCredit) {
              const commitment = result.destinationReceipt.commitment ?? (observing ? null : 'finalized');
              if (!['confirmed', 'finalized'].includes(commitment)) fail('DESTINATION_EVIDENCE_INVALID');
              return { result, commitment, signature };
            }
          } catch (error) {
            if (!['DESTINATION_RECEIPT_PENDING', 'RECEIPT_PENDING'].includes(error?.code)) throw error;
          }
          return null;
        };
        // A provider signature is only a discovery hint. Always obtain a fresh
        // independent Solana proof; never reuse its amount, status or finality.
        const known = memoGet(deliverySignatures, proofKey);
        if (known) {
          const proof = await observe(known);
          if (proof) return proof;
          deliverySignatures.delete(proofKey);
        }
        const status = await json(`/intents/status/v3?requestId=${t.meta.requestId}`, { method: 'GET' }, inner);
        if (status.originChainId !== 8453 || status.destinationChainId !== 792703809 ||
          !Array.isArray(status.inTxHashes) || !status.inTxHashes.some(value => eq(value, expected)) ||
          !Array.isArray(status.txHashes) || status.txHashes.length > 8)
          throw new ExecutionEngineError('DESTINATION_RECEIPT_PENDING', 202);
        for (const signature of status.txHashes) {
          const proof = await observe(signature);
          if (proof) return proof;
        }
        throw new ExecutionEngineError('DESTINATION_RECEIPT_PENDING', 202);
      }, signal);
      // Never begin a fresh endpoint attempt while another branch is outstanding,
      // and never hide invalid destination evidence behind source availability.
      const settled = await Promise.allSettled([sourceWork, destinationWork]);
      if (settled[0].status === 'fulfilled' && settled[0].value.confirmedFailure)
        return { success: false, routeId: plan.routeId, actionId: action.id, transactionHash,
          receipt: settled[0].value.receipt, confirmedFailure: true };
      const pendingCodes = ['RECEIPT_PENDING', 'DESTINATION_RECEIPT_PENDING'];
      const transientCodes = ['READINESS_RPC_BUSY', 'READINESS_RPC_TRANSPORT_UNAVAILABLE', 'READINESS_RPC_HISTORY_UNAVAILABLE'];
      const failures = settled.filter(value => value.status === 'rejected');
      const semantic = failures.find(value => !pendingCodes.includes(value.reason?.code) && !transientCodes.includes(value.reason?.code));
      if (semantic) throw semantic.reason;
      if (settled[0].status === 'rejected') throw settled[0].reason;
      const source = settled[0].value;
      const base = { success: false, routeId: plan.routeId, actionId: action.id, transactionHash, receipt: source.receipt };
      if (source.confirmedFailure) return { ...base, confirmedFailure: true };
      if (t.approval) return { ...base, success: true };
      const destination = settled[1].status === 'fulfilled' ? settled[1].value : null;
      if (destination) memoPut(deliverySignatures, proofKey, destination.signature);
      if (source.receipt.confirmations >= 12 && destination?.commitment === 'finalized')
        return { ...base, ...destination.result, success: true, routeId: plan.routeId,
          actionId: action.id, transactionHash, receipt: source.receipt };
      const progress = { routeId: plan.routeId, actionId: action.id, sourceTransactionHash: expected,
        stage: destination ? 'DESTINATION_CONFIRMED' : 'SOURCE_CONFIRMED', observedAtMs: now(),
        sourceConfirmations: source.receipt.confirmations, requiredSourceConfirmations: 12,
        ...(destination ? { destination: { chainId: SOLANA_USDC.chainId,
          transactionHash: destination.result.destinationReceipt.transactionHash,
          asset: structuredClone(destination.result.destinationCredit.asset),
          recipient: destination.result.destinationCredit.recipient, amountRaw: destination.result.destinationCredit.amountRaw,
          commitment: destination.commitment } } : {}) };
      const pending = new ExecutionEngineError(source.receipt.confirmations < 12 ? 'RECEIPT_PENDING' : 'DESTINATION_RECEIPT_PENDING', 202);
      pending.progress = progress;
      throw pending;
    },
  };
}
