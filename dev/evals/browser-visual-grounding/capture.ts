import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentBrowserArgv,
  agentBrowserSnapshotJsonArgv,
  agentBrowserViewportEvalArgv,
  parseAgentBrowserSnapshot,
} from "../../../packages/relay/src/browser.ts";
import { browserControlStateSessionId } from "../../../apps/desktop/electron/browser-control-state.ts";
import {
  BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION,
  isCaseId,
  parseCorpusIndex,
  type BrowserVisualGroundingCase,
} from "./schema.ts";

const usage = `Usage: bun dev/evals/browser-visual-grounding/capture.ts \\
  --id <lowercase-slug> --description <text> --profile <desktop-profile-dir> [--binary <agent-browser>]`;

interface CaptureOptions {
  readonly id: string;
  readonly description: string;
  readonly profileDir: string;
  readonly binaryPath?: string | undefined;
}

interface ViewportEvaluation {
  readonly w: number;
  readonly h: number;
  readonly dpr: number;
}

export function parseCaptureArgs(argv: readonly string[]): CaptureOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(usage);
    if (!["--id", "--description", "--profile", "--binary"].includes(key) || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  const id = values.get("--id") ?? "";
  const description = values.get("--description")?.trim() ?? "";
  const profileDir = values.get("--profile") ?? "";
  if (!isCaseId(id) || !description || !path.isAbsolute(profileDir)) throw new Error(usage);
  const binaryPath = values.get("--binary");
  if (binaryPath !== undefined && !path.isAbsolute(binaryPath)) throw new Error(usage);
  return { id, description, profileDir, ...(binaryPath === undefined ? {} : { binaryPath }) };
}

function defaultAgentBrowserBinary(repoRoot: string): string {
  if (process.platform !== "darwin") throw new Error("Pass --binary outside macOS");
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (architecture === null) throw new Error(`Unsupported macOS architecture: ${process.arch}`);
  return path.join(repoRoot, "apps", "desktop", "vendor", "agent-browser", architecture, "agent-browser");
}

async function run(binary: string, argv: readonly string[]): Promise<string> {
  const processHandle = Bun.spawn([binary, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `agent-browser exited ${exitCode}`);
  return stdout.trim();
}

export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error("Screenshot is not a PNG");
  }
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") throw new Error("Screenshot has no PNG IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) throw new Error("Screenshot has invalid dimensions");
  return { width, height };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function parseViewport(stdout: string): ViewportEvaluation {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid viewport result");
  const candidate = value as Record<string, unknown>;
  const w = candidate["w"];
  const h = candidate["h"];
  const dpr = candidate["dpr"];
  if (typeof w !== "number" || w <= 0 || typeof h !== "number" || h <= 0
    || typeof dpr !== "number" || dpr <= 0) throw new Error("Invalid viewport result");
  return { w, h, dpr };
}

