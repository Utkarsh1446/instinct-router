import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  createQuoteService,
  createExecutionEngine,
} from "@instinct/router-engine";
import {
  createRouterApi,
  createFileExecutionStore,
} from "@instinct/router-server";
import { createRouterServerClient } from "@instinct/router-sdk/server";
import {
  createEvmWallet,
  createExecutionController,
} from "@instinct/router-sdk";
import { BASE_V3 } from "@instinct/router-core";
import { relayPrepared } from "../packages/engine/test/fixtures/relay-execution.mjs";
import { TXHASH } from "../packages/engine/test/fixtures/base-execution.mjs";

import { relayUsdcApprovalData, relayUsdcDepositData, RELAY_DEPOSITORY } from "../packages/engine/src/relay-base-sol-execution.mjs";
const APPROVAL_HASH = "0x" + "ab".repeat(32);

// Public test identity and entirely synthetic provider/RPC responses. Wallet
// sends only record a fixture transaction; HTTP reaches an ephemeral loopback API.
const account = privateKeyToAccount("0x" + "04".repeat(32)),
  sender = account.address.toLowerCase();
const solver = "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe";
const tokenSource = "Q4UmPB9hKMw3ERqksavS9oEpNo2eWG4ffkWg7wHa9j6",
  tokenDestination = "FZeGx9mDteLt17pYM6iYmHBmRVn2joyDeqexC1qSxT54";
const signature =
  "4LobeBPHwLz4nCWse5N8g2kxp97LwTWenFXztFeTH2aiMnkXx3irbwwdF2PPeaUNmnvAhqJqTR1gYHeATRUD7Pnv";
const solRpc = "https://solana-rpc.publicnode.com",
  tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const app = {
  id: "crosschain-integration",
  publishableKey: "crosschain_public_0123456789",
  serverKey: "crosschain_server_0123456789",
  allowedOrigins: ["https://integration.example"],
  rateLimitPerMinute: 1000,
};

