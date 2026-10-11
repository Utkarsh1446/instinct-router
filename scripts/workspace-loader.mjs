import { registerHooks } from 'node:module';
const entries = { '@instinct/router-core': '../packages/core/dist/index.js', '@instinct/router-engine': '../packages/engine/src/index.mjs', '@instinct/router-server': '../packages/server/src/index.mjs', '@instinct/router-sdk': '../packages/sdk/src/index.js', '@instinct/router-sdk/server': '../packages/sdk/src/server.js' };
registerHooks({ resolve(specifier, context, next) {
 if (Object.hasOwn(entries, specifier)) return { url: new URL(entries[specifier], import.meta.url).href, shortCircuit: true };
 return next(specifier, context);
} });
