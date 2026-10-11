import { makeClient } from './transport.js';
import { RouterSdkError } from './errors.js';
export { RouterSdkError } from './errors.js';
export const API_VERSION = '1';
export function createRouterServerClient(options) {
  if (typeof globalThis.window !== 'undefined') throw new RouterSdkError('SERVER_ONLY', 'Server credentials cannot be used in a browser.');
  return makeClient(options, 'server');
}

export { createExecutionController } from './execution.js';
export { createEvmWallet, createPhantomWallet } from './wallets.js';
