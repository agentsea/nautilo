import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNativeRuntimeInventory, runtimeArchForPlatform, type NativeRuntimePlatform } from "./native-runtime-contract.ts";

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
  const value = process.env.D490_EXPECTED_PLATFORM;
  if (value !== "linux/amd64" && value !== "linux/arm64") throw new Error("D490_EXPECTED_PLATFORM must be linux/amd64 or linux/arm64");
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
  const scratch = await mkdtemp(join(tmpdir(), "d490-officecli-render-"));
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
  const phrase = "d490-native-runtime-probe";
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
    agentBrowser,
  })}\n`);
}

if (import.meta.main) await main();
