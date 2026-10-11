import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const spec = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url)));
const schemas = spec.components.schemas;
const mutations = ['claim', 'submit', 'uncertain', 'refresh', 'cancel', 'watch'];
const lifecycle = ['/v1/executions/prepare', '/v1/executions/active', '/v1/executions/{executionId}',
  ...mutations.map(action => '/v1/executions/{executionId}/' + action)];
const resolve = ref => ref.split('/').slice(1).reduce((value, key) => value?.[key], spec);
function visit(value, callback) {
  if (!value || typeof value !== 'object') return;
  callback(value); for (const child of Object.values(value)) visit(child, callback);
}
test('OpenAPI local references, operation IDs and required fields are consistent', () => {
  assert.equal(spec.openapi, '3.1.0');
  visit(spec, value => {
    if (value.$ref) { assert.ok(value.$ref.startsWith('#/')); assert.ok(resolve(value.$ref), value.$ref); }
    if (Array.isArray(value.required) && value.properties && value.type === 'object') for (const key of value.required) assert.ok(Object.hasOwn(value.properties ?? {}, key), key);
  });
  const ids = [];
  for (const item of Object.values(spec.paths)) for (const method of ['get', 'post', 'options'])
    if (item[method]) ids.push(item[method].operationId);
  assert.equal(ids.length, new Set(ids).size);
});
test('wallet proof and every execution operation use the intended exact security matrix', () => {
  assert.deepEqual(spec.paths['/healthz'].get.security, []);
  const expected = [{ PublishableKey: [], AppOrigin: [], WalletToken: [] }, { ServerBearer: [], WalletToken: [] }];
  assert.equal(spec.components.securitySchemes.WalletToken.name, 'X-Router-Wallet-Token');
  for (const path of lifecycle) {
    const method = path.endsWith('/active') || path.endsWith('{executionId}') ? 'get' : 'post';
    const operation = spec.paths[path][method]; assert.ok(operation, path);
    assert.deepEqual(operation.security, expected, path);
    assert.ok(operation.responses['200']); assert.ok(operation.responses['501']);
    assert.deepEqual(spec.paths[path].options.security, []);
  }
  for (const path of ['/v1/wallets/challenge', '/v1/wallets/verify']) {
    assert.ok(spec.paths[path].post); assert.equal(spec.paths[path].post.security, undefined);
  }
  assert.deepEqual(spec.security, [{ PublishableKey: [], AppOrigin: [] }, { ServerBearer: [] }]);
});
test('execution requests reject extra fields and expose no snapshot authorization shortcut', () => {
  for (const name of ['WalletChallengeInput', 'WalletVerifyInput', 'PrepareInput', 'ReviewInput', 'SubmitInput', 'EmptyInput', 'NativeFeeBudget'])
    assert.equal(schemas[name].additionalProperties, false, name);
  assert.deepEqual(schemas.WalletChallengeInput.required, ['chainId', 'address']);
  assert.deepEqual(schemas.WalletVerifyInput.required, ['challengeId', 'signature']);
  assert.deepEqual(schemas.PrepareInput.required, ['source', 'destination', 'amount', 'sender', 'recipient', 'nativeFeeBudgets']);
  assert.equal(schemas.PrepareInput.properties.quoteId, undefined);
  assert.deepEqual(schemas.ReviewInput.required, ['reviewHash', 'revision']);
  assert.deepEqual(schemas.SubmitInput.required, ['transactionHash']);
  assert.deepEqual(schemas.EmptyInput.required, []);
  assert.equal(schemas.PrepareInput.properties.maxFeeBps.default, 100);
  const amount = new RegExp(schemas.PrepareInput.properties.amount.pattern);
  assert.ok(amount.test('0.00005')); assert.ok(amount.test('1.25'));
  for (const value of ['1e5', '+1', '01', '1.1234567890123456789']) assert.equal(amount.test(value), false);
  for (const action of mutations) {
    const input = spec.paths['/v1/executions/{executionId}/' + action].post.requestBody.content['application/json'].schema;
    assert.equal(resolve(input.$ref).additionalProperties, false);
  }
});
test('explicit null fee and native ceilings are documented separately from unchanged omission defaults', () => {
  for (const name of ['QuoteInput', 'PrepareInput', 'ExecutionRequest'])
    assert.deepEqual(schemas[name].properties.maxFeeBps.type, ['integer', 'null']);
  assert.equal(schemas.QuoteInput.properties.maxFeeBps.default, 500);
  assert.equal(schemas.PrepareInput.properties.maxFeeBps.default, 100);
  assert.deepEqual(schemas.NativeFeeBudget.properties.maxAmountRaw.type, ['string', 'null']);
  assert.deepEqual(schemas.NativeFeeBudget.required, ['chainId', 'maxAmountRaw']);
});
test('asset schema permits configured EVM chains beyond the original menu and uint8 token precision', () => {
  for (const name of ['Asset', 'AssetLookup', 'ResolvedAsset']) {
    const chain = schemas[name].properties.chainId;
    assert.equal(chain.enum, undefined);
    assert.ok(new RegExp(chain.pattern).test('eip155:10'));
    assert.equal(new RegExp(chain.pattern).test('eip155:0'), false);
  }
  assert.equal(schemas.Asset.properties.decimals.maximum, 255);
  assert.equal(schemas.QuoteInput.properties.amount.maxLength, 334);
});
test('pricing remains read-only while supported execution, receipt and recovery are typed separately', () => {
  assert.equal(schemas.Execution.properties.enabled.const, false);
  assert.equal(schemas.QuoteSnapshot.properties.execution.$ref, '#/components/schemas/Execution');
  assert.equal(schemas.QuoteSnapshot.properties.readOnly.const, true);
  assert.equal(schemas.Candidate.properties.executionReady.const, false);
  assert.equal(schemas.Config.properties.execution.$ref, '#/components/schemas/ExecutionSupport');
  assert.equal(schemas.ExecutionSupport.properties.broadcastsTransactions.const, false);
  assert.deepEqual(schemas.ExecutionStatus.enum, ['READY', 'CLAIMED', 'SUBMITTED', 'COMPLETE', 'RECOVERY_REQUIRED', 'CANCELLED', 'EXPIRED', 'FAILED']);
  assert.ok(schemas.ExecutionReceipt.properties.actualNativeFeeRaw);
  assert.equal(schemas.ExecutionReceipt.properties.destinationCredit.$ref, '#/components/schemas/DestinationCredit');
  assert.match(schemas.ExecutionTimeline.description, /Not exact/);
  assert.equal(schemas.ReviewedAction.properties.payload, undefined);
  assert.ok(schemas.ReviewedAction.required.includes('payloadHash'));
  assert.equal(schemas.ClaimResponse.properties.action.$ref, '#/components/schemas/UnsignedAction');
  assert.equal(schemas.EvmTransaction.properties.type.const, '0x2');
  assert.equal(schemas.EvmTransaction.properties.chainId.const, '0x2105');
});

