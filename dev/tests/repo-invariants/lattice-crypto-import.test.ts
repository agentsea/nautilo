import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import ts from "typescript";
import {
  auditImportManifest,
  auditImportReceiptBytes,
} from
  "../../../packages/lattice-crypto/scripts/verify-import-provenance.ts";
import {
  assertCompleteMutationCoverage,
  parseMutationManifest,
} from
  "../../../packages/lattice-crypto/scripts/mutation-governance.ts";
import { parseMutationResidualLedger } from
  "../../../packages/lattice-crypto/scripts/mutation-policy.ts";
import { deriveMutationSourceInventory } from
  "../../../packages/lattice-crypto/scripts/mutation-source-inventory.ts";

const repositoryRoot = join(import.meta.dir, "../../..");
const packageRelativePath = "packages/lattice-crypto";
const packageRoot = join(repositoryRoot, packageRelativePath);
const bridgeRelativePath = "packages/lattice-bridge";
const bridgeRoot = join(repositoryRoot, bridgeRelativePath);
const pinnedSourceCommit = "a1fc280cd646fe147427b9feb8a41f121386a138";
const pinnedSourceRootTree = "aeec95b24de2672346652c6a4ed312fc898d84f6";
const pinnedSourceFileCount = 57;
const pinnedSourceManifestSha256 =
  "58f3b83d74a12fac09abcc7088f35d6a528240ac1601980b3c23b8d866952726";
const pinnedRootLock = {
  sourcePath: "bun.lock",
  sourceMode: "100644",
  sourceType: "blob",
  sourceBlobSha: "9eacbe994927bc8155afc29f5b7d03ef42928a87",
  sourceSize: 40_193,
  sourceSha256:
    "21404f3399ce3f5cf8132f0e495c6ed86df6620bd94922f4a22e2660c4d38cfe",
} as const;

const allowedAdaptations = new Set([
  "package-name",
  "package-version",
  "package-scripts",
  "workspace-config",
  "script-path",
  "branding-domain",
  "old-domain-negative-test",
  "regenerated-fixture",
  "toolchain-provenance",
  "test-boundary",
  "license-provenance",
  "verification-infrastructure",
  "artifact-provenance",
]);

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const legacyV1Modules = new Set([
  "src/conformance/suite.ts",
  "src/engine/engine.ts",
  "src/format/grant-v1.ts",
  "src/format/object-v1.ts",
  "src/group/dummy.ts",
  "src/group/mls.ts",
  "src/group/openmls.ts",
  "src/group/provider.ts",
  "src/lattice/enumeration.ts",
  "src/lattice/scheme.ts",
  "src/limits.ts",
  "src/recovery/device-vault.ts",
  "src/recovery/kit-v1.ts",
  "src/recovery/protocol.ts",
  "src/storage/in-memory-relational-store.ts",
  "src/storage/store.ts",
  "src/testing/v1-compat.ts",
  "src/testing/matrix.ts",
  "src/testing/world.ts",
  "src/types/index.ts",
  "src/util/sets.ts",
  "src/validation.ts",
]);

const sharedV1V2RootExportNames = new Set([
  "Clock",
  "GrantId",
  "GroupKeyProvider",
  "KeyPair",
  "LATTICE_LIMITS",
  "LatticeCrypto",
  "NamespaceId",
  "ObjectId",
  "OpenMlsGroupProvider",
  "Rng",
  "canonicalizeParticipants",
  "systemClock",
  "systemRng",
]);

const ignoredDirectories = new Set([
  ".git",
  ".stryker-tmp",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reports",
  "target",
]);

const ignoredGeneratedFiles = new Set(["tsconfig.tsbuildinfo"]);

const historicalEvidenceFiles = new Set([
  "LICENSE.lattice-lab",
  "NOTICE",
  "PROVENANCE.json",
  "PROVENANCE.md",
  "THIRD_PARTY_NOTICES.cargo.md",
  "THIRD_PARTY_NOTICES.md",
  "bun.lock.lattice-lab",
  "provenance/lattice-lab-bun.lock",
]);
const governedPackageDirectories = new Set([
  "openmls-wasm",
  "playground",
  "provenance",
  "scripts",
  "src",
  "tests",
  "vendor",
]);
const governedPackageRootFiles = new Set([
  "CURRENT_PACKAGE_GOVERNANCE.md",
  "LICENSE.lattice-lab",
  "NOTICE",
  "PROVENANCE.json",
  "PROVENANCE.md",
  "THIRD_PARTY_NOTICES.cargo.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "rust-toolchain.toml",
  "stryker.config.mjs",
  "tsconfig.json",
]);

type ImportedFile = {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceMode: string;
  readonly sourceType: string;
  readonly sourceBlobSha: string;
  readonly sourceSize: number;
  readonly sourceSha256: string;
  readonly destinationSha256BeforeAdaptation: string;
  readonly destinationSha256AfterAdaptation: string;
  readonly adaptations: readonly string[];
};

type RootLockEvidence = {
  readonly sourcePath: string;
  readonly sourceMode: string;
  readonly sourceType: string;
  readonly sourceBlobSha: string;
  readonly sourceSize: number;
  readonly sourceSha256: string;
};

type ProvenanceOptions = {
  readonly expectedCommit: string;
  readonly expectedRootTree: string;
  readonly expectedFileCount: number;
  readonly expectedSourceManifestSha256: string;
  readonly expectedReceiptSha256: string;
  readonly expectedRootLock: RootLockEvidence;
};

type SourceRecord = Pick<ImportedFile,
  | "sourcePath"
  | "sourceMode"
  | "sourceType"
  | "sourceBlobSha"
  | "sourceSize"
  | "sourceSha256"
>;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

function manifestSourceCommit(manifest: Record<string, unknown>): unknown {
  if ("sourceCommit" in manifest) return manifest.sourceCommit;
  return isRecord(manifest.source) ? manifest.source.commit : undefined;
}

function manifestSourceRootTree(manifest: Record<string, unknown>): unknown {
  if ("sourceRootTree" in manifest) return manifest.sourceRootTree;
  return isRecord(manifest.source) ? manifest.source.rootTree : undefined;
}

function manifestFiles(manifest: Record<string, unknown>): unknown {
  if ("files" in manifest) return manifest.files;
  return manifest.importedFiles;
}

