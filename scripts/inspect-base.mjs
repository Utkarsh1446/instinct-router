/** Read-only live SDK inspection. No private keys, signing or broadcasting. */
import { writeFile } from 'node:fs/promises';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { readOwnedJson } from './config.mjs';
const sender = process.env.ROUTER_TEST_BASE_WALLET;
if (!sender) throw new Error('Supply the public ROUTER_TEST_BASE_WALLET address.');
const apps = await readOwnedJson(new URL('../.dev/apps.json', import.meta.url).pathname);
const client = createRouterServerClient({baseUrl:'http://127.0.0.1:8791',serverKey:apps.apps[0].serverKey});
const config = await client.getConfig();
if (!config.capabilities.executionInspection) throw new Error('Enable independentRoutes in local trusted policy.');
const asset = id => { const {chainId,address,decimals} = config.assets.find(row => row.id === id); return {chainId,address,decimals}; };
const input = {source:asset('base-eth'),destination:asset('base-usdc'),amount:'0.00005',sender,recipient:sender,slippageBps:50};
const start = performance.now(), result = await client.inspectExecution(input);
const {balanceRaw, ...fees} = result.fees ?? {};
const report = {capturedAt:new Date().toISOString(),mode:'READ_ONLY_LIVE_SDK_INSPECTION',pair:'Base ETH -> Base USDC',amount:input.amount,
  sdkRttMs:Math.round(performance.now()-start),inspectionRttMs:result.inspectionRttMs,status:result.status,
  checkedAtMs:result.checkedAtMs,validUntilMs:result.validUntilMs,quote:result.quote,fees,evidence:result.evidence,
  walletFundingSufficient:balanceRaw !== undefined && fees.totalNativeBudgetRaw !== null && fees.totalNativeBudgetRaw !== undefined ? BigInt(balanceRaw)>=BigInt(result.amountRaw)+BigInt(fees.totalNativeBudgetRaw):null,
  transactionPrepared:result.transactionPrepared,blockers:result.blockers,executionReady:result.executionReady,
  tradeRttMs:null,interpretation:'Simulation and estimated fee-component check only. No wallet authorization, transaction submission or independently verified recipient balance delta. Public wallet balance/address omitted from this report.'};
if(process.argv[2]) await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,sdkRttMs:report.sdkRttMs,expectedOutputRaw:report.quote?.expectedOutputRaw,
  estimatedNativeBudgetRaw:fees.totalNativeBudgetRaw,blockers:report.blockers,executionReady:false}));
