/** Independent Solana credit with solver memo declaration; not bridge consensus. */
import { baseExecutionPrimitives as p } from "./base-readiness.mjs";
import { inspectSolanaAsset } from "./relay-solana-asset.mjs"; import { fail } from "./base-execution-checks.mjs";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SYSTEM = "11111111111111111111111111111111"; const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(value, size) {
  if (typeof value !== "string" || value.length > 128 || !value.length)
    fail("DESTINATION_EVIDENCE_INVALID");
  let n = 0n;
  for (const c of value) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) fail("DESTINATION_EVIDENCE_INVALID");
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (n) {
    bytes++;
    n >>= 8n;
  }
  if (bytes + (value.match(/^1*/)?.[0].length ?? 0) !== size)
    fail("DESTINATION_EVIDENCE_INVALID");
}
function units(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) >= 1n << 64n
  )
    fail("DESTINATION_EVIDENCE_INVALID");
  return BigInt(value);
}
export function verifyRelaySolanaDelivery(
  plan,
  signature,
  transaction,
  status,
  solverSigners,
) {
  return verifyDelivery(plan, signature, transaction, status, solverSigners, 'finalized');
}
function verifyDelivery(plan, signature, transaction, status, solverSigners, minimumCommitment) {
  base58(signature, 64);
  base58(plan.recipient, 32);
  const metadata = plan.actions?.[0]?.payload?.relay;
  if (
    !metadata ||
    !/^0x[0-9a-fA-F]{64}$/.test(metadata.orderId) ||
    plan.destination?.chainId !== SOL ||
    !Number.isSafeInteger(plan.destination.decimals) || plan.destination.decimals < 0 || plan.destination.decimals > 255 ||
    (plan.destination.address === SYSTEM && plan.destination.decimals !== 9) ||
    units(plan.minimumOutRaw) === 0n
  )
    fail("DESTINATION_EVIDENCE_INVALID");
  if (
    !Array.isArray(solverSigners) ||
    !solverSigners.length ||
    solverSigners.length > 16
  )
    fail("EXECUTION_PINS_REQUIRED");
  solverSigners.forEach((key) => base58(key, 32));
  if (
    !transaction ||
    !status ||
    transaction.transaction?.signatures?.[0] !== signature ||
    !(status.confirmationStatus === 'finalized' || minimumCommitment === 'confirmed' && status.confirmationStatus === 'confirmed') ||
    !Number.isSafeInteger(transaction.slot) ||
    transaction.slot < 1 ||
    status.slot !== transaction.slot ||
    transaction.meta?.err !== null ||
    status.err !== null ||
    (status.confirmationStatus === 'finalized' ? status.confirmations !== null :
      !Number.isSafeInteger(status.confirmations) || status.confirmations < 1)
  )
    fail("DESTINATION_FINALITY_REQUIRED");
  const message = transaction.transaction.message,
    meta = transaction.meta;
  if (
    !Array.isArray(message?.accountKeys) ||
    !Array.isArray(message.instructions) ||
    message.instructions.length > 64 ||
    message.accountKeys.length > 256
  )
    fail("DESTINATION_EVIDENCE_INVALID");
  const keys = message.accountKeys;
  if (
    keys.some(
      (key) =>
        !key || typeof key !== "object" || typeof key.pubkey !== "string",
    ) ||
    new Set(keys.map((key) => key.pubkey)).size !== keys.length
  )
    fail("DESTINATION_EVIDENCE_INVALID");
  keys.forEach((key) => base58(key.pubkey, 32));
  const memos = message.instructions.filter((ix) => ix.programId === MEMO);
  if (
    memos.length > 2 ||
    new Set(memos.map((ix) => ix.parsed?.toLowerCase?.())).size !==
      memos.length ||
    memos.filter(
      (ix) => ix.parsed?.toLowerCase?.() === metadata.orderId.toLowerCase(),
    ).length !== 1 ||
    memos.some(
      (ix) =>
        typeof ix.parsed !== "string" ||
        ![
          metadata.orderId.toLowerCase(),
          metadata.requestId?.toLowerCase(),
        ].includes(ix.parsed.toLowerCase()),
    )
  )
    fail("DESTINATION_ORDER_ATTRIBUTION_REQUIRED");
  const signers = keys
    .filter((key) => key.signer === true)
    .map((key) => key.pubkey);
  const trusted = signers.filter((key) => solverSigners.includes(key));
  if (
    signers.length !== 1 ||
    trusted.length !== 1 ||
    keys[0].pubkey !== trusted[0] ||
    !message.instructions.some(
      (ix) =>
        ix.programId === MEMO &&
        typeof ix.parsed === "string" &&
        ix.parsed.toLowerCase() === metadata.orderId.toLowerCase(),
    )
  )
    fail("DESTINATION_ORDER_ATTRIBUTION_REQUIRED");
  base58(plan.destination.address, 32);
  if (plan.destination.address === SYSTEM) {
    const index = keys.findIndex(key => key.pubkey === plan.recipient);
    const before = meta.preBalances, after = meta.postBalances;
    if (index < 0 || !Array.isArray(before) || !Array.isArray(after) || before.length !== keys.length || after.length !== keys.length ||
      !before.every(v => Number.isSafeInteger(v) && v >= 0) || !after.every(v => Number.isSafeInteger(v) && v >= 0) ||
      plan.recipient === trusted[0]) fail("DESTINATION_EVIDENCE_INVALID");
    let attributed = 0n;
    for (const ix of message.instructions) {
      if (ix.programId !== SYSTEM || ix.parsed?.type !== "transfer") continue;
      const info = ix.parsed.info;
      if (info?.source !== trusted[0] || info?.destination !== plan.recipient) continue;
      if (!Number.isSafeInteger(info.lamports) || info.lamports <= 0) fail("DESTINATION_EVIDENCE_INVALID");
      attributed += BigInt(info.lamports);
    }
    const net = BigInt(after[index]) - BigInt(before[index]);
    if (net < units(plan.minimumOutRaw) || attributed < units(plan.minimumOutRaw) ||
      BigInt(before[0]) - BigInt(after[0]) < attributed) fail("DESTINATION_CREDIT_REQUIRED");
    return { asset: structuredClone(plan.destination), recipient: plan.recipient, amountRaw: net.toString(),
      attributedAmountRaw: attributed.toString(), orderId: metadata.orderId, solverSigners: trusted };
  }
  const balances = new Map();
  for (const [field, sign] of [
    ["preTokenBalances", -1n],
    ["postTokenBalances", 1n],
  ]) {
    if (!Array.isArray(meta[field]) || meta[field].length > 256)
      fail("DESTINATION_EVIDENCE_INVALID");
    const seen = new Set();
    for (const row of meta[field]) {
      if (row.mint !== plan.destination.address) continue;
      if (
        !Number.isSafeInteger(row.accountIndex) ||
        row.accountIndex < 0 ||
        row.accountIndex >= keys.length ||
        seen.has(row.accountIndex) ||
        row.programId !== TOKEN ||
        row.uiTokenAmount?.decimals !== plan.destination.decimals
      )
        fail("DESTINATION_EVIDENCE_INVALID");
      seen.add(row.accountIndex);
      base58(row.owner, 32);
      const key = keys[row.accountIndex].pubkey;
      base58(key, 32);
      const saved = balances.get(key) ?? { net: 0n, owner: row.owner };
      if (saved.owner !== row.owner) fail("DESTINATION_EVIDENCE_INVALID");
      saved.net += sign * units(row.uiTokenAmount.amount);
      balances.set(key, saved);
    }
  }
  let attributed = 0n;
  for (const ix of message.instructions) {
    if (
      ix.programId !== TOKEN ||
      !["transfer", "transferChecked"].includes(ix.parsed?.type)
    )
      continue;
    const info = ix.parsed.info;
    if (!trusted.includes(info?.authority)) continue;
    const destination = balances.get(info.destination),
      source = balances.get(info.source);
    if (
      destination?.owner !== plan.recipient ||
      source?.owner !== info.authority ||
      info.source === info.destination
    )
      continue;
    if (
      ix.parsed.type === "transferChecked" &&
      (info.mint !== plan.destination.address || info.tokenAmount?.decimals !== plan.destination.decimals)
    )
      fail("DESTINATION_EVIDENCE_INVALID");
    attributed += units(
      ix.parsed.type === "transfer" ? info.amount : info.tokenAmount.amount,
    );
  }
  const net = [...balances.values()]
    .filter((row) => row.owner === plan.recipient)
    .reduce((sum, row) => sum + row.net, 0n);
  if (net < units(plan.minimumOutRaw) || attributed < units(plan.minimumOutRaw))
    fail("DESTINATION_CREDIT_REQUIRED");
  return {
    asset: structuredClone(plan.destination),
    recipient: plan.recipient,
    amountRaw: net.toString(),
    attributedAmountRaw: attributed.toString(),
    orderId: metadata.orderId,
    solverSigners: trusted,
  };
}
export function createRelayDestinationVerifier({
  fetch: wire = globalThis.fetch,
  rpcEndpoint = "https://api.mainnet-beta.solana.com",
  pins = {},
  now = Date.now,
} = {}) {
  let endpoint;
  try {
    endpoint = new URL(rpcEndpoint);
  } catch {
    fail("INVALID_EXECUTION_CONFIG");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    fail("INVALID_EXECUTION_CONFIG");
  if (typeof now !== "function" || typeof wire !== "function")
    fail("INVALID_EXECUTION_CONFIG");
  const signers = structuredClone(
    pins.solanaSolverSigners ?? pins.solanaSolver ?? [],
  );
  async function abortable(promise, signal) {
    if (signal.aborted) {
      void Promise.resolve(promise).catch(() => {});
      fail("EXECUTION_CANCELLED");
    }
    let abort;
    const stopped = new Promise((resolve, reject) => {
      abort = () => {
        try {
          fail("EXECUTION_CANCELLED");
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([promise, stopped]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  let actualRequests = 0;
  async function read(method, params, signal) {
    if (signal.aborted) fail('EXECUTION_CANCELLED');
    if (actualRequests >= 6) fail('EXECUTION_BUSY');
    actualRequests++;
    const inFlight = [];
    const retain = promise => { const work = Promise.resolve(promise); inFlight.push(work); return work; };
    try { return await readEvidence(method, params, signal, retain); }
    finally {
      // Aborting a caller does not settle an ignored fetch/read/cancellation.
      // Keep its actual request permit until every underlying operation settles.
      void Promise.allSettled(inFlight).then(() => { actualRequests--; });
    }
  }
  async function readEvidence(method, params, signal, retain) {
    const response = await abortable(
      retain(Promise.resolve().then(() => {
        if (signal.aborted) fail('EXECUTION_CANCELLED');
        return wire(endpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
        redirect: "error",
        credentials: "omit",
        });
      }).then(async response => {
        if (signal.aborted) {
          await response.body?.cancel().catch(() => {});
          fail('EXECUTION_CANCELLED');
        }
        return response;
      })),
      signal,
    );
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== endpoint.href)
    ) {
      if (response.body) retain(response.body.cancel().catch(() => {}));
      fail("DESTINATION_RPC_UNAVAILABLE");
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > 2000000)
    ) {
      if (response.body) retain(response.body.cancel().catch(() => {}));
      fail("DESTINATION_EVIDENCE_INVALID");
    }
    const reader = response.body?.getReader();
    if (!reader) fail("DESTINATION_EVIDENCE_INVALID");
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const part = await abortable(retain(reader.read()), signal);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 2000000 || chunks.length >= 4096) {
          fail("DESTINATION_EVIDENCE_INVALID");
        }
        chunks.push(part.value);
      }
    } finally {
      retain(reader.cancel().catch(() => {}));
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("DESTINATION_EVIDENCE_INVALID");
    }
    let body;
    try {
      body = p.strictJson(text);
    } catch {
      fail("DESTINATION_EVIDENCE_INVALID");
    }
    if (
      body?.jsonrpc !== "2.0" ||
      body.id !== 1 ||
      body.error ||
      !Object.hasOwn(body, "result")
    )
      fail("DESTINATION_RPC_UNAVAILABLE");
    return body.result;
  }  async function inspect(plan, sourceHash, signature, signal, minimumCommitment) {
      signal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000);
      if (signal.aborted) fail("EXECUTION_CANCELLED");
      plan = structuredClone(plan);
      if (!/^0x[0-9a-fA-F]{64}$/.test(sourceHash))
        fail("DESTINATION_EVIDENCE_INVALID");
      base58(signature, 64);
      const snapshots = await Promise.allSettled([
        read("getGenesisHash", [], signal),
        read(
          "getTransaction",
          [
            signature,
            {
              encoding: "jsonParsed",
              commitment: minimumCommitment,
              maxSupportedTransactionVersion: 0,
            },
          ],
          signal,
        ),
        read(
          "getSignatureStatuses",
          [[signature], { searchTransactionHistory: true }],
          signal,
        ),
      ]);
      const failure = snapshots.find(snapshot => snapshot.status === 'rejected');
      if (failure) throw failure.reason;
      const [genesis, transaction, statuses] = snapshots.map(snapshot => snapshot.value);
      if (genesis !== GENESIS) fail("DESTINATION_CHAIN_MISMATCH");
      if (transaction === null || statuses?.value?.[0] === null)
        return { success: false, pending: true };
      if (!Array.isArray(statuses?.value) || statuses.value.length !== 1)
        fail("DESTINATION_EVIDENCE_INVALID");
      const commitment = statuses.value[0]?.confirmationStatus === 'finalized' ? 'finalized' : minimumCommitment;
      const metadata = plan.actions?.[0]?.payload?.relay;
      if (
        typeof metadata?.requestId !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata.requestId) ||
        !Array.isArray(plan.quoteIds) ||
        plan.quoteIds.length !== 1 ||
        plan.quoteIds[0] !== "relay:" + metadata.requestId
      )
        fail("DESTINATION_ORDER_ATTRIBUTION_REQUIRED");
      if (![USDC, SYSTEM].includes(plan.destination.address)) {
        const mint = await read("getAccountInfo", [plan.destination.address, { encoding: "jsonParsed", commitment, minContextSlot: transaction.slot }], signal);
        if (!Number.isSafeInteger(mint?.context?.slot) || mint.context.slot < transaction.slot ||
          mint.value?.owner !== TOKEN || mint.value.executable !== false || mint.value.data?.program !== "spl-token" ||
          mint.value.data?.parsed?.type !== "mint" || mint.value.data.parsed.info?.isInitialized !== true ||
          mint.value.data.parsed.info.decimals !== plan.destination.decimals) fail("DESTINATION_TOKEN_UNSUPPORTED");
      }
      const block = await read(
        "getBlock",
        [
          transaction.slot,
          {
            commitment,
            transactionDetails: "signatures",
            rewards: false,
          },
        ],
        signal,
      );
      base58(block?.blockhash, 32);
      if (
        !Array.isArray(block.signatures) ||
        block.signatures.length > 10000 ||
        block.signatures.filter((hash) => hash === signature).length !== 1
      )
        fail("DESTINATION_FINALITY_REQUIRED");
      const credit = verifyDelivery(
        plan,
        signature,
        transaction,
        statuses.value[0],
        signers,
        minimumCommitment,
      );
      const recheck = await read(
        "getSignatureStatuses",
        [[signature], { searchTransactionHistory: true }],
        signal,
      );
      if (
        recheck?.value?.[0]?.slot !== transaction.slot ||
        !(recheck.value[0].confirmationStatus === 'finalized' || commitment === 'confirmed' && recheck.value[0].confirmationStatus === 'confirmed') ||
        recheck.value[0].err !== null ||
        (recheck.value[0].confirmationStatus === 'finalized' ? recheck.value[0].confirmations !== null :
          !Number.isSafeInteger(recheck.value[0].confirmations) || recheck.value[0].confirmations < 1)
      )
        fail("DESTINATION_FINALITY_REQUIRED");
      return {
        success: commitment === 'finalized',
        destinationCredit: {
          asset: credit.asset,
          recipient: credit.recipient,
          amountRaw: credit.amountRaw,
        },
        destinationReceipt: {
          chainId: SOL,
          transactionHash: signature,
          blockNumberRaw: String(transaction.slot),
          blockHash: block.blockhash,
          observedAtMs: now(),
          commitment,
          destinationCredit: {
            asset: credit.asset,
            recipient: credit.recipient,
            amountRaw: credit.amountRaw,
          },
          attribution: {
            provider: "relay",
            requestId: metadata.requestId,
            sourceTransactionHash: sourceHash,
          },
        },
        evidence: {
          genesisVerified: true,
          finalizedRecheck: commitment === 'finalized',
          confirmedRecheck: true,
          signedOrderMemoVerified: true,
          solverSigners: credit.solverSigners,
          receivedFromPinnedSolverRaw: credit.attributedAmountRaw,
          attributionPolicy:
            "PINNED_SOLVER_SIGNED_ORDER_MEMO_AND_EXACT_RECIPIENT_CREDIT",
        },
      };
  }
  return {
    inspect: (request, signal) => inspectSolanaAsset(request, read, base58, signal),
    confirm: (plan, sourceHash, signature, signal) => inspect(plan, sourceHash, signature, signal, 'finalized'),
    observe: (plan, sourceHash, signature, signal) => inspect(plan, sourceHash, signature, signal, 'confirmed'),
  };
}
