#!/usr/bin/env bun
/** Native, secret-free acceptance probe for the one-shot D488 bootstrap image. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executionMode } from "./native-runtime-probe-cli.ts";
import type { NativeRuntimePlatform } from "./native-runtime-contract.ts";

interface Arguments {
  readonly image: string;
  readonly platform: NativeRuntimePlatform;
  readonly output: string;
}

export interface BootstrapProbeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut?: boolean;
}

function fail(message: string): never {
  throw new Error(`D488 bootstrap native probe failed: ${message}`);
}

function parseArguments(values: readonly string[]): Arguments {
  const entries = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || entries.has(key)) fail("arguments must be unique option/value pairs");
    entries.set(key, value);
  }
  const image = entries.get("--image");
  const platform = entries.get("--platform");
  const output = entries.get("--output");
  if (!image || (platform !== "linux/amd64" && platform !== "linux/arm64") || !output || entries.size !== 3) {
    fail("usage: --image <digest-ref> --platform <linux/amd64|linux/arm64> --output <json>");
  }
  return { image, platform, output: resolve(output) };
}

async function run(command: string, args: readonly string[], timeoutMilliseconds = 20_000): Promise<BootstrapProbeCommandResult> {
  const subprocess = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, timeoutMilliseconds);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    return { stdout, stderr, exitCode, ...(timedOut ? { timedOut: true } : {}) };
  } finally {
    clearTimeout(timeout);
  }
}

async function checked(command: string, args: readonly string[]): Promise<string> {
  const result = await run(command, args);
  if (result.exitCode !== 0 || result.timedOut) fail(`${command} failed with exit code ${result.exitCode}`);
  if (result.stdout.trim() === "") fail(`${command} produced no output`);
  return result.stdout.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function jsonOutput(result: BootstrapProbeCommandResult, stream: "stdout" | "stderr", label: string): Record<string, unknown> {
  if (result.timedOut || result.exitCode !== 1) fail(`${label} must fail promptly with exit code 1`);
  const selected = result[stream].trim();
  const other = result[stream === "stdout" ? "stderr" : "stdout"].trim();
  if (selected === "" || other !== "") fail(`${label} must emit exactly one JSON stream`);
  try {
    return record(JSON.parse(selected) as unknown, label);
  } catch {
    fail(`${label} did not emit valid JSON`);
  }
}

export function evaluateBootstrapFailureProbes(input: {
  readonly missingEnvironment: BootstrapProbeCommandResult;
  readonly invalidMode: BootstrapProbeCommandResult;
  readonly missingDatabase: BootstrapProbeCommandResult;
}): Readonly<Record<string, unknown>> {
  const missingEnvironment = jsonOutput(input.missingEnvironment, "stdout", "missing-environment probe");
  const missingFailure = record(missingEnvironment["failure"], "missing-environment failure");
  if (missingEnvironment["status"] !== "failed" || !Array.isArray(missingEnvironment["clusters"]) ||
    missingEnvironment["clusters"].length !== 0 || missingFailure["kind"] !== "invalid-environment" ||
    missingFailure["code"] !== "missing-app-postgres-admin-url") {
    fail("missing-environment probe did not fail closed before database access");
  }

  const invalidMode = jsonOutput(input.invalidMode, "stderr", "invalid-mode probe");
  if (JSON.stringify(invalidMode) !== JSON.stringify({ status: "failed", code: "invalid-bootstrap-mode" })) {
    fail("invalid-mode probe did not reject the mode exactly");
  }

  const missingDatabase = jsonOutput(input.missingDatabase, "stdout", "missing-database probe");
  const databaseFailure = record(missingDatabase["failure"], "missing-database failure");
  if (missingDatabase["status"] !== "failed" || databaseFailure["kind"] !== "reconciliation-failed" ||
    databaseFailure["cluster"] !== "app" || !Array.isArray(missingDatabase["clusters"]) ||
    missingDatabase["clusters"].length !== 1) {
    fail("missing-database probe did not return a bounded app-cluster failure");
  }
  const cluster = record(missingDatabase["clusters"][0], "missing-database cluster");
  const clusterFailure = record(cluster["failure"], "missing-database cluster failure");
  if (cluster["status"] !== "failed" || !Array.isArray(cluster["checkpoints"]) || cluster["checkpoints"].length !== 0 ||
    clusterFailure["kind"] !== "adapter-failure" || clusterFailure["cluster"] !== "app" ||
    clusterFailure["retryable"] !== true) {
    fail("missing-database probe did not preserve retryable idempotent failure semantics");
  }

  return {
    missingEnvironment,
    invalidMode,
    missingDatabase,
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const status = await run("git", ["status", "--porcelain"]);
  if (status.exitCode !== 0 || status.stdout.trim() !== "") fail("native evidence requires a clean Git worktree");
  const sourceSha = await checked("git", ["rev-parse", "HEAD"]);
  const dockerEngineArchitecture = await checked("docker", ["info", "--format", "{{.Architecture}}"]);
  const dockerfile = await readFile(resolve(import.meta.dir, "Dockerfile.bootstrap"));
  const inspectList = JSON.parse(await checked("docker", ["image", "inspect", args.image])) as Array<Record<string, unknown>>;
  if (inspectList.length !== 1) fail("image inspection must contain exactly one image");
  const image = inspectList[0]!;
  const expectedArchitecture = args.platform.split("/")[1];
  if (image["Os"] !== "linux" || image["Architecture"] !== expectedArchitecture) fail("image architecture does not match the native runner");
  const config = record(image["Config"], "image config");
  const labels = record(config["Labels"], "image labels");
  const environment = Array.isArray(config["Env"]) ? config["Env"] : [];
  if (config["User"] !== "nonroot:nonroot" || JSON.stringify(config["Entrypoint"]) !== JSON.stringify(["/usr/local/bin/nautilo-hosted-bootstrap"]) ||
    labels["org.opencontainers.image.revision"] !== sourceSha ||
    environment.some((entry) => typeof entry !== "string" || /(?:PASSWORD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)=/i.test(entry))) {
    fail("image configuration is not the approved nonroot, secret-free bootstrap contract");
  }
  const repoDigests = Array.isArray(image["RepoDigests"]) ? image["RepoDigests"] : [];
  if (!repoDigests.includes(args.image)) fail("image inspection is not bound to the requested digest reference");

  const containerBase = ["run", "--rm", "--network", "none", "--read-only", "--platform", args.platform];
  const missingEnvironment = await run("docker", [...containerBase, args.image]);
  const invalidMode = await run("docker", [...containerBase, "-e", "NAUTILO_BOOTSTRAP_MODE=invalid", args.image]);
  const inertEnvironment = [
    "APP_POSTGRES_ADMIN_URL=postgres://bootstrap:dummy-password@127.0.0.1:1/postgres",
    "LOGTO_POSTGRES_ADMIN_URL=postgres://bootstrap:dummy-password@127.0.0.1:1/postgres",
    "APP_NAUTILO_DB_PASSWORD=dummy-password",
    "APP_NAUTILO_AGENT_DB_PASSWORD=dummy-password",
    "APP_NAUTILO_CRYPTO_DB_PASSWORD=dummy-password",
    "LOGTO_DB_PASSWORD=dummy-password",
  ];
  const missingDatabase = await run("docker", [
    ...containerBase,
    ...inertEnvironment.flatMap((entry) => ["-e", entry]),
    args.image,
  ]);
  const probes = evaluateBootstrapFailureProbes({ missingEnvironment, invalidMode, missingDatabase });

  const evidence = {
    version: 1,
    sourceSha,
    dockerfileSha256: `sha256:${createHash("sha256").update(dockerfile).digest("hex")}`,
    capturedAt: new Date().toISOString(),
    host: { os: process.platform, architecture: process.arch, dockerEngineArchitecture },
    requestedPlatform: args.platform,
    executionMode: executionMode(dockerEngineArchitecture, args.platform),
    image: {
      reference: args.image,
      id: image["Id"],
      repoDigests,
      sizeBytes: image["Size"],
    },
    probe: {
      user: config["User"],
      entrypoint: config["Entrypoint"],
      network: "none",
      rootFilesystem: "read-only",
      ...probes,
    },
  };
  await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  process.stdout.write(`[d488:bootstrap-native-probe] PASS ${args.platform} ${args.image}\n`);
}

if (import.meta.main) await main();
