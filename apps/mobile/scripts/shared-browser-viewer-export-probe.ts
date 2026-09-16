import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyMobileWebExport } from "./verify-mobile-web-export";

const MOBILE_BASE_PATH = "/mobile/";
const PDF_VERSION = "6.2.108";
const EMITTED_PDF_WORKER_BYTES = 1_236_103;
const PROBE_MARKERS = [
  "nautilo.shared-browser-viewer-export-probe.pdf.v1",
  "nautilo.shared-browser-viewer-export-probe.docx.v1",
  "nautilo.shared-browser-viewer-export-probe.xlsx.v1",
  "nautilo.shared-browser-viewer-export-probe.pptx.v1",
] as const;
const PDF_RENDERER_MARKER = "nautilo.browser-document-viewer.pdf-renderer.v1" as const;
const WASM_ASSETS = ["docx_parser_bg.wasm", "xlsx_parser_bg.wasm", "pptx_parser_bg.wasm"] as const;

type Platform = "web" | "ios" | "android";
type ExportDirectories = Record<Platform, string>;
type ExportPlan = { readonly directories: ExportDirectories; readonly temporaryRoot?: string };
type ByteIdentity = { readonly bytes: number; readonly sha256: string };

function fail(message: string): never {
  throw new Error(`shared browser viewer export probe: ${message}`);
}

function usage(): never {
  fail("usage: bun scripts/shared-browser-viewer-export-probe.ts [--web-dir <fresh-dir> --ios-dir <fresh-dir> --android-dir <fresh-dir>]");
}

async function fileIdentity(filePath: string): Promise<ByteIdentity> {
  const bytes = await readFile(filePath);
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  }));
  return nested.flat().sort();
}

async function requireFreshDirectory(directory: string): Promise<string> {
  try {
    await stat(directory);
  } catch {
    return directory;
  }
  fail(`output directory must not already exist: ${directory}`);
}

async function exportDirectories(args: readonly string[]): Promise<ExportPlan> {
  if (args.length === 0) {
    const root = await mkdtemp(path.join(tmpdir(), "nautilo-shared-browser-viewer-export-"));
    return { directories: {
      web: path.join(root, "web"),
      ios: path.join(root, "ios"),
      android: path.join(root, "android"),
    }, temporaryRoot: root };
  }
  if (args.length !== 6) usage();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || !["--web-dir", "--ios-dir", "--android-dir"].includes(flag)
      || value.startsWith("-")) usage();
    if (values.has(flag)) usage();
    values.set(flag, path.resolve(value));
  }
  const directories = {
    web: values.get("--web-dir"),
    ios: values.get("--ios-dir"),
    android: values.get("--android-dir"),
  };
  if (!directories.web || !directories.ios || !directories.android) usage();
  return { directories: {
    web: await requireFreshDirectory(directories.web),
    ios: await requireFreshDirectory(directories.ios),
    android: await requireFreshDirectory(directories.android),
  } };
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim().replaceAll(/\s+/g, " ").slice(-800);
    fail(`command failed: ${command.slice(1, 4).join(" ")}${detail ? ` (${detail})` : ""}`);
  }
}

async function exportPlatform(platform: Platform, outputDirectory: string, appRoot: string): Promise<void> {
  await run([
    process.execPath,
    "x",
    "expo",
    "export",
    "--platform",
    platform,
    "--output-dir",
    outputDirectory,
  ], appRoot);
}

function staticJsPaths(html: string): string[] {
  const paths = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  for (const resourcePath of paths) {
    if (!resourcePath.startsWith(MOBILE_BASE_PATH) || /[?#\\]/.test(resourcePath)) {
      fail(`HTML script path escapes ${MOBILE_BASE_PATH}`);
    }
  }
  return paths;
}

function outputPathForMobileUrl(outputDirectory: string, url: string): string {
  const relative = url.slice(MOBILE_BASE_PATH.length);
  const outputPath = path.resolve(outputDirectory, relative);
  if (!relative || !outputPath.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) {
    fail("HTML script path escapes the Web export");
  }
  return outputPath;
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(value, "utf8"));
}

