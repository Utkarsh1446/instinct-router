# Instinct Router

## NEAR Hackathon

Track: `defi`.

This repository is the existing Instinct Router, a wallet-custodied cross-chain router. The hackathon work adds a NEAR Intents 1Click route provider, ranks it with the existing providers, and shows the result in a quote-only widget. It does not share code with the team's other hackathon entries (Light Swarm, Dryrun, Intents Thesis, Mutuals, 404, Receipts, Crunch Oracle).

### Problem

A router can show several cross-chain prices, but a NEAR Intents quote is easy to confuse with an instruction to send funds. The user needs the 1Click output, fee, and ETA next to routes such as Relay, a deposit step that cannot be funded by accident, and a record of the quote the router committed to.

### What was added

- `createNearIntentsOneClickAdapter` in `@instinct/router-core`. It calls `https://1click.chaindefuser.com/v0/quote` with `dry: true` only. A response that contains `depositAddress`, `deadline`, or `timeWhenInactive` is rejected. The adapter returns output, a fee, an ETA, and a SHA-256 quote hash that `DynamicRouter` can rank against Relay.
- A static widget at `examples/near-intents`. The 1Click card is marked `DRY QUOTE`. The deposit panel says the address was not issued, and the send control stays disabled.
- `contracts/route-audit`, a NEAR testnet contract. `record_decision` appends a route id, quote hash, provider, output, fee, ETA, and objective. It does not hold swap funds or settle an intent.
- Chain Signatures are not implemented. A NEAR account could later sign an origin-chain deposit with them. This demo never requests a deposit address and never signs.

### Baseline and diff

The repository was created before the hackathon window. The baseline is the lightweight tag `pre-hackathon` on `6a3c4f289919c45913b7a54f65fe05735f2b1adb` (2026-10-14). Hackathon commits are on branch `near-hackathon`. The tag `hackathon-submission` points at the final hackathon commit.

Compare: https://github.com/Utkarsh1446/instinct-router/compare/pre-hackathon...hackathon-submission

The pre-hackathon tree already included the router core, Relay, Aurora, CCTP, DEX adapters, the server, and the browser swap widget. Those packages are baseline. The NEAR Intents adapter, the dry-quote widget, the audit contract, and this section were added in the hackathon window. AI assistance was used to write that new code. No new runtime npm dependency was added. The contract uses `near-sdk` 5.5.0. Deployment used `near-cli-rs` 0.31.1. 1Click is called over HTTPS; no 1Click SDK is vendored.

### Do this and see that

1. Build the static demo (commands below) and open it.
2. Leave the pair as ETH on Ethereum to USDC on Base, amount `0.05`, rank `Balanced`.
3. Press **Compare dry quotes**.
4. See one card per provider. The NEAR Intents card has a `DRY QUOTE` badge. The selected card is the one with the better ranked output, fee, and ETA. `executionAuthorized` stays false.
5. See **NEAR deposit address**. The field reads `Not issued — dry mode`. **Send funds** is disabled.
6. See **Testnet audit**. It links the contract and the stored sample decision. The page does not send a transaction. A new comparison shows its own quote hash locally and does not write it on chain.
7. Change the pair to ETH on Ethereum to USDC on NEAR and compare again. Relay is not registered for NEAR. The 1Click quote is still dry.

Screenshots of that flow are in `docs/screenshots/`.

### Run locally

Node 24 is what CI uses. The demo also runs on Node 22. Rust stable is required only for the contract tests.

```sh
npm ci --ignore-scripts
npm test
npm run build:near-demo
python3 -m http.server 4173 --directory dist/near-intents
```

Open `http://127.0.0.1:4173`. Optional live check from the shell, which prints outputs and confirms the 1Click deposit address is null:

```sh
npm run build
npm run smoke:near
```

Contract tests:

```sh
cargo test --manifest-path contracts/route-audit/Cargo.toml --locked --features test-utils
```

### Static build

Cloudflare Pages, no server:

| Setting | Value |
| --- | --- |
| Build command | `npm ci --ignore-scripts && npm run build:near-demo` |
| Output directory | `dist/near-intents` |

The page calls 1Click, Relay, and `https://rpc.testnet.near.org` from the browser. Both quote APIs respond with `access-control-allow-origin: *`. No API key is embedded.

