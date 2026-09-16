import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { NativeRuntimePlatform } from "./native-runtime-contract.ts";

type ExecutionMode = "native" | "emulated";

interface Arguments {
  readonly image: string;
  readonly platform: NativeRuntimePlatform;
  readonly output: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export function executionMode(engineArchitecture: string, platform: NativeRuntimePlatform): ExecutionMode {
  const normalized = engineArchitecture === "aarch64" ? "arm64" : engineArchitecture === "x86_64" ? "amd64" : engineArchitecture;
  return (normalized === "amd64" && platform === "linux/amd64") ||
    (normalized === "arm64" && platform === "linux/arm64") ? "native" : "emulated";
}

function parseArguments(values: readonly string[]): Arguments {
  const entries = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("usage: --image <ref> --platform <linux/amd64|linux/arm64> --output <path>");
    entries.set(key.slice(2), value);
  }
  const image = entries.get("image");
  const platform = entries.get("platform");
  const output = entries.get("output");
  if (!image || (platform !== "linux/amd64" && platform !== "linux/arm64") || !output) {
    throw new Error("usage: --image <ref> --platform <linux/amd64|linux/arm64> --output <path>");
  }
  return { image, platform, output: resolve(output) };
}

async function run(command: string, args: readonly string[]): Promise<CommandResult> {
  const subprocess = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function checked(command: string, args: readonly string[]): Promise<string> {
  const result = await run(command, args);
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  if (result.stdout.trim() === "") throw new Error(`${command} ${args.join(" ")} produced no output`);
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const status = await run("git", ["status", "--porcelain"]);
  if (status.exitCode !== 0) throw new Error(`git status failed (${status.exitCode}): ${status.stderr.trim()}`);
  if (status.stdout.trim() !== "") throw new Error("native probe evidence requires a clean Git worktree");
  const sourceSha = await checked("git", ["rev-parse", "HEAD"]);
  const dockerEngineArchitecture = await checked("docker", ["info", "--format", "{{.Architecture}}"]);
  const dockerfile = await readFile(resolve(import.meta.dir, "Dockerfile"));
  const inspect = JSON.parse(await checked("docker", ["image", "inspect", args.image])) as Array<Record<string, unknown>>;
  if (inspect.length !== 1) throw new Error(`expected one image inspection for ${args.image}`);
  const image = inspect[0]!;
  const expectedArchitecture = args.platform.split("/")[1];
  if (image["Os"] !== "linux" || image["Architecture"] !== expectedArchitecture) {
    throw new Error(`image reports ${String(image["Os"])}/${String(image["Architecture"])}; expected ${args.platform}`);
  }

  const probeDirectory = resolve(import.meta.dir);
  const rawProbe = await checked("docker", [
    "run", "--rm", "--platform", args.platform,
    "--entrypoint", "/usr/local/bin/bun",
    "-e", `D490_EXPECTED_PLATFORM=${args.platform}`,
    "-v", `${probeDirectory}:/tmp/d490-native-probe:ro`,
    args.image,
    "/tmp/d490-native-probe/native-runtime-probe.ts",
  ]);
  const probe = JSON.parse(rawProbe) as Record<string, unknown>;
  if (probe["platform"] !== args.platform) throw new Error("probe platform does not match requested platform");

  const evidence = {
    version: 1,
    sourceSha,
    dockerfileSha256: `sha256:${createHash("sha256").update(dockerfile).digest("hex")}`,
    capturedAt: new Date().toISOString(),
    host: { os: process.platform, architecture: process.arch, dockerEngineArchitecture },
    requestedPlatform: args.platform,
    executionMode: executionMode(dockerEngineArchitecture, args.platform),
    executionModeBasis: "requested platform compared with docker info .Architecture",
    image: {
      reference: args.image,
      id: image["Id"],
      repoDigests: image["RepoDigests"] ?? [],
      sizeBytes: image["Size"],
    },
    probe,
  };
  await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (import.meta.main) await main();
