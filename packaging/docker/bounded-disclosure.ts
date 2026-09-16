/** D490 Task 0.3.3 — deliberately bounded exact-image disclosure gate. */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";

export const BOUNDED_DISCLOSURE_CATEGORIES = [
  "secret-material", "package-auth-config", "repository-operator-path", "private-identity",
  "customer-marker", "source-map", "unsafe-oci-metadata",
] as const;
export type BoundedDisclosureCategory = typeof BOUNDED_DISCLOSURE_CATEGORIES[number];

export interface BoundedDisclosurePolicyV1 {
  readonly version: 1;
  readonly repositoryPaths: readonly string[];
  readonly operatorPaths: readonly string[];
  readonly privateHostnames: readonly string[];
  readonly privateEmails: readonly string[];
  readonly privateUsernames: readonly string[];
  readonly customerMarkers: readonly string[];
}

export interface DisclosureFileObservation {
  readonly layer: string;
  readonly path: string;
  readonly contents?: string;
}

export interface DisclosureArchiveObservation {
  readonly files: readonly DisclosureFileObservation[];
  readonly ociMetadata: unknown;
  readonly layersInspected: number;
  readonly filesInspected: number;
  readonly textBytesInspected: number;
  readonly unscannedTextFiles: readonly string[];
}

export interface BoundedDisclosureFindingV1 {
  readonly category: BoundedDisclosureCategory;
  readonly location: "file-path" | "file-content" | "oci-metadata";
  readonly path: string;
  readonly layer?: string;
  readonly rule: string;
  readonly matchSha256: string;
}

export interface BoundedDisclosureReportV1 {
  readonly version: 1;
  readonly claim: "bounded-taxonomy-only";
  readonly sourceSha: string;
  readonly architecture: RuntimeImageEvidenceManifestV1["architecture"];
  readonly image: RuntimeImageEvidenceManifestV1["image"];
  readonly categories: readonly BoundedDisclosureCategory[];
  readonly coverage: Readonly<{
    readonly layersInspected: number;
    readonly filesInspected: number;
    readonly textBytesInspected: number;
    readonly unscannedTextFiles: readonly string[];
  }>;
  readonly findings: readonly BoundedDisclosureFindingV1[];
  readonly passed: boolean;
  readonly limitation: "Does not claim detection of all PII or all possible sensitive information.";
}

export class BoundedDisclosureError extends Error {
  constructor(message: string) { super(message); this.name = "BoundedDisclosureError"; }
}