test('Relay execution separates chain-specific destination proofs from source funding and types immutable order metadata', () => {
  assert.equal(schemas.ExecutionRecord.properties.destinationReceipt.$ref, '#/components/schemas/DestinationReceipt');
  const [receipt, baseReceipt]=schemas.DestinationReceipt.oneOf;
  assert.equal(receipt.additionalProperties,false);
  assert.equal(receipt.properties.chainId.const,'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(receipt.properties.commitment.const,'finalized');
  assert.equal(receipt.properties.destinationCredit.$ref,'#/components/schemas/DestinationCredit');
  assert.deepEqual(receipt.properties.attribution.required,['provider','requestId','sourceTransactionHash']);
  assert.equal(receipt.properties.attribution.additionalProperties,false);
  assert.equal(receipt.properties.attribution.properties.provider.const,'relay');
  assert.ok(receipt.required.includes('destinationCredit'));assert.ok(receipt.required.includes('attribution'));
  const branch=schemas.ExecutionRecord.allOf[0];
  assert.deepEqual(branch.then.allOf[0].then.required,['receipt','destinationReceipt']);
  assert.deepEqual(branch.then.properties.receipt.not.required,['destinationCredit']);
  assert.deepEqual(schemas.ExecutionRecord.allOf[1].then.not.required,['destinationReceipt']);
  assert.equal(baseReceipt.properties.chainId.const, 'eip155:8453');
  assert.equal(baseReceipt.properties.commitment.const, 'canonical');
  assert.equal(baseReceipt.properties.confirmations.minimum, 12);
  assert.ok(baseReceipt.required.includes('confirmations'));
  assert.equal(baseReceipt.properties.attribution.properties.sourceTransactionHash.pattern, receipt.properties.transactionHash.pattern);
  assert.equal(branch.if.anyOf.length, 2);
  const [evmAction, solanaAction] = schemas.UnsignedAction.oneOf;
  for (const action of [evmAction, solanaAction])
    assert.equal(action.properties.payload.properties.relay.$ref,'#/components/schemas/RelayOrderMetadata');
  assert.equal(solanaAction.properties.chainId.const, receipt.properties.chainId.const);
  assert.equal(solanaAction.properties.payload.properties.type.const, 'SOLANA_TRANSACTION');
  assert.deepEqual(solanaAction.properties.payload.properties.transaction.required, ['message','blockhash','lastValidBlockHeight','feePayer']);
  assert.deepEqual(schemas.RelayOrderMetadata.required,['requestId','orderId','orderData']);
  assert.ok(schemas.RelayOrderMetadata.properties.orderSignature);
  const profile = schemas.ExecutionSupport.properties.executionProfiles.items;
  assert.equal(profile.additionalProperties, false);
  assert.equal(profile.properties.requiresFreshValidation.const, true);
  assert.ok(profile.required.includes('sourceAssetTypes'));
  assert.ok(profile.required.includes('destinationAssetTypes'));
  assert.match(schemas.PrepareInput.description,/source contract may not enforce UI expiry/);
  assert.match(receipt.description,/not a bridge consensus certificate/);
});

test('execution watch documents authenticated bounded observations separately from final authority', () => {
  const operation = spec.paths['/v1/executions/{executionId}/watch'].post;
  assert.ok(operation.responses['200'].content['application/x-ndjson']);
  assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/EmptyInput');
  assert.deepEqual(schemas.ExecutionWatchEvent.oneOf.map(row => row.properties.type.const), ['START', 'UPDATE', 'END', 'ERROR']);
  for (const row of schemas.ExecutionWatchEvent.oneOf) {
    assert.equal(row.additionalProperties, false);
    for (const key of ['executionId', 'requestId', 'appId', 'sequence', 'sentAtMs']) assert.ok(row.required.includes(key));
  }
  assert.equal(schemas.ExecutionWatchEvent.oneOf[1].properties.progress.$ref, '#/components/schemas/SettlementProgress');
  assert.equal(schemas.SettlementProgress.oneOf.length, 6);
  const reverse = schemas.SettlementProgress.oneOf.filter(row => row.properties.actionId.const === 'relay-solana-deposit');
  assert.equal(reverse.length, 2);
  assert.ok(reverse.every(row => row.properties.requiredSourceConfirmations.const === 1));
  assert.deepEqual(reverse[1].properties.destination.properties.commitment.enum, ['confirmed', 'canonical']);
});
