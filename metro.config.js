const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// The browser uses the SQLite WebAssembly worker with asynchronous queries.
if (!config.resolver.assetExts.includes("wasm")) config.resolver.assetExts.push("wasm");

module.exports = config;
