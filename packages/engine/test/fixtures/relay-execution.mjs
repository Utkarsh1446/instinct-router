import { createHash } from "node:crypto";
import { BASE_V3 } from "@instinct/router-core";
import {
  fixture,
  pins as basePins,
  OWNER,
  BLOCKHASH,
  TXHASH,
  abi,
} from "./base-execution.mjs";
import {
  createRelayBaseSolExecution,
  SOLANA_USDC,
  RELAY_DEPOSITORY,
  relayDepositData,
  relayUsdcDepositData,
  relayUsdcApprovalData,
} from "../../src/relay-base-sol-execution.mjs";
import { computeRelayOrderId } from "../../src/relay-order.mjs";
const code = "0x" + "73".repeat(100),
  sha = createHash("sha256")
    .update(Buffer.from(code.slice(2), "hex"))
    .digest("hex");
export const relayPins = {
  solver: OWNER,
  depository: { codeSha256: sha, owner: OWNER, allocator: OWNER },
};
const recipient = "47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT";
export const relayRequest = (f, {sourceUsdc = false} = {}) => ({
  source: { chainId: BASE_V3.chainId, address: sourceUsdc ? BASE_V3.usdc : BASE_V3.native, decimals: sourceUsdc ? 6 : 18 },
  destination: SOLANA_USDC,
  sender: f.sender ?? OWNER,
  recipient,
  amountRaw: sourceUsdc ? "100000" : "50000000000000",
  slippageBps: 50,
  maxFeeBps: 9999,
  maxPriceImpactBps: 9999,
  deadlineMs: f.now() + 90000,
  nativeFeeBudgets: [
    { chainId: BASE_V3.chainId, maxAmountRaw: "10000000000000" },
  ],
});
export function relayQuote(f, options = {}) {
  const r = relayRequest(f, options),
    deadline = Math.floor(f.now() / 1000) + 604799,
    order = {
      version: "v1",
      solverChainId: "base",
      solver: OWNER,
      salt: "0x" + "11".repeat(32),
      inputs: [
        {
          payment: {
            chainId: "base",
            currency: r.source.address,
            amount: r.amountRaw,
            weight: "1",
          },
          refunds: [
            {
              chainId: "base",
              recipient: r.sender,
              currency: r.source.address,
              minimumAmount: "0",
              deadline,
              extraData:
                "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
            },
            {
              chainId: "solana",
              recipient,
              currency: SOLANA_USDC.address,
              minimumAmount: "0",
              deadline,
              extraData: "0x",
            },
          ],
        },
      ],
      output: {
        chainId: "solana",
        payments: [
          {
            recipient,
            currency: SOLANA_USDC.address,
            minimumAmount: "99500",
            expectedAmount: "100000",
          },
        ],
        calls: [],
        deadline,
        extraData: "0x",
      },
      fees: [],
    },
    orderId = computeRelayOrderId(order),
    requestId = "0x" + "22".repeat(32);
  const amount = (chainId, address, decimals, value, min, usd) => ({
    currency: { chainId, address, decimals },
    amount: value,
    minimumAmount: min,
    amountUsd: usd,
  });
  return {
    requestId,
    protocol: {
      v2: {
        hubType: "onchain",
        orderId,
        orderData: order,
        paymentDetails: {
          chainId: "base",
          depository: RELAY_DEPOSITORY,
          currency: r.source.address,
          amount: r.amountRaw,
        },
      },
    },
    details: {
      sender: r.sender,
      recipient,
      slippageTolerance: { total: "50" },
      currencyIn: amount(
        8453,
        r.source.address,
        r.source.decimals,
        r.amountRaw,
        r.amountRaw,
        "0.15",
      ),
      currencyOut: amount(
        792703809,
        SOLANA_USDC.address,
        6,
        "100000",
        "99500",
        "0.1",
      ),
      expandedPriceImpact: {
        execution: { usd: "-0.02" },
        relay: { usd: "-0.00001" },
        app: { usd: "0" },
      },
      swapImpact: { percent: "-0.1" },
    },
    fees: {
      gas: { currency: { chainId: 8453, address: BASE_V3.native, decimals: 18 }, amount: "1000000000000", amountUsd: "0.003" },
      app: { amount: "0" },
    },
    steps: [
      {
        id: "deposit",
        kind: "transaction",
        requestId,
        depositAddress: "",
        items: [
          {
            status: "incomplete",
            data: {
              from: r.sender,
              to: RELAY_DEPOSITORY,
              chainId: 8453,
              data: options.sourceUsdc ? relayUsdcDepositData(r.sender, r.amountRaw, orderId) : relayDepositData(r.sender, orderId),
              value: options.sourceUsdc ? "0" : r.amountRaw,
            },
            check: {
              method: "GET",
              endpoint: "/intents/status/v3?requestId=" + requestId,
            },
          },
        ],
      },
    ],
  };
}
export async function relayPrepared({ sender = OWNER, sourceUsdc = false, allowance = "0" } = {}) {
  const f = fixture();
  f.sender = sender;
  const raw = relayQuote(f, {sourceUsdc});
  const archived = new Map();
  let currentAllowance = BigInt(allowance), tokenBalance = 1000000n;
  let receiptMutation = (r) => r,
    apiMutation = (r) => r;
  const calls = [];
  const wire = async (url, init) => {
    if (url.startsWith("https://api.relay.link")) {
      if (url.endsWith("/quote/v2"))
        return new Response(JSON.stringify(apiMutation(raw)));
      return new Response(
        JSON.stringify({
          status: "success",
          originChainId: 8453,
          destinationChainId: 792703809,
          inTxHashes: [TXHASH],
          txHashes: ["3".repeat(88)],
        }),
      );
    }
    const batch = JSON.parse(init.body);
    calls.push(...batch);
    const custom = batch.filter(
      (c) =>
        (c.method === "eth_getCode" &&
          [RELAY_DEPOSITORY, sender].includes(c.params[0])) ||
        (c.method === "eth_call" && (c.params[0].to === RELAY_DEPOSITORY ||
          (c.params[0].to === BASE_V3.usdc && /^0x(?:70a08231|dd62ed3e|095ea7b3)/.test(c.params[0].data)))),
    );
    const other = batch.filter((c) => !custom.includes(c));
    const rows = other.length
      ? await (
          await f.wire(url, { ...init, body: JSON.stringify(other) })
        ).json()
      : [];
    for (const c of custom) {
      const d = c.params[0]?.data;
      rows.push({
        jsonrpc: "2.0",
        id: c.id,
        result:
          c.method === "eth_getCode"
            ? c.params[0] === sender
              ? "0x"
              : code
            : d === "0x8da5cb5b" || d === "0xaa5dcecc"
              ? abi(BigInt(OWNER))
              : d?.startsWith("0x70a08231") ? abi(tokenBalance)
              : d?.startsWith("0xdd62ed3e") ? abi(currentAllowance)
              : d?.startsWith("0x095ea7b3") ? abi(1)
              : "0x",
      });
    }
    for (const row of rows) {
      const call = other.find((c) => c.id === row.id);
      if (call?.method === "eth_getBlockByNumber" && row.result && archived.size) row.result.transactions = [...archived.keys()];
      if (call?.method === "eth_getTransactionByHash") row.result = archived.get(call.params[0]) ?? null;
      if (call?.method === "eth_getTransactionReceipt" && row.result) {
        const transaction = archived.get(call.params[0]);
        if (!transaction) { row.result = null; continue; }
        const approved = transaction.input.startsWith("0x095ea7b3");
        row.result.transactionHash = transaction.hash;
        row.result.transactionIndex = transaction.transactionIndex;
        row.result.to = transaction.to;
        row.result.from = sender;
        row.result.logs = [
          {
            address: RELAY_DEPOSITORY,
            transactionHash: transaction.hash,
            blockHash: BLOCKHASH,
            blockNumber: "0x1234",
            removed: false,
            logIndex: "0x0",
            topics: [
              "0x8032066556caf3967d8fec4ad22a2d9e1e9576556b2903a0fcd5b1fd201e3477",
            ],
            data: abi(
              BigInt(sender),
              50000000000000n,
              BigInt(raw.protocol.v2.orderId),
            ),
          },
        ];
        if (sourceUsdc) {
          row.result.logs[0].data = abi(BigInt(sender), BigInt(BASE_V3.usdc), 100000n, BigInt(raw.protocol.v2.orderId));
          row.result.logs[0].topics = ["0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1"];
          if (approved) {
            row.result.logs[0].address = BASE_V3.usdc;
            row.result.logs[0].topics = ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", abi(BigInt(sender)), abi(BigInt(RELAY_DEPOSITORY))];
            row.result.logs[0].data = abi(100000n);
          }
        }
        row.result = receiptMutation(row.result, transaction);
      }
    }
    return new Response(JSON.stringify(rows));
  };
  const destinationVerifier = {
    confirm: async (_plan, _sourceHash, signature) => ({
      destinationCredit: { asset: SOLANA_USDC, recipient, amountRaw: "99500" },
      destinationReceipt: { proof: "independent-test-double", transactionHash: signature, commitment: 'finalized' },
    }),
  };
  const engine = createRelayBaseSolExecution({
    fetch: wire,
    now: f.now,
    pins: relayPins,
    basePins: basePins.base,
    destinationVerifier,
  });
  const result = await engine.prepare(
      relayRequest(f, {sourceUsdc}),
      new AbortController().signal,
    ),
    plan = result.plan,
    action = plan.actions[0];
  const baseSetTransaction = f.setTransaction;
  const setTransaction = (tx, hash = TXHASH) => {
    const transaction = { ...tx, hash, transactionIndex: archived.get(hash)?.transactionIndex ?? "0x" + archived.size.toString(16), input: tx.data, blockHash: BLOCKHASH, blockNumber: "0x1234" };
    delete transaction.data;
    archived.set(hash, transaction);
    baseSetTransaction(tx);
  };
  setTransaction(action.payload.transaction);
  // Retain the original fixture API while supporting separate approval/deposit archives.
  f.setTransaction = setTransaction;
  f.setAllowance = (amount) => { currentAllowance = BigInt(amount); };
  return {
    f,
    engine,
    plan,
    action,
    result,
    calls,
    wire,
    raw,
    setTransaction,
    setAllowance: (amount) => { currentAllowance = BigInt(amount); },
    setTokenBalance: (amount) => { tokenBalance = BigInt(amount); },
    basePins: basePins.base,
    pins: relayPins,
    setReceipt: (fn) => {
      receiptMutation = fn;
    },
    setApi: (fn) => {
      apiMutation = fn;
    },
  };
}
