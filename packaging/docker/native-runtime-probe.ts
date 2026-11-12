import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNativeRuntimeInventory, runtimeArchForPlatform, type NativeRuntimePlatform, expectedElfMachine } from "./native-runtime-contract.ts";

import chromiumArtifacts from "./chromium-artifacts.json";

export const BROWSER_EXECUTABLE = "/opt/nautilo/chromium/chrome-headless-shell";
const REQUIRED_BROWSER_LINKAGE_FILES = [
  BROWSER_EXECUTABLE,
  "/opt/nautilo/chromium/libEGL.so",
  "/opt/nautilo/chromium/libGLESv2.so",
  "/opt/nautilo/chromium/libvk_swiftshader.so",
  "/opt/nautilo/chromium/libvulkan.so.1",
] as const;

/** Validate both native execution evidence and the reviewed architecture-specific source pin. */
export function assertBrowserQualification(value: unknown, platform: NativeRuntimePlatform): void {
  const browser = value as Record<string, unknown> | null;
  const pin = chromiumArtifacts.targets[platform];
  if (!browser || browser.vendor !== "google-chrome-for-testing" ||
      browser.version !== chromiumArtifacts.version || browser.platform !== platform ||
      browser.archiveSha256 !== pin.sha256 || browser.executableSha256 !== pin.executableSha256 ||
      browser.realExecutable !== BROWSER_EXECUTABLE) {
    throw new Error("Browser qualification does not match the source-pinned artifact");
  }
  const elf = browser.elf as Record<string, unknown> | undefined;
  if (!elf || elf.class !== 64 || elf.endianness !== "little" || elf.machine !== expectedElfMachine(platform)) {
    throw new Error("Browser qualification has the wrong ELF architecture");
  }
  const linkage = browser.linkage as Record<string, unknown> | undefined;
  const checkedFiles = linkage?.checkedFiles;
  if (!linkage || linkage.passed !== true || !Array.isArray(linkage.missing) || linkage.missing.length !== 0 ||
      !Array.isArray(checkedFiles) || !REQUIRED_BROWSER_LINKAGE_FILES.every((path) => checkedFiles.includes(path)) ||
      new Set(checkedFiles).size !== checkedFiles.length ||
      !checkedFiles.every((path) => typeof path === "string" && path.startsWith("/opt/nautilo/chromium/") && !path.split("/").includes(".."))) {
    throw new Error("Browser qualification has incomplete or failed linkage evidence");
  }
}

export function assertBrowserElf(header: Buffer, platform: NativeRuntimePlatform): void {
  if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== expectedElfMachine(platform)) {
    throw new Error("Browser executable must be an ELF64 little-endian binary for the requested platform");
  }
}

export function assertBrowserLinkage(exitCode: number, stdout: string, stderr: string): void {
  if (exitCode !== 0 || /\bnot found\b/i.test(`${stdout}\n${stderr}`) || stdout.trim() === "") {
    throw new Error("Browser shared-library linkage failed");
  }
}

async function browserCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function browserLibraries(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await browserLibraries(path));
    else if (/\.so(?:\.|$)/.test(entry.name)) result.push(path);
  }
  return result;
}

export async function probeBrowser(platform: NativeRuntimePlatform): Promise<Record<string, unknown>> {
  const realExecutable = await realpath("/usr/bin/chromium");
  if (realExecutable !== BROWSER_EXECUTABLE) throw new Error("Canonical Chromium path does not resolve to the pinned vendor executable");
  const bytes = await readFile(realExecutable);
  const executableSha256 = createHash("sha256").update(bytes).digest("hex");
  const pin = chromiumArtifacts.targets[platform];
  const receipt = JSON.parse(await readFile("/opt/nautilo/chromium/artifact-manifest.json", "utf8"));
  if (receipt.schemaVersion !== 1 || receipt.version !== chromiumArtifacts.version || receipt.platform !== platform ||
      receipt.url !== pin.url || receipt.archiveSha256 !== pin.sha256 ||
      receipt.executableSha256 !== executableSha256 || executableSha256 !== pin.executableSha256) {
    throw new Error("Installed browser receipt or executable differs from the source pin");
  }
  assertBrowserElf(bytes, platform);
  const version = await browserCommand([realExecutable, "--version"]);
  const actualVersion = version.stdout.trim().match(/^(?:Google Chrome for Testing|Google Chrome|Chromium|HeadlessChrome) (\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (version.exitCode !== 0 || actualVersion !== chromiumArtifacts.version) throw new Error("Installed browser reports an unexpected version");
  const checkedFiles = [...new Set([realExecutable, ...await browserLibraries("/opt/nautilo/chromium")])].sort();
  for (const file of checkedFiles) {
    assertBrowserElf(await readFile(file), platform);
    const linkage = await browserCommand(["ldd", file]);
    assertBrowserLinkage(linkage.exitCode, linkage.stdout, linkage.stderr);
  }
  const result = {
    vendor: "google-chrome-for-testing", version: actualVersion, platform,
    archiveSha256: receipt.archiveSha256, executableSha256, realExecutable,
    elf: { class: 64, endianness: "little", machine: expectedElfMachine(platform) },
    linkage: { passed: true, checkedFiles, missing: [] },
  };
  assertBrowserQualification(result, platform);
  return result;
}

interface SharpPipeline {
  resize(width: number, height: number): SharpPipeline;
  png(): SharpPipeline;
  toBuffer(options?: unknown): Promise<Buffer | { data: Buffer; info: Record<string, unknown> }>;
}

interface SharpFactory {
  (input?: unknown, options?: unknown): SharpPipeline;
  readonly versions?: Record<string, string>;
}

interface SharpModule {
  readonly default: SharpFactory;
}

interface Argon2Module {
  readonly argon2id: number;
  hash(value: string, options: Record<string, unknown>): Promise<string>;
  verify(hash: string, value: string): Promise<boolean>;
}

interface TypeScriptModule {
  readonly version: string;
}

function platformFromEnvironment(): NativeRuntimePlatform {
  const value = process.env.NAUTILO_EXPECTED_PLATFORM;
  if (value !== "linux/amd64" && value !== "linux/arm64") throw new Error("NAUTILO_EXPECTED_PLATFORM must be linux/amd64 or linux/arm64");
  return value;
}

export function officeCliProbeEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    // Match the production runner. OfficeCLI's automatic resident can outlive
    // one screenshot command and race the next single-file .NET invocation,
    // producing intermittent lazy assembly-load failures on arm64.
    OFFICECLI_SKIP_UPDATE: "1",
    OFFICECLI_NO_AUTO_RESIDENT: "1",
  };
}

