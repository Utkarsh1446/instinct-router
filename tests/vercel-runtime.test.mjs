import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicRuntimeConfig, normalizePublicRequest, restorePublicApiPath, vercelClientKey } from '../scripts/vercel-runtime.mjs';

const environment = () => ({ VERCEL: '1', VERCEL_ENV: 'production', ROUTER_PUBLIC_ORIGIN: 'https://router.example.com',
  VERCEL_URL: 'router-release.vercel.app', ROUTER_PUBLIC_APP_KEY: 'router_public_test_1234567890',
  ROUTER_SERVER_KEY: 'router_server_test_1234567890', ROUTER_REDIS_NAMESPACE: 'router-production-v1',
  UPSTASH_REDIS_REST_URL: 'https://redis.example.com', UPSTASH_REDIS_REST_TOKEN: 'server-only-test-token' });
const request = (headers = {}, method = 'GET') => ({ method, headers: { ...headers }, rawHeaders: Object.entries(headers).flat() });

test('public runtime requires explicit production credentials, HTTPS origin and durable namespace', () => {
  const config = loadPublicRuntimeConfig(environment());
  assert.deepEqual(config.allowedOrigins, ['https://router.example.com', 'https://router-release.vercel.app']);
  assert.equal(config.apps[0].publishableKey, environment().ROUTER_PUBLIC_APP_KEY);
  for (const change of [{ VERCEL_ENV: 'preview' }, { VERCEL: undefined }, { ROUTER_REDIS_NAMESPACE: undefined },
    { ROUTER_PUBLIC_ORIGIN: 'http://localhost:8792' }, { ROUTER_PUBLIC_ORIGIN: 'https://router.example.com/path' },
    { ROUTER_SERVER_KEY: environment().ROUTER_PUBLIC_APP_KEY }, { ROUTER_SERVER_KEY: 'REPLACE_WITH_SERVER_CREDENTIAL' }])
    assert.throws(() => loadPublicRuntimeConfig({ ...environment(), ...change }));
});

test('same-origin GET inference is narrowly bound to configured host and browser metadata', () => {
  const allowed = ['https://router.example.com'];
  const good = request({ host: 'router.example.com', 'sec-fetch-site': 'same-origin', 'x-router-app-key': 'public' });
  normalizePublicRequest(good, allowed);
  assert.equal(good.headers.origin, allowed[0]);
  assert.deepEqual(good.rawHeaders.slice(-2), ['Origin', allowed[0]]);
  for (const [headers, method] of [
    [{ host: 'evil.example', 'sec-fetch-site': 'same-origin' }, 'GET'],
    [{ host: 'router.example.com', 'sec-fetch-site': 'cross-site' }, 'GET'],
    [{ host: 'router.example.com' }, 'GET'],
    [{ host: 'router.example.com', 'sec-fetch-site': 'same-origin', authorization: 'Bearer secret' }, 'GET'],
    [{ host: 'router.example.com', 'sec-fetch-site': 'same-origin' }, 'POST'],
  ]) { const req = request(headers, method); normalizePublicRequest(req, allowed); assert.equal(req.headers.origin, undefined); }
  const explicit = request({ host: 'router.example.com', 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' });
  normalizePublicRequest(explicit, allowed); assert.equal(explicit.headers.origin, 'https://evil.example');
});

test('Vercel rate key accepts a single edge-provided IP, rejects spoofable chains and missing values', () => {
  for (const ip of ['192.0.2.1', '2001:db8::1']) assert.equal(vercelClientKey({ req: request({ 'x-forwarded-for': ip }) }), ip);
  for (const value of [undefined, '', 'client', '192.0.2.1, 192.0.2.2']) assert.throws(() => vercelClientKey({ req: request(value === undefined ? {} : { 'x-forwarded-for': value }) }));
  const duplicate = request({ 'x-forwarded-for': '192.0.2.1' }); duplicate.rawHeaders.push('X-Forwarded-For', '192.0.2.2');
  assert.throws(() => vercelClientKey({ req: duplicate }));
});

test('Vercel rewrite restores API paths without accepting arbitrary or duplicate query parameters', () => {
  for (const path of ['/healthz', '/v1/config', '/v1/executions/ex_123/refresh']) {
    const req = { url: '/api/router?__router_path=' + encodeURIComponent(path) };
    restorePublicApiPath(req); assert.equal(req.url, path);
    const original = { url: path + '?__router_path=' + encodeURIComponent(path) };
    restorePublicApiPath(original); assert.equal(original.url, path);
    if (path.startsWith('/v1/')) {
      const wildcard = { url: path + '?__router_path=' + encodeURIComponent(path) + '&path=' + encodeURIComponent(path.slice(4)) };
      restorePublicApiPath(wildcard); assert.equal(wildcard.url, path);
    }
  }
  for (const url of ['/api/router', '/api/router?__router_path=/v1/config&extra=1',
    '/api/router?__router_path=/v1/config&__router_path=/v1/capabilities',
    '/api/router?__router_path=https://evil.example', '/api/router?__router_path=/../.dev/apps.json',
    '/api/router?__router_path=/v1/config%3Fevil=1', '/v1/config?__router_path=/v1/config&path=executions',
    '/v1/config?__router_path=/v1/config&path=config&path=config']) {
    const req = { url }; restorePublicApiPath(req); assert.equal(req.url, url);
  }
});
