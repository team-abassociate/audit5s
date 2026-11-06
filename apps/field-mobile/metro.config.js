const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * The web build (iOS users, in a browser) runs expo-sqlite as WebAssembly, which needs
 * `.wasm` bundled as an asset and the page cross-origin isolated (SharedArrayBuffer). The
 * same two headers are set by Caddy in production; these are for `expo start --web`.
 */
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('wasm');
config.server.enhanceMiddleware = (middleware) => (req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  return middleware(req, res, next);
};

/*
 * The browser's SQLite file pool is too small (see `web-sqlite-pool.js`). Done here and not with a
 * pnpm patch: a patch changes the package's install path, which the OTA check reads as a native
 * change, and every phone would need a new APK (R-70).
 */
const POOL = './wa-sqlite/AccessHandlePoolVFS';
const ORIGINAL_POOL = 'expo-sqlite-original-pool';
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath.split(path.win32.sep).join('/');
  if (platform === 'web' && moduleName === POOL && origin.endsWith('expo-sqlite/web/worker.ts')) {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'web-sqlite-pool.js') };
  }
  if (moduleName === ORIGINAL_POOL) {
    const web = path.join(path.dirname(require.resolve('expo-sqlite/package.json')), 'web');
    return { type: 'sourceFile', filePath: path.join(web, 'wa-sqlite', 'AccessHandlePoolVFS.js') };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
