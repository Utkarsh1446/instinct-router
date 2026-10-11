import { createQuoteService, createExecutionEngine, discoverQuoteCatalog, discoverProviderExecutionChains, createAssetBalanceReader } from '@instinct/router-engine';
import { createRouterApi, createFileExecutionStore } from '@instinct/router-server';
import { loadRuntimeConfig, port } from './config.mjs';

let store;
try {
  const config = await loadRuntimeConfig();
  const listenPort = port(process.env.ROUTER_PORT, 8791);
  let catalog = {};
  if (config.discoverChains !== false) {
    try { catalog = await discoverQuoteCatalog({ providerKeys: config.providerKeys }); }
    catch { console.warn('Chain discovery is unavailable; pricing will use the configured chains. Verified execution routes are unchanged.'); }
  }
  const service = createQuoteService({ ...config, ...catalog });
  let execution;
  let providerExecutionChains = [];
  if (config.executionPins?.providerManaged?.enabled === true || config.discoverChains !== false) {
      try { providerExecutionChains = await discoverProviderExecutionChains({ rpcOverrides: {
        ...(config.executionRpcEndpoints?.base?.[0] ? {'eip155:8453':config.executionRpcEndpoints.base[0]} : {}),
        ...(config.executionRpcEndpoints?.solana?.[0] ? {'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp':config.executionRpcEndpoints.solana[0]} : {}),
        ...config.providerExecutionRpcOverrides,
      } }); } catch { console.warn('Network RPC discovery is unavailable; configured Base/Solana balance reads and local execution recipes remain available.'); }
    }
  if (config.executionPins) {
    const engine = createExecutionEngine({ providerExecutionChains, executionPins: config.executionPins, rpcEndpoints: config.executionRpcEndpoints, providerKeys: config.providerKeys });
    if (!engine.capabilities().walletExecution) throw new Error('Execution pins do not enable a verified route.');
    store = await createFileExecutionStore({ directory: config.executionStoreDirectory });
    execution = { engine, store };
  }
  const balanceChains=[...providerExecutionChains];
  for(const c of [{chainId:'eip155:8453',vm:'EVM',rpcUrl:config.executionRpcEndpoints?.base?.[0]??'https://base-rpc.publicnode.com',nativeCurrency:{address:'0x'+'0'.repeat(40),decimals:18}},{chainId:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',vm:'SOLANA',rpcUrl:config.executionRpcEndpoints?.solana?.[0]??'https://solana-rpc.publicnode.com',nativeCurrency:{address:'11111111111111111111111111111111',decimals:9}}])if(!balanceChains.some(row=>row.chainId===c.chainId))balanceChains.push(c);
  // Publicnode restricts indexed token-account reads. Recheck the complete
  // observation on the same vetted canonical mainnet RPC used by claim recovery.
  for(const chain of balanceChains)if(chain.vm==='SOLANA')chain.rpcUrls=[...new Set([chain.rpcUrl,...(config.executionRpcEndpoints?.solana??[]),'https://api.mainnet-beta.solana.com'])].slice(0,3);
  const balances=createAssetBalanceReader({chains:balanceChains});
  const server = createRouterApi({ service, balances, apps: config.apps, ...(execution ? { execution } : {}) });
  server.on('error', async () => { console.error('Router could not bind its local port.'); await store?.close(); process.exitCode = 1; });
  server.listen(listenPort, '127.0.0.1', () => console.log(`Router API: http://127.0.0.1:${listenPort} (${execution ? 'reviewed wallet routes enabled; signing stays in your wallet' : 'pricing only'})`));
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    server.close(); server.closeAllConnections();
    try { await store?.close(); } catch { console.error('Execution store needs explicit recovery before restart.'); process.exitCode = 1; }
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch {
  await store?.close().catch(() => {});
  console.error('Router configuration is invalid or missing. Run npm run init:dev and check owner-only configuration files.');
  process.exitCode = 1;
}