async function capture(options: CaptureOptions): Promise<string> {
  const suiteRoot = import.meta.dir;
  const repoRoot = path.resolve(suiteRoot, "../../..");
  const casesRoot = path.join(suiteRoot, "cases");
  const destination = path.join(casesRoot, options.id);
  if (existsSync(destination)) throw new Error(`Case already exists: ${options.id}`);

  const statePath = path.join(options.profileDir, "browser-control-state.json");
  const configPath = path.join(options.profileDir, "agent-browser-provider.json");
  const binary = options.binaryPath ?? defaultAgentBrowserBinary(repoRoot);
  for (const requiredPath of [statePath, configPath, binary]) {
    if (!existsSync(requiredPath)) throw new Error(`Required capture input does not exist: ${requiredPath}`);
  }

  const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
  const session = browserControlStateSessionId(state);
  if (session === null) throw new Error("Desktop profile has no active embedded Browser view");

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "nautilo-browser-visual-grounding-"));
  const temporaryScreenshot = path.join(temporaryRoot, "screenshot.png");
  const startedAt = performance.now();
  try {
    const version = await run(binary, ["--version"]);
    const before = parseViewport(await run(binary, agentBrowserViewportEvalArgv(configPath, session)));
    const snapshotStartedAt = performance.now();
    const parsedSnapshot = parseAgentBrowserSnapshot(
      await run(binary, agentBrowserSnapshotJsonArgv(configPath, session)),
    );
    await run(binary, agentBrowserArgv("browser_screenshot", { _capturePath: temporaryScreenshot }, configPath, session));
    const screenshotFinishedAt = performance.now();
    const after = parseViewport(await run(binary, agentBrowserViewportEvalArgv(configPath, session)));
    const confirmSnapshot = parseAgentBrowserSnapshot(
      await run(binary, agentBrowserSnapshotJsonArgv(configPath, session)),
    );
    if (parsedSnapshot.pageUrl !== confirmSnapshot.pageUrl
      || parsedSnapshot.snapshot !== confirmSnapshot.snapshot
      || JSON.stringify(parsedSnapshot.refs) !== JSON.stringify(confirmSnapshot.refs)) {
      throw new Error("Browser state changed during capture; leave the page still and capture a new case");
    }
    if (before.w !== after.w || before.h !== after.h || before.dpr !== after.dpr) {
      throw new Error("Browser viewport changed during capture; capture a new case");
    }

    const snapshotBytes = new TextEncoder().encode(`${parsedSnapshot.snapshot}\n`);
    const screenshotBytes = new Uint8Array(await readFile(temporaryScreenshot));
    const image = parsePngDimensions(screenshotBytes);
    const manifest: BrowserVisualGroundingCase = {
      schemaVersion: BROWSER_VISUAL_GROUNDING_SCHEMA_VERSION,
      id: options.id,
      description: options.description,
      sourceUrl: parsedSnapshot.pageUrl,
      capturedAt: new Date().toISOString(),
      captureDurationMs: Math.round(performance.now() - startedAt),
      evidencePairWindowMs: Math.round(screenshotFinishedAt - snapshotStartedAt),
      agentBrowserVersion: version,
      viewport: {
        css: { width: after.w, height: after.h },
        image,
        dpr: after.dpr,
        imageToCssScale: image.width / after.w,
      },
      refs: parsedSnapshot.refs,
      snapshot: { file: "snapshot.txt", bytes: snapshotBytes.byteLength, sha256: sha256(snapshotBytes) },
      screenshot: { file: "screenshot.png", bytes: screenshotBytes.byteLength, sha256: sha256(screenshotBytes) },
    };

    return await publishCaptureCase({ casesRoot, manifest, snapshotBytes, screenshotPath: temporaryScreenshot });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function publishCaptureCase(options: {
  readonly casesRoot: string;
  readonly manifest: BrowserVisualGroundingCase;
  readonly snapshotBytes: Uint8Array;
  readonly screenshotPath: string;
}): Promise<string> {
  const { casesRoot, manifest, snapshotBytes, screenshotPath } = options;
  if (!isCaseId(manifest.id)) throw new Error(`Invalid case id: ${manifest.id}`);
  const destination = path.join(casesRoot, manifest.id);
  const staging = path.join(casesRoot, `.capture-${manifest.id}-${randomUUID()}`);
  const indexTemporary = path.join(casesRoot, `.manifest-${randomUUID()}.json`);
  let createdDestination = false;
  let published = false;
  try {
    await mkdir(casesRoot, { recursive: true });
    await mkdir(staging);
    await writeFile(path.join(staging, "snapshot.txt"), snapshotBytes);
    await copyFile(screenshotPath, path.join(staging, "screenshot.png"));
    await writeFile(path.join(staging, "case.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // Reserve the case ID exclusively: rename() could replace an existing empty directory.
    await mkdir(destination);
    createdDestination = true;
    for (const file of ["snapshot.txt", "screenshot.png", "case.json"]) {
      await rename(path.join(staging, file), path.join(destination, file));
    }
    await rm(staging, { recursive: true, force: true });

    const indexPath = path.join(casesRoot, "manifest.json");
    const current = parseCorpusIndex(JSON.parse(await readFile(indexPath, "utf8")));
    if (current.cases.some(({ id }) => id === manifest.id)) throw new Error(`Case already exists: ${manifest.id}`);
    const next = { ...current, cases: [...current.cases, { id: manifest.id }].sort((a, b) => a.id.localeCompare(b.id)) };
    await writeFile(indexTemporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(indexTemporary, indexPath);
    published = true;
    return destination;
  } finally {
    if (!published && createdDestination) await rm(destination, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    await rm(indexTemporary, { force: true });
  }
}

if (import.meta.main) {
  try {
    const destination = await capture(parseCaptureArgs(process.argv.slice(2)));
    console.log(`Captured paired browser evidence at ${destination}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