async function installedAssetIdentities(appRoot: string): Promise<{
  readonly pdfWorker: ByteIdentity;
  readonly wasm: Readonly<Record<(typeof WASM_ASSETS)[number], ByteIdentity>>;
}> {
  const root = path.resolve(appRoot, "../..");
  const pdfWorker = await fileIdentity(path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.mjs"));
  const wasmEntries = await Promise.all(WASM_ASSETS.map(async (asset) => [
    asset,
    await fileIdentity(path.join(root, "node_modules/@silurus/ooxml/dist", asset)),
  ] as const));
  return { pdfWorker, wasm: Object.fromEntries(wasmEntries) as Record<(typeof WASM_ASSETS)[number], ByteIdentity> };
}

async function verifySharedBrowserViewerWebExportWithInstalled(
  outputDirectory: string,
  appRoot: string,
  installed: Awaited<ReturnType<typeof installedAssetIdentities>>,
) {
  await verifyMobileWebExport(outputDirectory);
  const files = await listFiles(outputDirectory);
  const sourceMaps = files.filter((file) => file.endsWith(".map"));
  if (sourceMaps.length > 0) fail("Web export publishes source maps");
  const jsFiles = files.filter((file) => file.endsWith(".js"));
  const jsSources = await Promise.all(jsFiles.map(async (file) => [file, await readFile(file, "utf8")] as const));
  if (jsSources.some(([, source]) => /sourceMappingURL\s*=/.test(source))) {
    fail("Web export contains sourceMappingURL directives");
  }

  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  const initialJsFiles = new Set<string>();
  for (const htmlFile of htmlFiles) {
    for (const url of staticJsPaths(await readFile(htmlFile, "utf8"))) {
      initialJsFiles.add(outputPathForMobileUrl(outputDirectory, url));
    }
  }
  if (initialJsFiles.size === 0) fail("Web export has no initial JavaScript entries");
  const initialSources = await Promise.all([...initialJsFiles].map((file) => readFile(file, "utf8")));
  for (const marker of [...PROBE_MARKERS, PDF_RENDERER_MARKER]) {
    if (initialSources.some((source) => source.includes(marker))) {
      fail(`format marker leaked into initial Web entry: ${marker}`);
    }
  }

  const chunksFor = (marker: string) => jsSources.filter(([, source]) => source.includes(marker));
  const markerChunkFiles = new Set<string>();
  for (const marker of PROBE_MARKERS) {
    if (chunksFor(marker).length !== 1) fail(`expected exactly one lazy chunk for ${marker}`);
    markerChunkFiles.add(chunksFor(marker)[0]![0]);
  }
  if (markerChunkFiles.size !== PROBE_MARKERS.length) {
    fail("format marker closures merged into a shared lazy chunk");
  }
  if (chunksFor(PDF_RENDERER_MARKER).length !== 1) {
    fail("expected exactly one lazy Web chunk for the browser PDF renderer core");
  }

  const workerChunks = jsSources.filter(([, source]) => source.includes("globalThis.pdfjsWorker={WorkerMessageHandler")
    && source.includes("WorkerMessageHandler"));
  if (workerChunks.length !== 1) fail("expected exactly one emitted PDF.js worker with WorkerMessageHandler identity");
  const [workerPath, workerSource] = workerChunks[0]!;
  if (!workerSource.includes(PDF_VERSION)) fail("emitted PDF.js worker does not contain the locked version");
  const installedPdfWorkerPath = path.resolve(appRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.mjs");
  const installedPdfWorkerSource = await readFile(installedPdfWorkerPath, "utf8");
  if (!installedPdfWorkerSource.includes("WorkerMessageHandler") || !installedPdfWorkerSource.includes(PDF_VERSION)) {
    fail("installed PDF.js worker does not match the locked WorkerMessageHandler/version contract");
  }
  const emittedPdfWorker = await fileIdentity(workerPath);
  if (emittedPdfWorker.bytes !== EMITTED_PDF_WORKER_BYTES) {
    fail("emitted PDF.js worker does not match the expected Metro byte count");
  }
  const [pdfFormatChunk] = chunksFor(PROBE_MARKERS[0]);
  const expectedWorkerUrl = `${MOBILE_BASE_PATH}${path.relative(outputDirectory, workerPath).split(path.sep).join("/")}`;
  const emittedWorkerUrls = [...pdfFormatChunk![1].matchAll(/\/mobile\/_expo\/static\/js\/web\/[A-Za-z0-9._-]+\.js/g)]
    .map((match) => match[0]);
  if (emittedWorkerUrls.length !== 1 || emittedWorkerUrls[0] !== expectedWorkerUrl) {
    fail("PDF format chunk does not resolve its literal /mobile worker URL to the identified WorkerMessageHandler chunk");
  }

  const wasmFiles = files.filter((file) => file.endsWith(".wasm"));
  if (wasmFiles.length !== WASM_ASSETS.length) fail("expected exactly three emitted Silurus WASM files");
  const exportedWasm: Record<string, ByteIdentity> = {};
  for (const asset of WASM_ASSETS) {
    const basename = path.basename(asset, ".wasm");
    const matches = wasmFiles.filter((file) => path.basename(file).startsWith(`${basename}.`));
    if (matches.length !== 1) fail(`expected one emitted WASM file for ${asset}`);
    const bytes = await readFile(matches[0]!);
    if (bytes.subarray(0, 4).compare(Buffer.from([0, 0x61, 0x73, 0x6d])) !== 0) {
      fail(`emitted WASM magic is invalid for ${asset}`);
    }
    const identity = await fileIdentity(matches[0]!);
    const expected = installed.wasm[asset];
    if (identity.bytes !== expected.bytes || identity.sha256 !== expected.sha256) {
      fail(`emitted WASM bytes do not exactly match installed ${asset}`);
    }
    exportedWasm[asset] = identity;
  }
  if (jsSources.some(([, source]) => source.includes("mathjax") || source.includes("@silurus/ooxml/math"))) {
    fail("aggregate or MathJax Silurus closure entered the Web export");
  }

  return {
    initialJavaScriptFiles: initialJsFiles.size,
    lazyChunks: Object.fromEntries(PROBE_MARKERS.map((marker) => [
      marker,
      path.basename(chunksFor(marker)[0]![0]),
    ])),
    pdfRendererCore: path.basename(chunksFor(PDF_RENDERER_MARKER)[0]![0]),
    pdfWorker: {
      emitted: { file: path.basename(workerPath), bytes: emittedPdfWorker.bytes },
      installed: installed.pdfWorker,
      version: PDF_VERSION,
      relationship: "unique WorkerMessageHandler worker with the expected byte count; literal /mobile worker URL resolves to this chunk",
    },
    wasm: Object.fromEntries(WASM_ASSETS.map((asset) => [asset, exportedWasm[asset]])),
  };
}

/** Web-only closure proof reused by the canonical production export. */
export async function verifySharedBrowserViewerWebExport(
  outputDirectory: string,
  appRoot = path.resolve(import.meta.dir, ".."),
) {
  return verifySharedBrowserViewerWebExportWithInstalled(
    outputDirectory,
    appRoot,
    await installedAssetIdentities(appRoot),
  );
}

async function verifyNativeExport(platform: "ios" | "android", outputDirectory: string, installed: Awaited<ReturnType<typeof installedAssetIdentities>>) {
  const files = await listFiles(outputDirectory);
  const prohibited = [
    ...PROBE_MARKERS,
    PDF_RENDERER_MARKER,
    "WorkerMessageHandler",
    "pdfjs-dist",
    "@silurus/ooxml",
    installed.pdfWorker.sha256,
    ...WASM_ASSETS.flatMap((asset) => [installed.wasm[asset].sha256, "\0asm"]),
  ];
  for (const file of files) {
    const bytes = await readFile(file);
    if (prohibited.some((marker) => containsAscii(bytes, marker))) {
      fail(`${platform} export contains a browser viewer closure marker`);
    }
  }
  return { files: files.length };
}

async function main(): Promise<void> {
  const appRoot = path.resolve(import.meta.dir, "..");
  const plan = await exportDirectories(process.argv.slice(2));
  try {
    const installed = await installedAssetIdentities(appRoot);
    await exportPlatform("web", plan.directories.web, appRoot);
    await exportPlatform("ios", plan.directories.ios, appRoot);
    await exportPlatform("android", plan.directories.android, appRoot);
    const web = await verifySharedBrowserViewerWebExportWithInstalled(plan.directories.web, appRoot, installed);
    const ios = await verifyNativeExport("ios", plan.directories.ios, installed);
    const android = await verifyNativeExport("android", plan.directories.android, installed);
    if (plan.temporaryRoot) {
      const normalizedRoot = path.resolve(plan.temporaryRoot);
      const temporaryParent = path.resolve(tmpdir());
      if (!normalizedRoot.startsWith(`${temporaryParent}${path.sep}`)
        || !path.basename(normalizedRoot).startsWith("nautilo-shared-browser-viewer-export-")) {
        fail("refusing to remove an unexpected temporary export root");
      }
      await rm(normalizedRoot, { recursive: true, force: false });
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "nautilo.shared-browser-viewer-export-closure.v1",
      mobileBasePath: MOBILE_BASE_PATH,
      web,
      native: { ios, android },
    })}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "shared browser viewer export probe failed";
    throw new Error(plan.temporaryRoot
      ? `${detail}; temporary exports preserved at ${plan.temporaryRoot}`
      : detail);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "shared browser viewer export probe failed"}\n`);
    process.exitCode = 1;
  });
}
