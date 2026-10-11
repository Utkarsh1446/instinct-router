/** Read-only diagnostics for a saved review. Never claims, signs or broadcasts. */
import { readFile, writeFile } from 'node:fs/promises';
import { readOwnedJson } from './config.mjs';
import { BASE_V3 } from '@instinct/router-core';
import { baseExecutionPrimitives as p } from '../packages/engine/src/base-readiness.mjs';
import { createBaseExecutionTransport } from '../packages/engine/src/base-execution-transport.mjs';
const journal = JSON.parse(await readFile('./.dev/executions/state.json', 'utf8'));
const record = process.argv[2] ? journal.records.find(row => row.id === process.argv[2]) : journal.records.at(-1);
if (!record || record.plan.source.chainId !== BASE_V3.chainId) throw Error('A saved Base review is required.');
const endpoints = await readOwnedJson(process.env.ROUTER_EXECUTION_RPC_FILE ?? './.dev/execution-rpc.json');
const wire = (url, init) => {
  const rows = JSON.parse(init.body);
  if (!Array.isArray(rows) || rows.some(row => !['eth_chainId','eth_getBlockByNumber','eth_getBalance','eth_call'].includes(row.method)))
    throw Error('Only diagnostic chain reads are permitted.');
  return fetch(url, init);
};
const transport = createBaseExecutionTransport(wire, endpoints.base), start = performance.now();
const word = value => BigInt(value).toString(16).padStart(64,'0');
const result = await transport.run(async (index, signal) => {
  let serial = 0;
  const read = async calls => (await p.rpc(transport.transports[index], calls, signal, ++serial)).map(p.result);
  const [chain, latest] = await read([{method:'eth_chainId',params:[]},{method:'eth_getBlockByNumber',params:['latest',false]}]);
  if(chain !== '0x2105') throw Error('Unexpected chain.');
  const header = p.blockHeader(latest, Date.now()), block = {blockHash:header.hash,requireCanonical:true};
  const [balance, ...fees] = await read([{method:'eth_getBalance',params:[record.plan.sender,block]},
    ...record.plan.actions.flatMap(action => {
      const tx=action.payload.transaction;
      return [p.call(p.ORACLE,'0xf1c7a58b'+word((tx.data.length-2)/2+512),block),p.call(p.ORACLE,'0x275aedd2'+word(tx.gas),block)];
    })]);
  const [canonical] = await read([{method:'eth_getBlockByNumber',params:[header.number,false]}]);
  if(canonical.hash !== header.hash || Date.now()-header.timestamp > 12000) throw Error('Snapshot no longer fresh/canonical.');
  const actions = record.plan.actions.map((action,i) => {
    const tx=action.payload.transaction, reserve=p.quantity(tx.gas)*p.quantity(tx.maxFeePerGas)+2n*p.integerWord(fees[2*i])+p.integerWord(fees[2*i+1]);
    const cap=BigInt(action.payload.nativeFeeCapRaw ?? record.plan.nativeCosts[0].amountRaw);
    return {id:action.id,reviewedCapRaw:cap.toString(),freshReserveRaw:reserve.toString(),changeRaw:(reserve-cap).toString(),exceedsReviewedCap:reserve>cap};
  });
  return {scope:'READ_ONLY_SAVED_REVIEW_GAS_DIAGNOSTIC',checkedAt:new Date().toISOString(),recordId:record.id,
    status:record.status,submissions:record.submissions.map(row=>row.hash),transactionSubmitted:false,
    sourceAsset:record.plan.source.address,amountRaw:record.plan.amountRaw,balanceRaw:p.quantity(balance).toString(),
    reviewedTotalRaw:record.plan.nativeCosts[0].amountRaw,userLimitRaw:record.request.nativeFeeBudgets[0].maxAmountRaw,
    freshTotalRaw:actions.reduce((sum,row)=>sum+BigInt(row.freshReserveRaw),0n).toString(),actions,
    elapsedMs:Math.round(performance.now()-start)};
});
await writeFile('./docs/validation/2026-10-10-gas-reserve-diagnostic.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