async function harness(t) {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const dir = await mkdtemp(
    join(await realpath(tmpdir()), "router-crosschain-integration-"),
  );
  const f = await relayPrepared({ sender, sourceUsdc: true, allowance: "0" });
  let finalized = false,
    wrongRecipient = false,
    api,
    store,
    client,
    walletToken,
    sends = 0,
    messageProofs = 0;
  const walletMethods = [],
    solMethods = [],
    storageRows = new Map();
  const storage = {
    getItem: (key) => storageRows.get(key) ?? null,
    setItem: (key, value) => storageRows.set(key, value),
  };
  const input = {
    source: f.plan.source,
    destination: f.plan.destination,
    amount: "0.1",
    sender,
    recipient: f.plan.recipient,
    slippageBps: 50,
    maxFeeBps: 9999,
    maxPriceImpactBps: 9999,
    nativeFeeBudgets: [
      { chainId: BASE_V3.chainId, maxAmountRaw: "10000000000000" },
    ],
  };
  function payout() {
    const recipient = wrongRecipient ? solver : input.recipient;
    const balance = (accountIndex, owner, amount) => ({
      accountIndex,
      owner,
      mint: input.destination.address,
      programId: tokenProgram,
      uiTokenAmount: { decimals: 6, amount },
    });
    return {
      slot: 100,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [
            { pubkey: solver, signer: true },
            { pubkey: tokenSource, signer: false },
            { pubkey: tokenDestination, signer: false },
          ],
          instructions: [
            {
              programId: tokenProgram,
              parsed: {
                type: "transfer",
                info: {
                  source: tokenSource,
                  destination: tokenDestination,
                  authority: solver,
                  amount: "100000",
                },
              },
            },
            {
              programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
              parsed: f.raw.protocol.v2.orderId,
            },
          ],
        },
      },
      meta: {
        err: null,
        preTokenBalances: [
          balance(1, solver, "1000000"),
          balance(2, recipient, "0"),
        ],
        postTokenBalances: [
          balance(1, solver, "900000"),
          balance(2, recipient, "100000"),
        ],
      },
    };
  }
  const wire = async (url, init) => {
    if (url.startsWith("https://api.relay.link/intents/status/v3"))
      return new Response(
        JSON.stringify({
          status: "success",
          originChainId: 8453,
          destinationChainId: 792703809,
          inTxHashes: [TXHASH],
          txHashes: [signature],
        }),
      );
    if (url === solRpc || url === solRpc + "/") {
      const call = JSON.parse(init.body);
      solMethods.push(call.method);
      const status = {
        err: null,
        confirmations: null,
        slot: 100,
        confirmationStatus: "finalized",
      };
      let result;
      switch (call.method) {
        case "getGenesisHash":
          result = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
          break;
        case "getTransaction":
          result = finalized ? payout() : null;
          break;
        case "getSignatureStatuses":
          result = { value: [finalized ? status : null] };
          break;
        case "getBlock":
          result = { blockhash: solver, signatures: [signature] };
          break;
        default:
          throw Error(
            "Unexpected destination signing/broadcast/RPC: " + call.method,
          );
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: call.id, result }),
      );
    }
    return f.wire(url, init);
  };
  const provider = {
    on() {},
    async request({ method, params }) {
      walletMethods.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts")
        return [sender];
      if (method === "eth_chainId") return "0x2105";
      if (method === "personal_sign") {
        messageProofs++;
        assert.equal(params[1], sender);
        return account.signMessage({ message: { raw: params[0] } });
      }
      if (method === "eth_sendTransaction") {
        sends++;
        const hash = sends === 1 ? APPROVAL_HASH : TXHASH;
        f.setTransaction(params[0], hash);
        return hash;
      }
      throw Error("Unexpected wallet method: " + method);
    },
  };
  const wallet = createEvmWallet(provider);
  await wallet.connect();
  const close = async () => {
    if (api) {
      api.closeAllConnections();
      await new Promise((resolve) => api.close(resolve));
      api = undefined;
    }
    if (store) {
      await store.close();
      store = undefined;
    }
  };
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const start = async () => {
    store = await createFileExecutionStore({ directory: join(dir, "journal") });
    const engine = createExecutionEngine({
      fetch: wire,
      now: f.f.now,
      executionPins: {
        base: f.basePins,
        relay: { ...f.pins, solanaSolverSigners: [solver] },
      },
      rpcEndpoints: { base: [BASE_V3.rpc], solana: [solRpc] },
    });
    api = createRouterApi({
      service: createQuoteService({ fetch: wire }),
      apps: [app],
      execution: { engine, store },
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    client = createRouterServerClient({
      baseUrl: "http://127.0.0.1:" + api.address().port,
      serverKey: app.serverKey,
      fetch: async (url, init) => {
        const token = new Headers(init.headers).get("X-Router-Wallet-Token");
        if (token) walletToken = token;
        return globalThis.fetch(url, init);
      },
    });
    return createExecutionController({ client, wallet, storage });
  };
  return {
    input,
    fixture: f,
    advance: (ms) => { f.f.advance(ms); clock += ms; },
    start,
    close,
    client: () => client,
    auth: () => ({ walletToken }),
    store: () => store,
    sends: () => sends,
    messageProofs: () => messageProofs,
    finalize: () => {
      finalized = true;
    },
    wrongRecipient: () => {
      wrongRecipient = true;
    },
    solMethods,
    walletMethods,
  };
}

async function approve(f, c) {
  const config = await f.client().getConfig();
  assert.ok(config.execution.supportedRoutes.some(route =>
    route.source.address === BASE_V3.usdc && route.destination.chainId === f.input.destination.chainId));
  await c.proveOwnership();
  const review = await c.prepare(f.input);
  assert.equal(review.plan.actions.length, 2);
  assert.equal(review.nextAction, 0);
  assert.equal(review.plan.actions[0].id, "relay-usdc-approve");
  assert.equal(review.plan.actions[0].payload, undefined);
  const submitted = await c.execute(review, async (record, action) => {
    assert.equal(record.reviewHash, review.reviewHash);
    assert.equal(action.id, "relay-usdc-approve");
    const tx = action.payload.transaction;
    assert.equal(tx.from, sender);
    assert.equal(tx.to, BASE_V3.usdc);
    assert.equal(BigInt(tx.value), 0n);
    assert.equal(tx.data, relayUsdcApprovalData("100000"));
    assert.equal(BigInt("0x" + tx.data.slice(-64)), 100000n);
    return true;
  });
  assert.equal(submitted.status, "SUBMITTED");
  assert.equal(submitted.submissions[0].hash, APPROVAL_HASH);
  assert.equal(f.sends(), 1);
  return submitted;
}

async function readyDeposit(f, c) {
  const ready = await c.resume();
  assert.equal(ready.status, "READY");
  assert.equal(ready.nextAction, 1);
  assert.equal(ready.claimedActionId, null);
  assert.equal(ready.receipt, undefined, "An intermediate approval receipt cannot masquerade as the deposit receipt");
  assert.equal(ready.destinationReceipt, undefined);
  const recovery = c.getRecovery();
  assert.equal(recovery.phase, "REVIEW");
  assert.equal(recovery.transactionHash, undefined, "Verified action progress clears the approval hash");
  assert.equal(recovery.walletRttMs, undefined);
  assert.equal(f.sends(), 1, "Recovery must never send the next action automatically");
  return ready;
}

async function deposit(f, c, ready) {
  f.fixture.setAllowance("100000");
  const submitted = await c.execute(ready, async (record, action) => {
    assert.equal(record.nextAction, 1);
    assert.equal(action.id, "relay-usdc-deposit");
    const tx = action.payload.transaction;
    assert.equal(tx.from, sender);
    assert.equal(tx.to, RELAY_DEPOSITORY);
    assert.equal(BigInt(tx.value), 0n);
    assert.equal(tx.data, relayUsdcDepositData(sender, "100000", action.payload.relay.orderId));
    return true;
  });
  assert.equal(submitted.status, "SUBMITTED");
  assert.deepEqual(submitted.submissions.map(row => row.hash), [APPROVAL_HASH, TXHASH]);
  assert.equal(f.sends(), 2);
  return submitted;
}

test("Base USDC approval and deposit require separate explicit confirmations across durable restart; only exact finalized Solana credit completes", async t => {
  const f = await harness(t);
  let c = await f.start();
  await approve(f, c);
  await readyDeposit(f, c);
  await f.close();
  c = await f.start();
  await assert.rejects(c.resume(), error => error.code === "WALLET_SESSION_REQUIRED");
  await c.proveOwnership();
  let ready = await readyDeposit(f, c);
  assert.equal(f.messageProofs(), 2);
  // Approval receipt alone cannot replace the fresh current allowance read.
  await assert.rejects(c.execute(ready, async () => true), error => error.code === "EXECUTION_APPROVAL_REQUIRED");
  assert.equal(f.sends(), 1);
  ready = await readyDeposit(f, c);
  const submitted = await deposit(f, c, ready);
  const pending = await f.client().refreshExecution(submitted.id, f.auth());
  assert.equal(pending.receiptStatus, "PENDING");
  assert.equal(pending.execution.status, "SUBMITTED");
  assert.equal(pending.execution.destinationReceipt, undefined);
  assert.equal((await c.resume()).status, "SUBMITTED");
  assert.equal(f.sends(), 2);
  f.finalize();
  const complete = await c.resume();
  assert.equal(complete.status, "COMPLETE");
  assert.equal(complete.nextAction, 2);
  assert.equal(complete.receipt.transactionHash, TXHASH);
  assert.equal(complete.receipt.destinationCredit, undefined);
  assert.equal(complete.destinationReceipt.transactionHash, signature);
  assert.equal(complete.destinationReceipt.commitment, "finalized");
  assert.equal(complete.destinationReceipt.destinationCredit.recipient, f.input.recipient);
  assert.equal(complete.destinationReceipt.destinationCredit.amountRaw, "100000");
  assert.equal(complete.destinationReceipt.attribution.sourceTransactionHash, TXHASH);
  assert.ok(BigInt(complete.receipt.actualNativeFeeRaw) > 0n);
  assert.deepEqual(c.getRecovery().record.destinationReceipt, complete.destinationReceipt);
  assert.ok(f.solMethods.includes("getBlock"));
  assert.equal(f.sends(), 2);
  await f.close();
  c = await f.start();
  await c.proveOwnership();
  const durable = await c.resume();
  assert.deepEqual(durable.receipt, complete.receipt);
  assert.deepEqual(durable.destinationReceipt, complete.destinationReceipt);
  assert.equal(durable.status, "COMPLETE");
  assert.equal(f.sends(), 2);
});

test("a finalized wrong-recipient Solana payout cannot release a Base USDC deposit or authorize replacement", async t => {
  const f = await harness(t), c = await f.start();
  await approve(f, c);
  const ready = await readyDeposit(f, c);
  const submitted = await deposit(f, c, ready);
  f.finalize();
  f.wrongRecipient();
  await assert.rejects(c.resume(), error => error.code === "DESTINATION_CREDIT_REQUIRED");
  const owned = await f.client().getExecution(submitted.id, f.auth());
  assert.equal(owned.execution.status, "SUBMITTED");
  assert.equal(owned.execution.destinationReceipt, undefined);
  assert.equal((await f.client().getActiveExecution(f.auth())).execution.id, submitted.id);
  await assert.rejects(f.client().cancelExecution(submitted.id, {
    reviewHash: submitted.reviewHash, revision: owned.execution.revision,
  }, f.auth()), error => error.code === "EXECUTION_CANCEL_BLOCKED");
  await assert.rejects(f.client().prepareExecution(f.input, f.auth()), error => error.code === "EXECUTION_ALREADY_ACTIVE");
  assert.equal(f.sends(), 2);
});

test("expired receipt-verified approval can be cancelled and freshly prepared without losing approval history", async t => {
  const f = await harness(t);
  let c = await f.start();
  const submitted = await approve(f, c);
  // Confirmation may arrive after quote expiry. Approval does not fund the order.
  f.advance(submitted.plan.expiresAtMs - Date.now() + 1);
  const ready = await readyDeposit(f, c);
  await assert.rejects(c.execute(ready, async () => true), error => error.code === "QUOTE_EXPIRED");
  const cancelled = await c.cancel();
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.nextAction, 1);
  assert.deepEqual(cancelled.submissions, ready.submissions);
  assert.equal(cancelled.receipt, undefined);
  assert.equal((await f.client().getActiveExecution(f.auth())).execution, null);
  f.fixture.setAllowance("100000");
  const replacement = await c.prepare(f.input);
  assert.notEqual(replacement.id, ready.id);
  assert.equal(replacement.plan.actions.length, 1, "A fresh allowance read removes the unnecessary approval");
  assert.equal(replacement.plan.actions[0].id, "relay-usdc-deposit");
  assert.equal(f.sends(), 1);
  await f.close();
  c = await f.start();
  await c.proveOwnership();
  assert.equal((await c.resume()).id, replacement.id);
  const old = await f.client().getExecution(ready.id, f.auth());
  assert.equal(old.execution.status, "CANCELLED");
  assert.deepEqual(old.execution.submissions, ready.submissions);
});

