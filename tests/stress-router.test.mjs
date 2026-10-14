import test from 'node:test';
import assert from 'node:assert/strict';
import { runOfflineStress, percentiles } from '../scripts/stress-router.mjs';
test('200 local HTTP requests contain failures, cancel streams and recover within bounded work',async()=>{
 const report=await runOfflineStress();
 assert.equal(report.requests,200);
 assert.deepEqual(report.phases,{healthy:144,malformedRejected:24,streamCancelled:8,recovery:8,providerFailureContained:16});
 assert.ok(report.peakService<=16&&report.peakService>1);
 assert.ok(report.peakProvider<=4&&report.peakProvider>1);
 assert.equal(report.cancelledService,8);
 assert.deepEqual(report.resources,{activeProvider:0,activeService:0,openSockets:0,serverClosed:true});
 assert.ok(report.latency.p95Ms>=report.latency.p50Ms);
});
test('stress inputs are bounded before opening any listener',async()=>{
 for(const concurrency of [0,17,Infinity,1.5])await assert.rejects(runOfflineStress({concurrency}));
 assert.deepEqual(percentiles([4,1,3,2]),{p50Ms:2,p95Ms:4,maxMs:4});
});
