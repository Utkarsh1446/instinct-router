import test from "node:test";
import assert from "node:assert/strict";
import { computeRelayOrderId, solanaBytes } from "../src/relay-order.mjs";
import {
  verifyRelayOrder,
  relayDepositData,
  RELAY_DEPOSITORY,
} from "../src/relay-base-sol-execution.mjs";
const sender = "0xd627e435b88c1bf00244f7f3acd14b7f6db64b2e",
  recipient = "47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT",
  native = "0x" + "0".repeat(40),
  usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pins = {
  solver: "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
  depository: {
    codeSha256:
      "e1aba2f59c0b4f5838d6f283db6e09631ef58f558107b7d42000c7f1252d1eda",
    owner: "0xf61a305199fa1135d76ffab3752d42f55cbd775a",
    allocator: "0x63c1d3e9c646184529c5694630a01c00df171b56",
  },
};
const request = {
  source: { chainId: 'eip155:8453', address: native, decimals: 18 },
  destination: { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: usdc, decimals: 6 },
  sender,
  recipient,
  amountRaw: "50000000000000",
  slippageBps: 50,
};
function quote() {
  const deadline = 1700604800;
  const order = {
    version: "v1",
    solverChainId: "base",
    solver: pins.solver,
    salt: "0x" + "11".repeat(32),
    inputs: [
      {
        payment: {
          chainId: "base",
          currency: native,
          amount: request.amountRaw,
          weight: "1",
        },
        refunds: [
          {
            chainId: "base",
            recipient: sender,
            currency: native,
            minimumAmount: "0",
            deadline,
            extraData:
              "0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
          },
          {
            chainId: "solana",
            recipient,
            currency: usdc,
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
          currency: usdc,
          minimumAmount: "99500",
          expectedAmount: "100000",
        },
      ],
      calls: [],
      deadline,
      extraData: "0x",
    },
    fees: [],
  };
  const orderId = computeRelayOrderId(order),
    requestId = "0x" + "22".repeat(32);
  const value = (chainId, address, decimals, amount, minimumAmount) => ({
    currency: { chainId, address, decimals },
    amount,
    minimumAmount,
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
          currency: native,
          amount: request.amountRaw,
          depository: RELAY_DEPOSITORY,
        },
      },
    },
    details: {
      sender,
      recipient,
      slippageTolerance: { total: "50" },
      currencyIn: value(8453, native, 18, request.amountRaw, request.amountRaw),
      currencyOut: value(792703809, usdc, 6, "100000", "99500"),
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
              chainId: 8453,
              from: sender,
              to: RELAY_DEPOSITORY,
              data: relayDepositData(sender, orderId),
              value: request.amountRaw,
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
test("local struct hash binds exact quote and native deposit independently of request ID", () => {
  const raw = quote();
  const result = verifyRelayOrder(raw, request, pins, 1700000000000);
  assert.equal(result.orderId, computeRelayOrderId(raw.protocol.v2.orderData));
  assert.notEqual(result.orderId, result.requestId);
  assert.equal(
    raw.steps[0].items[0].data.data.slice(-64),
    result.orderId.slice(2),
  );
});
test("quote amount/recipient tampering cannot keep original deposit commitment", () => {
  for (const change of [
    (r) =>
      (r.protocol.v2.orderData.output.payments[0].recipient =
        "11111111111111111111111111111111"),
    (r) =>
      (r.protocol.v2.orderData.output.payments[0].minimumAmount = "100000"),
    (r) => (r.protocol.v2.orderData.inputs[0].payment.amount = "1"),
  ]) {
    const raw = quote();
    change(raw);
    assert.throws(() => verifyRelayOrder(raw, request, pins, 1700000000000));
  }
});
test("attacker depository, unknown solver and refund recipient fail closed", () => {
  for (const change of [
    (r) => (r.steps[0].items[0].data.to = sender),
    (r) => (r.protocol.v2.orderData.solver = sender),
    (r) =>
      (r.protocol.v2.orderData.inputs[0].refunds[0].recipient = pins.solver),
  ]) {
    const raw = quote();
    change(raw);
    assert.throws(() => verifyRelayOrder(raw, request, pins, 1700000000000));
  }
});
test("protocol rejects extra fees, destination calls, unknown schema fields and stale order", () => {
  for (const change of [
    (r) => r.protocol.v2.orderData.fees.push({}),
    (r) => r.protocol.v2.orderData.output.calls.push("0x"),
    (r) => (r.protocol.v2.orderData.output.extra = "0x"),
    (r) => (r.protocol.v2.orderData.output.deadline = 1),
  ]) {
    const raw = quote();
    change(raw);
    assert.throws(() => verifyRelayOrder(raw, request, pins, 1700000000000));
  }
});
test("Solana byte encoding preserves leading zeros and rejects oversized keys", () => {
  assert.equal(solanaBytes("1".repeat(32)), "0x" + "00".repeat(32));
  assert.throws(() => solanaBytes("1".repeat(33)));
  assert.throws(() => solanaBytes("0".repeat(32)));
});
