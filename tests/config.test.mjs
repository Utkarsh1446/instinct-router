import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig, readOwnedJson } from '../scripts/config.mjs';

test('runtime credentials are owner-only, never follow links, and only provider fields can be loaded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const apps = join(dir, 'apps.json'), keys = join(dir, 'keys.json'), link = join(dir, 'link.json');
  await writeFile(apps, JSON.stringify({ apps: [{ serverKey: 'actual_server_credential' }] }), { mode: 0o600 });
  await writeFile(keys, JSON.stringify({ AURORA_API_KEY: 'test-only-provider-value' }), { mode: 0o600 });
  const result = await loadRuntimeConfig({ ROUTER_APPS_FILE: apps, ROUTER_PROVIDER_KEYS_FILE: keys });
  assert.deepEqual(result.providerKeys, { AURORA_API_KEY: 'test-only-provider-value' });
  await symlink(keys, link);
  await assert.rejects(readOwnedJson(link));
  const shared = join(dir, 'shared.json');
  await writeFile(shared, '{}', { mode: 0o644 });
  await assert.rejects(readOwnedJson(shared), /owner-only/);
  await writeFile(keys, JSON.stringify({ signingSecret: 'invalid-for-provider-config' }));
  await assert.rejects(loadRuntimeConfig({ ROUTER_APPS_FILE: apps, ROUTER_PROVIDER_KEYS_FILE: keys }), /only RELAY_API_KEY/);
  await writeFile(apps, JSON.stringify({ apps: [{ serverKey: 'REPLACE_WITH_RANDOM_SERVER_CREDENTIAL' }] }));
  await assert.rejects(loadRuntimeConfig({ ROUTER_APPS_FILE: apps }), /actual app credentials/);
});

test('execution is opt-in with reviewed owner-only pins and a separate durable directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-execution-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const apps = join(dir, 'apps.json'), pins = join(dir, 'pins.json'), link = join(dir, 'pins-link.json');
  await writeFile(apps, JSON.stringify({ apps: [{ serverKey: 'actual_server_credential' }] }), { mode: 0o600 });
  await writeFile(pins, JSON.stringify({ base: { fixtureOnly: true } }), { mode: 0o600 });
  const env = { ROUTER_APPS_FILE: apps };
  assert.equal((await loadRuntimeConfig(env)).executionPins, undefined);
  await assert.rejects(loadRuntimeConfig({ ...env, ROUTER_EXECUTION_STORE_DIR: join(dir, 'journal') }), /reviewed execution pins/);
  await assert.rejects(loadRuntimeConfig({ ...env, ROUTER_EXECUTION_RPC_FILE: pins }), /reviewed execution pins/);
  const result = await loadRuntimeConfig({ ...env, ROUTER_EXECUTION_PINS_FILE: pins, ROUTER_EXECUTION_STORE_DIR: join(dir, 'journal') });
  assert.deepEqual(result.executionPins, { base: { fixtureOnly: true } });
  assert.equal(result.executionStoreDirectory, join(dir, 'journal'));
  const rpc = join(dir, 'rpc.json');
  await writeFile(rpc, JSON.stringify({ base: ['https://mainnet.base.org'] }), { mode: 0o600 });
  assert.deepEqual((await loadRuntimeConfig({ ...env, ROUTER_EXECUTION_PINS_FILE: pins, ROUTER_EXECUTION_RPC_FILE: rpc })).executionRpcEndpoints,
    { base: ['https://mainnet.base.org'] });
  await symlink(pins, link);
  await assert.rejects(loadRuntimeConfig({ ...env, ROUTER_EXECUTION_PINS_FILE: link }));
});
test('startup chain discovery policy is operator-owned and accepts only an explicit boolean', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-catalog-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const apps = join(dir, 'apps.json'), policy = join(dir, 'policy.json');
  await writeFile(apps, JSON.stringify({ apps: [{ serverKey: 'actual_server_credential' }] }), { mode: 0o600 });
  await writeFile(policy, JSON.stringify({ discoverChains: false }), { mode: 0o600 });
  assert.equal((await loadRuntimeConfig({ ROUTER_APPS_FILE: apps, ROUTER_POLICY_FILE: policy })).discoverChains, false);
  await writeFile(policy, JSON.stringify({ discoverChains: 'true' }));
  await assert.rejects(loadRuntimeConfig({ ROUTER_APPS_FILE: apps, ROUTER_POLICY_FILE: policy }), /boolean discoverChains/);
});

test('broad execution RPC overrides require separate explicit operator opt-in', async t => {
  const dir=await mkdtemp(join(tmpdir(),'router-provider-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const apps=join(dir,'apps.json'),pins=join(dir,'pins.json'),rpc=join(dir,'rpc.json');
  await writeFile(apps,JSON.stringify({apps:[{serverKey:'actual_server_credential'}]}),{mode:0o600});
  await writeFile(pins,JSON.stringify({providerManaged:{enabled:true}}),{mode:0o600});
  await writeFile(rpc,JSON.stringify({'eip155:8453':'https://base.drpc.org/'}),{mode:0o600});
  const env={ROUTER_APPS_FILE:apps,ROUTER_PROVIDER_EXECUTION_RPC_FILE:rpc};
  await assert.rejects(loadRuntimeConfig(env),/explicit providerManaged/);
  assert.deepEqual((await loadRuntimeConfig({...env,ROUTER_EXECUTION_PINS_FILE:pins})).providerExecutionRpcOverrides,{'eip155:8453':'https://base.drpc.org/'});
  await writeFile(rpc,JSON.stringify({base:'https://base.drpc.org/'}));
  await assert.rejects(loadRuntimeConfig({...env,ROUTER_EXECUTION_PINS_FILE:pins}),/chain-to-HTTPS/);
});
