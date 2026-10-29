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

module.exports = config;
