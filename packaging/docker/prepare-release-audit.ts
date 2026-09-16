#!/usr/bin/env bun
/** Prepare one native architecture candidate's digest-bound D490 audit inputs. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseExactImageAuditToolManifest } from "./exact-image-audit-tools.ts";
import {
  assertRuntimeImageEvidenceManifest,
  type RuntimeImageArchitecture,
  type RuntimeImageBaseIdentity,
  type RuntimeImageEvidenceManifestV1,
} from "./runtime-image-evidence.ts";
import {
  assertVulnerabilityDatabaseIdentity,
  type VulnerabilityDatabaseIdentityV1,
} from "./vulnerability-db-identity.ts";
import {
  assertVulnerabilityPolicy,
  assertVulnerabilityPolicyExceptionSource,
  type VulnerabilityPolicyV1,
} from "./vulnerability-policy.ts";

interface Arguments {
  readonly image: string;
  readonly architecture: RuntimeImageArchitecture;
  readonly toolsDirectory: string;
  readonly grypeCacheDirectory: string;
  readonly trivyCacheDirectory: string;
  readonly exceptions: string;
  readonly outputDirectory: string;
  readonly repositoryPath: string;
  readonly operatorPath: string;
  readonly dockerfile: string;
  readonly baseImages?: string;
}

function parseArguments(values: readonly string[]): Arguments {
  const entries = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || entries.has(key)) throw new Error("invalid prepare-release-audit arguments");
    entries.set(key, value);
  }
  const architecture = entries.get("--architecture");
  const required = (name: string): string => {
    const value = entries.get(`--${name}`);
    if (!value) throw new Error(`missing --${name}`);
    return value;
  };
  if (architecture !== "linux/amd64" && architecture !== "linux/arm64") throw new Error("--architecture must be linux/amd64 or linux/arm64");
  const dockerfile = entries.get("--dockerfile");
  const baseImages = entries.get("--base-images");
  if ((dockerfile === undefined) !== (baseImages === undefined)) {
    throw new Error("--dockerfile and --base-images must be supplied together");
  }
  return {
    image: required("image"), architecture,
    toolsDirectory: resolve(required("tools-directory")),
    grypeCacheDirectory: resolve(required("grype-cache-directory")),
    trivyCacheDirectory: resolve(required("trivy-cache-directory")),
    exceptions: resolve(required("exceptions")),
    outputDirectory: resolve(required("output-directory")),
    repositoryPath: resolve(required("repository-path")),
    operatorPath: resolve(required("operator-path")),
    dockerfile: resolve(dockerfile ?? join(import.meta.dir, "Dockerfile")),
    ...(baseImages === undefined ? {} : { baseImages: resolve(baseImages) }),
  };
}

async function checked(command: string, args: readonly string[], environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn([command, ...args], { env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
  return stdout.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function grypeBuiltAt(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  const match = /_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)_/.exec(source);
  return match?.[1];
}

export function databaseIdentityFromCaches(grypeCacheDirectory: string, trivyCacheDirectory: string): VulnerabilityDatabaseIdentityV1 {
  const grypeImportPath = join(grypeCacheDirectory, "6", "import.json");
  const grypeDatabasePath = join(grypeCacheDirectory, "6", "vulnerability.db");
  const trivyMetadataPath = join(trivyCacheDirectory, "db", "metadata.json");
  const trivyDatabasePath = join(trivyCacheDirectory, "db", "trivy.db");
  const grype = JSON.parse(readFileSync(grypeImportPath, "utf8")) as Record<string, unknown>;
  const trivy = JSON.parse(readFileSync(trivyMetadataPath, "utf8")) as Record<string, unknown>;
  if (typeof grype.client_version !== "string" || !/^v\d+\.\d+\.\d+$/.test(grype.client_version)) {
    throw new Error("Grype database metadata has no exact client_version");
  }
  if (!Number.isSafeInteger(trivy.Version)) throw new Error("Trivy database metadata has no exact Version");
  const builtAt = grypeBuiltAt(grype.source);
  const identity: VulnerabilityDatabaseIdentityV1 = {
    version: 1,
    databases: {
      grype: {
        provider: "Anchore Grype vulnerability database",
        schemaVersion: grype.client_version,
        ...(builtAt === undefined ? {} : { builtAt }),
        path: grypeDatabasePath,
        sha256: sha256(grypeDatabasePath),
      },
      trivy: {
        provider: "Aqua Security Trivy vulnerability database",
        schemaVersion: String(trivy.Version),
        updatedAt: canonicalTimestamp(trivy.UpdatedAt, "Trivy UpdatedAt"),
        path: trivyDatabasePath,
        sha256: sha256(trivyDatabasePath),
      },
    },
  };
  assertVulnerabilityDatabaseIdentity(identity);
  return identity;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  mkdirSync(args.outputDirectory, { recursive: true });
  mkdirSync(args.grypeCacheDirectory, { recursive: true });
  mkdirSync(args.trivyCacheDirectory, { recursive: true });
  const grype = join(args.toolsDirectory, "grype");
  const trivy = join(args.toolsDirectory, "trivy");
  await checked(grype, ["db", "update"], { GRYPE_DB_CACHE_DIR: args.grypeCacheDirectory });
  await checked(trivy, ["image", "--download-db-only", "--cache-dir", args.trivyCacheDirectory]);

  const databaseIdentity = databaseIdentityFromCaches(args.grypeCacheDirectory, args.trivyCacheDirectory);
  const inspected = JSON.parse(await checked("docker", ["image", "inspect", args.image])) as Array<Record<string, unknown>>;
  if (inspected.length !== 1) throw new Error("candidate image inspection must contain exactly one image");
  const image = inspected[0]!;
  const expectedArch = args.architecture.split("/")[1];
  if (image.Os !== "linux" || image.Architecture !== expectedArch || !Number.isSafeInteger(image.Size)) {
    throw new Error(`candidate inspection does not match ${args.architecture}`);
  }
  const separator = args.image.lastIndexOf("@sha256:");
  if (separator < 1) throw new Error("--image must be an immutable repository digest reference");
  const digest = args.image.slice(separator + 1);
  const tools = parseExactImageAuditToolManifest(readFileSync(join(import.meta.dir, "exact-image-audit-tools.manifest.json"), "utf8"));
  const sourceSha = await checked("git", ["rev-parse", "HEAD"]);
  const capturedAt = new Date().toISOString();
  const baseImages = args.baseImages === undefined
    ? [{
        role: "bun-build-and-runtime",
        identity: "docker.io/oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
      }]
    : JSON.parse(readFileSync(args.baseImages, "utf8")) as RuntimeImageBaseIdentity[];
  const manifest: RuntimeImageEvidenceManifestV1 = {
    version: 1,
    sourceSha,
    dockerfileSha256: `sha256:${sha256(args.dockerfile)}`,
    baseImages,
    architecture: args.architecture,
    image: { digest, reference: args.image, sizeBytes: image.Size as number },
    tools: { syft: tools.tools.syft.version, grype: tools.tools.grype.version, trivy: tools.tools.trivy.version, bun: Bun.version },
    databases: (["grype", "trivy"] as const).map((name) => ({
      name,
      identity: `sha256:${databaseIdentity.databases[name].sha256}`,
      version: databaseIdentity.databases[name].schemaVersion,
    })),
    capturedAt,
  };
  assertRuntimeImageEvidenceManifest(manifest);

  const exceptionSource = JSON.parse(readFileSync(args.exceptions, "utf8")) as unknown;
  assertVulnerabilityPolicyExceptionSource(exceptionSource);
  const vulnerabilityPolicy: VulnerabilityPolicyV1 = {
    version: 1,
    binding: {
      image: { digest, reference: args.image }, architecture: args.architecture,
      databases: {
        grype: databaseIdentity.databases.grype.sha256,
        trivy: databaseIdentity.databases.trivy.sha256,
      },
    },
    exceptions: exceptionSource.exceptions,
  };
  assertVulnerabilityPolicy(vulnerabilityPolicy);
  const disclosurePolicy = {
    version: 1,
    repositoryPaths: [args.repositoryPath], operatorPaths: [args.operatorPath],
    privateHostnames: [], privateEmails: [], privateUsernames: [], customerMarkers: [],
  };

  writeJson(join(args.outputDirectory, "database-identity.json"), databaseIdentity);
  writeJson(join(args.outputDirectory, "manifest.json"), manifest);
  writeJson(join(args.outputDirectory, "vulnerability-policy.json"), vulnerabilityPolicy);
  writeJson(join(args.outputDirectory, "disclosure-policy.json"), disclosurePolicy);
  process.stdout.write(`[d490:prepare-release-audit] image=${args.image} architecture=${args.architecture}\n`);
}

if (import.meta.main) await main();
