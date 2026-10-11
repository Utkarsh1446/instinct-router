/** Local v1 Relay order commitment. This hashes terms; it does not attest solver delivery. */
import { hashStruct } from "viem";
import { fail } from "./base-execution-checks.mjs";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function solanaBytes(address) {
  if (
    typeof address !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
  )
    fail("RELAY_ORDER_INVALID");
  let value = 0n;
  for (const char of address)
    value = value * 58n + BigInt(alphabet.indexOf(char));
  let hex = value === 0n ? "" : value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  hex = "00".repeat(address.match(/^1*/)[0].length) + hex;
  if (hex.length !== 64) fail("RELAY_ORDER_INVALID");
  return "0x" + hex;
}
const address = (value, chain) =>
  chain === "solana"
    ? solanaBytes(value)
    : chain === "base" && /^0x[0-9a-fA-F]{40}$/.test(value)
      ? value.toLowerCase()
      : fail("RELAY_ORDER_INVALID");
const types = {
  Order: [
    { name: "version", type: "string" },
    { name: "solverChainId", type: "string" },
    { name: "solver", type: "address" },
    { name: "salt", type: "uint256" },
    { name: "inputs", type: "Input[]" },
    { name: "output", type: "Output" },
    { name: "fees", type: "Fee[]" },
  ],
  Input: [
    { name: "payment", type: "InputPayment" },
    { name: "refunds", type: "InputRefund[]" },
  ],
  InputPayment: [
    { name: "chainId", type: "string" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
    { name: "weight", type: "uint256" },
  ],
  InputRefund: [
    { name: "chainId", type: "string" },
    { name: "recipient", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "minimumAmount", type: "uint256" },
    { name: "deadline", type: "uint32" },
    { name: "extraData", type: "bytes" },
  ],
  Output: [
    { name: "chainId", type: "string" },
    { name: "payments", type: "OutputPayment[]" },
    { name: "deadline", type: "uint32" },
    { name: "calls", type: "bytes[]" },
    { name: "extraData", type: "bytes" },
  ],
  OutputPayment: [
    { name: "recipient", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "minimumAmount", type: "uint256" },
    { name: "expectedAmount", type: "uint256" },
  ],
  Fee: [
    { name: "recipientChainId", type: "string" },
    { name: "recipient", type: "bytes" },
    { name: "currencyChainId", type: "string" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
  ],
};
export function computeRelayOrderId(order) {
  try {
    return hashStruct({
      types,
      primaryType: "Order",
      data: {
        ...order,
        salt: BigInt(order.salt),
        inputs: order.inputs.map((input) => ({
          payment: {
            ...input.payment,
            amount: BigInt(input.payment.amount),
            weight: BigInt(input.payment.weight),
            currency: address(input.payment.currency, input.payment.chainId),
          },
          refunds: input.refunds.map((r) => ({
            ...r,
            minimumAmount: BigInt(r.minimumAmount),
            recipient: address(r.recipient, r.chainId),
            currency: address(r.currency, r.chainId),
          })),
        })),
        output: {
          ...order.output,
          payments: order.output.payments.map((p) => ({
            ...p,
            minimumAmount: BigInt(p.minimumAmount),
            expectedAmount: BigInt(p.expectedAmount),
            recipient: address(p.recipient, order.output.chainId),
            currency: address(p.currency, order.output.chainId),
          })),
        },
        fees: order.fees.map((f) => ({
          ...f,
          amount: BigInt(f.amount),
          recipient: address(f.recipient, f.recipientChainId),
          currency: address(f.currency, f.currencyChainId),
        })),
      },
    });
  } catch {
    fail("RELAY_ORDER_INVALID");
  }
}