function fail(message: string): never { throw new BoundedDisclosureError(message); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hash(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function strictStrings(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const seen = new Set<string>();
  for (const marker of value) {
    if (typeof marker !== "string" || marker.trim() === "" || marker.length > 512) fail(`${label} entries must be non-blank strings of at most 512 characters`);
    if (seen.has(marker)) fail(`${label} contains a duplicate marker`);
    seen.add(marker);
  }
}

export function assertBoundedDisclosurePolicy(value: unknown): asserts value is BoundedDisclosurePolicyV1 {
  if (!isRecord(value) || value["version"] !== 1) fail("policy must be a version-1 object");
  const keys = ["version", "repositoryPaths", "operatorPaths", "privateHostnames", "privateEmails", "privateUsernames", "customerMarkers"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) fail(`policy must contain exactly: ${keys.join(", ")}`);
  for (const key of keys.slice(1)) strictStrings(value[key], `policy.${key}`);
}

export function parseBoundedDisclosurePolicy(text: string): BoundedDisclosurePolicyV1 {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("policy is not valid JSON"); }
  assertBoundedDisclosurePolicy(value);
  return value;
}

const SECRET_RULES: readonly [string, RegExp][] = [
  // A header by itself is a common parser constant. Require a bounded, complete key block.
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\r?\n(?=[\s\S]{32,8192}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)[\s\S]{32,8192}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
];
const CREDENTIAL_ASSIGNMENT = /\b(?:[A-Za-z0-9]+_)*(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*(["']?)([A-Za-z0-9_+./=-]{12,})\2/gi;
const AUTH_PATH = /(?:^|\/)(?:\.npmrc|\.yarnrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|\.env(?:\.[^/]+)?|\.docker\/config\.json|\.config\/gh\/hosts\.yml)$/i;
const SOURCE_MAP_PATH = /(?:^|\/)\S+\.(?:js|css)?\.map$/i;
const GITHUB_WORKSPACE_PATH = /\/github\/workspace(?=\/|$|[^\w-])/g;
const INERT_EXAMPLE_WORDS = ["...", "correct-horse", "example", "sample", "placeholder", "replace", "salt-", "your_", "your-", "yourtoken", "tokenhere", "secret_here", "not-a-real", "fake", "dummy", "mock", "test-token", "test_key"];
const PUBLIC_PROTOCOL_IDENTIFIERS = new Set(["x-aws-ec2-metadata-token"]);
const INERT_SEQUENCE = /(?:abcdefghijklmnopqrstuvwxyz|zyxwvutsrqponmlkjihgfedcba|0123456789|9876543210)/i;

function isInertExample(value: string): boolean {
  const normalized = value.toLowerCase();
  const payload = normalized.replace(/^(?:gh[pousr]_|github_pat_|akia|asia)/, "");
  return PUBLIC_PROTOCOL_IDENTIFIERS.has(normalized)
    || INERT_EXAMPLE_WORDS.some((word) => normalized.includes(word))
    || INERT_SEQUENCE.test(normalized)
    || new Set(payload).size <= 3;
}

function entropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function isLikelyEmbeddedCredential(value: string, quoted: boolean): boolean {
  // This is deliberately not a universal secret detector: it keeps high-signal assignments
  // while avoiding SDK documentation placeholders, environment-variable names, and code identifiers.
  return quoted && value.length >= 16 && /\d/.test(value) && !/^[A-Z][A-Z0-9_]+$/.test(value) && !isInertExample(value) && entropy(value) >= 3.25;
}

function strings(value: unknown, path = "$", output: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (typeof value === "string") output.push({ path, value });
  else if (Array.isArray(value)) value.forEach((entry, index) => strings(entry, `${path}[${index}]`, output));
  else if (isRecord(value)) Object.entries(value).forEach(([key, entry]) => strings(entry, `${path}.${key}`, output));
  return output;
}

export function evaluateBoundedDisclosure(
  manifest: RuntimeImageEvidenceManifestV1,
  policy: BoundedDisclosurePolicyV1,
  observation: DisclosureArchiveObservation,
): BoundedDisclosureReportV1 {
  assertBoundedDisclosurePolicy(policy);
  const findings: BoundedDisclosureFindingV1[] = [];
  const dedupe = new Set<string>();
  const add = (category: BoundedDisclosureCategory, location: BoundedDisclosureFindingV1["location"], path: string, rule: string, match: string, layer?: string): void => {
    const reportedPath = location === "file-path" && (category === "repository-operator-path" || category === "private-identity" || category === "customer-marker")
      ? `<redacted-path:${hash(path)}>` : path;
    const key = `${category}\0${location}\0${reportedPath}\0${rule}\0${hash(match)}\0${layer ?? ""}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    findings.push({ category, location, path: reportedPath, rule, matchSha256: hash(match), ...(layer === undefined ? {} : { layer }) });
  };
  const markerGroups: readonly [BoundedDisclosureCategory, string, readonly string[]][] = [
    ["repository-operator-path", "repository-path", policy.repositoryPaths],
    ["repository-operator-path", "operator-path", policy.operatorPaths],
    ["private-identity", "private-hostname", policy.privateHostnames],
    ["private-identity", "private-email", policy.privateEmails],
    ["private-identity", "private-username", policy.privateUsernames],
    ["customer-marker", "customer-marker", policy.customerMarkers],
  ];
  const scan = (text: string, location: BoundedDisclosureFindingV1["location"], path: string, layer?: string): void => {
    for (const [rule, pattern] of SECRET_RULES) {
      for (const match of text.matchAll(pattern)) {
        if (isInertExample(match[0])) continue;
        add("secret-material", location, path, rule, match[0], layer);
      }
    }
    for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
      if (isLikelyEmbeddedCredential(match[3]!, match[2] !== "")) add("secret-material", location, path, "credential-assignment", match[0], layer);
    }
    for (const match of text.matchAll(GITHUB_WORKSPACE_PATH)) add("repository-operator-path", location, path, "host-build-path", match[0], layer);
    for (const [category, rule, markers] of markerGroups) for (const marker of markers) if (text.includes(marker)) add(category, location, path, rule, marker, layer);
  };
  for (const file of observation.files) {
    if (AUTH_PATH.test(file.path)) add("package-auth-config", "file-path", file.path, "auth-config-path", file.path, file.layer);
    if (SOURCE_MAP_PATH.test(file.path)) add("source-map", "file-path", file.path, "source-map-path", file.path, file.layer);
    scan(file.path, "file-path", file.path, file.layer);
    if (file.contents !== undefined) scan(file.contents, "file-content", file.path, file.layer);
  }
  for (const item of strings(observation.ociMetadata)) {
    const before = findings.length;
    scan(item.value, "oci-metadata", item.path);
    if (findings.length > before) add("unsafe-oci-metadata", "oci-metadata", item.path, "sensitive-oci-value", item.value);
    if (/\.(?:Env|Labels)(?:\.|\[)/.test(item.path) && /(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)/i.test(`${item.path}=${item.value}`) && item.value.trim() !== "") {
      add("unsafe-oci-metadata", "oci-metadata", item.path, "credential-bearing-oci-field", item.value);
    }
  }
  const revision = isRecord(observation.ociMetadata) && isRecord(observation.ociMetadata["config"]) && isRecord(observation.ociMetadata["config"]["Labels"])
    ? observation.ociMetadata["config"]["Labels"]["org.opencontainers.image.revision"] : undefined;
  if (typeof revision === "string" && revision !== manifest.sourceSha) add("unsafe-oci-metadata", "oci-metadata", "$.config.Labels.org.opencontainers.image.revision", "source-revision-mismatch", revision);
  findings.sort((a, b) => `${a.category}:${a.path}:${a.rule}`.localeCompare(`${b.category}:${b.path}:${b.rule}`));
  return {
    version: 1, claim: "bounded-taxonomy-only", sourceSha: manifest.sourceSha, architecture: manifest.architecture, image: manifest.image,
    categories: BOUNDED_DISCLOSURE_CATEGORIES,
    coverage: { layersInspected: observation.layersInspected, filesInspected: observation.filesInspected, textBytesInspected: observation.textBytesInspected, unscannedTextFiles: observation.unscannedTextFiles },
    findings, passed: findings.length === 0 && observation.unscannedTextFiles.length === 0,
    limitation: "Does not claim detection of all PII or all possible sensitive information.",
  };
}

export interface DisclosureArchiveCommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; }
export type RunDisclosureArchiveCommand = (command: string, args: readonly string[]) => Promise<DisclosureArchiveCommandResult>;

function safeTarEntries(text: string, label: string): string[] {
  const entries = text.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    if (entry.includes("\0") || isAbsolute(entry) || entry.split("/").includes("..")) fail(`${label} contains an unsafe path: ${JSON.stringify(entry)}`);
  }
  return entries;
}

async function run(runCommand: RunDisclosureArchiveCommand, command: string, args: readonly string[], label: string, requireOutput = true): Promise<string> {
  const result = await runCommand(command, args);
  if (result.exitCode !== 0) fail(`${label} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
  if (requireOutput && result.stdout.trim() === "") fail(`${label} produced no output`);
  return result.stdout;
}

async function walk(base: string, current: string, layer: string, files: DisclosureFileObservation[], coverage: { files: number; bytes: number; skipped: string[] }): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const relativePath = relative(base, path).replaceAll("\\", "/");
    // Docker save archives encode overlay deletions as zero-byte `.wh.*`
    // markers, commonly mode 000. Their path is evidence; they have no file
    // contents to inspect and even resolving them can fail by architecture.
    if (entry.isFile() && relativePath.split("/").some((component) => component.startsWith(".wh."))) {
      coverage.files += 1;
      files.push({ layer, path: relativePath });
      continue;
    }
    const canonical = await realpath(path);
    if (canonical !== base && !canonical.startsWith(`${base}/`)) fail(`layer extraction escaped its directory: ${path}`);
    if (entry.isDirectory()) { await walk(base, path, layer, files, coverage); continue; }
    coverage.files += 1;
    const stat = await lstat(path);
    const handle = await open(path, "r");
    const sample = Buffer.alloc(Math.min(stat.size, 8192));
    try { await handle.read(sample, 0, sample.length, 0); } finally { await handle.close(); }
    if (sample.includes(0)) { files.push({ layer, path: relativePath }); continue; }
    if (stat.size > 16 * 1024 * 1024) { coverage.skipped.push(`${layer}:${relativePath}`); files.push({ layer, path: relativePath }); continue; }
    const contents = await readFile(path, "utf8");
    coverage.bytes += Buffer.byteLength(contents);
    files.push({ layer, path: relativePath, contents });
  }
}

/** Saves and inspects every declared Docker layer in isolated temporary directories. */
export async function collectDisclosureArchive(imageReference: string, runCommand: RunDisclosureArchiveCommand): Promise<DisclosureArchiveObservation> {
  const temporary = await mkdtemp(join(tmpdir(), "d490-disclosure-"));
  try {
    const archive = join(temporary, "image.tar");
    const outer = join(temporary, "outer");
    await mkdir(outer);
    await run(runCommand, "docker", ["image", "save", "--output", archive, imageReference], "Docker image save", false);
    safeTarEntries(await run(runCommand, "tar", ["-tf", archive], "Docker image archive listing"), "Docker image archive");
    await run(runCommand, "tar", ["-xf", archive, "-C", outer], "Docker image archive extraction", false);
    // The outer archive now owns complete copies of every layer tar. Keeping
    // image.tar as well doubles the compressed image footprint on the hosted
    // runner and can exhaust AMD64 disk before disclosure inspection starts.
    await rm(archive);
    const manifests = JSON.parse(await readFile(join(outer, "manifest.json"), "utf8")) as unknown;
    if (!Array.isArray(manifests) || manifests.length !== 1 || !isRecord(manifests[0]) || typeof manifests[0]["Config"] !== "string" || !Array.isArray(manifests[0]["Layers"])) fail("Docker image archive manifest is malformed");
    const configPath = manifests[0]["Config"];
    const layerPaths = manifests[0]["Layers"];
    if (layerPaths.some((layerPath) => typeof layerPath !== "string")) fail("Docker image archive layer path is malformed");
    const declaredLayerPaths = layerPaths as string[];
    safeTarEntries([configPath, ...layerPaths].join("\n"), "Docker image archive manifest");
    const ociMetadata = JSON.parse(await readFile(join(outer, configPath), "utf8")) as unknown;
    const files: DisclosureFileObservation[] = [];
    const coverage = { files: 0, bytes: 0, skipped: [] as string[] };
    const remainingLayerUses = new Map<string, number>();
    for (const layerPath of declaredLayerPaths) remainingLayerUses.set(layerPath, (remainingLayerUses.get(layerPath) ?? 0) + 1);
    for (const [index, layerPath] of declaredLayerPaths.entries()) {
      const layerTar = resolve(outer, layerPath);
      if (!layerTar.startsWith(`${outer}/`)) fail("Docker image archive layer escaped its directory");
      const layerEntries = safeTarEntries(await run(runCommand, "tar", ["-tf", layerTar], `layer ${index} listing`, false), `layer ${index}`);
      const layerDirectory = join(temporary, `layer-${index}`);
      const layerRoot = join(layerDirectory, "layer-root");
      await mkdir(layerRoot, { recursive: true });
      if (layerEntries.length > 0) await run(runCommand, "tar", ["-xf", layerTar, "-C", layerRoot], `layer ${index} extraction`, false);
      // Inspect one layer at a time and always remove its expanded root before
      // advancing. Remove the tar after its final manifest reference; OCI may
      // legitimately reuse one empty-layer blob at multiple history positions.
      const remainingUses = (remainingLayerUses.get(layerPath) ?? 1) - 1;
      remainingLayerUses.set(layerPath, remainingUses);
      if (remainingUses === 0) await rm(layerTar);
      try {
        const canonicalLayerRoot = await realpath(layerRoot);
        await walk(canonicalLayerRoot, canonicalLayerRoot, layerPath, files, coverage);
      } finally {
        await rm(layerDirectory, { recursive: true, force: true });
      }
    }
    return { files, ociMetadata, layersInspected: declaredLayerPaths.length, filesInspected: coverage.files, textBytesInspected: coverage.bytes, unscannedTextFiles: coverage.skipped };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
