/** D490 Task 0.3.2 — exact-image audit orchestration and report binding. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertRuntimeImageEvidenceManifest,
  writeRuntimeImageEvidence,
  type RuntimeImageEvidenceManifestV1,
} from "./runtime-image-evidence.ts";
import {
  assertExactImageAuditToolManifest,
  type ExactImageAuditToolManifestV1,
  type ExactImageAuditToolName,
} from "./exact-image-audit-tools.ts";
import {
  verifyVulnerabilityDatabaseIdentity,
  type VulnerabilityDatabaseIdentityV1,
} from "./vulnerability-db-identity.ts";
import {
  collectDisclosureArchive,
  evaluateBoundedDisclosure,
  type BoundedDisclosurePolicyV1,
  type DisclosureArchiveObservation,
} from "./bounded-disclosure.ts";
import {
  evaluateVulnerabilityPolicy,
  renderVulnerabilityPolicyReportSummary,
  type VulnerabilityPolicyV1,
} from "./vulnerability-policy.ts";

const execFileAsync = promisify(execFile);
const REPORT_TYPES = ["sbom", "vulnerabilities", "image-analysis", "vulnerability-policy", "image-inspect", "image-history", "bounded-disclosure"] as const;
export type ExactImageAuditReportType = typeof REPORT_TYPES[number];

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExactImageAuditDependencies {
  readonly run?: (command: string, args: readonly string[], environment?: Readonly<Record<string, string>>) => Promise<CommandResult>;
  readonly readFile?: (path: string) => Buffer;
  readonly writeFile?: (path: string, contents: string) => Promise<void>;
  readonly collectDisclosure?: (imageReference: string) => Promise<DisclosureArchiveObservation>;
}

export interface RunExactImageAuditInput {
  readonly manifest: RuntimeImageEvidenceManifestV1;
  readonly toolManifest: ExactImageAuditToolManifestV1;
  readonly databaseIdentity: VulnerabilityDatabaseIdentityV1;
  readonly disclosurePolicy: BoundedDisclosurePolicyV1;
  readonly vulnerabilityPolicy: VulnerabilityPolicyV1;
  readonly toolsDirectory: string;
  readonly grypeCacheDirectory: string;
  readonly trivyCacheDirectory: string;
  readonly outputRoot: string;
  readonly dependencies?: ExactImageAuditDependencies;
}

export interface ExactImageAuditReportEntryV1 {
  readonly type: ExactImageAuditReportType;
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sourceSha: string;
  readonly architecture: RuntimeImageEvidenceManifestV1["architecture"];
  readonly image: RuntimeImageEvidenceManifestV1["image"];
}

export interface ExactImageAuditReportIndexV1 {
  readonly version: 1;
  readonly sourceSha: string;
  readonly architecture: RuntimeImageEvidenceManifestV1["architecture"];
  readonly image: RuntimeImageEvidenceManifestV1["image"];
  readonly tools: Readonly<Record<ExactImageAuditToolName, string>>;
  readonly databases: VulnerabilityDatabaseIdentityV1["databases"];
  readonly reports: readonly ExactImageAuditReportEntryV1[];
  readonly capturedAt: string;
}

export interface RunExactImageAuditResult {
  readonly directory: string;
  readonly indexPath: string;
  readonly index: ExactImageAuditReportIndexV1;
}

export class ExactImageAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactImageAuditError";
  }
}

function fail(message: string): never {
  throw new ExactImageAuditError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAbsolute(path: string, label: string): void {
  if (path.trim() === "" || !isAbsolute(path) || resolve(path) !== path) fail(`${label} must be a canonical absolute path`);
}

function parseJson(text: string, label: string): unknown {
  if (text.trim() === "") fail(`${label} output is empty`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} output is not valid JSON`);
  }
}

function assertReportShape(type: ExactImageAuditReportType, value: unknown, manifest: RuntimeImageEvidenceManifestV1): void {
  if (type === "image-history") {
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !isRecord(entry))) fail("docker history output must be a non-empty JSON object array");
    return;
  }
  if (type === "bounded-disclosure") {
    if (!isRecord(value) || value["version"] !== 1 || value["claim"] !== "bounded-taxonomy-only" || !Array.isArray(value["categories"]) || !Array.isArray(value["findings"]) || !isRecord(value["coverage"]) || typeof value["passed"] !== "boolean") {
      fail("bounded disclosure output is malformed");
    }
    return;
  }
  if (type === "vulnerability-policy") {
    if (!isRecord(value) || value["version"] !== 1 || typeof value["passed"] !== "boolean" || !Array.isArray(value["findings"]) || !Array.isArray(value["exceptions"]) || !Array.isArray(value["failures"]) || !Array.isArray(value["warnings"]) || typeof value["evaluatedAt"] !== "string") {
      fail("vulnerability policy output is malformed");
    }
    return;
  }
  if (type === "image-inspect") {
    if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) fail("docker inspect output must contain exactly one image");
    const inspected = value[0];
    const architecture = manifest.architecture.split("/")[1];
    if (inspected["Os"] !== "linux") fail("docker inspect operating system does not match the evidence manifest");
    if (inspected["Architecture"] !== architecture) fail("docker inspect architecture does not match the evidence manifest");
    if (inspected["Size"] !== manifest.image.sizeBytes) fail("docker inspect size does not match the evidence manifest");
    const repoDigests = inspected["RepoDigests"];
    if (!Array.isArray(repoDigests) || !repoDigests.includes(manifest.image.reference)) fail("docker inspect repository digests do not contain the immutable image reference");
    return;
  }
  if (!isRecord(value)) fail(`${type} output must be a JSON object`);
  if (type === "sbom") {
    if (!Array.isArray(value["artifacts"]) || !isRecord(value["source"])) fail("Syft output must contain artifacts and source");
    const source = value["source"];
    const target = source["target"];
    const metadata = source["metadata"];
    const userInput = isRecord(metadata) && typeof metadata["userInput"] === "string"
      ? metadata["userInput"]
      : isRecord(target) && typeof target["userInput"] === "string" ? target["userInput"] : undefined;
    if (userInput !== manifest.image.reference) fail("Syft output target does not match the immutable image reference");
    if (source["version"] !== manifest.image.digest) fail("Syft output source version does not match the immutable image digest");
    const repoDigests = isRecord(metadata) ? metadata["repoDigests"] : undefined;
    if (!Array.isArray(repoDigests) || !repoDigests.includes(manifest.image.reference)) {
      fail("Syft output repository digests do not contain the immutable image reference");
    }
  }
  if (type === "vulnerabilities" && (!Array.isArray(value["matches"]) || !isRecord(value["source"]) || !isRecord(value["descriptor"]))) {
    fail("Grype output must contain matches, source, and descriptor");
  }
  if (type === "image-analysis") {
    if (typeof value["SchemaVersion"] !== "number" || !Array.isArray(value["Results"])) fail("Trivy output must contain SchemaVersion and Results");
    if (typeof value["ArtifactName"] === "string" && value["ArtifactName"] !== manifest.image.reference) {
      fail("Trivy output target does not match the immutable image reference");
    }
  }
}

function parseVersion(text: string, name: ExactImageAuditToolName): string {
  const match = /^Version:\s*v?(\S+)\s*$/m.exec(text);
  if (!match) fail(`${name} version output is malformed`);
  return match[1]!;
}

async function defaultRun(command: string, args: readonly string[], environment: Readonly<Record<string, string>> = {}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      env: { ...process.env, ...environment },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const candidate = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { exitCode: typeof candidate.code === "number" ? candidate.code : 1, stdout: candidate.stdout ?? "", stderr: candidate.stderr ?? candidate.message ?? String(error) };
  }
}

async function checkedRun(
  run: NonNullable<ExactImageAuditDependencies["run"]>,
  command: string,
  args: readonly string[],
  label: string,
  environment?: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await run(command, args, environment);
  if (result.exitCode !== 0) fail(`${label} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
  if (result.stdout.trim() === "") fail(`${label} produced no output`);
  return result.stdout;
}

function reportEntry(type: ExactImageAuditReportType, path: string, contents: string, manifest: RuntimeImageEvidenceManifestV1): ExactImageAuditReportEntryV1 {
  const bytes = Buffer.from(contents);
  return {
    type,
    path,
    sizeBytes: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sourceSha: manifest.sourceSha,
    architecture: manifest.architecture,
    image: manifest.image,
  };
}

function assertManifestBindings(input: RunExactImageAuditInput): void {
  for (const name of ["syft", "grype", "trivy"] as const) {
    const expected = input.toolManifest.tools[name].version;
    if (input.manifest.tools[name] !== expected) fail(`manifest.tools.${name} must equal pinned version ${expected}`);
    if (name !== "syft") {
      const database = input.databaseIdentity.databases[name];
      const claimed = input.manifest.databases.find((entry) => entry.name === name);
      if (!claimed || claimed.identity !== `sha256:${database.sha256}` || claimed.version !== database.schemaVersion) {
        fail(`manifest.databases.${name} must match the supplied hash-verified database identity`);
      }
    }
  }
  for (const [name, cacheDirectory] of [["grype", input.grypeCacheDirectory], ["trivy", input.trivyCacheDirectory]] as const) {
    const databasePath = input.databaseIdentity.databases[name].path;
    const cacheRelativePath = relative(cacheDirectory, databasePath);
    if (cacheRelativePath === "" || cacheRelativePath === ".." || cacheRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(cacheRelativePath)) {
      fail(`identity.databases.${name}.path must be a file inside ${name}CacheDirectory`);
    }
  }
}

/** Executes all scanners against one immutable image and writes report-index.json last. */
export async function runExactImageAudit(input: RunExactImageAuditInput): Promise<RunExactImageAuditResult> {
  assertRuntimeImageEvidenceManifest(input.manifest);
  assertExactImageAuditToolManifest(input.toolManifest);
  for (const [label, path] of Object.entries({ toolsDirectory: input.toolsDirectory, grypeCacheDirectory: input.grypeCacheDirectory, trivyCacheDirectory: input.trivyCacheDirectory, outputRoot: input.outputRoot })) requireAbsolute(path, label);
  const databaseDependencies = input.dependencies?.readFile === undefined ? {} : { readFile: input.dependencies.readFile };
  verifyVulnerabilityDatabaseIdentity(input.databaseIdentity, databaseDependencies);
  assertManifestBindings(input);

  const run = input.dependencies?.run ?? defaultRun;
  const write = input.dependencies?.writeFile ?? (async (path, contents) => writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o644 }));
  const toolPaths = { syft: join(input.toolsDirectory, "syft"), grype: join(input.toolsDirectory, "grype"), trivy: join(input.toolsDirectory, "trivy") } as const;
  const versions = {} as Record<ExactImageAuditToolName, string>;
  for (const name of ["syft", "grype", "trivy"] as const) {
    const output = await checkedRun(run, toolPaths[name], ["version"], `${name} version`);
    versions[name] = parseVersion(output, name);
    if (versions[name] !== input.toolManifest.tools[name].version) fail(`${name} version mismatch: expected ${input.toolManifest.tools[name].version}, got ${versions[name]}`);
  }

  const written = await writeRuntimeImageEvidence(input.outputRoot, input.manifest);
  const reports: ExactImageAuditReportEntryV1[] = [];
  const emit = async (type: ExactImageAuditReportType, filename: string, raw: string, transform?: (value: unknown) => unknown): Promise<void> => {
    const parsed = parseJson(raw, type);
    const value = transform?.(parsed) ?? parsed;
    assertReportShape(type, value, input.manifest);
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    await write(join(written.directory, filename), contents);
    reports.push(reportEntry(type, filename, contents, input.manifest));
  };

  const syft = await checkedRun(run, toolPaths.syft, [input.manifest.image.reference, "-o", "syft-json"], "Syft audit");
  await emit("sbom", "sbom.syft.json", syft);
  const sbomPath = join(written.directory, "sbom.syft.json");
  const grype = await checkedRun(run, toolPaths.grype, [`sbom:${sbomPath}`, "-o", "json"], "Grype audit", {
    GRYPE_DB_AUTO_UPDATE: "false",
    GRYPE_DB_CACHE_DIR: input.grypeCacheDirectory,
  });
  await emit("vulnerabilities", "vulnerabilities.grype.json", grype);
  const trivy = await checkedRun(run, toolPaths.trivy, ["image", "--image-src", "remote", "--format", "json", "--scanners", "vuln,misconfig,secret,license", "--skip-db-update", "--skip-java-db-update", "--cache-dir", input.trivyCacheDirectory, input.manifest.image.reference], "Trivy audit");
  await emit("image-analysis", "image-analysis.trivy.json", trivy);
  const vulnerabilityPolicy = evaluateVulnerabilityPolicy({
    policy: input.vulnerabilityPolicy,
    manifest: input.manifest,
    databaseIdentity: input.databaseIdentity,
    grype: parseJson(grype, "vulnerabilities"),
    trivy: parseJson(trivy, "image-analysis"),
    evaluatedAt: input.manifest.capturedAt,
  });
  await emit("vulnerability-policy", "vulnerability-policy.json", JSON.stringify(vulnerabilityPolicy));
  const vulnerabilitySummary = renderVulnerabilityPolicyReportSummary(
    vulnerabilityPolicy,
    `Vulnerability policy — ${input.manifest.architecture}`,
  );
  await write(join(written.directory, "vulnerability-policy-summary.md"), vulnerabilitySummary);
  if (!vulnerabilityPolicy.passed) {
    fail(`vulnerability policy gate found ${vulnerabilityPolicy.failures.length} failure(s)\n\n${vulnerabilitySummary.trim()}`);
  }
  const inspect = await checkedRun(run, "docker", ["image", "inspect", input.manifest.image.reference], "Docker inspect");
  await emit("image-inspect", "image-inspect.docker.json", inspect);
  const history = await checkedRun(run, "docker", ["image", "history", "--no-trunc", "--format", "{{json .}}", input.manifest.image.reference], "Docker history");
  const historyArray = `[${history.trim().split(/\r?\n/).join(",")}]`;
  await emit("image-history", "image-history.docker.json", historyArray);
  const disclosureObservation = input.dependencies?.collectDisclosure === undefined
    ? await collectDisclosureArchive(input.manifest.image.reference, run)
    : await input.dependencies.collectDisclosure(input.manifest.image.reference);
  const disclosure = evaluateBoundedDisclosure(input.manifest, input.disclosurePolicy, disclosureObservation);
  await emit("bounded-disclosure", "bounded-disclosure.json", JSON.stringify(disclosure));
  if (!disclosure.passed) fail(`bounded disclosure gate found ${disclosure.findings.length} finding(s) and ${disclosure.coverage.unscannedTextFiles.length} unscanned text file(s)`);

  const index: ExactImageAuditReportIndexV1 = {
    version: 1,
    sourceSha: input.manifest.sourceSha,
    architecture: input.manifest.architecture,
    image: input.manifest.image,
    tools: versions,
    databases: input.databaseIdentity.databases,
    reports,
    capturedAt: input.manifest.capturedAt,
  };
  const indexPath = join(written.directory, "report-index.json");
  await write(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return { directory: written.directory, indexPath, index };
}