test("approval-only release rechecks canonical receipt and a claimed deposit can never be released", async t => {
  const f = await harness(t), c = await f.start();
  await approve(f, c);
  const ready = await readyDeposit(f, c);
  f.fixture.setReceipt(receipt => ({ ...receipt, logs: [] }));
  await assert.rejects(c.cancel(), error => error.code === "RELAY_APPROVAL_EVENT_REQUIRED");
  assert.equal((await f.client().getActiveExecution(f.auth())).execution.id, ready.id);
  f.fixture.setReceipt(receipt => receipt);
  f.fixture.setAllowance("100000");
  const claimed = await f.client().claimExecution(ready.id, {
    reviewHash: ready.reviewHash, revision: ready.revision,
  }, f.auth());
  assert.equal(claimed.execution.status, "CLAIMED");
  assert.equal(claimed.execution.nextAction, 1);
  await assert.rejects(f.client().cancelExecution(ready.id, {
    reviewHash: ready.reviewHash, revision: claimed.execution.revision,
  }, f.auth()), error => error.code === "EXECUTION_CANCEL_BLOCKED");
  f.advance(ready.plan.expiresAtMs - Date.now() + 1);
  assert.equal((await f.client().getActiveExecution(f.auth())).execution.id, ready.id);
  await assert.rejects(f.client().prepareExecution(f.input, f.auth()), error => error.code === "EXECUTION_ALREADY_ACTIVE");
  assert.equal(f.sends(), 1);
});
