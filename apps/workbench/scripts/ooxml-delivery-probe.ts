#!/usr/bin/env bun
/**
 * D431 Task 0.4 — inspect the emitted Silurus parser WASM closure.
 *
 * This deliberately inspects already-built output. It does not mutate Vite
 * configuration or copy assets: build the production app first, then run it.
 *
 * Examples:
 *   bun run build && bun scripts/ooxml-delivery-probe.ts --expect production
 *   bun scripts/ooxml-delivery-probe.ts --expect production --server-url http://127.0.0.1:3001
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const OOXML_FORMATS = ["docx", "xlsx", "pptx"] as const;
export type OoxmlFormat = (typeof OOXML_FORMATS)[number];

const WORKBENCH_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_DIST = resolve(WORKBENCH_ROOT, "dist");
export const DEFAULT_PACKAGE_ROOT = resolve(
  WORKBENCH_ROOT,
  "node_modules/@silurus/ooxml",
);
const WASM_MAGIC = "0061736d";
const OOXML_VERSION_RANGE = "~0.75.0";

export type ParserAsset = {
  readonly format: OoxmlFormat;
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly wasmMagic: boolean;
  readonly matchesInstalledPackage: boolean;
};

export type AssetClosureReport = {
  readonly distDir: string;
  readonly packageVersion: string;
  readonly totalDistBytes: number;
  readonly allWasmAssetNames: readonly string[];
  readonly parserAssets: readonly ParserAsset[];
};

/** The release line permitted by Workbench's declared `~0.75.0` dependency. */
export function isManifestCompatibleOoxmlVersion(version: string): boolean {
  return /^0\.75\.\d+$/.test(version);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parserFormatForAsset(name: string): OoxmlFormat | null {
  const match = /^(docx|xlsx|pptx)_parser_bg(?:-[A-Za-z0-9_-]+)?\.wasm$/.exec(name);
  return match?.[1] as OoxmlFormat | undefined ?? null;
}

/** Inspect the exact bytes Vite emitted against the installed pinned package. */
export async function inspectOoxmlAssetClosure(options: {
  readonly distDir?: string;
  readonly packageRoot?: string;
} = {}): Promise<AssetClosureReport> {
  const distDir = options.distDir ?? DEFAULT_DIST;
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const [distFiles, packageJson] = await Promise.all([
    filesUnder(distDir),
    readFile(resolve(packageRoot, "package.json"), "utf8"),
  ]);
  const packageVersion = (JSON.parse(packageJson) as { version?: unknown }).version;
  if (typeof packageVersion !== "string") {
    throw new Error(`Silurus package at ${packageRoot} has no string version.`);
  }

  const wasmFiles = distFiles.filter((path) => path.endsWith(".wasm"));
  const parserCandidates = wasmFiles
    .map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) }))
    .filter(({ name }) => parserFormatForAsset(name) !== null);

  const parserAssets = await Promise.all(
    parserCandidates.map(async ({ path, name }) => {
      const format = parserFormatForAsset(name);
      if (!format) throw new Error(`Unexpected parser asset name: ${name}`);
      const [emitted, installed] = await Promise.all([
        readFile(path),
        readFile(resolve(packageRoot, "dist", `${format}_parser_bg.wasm`)),
      ]);
      const emittedHash = sha256(emitted);
      return {
        format,
        name,
        byteLength: emitted.byteLength,
        sha256: emittedHash,
        wasmMagic: emitted.subarray(0, 4).toString("hex") === WASM_MAGIC,
        matchesInstalledPackage: emittedHash === sha256(installed),
      } satisfies ParserAsset;
    }),
  );
  const totalDistBytes = (await Promise.all(distFiles.map(async (path) => (await readFile(path)).byteLength))).reduce(
    (total, bytes) => total + bytes,
    0,
  );
  return {
    distDir,
    packageVersion,
    totalDistBytes,
    allWasmAssetNames: wasmFiles.map((path) => path.slice(path.lastIndexOf("/") + 1)).sort(),
    parserAssets: parserAssets.sort((left, right) => left.format.localeCompare(right.format)),
  };
}

/** Fail closed unless the ordinary production bundle carries all three parsers. */
export function assertProductionOoxmlAssetClosure(
  report: AssetClosureReport,
): void {
  if (!isManifestCompatibleOoxmlVersion(report.packageVersion)) {
    throw new Error(`Production closure must use an installed @silurus/ooxml version compatible with ${OOXML_VERSION_RANGE}, received ${report.packageVersion}.`);
  }
  if (report.parserAssets.length !== OOXML_FORMATS.length) {
    throw new Error(`Production build must emit exactly three parser WASM assets, received ${report.parserAssets.length}.`);
  }
  for (const format of OOXML_FORMATS) {
    const asset = report.parserAssets.find((candidate) => candidate.format === format);
    if (!asset?.wasmMagic || !asset.matchesInstalledPackage) {
      throw new Error(`Production ${format} parser WASM is missing, non-WASM, or mismatched with the installed @silurus/ooxml package.`);
    }
  }
}

export type ServerAssetDelivery = {
  readonly name: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly byteLength: number;
  readonly wasmMagic: boolean;
  readonly spaHtmlFallback: boolean;
};

/**
 * Probe an already-running Nautilo server. The missing asset is reported too:
 * release verification must reject an HTML SPA fallback for that request.
 */
export async function probeServerAssetDelivery(
  serverUrl: string,
  report: AssetClosureReport,
): Promise<readonly ServerAssetDelivery[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const names = [...report.parserAssets.map((asset) => asset.name), "d431-missing-parser.wasm"];
  return Promise.all(
    names.map(async (name) => {
      const response = await fetch(`${baseUrl}/assets/${name}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const textPrefix = new TextDecoder().decode(bytes.subarray(0, 32)).toLowerCase();
      return {
        name,
        status: response.status,
        contentType: response.headers.get("content-type"),
        byteLength: bytes.byteLength,
        wasmMagic: bytes.subarray(0, 4).toString() === "0,97,115,109",
        spaHtmlFallback: textPrefix.startsWith("<!doctype html"),
      } satisfies ServerAssetDelivery;
    }),
  );
}

function assertServerAssetDelivery(delivery: readonly ServerAssetDelivery[]): void {
  const missing = delivery.find((entry) => entry.name === "d431-missing-parser.wasm");
  if (!missing || missing.spaHtmlFallback || missing.status === 200) {
    throw new Error("Missing parser asset reached the SPA fallback; it must be a non-HTML failure response.");
  }
  for (const entry of delivery.filter((candidate) => candidate.name !== "d431-missing-parser.wasm")) {
    if (entry.status !== 200 || entry.contentType !== "application/wasm" || !entry.wasmMagic) {
      throw new Error(`Server did not return ${entry.name} as a WASM response.`);
    }
  }
}

function readArgument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const expected = readArgument("--expect");
  if (expected !== "production") {
    throw new Error("Pass --expect production.");
  }
  const report = await inspectOoxmlAssetClosure({ distDir: readArgument("--dist") });
  assertProductionOoxmlAssetClosure(report);
  const serverUrl = readArgument("--server-url");
  const delivery = serverUrl ? await probeServerAssetDelivery(serverUrl, report) : undefined;
  if (delivery && !process.argv.includes("--record-current-server-fallback")) {
    assertServerAssetDelivery(delivery);
  }
  process.stdout.write(`${JSON.stringify({ expected, report, delivery }, null, 2)}\n`);
}

if (import.meta.main) await main();
