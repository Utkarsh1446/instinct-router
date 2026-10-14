# @instinct/router-sdk · 0.1.0

Dependency-free ESM SDK with browser and Node clients and TypeScript declarations. Maintained in the Instinct monorepo at `router/packages/sdk`; repository access or an operator-supplied package archive is required until an npm release is published.

Browser execution controllers require durable storage and the Web Locks API on a secure origin. Controllers sharing a recovery key serialize persistence, including status watchers, across tabs. A busy lock returns `EXECUTION_BUSY`; unsupported browsers return `EXECUTION_LOCK_UNAVAILABLE` before signing. Abort a watcher before starting another operation. Ownership proofs and reading recovery hints do not acquire this lock. Non-browser callers must provide their own cross-process coordination if multiple processes share storage.

```ts
import { createRouterClient } from '@instinct/router-sdk';
const router = createRouterClient({ baseUrl: 'https://YOUR_ROUTER_HOST', publishableKey: 'YOUR_APP_PUBLISHABLE_KEY' });
const config = await router.getConfig();
```

Import `createRouterServerClient` from `@instinct/router-sdk/server` for backend-only Bearer credentials. Never place a server/provider secret in browser code. The API operator must register your app key and exact browser origin.

Use native Fetch in Node 18+ or a modern browser. A custom `fetch` must return a standard streaming `Response` whose body exposes `getReader()`. Version 0.1 intentionally rejects nonstreaming, text-only or JSON-only response shims with `PROTOCOL_ERROR`, without calling `text()`. This keeps the 2 MiB response limit enforceable before the complete body is buffered.

Methods: `getConfig`, `getCapabilities`, `resolveAsset`, `quote`, `quoteStream`, `getQuote`, `inspectExecution`, `prepareExecution`. Quotes require exact chain/address/decimals, a positive decimal string amount, and explicit sender/recipient wallet addresses. Ordinary quote creation accepts an optional `idempotencyKey`; all methods accept cancellation and bounded timeouts. There are no automatic retries.

`quoteStream(input,{signal?,timeoutMs?,onCandidate?})` delivers detached provisional candidates through an awaited `(candidate, metadata)` callback, then returns the final `QuoteResponse` only after validated COMPLETE and clean EOF. Streams have strict JSON, line/total/chunk/event bounds, sequence/app/request/candidate binding and EOF freshness checks. They reject idempotency keys. Provisional callbacks carry no winner or execution authority; keep rendering fast and discard previews if the stream fails. Expired snapshots or selected routes fail with `QUOTE_EXPIRED` and require an explicit fresh request.

The optional `routeScope` is `ALL` (default) or `INDEPENDENT`. Check `config.capabilities.independentRoutes` first. Independent scope rejects a response containing Relay/Aurora/deBridge candidates or an inconsistent request binding. Candidate `routingFamily`, `routeKind` and `steps` describe direct or composed previews. These fields are not executable calldata or settlement guarantees.

Pricing responses remain read-only. Local recipes reconstruct the Base ETH → Base USDC swap and pinned Base/Solana Relay deposits. An additional explicit `executionPins.providerManaged.enabled: true` mode enables official Relay transaction steps across configured EVM chains and Solana, including same-chain swaps, cross-chain ERC20 outputs, custom contract/mint addresses and source DEX composition. Chain/deployment metadata is discovered separately from quotes. This mode trusts Relay transaction construction and payout association; it still binds wallets/assets/amount/minimum/expiry/fees, simulates the exact source action and verifies canonical destination credit. Standard ERC20, classic SPL and supported passive Token-2022 extensions are admitted. Liquidity, usable RPC evidence, gas and supported token behavior remain necessary; other wallet VM families are not implemented. Price discovery alone never grants execution. Unsupported execution returns `EXECUTION_ADAPTER_UNAVAILABLE` (501) or a recipe-specific validation error. A quote is never a completed trade. Unknown costs remain null; configured completion estimates and measured quote RTT are distinct.

`execution.supportedRoutes` lists exact local pairs. Local profiles use `sourceChainId`/`destinationChainId`; the compact provider-managed profile uses `sourceChainIds`/`destinationChainIds` and `verification: "PROVIDER_MANAGED"`. Both bind asset classes and require `requiresFreshValidation: true`. The widget checks both chain arrays, supports custom addresses and attempts fresh preparation instead of enforcing a preset pair whitelist. Only the returned immutable review authorizes its exact claimed action.

See the project root README and OpenAPI contract for app configuration, coverage, packaging, and the execution implementation plan. Packages are locally packable; registry publication is a separate step.

