import type { RouterClient } from './index.js';
export { RouterSdkError, API_VERSION } from './index.js';
export type { Asset, AssetLookup, AssetBalanceInput, AssetBalanceResponse, QuoteRequest, QuoteResponse, RequestOptions, QuoteStreamOptions, ProvisionalQuoteMetadata, RouterClient, ConfigResponse, CapabilitiesResponse, PrepareRequest, PrepareResponse } from './index.js';
export interface ServerClientOptions {
  readonly baseUrl: string;
  /** Confidential app credential. Keep this constructor and key on your server. */
  readonly serverKey: string;
  /** Must return a standard streaming Response; buffered response shims are rejected. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export function createRouterServerClient(options: ServerClientOptions): RouterClient;

export * from './execution.js';