function destinationForSource(sourcePath: string): string | null {
  const packagePrefix = "packages/lattice-crypto/";
  const testPrefix = `${packagePrefix}tests/`;
  if (sourcePath.startsWith(testPrefix)) {
    const basename = sourcePath.slice(testPrefix.length);
    const lane = new Set([
      "engine.test.ts",
      "grant-cache.test.ts",
      "validation.test.ts",
    ]).has(basename)
      ? "unit"
      : "integration";
    return `${testPrefix}${lane}/${basename}`;
  }
  if (sourcePath.startsWith(packagePrefix)) return sourcePath;
  if (sourcePath === "scripts/build-openmls-wasm.sh") {
    return "packages/lattice-crypto/scripts/build-openmls-wasm.sh";
  }
  if (sourcePath === "LICENSE") {
    return "packages/lattice-crypto/LICENSE.lattice-lab";
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

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function parseImportedFile(
  value: unknown,
  index: number,
  errors: string[],
): ImportedFile | null {
  if (!isRecord(value)) {
    errors.push(`provenance file ${index} must be an object`);
    return null;
  }
  const required = [
    "sourcePath",
    "destinationPath",
    "sourceMode",
    "sourceType",
    "sourceBlobSha",
    "sourceSha256",
    "destinationSha256BeforeAdaptation",
    "destinationSha256AfterAdaptation",
  ] as const;
  for (const field of required) {
    if (typeof value[field] !== "string") {
      errors.push(`provenance file ${index} has invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(value.sourceSize) || Number(value.sourceSize) < 0) {
    errors.push(`provenance file ${index} has invalid sourceSize`);
  }
  if (
    !Array.isArray(value.adaptations)
    || value.adaptations.some((adaptation) => typeof adaptation !== "string")
  ) {
    errors.push(`provenance file ${index} has invalid adaptations`);
  }
  if (errors.some((error) => error.startsWith(`provenance file ${index} `))) {
    return null;
  }
  return value as unknown as ImportedFile;
}

function auditImportProvenance(
  repoRoot: string,
  options: ProvenanceOptions,
): string[] {
  const errors: string[] = [];
  const manifestPath = join(repoRoot, packageRelativePath, "PROVENANCE.json");
  if (!existsSync(manifestPath)) {
    return [`missing import provenance: ${packageRelativePath}/PROVENANCE.json`];
  }

  const receiptBytes = readFileSync(manifestPath);
  if (sha256(receiptBytes) !== options.expectedReceiptSha256) {
    errors.push("immutable import receipt byte drift");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    return [`invalid JSON import provenance: ${packageRelativePath}/PROVENANCE.json`];
  }
  if (!isRecord(parsed)) {
    return ["import provenance must be an object"];
  }
  if (manifestSourceCommit(parsed) !== options.expectedCommit) {
    errors.push(
      `source commit drift: expected ${options.expectedCommit}, `
      + `received ${String(manifestSourceCommit(parsed))}`,
    );
  }
  if (manifestSourceRootTree(parsed) !== options.expectedRootTree) {
    errors.push(
      `source root tree drift: expected ${options.expectedRootTree}, `
      + `received ${String(manifestSourceRootTree(parsed))}`,
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(String(parsed.mechanicalImportCommit ?? ""))) {
    errors.push("mechanicalImportCommit must be a full Git commit SHA");
  }
  for (const field of ["generatedFiles", "workspaceAdaptations"] as const) {
    if (!Array.isArray(parsed[field])) {
      errors.push(`import provenance must contain a ${field} array`);
    }
  }

  const rawFiles = manifestFiles(parsed);
  if (!Array.isArray(rawFiles)) {
    errors.push("import provenance must contain a files array");
    return errors.sort();
  }
  if (rawFiles.length !== options.expectedFileCount) {
    errors.push(
      `source file count drift: expected ${options.expectedFileCount}, `
      + `received ${rawFiles.length}`,
    );
  }

  const files = rawFiles
    .map((value, index) => parseImportedFile(value, index, errors))
    .filter((value): value is ImportedFile => value !== null);

  for (const sourcePath of duplicateValues(files.map((file) => file.sourcePath))) {
    errors.push(`duplicate source path: ${sourcePath}`);
  }
  for (
    const destinationPath of duplicateValues(
      files.map((file) => file.destinationPath),
    )
  ) {
    errors.push(`duplicate destination path: ${destinationPath}`);
  }

  for (const file of files) {
    if (!exactRelativePath(file.sourcePath)) {
      errors.push(`invalid source path: ${file.sourcePath}`);
    }
    if (!exactRelativePath(file.destinationPath)) {
      errors.push(`invalid destination path: ${file.destinationPath}`);
    }
    const expectedDestination = destinationForSource(file.sourcePath);
    if (expectedDestination === null) {
      errors.push(`ineligible pinned source path: ${file.sourcePath}`);
    } else if (file.destinationPath !== expectedDestination) {
      errors.push(
        `destination mapping drift: ${file.sourcePath} expected `
        + `${expectedDestination}, received ${file.destinationPath}`,
      );
    }
    if (!/^[0-9a-f]{40}$/u.test(file.sourceBlobSha)) {
      errors.push(`invalid source blob SHA: ${file.sourcePath}`);
    }
    if (!/^(?:100644|100755)$/u.test(file.sourceMode)) {
      errors.push(`invalid Git source mode: ${file.sourcePath}`);
    }
    if (file.sourceType !== "blob") {
      errors.push(`invalid Git source type: ${file.sourcePath}`);
    }
    if (!Number.isSafeInteger(file.sourceSize) || file.sourceSize < 0) {
      errors.push(`invalid source size: ${file.sourcePath}`);
    }
    for (
      const [label, digest] of [
        ["source", file.sourceSha256],
        ["before-adaptation", file.destinationSha256BeforeAdaptation],
        ["after-adaptation", file.destinationSha256AfterAdaptation],
      ] as const
    ) {
      if (!/^[0-9a-f]{64}$/u.test(digest)) {
        errors.push(`invalid ${label} SHA-256: ${file.sourcePath}`);
      }
    }
    if (
      file.destinationSha256BeforeAdaptation !== file.sourceSha256
    ) {
      errors.push(`mechanical import byte drift: ${file.sourcePath}`);
    }
    const invalidAdaptations = file.adaptations.filter(
      (adaptation) => !allowedAdaptations.has(adaptation),
    );
    for (const adaptation of invalidAdaptations) {
      errors.push(`invalid adaptation ${adaptation}: ${file.sourcePath}`);
    }
    for (const adaptation of duplicateValues(file.adaptations)) {
      errors.push(`duplicate adaptation ${adaptation}: ${file.sourcePath}`);
    }
    if (
      file.adaptations.length === 0
      && (
        file.destinationSha256AfterAdaptation !== file.sourceSha256
        || (
          file.sourcePath.startsWith(
            "packages/lattice-crypto/tests/",
          )
          && file.destinationPath !== file.sourcePath
        )
      )
    ) {
      errors.push(`unaccounted final adaptation: ${file.sourcePath}`);
    } else if (
      file.adaptations.length > 0
      && file.destinationSha256AfterAdaptation === file.sourceSha256
      && !(
        file.sourcePath.startsWith("packages/lattice-crypto/tests/")
        && file.destinationPath !== file.sourcePath
      )
    ) {
      errors.push(`declared adaptation changed no bytes: ${file.sourcePath}`);
    }

    const packagePath = file.destinationPath.startsWith(
      `${packageRelativePath}/`,
    )
      ? file.destinationPath.slice(packageRelativePath.length + 1)
      : "";
    if (
      exactRelativePath(file.destinationPath)
      && historicalEvidenceFiles.has(packagePath)
    ) {
      const destination = join(repoRoot, file.destinationPath);
      if (!existsSync(destination)) {
        errors.push(`missing historical import evidence: ${file.destinationPath}`);
      } else {
        const actual = sha256(readFileSync(destination));
        if (actual !== file.destinationSha256AfterAdaptation) {
          errors.push(
            `historical import evidence byte drift: ${file.destinationPath} `
            + `expected ${file.destinationSha256AfterAdaptation}, received ${actual}`,
          );
        }
      }
    }
  }

  const actualSourceFingerprint = sourceManifestFingerprint(files);
  if (actualSourceFingerprint !== options.expectedSourceManifestSha256) {
    errors.push(
      `pinned source manifest drift: expected `
      + `${options.expectedSourceManifestSha256}, received ${actualSourceFingerprint}`,
    );
  }

  const accountedDestinations = new Set(
    files.map((file) => file.destinationPath),
  );
  const generatedFiles = parsed.generatedFiles;
  if (Array.isArray(generatedFiles)) {
    for (const [index, generated] of generatedFiles.entries()) {
      if (!isRecord(generated)) {
        errors.push(`generated file ${index} must be an object`);
        continue;
      }
      if (!exactRelativePath(generated.destinationPath)) {
        errors.push(`generated file ${index} has invalid destinationPath`);
        continue;
      }
      if (
        !generated.destinationPath.startsWith(`${packageRelativePath}/`)
      ) {
        errors.push(
          `generated file must live in lattice-crypto: `
          + `${generated.destinationPath}`,
        );
      }
      const digest = generated.destinationSha256 ?? generated.sha256;
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
        errors.push(
          `generated file ${generated.destinationPath} has invalid SHA-256`,
        );
        continue;
      }
      if (
        typeof generated.reason !== "string"
        || generated.reason.trim().length === 0
      ) {
        errors.push(`generated file ${generated.destinationPath} needs a reason`);
      }
      if (accountedDestinations.has(generated.destinationPath)) {
        errors.push(
          `destination represented more than once: ${generated.destinationPath}`,
        );
      }
      accountedDestinations.add(generated.destinationPath);
      const packagePath = generated.destinationPath.startsWith(
        `${packageRelativePath}/`,
      )
        ? generated.destinationPath.slice(packageRelativePath.length + 1)
        : "";
      if (historicalEvidenceFiles.has(packagePath)) {
        const destination = join(repoRoot, generated.destinationPath);
        if (!existsSync(destination)) {
          errors.push(
            `missing historical generated evidence: ${generated.destinationPath}`,
          );
        } else if (sha256(readFileSync(destination)) !== digest) {
          errors.push(
            `historical generated evidence byte drift: ${generated.destinationPath}`,
          );
        }
      }
    }
  }

  const workspaceAdaptations = parsed.workspaceAdaptations;
  if (Array.isArray(workspaceAdaptations)) {
    for (const [index, adaptation] of workspaceAdaptations.entries()) {
      if (!isRecord(adaptation)) {
        errors.push(`workspace adaptation ${index} must be an object`);
        continue;
      }
      if (!exactRelativePath(adaptation.destinationPath)) {
        errors.push(`workspace adaptation ${index} has invalid destinationPath`);
        continue;
      }
      if (
        adaptation.destinationPath === packageRelativePath
        || adaptation.destinationPath.startsWith(`${packageRelativePath}/`)
      ) {
        errors.push(
          `workspace adaptation points inside imported package: `
          + `${adaptation.destinationPath}`,
        );
      }
      if (
        !Array.isArray(adaptation.adaptations)
        || adaptation.adaptations.length === 0
        || adaptation.adaptations.some(
          (reason) => typeof reason !== "string" || reason.trim().length === 0,
        )
      ) {
        errors.push(
          `workspace adaptation ${adaptation.destinationPath} needs adaptations`,
        );
      }
      const digest = adaptation.destinationSha256AfterAdaptation;
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
        errors.push(
          `workspace adaptation ${adaptation.destinationPath} has invalid `
          + "after-adaptation SHA-256",
        );
      }
    }
  }

  const evidence = parsed.sourceRootEvidence;
  if (!Array.isArray(evidence)) {
    errors.push("import provenance must contain a sourceRootEvidence array");
  } else {
    if (evidence.length !== 1) {
      errors.push(
        `sourceRootEvidence drift: expected 1 entry, received ${evidence.length}`,
      );
    }
    const expectedRootLock = options.expectedRootLock;
    const rootLock = evidence.find(
      (entry) =>
        isRecord(entry) && entry.sourcePath === expectedRootLock.sourcePath,
    );
    if (!isRecord(rootLock)) {
      errors.push("missing pinned source-root bun.lock evidence");
    } else {
      for (const [field, expected] of Object.entries(expectedRootLock)) {
        if (rootLock[field] !== expected) {
          errors.push(
            `source-root bun.lock ${field} drift: expected ${String(expected)}, `
            + `received ${String(rootLock[field])}`,
          );
        }
      }
      if (!exactRelativePath(rootLock.destinationPath)) {
        errors.push("source-root bun.lock has invalid destinationPath");
      } else if (
        !rootLock.destinationPath.startsWith(
          `${packageRelativePath}/provenance/`,
        )
      ) {
        errors.push(
          "source-root bun.lock evidence must live in lattice-crypto/provenance",
        );
      } else {
        if (accountedDestinations.has(rootLock.destinationPath)) {
          errors.push(
            `destination represented more than once: `
            + `${rootLock.destinationPath}`,
          );
        }
        accountedDestinations.add(rootLock.destinationPath);
        const destination = join(repoRoot, rootLock.destinationPath);
        if (!existsSync(destination)) {
          errors.push(
            `missing source-root evidence: ${rootLock.destinationPath}`,
          );
        } else {
          const bytes = readFileSync(destination);
          if (bytes.byteLength !== expectedRootLock.sourceSize) {
            errors.push("source-root bun.lock size drift");
          }
          if (sha256(bytes) !== expectedRootLock.sourceSha256) {
            errors.push("source-root bun.lock byte drift");
          }
        }
      }
    }
  }

  return [...new Set(errors)].sort();
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (
      const entry of readdirSync(directory, {
        withFileTypes: true,
      }).sort((left, right) => left.name.localeCompare(right.name))
    ) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile()
        && !ignoredGeneratedFiles.has(entry.name)
      ) files.push(path);
    }
  };
  visit(root);
  return files;
}

function relativeFrom(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function staleKentaurosPrefixes(coreRoot: string): string[] {
  if (!existsSync(coreRoot)) return ["missing packages/lattice-crypto"];
  const errors: string[] = [];
  for (const path of walkFiles(coreRoot)) {
    const packagePath = relativeFrom(coreRoot, path);
    if (historicalEvidenceFiles.has(packagePath)) continue;
    const contents = readFileSync(path).toString("utf8");
    const matchIndex = contents.toLowerCase().indexOf("kentauros");
    if (matchIndex < 0) continue;
    const line = contents.slice(0, matchIndex).split("\n").length;
    errors.push(`${packageRelativePath}/${packagePath}:${line}`);
  }
  return errors.sort();
}

function moduleSpecifiersFromContents(path: string, contents: string): string[] {
  const scriptKind = [".tsx", ".jsx"].includes(extname(path))
    ? ts.ScriptKind.TSX
    : [".js", ".jsx", ".mjs", ".cjs"].includes(extname(path))
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const values: string[] = [];
  const addLiteral = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) values.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (
          ts.isIdentifier(node.expression)
          && node.expression.text === "require"
        )
      )
    ) {
      addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

function moduleSpecifiers(path: string): string[] {
  return moduleSpecifiersFromContents(path, readFileSync(path, "utf8"));
}

/**
 * The product-consumer invariant only reports string-literal module specifiers
 * that name lattice-crypto. Avoid constructing a TypeScript AST for the many
 * ordinary product source files that cannot possibly produce such a report.
 * This is deliberately a byte-level prefilter, not a narrower source scope:
 * every supported source file is still read and a matching literal is scanned
 * by TypeScript's syntax-only module preprocessor. That scanner covers static
 * imports/exports, import-equals, CommonJS require, and dynamic import without
 * constructing a full AST.
 */
function latticeCryptoModuleSpecifiers(path: string): string[] {
  const contents = readFileSync(path, "utf8");
  return contents.includes("lattice-crypto")
    ? ts.preProcessFile(contents, true, true).importedFiles.map((reference) =>
      reference.fileName
    )
    : [];
}

function hasLatticeCryptoReference(path: string): boolean {
  return readFileSync(path, "utf8").includes("lattice-crypto");
}

type PackageReference = {
  readonly name: string;
  readonly target: string;
};

function dependencyReferences(packageJsonPath: string): PackageReference[] {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  return [
    parsed.dependencies,
    parsed.devDependencies,
    parsed.optionalDependencies,
    parsed.peerDependencies,
  ].flatMap((dependencies) =>
    Object.entries(dependencies ?? {}).map(([name, target]) => ({
      name,
      target,
    }))
  );
}

function nestedStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStringValues);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(nestedStringValues);
}

function packageImportReferences(
  packageJsonPath: string,
): PackageReference[] {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    imports?: unknown;
  };
  if (!isRecord(parsed.imports)) return [];
  return Object.entries(parsed.imports).flatMap(([name, target]) =>
    nestedStringValues(target).map((value) => ({ name, target: value }))
  );
}

function tsconfigPathReferences(
  tsconfigPath: string,
): PackageReference[] {
  const parsedResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (parsedResult.error) {
    throw new TypeError(`invalid tsconfig: ${tsconfigPath}`);
  }
  const parsed = parsedResult.config as {
    compilerOptions?: { paths?: unknown };
  };
  const paths = parsed.compilerOptions?.paths;
  if (!isRecord(paths)) return [];
  return Object.entries(paths).flatMap(([name, target]) =>
    nestedStringValues(target).map((value) => ({ name, target: value }))
  );
}

function coreProductImports(coreRoot: string): string[] {
  if (!existsSync(coreRoot)) return ["missing packages/lattice-crypto"];
  const violations: string[] = [];
  for (const path of walkFiles(coreRoot)) {
    const packagePath = relativeFrom(coreRoot, path);
    const extension = extname(path);
    if (sourceExtensions.has(extension)) {
      for (const specifier of moduleSpecifiers(path)) {
        if (
          specifier.startsWith("@nautilo/")
          && !(
            specifier === "@nautilo/lattice-crypto"
            || specifier.startsWith("@nautilo/lattice-crypto/")
          )
        ) {
          violations.push(
            `${packageRelativePath}/${packagePath} -> ${specifier}`,
          );
        }
      }
    }
    if (basename(path) === "package.json") {
      for (const dependency of dependencyReferences(path)) {
        if (
          dependency.name.startsWith("@nautilo/")
          || dependency.target.includes("@nautilo/")
        ) {
          violations.push(
            `${packageRelativePath}/${packagePath} dependency `
              + `${dependency.name} -> ${dependency.target}`,
          );
        }
      }
    }
  }
  return violations.sort();
}

function isLatticeCryptoConsumer(specifier: string): boolean {
  return specifier === "@nautilo/lattice-crypto"
    || specifier.startsWith("@nautilo/lattice-crypto/")
    || specifier === "@kentauros/lattice-crypto"
    || specifier.startsWith("@kentauros/lattice-crypto/")
    || /(?:^|[/])(?:packages[/])?lattice-crypto(?:[/]|$)/u.test(specifier);
}

function isLatticeCryptoTarget(value: string): boolean {
  return isLatticeCryptoConsumer(value)
    || /@(?:nautilo|kentauros)\/lattice-crypto(?:[/@]|$)/u.test(value)
    || /(?:^|[:/])(?:packages\/)?lattice-crypto(?:[/@]|$)/u.test(value);
}

function auditProductConsumerPath(
  path: string,
  repoRoot: string,
  violations: string[],
): void {
  const repositoryPath = relativeFrom(repoRoot, path);
  if (
    repositoryPath === packageRelativePath
    || repositoryPath.startsWith(`${packageRelativePath}/`)
  ) {
    return;
  }
  if (sourceExtensions.has(extname(path))) {
    for (const specifier of latticeCryptoModuleSpecifiers(path)) {
      if (isLatticeCryptoConsumer(specifier)) {
        if (
          repositoryPath.startsWith(`${bridgeRelativePath}/`)
          && (
            specifier === "@nautilo/lattice-crypto"
            || (
              specifier === "@nautilo/lattice-crypto/wire"
              && (
                repositoryPath.startsWith(
                  `${bridgeRelativePath}/src/`,
                )
                || repositoryPath.startsWith(
                  `${bridgeRelativePath}/tests/`,
                )
              )
            )
            || (
              specifier === "@nautilo/lattice-crypto/testing"
              && (
                repositoryPath.startsWith(
                  `${bridgeRelativePath}/src/testing/`,
                )
                || repositoryPath.startsWith(
                  `${bridgeRelativePath}/tests/`,
                )
              )
            )
          )
        ) {
          continue;
        }
        violations.push(`${repositoryPath} -> ${specifier}`);
      }
    }
  }
  if (basename(path) === "package.json" && hasLatticeCryptoReference(path)) {
    for (const dependency of dependencyReferences(path)) {
      if (
        isLatticeCryptoTarget(dependency.name)
        || isLatticeCryptoTarget(dependency.target)
      ) {
        if (
          repositoryPath === `${bridgeRelativePath}/package.json`
          && dependency.name === "@nautilo/lattice-crypto"
          && dependency.target === "workspace:*"
        ) {
          continue;
        }
        violations.push(
          `${repositoryPath} dependency ${dependency.name} -> `
            + dependency.target,
        );
      }
    }
    for (const reference of packageImportReferences(path)) {
      if (isLatticeCryptoTarget(reference.target)) {
        violations.push(
          `${repositoryPath} import alias ${reference.name} -> `
            + reference.target,
        );
      }
    }
  }
  if (
    /^tsconfig(?:\..+)?\.json$/u.test(basename(path))
    && hasLatticeCryptoReference(path)
  ) {
    for (const reference of tsconfigPathReferences(path)) {
      if (isLatticeCryptoTarget(reference.target)) {
        violations.push(
          `${repositoryPath} path alias ${reference.name} -> `
            + reference.target,
        );
      }
    }
  }
}

function productConsumerImports(repoRoot: string): string[] {
  const violations: string[] = [];
  const productRoots = [
    "apps",
    "bin",
    "deploy",
    "infra",
    "native",
    "ops",
    "packages",
    "packaging",
  ];
  for (const rootName of productRoots) {
    const root = join(repoRoot, rootName);
    for (const path of walkFiles(root)) {
      const repositoryPath = relativeFrom(repoRoot, path);
      if (repositoryPath.startsWith("packaging/docker/runtime-install/")) {
        // D490's checked-in install projection duplicates reviewed source
        // manifests; source ownership remains with the canonical workspace.
        continue;
      }
      auditProductConsumerPath(path, repoRoot, violations);
    }
  }
  for (
    const entry of readdirSync(repoRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
  ) {
    if (!entry.isFile()) continue;
    if (
      entry.name === "package.json"
      || /^tsconfig(?:\..+)?\.json$/u.test(entry.name)
      || /^nautilo(?:\..+)?\.config\.(?:[cm]?[jt]s)$/u.test(entry.name)
    ) {
      auditProductConsumerPath(join(repoRoot, entry.name), repoRoot, violations);
    }
  }
  return violations.sort();
}

const reviewedCryptoProductConsumerInventory = [
  // Protected approval recovery composes the canonical decrypt-only foreground
  // grant and checkpoint capsule APIs; it introduces no alternate crypto store.
  // Wire decoding validates publication receipts before dispatch, while these
  // exact fixtures exercise real signatures, capsule binding and zeroization.
  "packages/server/src/messaging/decode-prepared-message.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/foreground-checkpoint-read-authority.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/foreground-checkpoint-read-authority.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/foreground-memory-projection-capsule.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/foreground-pending-attention.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit-isolated/foreground-memory-projection-resume.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/decode-prepared-message.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/foreground-checkpoint-read-authority.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/foreground-checkpoint-read-authority.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/tests/unit/foreground-memory-projection-capsule.test.ts -> @nautilo/lattice-crypto",
  // M313 — request schemas and route admission derive their bounds from the
  // provider-free wire limits. Server composition supplies the crypto verifier
  // and signed-request lifetime to bridge-owned admission; device keys stay in
  // client custody. Exact test fixtures exercise signing, custody and races.
  "packages/api-client/src/schemas/message-backfill.ts -> @nautilo/lattice-crypto/wire-limits",
  "packages/api-client/tests/unit/message-backfill-methods-contract.test.ts -> @nautilo/lattice-crypto/wire-limits",
  "packages/server/src/routes/message-backfill-composition.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/message-backfill-composition.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/message-backfill.ts -> @nautilo/lattice-crypto/wire-limits",
  "packages/server/tests/integration/helpers/message-backfill-custody.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/integration/helpers/message-backfill-runtime-race.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/integration/helpers/message-backfill-runtime-race.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> @nautilo/lattice-crypto",
  // M314 Full-mode membership QA signs real device admission; no product-route bypass.
  "packages/server/tests/integration/ws/rooms-join-ws.integration.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/message-backfill-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/message-backfill-route.test.ts -> @nautilo/lattice-crypto/wire-limits",
  // M320 — API schemas reuse the provider-free wire-limits surface's canonical byte
  // and inventory limits. Tests pin those exact derived admission boundaries;
  // neither API production module performs crypto or imports the root surface.
  "packages/api-client/package.json dependency @nautilo/lattice-crypto -> workspace:*",
  "packages/api-client/src/schemas/human-memory-read-observation.ts -> @nautilo/lattice-crypto/wire-limits",
  "packages/api-client/src/schemas/protected-memory.ts -> @nautilo/lattice-crypto/wire-limits",
  "packages/api-client/tests/unit/human-memory-read-observation.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/api-client/tests/unit/protected-memory-schema.test.ts -> @nautilo/lattice-crypto/wire",
  // M320 — foreground Domain Memory Runtime owns invocation-scoped plaintext
  // crypto and exact-access adaptation. Its unit tests exercise real signing,
  // envelopes, zeroization, and fail-closed authority behavior.
  "packages/runtime/src/memory/foreground-domain-memory-crypto-session.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/memory/foreground-domain-memory-exact-access.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/memory/foreground-domain-memory-exact-access.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/unit/foreground-domain-memory-crypto-session.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/foreground-domain-memory-crypto-session.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/unit/foreground-domain-memory-exact-access.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/foreground-domain-memory-exact-access.test.ts -> @nautilo/lattice-crypto/wire",
  // M320 — Server routes compose Human Memory verification and foreground
  // Runtime ports. Device secrets remain client-side or Runtime-scoped; the
  // conformance fixtures use real crypto to prove the same production seams.
  "packages/server/src/routes/foreground-memory-repository.ts -> @nautilo/lattice-crypto",
  // Exact native Namespace authority records use the versioned wire subpath.
  "packages/server/src/routes/foreground-memory-repository.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/human-memory-exact-access-services.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/human-memory-read-observations.ts -> @nautilo/lattice-crypto",
  // The receipt issuer derives its lifetime from the signed read-ACK codec.
  "packages/server/src/routes/human-memory-read-observations.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/human-memory-repair-services.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/human-memory-repair-services.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/human-memory-request-services.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/helpers/protected-memory-foreground-conformance.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit-isolated/memory-routes.test.ts -> @nautilo/lattice-crypto",
  // M311 — invocation-scoped repair adapters and server composition consume
  // public crypto types; publication/verification remains in lattice-bridge.
  // Exact test consumers exercise real signing, envelopes, and checkpoints.
  "packages/agent/tests/unit/encrypted-checkpoint-saver.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/conversation/foreground-journal-history-repair.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/conversation/foreground-memory-history-repair.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/conversation/foreground-record-history-repair.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/foreground-journal-history-repair.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/foreground-journal-history-repair.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/unit/foreground-memory-history-repair.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/foreground-memory-history-repair.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/unit/foreground-record-history-repair.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/foreground-record-history-repair.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/foreground-agent-entity-crypto-gateway.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/foreground-agent-entity-crypto-gateway.test.ts -> @nautilo/lattice-crypto",
  // M304 PR 1 — the server composition layer verifies and applies the
  // Human-device MLS transition through the reviewed lattice-crypto API. DB
  // persistence remains owned by lattice-bridge's server repositories.
  "packages/server/src/routes/human-device-membership-composition.ts -> @nautilo/lattice-crypto",
  // M257 — the dormant Reflection bridge is the reviewed product integration
  // owner for protected Record publication. No Runtime or Server caller is
  // activated in this wave.
  "packages/reflection-bridge/package.json dependency @nautilo/lattice-crypto -> workspace:*",
  "packages/reflection-bridge/src/server/protected-record-crypto.ts -> @nautilo/lattice-crypto",
  "packages/reflection-bridge/src/server/protected-record-crypto.ts -> @nautilo/lattice-crypto/wire",
  // M258 — the same dormant bridge owner repackages byte-identical Record
  // payloads when a protected authority projection generation changes.
  "packages/reflection-bridge/src/server/protected-authority-republisher.ts -> @nautilo/lattice-crypto",
  "packages/reflection-bridge/src/server/protected-authority-republisher.ts -> @nautilo/lattice-crypto/wire",
  "packages/reflection-bridge/tests/unit/protected-record-crypto.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/package.json dependency @nautilo/lattice-crypto -> workspace:*",
  "packages/runtime/src/protected-execution/background-authorization/processor-credential-claim-port.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/src/stenographer/postgres-protected-stenographer-work-recovery.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/src/stenographer/protected-journal-output-planner.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/protected-source-loader.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/src/stenographer/protected-stenographer-compaction.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/protected-stenographer-extraction.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/protected-stenographer-work-composition.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/protected-stenographer-work-composition.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/integration/wave-10-background-encryption-scenario.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/integration/wave-10-background-encryption-scenario.test.ts -> @nautilo/lattice-crypto/testing",
  "packages/runtime/tests/integration/wave-10-background-encryption-scenario.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/unit/background-authorization-processor-credential-claim-port.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/postgres-protected-stenographer-work-recovery.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/unit/protected-agent-memory-background.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/protected-stenographer-compaction.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/protected-stenographer-extraction.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/protected-stenographer-work-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/protected-stenographer-work-composition.test.ts -> @nautilo/lattice-crypto/testing",
  "packages/runtime/tests/unit/protected-stenographer-work-composition.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/tests/unit/stenographer-protected-source-loader.test.ts -> @nautilo/lattice-crypto",
  // M282 — reviewed Browser live-shadow production composition. The Server
  // owns current authority and the Runtime owns the turn-scoped crypto
  // consumer; neither receives device private keys.
  "packages/server/package.json dependency @nautilo/lattice-crypto -> workspace:*",
  "packages/server/src/routes/live-shadow-message-composition.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/live-shadow-message-composition.ts -> @nautilo/lattice-crypto/wire",
  // M294 — this boundary test mints a real device-signed reusable foreground
  // authorization to exercise the Server session registry end to end.
  "packages/server/tests/unit/live-shadow-foreground-authorization-sessions.test.ts -> @nautilo/lattice-crypto",
  // M275 — Browser Room-history reconciliation verifies a signed, content-free
  // result acknowledgement. Restricted device-key reads remain bridge-owned.
  "packages/server/src/routes/room-history-shadow-read-composition.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/room-history-shadow-read-composition.ts -> @nautilo/lattice-crypto/wire",
  // M295 — the Human-only dispatch path decodes the authenticated Human-peer
  // plan and derives the durable event digest without receiving device private
  // keys. Its isolated HTTP test builds the same exact protected wire bytes.
  "packages/server/src/messaging/dispatch.ts -> @nautilo/lattice-crypto",
  "packages/server/src/messaging/dispatch.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/tests/unit-isolated/messaging-route-http.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit-isolated/messaging-route-http.test.ts -> @nautilo/lattice-crypto/wire",
  // Full dispatch fixtures use deterministic crypto, and the composition
  // contract encodes real plans; neither introduces a production consumer.
  "packages/server/tests/unit-isolated/messaging-route-http.test.ts -> @nautilo/lattice-crypto/testing",
  "packages/server/tests/unit/live-shadow-message-composition-policy.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/live-shadow-message-composition-policy.test.ts -> @nautilo/lattice-crypto/wire",
  // M317 — the portable responder and Stenographer recovery path consume the
  // narrow background surface. Lattice retains grant opening, current-authority
  // verification, protected input/output crypto and secret destruction. Runtime
  // and Server compose product intent, persistence and publication; exact tests
  // exercise those same seams. Reflection and Memory activation remain deferred.
  "packages/lattice-bridge/src/client/background/background-authorization-sweep-v2.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/client/background/device-authorization-responder-v2.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/client/message/foreground-shadow-client-composition.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/device/background-authorization-responder.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/device/background-authorization-transport.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/journal/stenographer-ordinary-output-provenance.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/journal/stenographer-ordinary-output-provenance.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/journal/stenographer-output-repair-plan.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/current-stenographer-authority.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/postgres-journal-crypto-tombstone.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/postgres-processor-transform-commit-verifier.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/postgres-protected-journal-processor-object-verifier.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/postgres-stenographer-fallback-selection.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/postgres-stenographer-output-repair.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/stenographer-data-operation.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/storage/postgres-current-processor-reconciliation-input.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/storage/postgres-current-processor-signer-authorization.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/storage/postgres-current-processor-transform-object-port.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/storage/postgres-object-access-manifest-v5.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/helpers/current-processor-certificate-v2.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/integration/postgres-readable-namespace-lock-order.integration.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/integration/wave-10-background-postgres.integration.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/device-authorization-responder-v2.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/foreground-background-authorization-client-v2.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-current-journal-v5-chain.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-current-processor-reconciliation-input.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-current-processor-transform-object-port.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-processor-transform-commit-verifier.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-protected-journal-processor-object-verifier.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-stenographer-fallback-selection.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/stenographer-ordinary-sibling-authority.test.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/protected-execution/background-authorization/repository.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/current-stenographer-output-repair.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/current-stenographer-output-repair.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/current-stenographer-publication-reconciliation.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/current-stenographer-publication-reconciliation.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/current-stenographer-publication-reconciliation.ts -> @nautilo/lattice-crypto/wire",
  "packages/runtime/src/stenographer/postgres-protected-stenographer-work-recovery.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/protected-journal-output-planner.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/protected-publication-repository.ts -> @nautilo/lattice-crypto",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/protected-stenographer-publication-reconciliation.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/stenographer/protected-stenographer-work-composition.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/tests/integration/m317-output-repair.integration.test.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/tests/unit/background-authorization-repository.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/background-authorization-repository.test.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/tests/unit/current-stenographer-output-repair.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/current-stenographer-output-repair.test.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/tests/unit/protected-stenographer-work-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/protected-stenographer-work-composition.test.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/tests/unit/protected-stenographer-work-composition.test.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/app.ts -> @nautilo/lattice-crypto",
  "packages/server/src/app.ts -> @nautilo/lattice-crypto/background",
  "packages/server/src/background/stenographer-composition.ts -> @nautilo/lattice-crypto",
  "packages/server/src/background/stenographer-composition.ts -> @nautilo/lattice-crypto/background",
  "packages/server/src/background/stenographer-output-repair-composition.ts -> @nautilo/lattice-crypto",
  "packages/server/src/background/stenographer-output-repair-composition.ts -> @nautilo/lattice-crypto/background",
  "packages/server/src/background/stenographer-output-repair-composition.ts -> @nautilo/lattice-crypto/wire",
  "packages/server/src/routes/background-authorization-composition.ts -> @nautilo/lattice-crypto",
  "packages/server/src/routes/background-authorization-composition.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/background-authorization-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/background-authorization-composition.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/stenographer-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/stenographer-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/stenographer-composition.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/stenographer-output-repair-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/stenographer-output-repair-composition.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/stenographer-output-repair-composition.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/stenographer-output-repair-composition.test.ts -> @nautilo/lattice-crypto/wire",
  // M327 — Lattice's Reflection implementation consumes only V2 semantic descriptor types
  // and protocol limits from Lattice's background surface. Server recovery
  // names the verified reconciliation binding as type-only metadata; focused
  // fixtures exercise these exact seams without moving crypto ownership.
  "packages/lattice-bridge/src/server/reflection/postgres-semantic-plan.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/protected-message-metadata.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/protected-organizer-metadata.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/protected-search-projection.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/protected-semantic-questions.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/semantic-operation.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-reflection-semantic-plan.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/src/reflection/attach-semantic-recovery.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/attach-semantic-recovery.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/reflection-semantic-commit-settlement.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/reflection-semantic-lifecycle.test.ts -> @nautilo/lattice-crypto/background",
  "packages/api-client/src/schemas/background-authorization.ts -> @nautilo/lattice-crypto/background",
  "packages/db/tests/unit/m327-background-reflection-carrier-schema.test.ts -> ../../../lattice-crypto/src/background/processor-authorization-v2.ts",
  "packages/db/tests/unit/m327-background-reflection-carrier-schema.test.ts -> ../../../lattice-crypto/src/background/work-descriptor-v2.ts",
  "packages/lattice-bridge/src/server/delivery/postgres-namespace-product-authority.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/journal/current-reflection-authority.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/postgres-authority-object-port.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/postgres-authority-plan.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/reflection/postgres-authority-recovery.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/src/server/storage/postgres-current-processor-running-request.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/background-authorization-sweep-v2.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/current-reflection-authority.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-reflection-authority-object-port.test.ts -> @nautilo/lattice-crypto/background",
  "packages/lattice-bridge/tests/unit/postgres-reflection-authority-plan.test.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/src/protected-execution/background-authorization/prepare-processor-recipient.ts -> @nautilo/lattice-crypto",
  "packages/runtime/tests/unit/postgres-background-authorization-repository.test.ts -> @nautilo/lattice-crypto/background",
  "packages/runtime/tests/unit/prepare-processor-recipient.test.ts -> @nautilo/lattice-crypto",
  "packages/server/src/reflection/protected-authority-composition.ts -> @nautilo/lattice-crypto",
  "packages/server/src/reflection/protected-authority-composition.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/unit/reflection-authority-composition.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/unit/reflection-authority-composition.test.ts -> @nautilo/lattice-crypto/background",
  // Real device/processor/foreground integration proof against an isolated clone.
  "packages/server/tests/lattice-integration/m327-protected-reflection-composition.integration.test.ts -> @nautilo/lattice-crypto",
  "packages/server/tests/lattice-integration/m327-protected-reflection-composition.integration.test.ts -> @nautilo/lattice-crypto/background",
  "packages/server/tests/lattice-integration/m327-protected-reflection-composition.integration.test.ts -> @nautilo/lattice-crypto/wire",
] as const;

const allowedReviewedCryptoProductConsumers = new Set(
  reviewedCryptoProductConsumerInventory,
);

function isLatticeBridgeConsumer(specifier: string): boolean {
  return specifier === "@nautilo/lattice-bridge"
    || specifier.startsWith("@nautilo/lattice-bridge/")
    || /(?:^|[/])(?:packages[/])?lattice-bridge(?:[/]|$)/u.test(specifier);
}

function isLatticeBridgeTarget(value: string): boolean {
  return isLatticeBridgeConsumer(value)
    || /@nautilo\/lattice-bridge(?:[/@]|$)/u.test(value)
    || /(?:^|[:/])(?:packages\/)?lattice-bridge(?:[/@]|$)/u.test(value);
}

const reviewedBridgeProductConsumerInventory = [
  // Real admitted-device, storage, and foreground integration proof.
  "packages/server/tests/lattice-integration/m327-protected-reflection-composition.integration.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/lattice-integration/m327-protected-reflection-composition.integration.test.ts -> @nautilo/lattice-bridge/client/background",
  "packages/server/tests/lattice-integration/m327-protected-reflection-composition.integration.test.ts -> @nautilo/lattice-bridge/server",
  // Sharing continuation uses provider-free bridge contracts/errors. Server
  // recovery composes the existing protected checkpoint and recipient owners;
  // its exact server-side fixtures verify these boundaries without new stores.
  "packages/agent/src/tools/memory/projection-sharing.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit-isolated/protected-checkpoint-resume.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/friendly-errors.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/protected-memory-projection-continuation.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/tools-lifecycle-events.test.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-checkpoint-read-authority.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-checkpoint-read-authority.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/foreground-memory-projection-capsule.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-pending-attention.ts -> @nautilo/lattice-bridge/server",
  // Human-only recovery tests construct the service's recipient registry;
  // they stop before checkpoint/crypto lookup and never open database pools.
  "packages/server/tests/unit-isolated/foreground-pending-attention-human-chat.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/foreground-memory-access-object-type.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit-isolated/foreground-memory-access-object-type.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/foreground-memory-projection-resume.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit-isolated/foreground-memory-projection-resume.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/foreground-checkpoint-read-authority.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/foreground-checkpoint-read-authority.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/foreground-memory-projection-capsule.test.ts -> @nautilo/lattice-bridge",
  // M313 — Workbench schedules the Browser facade; server composition binds
  // bridge-owned discovery, authority and publication to admitted requests.
  // Integration-only internal adapters reproduce device vault custody and
  // exact production reads with synthetic keys; they expose no product API.
  "apps/workbench/src/adapters/message-backfill-scheduler.ts -> @nautilo/lattice-bridge/client/browser",
  "apps/workbench/tests/unit/message-backfill-scheduler.test.ts -> @nautilo/lattice-bridge/client/browser",
  "apps/workbench/tests/unit/mounted-key-waiting-history-retry.test.ts -> @nautilo/lattice-bridge/client/browser",
  "apps/workbench/tests/unit/room-history-data-adapter.test.ts -> @nautilo/lattice-bridge",
  "apps/workbench/tests/unit/room-history-data-adapter.test.ts -> @nautilo/lattice-bridge/client/browser",
  "packages/server/src/routes/message-backfill-composition.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/message-backfill-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/integration/helpers/message-backfill-custody.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/integration/helpers/message-backfill-runtime-race.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/integration/helpers/message-backfill-runtime-race.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client-vault/domain-key-cache-v2.ts",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client-vault/namespace-generation-cache-v1.ts",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client-vault/profile-v2.ts",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client-vault/profile-v4.ts",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client-vault/types.ts",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client/message/domain-key-authority-client.ts",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client/message/domain-namespace-authority-adapter",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client/message/domain-namespace-authority-client.ts",
  // M314 — server protocol integration extends the existing M313 fixture with
  // the real device client, foreground owner, and enrollment client boundaries.
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client/message/device-message-backfill-client",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client/message/foreground-shadow-client-composition",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/client/message/vault-room-history-shadow-message-reader",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/device/additional-device-client",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/server/message/message-backfill-tool-context",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> ../../../lattice-bridge/src/testing/client-profile-vault.ts",
  "packages/server/tests/integration/message-backfill.integration.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/message-backfill-composition.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/message-backfill-composition.test.ts -> @nautilo/lattice-bridge/server",
  // M314 — the Full-mode WebSocket fixture imports only the canonical bridge
  // admission codecs needed to enroll its test devices through the real gate.
  "packages/server/tests/integration/ws/rooms-join-ws.integration.test.ts -> @nautilo/lattice-bridge",
  // M321 — reviewed shared-owner bindings, typed operation failures and Browser
  // read-result DTOs. These adapters expose no raw keys or server/storage APIs;
  // their behavior tests exercise the actual owner across all four policies.
  // See docs/encryption-data-operation-ownership.md for the exact seam roles.
  "apps/desktop/electron/foreground-shadow-controller.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/adapters/room-history-data-adapter.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/adapters/room-history-data-adapter.ts -> @nautilo/lattice-bridge/client/browser",
  "apps/workbench/src/adapters/room-history-row-access.test.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/adapters/room-history-row-access.test.ts -> @nautilo/lattice-bridge/client/browser",
  "apps/workbench/src/adapters/room-history-row-access.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/adapters/room-history-row-access.ts -> @nautilo/lattice-bridge/client/browser",
  // M314 — the Room read adapter maps the shared operation failure taxonomy to
  // its existing UI outcome; its test constructs those public typed failures.
  "apps/workbench/src/adapters/room-read-outcome.test.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/adapters/room-read-outcome.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/adapters/room-message-operations.test.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/adapters/room-message-operations.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/lib/encryption-data-operation-policy.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/lib/memory-read-operations.test.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/lib/memory-read-operations.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/lib/room-message-edit.test.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/lib/room-message-edit.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/pages/memory/memory-page.tsx -> @nautilo/lattice-bridge",
  "apps/workbench/tests/unit-isolated/admission-runtime.test.tsx -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/conductor-data-operation-policy.test.ts -> @nautilo/lattice-bridge",
  // M320 — Workbench holds only the reviewed Browser custody facade; the
  // controller test proves protected create/update/read behavior without
  // exposing device keys or bridge server/storage modules to UI code.
  "apps/workbench/src/lib/protected-human-memory-controller.ts -> @nautilo/lattice-bridge/client/browser",
  "apps/workbench/src/pages/memory/memory-page.tsx -> @nautilo/lattice-bridge/client/browser",
  "apps/workbench/tests/unit/protected-human-memory-controller.test.ts -> @nautilo/lattice-bridge/client/browser",
  // M320 — Agent and Runtime consume bridge-owned Memory repository, prepared
  // crypto, exact-access, and strict-failure ports. The snapshot reader needed
  // by fake persistence is confined to the explicit test-only entry point.
  "packages/agent/src/nodes/post-model.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/executors/langgraph-executor.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/memory/foreground-domain-memory-crypto-session.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/memory/foreground-domain-memory-exact-access.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-domain-memory-crypto-session.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-domain-memory-crypto-session.test.ts -> @nautilo/lattice-bridge/testing",
  "packages/runtime/tests/unit/foreground-domain-memory-exact-access.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-protected-memory-repository.test.ts -> @nautilo/lattice-bridge",
  // M320 — Server route modules are thin authority/composition adapters over
  // bridge-owned codecs and Postgres repositories. Tests cover effect receipt,
  // publication, repair, delivery, and HTTP behavior at those exact seams.
  "packages/server/src/routes/foreground-memory-effect-receipts.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-memory-effect-receipts.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/foreground-memory-publication-authority.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-memory-publication-authority.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/foreground-memory-repository.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-memory-repository.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/human-memory-embedding-processor.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/human-memory-exact-access-services.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/human-memory-live-composition.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/human-memory-live-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/human-memory-publication-authority.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/human-memory-publication-authority.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/human-memory-read-observations.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/human-memory-read-observations.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/human-memory-repair-services.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/human-memory-repair-services.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/human-memory-request-services.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/memory.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit-isolated/domain-namespace-bundle-delivery.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/foreground-memory-repair-policy.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit-isolated/foreground-memory-repair-policy.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/human-memory-repair-services.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/memory-routes.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/foreground-memory-effect-receipts.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/foreground-memory-effect-receipts.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/foreground-memory-publication-authority.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/human-memory-publication-authority.test.ts -> @nautilo/lattice-bridge/server",
  // M311 — product adapters select context and preserve typed Strict failures;
  // bridge-owned invocation, repair, and checkpoint ports retain crypto custody.
  // Test-only snapshot readers inspect ciphertext fixtures, not production APIs.
  "packages/agent/src/agent/graph.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/recall-records.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/encrypted-checkpoint-saver.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/foreground-message-repair-source.test.ts -> @nautilo/lattice-bridge/server",
  "packages/agent/tests/unit/recall-records.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/context/build-transcript-context.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/foreground-context-preparation.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/foreground-journal-history-repair.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/foreground-journal-history-repair.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/conversation/foreground-memory-history-repair.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/foreground-memory-history-repair.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/conversation/foreground-record-history-repair.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/foreground-record-history-repair.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/conversation/live-shadow-checkpoint-saver.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/live-shadow-checkpoint-saver.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/executors/fork-langgraph-executor.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/executors/langgraph-executor.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/fixtures/foreground-context-failure-child.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/build-transcript-context.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-journal-history-repair.test.ts -> ../../../lattice-bridge/src/object/device-wrapped-agent-object-crypto",
  "packages/runtime/tests/unit/foreground-journal-history-repair.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-journal-history-repair.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/foreground-memory-history-repair.test.ts -> ../../../lattice-bridge/src/object/device-wrapped-agent-object-crypto",
  "packages/runtime/tests/unit/foreground-memory-history-repair.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-record-history-repair.test.ts -> ../../../lattice-bridge/src/object/device-wrapped-agent-object-crypto",
  "packages/runtime/tests/unit/foreground-record-history-repair.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/job-friendly-errors.test.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-agent-entity-crypto-gateway.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/foreground-agent-entity-crypto-gateway.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/foreground-message-product-store.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/foreground-agent-entity-crypto-gateway.test.ts -> @nautilo/lattice-bridge/server",
  // M280 Part 3 — reviewed production setup clients and thin HTTP/DB-handle
  // adapters. Cryptographic protocol and crypto-table ownership remain in the
  // lattice bridge; product clients own only local sealed custody and UI.
  "apps/desktop/electron/encryption-recovery-readiness.ts -> @nautilo/lattice-bridge/client/electron",
  "apps/desktop/package.json dependency @nautilo/lattice-bridge -> workspace:*",
  "apps/workbench/src/adapters/nautilo-runtime.tsx -> @nautilo/lattice-bridge/client/browser",
  // D568 — protected Done/Cancel supplies the current browser device ID via
  // the canonical bridge derivation; no key custody or protocol moves to UI.
  "apps/workbench/src/components/tool-card/renderers/connected-web-account-action.tsx -> @nautilo/lattice-bridge/client/browser",
  // M300 PR 1 — Desktop foreground Shadow parity keeps cryptographic protocol,
  // sealed custody, and API adapters inside lattice-bridge. Electron main owns
  // lifecycle/IPC containment; preload and Workbench expose only reviewed DTOs.
  "apps/desktop/electron/foreground-shadow-controller.ts -> @nautilo/lattice-bridge/client/electron",
  "apps/desktop/electron/main.ts -> @nautilo/lattice-bridge",
  "apps/desktop/electron/preload.ts -> @nautilo/lattice-bridge",
  "apps/desktop/electron/preload.ts -> @nautilo/lattice-bridge/client/browser",
  "apps/desktop/tests/unit/foreground-shadow-controller.test.ts -> @nautilo/lattice-bridge/client/electron",
  "apps/workbench/src/lib/desktop.ts -> @nautilo/lattice-bridge",
  "apps/workbench/src/lib/desktop.ts -> @nautilo/lattice-bridge/client/browser",
  // M298 — a foreground subthread is an ordinary Browser crypto device
  // consumer; authority still stays in the lattice bridge client boundary.
  "apps/workbench/src/modes/rooms/thread-drawer/surfaces/SubthreadSurface.tsx -> @nautilo/lattice-bridge/client/browser",
  // M301 PR 1 — the authenticated HTTP route is a thin product adapter over
  // the bridge-owned Domain-key authority repository and protocol factory.
  "packages/server/src/routes/domain-key-authority.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/protected-additional-device-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/protected-initial-device-readiness.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/protected-initial-device-readiness.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/protected-initial-device-readiness-route.test.ts -> @nautilo/lattice-bridge",
  // M304 PR 1 — the route composition is a thin coordinator over the
  // bridge-owned Human-device membership repositories and transaction port.
  "packages/server/src/routes/human-device-membership-composition.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/human-device-membership-composition.ts -> @nautilo/lattice-bridge/server",
  // M303 — Workbench consumes only the Browser custody/admission facade, while
  // Server routes adapt strict DTOs to bridge-owned proof and persistence
  // boundaries. No product surface receives device private keys.
  "apps/workbench/src/contexts/encryption-readiness-context.tsx -> @nautilo/lattice-bridge",
  "apps/workbench/src/contexts/encryption-readiness-context.tsx -> @nautilo/lattice-bridge/client/browser",
  "packages/server/src/routes/device-admission-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/device-admission.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/device-admission.ts -> @nautilo/lattice-bridge/server",
  // M262 — reviewed dormant Human Artifact composition. These consumers are
  // reachable only through explicit test registration; production app wiring
  // remains absent until the later activation wave.
  "apps/workbench/package.json dependency @nautilo/lattice-bridge -> workspace:*",
  "apps/workbench/tests/unit/viewer-registry.test.ts -> @nautilo/lattice-bridge/client/browser",
  "packages/server/src/routes/protected-artifact-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/protected-artifact-exact-access-target.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/protected-artifact-routes.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/protected-artifact-exact-access-target.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/protected-artifact-routes.test.ts -> @nautilo/lattice-bridge/server",
  // M257 — reviewed dormant Record crypto composition; there is no production
  // producer, reader, worker, route, or mode selector in this wave.
  "packages/reflection-bridge/package.json dependency @nautilo/lattice-bridge -> workspace:*",
  "packages/reflection-bridge/src/server/protected-record-crypto.ts -> @nautilo/lattice-bridge/server",
  "packages/reflection-bridge/tests/unit/protected-record-crypto.test.ts -> @nautilo/lattice-bridge/server",
  // M267 — native protected Stenographer publication reuses the reviewed
  // Wave-10 transform/open boundaries through the Reflection bridge owner.
  "packages/reflection-bridge/src/server/postgres-protected-stenographer-converter.ts -> @nautilo/lattice-bridge",
  "packages/reflection-bridge/src/server/protected-stenographer-record-attachment.ts -> @nautilo/lattice-bridge/server",
  "packages/reflection-bridge/tests/unit/postgres-protected-stenographer-converter.test.ts -> @nautilo/lattice-bridge",
  "packages/reflection-bridge/tests/unit/protected-stenographer-record-attachment.test.ts -> @nautilo/lattice-bridge/server",
  // M264 — the dormant Record-search bridge adapts the already-reviewed Wave
  // 15 embedding port without activating a production search caller.
  "packages/reflection-bridge/src/server/wave15-record-embedding-adapter.ts -> @nautilo/lattice-bridge",
  "packages/reflection-bridge/tests/unit/wave15-record-embedding-adapter.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/package.json dependency @nautilo/lattice-bridge -> workspace:*",
  "packages/agent/src/memory/protected-background-memory-review.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/memory/protected-background-memory-staging.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/nodes/tools.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/invocation-service.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/add-memory-to-scope.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/close-scope.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/create-scope.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/manage-memory.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/protected-memory-authority.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/protected-memory-ports.ts -> @nautilo/lattice-bridge",
  "packages/agent/src/tools/memory/search-memory.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/projection-sharing-contract.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/protected-background-memory-review.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/protected-memory-tools-node-composition.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/protected-memory-tools.test.ts -> @nautilo/lattice-bridge",
  "packages/agent/tests/unit/tool-invocation-service.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/package.json dependency @nautilo/lattice-bridge -> workspace:*",
  "packages/runtime/src/conversation/active-conversation-repository.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/protected-active-conversation-repository.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/protected-agent-message-write-coordinator.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/protected-checkpoint-saver-provider.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/protected-conversation-agent-content-authority.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/protected-conversation-agent-content-authority.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/conversation/protected-conversation-executor-io.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/protected-conversation-transcript.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/protected-execution/foreground-authorization-session.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/memory/foreground-protected-agent-memory-session.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/memory/protected-agent-scope-close-worker.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/protected-execution/lease-registry.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/protected-execution/background-authorization/repository.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/postgres-protected-stenographer-work-recovery.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/stenographer/protected-journal-agent-content-authority.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-journal-agent-content-authority.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/stenographer/protected-journal-output-planner.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-journal-reader.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-journal-rebuild-repository.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/stenographer/protected-publication-repository.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/stenographer/protected-source-loader.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-stenographer-compaction-planner.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-stenographer-publication-reconciliation.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/stenographer/protected-stenographer-work-composition.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-stenographer-work-repository.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/integration/wave-10-background-encryption-scenario.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/integration/wave-10-background-encryption-scenario.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/background-authorization-repository.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-authorization-session.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/foreground-protected-agent-memory-session.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/postgres-background-authorization-repository.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/postgres-background-authorization-repository.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/postgres-protected-stenographer-work-recovery.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/protected-agent-memory-background.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-active-conversation-repository.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-agent-conversation-vertical-slice.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-agent-conversation-vertical-slice.test.ts -> @nautilo/lattice-bridge/testing",
  "packages/runtime/tests/unit/protected-agent-message-write-coordinator.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-checkpoint-saver-provider.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-conversation-agent-content-authority.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-foreground-journal-reader.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-invocation-lease-registry.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-journal-agent-content-authority.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/protected-journal-publication-repository.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/protected-journal-rebuild-repository.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/protected-stenographer-compaction.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-stenographer-extraction.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-stenographer-work-composition.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-stenographer-work-repository.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/stenographer-protected-source-loader.test.ts -> @nautilo/lattice-bridge",
  // M268 — the unified foreground Memory conformance assembler is test-only;
  // production registration remains absent until the transition wave.
  "packages/server/package.json dependency @nautilo/lattice-bridge -> workspace:*",
  "packages/server/src/routes/protected-memory-exact-access-target.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/helpers/protected-memory-foreground-conformance.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/helpers/protected-memory-foreground-conformance.ts -> @nautilo/lattice-bridge/testing",
  "packages/server/tests/unit-isolated/memory-routes.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/memory-routes.test.ts -> @nautilo/lattice-bridge/testing",
  "packages/server/tests/unit-isolated/protected-memory-exact-access-target.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/protected-memory-foreground-conformance.test.ts -> @nautilo/lattice-bridge",
  // M282 — reviewed live Browser conversation seams. Product and Runtime
  // consumers receive typed bridge ports; crypto-table access and protected
  // byte authentication remain owned by lattice-bridge.
  "apps/workbench/src/adapters/live-shadow-message-projection.ts -> @nautilo/lattice-bridge/client/browser",
  "packages/runtime/src/conversation/live-shadow-agent-runtime.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/live-shadow-agent-runtime.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/conversation/live-shadow-turn-context.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/conversation/live-shadow-turn-context.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/live-shadow-agent-runtime.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/live-shadow-turn-context.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/live-shadow-turn-context.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/messaging/agent-mediated.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/live-shadow-message-composition.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/live-shadow-message-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/live-shadow-message.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/live-shadow-message.ts -> @nautilo/lattice-bridge/server",
  // M302 PR 1 — Strict Shadow policy enforcement consumes only the bridge's
  // typed foreground authority projection. Product callers neither read
  // crypto tables directly nor receive device-private key material.
  "packages/runtime/tests/unit/live-shadow-agent-runtime.test.ts -> @nautilo/lattice-bridge",
  "packages/server/src/lib/strict-shadow-policy.ts -> @nautilo/lattice-bridge",
  "packages/server/src/messaging/agent-mediated.ts -> @nautilo/lattice-bridge",
  // M295 — the Browser runtime owns Human-peer sender/recipient coordination,
  // while the Human-only dispatch path uses the bridge's authenticated plan,
  // admission, persistence, and durable publication ports.
  "apps/workbench/src/adapters/nautilo-runtime.tsx -> @nautilo/lattice-bridge",
  "packages/server/src/messaging/dispatch.ts -> @nautilo/lattice-bridge",
  // M294 — the Server session owner accepts a bridge-authenticated reusable
  // capability; the focused test exercises that same production boundary.
  "packages/server/src/routes/live-shadow-foreground-authorization-sessions.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/live-shadow-foreground-authorization-sessions.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit-isolated/messaging-route-http.test.ts -> @nautilo/lattice-bridge/server",
  // M275 — Browser history hydration and its HTTP composition consume only
  // reviewed client/server bridge projections; restricted storage stays in the
  // bridge implementation.
  "apps/workbench/src/adapters/session-rehydrate.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/room-history-shadow-read-composition.ts -> @nautilo/lattice-bridge/server",
  // M318 retains bridge-owned typed enforcement and canonical protected
  // publication: these callers do not own raw crypto storage or keys.
  "packages/runtime/src/conversation/protected-prompt-memory-staging.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/job.ts -> @nautilo/lattice-bridge",
  "packages/server/src/routes/human-message-product-store.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/room-history-shadow-read-composition.ts -> @nautilo/lattice-bridge",
  // M317 — Browser/Desktop mount the portable device responder. Stenographer
  // callers consume bridge-owned authorization, representation, verification,
  // repair and publication ports; the bridge remains the Lattice integration
  // owner and Reflection supplies only its existing ordinary publication port.
  "apps/desktop/electron/foreground-shadow-controller.ts -> @nautilo/lattice-bridge/client/background",
  "apps/workbench/src/adapters/nautilo-runtime.tsx -> @nautilo/lattice-bridge/client/background",
  "packages/reflection-bridge/src/server/postgres-ordinary-stenographer-publisher.ts -> @nautilo/lattice-bridge",
  "packages/reflection-bridge/tests/unit/postgres-ordinary-stenographer-publisher.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/current-stenographer-output-repair.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/current-stenographer-publication-reconciliation.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/current-stenographer-publication-reconciliation.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/stenographer/ordinary-stenographer-data-operation.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/src/stenographer/protected-journal-output-planner.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-publication-repository.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-publication-repository.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/repository.ts -> @nautilo/lattice-bridge",
  "packages/runtime/src/stenographer/worker.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/integration/m317-output-repair.integration.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/integration/m317-output-repair.integration.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/background-family-contract.test.ts -> @nautilo/lattice-bridge/server",
  "packages/runtime/tests/unit/current-stenographer-output-repair.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/protected-journal-publication-repository.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/stenographer-repository-parameters.test.ts -> @nautilo/lattice-bridge",
  "packages/runtime/tests/unit/stenographer-worker.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/app.ts -> @nautilo/lattice-bridge",
  "packages/server/src/app.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/background/stenographer-composition.ts -> @nautilo/lattice-bridge",
  "packages/server/src/background/stenographer-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/background/stenographer-output-repair-composition.ts -> @nautilo/lattice-bridge",
  "packages/server/src/background/stenographer-output-repair-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/routes/background-authorization-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/stenographer-composition.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/stenographer-output-repair-composition.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/stenographer-output-repair-composition.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/reflection/protected-authority-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/reflection/protected-authority-composition.ts -> @nautilo/lattice-bridge",
  // M327 — Server composes protected Reflection through bridge-owned semantic
  // ports, codecs, held-authority handles, and verified Postgres handles. The
  // adjacent tests exercise those same seams without acquiring key custody or
  // direct crypto-table access; the duplicate entry records two literal imports.
  "packages/server/src/reflection/attach-semantic-recovery.ts -> @nautilo/lattice-bridge",
  "packages/server/src/reflection/attach-semantic-recovery.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/reflection/protected-search-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/src/reflection/protected-semantic-composition.ts -> @nautilo/lattice-bridge",
  "packages/server/src/reflection/protected-semantic-composition.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/protected-reflection-message-sources.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/protected-reflection-message-sources.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/protected-search-composition.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/protected-semantic-composition.test.ts -> @nautilo/lattice-bridge",
  "packages/server/tests/unit/protected-semantic-composition.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/protected-semantic-composition.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/reflection-semantic-fallback-release.test.ts -> @nautilo/lattice-bridge/server",
  "packages/server/tests/unit/reflection-semantic-lifecycle.test.ts -> @nautilo/lattice-bridge/server",
] as const;

const allowedBridgeProductConsumers = new Set(
  reviewedBridgeProductConsumerInventory,
);

const allowedRuntimeRootProtectedExecutionModules = new Set([
  "src/protected-execution/background-authorization/dark-background-family-adapter.ts",
  "src/protected-execution/background-authorization/index.ts",
  "src/protected-execution/background-authorization/lifecycle.ts",
  "src/protected-execution/background-authorization/postgres-repository.ts",
  "src/protected-execution/background-authorization/prepare-processor-recipient.ts",
  "src/protected-execution/background-authorization/processor-credential-claim-port.ts",
  "src/protected-execution/background-authorization/protected-agent-memory-background-entrypoints.ts",
  "src/protected-execution/background-authorization/protected-agent-memory-background.ts",
  "src/protected-execution/background-authorization/repository.ts",
  "src/protected-execution/broker.ts",
  "src/protected-execution/foreground-authorization-session.ts",
  "src/protected-execution/lease-registry.ts",
]);

const allowedProtectedExecutionProductionReferences = new Set([
  "packages/runtime/src/memory/foreground-protected-agent-memory-session.ts -> ../protected-execution/foreground-authorization-session.ts",
  "packages/runtime/src/conversation/active-conversation-repository.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/conversation/conversation-composition.ts -> ../protected-execution/broker",
  "packages/runtime/src/conversation/conversation-execution-services.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/conversation/protected-agent-message-write-coordinator.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/conversation/protected-checkpoint-saver-provider.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/conversation/protected-conversation-agent-content-authority.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/conversation/protected-conversation-executor-io.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/conversation/protected-conversation-transcript.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/index.ts -> ./protected-execution/background-authorization",
  "packages/runtime/src/index.ts -> ./protected-execution/foreground-authorization-session",
  "packages/runtime/src/stenographer/current-stenographer-output-repair.ts -> ../protected-execution/background-authorization/lifecycle",
  "packages/runtime/src/stenographer/current-stenographer-output-repair.ts -> ../protected-execution/background-authorization/repository",
  "packages/runtime/src/stenographer/current-stenographer-publication-reconciliation.ts -> ../protected-execution/background-authorization/lifecycle",
  "packages/runtime/src/stenographer/current-stenographer-publication-reconciliation.ts -> ../protected-execution/background-authorization/repository",
  "packages/runtime/src/stenographer/postgres-protected-stenographer-work-recovery.ts -> ../protected-execution/background-authorization/repository",
  "packages/runtime/src/stenographer/protected-journal-agent-content-authority.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/stenographer/protected-journal-reader.ts -> ../protected-execution/foreground-authorization-session",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> ../protected-execution/background-authorization/lifecycle",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> ../protected-execution/background-authorization/prepare-processor-recipient",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> ../protected-execution/background-authorization/processor-credential-claim-port",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts -> ../protected-execution/background-authorization/repository",
  "packages/runtime/src/stenographer/protected-stenographer-publication-reconciliation.ts -> ../protected-execution/background-authorization/lifecycle",
  "packages/runtime/src/stenographer/protected-stenographer-publication-reconciliation.ts -> ../protected-execution/background-authorization/repository",
  "packages/runtime/src/stenographer/protected-stenographer-work-composition.ts -> ../protected-execution/background-authorization/lifecycle",
  "packages/runtime/src/stenographer/protected-stenographer-work-composition.ts -> ../protected-execution/background-authorization/repository",
]);

function bridgeProductConsumerReferences(repoRoot: string): string[] {
  const violations: string[] = [];
  const productRoots = [
    "apps",
    "bin",
    "deploy",
    "infra",
    "native",
    "ops",
    "packages",
    "packaging",
  ];
  const inspect = (path: string): void => {
    const repositoryPath = relativeFrom(repoRoot, path);
    if (repositoryPath.startsWith("packaging/docker/runtime-install/")) {
      // D490's checked-in projection mirrors canonical workspace manifests.
      return;
    }
    if (
      repositoryPath === bridgeRelativePath
      || repositoryPath.startsWith(`${bridgeRelativePath}/`)
    ) {
      return;
    }
    if (sourceExtensions.has(extname(path))) {
      for (const specifier of moduleSpecifiers(path)) {
        if (isLatticeBridgeConsumer(specifier)) {
          violations.push(`${repositoryPath} -> ${specifier}`);
        }
      }
    }
    if (basename(path) === "package.json") {
      for (const dependency of dependencyReferences(path)) {
        if (
          isLatticeBridgeTarget(dependency.name)
          || isLatticeBridgeTarget(dependency.target)
        ) {
          violations.push(
            `${repositoryPath} dependency ${dependency.name} -> `
              + dependency.target,
          );
        }
      }
      for (const reference of packageImportReferences(path)) {
        if (isLatticeBridgeTarget(reference.target)) {
          violations.push(
            `${repositoryPath} import alias ${reference.name} -> `
              + reference.target,
          );
        }
      }
    }
    if (/^tsconfig(?:\..+)?\.json$/u.test(basename(path))) {
      for (const reference of tsconfigPathReferences(path)) {
        if (isLatticeBridgeTarget(reference.target)) {
          violations.push(
            `${repositoryPath} path alias ${reference.name} -> `
              + reference.target,
          );
        }
      }
    }
  };
  for (const rootName of productRoots) {
    for (const path of walkFiles(join(repoRoot, rootName))) inspect(path);
  }
  for (
    const entry of readdirSync(repoRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
  ) {
    if (
      entry.isFile()
      && (
        entry.name === "package.json"
        || /^tsconfig(?:\..+)?\.json$/u.test(entry.name)
        || /^nautilo(?:\..+)?\.config\.(?:[cm]?[jt]s)$/u.test(entry.name)
      )
    ) {
      inspect(join(repoRoot, entry.name));
    }
  }
  return violations.sort();
}

function bridgeProductConsumerImports(repoRoot: string): string[] {
  return bridgeProductConsumerReferences(repoRoot)
    .filter((reference) => !allowedBridgeProductConsumers.has(reference));
}

function bridgeExportViolations(root: string): string[] {
  const packageJson = join(root, "package.json");
  if (!existsSync(packageJson)) return ["missing packages/lattice-bridge"];
  const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
    exports?: unknown;
  };
  if (!isRecord(parsed.exports)) return ["package exports must be an object"];
  const expected = new Map([
    [".", "./src/index.ts"],
    ["./server", "./src/server/index.ts"],
    [
      "./client/background",
      "./src/device/background-authorization-client.ts",
    ],
    ["./client/browser", "./src/client/browser/index.ts"],
    ["./client/electron", "./src/client/electron/index.ts"],
    ["./testing", "./src/testing/index.ts"],
  ]);
  const violations: string[] = [];
  for (const [exportName, target] of Object.entries(parsed.exports)) {
    const expectedTarget = expected.get(exportName);
    const targets = nestedStringValues(target);
    if (
      expectedTarget === undefined
      || targets.length === 0
      || targets.some((value) => value !== expectedTarget)
    ) {
      violations.push(`${exportName} -> ${targets.join(",")}`);
    }
  }
  for (const exportName of expected.keys()) {
    if (!(exportName in parsed.exports)) violations.push(`missing ${exportName}`);
  }
  return violations.sort();
}

function bridgeRootReachabilityViolations(root: string): string[] {
  const entry = join(root, "src/index.ts");
  if (!existsSync(entry)) return ["missing src/index.ts"];
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const packagePath = relativeFrom(root, path);
    if (
      packagePath.startsWith("src/server/")
      || packagePath.startsWith("src/testing/")
    ) {
      violations.push(`${packagePath} is reachable from the package root`);
    }
    for (const specifier of moduleSpecifiers(path)) {
      if (
        specifier === "@nautilo/db"
        || specifier.startsWith("@nautilo/db/")
        || specifier.startsWith("node:")
      ) {
        violations.push(`${packagePath} -> ${specifier}`);
      }
      const resolved = resolveRelativeSourceModule(path, specifier);
      if (
        resolved !== null
        && (resolved === root || resolved.startsWith(`${root}${sep}`))
      ) {
        pending.push(resolved);
      }
    }
  }
  return violations.sort();
}

function bridgeInternalBoundaryViolations(root: string): string[] {
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) return ["missing src"];
  const violations: string[] = [];
  for (
    const path of walkFiles(sourceRoot)
      .filter((value) => sourceExtensions.has(extname(value)))
  ) {
    const packagePath = relativeFrom(root, path);
    for (const specifier of moduleSpecifiers(path)) {
      const resolved = resolveRelativeSourceModule(path, specifier);
      if (resolved !== null) {
        const target = relativeFrom(root, resolved);
        if (
          !packagePath.startsWith("src/testing/")
          && target.startsWith("src/testing/")
        ) {
          violations.push(`${packagePath} -> ${specifier}`);
        }
        if (
          !packagePath.startsWith("src/server/")
          && !packagePath.startsWith("src/testing/")
          && target.startsWith("src/server/")
        ) {
          violations.push(`${packagePath} -> ${specifier}`);
        }
      }
      if (
        !packagePath.startsWith("src/testing/")
        && specifier === "@nautilo/lattice-bridge/testing"
      ) {
        violations.push(`${packagePath} -> ${specifier}`);
      }
      if (
        !packagePath.startsWith("src/server/")
        && specifier === "@nautilo/lattice-bridge/server"
      ) {
        violations.push(`${packagePath} -> ${specifier}`);
      }
    }
  }
  return [...new Set(violations)].sort();
}

function runtimeProtectedExecutionReachabilityViolations(
  root: string,
): string[] {
  const entry = join(root, "src/index.ts");
  if (!existsSync(entry)) return ["missing packages/runtime/src/index.ts"];
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const packagePath = relativeFrom(root, path);
    if (
      packagePath.startsWith("src/protected-execution/")
      && !allowedRuntimeRootProtectedExecutionModules.has(packagePath)
    ) {
      violations.push(
        `${packagePath} is reachable from the runtime root`,
      );
    }
    for (const specifier of moduleSpecifiers(path)) {
      const resolved = resolveRelativeSourceModule(path, specifier);
      if (
        resolved !== null
        && (resolved === root || resolved.startsWith(`${root}${sep}`))
      ) {
        pending.push(resolved);
      }
    }
  }
  return violations.sort();
}

function protectedExecutionProductionReferenceInventory(
  repoRoot: string,
): string[] {
  const runtimeRoot = join(repoRoot, "packages/runtime");
  const protectedRoot =
    join(runtimeRoot, "src/protected-execution");
  const violations: string[] = [];
  for (const rootName of ["apps", "bin", "packages"]) {
    for (
      const path of walkFiles(join(repoRoot, rootName))
        .filter((value) => sourceExtensions.has(extname(value)))
    ) {
      const repositoryPath = relativeFrom(repoRoot, path);
      if (
        path.startsWith(`${protectedRoot}${sep}`)
        || repositoryPath.includes("/tests/")
        || !readFileSync(path, "utf8").includes("protected-execution")
      ) {
        continue;
      }
      for (const specifier of moduleSpecifiers(path)) {
        const resolved = resolveRelativeSourceModule(path, specifier);
        if (
          specifier.startsWith("@nautilo/runtime/protected-execution")
          || (
            resolved !== null
            && resolved.startsWith(`${protectedRoot}${sep}`)
          )
        ) {
          violations.push(`${repositoryPath} -> ${specifier}`);
        }
      }
    }
  }
  return violations.sort();
}

function protectedExecutionProductionReferences(
  repoRoot: string,
): string[] {
  return protectedExecutionProductionReferenceInventory(repoRoot)
    .filter((reference) =>
      !allowedProtectedExecutionProductionReferences.has(reference)
    );
}

function unexpectedPackageGovernancePaths(coreRoot: string): string[] {
  if (!existsSync(coreRoot)) return ["missing packages/lattice-crypto"];
  const violations: string[] = [];
  for (
    const entry of readdirSync(coreRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
  ) {
    if (entry.isDirectory()) {
      if (
        !ignoredDirectories.has(entry.name)
        && !governedPackageDirectories.has(entry.name)
      ) {
        violations.push(`unexpected package directory: ${entry.name}`);
      }
    } else if (entry.isFile()) {
      if (
        !ignoredGeneratedFiles.has(entry.name)
        && !governedPackageRootFiles.has(entry.name)
      ) {
        violations.push(`unexpected package root file: ${entry.name}`);
      }
    } else {
      violations.push(`unsupported package root entry: ${entry.name}`);
    }
  }
  return violations;
}

function unreviewedPublicExportPaths(coreRoot: string): string[] {
  const parsed = JSON.parse(
    readFileSync(join(coreRoot, "package.json"), "utf8"),
  ) as { exports?: unknown };
  if (!isRecord(parsed.exports)) return ["package exports must be an object"];
  const allowed = new Map([
    [".", "./src/index.ts"],
    ["./wire", "./src/wire.ts"],
    // Portable clients and product compositions use the provider-free,
    // versioned background authorization/processor surface.
    ["./background", "./src/background/client.ts"],
    // Data-only schemas must not traverse the MLS provider closure in Metro.
    ["./wire-limits", "./src/wire-limits.ts"],
    ["./testing", "./src/testing/index.ts"],
  ]);
  const violations: string[] = [];
  for (const [path, target] of Object.entries(parsed.exports)) {
    if (allowed.get(path) !== target) {
      violations.push(`${path} -> ${String(target)}`);
    }
  }
  for (const path of allowed.keys()) {
    if (!(path in parsed.exports)) violations.push(`missing ${path}`);
  }
  return violations.sort();
}

function resolveRelativeSourceModule(
  importer: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = join(dirname(importer), specifier);
  const withoutExtension = sourceExtensions.has(extname(resolved))
    ? resolved.slice(0, -extname(resolved).length)
    : resolved;
  const candidates = [
    resolved,
    ...[...sourceExtensions].map((extension) =>
      `${withoutExtension}${extension}`
    ),
    ...[...sourceExtensions].map((extension) =>
      join(resolved, `index${extension}`)
    ),
  ];
  return candidates.find((candidate) =>
    existsSync(candidate)
    && sourceExtensions.has(extname(candidate))
  ) ?? null;
}

function supportedRootLegacyModulePaths(coreRoot: string): string[] {
  const root = join(coreRoot, "src/index.ts");
  if (!existsSync(root)) return ["missing src/index.ts"];
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const specifier of moduleSpecifiers(path)) {
      const resolved = resolveRelativeSourceModule(path, specifier);
      if (
        resolved !== null
        && (
          resolved === coreRoot
          || resolved.startsWith(`${coreRoot}${sep}`)
        )
      ) {
        pending.push(resolved);
      }
    }
  }
  return [...visited]
    .map((path) => relativeFrom(coreRoot, path))
    .filter((path) => legacyV1Modules.has(path))
    .sort();
}

function moduleExportNames(
  checker: ts.TypeChecker,
  source: ts.SourceFile | undefined,
): string[] {
  if (!source) return [];
  const symbol = checker.getSymbolAtLocation(source);
  return symbol
    ? checker.getExportsOfModule(symbol).map((value) => value.name)
    : [];
}

function supportedRootLegacyExportNames(coreRoot: string): string[] {
  const rootPath = join(coreRoot, "src/index.ts");
  const v1CompatPath = join(coreRoot, "src/testing/v1-compat.ts");
  if (!existsSync(rootPath)) return ["missing src/index.ts"];
  if (!existsSync(v1CompatPath)) return ["missing src/testing/v1-compat.ts"];
  const sources = walkFiles(join(coreRoot, "src"))
    .filter((path) => sourceExtensions.has(extname(path)));
  const program = ts.createProgram(sources, {
    allowImportingTsExtensions: true,
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  const checker = program.getTypeChecker();
  const rootExports = new Set(moduleExportNames(
    checker,
    program.getSourceFile(rootPath),
  ));
  return moduleExportNames(
    checker,
    program.getSourceFile(v1CompatPath),
  )
    .filter((name) =>
      rootExports.has(name) && !sharedV1V2RootExportNames.has(name)
    )
    .sort();
}

function v2LocaleCollationPaths(coreRoot: string): string[] {
  return walkFiles(join(coreRoot, "src"))
    .filter((path) => sourceExtensions.has(extname(path)))
    .filter((path) => {
      const sourcePath = relativeFrom(coreRoot, path);
      return !legacyV1Modules.has(sourcePath)
        && !sourcePath.startsWith("src/testing/");
    })
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          line.includes(".localeCompare(")
            ? [`${relativeFrom(coreRoot, path)}:${index + 1}`]
            : []
        )
    )
    .sort();
}

function latticeUnitBinaryImports(coreRoot: string): string[] {
  const unitRoot = join(coreRoot, "tests/unit");
  if (!existsSync(unitRoot)) return ["missing packages/lattice-crypto/tests/unit"];
  const violations: string[] = [];
  const pending = walkFiles(unitRoot)
    .filter((path) => sourceExtensions.has(extname(path)));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const packagePath = relativeFrom(coreRoot, path);
    const isBinaryModule =
      packagePath === "src/group/openmls.ts"
      || packagePath === "src/group/v2-openmls.ts"
      || packagePath.startsWith("vendor/openmls-wasm/");
    const isBinaryMatrix =
      packagePath === "src/testing/matrix.ts"
      || packagePath === "src/testing/v2-matrix.ts";
    if (isBinaryModule || isBinaryMatrix) {
      violations.push(
        `${packageRelativePath}/${packagePath} is reachable from tests/unit`,
      );
      if (isBinaryModule) continue;
    }
    if (!sourceExtensions.has(extname(path))) continue;
    for (const specifier of moduleSpecifiers(path)) {
      if (
        /\/group\/(?:v2-)?openmls(?:\.ts)?$/u.test(specifier)
        || /\/testing\/(?:v2-)?matrix(?:\.ts)?$/u.test(specifier)
        || specifier.includes("/vendor/openmls-wasm")
      ) {
        violations.push(
          `${packageRelativePath}/${relativeFrom(coreRoot, path)} -> ${specifier}`,
        );
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = join(dirname(path), specifier);
      for (const candidate of [
        resolved,
        `${resolved}.ts`,
        `${resolved}.tsx`,
        join(resolved, "index.ts"),
      ]) {
        if (
          existsSync(candidate)
          && candidate.startsWith(`${coreRoot}${sep}`)
          && sourceExtensions.has(extname(candidate))
        ) {
          pending.push(candidate);
          break;
        }
      }
    }
  }
  return violations.sort();
}

function writeFixtureFile(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function fixtureImportedFile(
  sourcePath: string,
  destinationPath: string,
  sourceBlobSha: string,
  contents: string,
): ImportedFile {
  const digest = sha256(contents);
  return {
    sourcePath,
    destinationPath,
    sourceMode: "100644",
    sourceType: "blob",
    sourceBlobSha,
    sourceSize: Buffer.byteLength(contents),
    sourceSha256: digest,
    destinationSha256BeforeAdaptation: digest,
    destinationSha256AfterAdaptation: digest,
    adaptations: [],
  };
}

function provenanceFixture(): {
  readonly root: string;
  readonly files: readonly ImportedFile[];
  readonly options: ProvenanceOptions;
} {
  const root = mkdtempSync(join(tmpdir(), "m221 provenance "));
  temporaryDirectories.push(root);
  const files = [
    fixtureImportedFile(
      "LICENSE",
      "packages/lattice-crypto/LICENSE.lattice-lab",
      "a".repeat(40),
      "fixture license\n",
    ),
    fixtureImportedFile(
      "packages/lattice-crypto/src/index.ts",
      "packages/lattice-crypto/src/index.ts",
      "b".repeat(40),
      "export const fixture = true;\n",
    ),
  ];
  for (const file of files) {
    const contents = file.sourcePath === "LICENSE"
      ? "fixture license\n"
      : "export const fixture = true;\n";
    writeFixtureFile(root, file.destinationPath, contents);
  }
  const expectedCommit = "c".repeat(40);
  const lockContents = "fixture lock evidence\n";
  const expectedRootLock = {
    sourcePath: "bun.lock",
    sourceMode: "100644",
    sourceType: "blob",
    sourceBlobSha: "e".repeat(40),
    sourceSize: Buffer.byteLength(lockContents),
    sourceSha256: sha256(lockContents),
  } as const;
  const options = {
    expectedCommit,
    expectedRootTree: pinnedSourceRootTree,
    expectedFileCount: files.length,
    expectedSourceManifestSha256: sourceManifestFingerprint(files),
    expectedReceiptSha256: "",
    expectedRootLock,
  };
  const receipt = `${JSON.stringify({
    sourceCommit: expectedCommit,
    sourceRootTree: pinnedSourceRootTree,
    mechanicalImportCommit: "d".repeat(40),
    files,
    generatedFiles: [],
    workspaceAdaptations: [],
    sourceRootEvidence: [{
      ...expectedRootLock,
      destinationPath:
        `${packageRelativePath}/provenance/lattice-lab-bun.lock`,
    }],
  }, null, 2)}\n`;
  writeFixtureFile(
    root,
    `${packageRelativePath}/PROVENANCE.json`,
    receipt,
  );
  writeFixtureFile(
    root,
    `${packageRelativePath}/provenance/lattice-lab-bun.lock`,
    lockContents,
  );
  return {
    root,
    files,
    options: {
      ...options,
      expectedReceiptSha256: sha256(receipt),
    },
  };
}

describe("M221 lattice-crypto import provenance", () => {
  test("pins the exact immutable 57-file M221 import receipt", () => {
    expect(auditImportProvenance(repositoryRoot, {
      expectedCommit: pinnedSourceCommit,
      expectedRootTree: pinnedSourceRootTree,
      expectedFileCount: pinnedSourceFileCount,
      expectedSourceManifestSha256: pinnedSourceManifestSha256,
      expectedReceiptSha256:
        "6ec11122f06c640f258c1a175376cfbc05a22c81c9283e8e5202342aad702c24",
      expectedRootLock: pinnedRootLock,
    })).toEqual([]);
  });

  test("permits legitimate current v2 edits and new tracked v2 modules", () => {
    const edit = provenanceFixture();
    writeFixtureFile(
      edit.root,
      "packages/lattice-crypto/src/index.ts",
      "export const v2Fixture = true;\n",
    );
    expect(auditImportProvenance(edit.root, edit.options)).toEqual([]);

    const newModule = provenanceFixture();
    writeFixtureFile(
      newModule.root,
      "packages/lattice-crypto/src/domain/v2.ts",
      "export const v2Domain = true;\n",
    );
    expect(auditImportProvenance(newModule.root, newModule.options)).toEqual([]);
  });

  test("fails closed for receipt, source, and preserved-lock mutation", () => {
    const receipt = provenanceFixture();
    const receiptPath = join(
      receipt.root,
      packageRelativePath,
      "PROVENANCE.json",
    );
    writeFileSync(receiptPath, `${readFileSync(receiptPath, "utf8")}\n`);
    expect(auditImportProvenance(receipt.root, receipt.options)).toContain(
      "immutable import receipt byte drift",
    );

    const source = provenanceFixture();
    const provenancePath = join(
      source.root,
      packageRelativePath,
      "PROVENANCE.json",
    );
    const manifest = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      files: ImportedFile[];
    };
    manifest.files[0] = {
      ...manifest.files[0]!,
      sourceBlobSha: "0".repeat(40),
    };
    writeFixtureFile(
      source.root,
      `${packageRelativePath}/PROVENANCE.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    expect(auditImportProvenance(source.root, source.options)).toContainEqual(
      expect.stringContaining("pinned source manifest drift:"),
    );

    const preservedLock = provenanceFixture();
    writeFixtureFile(
      preservedLock.root,
      `${packageRelativePath}/provenance/lattice-lab-bun.lock`,
      "mutated lock evidence\n",
    );
    expect(auditImportProvenance(
      preservedLock.root,
      preservedLock.options,
    )).toContain(
      "source-root bun.lock byte drift",
    );
  });

  test("the package verifier rejects mutation of source provenance claims", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "PROVENANCE.json"), "utf8"),
    ) as { files: { sourceBlobSha: string }[] };
    manifest.files[0]!.sourceBlobSha = "0".repeat(40);

    expect(auditImportManifest(manifest, repositoryRoot)).toContain(
      "pinned source manifest drift",
    );
  });

  test("the package verifier pins the complete reviewed receipt bytes", () => {
    const receipt = readFileSync(join(packageRoot, "PROVENANCE.json"));
    expect(auditImportReceiptBytes(receipt, repositoryRoot)).toEqual([]);
    const mutated = Buffer.concat([receipt, Buffer.from("\n")]);
    expect(auditImportReceiptBytes(mutated, repositoryRoot)).toContain(
      "immutable import receipt byte drift",
    );
  });
});