async function probeOfficeCliScreenshots(platform: NativeRuntimePlatform): Promise<Record<string, unknown>> {
  const architecture = platform === "linux/amd64" ? "linux-x64" : "linux-arm64";
  const officeCli = `/srv/repo/packages/server/vendor/officecli/${architecture}/officecli`;
  const scratch = await mkdtemp(join(tmpdir(), "nautilo-officecli-render-"));
  const screenshots: Array<Record<string, unknown>> = [];

  for (const format of ["docx", "xlsx", "pptx"] as const) {
    const input = `/srv/repo/packages/server/assets/office-templates/blank.${format}`;
    const output = join(scratch, `blank-${format}.png`);
    const child = Bun.spawn([officeCli, "view", input, "screenshot", "--page", "1", "--out", output, "--json"], {
      env: officeCliProbeEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`OfficeCLI ${format} screenshot failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
    }
    const bytes = await readFile(output);
    if (bytes.length < 100 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`OfficeCLI ${format} screenshot did not produce a valid PNG`);
    }
    screenshots.push({ format, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }

  return { browserExecutable: "/usr/bin/chromium", screenshots };
}

async function probeAgentBrowser(platform: NativeRuntimePlatform): Promise<Record<string, unknown>> {
  const architecture = platform === "linux/amd64" ? "linux-x64" : "linux-arm64";
  const binary = `/srv/repo/packages/server/vendor/agent-browser/${architecture}/agent-browser`;
  const child = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 || !/\b0\.35\.2\b/.test(stdout)) {
    throw new Error(`agent-browser version probe failed (${exitCode}): ${stderr.trim()}`);
  }
  return { version: "0.35.2" };
}

async function main(): Promise<void> {
  const platform = platformFromEnvironment();
  if (process.platform !== "linux" || process.arch !== runtimeArchForPlatform(platform)) {
    throw new Error(`runtime reported ${process.platform}/${process.arch}; expected ${platform}`);
  }
  const inventory = await collectNativeRuntimeInventory(platform);
  const browser = await probeBrowser(platform);

  await import(
    "/srv/repo/packages/encryption-invariants/src/node/database-writer-inventory.ts"
  );
  const typescript = await import(
    "/srv/repo/node_modules/typescript/lib/typescript.js"
  ) as TypeScriptModule;
  if (typescript.version !== "5.9.3") {
    throw new Error(
      `encryption inventory TypeScript runtime reported ${typescript.version}; expected 5.9.3`,
    );
  }

  const sharpModule = await import("/srv/repo/node_modules/sharp/dist/index.mjs") as SharpModule;
  const sharp = sharpModule.default;
  const pipeline = sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 19, g: 87, b: 143, alpha: 1 } },
  }).resize(2, 1).png();
  const transformed = await pipeline.toBuffer({ resolveWithObject: true }) as { data: Buffer; info: Record<string, unknown> };
  if (transformed.info.width !== 2 || transformed.info.height !== 1 || transformed.info.format !== "png") {
    throw new Error(`Sharp transform returned unexpected output: ${JSON.stringify(transformed.info)}`);
  }

  const argon2Namespace = await import("/srv/repo/node_modules/argon2/argon2.cjs") as { default?: Argon2Module } & Partial<Argon2Module>;
  const argon2 = argon2Namespace.default ?? argon2Namespace as Argon2Module;
  const phrase = "nautilo-native-runtime-probe";
  const hash = await argon2.hash(phrase, {
    type: argon2.argon2id,
    memoryCost: 4096,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });
  const verified = await argon2.verify(hash, phrase);
  const rejectedWrongValue = !(await argon2.verify(hash, `${phrase}-wrong`));
  if (!verified || !rejectedWrongValue) throw new Error("argon2 hash/verify contract failed");
  const officecli = await probeOfficeCliScreenshots(platform);
  const agentBrowser = await probeAgentBrowser(platform);

  process.stdout.write(`${JSON.stringify({
    version: 1,
    platform,
    observedRuntime: { os: process.platform, architecture: process.arch },
    inventory,
    encryptionInventory: { typescriptVersion: typescript.version },
    sharp: {
      version: sharp.versions?.sharp,
      libvipsVersion: sharp.versions?.vips,
      output: transformed.info,
      sha256: createHash("sha256").update(transformed.data).digest("hex"),
    },
    argon2: { algorithm: "argon2id", verified, rejectedWrongValue },
    officecli,
    browser,
    agentBrowser,
  })}\n`);
}

if (import.meta.main) await main();
