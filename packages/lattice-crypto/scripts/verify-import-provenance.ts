import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packageRelativePath = "packages/lattice-crypto";
const defaultRepositoryRoot = join(import.meta.dir, "../../..");
const pinnedSourceCommit = "a1fc280cd646fe147427b9feb8a41f121386a138";
const pinnedSourceRootTree = "aeec95b24de2672346652c6a4ed312fc898d84f6";
const pinnedMechanicalImport =
  "593e64df8b9bb2f62281d65b239a587b132cd93b";
const pinnedReceiptSha256 =
  "6ec11122f06c640f258c1a175376cfbc05a22c81c9283e8e5202342aad702c24";
const pinnedSourceManifestSha256 =
  "58f3b83d74a12fac09abcc7088f35d6a528240ac1601980b3c23b8d866952726";
const unitTestBasenames = new Set([
  "engine.test.ts",
  "grant-cache.test.ts",
  "validation.test.ts",
]);
const pinnedRootLock = {
  sourcePath: "bun.lock",
  destinationPath:
    "packages/lattice-crypto/provenance/lattice-lab-bun.lock",
  sourceMode: "100644",
  sourceType: "blob",
  sourceBlobSha: "9eacbe994927bc8155afc29f5b7d03ef42928a87",
  sourceSize: 40_193,
  sourceSha256:
    "21404f3399ce3f5cf8132f0e495c6ed86df6620bd94922f4a22e2660c4d38cfe",
} as const;
const expectedWorkspacePaths = new Set([
  ".github/workflows/lattice-crypto.yml",
  "bun.lock",
  "dev/tests/repo-invariants/lattice-crypto-import.test.ts",
  "eslint.config.mjs",
  "knip.json",
  "packages/encryption-invariants/generated/encryption-coverage.md",
  "packages/encryption-invariants/package.json",
  "packages/encryption-invariants/stryker.config.mjs",
  "packages/encryption-invariants/src/node/source-inventory.ts",
  "packages/encryption-invariants/tests/integration/dto-inventory-actual-source.test.ts",
  "packages/encryption-invariants/tests/integration/repository-inventory.test.ts",
  "packages/encryption-invariants/tests/integration/source-inventory-declarations.test.ts",
  "packaging/docker/Dockerfile",
]);
const allowedAdaptations = new Set([
  "artifact-provenance",
  "branding-domain",
  "package-name",
  "script-path",
  "test-boundary",
  "workspace-config",
]);
const immutableHistoricalEvidence = new Set([
  "packages/lattice-crypto/LICENSE.lattice-lab",
  "packages/lattice-crypto/NOTICE",
  "packages/lattice-crypto/PROVENANCE.md",
  "packages/lattice-crypto/THIRD_PARTY_NOTICES.cargo.md",
  "packages/lattice-crypto/THIRD_PARTY_NOTICES.md",
  "packages/lattice-crypto/provenance/lattice-lab-bun.lock",
]);

type SourceRecord = {
  sourcePath: string;
  destinationPath: string;
  sourceMode: string;
  sourceType: string;
  sourceBlobSha: string;
  sourceSize: number;
  sourceSha256: string;
  destinationSha256BeforeAdaptation: string;
  destinationSha256AfterAdaptation: string;
  adaptations: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !value.includes("\\")
    && value.split("/").every((segment) =>
      segment.length > 0 && segment !== "." && segment !== ".."
    );
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function destinationFor(sourcePath: string): string | null {
  const testPrefix = `${packageRelativePath}/tests/`;
  if (sourcePath.startsWith(testPrefix)) {
    const basename = sourcePath.slice(testPrefix.length);
    const lane = unitTestBasenames.has(basename) ? "unit" : "integration";
    return `${testPrefix}${lane}/${basename}`;
  }
  if (sourcePath.startsWith(`${packageRelativePath}/`)) return sourcePath;
  if (sourcePath === "scripts/build-openmls-wasm.sh") {
    return `${packageRelativePath}/scripts/build-openmls-wasm.sh`;
  }
  if (sourcePath === "LICENSE") {
    return `${packageRelativePath}/LICENSE.lattice-lab`;
  }
  return null;
}

function sourceManifestFingerprint(records: readonly SourceRecord[]): string {
  return sha256(
    [...records]
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
      .map((record) =>
        [
          record.sourcePath,
          record.sourceMode,
          record.sourceType,
          record.sourceBlobSha,
          String(record.sourceSize),
          record.sourceSha256,
        ].join("\0")
      )
      .join("\n"),
  );
}

function addDestination(
  destinationPath: unknown,
  accounted: Set<string>,
  errors: string[],
): destinationPath is string {
  if (!exactRelativePath(destinationPath)) {
    errors.push(`invalid destination path: ${String(destinationPath)}`);
    return false;
  }
  if (accounted.has(destinationPath)) {
    errors.push(`duplicate destination path: ${destinationPath}`);
    return false;
  }
  accounted.add(destinationPath);
  return true;
}

function verifyDestination(
  repositoryRoot: string,
  destinationPath: string,
  expectedSha256: unknown,
  errors: string[],
): void {
  if (
    typeof expectedSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(expectedSha256)
  ) {
    errors.push(`invalid destination digest: ${destinationPath}`);
    return;
  }
  const destination = join(repositoryRoot, destinationPath);
  if (!existsSync(destination)) {
    errors.push(`missing destination: ${destinationPath}`);
    return;
  }
  if (sha256(readFileSync(destination)) !== expectedSha256) {
    errors.push(`destination byte drift: ${destinationPath}`);
  }
}

function parseSourceRecord(
  value: unknown,
  index: number,
  errors: string[],
): SourceRecord | null {
  if (!isRecord(value)) {
    errors.push(`source record ${index} must be an object`);
    return null;
  }
  const stringFields = [
    "sourcePath",
    "destinationPath",
    "sourceMode",
    "sourceType",
    "sourceBlobSha",
    "sourceSha256",
    "destinationSha256BeforeAdaptation",
    "destinationSha256AfterAdaptation",
  ] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== "string") {
      errors.push(`source record ${index} has invalid ${field}`);
    }
  }
  if (
    !Number.isSafeInteger(value["sourceSize"])
    || Number(value["sourceSize"]) < 0
  ) {
    errors.push(`source record ${index} has invalid sourceSize`);
  }
  if (
    !Array.isArray(value["adaptations"])
    || value["adaptations"].some((entry) => typeof entry !== "string")
  ) {
    errors.push(`source record ${index} has invalid adaptations`);
  }
  if (errors.some((error) => error.startsWith(`source record ${index} `))) {
    return null;
  }
  return value as unknown as SourceRecord;
}