describe("M226 lattice-crypto current package governance", () => {
  test("supports the clean root, explicit wire surface, and test-only v1", () => {
    const rootSource = readFileSync(
      join(packageRoot, "src/index.ts"),
      "utf8",
    );
    expect(rootSource.match(/^export (?:type )?\*/gmu) ?? []).toEqual([]);
    expect(existsSync(join(packageRoot, "src/public-v2.ts"))).toBe(false);
    expect(existsSync(join(packageRoot, "src/public.ts"))).toBe(false);
    const v1CompatConsumers = walkFiles(packageRoot)
      .filter((path) => sourceExtensions.has(extname(path)))
      .flatMap((path) =>
        moduleSpecifiers(path)
          .filter((specifier) => specifier.includes("v1-compat"))
          .map((specifier) =>
            `${relativeFrom(packageRoot, path)} -> ${specifier}`
          )
      )
      .sort();
    expect(v1CompatConsumers).toEqual([
      "playground/scenarios.ts -> ../src/testing/v1-compat.ts",
      "src/testing/index.ts -> ./v1-compat.ts",
      "tests/integration/adversary.test.ts -> ../../src/testing/v1-compat.ts",
      "tests/integration/history-recovery.test.ts -> ../../src/testing/v1-compat.ts",
    ]);
    expect(supportedRootLegacyModulePaths(packageRoot)).toEqual([]);
    expect(supportedRootLegacyExportNames(packageRoot)).toEqual([]);
  });

  test("keeps current evolution inside reviewed package boundaries", () => {
    expect(unexpectedPackageGovernancePaths(packageRoot)).toEqual([]);
    expect(unreviewedPublicExportPaths(packageRoot)).toEqual([]);
    expect(v2LocaleCollationPaths(packageRoot)).toEqual([]);
    const internalStorageBarrelConsumers = walkFiles(
      join(packageRoot, "src"),
    )
      .filter((path) =>
        sourceExtensions.has(extname(path))
        && relativeFrom(packageRoot, path) !== "src/internal-v2.ts"
        && relativeFrom(packageRoot, path) !== "src/index.ts"
        && relativeFrom(packageRoot, path) !== "src/wire.ts"
        && relativeFrom(packageRoot, path) !== "src/storage/v2-store.ts"
      )
      .flatMap((path) =>
        moduleSpecifiers(path)
          .filter((specifier) => specifier.endsWith("/storage/v2-store.ts"))
          .map((specifier) =>
            `${relativeFrom(packageRoot, path)} -> ${specifier}`
          )
      )
      .sort();
    expect(internalStorageBarrelConsumers).toEqual([]);
    const rootIgnore = readFileSync(
      join(repositoryRoot, ".gitignore"),
      "utf8",
    );
    const eslintConfig = readFileSync(
      join(repositoryRoot, "eslint.config.mjs"),
      "utf8",
    );
    for (const generatedPath of [
      "packages/lattice-crypto/.stryker-tmp/",
      "packages/lattice-crypto/reports/",
    ]) {
      expect(rootIgnore).toContain(generatedPath);
      expect(eslintConfig).toContain(`${generatedPath}**`);
    }
  });

  test("active imported package files contain no stale Kentauros prefix", () => {
    expect(staleKentaurosPrefixes(packageRoot)).toEqual([]);
  });

  test("the isolated core imports no Nautilo product package", () => {
    expect(coreProductImports(packageRoot)).toEqual([]);
  });

  test("only reviewed runtime seams reach lattice packages", () => {
    const cryptoProductConsumers = productConsumerImports(repositoryRoot);
    const bridgeProductConsumers = bridgeProductConsumerReferences(
      repositoryRoot,
    );
    const protectedExecutionReferences =
      protectedExecutionProductionReferenceInventory(repositoryRoot);
    expect(
      cryptoProductConsumers.filter((reference) =>
        !allowedReviewedCryptoProductConsumers.has(reference)
      ),
    ).toEqual([]);
    expect(
      cryptoProductConsumers.filter((reference) =>
        allowedReviewedCryptoProductConsumers.has(reference)
      ),
    ).toEqual([...reviewedCryptoProductConsumerInventory].sort());
    expect(
      bridgeProductConsumers.filter((reference) =>
        !allowedBridgeProductConsumers.has(reference)
      ),
    ).toEqual([]);
    expect(
      bridgeProductConsumers
        .filter((reference) => allowedBridgeProductConsumers.has(reference)),
    ).toEqual([...reviewedBridgeProductConsumerInventory].sort());
    expect(
      readFileSync(
        join(repositoryRoot, "packages/runtime/src/index.ts"),
        "utf8",
      ),
    ).toContain(
      'from "./protected-execution/foreground-authorization-session";',
    );
    expect(
      protectedExecutionReferences.filter((reference) =>
        !allowedProtectedExecutionProductionReferences.has(reference)
      ),
    ).toEqual([]);
    expect(
      protectedExecutionReferences
        .filter((reference) =>
          allowedProtectedExecutionProductionReferences.has(reference)
        ),
    ).toEqual([...allowedProtectedExecutionProductionReferences].sort());
    expect(
      runtimeProtectedExecutionReachabilityViolations(
        join(repositoryRoot, "packages/runtime"),
      ),
    ).toEqual([]);
    expect(bridgeExportViolations(bridgeRoot)).toEqual([]);
    expect(bridgeRootReachabilityViolations(bridgeRoot)).toEqual([]);
    expect(bridgeInternalBoundaryViolations(bridgeRoot)).toEqual([]);
  }, 45_000);

  test("keeps honest binary-free unit tests and dedicated lattice CI lanes", () => {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["test:unit"]).toBe(
      "bun test --timeout 60000 tests/unit/",
    );
    expect(packageJson.scripts?.["test:integration"]).toBe(
      "bun test --timeout 60000 tests/integration/",
    );
    expect(packageJson.scripts?.["test:scenarios"]).toBe(
      "bun run playground/runner.ts all all && bun test --timeout 60000 tests/scenarios/",
    );
    expect(packageJson.scripts?.["test"]).toBe(
      "bun run test:unit && bun run test:property && bun run test:integration && bun run test:scenarios && bun run test:fuzz",
    );
    expect(packageJson.scripts?.["test:property"]).toBe(
      "bun test --timeout 60000 tests/property/",
    );
    expect(packageJson.scripts?.["test:fuzz"]).toBe(
      "bun test --timeout 60000 tests/fuzz/",
    );
    expect(packageJson.scripts?.["test:soak"]).toBe(
      "bun test --timeout 60000 tests/soak/",
    );
    expect(packageJson.scripts?.["test:mutation"]).toBe(
      "bun run scripts/run-mutation-gate.ts",
    );
    expect(packageJson.scripts?.["test:mutation:target"]).toBe(
      "bun run scripts/run-mutation-target.ts",
    );
    expect(packageJson.scripts?.["test:assurance"]).toBe(
      "bun run test:unit && bun run test:property && bun run test:integration && bun run test:scenarios && bun run test:fuzz && bun run test:soak && bun run test:mutation && bun run wasm:audit && bun run wasm:license-verify && bun run wasm:test-verifier && bun run wasm:verify",
    );
    expect(packageJson.scripts?.["wasm:audit"]).toBe(
      "bash scripts/audit-openmls-wasm.sh",
    );
    expect(latticeUnitBinaryImports(packageRoot)).toEqual([]);
    expect(
      walkFiles(join(packageRoot, "tests/unit"))
        .filter((path) => path.endsWith(".test.ts")).length,
    ).toBeGreaterThan(0);
    expect(
      walkFiles(join(packageRoot, "tests/integration"))
        .filter((path) => path.endsWith(".test.ts")).length,
    ).toBeGreaterThan(0);

    const mainWorkflow = readFileSync(
      join(repositoryRoot, ".github/workflows/lattice-crypto.yml"),
      "utf8",
    );
    const prWorkflow = readFileSync(
      join(repositoryRoot, ".github/workflows/lattice-crypto-pr.yml"),
      "utf8",
    );
    const wasmBuild = readFileSync(
      join(packageRoot, "scripts/openmls-wasm-common.sh"),
      "utf8",
    );
    expect(mainWorkflow).not.toMatch(/^\s*pull_request:/mu);
    expect(mainWorkflow).toMatch(/push:\s*\n\s+branches:\s*\[main\]/u);
    expect(mainWorkflow).not.toContain(
      "bun run --cwd packages/lattice-crypto test:integration",
    );
    expect(mainWorkflow).not.toContain(
      "bun run --cwd packages/lattice-crypto test:scenarios",
    );
    expect(prWorkflow).toMatch(/^\s*pull_request:/mu);
    expect(prWorkflow).not.toMatch(/push:\s*\n\s+branches:\s*\[main\]/u);
    expect(prWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto test:integration",
    );
    expect(prWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto test:scenarios",
    );
    expect(mainWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto wasm:verify",
    );
    expect(mainWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto wasm:test-verifier",
    );
    expect(mainWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto wasm:license-verify",
    );
    expect(mainWorkflow).not.toContain("cargo install cargo-audit");
    expect(mainWorkflow).toContain(
      "cargo-audit-x86_64-unknown-linux-gnu-v0.22.2.tgz",
    );
    expect(mainWorkflow).toContain(
      "ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39",
    );
    expect(mainWorkflow).toContain(
      'test "$("$tools/cargo-audit" --version)" = "cargo-audit 0.22.2"',
    );
    expect(mainWorkflow).toContain('echo "$tools" >> "$GITHUB_PATH"');
    expect(mainWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto wasm:audit",
    );
    expect(mainWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto test:property",
    );
    expect(mainWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto test:fuzz",
    );
    expect(mainWorkflow).not.toContain(
      "bun run --cwd packages/lattice-crypto test:mutation",
    );
    expect(mainWorkflow).toContain(
      "bun run --cwd packages/lattice-crypto test:soak",
    );
    expect(mainWorkflow).toContain("actions/upload-artifact@");
    expect(mainWorkflow).toContain(
      "packages/lattice-crypto/reports/assurance/seed-manifest.json",
    );
    expect(mainWorkflow).not.toContain("rustup toolchain install");
    expect(mainWorkflow).not.toContain("WASM_PACK_SHA256");
    expect(mainWorkflow).not.toMatch(
      /\b(?:db:migrate|db:push|infra:start|server:start)\b/u,
    );
    expect(wasmBuild).toContain(
      "rust@sha256:d99f7b31f49909348dc59b51f3c95d1efded1701ffb222f095aaab7de3c4abd8",
    );
    expect(wasmBuild).toContain("--platform linux/amd64");
    expect(wasmBuild).toContain(
      "c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539",
    );
    expect(wasmBuild).toContain(
      "064948d58e2d6c0a745216477a639ba696216d6309aaa902939d1b865b1d869d",
    );
    expect(wasmBuild).toContain(
      "3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212",
    );
  });

  test("derives and validates the complete canonical mutation inventory", () => {
    const manifestValue: unknown = JSON.parse(readFileSync(
      join(packageRoot, "scripts/mutation-scopes.json"),
      "utf8",
    ));
    const manifest = parseMutationManifest(manifestValue, {
      fileExists: (path) => existsSync(join(packageRoot, path)),
    });
    const eligibleTargets = deriveMutationSourceInventory(packageRoot);
    expect(() =>
      assertCompleteMutationCoverage(manifest, eligibleTargets)
    ).not.toThrow();
    expect({
      formatVersion: manifest.formatVersion,
      minimumKilledPercentage: manifest.minimumKilledPercentage,
      perScopeWorkerBudget: manifest.perScopeWorkerBudget,
      hostedMaxParallelScopes: manifest.hostedMaxParallelScopes,
      maximumHostedWorkers:
        manifest.perScopeWorkerBudget * manifest.hostedMaxParallelScopes,
      scopeCount: manifest.scopes.length,
      reviewedDuplicateTargets: manifest.reviewedDuplicateTargets,
    }).toEqual({
      formatVersion: 3,
      minimumKilledPercentage: 80,
      perScopeWorkerBudget: 4,
      hostedMaxParallelScopes: 4,
      maximumHostedWorkers: 16,
      scopeCount: 28,
      reviewedDuplicateTargets: [],
    });
    expect(
      manifest.scopes.filter((scope) => scope.tier === "critical"),
    ).toHaveLength(26);
    expect(
      manifest.scopes.filter((scope) => scope.tier === "provider"),
    ).toHaveLength(2);

    const objectGrant = manifest.scopes.find((scope) =>
      scope.name === "object-grant"
    );
    expect(objectGrant).toBeDefined();
    expect(objectGrant!.mutate.filter((target) =>
      target === "src/object/authorized-write.ts"
    )).toHaveLength(1);

    const mutationTargets = manifest.scopes.flatMap((scope) => scope.mutate);
    expect(new Set(mutationTargets).size).toBe(124);
    expect(mutationTargets).toContain("src/message/human-message-edit-v1.ts");
    expect(eligibleTargets).toHaveLength(124);
    expect(mutationTargets).toContain("src/message/human-ai-readable-live-shadow-core.ts");
    expect(mutationTargets).toContain("src/message/human-ai-readable-live-shadow-v2.ts");
    expect([...new Set(mutationTargets)].sort()).toEqual(eligibleTargets);
    expect(mutationTargets).toContain(
      "src/object/device-wrapped-agent-access-manifest-set-v1.ts",
    );
    expect(mutationTargets).toContain("src/group/v2-mls.ts");
    expect(mutationTargets).toContain("src/group/v2-openmls.ts");
    expect(mutationTargets).toContain("src/group/human-device-openmls-v1.ts");
    expect(mutationTargets).toContain("src/crypto/index.ts");
    expect(mutationTargets).toContain(
      "src/message/shared-agent-live-shadow-v1.ts",
    );
    expect(mutationTargets).toContain(
      "src/storage/v2-adapter-support.ts",
    );
    expect(mutationTargets).toContain(
      "src/recovery/device-transfer-size-v2.ts",
    );
    expect(mutationTargets.filter((target) =>
      target === "src/recovery/human-archive-v2.ts"
    )).toHaveLength(1);
    expect(mutationTargets.some((target) => target.includes(":"))).toBe(false);
    expect(manifest.reviewedExclusions).toEqual([]);
    const residualLedger: unknown = JSON.parse(readFileSync(
      join(packageRoot, "scripts/mutation-residuals.json"),
      "utf8",
    ));
    const parsedResidualLedger = parseMutationResidualLedger(residualLedger, {
      manifest,
      fileExists: (path) => existsSync(join(packageRoot, path)),
    });
    // The ledger deliberately evolves as mutants are measured and closed.
    // Require every checked-in field to survive strict parsing; exact residual
    // identity and staleness are enforced against generated mutation reports.
    expect(parsedResidualLedger).toEqual(residualLedger);
  });

  test("pins the exact recorded property and fuzz seed inventory", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/lattice-crypto.yml"),
      "utf8",
    );
    const expectedSeedManifest = {
      formatVersion: 1,
      property: {
        "formats-v2.property.test.ts": "1-64",
        "foundation-v2.property.test.ts": "1-512",
        "grant-enumeration-v2.property.test.ts": "1-256",
        "keyring-transition-v2.property.test.ts": "1-256",
        "object-attachment-v2.property.test.ts": "1-32",
        "recovery-inventory-v2.property.test.ts": "1-32",
      },
      fuzz: {
        "v2-codecs.fuzz.test.ts": "1-2048",
        "v2-primitives.fuzz.test.ts": "1-4096",
        "v2-verifiers.fuzz.test.ts": {
          "runtime-handoff": "1-16",
          "namespace-and-keyring": "1-32",
          "manifest-chain": "1-32",
          "recovery-activation": "1-32",
        },
      },
      replay: {
        "formats-v2.property.test.ts":
          "M225_FORMAT_PROPERTY_SEED=<seed> bun test --timeout 60000 tests/property/formats-v2.property.test.ts",
        "v2-codecs.fuzz.test.ts":
          "M225_FUZZ_SEED=<seed> bun test --timeout 60000 tests/fuzz/v2-codecs.fuzz.test.ts",
        "v2-primitives.fuzz.test.ts":
          "M225_FUZZ_SEED=<seed> bun test --timeout 60000 tests/fuzz/v2-primitives.fuzz.test.ts",
        "v2-verifiers.fuzz.test.ts":
          "bun test --timeout 60000 tests/fuzz/v2-verifiers.fuzz.test.ts",
      },
    };
    const seedManifestMatch = workflow.match(
      /printf '%s\\n' '([^']+)' \\\n\s+> packages\/lattice-crypto\/reports\/assurance\/seed-manifest\.json/u,
    );
    expect(seedManifestMatch).not.toBeNull();
    expect(JSON.parse(seedManifestMatch![1]!)).toEqual(expectedSeedManifest);

    for (const file of Object.keys(expectedSeedManifest.property)) {
      expect(existsSync(join(packageRoot, "tests/property", file))).toBe(true);
    }
    for (const file of Object.keys(expectedSeedManifest.fuzz)) {
      expect(existsSync(join(packageRoot, "tests/fuzz", file))).toBe(true);
    }
    const propertySources = Object.fromEntries(
      Object.keys(expectedSeedManifest.property).map((file) => [
        file,
        readFileSync(join(packageRoot, "tests/property", file), "utf8"),
      ]),
    );
    expect(
      propertySources["formats-v2.property.test.ts"],
    ).toContain("const MAX_SEED = 64");
    expect(
      propertySources["formats-v2.property.test.ts"],
    ).toContain('process.env["M225_FORMAT_PROPERTY_SEED"]');
    expect(
      propertySources["foundation-v2.property.test.ts"]!.match(
        /for \(let seed = 1; seed <= 512; seed \+= 1\)/gu,
      ),
    ).toHaveLength(2);
    expect(
      propertySources["grant-enumeration-v2.property.test.ts"],
    ).toContain("for (let seed = 1; seed <= 256; seed += 1)");
    expect(
      propertySources["keyring-transition-v2.property.test.ts"],
    ).toContain("for (let seed = 1; seed <= 256; seed++)");
    expect(
      propertySources["object-attachment-v2.property.test.ts"],
    ).toContain("for (let seed = 1; seed <= 32; seed++)");
    expect(
      propertySources["recovery-inventory-v2.property.test.ts"],
    ).toContain("for (let seed = 1; seed <= 32; seed++)");
    const codecFuzz = readFileSync(
      join(packageRoot, "tests/fuzz/v2-codecs.fuzz.test.ts"),
      "utf8",
    );
    const primitiveFuzz = readFileSync(
      join(packageRoot, "tests/fuzz/v2-primitives.fuzz.test.ts"),
      "utf8",
    );
    expect(codecFuzz).toContain("selectedSeeds(2_048)");
    expect(codecFuzz).toContain(
      "tests/fuzz/v2-codecs.fuzz.test.ts",
    );
    expect(primitiveFuzz).toContain("selectedSeeds(4_096)");
    expect(primitiveFuzz).toContain(
      "tests/fuzz/v2-primitives.fuzz.test.ts",
    );
    const verifierFuzz = readFileSync(
      join(packageRoot, "tests/fuzz/v2-verifiers.fuzz.test.ts"),
      "utf8",
    );
    expect(verifierFuzz).toContain(
      "for (let seed = 1; seed <= 16; seed++)",
    );
    expect(
      verifierFuzz.match(/for \(let seed = 1; seed <= 32; seed\+\+\)/gu),
    ).toHaveLength(3);
    for (const [corpus, range] of Object.entries(
      expectedSeedManifest.fuzz["v2-verifiers.fuzz.test.ts"],
    )) {
      expect(verifierFuzz).toContain(`"${corpus}": "${range}"`);
    }
  });

  test("synthetic v2 binary reachability from unit tests fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "m225 binary lane "));
    temporaryDirectories.push(root);
    const coreRoot = join(root, packageRelativePath);
    writeFixtureFile(
      root,
      `${packageRelativePath}/tests/unit/consumer.test.ts`,
      'import "../../src/testing/v2-matrix.ts";\n',
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/testing/v2-matrix.ts`,
      'import "../group/v2-openmls.ts";\n',
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/group/v2-openmls.ts`,
      'export const binaryProvider = true;\n',
    );
    expect(latticeUnitBinaryImports(coreRoot)).toEqual([
      "packages/lattice-crypto/src/group/v2-openmls.ts is reachable from tests/unit",
      "packages/lattice-crypto/src/testing/v2-matrix.ts -> ../group/v2-openmls.ts",
      "packages/lattice-crypto/src/testing/v2-matrix.ts is reachable from tests/unit",
      "packages/lattice-crypto/tests/unit/consumer.test.ts -> ../../src/testing/v2-matrix.ts",
    ]);
  });

  test("synthetic runtime and type-only v1 root leaks fail closed", () => {
    const root = mkdtempSync(join(tmpdir(), "m225 public surface "));
    temporaryDirectories.push(root);
    const coreRoot = join(root, packageRelativePath);
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/index.ts`,
      'export { LatticeCrypto } from "./crypto/index.ts";\n'
        + 'export type { Clock } from "./crypto/index.ts";\n'
        + 'export { legacyRuntime } from "./engine/engine.ts";\n'
        + 'export type { LegacyType } from "./engine/engine.ts";\n',
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/crypto/index.ts`,
      "export interface Clock { now(): number; }\n"
        + "export class LatticeCrypto {}\n",
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/engine/engine.ts`,
      "export interface LegacyType { readonly legacy: true; }\n"
        + "export const legacyRuntime = true;\n",
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/testing/v1-compat.ts`,
      'export { LatticeCrypto } from "../crypto/index.ts";\n'
        + 'export type { Clock } from "../crypto/index.ts";\n'
        + 'export { legacyRuntime } from "../engine/engine.ts";\n'
        + 'export type { LegacyType } from "../engine/engine.ts";\n',
    );

    expect(supportedRootLegacyModulePaths(coreRoot)).toEqual([
      "src/engine/engine.ts",
    ]);
    expect(supportedRootLegacyExportNames(coreRoot)).toEqual([
      "LegacyType",
      "legacyRuntime",
    ]);
  });

  test("synthetic stale branding and unreviewed product consumption fail closed", () => {
    const root = mkdtempSync(join(tmpdir(), "m221 boundary "));
    temporaryDirectories.push(root);
    const coreRoot = join(root, packageRelativePath);
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/legacy.ts`,
      'export const domain = "kentauros/lattice-crypto/grant/v1";\n',
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/src/core.ts`,
      'import { db } from "@nautilo/db";\nexport { db };\n',
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/package.json`,
      `${JSON.stringify({
        name: "@nautilo/lattice-crypto",
        dependencies: { "@nautilo/runtime": "workspace:*" },
        exports: {
          ".": "./src/index.ts",
          "./wire": "./src/wire.ts",
          "./testing": "./src/testing/index.ts",
          "./v2": "./src/internal-v2.ts",
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      `${packageRelativePath}/PROVENANCE.md`,
      "Historical source evidence: @kentauros/lattice-crypto.\n",
    );
    writeFixtureFile(
      root,
      "packages/server/src/consumer.ts",
      'export { createEngine } from "@nautilo/lattice-crypto";\n',
    );
    writeFixtureFile(
      root,
      "packages/server/src/consumer.mts",
      'export { createEngine } from "@nautilo/lattice-crypto/testing";\n',
    );
    writeFixtureFile(
      root,
      "packages/server/src/wire.ts",
      'export { serializeGrantV2 } from "@nautilo/lattice-crypto/wire";\n',
    );
    writeFixtureFile(
      root,
      "packages/server/src/internal.ts",
      'export { V2Storage } from "../../lattice-crypto/src/internal-v2.ts";\n',
    );
    writeFixtureFile(
      root,
      "packages/server/src/consumer.cts",
      'const core = require("@nautilo/lattice-crypto");\nexport { core };\n',
    );
    writeFixtureFile(
      root,
      "packages/server/package.json",
      `${JSON.stringify({
        name: "@nautilo/server",
        imports: {
          "#lattice": "../lattice-crypto/src/index.ts",
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "packages/server/tsconfig.json",
      `${JSON.stringify({
        compilerOptions: {
          paths: {
            "#lattice": ["../lattice-crypto/src/index.ts"],
          },
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "packages/runtime/package.json",
      `${JSON.stringify({
        name: "@nautilo/runtime",
        dependencies: {
          "lattice-alias": "npm:@nautilo/lattice-crypto@0.1.0",
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "package.json",
      `${JSON.stringify({
        imports: {
          "#root-lattice": "./packages/lattice-crypto/src/index.ts",
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "nautilo.config.ts",
      'import "@nautilo/lattice-crypto";\nexport default {};\n',
    );

    expect(staleKentaurosPrefixes(coreRoot)).toEqual([
      "packages/lattice-crypto/src/legacy.ts:1",
    ]);
    expect(coreProductImports(coreRoot)).toEqual([
      "packages/lattice-crypto/package.json dependency @nautilo/runtime -> workspace:*",
      "packages/lattice-crypto/src/core.ts -> @nautilo/db",
    ]);
    expect(productConsumerImports(root)).toEqual([
      "nautilo.config.ts -> @nautilo/lattice-crypto",
      "package.json import alias #root-lattice -> ./packages/lattice-crypto/src/index.ts",
      "packages/runtime/package.json dependency lattice-alias -> npm:@nautilo/lattice-crypto@0.1.0",
      "packages/server/package.json import alias #lattice -> ../lattice-crypto/src/index.ts",
      "packages/server/src/consumer.cts -> @nautilo/lattice-crypto",
      "packages/server/src/consumer.mts -> @nautilo/lattice-crypto/testing",
      "packages/server/src/consumer.ts -> @nautilo/lattice-crypto",
      "packages/server/src/internal.ts -> ../../lattice-crypto/src/internal-v2.ts",
      "packages/server/src/wire.ts -> @nautilo/lattice-crypto/wire",
      "packages/server/tsconfig.json path alias #lattice -> ../lattice-crypto/src/index.ts",
    ]);
    expect(unreviewedPublicExportPaths(coreRoot)).toEqual([
      "./v2 -> ./src/internal-v2.ts",
      "missing ./background",
      "missing ./wire-limits",
    ]);
    writeFixtureFile(
      root,
      `${packageRelativePath}/unreviewed-root.txt`,
      "unreviewed package surface\n",
    );
    expect(unexpectedPackageGovernancePaths(coreRoot)).toEqual([
      "unexpected package root file: unreviewed-root.txt",
    ]);
  });

  test("product consumer scan keeps every relevant candidate visible around ignored artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "m221 product scan "));
    temporaryDirectories.push(root);
    // These artifacts deliberately sort before the source directory. They must
    // not cause the scanner to skip the sibling source/configuration evidence.
    writeFixtureFile(
      root,
      "apps/mobile/generated/lattice-crypto.fixture.bin",
      "\u0000generated fixture bytes\u0000",
    );
    writeFixtureFile(
      root,
      "apps/mobile/dist/generated.ts",
      "export const generated = true;\n",
    );
    writeFixtureFile(
      root,
      "apps/mobile/src/consumer.ts",
      'export { createEngine } from "@nautilo/lattice-crypto";\n',
    );
    writeFixtureFile(
      root,
      "packages/runtime/package.json",
      `${JSON.stringify({
        dependencies: { "@nautilo/lattice-crypto": "workspace:*" },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "packages/server/tsconfig.json",
      `${JSON.stringify({
        compilerOptions: {
          paths: { "#lattice": ["../lattice-crypto/src/index.ts"] },
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "nautilo.config.ts",
      'import "@nautilo/lattice-crypto";\nexport default {};\n',
    );

    expect(productConsumerImports(root)).toEqual([
      "apps/mobile/src/consumer.ts -> @nautilo/lattice-crypto",
      "nautilo.config.ts -> @nautilo/lattice-crypto",
      "packages/runtime/package.json dependency @nautilo/lattice-crypto -> workspace:*",
      "packages/server/tsconfig.json path alias #lattice -> ../lattice-crypto/src/index.ts",
    ]);
  });

  test("product consumer scan catches every supported literal module form", () => {
    const root = mkdtempSync(join(tmpdir(), "m221 module forms "));
    temporaryDirectories.push(root);
    writeFixtureFile(
      root,
      "apps/mobile/src/static.ts",
      'import { createEngine } from "@nautilo/lattice-crypto";\n',
    );
    writeFixtureFile(
      root,
      "bin/worker/export.mts",
      'export { serializeGrantV2 } from "@nautilo/lattice-crypto/wire";\n',
    );
    writeFixtureFile(
      root,
      "deploy/worker/import-equals.cts",
      'import core = require("@nautilo/lattice-crypto");\nexport { core };\n',
    );
    writeFixtureFile(
      root,
      "infra/worker/require.cjs",
      'const core = require("@nautilo/lattice-crypto/testing");\n',
    );
    writeFixtureFile(
      root,
      "native/worker/dynamic.ts",
      'void import("@nautilo/lattice-crypto/wire");\n',
    );
    writeFixtureFile(
      root,
      "ops/worker/template.ts",
      "void import(`@nautilo/lattice-crypto`);\n",
    );

    expect(productConsumerImports(root)).toEqual([
      "apps/mobile/src/static.ts -> @nautilo/lattice-crypto",
      "bin/worker/export.mts -> @nautilo/lattice-crypto/wire",
      "deploy/worker/import-equals.cts -> @nautilo/lattice-crypto",
      "infra/worker/require.cjs -> @nautilo/lattice-crypto/testing",
      "native/worker/dynamic.ts -> @nautilo/lattice-crypto/wire",
      "ops/worker/template.ts -> @nautilo/lattice-crypto",
    ]);
  });

  test("synthetic bridge boundary drift fails closed with actionable paths", () => {
    const root = mkdtempSync(join(tmpdir(), "m231 bridge boundary "));
    temporaryDirectories.push(root);
    writeFixtureFile(
      root,
      `${bridgeRelativePath}/package.json`,
      `${JSON.stringify({
        name: "@nautilo/lattice-bridge",
        dependencies: {
          "@nautilo/lattice-crypto": "workspace:*",
        },
        exports: {
          ".": {
            import: "./src/index.ts",
            types: "./src/index.ts",
          },
          "./server": "./src/server/index.ts",
          "./client/browser": "./src/client/browser/index.ts",
          "./client/electron": "./src/client/electron/index.ts",
          "./testing": "./src/testing/index.ts",
          "./internal": "./src/internal.ts",
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      `${bridgeRelativePath}/src/index.ts`,
      'import "node:fs";\n'
        + 'export * from "./server/index.ts";\n'
        + 'export type { Wire } from "@nautilo/lattice-crypto/wire";\n',
    );
    writeFixtureFile(
      root,
      `${bridgeRelativePath}/src/server/index.ts`,
      'export { fixture } from "@nautilo/lattice-crypto/testing";\n'
        + 'export * from "../testing/index.ts";\n',
    );
    writeFixtureFile(
      root,
      `${bridgeRelativePath}/src/testing/index.ts`,
      'export * from "../server/index.ts";\n',
    );
    writeFixtureFile(
      root,
      `${bridgeRelativePath}/src/internal.ts`,
      'export * from "../../lattice-crypto/src/index.ts";\n',
    );
    writeFixtureFile(
      root,
      "packages/server/src/bridge.ts",
      'import "@nautilo/lattice-bridge";\n'
        + 'import "@nautilo/lattice-bridge/testing";\n',
    );
    writeFixtureFile(
      root,
      "packages/server/package.json",
      `${JSON.stringify({
        name: "@nautilo/server",
        dependencies: {
          "@nautilo/lattice-bridge": "workspace:*",
        },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "packages/runtime/src/index.ts",
      'export * from "./protected-execution/unreviewed.ts";\n',
    );
    writeFixtureFile(
      root,
      "packages/runtime/src/protected-execution/unreviewed.ts",
      "export const protectedBroker = true;\n",
    );

    expect(productConsumerImports(root)).toEqual([
      "packages/lattice-bridge/src/internal.ts -> ../../lattice-crypto/src/index.ts",
      "packages/lattice-bridge/src/server/index.ts -> @nautilo/lattice-crypto/testing",
    ]);
    expect(bridgeProductConsumerImports(root)).toEqual([
      "packages/server/src/bridge.ts -> @nautilo/lattice-bridge",
      "packages/server/src/bridge.ts -> @nautilo/lattice-bridge/testing",
    ]);
    expect(bridgeExportViolations(join(root, bridgeRelativePath))).toEqual([
      "./internal -> ./src/internal.ts",
      "missing ./client/background",
    ]);
    expect(
      bridgeRootReachabilityViolations(join(root, bridgeRelativePath)),
    ).toEqual([
      "src/index.ts -> node:fs",
      "src/server/index.ts is reachable from the package root",
      "src/testing/index.ts is reachable from the package root",
    ]);
    expect(
      bridgeInternalBoundaryViolations(join(root, bridgeRelativePath)),
    ).toEqual([
      "src/index.ts -> ./server/index.ts",
      "src/server/index.ts -> ../testing/index.ts",
    ]);
    expect(
      runtimeProtectedExecutionReachabilityViolations(
        join(root, "packages/runtime"),
      ),
    ).toEqual([
      "src/protected-execution/unreviewed.ts is reachable from the runtime root",
    ]);
    expect(protectedExecutionProductionReferences(root)).toEqual([
      "packages/runtime/src/index.ts -> ./protected-execution/unreviewed.ts",
    ]);
  });
});
