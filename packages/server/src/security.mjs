import { createHash, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, retryable = false, retryAfterMs) {
    super(message); Object.assign(this, { status, code, retryable, retryAfterMs });
  }
}
export const fault = (status, code, message, retryable, retryAfterMs) => {
  throw new ApiError(status, code, message, retryable, retryAfterMs);
};
export function single(req, name) {
  let found;
  for (let at = 0; at < req.rawHeaders.length; at += 2) if (req.rawHeaders[at].toLowerCase() === name) {
    if (found !== undefined) fault(400, 'DUPLICATE_HEADER', 'Security and request headers must occur once.');
    found = req.rawHeaders[at + 1];
  }
  return found;
}
const digest = value => createHash('sha256').update(value).digest();
function validOrigin(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && url.origin === value && !url.username && !url.password &&
      (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
export function createAuthentication(rawApps) {
  if (!Array.isArray(rawApps) || !rawApps.length || rawApps.length > 128) throw new Error('Invalid router app configuration.');
  const ids = new Set(), keys = new Set();
  const apps = rawApps.map(raw => {
    if (!raw || typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(raw.id) || ids.has(raw.id) ||
        !Array.isArray(raw.allowedOrigins) || raw.allowedOrigins.length > 64 || raw.allowedOrigins.some(value => !validOrigin(value)) ||
        [raw.publishableKey, raw.serverKey].some(key => typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(key) || keys.has(key)) ||
        raw.publishableKey === raw.serverKey) throw new Error('Invalid router app configuration.');
    const rateLimit = raw.rateLimitPerMinute ?? 60, maxConcurrent = raw.maxConcurrent ?? 2;
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100000 ||
        !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) throw new Error('Invalid router app limits.');
    ids.add(raw.id); keys.add(raw.publishableKey); keys.add(raw.serverKey);
    return { id: raw.id, allowedOrigins: new Set(raw.allowedOrigins), publishableHash: digest(raw.publishableKey),
      serverHash: digest(raw.serverKey), rateLimit, maxConcurrent };
  });
  const originKnown = origin => typeof origin === 'string' && apps.some(app => app.allowedOrigins.has(origin));
  return {
    originKnown,
    authenticate(req) {
      const origin = single(req, 'origin'), publishable = single(req, 'x-router-app-key'), authorization = single(req, 'authorization');
      if (publishable !== undefined && authorization !== undefined) fault(400, 'AMBIGUOUS_AUTHENTICATION', 'Use one authentication method.');
      if (origin !== undefined && !originKnown(origin)) fault(403, 'ORIGIN_NOT_ALLOWED', 'This app origin is not allowed.');
      let supplied, kind;
      if (publishable !== undefined) {
        if (origin === undefined) fault(403, 'ORIGIN_REQUIRED', 'Publishable keys require the app origin.');
        supplied = publishable; kind = 'publishableHash';
      } else if (authorization !== undefined) {
        if (origin !== undefined) fault(403, 'SERVER_KEY_BROWSER_FORBIDDEN', 'Server credentials cannot authenticate browser requests.');
        if (!/^Bearer [A-Za-z0-9_-]{16,256}$/.test(authorization)) fault(401, 'UNAUTHORIZED', 'A valid app credential is required.');
        supplied = authorization.slice(7); kind = 'serverHash';
      } else fault(401, 'UNAUTHORIZED', 'A valid app credential is required.');
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(supplied)) fault(401, 'UNAUTHORIZED', 'A valid app credential is required.');
      const fingerprint = digest(supplied);
      const app = apps.find(candidate => timingSafeEqual(fingerprint, candidate[kind]));
      if (!app) fault(401, 'UNAUTHORIZED', 'A valid app credential is required.');
      if (origin !== undefined && !app.allowedOrigins.has(origin)) fault(403, 'ORIGIN_NOT_ALLOWED', 'This app origin is not allowed.');
      return { app, origin };
    },
  };
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const requestFingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
