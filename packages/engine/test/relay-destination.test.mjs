import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyRelaySolanaDelivery,
  createRelayDestinationVerifier,
} from "../src/relay-destination.mjs";
const solver = "F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe",
  recipient = "47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT";
const source = "Q4UmPB9hKMw3ERqksavS9oEpNo2eWG4ffkWg7wHa9j6",
  destination = "FZeGx9mDteLt17pYM6iYmHBmRVn2joyDeqexC1qSxT54";
const signature =
  "4LobeBPHwLz4nCWse5N8g2kxp97LwTWenFXztFeTH2aiMnkXx3irbwwdF2PPeaUNmnvAhqJqTR1gYHeATRUD7Pnv";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
function fixture() {
  const orderId = "0x" + "12".repeat(32);
  const plan = {
    recipient,
    minimumOutRaw: "90",
    destination: {
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      address: mint,
      decimals: 6,
    },
    quoteIds: ["relay:test-request"],
    actions: [{ payload: { relay: { orderId, requestId: "test-request" } } }],
  };
  const balance = (accountIndex, owner, amount) => ({
    accountIndex,
    owner,
    mint,
    programId: token,
    uiTokenAmount: { decimals: 6, amount },
  });
  const tx = {
    slot: 100,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: solver, signer: true },
          { pubkey: source, signer: false },
          { pubkey: destination, signer: false },
        ],
        instructions: [
          {
            programId: token,
            parsed: {
              type: "transfer",
              info: { source, destination, authority: solver, amount: "100" },
            },
          },
          {
            programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            parsed: orderId,
          },
        ],
      },
    },
    meta: {
      err: null,
      preTokenBalances: [
        balance(1, solver, "1000"),
        balance(2, recipient, "0"),
      ],
      postTokenBalances: [
        balance(1, solver, "900"),
        balance(2, recipient, "100"),
      ],
    },
  };
  return {
    plan,
    tx,
    status: {
      err: null,
      confirmations: null,
      slot: 100,
      confirmationStatus: "finalized",
    },
  };
}
test("accepts only a finalized exact credit declared by the pinned signing solver", () => {
  const { plan, tx, status } = fixture();
  const credit = verifyRelaySolanaDelivery(plan, signature, tx, status, [
    solver,
  ]);
  assert.equal(credit.amountRaw, "100");
  assert.equal(credit.attributedAmountRaw, "100");
});
test("rejects unrelated credits, copied memo without signer, wrong memo, wrong mint and drained credits", () => {
  for (const mutate of [
    (f) => {
      f.tx.transaction.message.accountKeys[0].signer = false;
    },
    (f) => {
      f.tx.transaction.message.instructions[1].parsed = "0x" + "34".repeat(32);
    },
    (f) => {
      f.tx.transaction.message.instructions[0].parsed.info.authority =
        recipient;
    },
    (f) => {
      f.tx.meta.postTokenBalances[1].mint = solver;
    },
    (f) => {
      f.tx.meta.postTokenBalances[1].uiTokenAmount.amount = "89";
    },
    (f) => {
      f.status.confirmationStatus = "confirmed";
    },
    (f) => {
      f.status.slot = 101;
    },
    (f) => {
      f.tx.meta.postTokenBalances.push(f.tx.meta.postTokenBalances[1]);
    },
    (f) => {
      f.tx.transaction.message.instructions.push(
        f.tx.transaction.message.instructions[1],
      );
    },
    (f) => {
      f.tx.transaction.message.instructions.push({
        programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        parsed: "0x" + "45".repeat(32),
      });
    },
    (f) => {
      f.tx.transaction.message.accountKeys.push(
        f.tx.transaction.message.accountKeys[0],
      );
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      verifyRelaySolanaDelivery(f.plan, signature, f.tx, f.status, [solver]),
    );
  }
});
test("pins are mandatory even if the provider nominates a correct credited transaction", () => {
  const f = fixture();
  assert.throws(
    () => verifyRelaySolanaDelivery(f.plan, signature, f.tx, f.status, []),
    { code: "EXECUTION_PINS_REQUIRED" },
  );
});
test("independent RPC checks chain and finality again before producing a separate destination receipt", async () => {
  const f = fixture(),
    methods = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    methods.push(body.method);
    const result =
      body.method === "getGenesisHash"
        ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
        : body.method === "getTransaction"
          ? f.tx
          : body.method === "getBlock"
            ? { blockhash: solver, signatures: [signature] }
            : { value: [f.status] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  const verifier = createRelayDestinationVerifier({
    fetch,
    pins: { solanaSolverSigners: [solver] },
  });
  const result = await verifier.confirm(
    f.plan,
    "0x" + "ab".repeat(32),
    signature,
  );
  assert.equal(result.destinationReceipt.transactionHash, signature);
  assert.equal(result.destinationCredit.amountRaw, "100");
  assert.equal(methods.filter((m) => m === "getSignatureStatuses").length, 2);
});

test("rejects credited transactions absent from the finalized block", async () => {
  const f = fixture();
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const result =
      body.method === "getGenesisHash"
        ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
        : body.method === "getTransaction"
          ? f.tx
          : body.method === "getBlock"
            ? { blockhash: solver, signatures: [] }
            : { value: [f.status] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  await assert.rejects(
    createRelayDestinationVerifier({
      fetch,
      pins: { solanaSolverSigners: [solver] },
    }).confirm(f.plan, "0x" + "ab".repeat(32), signature),
    { code: "DESTINATION_FINALITY_REQUIRED" },
  );
});
test("rejects cross-chain RPC responses exceeding the bounded reader before parsing", async () => {
  const f = fixture();
  let cancelled = false;
  const fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(2000001));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(
    createRelayDestinationVerifier({
      fetch,
      pins: { solanaSolverSigners: [solver] },
    }).confirm(f.plan, "0x" + "ab".repeat(32), signature),
    { code: "DESTINATION_EVIDENCE_INVALID" },
  );
  assert.equal(cancelled, true);
});

function rpcFixture(f, alter = (value) => value) {
  let statusReads = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const result =
      body.method === "getGenesisHash"
        ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
        : body.method === "getTransaction"
          ? f.tx
          : body.method === "getBlock"
            ? { blockhash: solver, signatures: [signature] }
            : { value: [f.status] };
    if (body.method === "getSignatureStatuses") statusReads++;
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: alter(structuredClone(result), body.method, statusReads),
      }),
    );
  };
}
test("factory rejects wrong genesis, initial finality, changed finality and missing slot membership", async () => {
  for (const [mutate, code] of [
    [
      (result, method) => (method === "getGenesisHash" ? solver : result),
      "DESTINATION_CHAIN_MISMATCH",
    ],
    [
      (result, method) => {
        if (method === "getSignatureStatuses")
          result.value[0].confirmationStatus = "confirmed";
        return result;
      },
      "DESTINATION_FINALITY_REQUIRED",
    ],
    [
      (result, method, reads) => {
        if (method === "getSignatureStatuses" && reads === 2)
          result.value[0].slot++;
        return result;
      },
      "DESTINATION_FINALITY_REQUIRED",
    ],
    [
      (result, method) => {
        if (method === "getBlock") result.signatures = [signature, signature];
        return result;
      },
      "DESTINATION_FINALITY_REQUIRED",
    ],
  ]) {
    const f = fixture();
    await assert.rejects(
      createRelayDestinationVerifier({
        fetch: rpcFixture(f, mutate),
        pins: { solanaSolverSigners: [solver] },
      }).confirm(f.plan, "0x" + "ab".repeat(32), signature),
      { code },
    );
  }
});
test("factory rejects a mismatched quote request and does not mutate caller plans", async () => {
  const f = fixture();
  f.plan.quoteIds = ["relay:another-request"];
  await assert.rejects(
    createRelayDestinationVerifier({
      fetch: rpcFixture(f),
      pins: { solanaSolverSigners: [solver] },
    }).confirm(f.plan, "0x" + "ab".repeat(32), signature),
    { code: "DESTINATION_ORDER_ATTRIBUTION_REQUIRED" },
  );
});
test("factory rejects redirects and duplicate JSON properties", async () => {
  const f = fixture();
  for (const fetch of [
    async () => {
      const r = new Response("{}");
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
    async () => new Response('{"jsonrpc":"2.0","id":1,"result":1,"result":2}'),
  ]) {
    await assert.rejects(
      createRelayDestinationVerifier({
        fetch,
        pins: { solanaSolverSigners: [solver] },
      }).confirm(f.plan, "0x" + "ab".repeat(32), signature),
    );
  }
});
test("caller cancellation bounds a fetch that ignores its signal", async () => {
  const f = fixture(),
    abort = new AbortController();
  const fetch = async () => new Promise(() => {});
  const promise = createRelayDestinationVerifier({
    fetch,
    pins: { solanaSolverSigners: [solver] },
  }).confirm(f.plan, "0x" + "ab".repeat(32), signature, abort.signal);
  abort.abort();
  await assert.rejects(promise, { code: "EXECUTION_CANCELLED" });
});
test("caller cancellation bounds a stalled response body and cancels its reader", async () => {
  const f = fixture(),
    abort = new AbortController();
  let cancelled = false;
  const fetch = async () =>
    new Response(
      new ReadableStream({
        pull() {},
        cancel() {
          cancelled = true;
        },
      }),
    );
  const promise = createRelayDestinationVerifier({
    fetch,
    pins: { solanaSolverSigners: [solver] },
  }).confirm(f.plan, "0x" + "ab".repeat(32), signature, abort.signal);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(promise, { code: "EXECUTION_CANCELLED" });
  assert.equal(cancelled, true);
});

test("a timed caller signal bounds a stalled RPC and requests redirect rejection", async () => {
  const f = fixture(),
    abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10);
  let redirect;
  const fetch = async (url, init) => {
    redirect = init.redirect;
    return new Promise(() => {});
  };
  try {
    await assert.rejects(
      createRelayDestinationVerifier({
        fetch,
        pins: { solanaSolverSigners: [solver] },
      }).confirm(f.plan, "0x" + "ab".repeat(32), signature, abort.signal),
      { code: "EXECUTION_CANCELLED" },
    );
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(redirect, "error");
});

test('confirmed observation proves exact credit once but public confirmation remains finalized only', async () => {
  const f = fixture();
  f.status.confirmationStatus = 'confirmed'; f.status.confirmations = 1;
  const calls = [], wire = rpcFixture(f);
  const verifier = createRelayDestinationVerifier({ fetch: (url, init) => {
    calls.push(JSON.parse(init.body)); return wire(url, init);
  }, pins: { solanaSolverSigners: [solver] } });
  const result = await verifier.observe(f.plan, '0x' + 'ab'.repeat(32), signature);
  assert.equal(result.success, false);
  assert.equal(result.destinationReceipt.commitment, 'confirmed');
  assert.equal(result.destinationCredit.amountRaw, '100');
  assert.equal(calls.filter(call => call.method === 'getTransaction').length, 1);
  assert.equal(calls.filter(call => call.method === 'getBlock').length, 1);
  assert.equal(calls.filter(call => call.method === 'getSignatureStatuses').length, 2);
  for (const method of ['getTransaction', 'getBlock'])
    assert.equal(calls.find(call => call.method === method).params[1].commitment, 'confirmed');
  assert.throws(() => verifyRelaySolanaDelivery(f.plan, signature, f.tx, f.status, [solver]),
    { code: 'DESTINATION_FINALITY_REQUIRED' });
  await assert.rejects(verifier.confirm(f.plan, '0x' + 'ab'.repeat(32), signature),
    { code: 'DESTINATION_FINALITY_REQUIRED' });
});
test('observation reports finalized only with finalized block membership and status recheck', async () => {
  for (const initiallyFinalized of [true, false]) {
    const f = fixture(), calls = [];
    if (!initiallyFinalized) { f.status.confirmationStatus = 'confirmed'; f.status.confirmations = 1; }
    const wire = rpcFixture(f, (value, method, reads) => {
      if (method === 'getSignatureStatuses' && reads === 2) {
        value.value[0].confirmationStatus = 'finalized'; value.value[0].confirmations = null;
      }
      return value;
    });
    const result = await createRelayDestinationVerifier({ fetch: (url, init) => {
      calls.push(JSON.parse(init.body)); return wire(url, init);
    }, pins: { solanaSolverSigners: [solver] } }).observe(f.plan, '0x' + 'ab'.repeat(32), signature);
    assert.equal(result.success, initiallyFinalized);
    assert.equal(result.destinationReceipt.commitment, initiallyFinalized ? 'finalized' : 'confirmed');
    assert.equal(calls.find(call => call.method === 'getBlock').params[1].commitment,
      initiallyFinalized ? 'finalized' : 'confirmed');
    assert.equal(calls.filter(call => call.method === 'getTransaction').length, 1);
  }
});
test('confirmed observation preserves all exact delivery and canonical membership checks', async () => {
  for (const mutate of [
    f => { f.tx.transaction.message.accountKeys[0].signer = false; },
    f => { f.tx.transaction.message.instructions[1].parsed = '0x' + '34'.repeat(32); },
    f => { f.tx.meta.postTokenBalances[1].mint = solver; },
    f => { f.tx.meta.postTokenBalances[1].owner = solver; },
    f => { f.tx.meta.postTokenBalances[1].uiTokenAmount.amount = '89'; },
  ]) {
    const f = fixture(); f.status.confirmationStatus = 'confirmed'; f.status.confirmations = 1; mutate(f);
    await assert.rejects(createRelayDestinationVerifier({ fetch: rpcFixture(f),
      pins: { solanaSolverSigners: [solver] } }).observe(f.plan, '0x' + 'ab'.repeat(32), signature));
  }
  for (const mutation of ['membership', 'slot', 'regression']) {
    const f = fixture();
    await assert.rejects(createRelayDestinationVerifier({ fetch: rpcFixture(f, (value, method, reads) => {
      if (mutation === 'membership' && method === 'getBlock') value.signatures = [];
      if (method === 'getSignatureStatuses' && reads === 2) {
        if (mutation === 'slot') value.value[0].slot++;
        if (mutation === 'regression') { value.value[0].confirmationStatus = 'confirmed'; value.value[0].confirmations = 1; }
      }
      return value;
    }), pins: { solanaSolverSigners: [solver] } }).observe(f.plan, '0x' + 'ab'.repeat(32), signature),
    { code: 'DESTINATION_FINALITY_REQUIRED' });
  }
});

test('ignored fetch aborts retain actual destination permits across repeated reconnects until fetches settle', async () => {
  const f = fixture(), held = [];
  let requests = 0, stalled = true;
  const healthy = rpcFixture(f);
  const verifier = createRelayDestinationVerifier({ fetch: (url, init) => {
    requests++;
    return stalled ? new Promise(resolve => held.push(resolve)) : healthy(url, init);
  }, pins: { solanaSolverSigners: [solver] } });
  for (let index = 0; index < 2; index++) {
    const abort = new AbortController();
    const work = verifier.observe(f.plan, '0x' + 'ab'.repeat(32), signature, abort.signal);
    await new Promise(resolve => setImmediate(resolve)); abort.abort();
    await assert.rejects(work, { code: 'EXECUTION_CANCELLED' });
  }
  assert.equal(requests, 6);
  for (let index = 0; index < 10; index++) await assert.rejects(
    verifier.observe(f.plan, '0x' + 'ab'.repeat(32), signature), { code: 'EXECUTION_BUSY' });
  assert.equal(requests, 6);
  stalled = false;
  for (const release of held) release(new Response('{}'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await verifier.observe(f.plan, '0x' + 'ab'.repeat(32), signature)).success, true);
  assert.equal(requests, 11);
});
test('ignored body read and cancellation retain destination permits until both actually settle', async () => {
  const f = fixture(), reads = [], cancellations = [];
  let requests = 0, stalled = true;
  const healthy = rpcFixture(f);
  const verifier = createRelayDestinationVerifier({ fetch: (url, init) => {
    requests++;
    if (!stalled) return healthy(url, init);
    // Deliberately noncooperative reader: neither cancel nor release settles read.
    return Promise.resolve({ ok: true, redirected: false, headers: new Headers(), body: { getReader: () => ({
      read: () => new Promise(resolve => reads.push(resolve)),
      cancel: () => new Promise(resolve => cancellations.push(resolve)), releaseLock() {},
    }) } });
  }, pins: { solanaSolverSigners: [solver] } });
  for (let index = 0; index < 2; index++) {
    const abort = new AbortController();
    const work = verifier.confirm(f.plan, '0x' + 'ab'.repeat(32), signature, abort.signal);
    await new Promise(resolve => setImmediate(resolve)); abort.abort();
    await assert.rejects(work, { code: 'EXECUTION_CANCELLED' });
  }
  assert.equal(requests, 6); assert.equal(reads.length, 6); assert.equal(cancellations.length, 6);
  for (const release of reads) release({ done: true });
  await new Promise(resolve => setImmediate(resolve));
  // Body reads settled, but their outstanding cancellations still own permits.
  await assert.rejects(verifier.confirm(f.plan, '0x' + 'ab'.repeat(32), signature), { code: 'EXECUTION_BUSY' });
  assert.equal(requests, 6);
  stalled = false;
  for (const release of cancellations) release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await verifier.confirm(f.plan, '0x' + 'ab'.repeat(32), signature)).success, true);
  assert.equal(requests, 11);
});
