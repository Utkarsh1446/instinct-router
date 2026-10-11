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
  const dir = await mkdtemp(
    join(await realpath(tmpdir()), "router-crosschain-integration-"),
  );
  const f = await relayPrepared({ sender });
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
    amount: "0.00005",
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
        f.f.setTransaction(params[0]);
        return TXHASH;
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

async function submit(f, c) {
  const config = await f.client().getConfig();
  assert.ok(
    config.execution.supportedRoutes.some(
      (route) => route.destination.chainId === f.input.destination.chainId,
    ),
  );
  await c.proveOwnership();
  const review = await c.prepare(f.input);
  assert.equal(review.plan.actions.length, 1);
  assert.equal(review.plan.actions[0].chainId, BASE_V3.chainId);
  assert.equal(review.plan.actions[0].payload, undefined);
  const submitted = await c.execute(review, async (record, action) => {
    assert.equal(record.reviewHash, review.reviewHash);
    assert.equal(action.payload.type, "EVM_TRANSACTION");
    assert.equal(action.payload.transaction.from, sender);
    assert.match(action.payload.relay.orderId, /^0x[0-9a-f]{64}$/);
    return true;
  });
  assert.equal(submitted.status, "SUBMITTED");
  assert.equal(f.sends(), 1);
  return submitted;
}

test("actual Relay engine, SDK, API and durable store recover a pending Solana delivery after restart without resending", async (t) => {
  const f = await harness(t);
  let c = await f.start();
  const submitted = await submit(f, c);
  const pending = await f.client().refreshExecution(submitted.id, f.auth());
  assert.equal(pending.receiptStatus, "PENDING");
  assert.equal(pending.execution.status, "SUBMITTED");
  assert.equal(pending.execution.destinationReceipt, undefined);
  assert.equal((await c.resume()).status, "SUBMITTED");
  await f.close();
  c = await f.start();
  await assert.rejects(
    c.resume(),
    (error) => error.code === "WALLET_SESSION_REQUIRED",
  );
  await c.proveOwnership();
  assert.equal(f.messageProofs(), 2);
  f.finalize();
  const complete = await c.resume();
  assert.equal(complete.status, "COMPLETE");
  assert.equal(complete.receipt.transactionHash, TXHASH);
  assert.equal(complete.receipt.destinationCredit, undefined);
  assert.equal(complete.destinationReceipt.transactionHash, signature);
  assert.equal(complete.destinationReceipt.commitment, "finalized");
  assert.equal(
    complete.destinationReceipt.destinationCredit.recipient,
    f.input.recipient,
  );
  assert.equal(
    complete.destinationReceipt.destinationCredit.amountRaw,
    "100000",
  );
  assert.equal(
    complete.destinationReceipt.attribution.sourceTransactionHash,
    TXHASH,
  );
  assert.equal(
    complete.plan.quoteIds[0],
    "relay:" + complete.destinationReceipt.attribution.requestId,
  );
  assert.ok(BigInt(complete.receipt.actualNativeFeeRaw) > 0n);
  assert.ok(complete.timeline.completedAtMs >= complete.timeline.submittedAtMs);
  assert.equal((await c.resume()).revision, complete.revision);
  assert.deepEqual(
    c.getRecovery().record.destinationReceipt,
    complete.destinationReceipt,
  );
  assert.equal(f.sends(), 1);
  assert.equal(
    f.walletMethods.filter((method) => method === "eth_sendTransaction").length,
    1,
  );
  assert.ok(f.solMethods.includes("getBlock"));
  assert.ok(
    f.solMethods.filter((method) => method === "getSignatureStatuses").length >=
      2,
  );
  await f.close();
  c = await f.start();
  await c.proveOwnership();
  const durable = await c.resume();
  assert.equal(durable.status, "COMPLETE");
  assert.deepEqual(durable.receipt, complete.receipt);
  assert.deepEqual(durable.destinationReceipt, complete.destinationReceipt);
  assert.equal(
    f.sends(),
    1,
    "Completed source and destination proofs survive restart without a wallet resend",
  );
});

test("finalized wrong-recipient proof leaves the funding reserved and cannot complete or authorize a replacement", async (t) => {
  const f = await harness(t),
    c = await f.start(),
    submitted = await submit(f, c);
  f.finalize();
  f.wrongRecipient();
  await assert.rejects(
    c.resume(),
    (error) => error.code === "DESTINATION_CREDIT_REQUIRED",
  );
  const owned = await f.client().getExecution(submitted.id, f.auth());
  assert.equal(owned.execution.status, "SUBMITTED");
  assert.equal(owned.execution.destinationReceipt, undefined);
  assert.equal(
    (await f.client().getActiveExecution(f.auth())).execution.id,
    submitted.id,
  );
  await assert.rejects(
    f.client().prepareExecution(f.input, f.auth()),
    (error) => error.code === "EXECUTION_ALREADY_ACTIVE",
  );
  await assert.rejects(
    c.prepare(f.input),
    (error) => error.code === "RECOVERY_REQUIRED",
  );
  assert.equal(f.sends(), 1);
  assert.equal(c.getRecovery().record.id, submitted.id);
});