function verifyHashedRecords(
  repositoryRoot: string,
  value: unknown,
  field: "generatedFiles" | "workspaceAdaptations",
  accounted: Set<string>,
  errors: string[],
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      errors.push(`${field} record ${index} must be an object`);
      continue;
    }
    if (!addDestination(entry["destinationPath"], accounted, errors)) continue;
    paths.push(entry["destinationPath"]);
    const digest = field === "generatedFiles"
      ? entry["destinationSha256"]
      : entry["destinationSha256AfterAdaptation"];
    if (immutableHistoricalEvidence.has(entry["destinationPath"])) {
      verifyDestination(repositoryRoot, entry["destinationPath"], digest, errors);
    }
    if (
      field === "generatedFiles"
      && (
        typeof entry["reason"] !== "string"
        || entry["reason"].trim().length === 0
      )
    ) {
      errors.push(`generated file lacks reason: ${entry["destinationPath"]}`);
    }
    if (
      field === "workspaceAdaptations"
      && (
        !Array.isArray(entry["adaptations"])
        || entry["adaptations"].length === 0
        || entry["adaptations"].some((item) =>
          typeof item !== "string" || item.trim().length === 0
        )
      )
    ) {
      errors.push(
        `workspace adaptation lacks reason: ${entry["destinationPath"]}`,
      );
    }
  }
  return paths;
}