### Testnet contract

| | |
| --- | --- |
| Account | `ir1cd33a844b.testnet` |
| Account | https://explorer.testnet.near.org/accounts/ir1cd33a844b.testnet |
| Deploy and `new` | `72mwEgpkx7oBud4zrkv7eJjqfHB6FxtiyXLjNC1pTTU3` |
| Deploy | https://explorer.testnet.near.org/transactions/72mwEgpkx7oBud4zrkv7eJjqfHB6FxtiyXLjNC1pTTU3 |
| `record_decision` | `7zMroVw8YRQUCxZCE6DhmBUk8yvv4ehk3nQrQn1FSkib` |
| Record | https://explorer.testnet.near.org/transactions/7zMroVw8YRQUCxZCE6DhmBUk8yvv4ehk3nQrQn1FSkib |

The recorded decision is route `demo-eth-base-usdc`, provider `near-intents-1click`, quote hash `dc38dedb35f27886e967eb668ce63c4efaad8799ed40ff0f781acb303beaefb0`, expected output `94856141` (USDC, 6 decimals), fee 20 bps, ETA 63000 ms, objective `BEST_OUTPUT`. On that live comparison Relay's expected output was higher (`94913124`) and its ETA was shorter, so the router selected Relay. The contract stores the 1Click dry-quote hash; it does not claim 1Click won. The faucet account key is not in this repository.

Quote hash preimage, UTF-8, this key order:

```json
{"amountIn":"...","amountOut":"...","correlationId":"...","destinationAsset":"...","minAmountOut":"...","originAsset":"..."}
```

### Limitations

- Quote-only. `dry: false` is rejected. Nothing is signed, submitted, or bridged. No mainnet contract. No production 1Click key. Unauthenticated 1Click quotes include the documented 20 bps app fee; a larger injected fee is rejected.
- 1Click has no testnet (hackathon Q-007). Dry quotes use the production quote API and do not open a swap.
- The 1Click signature is required to be present and is not verified against a published key.
- Fee basis: when 1Click adds one app fee, that fee is `feeBps`. USD shortfall above it is `priceImpactBps`. 1Click does not publish a separate impact number. Costs are already included in `amountOut` and are not subtracted again.
- Relay is quoted with the existing adapter (`useDepositAddress: false`, protocol data on). The order is not signed.
- The audit contract checks hash format and stores the row. It does not fetch 1Click or prove the hash.
- Preview addresses in the widget are not a connected wallet. Do not send funds to them.
- Chain Signatures are a stretch note only.
- The existing server, Redis, and execution pins are unchanged. This demo does not need them.

### Files to review before making the repository public

No `.env`, private key, or production credential is tracked. These files are still worth a look:

- `.env.example` — names of production env vars (Redis, Relay, Aurora, app keys). Values are placeholders.
- `config/apps.example.json` — example app record. The server key is a placeholder. The publishable value is a local test string, not a live credential.
- `config/base-execution-pins.json` — public chain addresses, code hashes, and Relay solver addresses used by the pre-hackathon execution review. No private keys.
- `config/policy.example.json` — example routing policy, no secrets.
- `vercel.json` — existing Vercel deploy shape. The hackathon demo does not use it.

The testnet key created for `ir1cd33a844b.testnet` stays outside the repository.

## Product baseline


