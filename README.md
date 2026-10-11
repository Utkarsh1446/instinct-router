# Instinct Router

A standalone swap widget, developer SDK, and wallet-authorized routing API. It supports same-chain and cross-chain routes across configured EVM networks and Solana, including assets entered by contract or mint address. It runs separately from the Instinct application.

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