`inspectExecution({source,destination,amount,sender,recipient,slippageBps?})` requests a fresh Base ETH→USDC read-only simulation and wallet gas check when `config.capabilities.executionInspection` is true. The SDK binds the response to the exact request, verifies fee arithmetic/funding and rejects injected transaction fields or premature execution authority. Reports contain no calldata/signatures. Estimated gas components are not a guaranteed final fee or a complete cross-chain cost comparison. Inspect calls accept cancellation/timeouts, never idempotency keys or automatic retries.

## Wallet execution

Choose an injected EIP-1193 provider or Phantom explicitly using the app's wallet picker. Use `createEvmWallet(provider, source.chainId)` for configured EVM sources and `createPhantomWallet(provider, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')` for Solana sources. Each step below belongs in a user-initiated UI handler. A wallet-control message signature starts a 15-minute app/origin/wallet session; it is separate from the transaction confirmation and cannot spend funds.

`wallet.resume(expectedAccount?)` restores an already authorized live account without requesting account access, signatures, or transactions. It returns an account or `null` when unavailable, untrusted, mismatched, ambiguous, or superseded by a newer wallet operation/event. EVM restoration matches the expected address on the live network; without an expected account it requires exactly one authorized account. Phantom uses `connect({onlyIfTrusted:true})` and validates its live public key. Persisted account data is only a selection hint; signing and execution still require fresh account/network checks and their existing explicit confirmations.

```ts
import { createEvmWallet, createExecutionController } from '@instinct/router-sdk';

