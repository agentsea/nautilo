// Metro config for the Nautilo mobile app inside the bun monorepo.
// Without watchFolders → repo root + the two nodeModulesPaths, Metro
// cannot resolve the workspace `@nautilo/*` packages (D369 §Architecture).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// D515: Metro treats these three parser payloads as ordinary Web assets.  The
// names below are deliberately virtual: Silurus does not export its `.wasm`
// files as package subpaths, and only the Web-only diagnostic loaders may ask
// Metro for them.  Native must never resolve this closure.
const silurusDist = path.dirname(require.resolve("@silurus/ooxml"));
const sharedBrowserViewerWasmAssets = new Map([
  ["@nautilo/shared-browser-viewer-wasm/docx_parser_bg.wasm", path.join(
    silurusDist,
    "docx_parser_bg.wasm",
  )],
  ["@nautilo/shared-browser-viewer-wasm/xlsx_parser_bg.wasm", path.join(
    silurusDist,
    "xlsx_parser_bg.wasm",
  )],
  ["@nautilo/shared-browser-viewer-wasm/pptx_parser_bg.wasm", path.join(
    silurusDist,
    "pptx_parser_bg.wasm",
  )],
]);

// 1. Watch the whole monorepo so changes in packages/* hot-reload.
config.watchFolders = [monorepoRoot];

// 2. Resolve modules from the app first, then the monorepo root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Preserve Expo's defaults and add only the parser binary extension needed by
// the Web diagnostic closure.
config.resolver.assetExts = [...config.resolver.assetExts, "wasm"];

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const wasmAssetPath = sharedBrowserViewerWasmAssets.get(moduleName);
  if (wasmAssetPath) {
    if (platform !== "web") {
      throw new Error(`shared browser viewer WASM is Web-only: ${moduleName}`);
    }
    return { type: "assetFiles", filePaths: [wasmAssetPath] };
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
