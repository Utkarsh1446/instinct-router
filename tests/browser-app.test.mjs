import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = (await readFile(new URL('../examples/browser/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const html = await readFile(new URL('../examples/browser/index.html', import.meta.url), 'utf8');
class Element extends EventTarget {
  value = ''; textContent = ''; dataset = {}; children = []; hidden = false;
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(quoteStream) {
  const fields = new Map();
  const $ = id => { if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
  $('price-panel').hidden = true; $('readiness').hidden = true;
  $('slippage').value = '0.50'; $('amount').value = '1';
  const document = {getElementById: $, createElement: () => new Element()};
  const client = {getConfig: async () => ({assets: []}), quoteStream};
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('document', 'window', 'fetch', 'createRouterClient', 'initTokenSelection', 'selectedToken', 'initWalletUi', 'initAssetBalances', source)(
    document, {}, async () => ({json: async () => ({})}), () => client, () => {}, async () => ({decimals: 6}),
    () => ({addressesValid: () => false, assertAddresses() {}}), () => {});
  return {$, submit: async () => { $('quote-form').dispatchEvent(new Event('submit', {cancelable: true})); await tick(); }};
}
const route = {id: 'r', providerName: 'Provider', expectedOutputRaw: '1000000', minimumOutputRaw: '990000', feeBps: 10, priceImpactBps: 1, estimatedCompletionMs: 1000, eligible: true};
const result = candidates => ({candidates, winner: 'r', request: {destination: {decimals: 6}}, comparisonComplete: true});

test('idle form keeps Routes hidden and clears old results when inputs change', async () => {
  const f = await fixture(async () => result([route]));
  assert.equal(f.$('price-panel').hidden, true);
  assert.equal(f.$('status').textContent, '');
  await f.submit();
  assert.equal(f.$('price-panel').hidden, false);
  assert.equal(f.$('routes').children.length, 1);
  f.$('quote-form').dispatchEvent(new Event('input'));
  assert.equal(f.$('price-panel').hidden, true);
  assert.equal(f.$('routes').children.length, 0);
  assert.equal(f.$('status').textContent, '');
});

test('pending requests stay hidden until a route arrives', async () => {
  let onCandidate, complete;
  const f = await fixture((input, callbacks) => { onCandidate = callbacks.onCandidate; return new Promise(resolve => { complete = resolve; }); });
  await f.submit();
  assert.equal(f.$('price-panel').hidden, true);
  onCandidate(route);
  assert.equal(f.$('price-panel').hidden, false);
  assert.equal(f.$('routes').children.length, 1);
  complete(result([route])); await tick();
  assert.equal(f.$('routes').children.length, 1);
});

test('empty results and request errors remain visible', async () => {
  const empty = await fixture(async () => result([])); await empty.submit();
  assert.equal(empty.$('price-panel').hidden, false);
  assert.match(empty.$('routes').children[0].textContent, /No routes found/);
  const failed = await fixture(async () => { throw Error('Price service unavailable'); }); await failed.submit();
  assert.equal(failed.$('price-panel').hidden, false);
  assert.equal(failed.$('status').dataset.error, 'true');
  assert.match(failed.$('status').textContent, /Price service unavailable/);
});

test('consumer markup retains collapsed settings and hides diagnostics', () => {
  assert.match(html, /<details>\s*<summary>Settings<\/summary>/);
  assert.match(html, /id="slippage"/); assert.match(html, /id="max-fee"/);
  assert.match(html, /id="price-panel"[^>]* hidden/);
  assert.match(html, /id="execution-support"[^>]* hidden/);
  assert.match(html, /id="timings"[^>]* hidden/);
  assert.match(html, /id="response" hidden/);
  assert.doesNotMatch(html, /<summary>Route details<\/summary>/);
});

test('receiving estimate follows the eligible winner and clears when inputs or comparison fail',async()=>{
  let fail=false;
  const f=await fixture(async()=>{if(fail)throw Error('Unavailable');return result([{...route,expectedOutputRaw:'123456789012345678901234567890'}]);});
  await f.submit();assert.equal(f.$('receive-amount').textContent,'123456789012345678901234.56789');assert.equal(f.$('receive-amount').dataset.state,'quoted');
  f.$('quote-form').dispatchEvent(new Event('input'));assert.equal(f.$('receive-amount').textContent,'0.00');assert.equal(f.$('receive-amount').dataset.state,'empty');
  fail=true;await f.submit();assert.equal(f.$('receive-amount').textContent,'0.00');
  const excluded=await fixture(async()=>result([{...route,eligible:false}]));await excluded.submit();assert.equal(excluded.$('receive-amount').dataset.state,'empty');
});

test('a superseded stream cannot repaint the receiving estimate for changed assets',async()=>{
  let onCandidate;
  const f=await fixture((input,callbacks)=>{onCandidate=callbacks.onCandidate;return new Promise(()=>{});});await f.submit();
  onCandidate(route);assert.equal(f.$('receive-amount').textContent,'1');
  f.$('quote-form').dispatchEvent(new Event('input'));onCandidate({...route,expectedOutputRaw:'2000000'});
  assert.equal(f.$('receive-amount').textContent,'0.00');
});
