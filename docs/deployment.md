# Public deployment

The browser widget can be deployed with its API on the same HTTPS origin. The widget sends API calls to `/v1`; it does not call a development machine or ask the browser to hold provider secrets. Deploy this standalone workspace without the Instinct application, containers, or another application stack.

## Static build

Use Node 24 or newer and run:

```sh
node scripts/build-public.mjs
```

Set `ROUTER_PUBLIC_APP_KEY` in the build environment to the application's **publishable** credential. This value is intentionally downloadable. It must match the app configured on the API, whose allowed origins must include the exact deployed HTTPS origin. Never put a server credential, provider key, RPC credential, signing key, or private configuration JSON in this variable. There is no built-in production credential or test-key fallback; a missing or malformed value fails the build.

The build has no package dependencies and writes `public/`. It copies an explicit list of browser HTML, CSS and JavaScript and the browser SDK modules, plus generated `/demo-config.json`. The generated configuration contains only the publishable key and an empty `baseUrl`; the widget resolves that empty value to `window.location.origin`. SDK requests then target that origin's `/v1` paths. The build does not read `.dev`, private application configuration, provider configuration, execution journals, audit output, or environment variables other than `ROUTER_PUBLIC_APP_KEY`. It clears previous output so removed assets cannot survive a later build. Only `public/` is the static publish directory.

The local example still works with `npm run example`: `/demo-config.json` returns its explicit loopback API origin and local publishable credential. The legacy `/demo-config` endpoint remains available locally. No browser token or wallet address is prefilled with a test address.

## Vercel runtime setup

Link a new Vercel project to this repository. Use the included `vercel.json`: Node 24, `npm ci --ignore-scripts`, `npm run build:vercel`, output `public`, and a 240-second Node function in `iad1`. Choose Redis in the same region when available. The function does not open a listening port or require a local application stack.

Configure these production environment variables:

| Variable | Value |
| --- | --- |
| `ROUTER_PUBLIC_APP_KEY` | Fresh publishable app credential, at least 24 characters; also required for preview builds |
| `ROUTER_SERVER_KEY` | Separate random server-only credential, at least 24 characters |
| `ROUTER_PUBLIC_ORIGIN` | Exact production HTTPS origin, without a trailing slash |
| `ROUTER_REDIS_NAMESPACE` | Stable production identifier, 8–80 letters/digits/underscores/hyphens |
| `UPSTASH_REDIS_REST_URL` | Dedicated Redis REST endpoint; `KV_REST_API_URL` is also accepted |
| `UPSTASH_REDIS_REST_TOKEN` | Server-only write credential; `KV_REST_API_TOKEN` is also accepted |
| `RELAY_API_KEY`, `AURORA_API_KEY` | Optional server-only provider credentials |
| `ROUTER_EXECUTION_RPC_JSON` | Optional JSON object with `base` and `solana` arrays of operator-reviewed HTTPS RPCs |
| `ROUTER_PROVIDER_EXECUTION_RPC_JSON` | Optional chain-ID to HTTPS RPC mapping for other configured networks |

Use a dedicated persistent Redis database with eviction disabled. Never expire or clear execution records, claims, or their indexes to free capacity; archived replay protection still matters. Monitor the database's storage/command quotas and configure backups. Memory-only Redis and Vercel's temporary filesystem are not execution journals. The local `.dev/executions` journal remains separate and is not imported by deployment.

Set server/provider/storage credentials for production only. Preview APIs intentionally return unavailable, even if someone accidentally adds production settings to preview; they cannot initiate or recover production trades. The public static preview can be used to check layout and build integrity.

Provider discovery failures leave saved-trade reads and configured Base/Solana recovery available. Broad network discovery is retried on subsequent requests after one minute. Successful discovery refreshes after ten minutes. A temporary uncertain Redis write is never retried; a later request reopens the same durable journal before proceeding. Financial indexes have no TTL. Wallet proofs and hashed session tokens expire independently.

Public request limits use Vercel's overwritten client-IP header, storing only a hash. Quote, wallet-proof, read, and recovery budgets are separate so price-refresh traffic cannot consume the recovery budget. Deploy this entry point directly behind Vercel; a different hosting proxy requires its own trusted client-address policy.

Same-origin browser GET requests usually omit `Origin`. The entry point infers it only for a `same-origin` Fetch Metadata request whose Host exactly matches an allowed deployment origin. Explicit origins and server-key requests retain the normal authentication checks.

## Routing and browser headers

Serve `/`, the allowlisted static assets, and `/demo-config.json` from `public/`. Route `/v1` API paths and `/healthz` to the backend handler. A missing static file should return 404; an HTML fallback for API paths or missing JavaScript can hide deployment failures.

Recommended static response headers:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
```

Inline styles are used by the existing widget; scripts remain same-origin modules. Wallet signing happens through the user's installed wallet. API provider requests happen on the backend, so they do not require browser CSP exceptions.

## Token and execution scope

The widget supports selecting a listed chain and entering an EVM contract or Solana mint address. Metadata lookup determines precision when available; unsupported metadata may require explicit precision for a preview. The chain, exact token identity, liquidity, supported transfer behavior, fees, gas, and enabled execution configuration still determine whether a route can be quoted or traded. A visible token or successful price preview does not establish that execution is enabled. Read `/v1/config` capabilities and execution routes rather than promising universal token support.

Execution additionally requires wallet ownership proof, fresh fixed terms, preflight, wallet confirmation, and recoverable state. A deployment must preserve the backend's execution storage and origin checks; a successful static build or health response alone does not prove trade readiness.

## Verification

```sh
node --test tests/public-build.test.mjs tests/browser-app.test.mjs
```

The build tests verify the complete published module dependency graph, absence of unrelated environment values and stale files, repeatable output, rejection of invalid configuration, and public/local browser configuration compatibility. After deployment, check that `/demo-config.json` exposes only the intended publishable value, `/healthz` succeeds, `/v1/config` accepts that credential from the deployed origin, and the browser can list assets and request a price without loopback requests. Test wallet execution separately only when the deployed runtime explicitly enables it and its durable storage requirements are met.