const wallet = createEvmWallet(selectedInjectedProvider);
await wallet.connect(chooseAccount);
const execution = createExecutionController({ client: router, wallet, storage: localStorage });
await execution.proveOwnership();
const account = await wallet.getAccount();
const review = await execution.prepare({
  source: { chainId: 'eip155:8453', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  destination: { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  amount: userAmount,
  sender: account.address,
  recipient: userRecipient,
  slippageBps: userSlippageBps,
  maxFeeBps: userFeeLimitBps,
  nativeFeeBudgets: [{ chainId: 'eip155:8453', maxAmountRaw: userNativeFeeReserveWei }],
});
// Display review, then run this only from the user's execution button.
const submitted = await execution.execute(review, confirmExactAction);
// The callback receives the review and exact unsigned action; it must explicitly
// return true. The wallet still makes the final signing/broadcast decision.
const current = await execution.resume(); // recovery/status only; never resends
const progress = execution.getProgress(); // transient verified progress, or null
// DESTINATION_CONFIRMED may display "Funds received · final confirmation pending".
// Only current.status === 'COMPLETE' means final settlement checks passed.
```

`chooseAccount`, `confirmExactAction` and the `user*` values come from your UI. Review the minimum output, exact recipient, network, expiry and fee reserve. The reserve is a conservative estimate; Base L1 data/operator fees can change before inclusion. No unlimited token approval is needed for native ETH input.

For a durably reported submission, `resume()` uses one status request. `watch({signal,onUpdate})` receives authenticated pushed observations; the lower-level client exposes `watchExecution(id,{walletToken,signal,onUpdate})`. The example uses streaming, with bounded sequential polling only for an unavailable stream endpoint or connection loss. Protocol or ownership failures stop. Verified receipt of the exact destination funds can be displayed before the final Base/Solana confirmation policies finish. This display evidence is bound to the original action and hash, expires after fifteen seconds, and is cleared on errors or advancement. It is never restored from storage or used to authorize another trade. The example hides it when status checks stop. See [the progress contract](../server/EXECUTION_API.md) for the full response shape and finality requirements.

New Relay reviews include up to 25% gas-estimate headroom within the caller's native budget; aggregate fee comparisons include the full reviewed reserve. This does not change transaction gas/max-fee fields or existing review terms. `EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED` requests fresh terms, `EXECUTION_NATIVE_BUDGET_EXCEEDED` identifies the caller's configured cap, and `EXECUTION_NATIVE_BALANCE_INSUFFICIENT` identifies insufficient source-native funds. Never increase a user's settings automatically to recover an error.

The controller stores public recovery data before preparing, claiming or opening the wallet; wallet tokens stay in memory. A lost response, page reload, declined claimed action, or uncertain wallet result requires recovery, never another automatic send. Reconnect the same wallet, call `proveOwnership()` after a reload/session expiry, then `resume()`. Only an untouched READY review or an independently reverified exact approval-only prefix with an unclaimed deposit can `cancel()`. Do not delete recovery state to bypass an outstanding trade. The server's owner-active lookup recovers a missing prepare response.

Unsent `PREPARE_PENDING` requests have a 30-second reconciliation deadline, exposed as `expiresAtMs`. A subsequent `prepare()` first checks authenticated server state for an expired unsent request or an expired untouched review. An empty active lookup or verified terminal record releases the queue; a late active review is recovered and still requires explicit approval. The browser example automatically performs these read-only checks while its wallet login is active, with at most three attempts. It never opens a wallet prompt in the background. Claimed, submitted, and ambiguous transactions do not expire from elapsed time; their original evidence remains available for recovery. Independently confirmed `FAILED` executions permit a new trade without deleting history.

Lower-level methods expose challenge/verify, prepare, active/get, claim, submit, uncertain, refresh, watch and cancel; see the [execution contract](../server/EXECUTION_API.md). They require the wallet token and app credential. The SDK checks exact request policies, finite native reserves, action digests, locally reconstructed Solana messages and monotonic recovery evidence. Same-chain Base COMPLETE requires actual recipient credit and twelve canonical confirmations. Base → Solana requires twelve canonical Base funding confirmations and finalized native/SPL payout proof. Solana → Base requires finalized Solana funding plus a Base native-ETH receipt with `commitment: "canonical"` and at least twelve confirmations. Twelve Base confirmations do not claim Ethereum L1 finality. Cross-chain receipts bind the exact asset/recipient/minimum, Relay request ID and original source hash. Timeline fields are server observations, not exact broadcast or trade RTT.

For Base → Solana, use the exact reviewed Solana output mint or native SOL sentinel and an explicit Solana recipient public key. Connecting a destination wallet supplies an address only. For Solana → Base native ETH, use the Phantom source adapter and an explicit Base EOA recipient; the Base destination wallet does not sign. SOL uses 9 decimals and the system sentinel; wrapped SOL is a separate SPL mint. Native fee budgets use the source currency (wei on Base, lamports on Solana).

The operator must review the Base Relay depository/solver, fee-oracle implementation and Solana payout signers. Reverse execution additionally requires `executionPins.solanaRelay` for the program/program-data code, config/owner/allocator and vault. The SDK verifies a Solana action as exactly two leading ComputeBudget instructions (200,000 units and the reviewed fresh micro-lamport price) followed by one locally reconstructed Relay deposit, with derived accounts and bound source/order/destination terms. Phantom receives a full base58 unsigned transaction envelope: one zero signature slot plus the unchanged reviewed message. The wallet signs/submits once; the SDK never broadcasts or retries another wire format. Account checks run before submission. A valid returned transaction hash is preserved even if the wallet changes accounts during the prompt; a lost wallet response stays uncertain even after expiry.

Trusted configuration adds `executionPins.relay = {depository:{codeSha256,owner,allocator},solver,solanaSolverSigners:[publicKey]}` alongside existing `executionPins.base` pins. Each value must be independently reviewed; omitted pins keep the lane disabled. Operator-only `rpcEndpoints.solana` accepts a reviewed HTTPS endpoint list (default Solana mainnet-beta); callers cannot select RPCs. The Base-source Relay review cap is 60 seconds for native ETH and 90 seconds for ERC20 input; Solana-source reviews are capped at 60 seconds, with pricing capped at 15 seconds and provider expiry applied as an additional bound, within the lifecycle's 90-second maximum.

For admitted Base ERC20 input, `plan.actions` contains an exact approval plus deposit when necessary, or only the deposit when allowance already suffices. Each action requires an explicit `execute(review, confirmExactAction)` invocation; `resume()` and `watch()` never call it. The example's **Swap** handler sequences those invocations from one user gesture, using an in-memory consent scope for the same wallet, inputs, immutable plan and unexpired review. It continues only after the original approval is canonically confirmed at the exact next action. Stop, recovery, reload, changed terms, errors and ambiguous wallet outcomes end that consent. The wallet separately confirms every required transaction. The controller clears the previous action's pending hash at this transition while preserving submissions in the record. A confirmed approval-only review may be cancelled and requoted after independent receipt verification. Cancelling does not revoke allowance. Once the deposit is claimed, cancellation stays blocked.

Expanded direct-token and reverse-route probes establish simulation/fixture compatibility only. They do not establish a real wallet response time, live settlement latency, universal token liquidity or production readiness. Historical user-signed Base USDC → Solana USDC evidence remains separately labeled in the root validation report.
