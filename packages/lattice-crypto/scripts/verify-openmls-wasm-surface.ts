import { readFile } from "node:fs/promises";
import { join } from "node:path";

const artifactDir = process.argv[2];
if (!artifactDir) {
  throw new Error("usage: verify-openmls-wasm-surface.ts <artifact-dir>");
}

const normalizeImportName = (name: string): string =>
  name.replace(/_[0-9a-f]{16}$/, "");

const expectedImports = [
  "__wbg_Error",
  "__wbg___wbindgen_is_function",
  "__wbg___wbindgen_is_object",
  "__wbg___wbindgen_is_string",
  "__wbg___wbindgen_is_undefined",
  "__wbg___wbindgen_throw",
  "__wbg_call",
  "__wbg_crypto",
  "__wbg_getRandomValues",
  "__wbg_length",
  "__wbg_msCrypto",
  "__wbg_new",
  "__wbg_new_with_length",
  "__wbg_node",
  "__wbg_now",
  "__wbg_process",
  "__wbg_prototypesetcall",
  "__wbg_randomFillSync",
  "__wbg_require",
  "__wbg_static_accessor_GLOBAL",
  "__wbg_static_accessor_GLOBAL_THIS",
  "__wbg_static_accessor_SELF",
  "__wbg_static_accessor_WINDOW",
  "__wbg_subarray",
  "__wbg_versions",
  "__wbindgen_cast",
  "__wbindgen_cast",
  "__wbindgen_init_externref_table",
].sort();

const wasmPath = join(artifactDir, "openmls_wasm_bg.wasm");
const wasm = await readFile(wasmPath);
const module = new WebAssembly.Module(wasm);
const imports = WebAssembly.Module.imports(module);
const exports = WebAssembly.Module.exports(module);

for (const entry of imports) {
  if (entry.module !== "./openmls_wasm_bg.js" || entry.kind !== "function") {
    throw new Error(
      `unexpected WASM import boundary: ${entry.module}:${entry.name}:${entry.kind}`,
    );
  }
}

const actualImports = imports.map(({ name }) => normalizeImportName(name)).sort();
if (JSON.stringify(actualImports) !== JSON.stringify(expectedImports)) {
  throw new Error(
    [
      "OpenMLS WASM host imports changed; security review is required.",
      `Expected: ${expectedImports.join(", ")}`,
      `Actual:   ${actualImports.join(", ")}`,
    ].join("\n"),
  );
}

const glue = await readFile(join(artifactDir, "openmls_wasm.js"), "utf8");
const declaration = await readFile(
  join(artifactDir, "openmls_wasm.d.ts"),
  "utf8",
);
const requiredUpdateExport = "group_propose_and_commit_update";
if (
  !exports.some(
    (entry) =>
      entry.kind === "function" && entry.name === requiredUpdateExport,
  ) ||
  !glue.includes("propose_and_commit_update(provider, sender)") ||
  !declaration.includes(
    "propose_and_commit_update(provider: Provider, sender: Identity): UpdateMessages;",
  )
) {
  throw new Error(
    "OpenMLS WASM is missing the required RFC 9420 self-update commit surface",
  );
}

const prohibitedGlue = [
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/,
  /\bchild_process\b/,
  /\bDeno\./,
  /(?:from|require\s*\()\s*["'](?:node:)?(?:fs|net|http|https|child_process)["']/,
];
for (const pattern of prohibitedGlue) {
  if (pattern.test(glue)) {
    throw new Error(`prohibited host capability in OpenMLS glue: ${pattern}`);
  }
}

const fetchCalls = glue.match(/\bfetch\s*\(/g) ?? [];
if (
  fetchCalls.length !== 1 ||
  !glue.includes("module_or_path = fetch(module_or_path);")
) {
  throw new Error(
    "OpenMLS glue fetch surface changed; only the standard local WASM loader is allowed",
  );
}

console.log(
  "OpenMLS WASM host surface verified: randomness, time, globals, and the standard local loader only.",
);