export function auditImportManifest(
  value: unknown,
  repositoryRoot = defaultRepositoryRoot,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["provenance manifest must be an object"];
  if (value["schemaVersion"] !== 1) errors.push("unsupported provenance schema");
  if (
    value["sourceCommit"] !== pinnedSourceCommit
    || value["sourceRootTree"] !== pinnedSourceRootTree
    || value["mechanicalImportCommit"] !== pinnedMechanicalImport
  ) {
    errors.push("pinned source identity drift");
  }
  const source = value["source"];
  if (
    !isRecord(source)
    || source["repository"] !== "agentsea/lattice-lab"
    || source["commit"] !== pinnedSourceCommit
    || source["rootTree"] !== pinnedSourceRootTree
    || source["objectFormat"] !== "sha1"
  ) {
    errors.push("source identity mirror drift");
  }
  const trustBoundary = value["manifestTrustBoundary"];
  if (
    !isRecord(trustBoundary)
    || trustBoundary["excludedSelf"]
      !== `${packageRelativePath}/PROVENANCE.json`
    || typeof trustBoundary["rule"] !== "string"
  ) {
    errors.push("manifest trust boundary drift");
  }

  const accounted = new Set<string>();
  const sourcePaths = new Set<string>();
  const sourceRecords: SourceRecord[] = [];
  const files = value["files"];
  if (!Array.isArray(files) || files.length !== 57) {
    errors.push("source file count drift");
  } else {
    for (const [index, candidate] of files.entries()) {
      const record = parseSourceRecord(candidate, index, errors);
      if (!record) continue;
      sourceRecords.push(record);
      if (!exactRelativePath(record.sourcePath)) {
        errors.push("invalid source path");
      } else if (sourcePaths.has(record.sourcePath)) {
        errors.push(`duplicate source path: ${record.sourcePath}`);
      } else {
        sourcePaths.add(record.sourcePath);
      }
      if (!["100644", "100755"].includes(record.sourceMode)) {
        errors.push(`invalid source mode: ${record.sourcePath}`);
      }
      if (record.sourceType !== "blob") {
        errors.push(`invalid source type: ${record.sourcePath}`);
      }
      if (!/^[0-9a-f]{40}$/u.test(record.sourceBlobSha)) {
        errors.push(`invalid source blob: ${record.sourcePath}`);
      }
      if (!/^[0-9a-f]{64}$/u.test(record.sourceSha256)) {
        errors.push(`invalid source digest: ${record.sourcePath}`);
      }
      if (record.destinationSha256BeforeAdaptation !== record.sourceSha256) {
        errors.push(`pre-adaptation digest drift: ${record.sourcePath}`);
      }
      const expectedDestination = destinationFor(record.sourcePath);
      if (record.destinationPath !== expectedDestination) {
        errors.push(`source/destination mapping drift: ${record.sourcePath}`);
      }
      const adaptations = new Set(record.adaptations);
      if (
        adaptations.size !== record.adaptations.length
        || record.adaptations.some((entry) => !allowedAdaptations.has(entry))
      ) {
        errors.push(`invalid adaptations: ${record.sourcePath}`);
      }
      const changed = record.destinationSha256AfterAdaptation
        !== record.sourceSha256;
      const testBoundaryAdaptation =
        record.sourcePath.startsWith(`${packageRelativePath}/tests/`)
        && record.destinationPath !== record.sourcePath;
      if (
        (changed || testBoundaryAdaptation)
        !== (record.adaptations.length > 0)
      ) {
        errors.push(`adaptation accounting drift: ${record.sourcePath}`);
      }
      if (addDestination(record.destinationPath, accounted, errors)) {
        if (immutableHistoricalEvidence.has(record.destinationPath)) {
          verifyDestination(
            repositoryRoot,
            record.destinationPath,
            record.destinationSha256AfterAdaptation,
            errors,
          );
        }
      }
    }
  }
  if (
    sourceRecords.length === 57
    && sourceManifestFingerprint(sourceRecords) !== pinnedSourceManifestSha256
  ) {
    errors.push("pinned source manifest drift");
  }

  const sourceRootEvidence = value["sourceRootEvidence"];
  if (
    !Array.isArray(sourceRootEvidence)
    || sourceRootEvidence.length !== 1
    || !isRecord(sourceRootEvidence[0])
  ) {
    errors.push("source-root evidence drift");
  } else {
    const rootLock = sourceRootEvidence[0];
    for (const [field, expected] of Object.entries(pinnedRootLock)) {
      if (rootLock[field] !== expected) {
        errors.push(`source-root evidence ${field} drift`);
      }
    }
    if (addDestination(rootLock["destinationPath"], accounted, errors)) {
      verifyDestination(
        repositoryRoot,
        rootLock["destinationPath"],
        rootLock["sourceSha256"],
        errors,
      );
    }
  }

  verifyHashedRecords(
    repositoryRoot,
    value["generatedFiles"],
    "generatedFiles",
    accounted,
    errors,
  );
  const workspacePaths = verifyHashedRecords(
    repositoryRoot,
    value["workspaceAdaptations"],
    "workspaceAdaptations",
    accounted,
    errors,
  );
  if (
    workspacePaths.length !== expectedWorkspacePaths.size
    || workspacePaths.some((path) => !expectedWorkspacePaths.has(path))
  ) {
    errors.push("workspace adaptation inventory drift");
  }

  return [...new Set(errors)].sort();
}

export function auditImportReceiptBytes(
  receiptBytes: Uint8Array,
  repositoryRoot = defaultRepositoryRoot,
): string[] {
  const errors: string[] = [];
  if (sha256(receiptBytes) !== pinnedReceiptSha256) {
    errors.push("immutable import receipt byte drift");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(receiptBytes).toString("utf8"));
  } catch {
    return [...errors, "invalid import receipt JSON"].sort();
  }
  return [...new Set([
    ...errors,
    ...auditImportManifest(manifest, repositoryRoot),
  ])].sort();
}

if (import.meta.main) {
  const manifestPath = join(
    defaultRepositoryRoot,
    packageRelativePath,
    "PROVENANCE.json",
  );
  if (!existsSync(manifestPath)) throw new Error("missing PROVENANCE.json");
  const receiptBytes = readFileSync(manifestPath);
  const manifest: unknown = JSON.parse(receiptBytes.toString("utf8"));
  const errors = auditImportReceiptBytes(receiptBytes);
  if (errors.length > 0) {
    throw new Error(`Import provenance verification failed:\n- ${errors.join("\n- ")}`);
  }
  const parsed = manifest as {
    files: unknown[];
    generatedFiles: unknown[];
    workspaceAdaptations: unknown[];
  };
  console.log(
    `Verified ${parsed.files.length} imported files, `
      + `${parsed.generatedFiles.length} generated files, and `
      + `${parsed.workspaceAdaptations.length} workspace adaptations.`,
  );
}