A separately deployed swap widget, developer SDK, and wallet-authorized routing API, maintained in the [Instinct repository](https://github.com/Utkarsh1446/Instinct/tree/main/router). It supports same-chain and cross-chain routes across configured EVM networks and Solana, including assets entered by contract or mint address. Instinct uses the same SDK to fund token and eligible stock purchases; the market purchase remains a separately reviewed operation.

Users connect their own source and destination wallets. The backend compares routes, prepares fresh terms, validates transactions, and tracks settlement. Users sign and submit through their wallets; the service holds no wallet private keys.

## What can be traded

Use `/v1/config` for current chains, assets, and executable route profiles. Token presets are conveniences, not a token allowlist. Pasted addresses still need valid metadata, liquidity, supported transfer behavior, and a route that passes fresh execution checks. Token discovery and price previews do not authorize a trade.

Relay provides broad EVM/Solana execution. Reviewed Base/Solana recipes and independent DEX/CCTP price comparisons are also included. Aurora comparisons require its server-side API key. Provider support and executable support are reported separately. Tokenized stocks can use supported token routes; this project does not provide brokerage access to traditional stocks or prediction-market order execution.

## Packages

| Package | Purpose |
| --- | --- |
| `@instinct/router-core` | Route modeling, ranking, provider adapters, and execution coordinator |
| `@instinct/router-engine` | Provider discovery, token lookup, fresh transaction checks, and receipts |
| `@instinct/router-server` | HTTP API, wallet proof, durable execution storage, and status streaming |
| `@instinct/router-sdk` | Browser/server clients, wallet adapters, and execution flow |
| `examples/browser` | Lightweight swap widget using the same public SDK |

## Deploy to Vercel

See [deployment setup](docs/deployment.md) and [.env.example](.env.example). The project uses Node 24 or newer. Vercel serves the widget and `/v1` API on the same origin.

Production requires a dedicated durable Redis REST database with eviction disabled. Trade records, source-wallet reservations, replay indexes, wallet challenges, and wallet sessions are shared across function instances. No production execution state is written to temporary files. Missing storage or credentials fails closed. Preview deployments cannot use production execution credentials.

```sh
npm ci --ignore-scripts
npm run build
npm test
# Requires ROUTER_PUBLIC_APP_KEY, a publishable browser credential.
npm run build:vercel
```

The public static build contains only explicitly listed browser assets and its publishable credential. Server/provider keys remain in Vercel environment variables. Local configuration, wallets, execution history, and audit reports are excluded from Git and deployment uploads.

## Run the lightweight local example

```sh
npm run init:dev
npm run build
npm start
# In another terminal:
npm run example
```

The local API uses port 8791 and the widget uses port 8792. This starts no Instinct stack. The default local API is pricing-only; reviewed execution requires explicit execution pins, RPC settings, and a private file journal. Existing local configuration is preserved by `init:dev`.

## Use the SDK

`npm run pack` creates workspace package archives in `artifacts/`. Packages have not been published to npm. After installing the SDK archive:

```js
import { createRouterClient } from '@instinct/router-sdk';

const router = createRouterClient({
  baseUrl: 'https://YOUR_ROUTER_HOST',
  publishableKey: 'YOUR_APP_PUBLISHABLE_KEY',
});
const config = await router.getConfig();
const token = await router.resolveAsset({ chainId, address });
const quote = await router.quote({
  source, destination, amount: '1', sender, recipient,
  slippageBps: 50, objective: 'BALANCED', routeScope: 'ALL',
});
```

`source` and `destination` each contain `chainId`, `address`, and `decimals`. Amounts are decimal strings; output values use integer atomic-unit strings. Avoid floating-point arithmetic when preparing token amounts.

Use `quoteStream` for progressive prices and the wallet execution helpers demonstrated in `examples/browser/wallet-ui.js` for trading. Quotes are previews; execution prepares fresh terms and requires wallet ownership proof and wallet confirmations. A single Swap action can coordinate required steps, but wallets may require separate token-approval and transaction confirmations.

External browser apps need their own app configuration with an exact allowed origin. The public widget key does not authorize arbitrary third-party origins. Server integrations use `createRouterServerClient` from `@instinct/router-sdk/server` with a server-only credential. App keys never establish ownership of a wallet.

## API and recovery

See the [pricing OpenAPI contract](docs/openapi.json), [execution protocol](packages/server/EXECUTION_API.md), and [token coverage](docs/token-coverage.md).

Execution records persist exact reviewed terms, claims, original transaction hashes, and receipt evidence. A submitted or uncertain transaction must be recovered before another trade from the same source wallet can claim funds. Shared atomic storage prevents concurrent instances from claiming the same action. The service never automatically retries an ambiguous financial write or sends a transaction.

Price snapshots and quote idempotency are short-lived, per-instance conveniences; they may be unavailable after an instance change. Request a fresh quote in that case. Execution and wallet sessions use shared durable state. The widget's execution preparation does not depend on retrieving a saved price snapshot.

“Funds received” describes observed delivery. Final completion follows the route's configured source and destination verification policy. Quote latency, wallet response time, delivery time, and final verification time are different measurements.
