import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

const sourceCommit = "a1fc280cd646fe147427b9feb8a41f121386a138";
const sourceRootTree = "aeec95b24de2672346652c6a4ed312fc898d84f6";
const mechanicalImportCommit =
  "593e64df8b9bb2f62281d65b239a587b132cd93b";
const repositoryRoot = join(import.meta.dir, "../../..");
const packageRoot = join(repositoryRoot, "packages/lattice-crypto");
const sourceRepository = process.env["LATTICE_LAB_REPOSITORY"];
const unitTestBasenames = new Set([
  "engine.test.ts",
  "grant-cache.test.ts",
  "validation.test.ts",
]);

if (!sourceRepository) {
  throw new Error(
    "Set LATTICE_LAB_REPOSITORY to a checkout containing the pinned source commit",
  );
}

function git(...args: string[]): Buffer {
  return execFileSync(
    "git",
    ["-C", sourceRepository!, ...args],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryPath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function destinationFor(sourcePath: string): string {
  const testPrefix = "packages/lattice-crypto/tests/";
  if (sourcePath.startsWith(testPrefix)) {
    const basename = sourcePath.slice(testPrefix.length);
    const lane = unitTestBasenames.has(basename) ? "unit" : "integration";
    return `${testPrefix}${lane}/${basename}`;
  }
  if (sourcePath.startsWith("packages/lattice-crypto/")) return sourcePath;
  if (sourcePath === "scripts/build-openmls-wasm.sh") {
    return "packages/lattice-crypto/scripts/build-openmls-wasm.sh";
  }
  if (sourcePath === "LICENSE") {
    return "packages/lattice-crypto/LICENSE.lattice-lab";
  }
  throw new Error(`ineligible source path: ${sourcePath}`);
}

function adaptationsFor(
  sourcePath: string,
  sourceDigest: string,
  finalDigest: string,
): string[] {
  if (sourcePath.startsWith("packages/lattice-crypto/tests/")) {
    return sourceDigest === finalDigest
      ? ["test-boundary"]
      : ["branding-domain", "test-boundary"];
  }
  if (sourceDigest === finalDigest) return [];
  if (sourcePath === "packages/lattice-crypto/package.json") {
    return ["package-name", "workspace-config"];
  }
  if (sourcePath === "packages/lattice-crypto/tsconfig.json") {
    return ["workspace-config"];
  }
  if (sourcePath === "scripts/build-openmls-wasm.sh") {
    return ["script-path", "artifact-provenance"];
  }
  if (
    sourcePath.startsWith("packages/lattice-crypto/openmls-wasm/")
    || sourcePath.startsWith("packages/lattice-crypto/vendor/openmls-wasm/")
  ) {
    return ["artifact-provenance"];
  }
  if (
    sourcePath.startsWith("packages/lattice-crypto/src/")
  ) {
    return ["branding-domain"];
  }
  throw new Error(`unapproved imported-file adaptation: ${sourcePath}`);
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (
    const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
  ) {
    if (entry.isFile() && entry.name === "tsconfig.tsbuildinfo") continue;
    if (
      entry.isDirectory()
      && [".turbo", "dist", "node_modules", "target"].includes(entry.name)
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`unsupported package entry: ${repositoryPath(path)}`);
  }
  return files;
}

const tree = git("rev-parse", `${sourceCommit}^{tree}`).toString().trim();
if (tree !== sourceRootTree) {
  throw new Error(`pinned source root tree drift: ${tree}`);
}

const sourceRows = git(
  "ls-tree",
  "-r",
  "-l",
  sourceCommit,
  "--",
  "packages/lattice-crypto",
  "scripts/build-openmls-wasm.sh",
  "LICENSE",
).toString().trim().split("\n").filter(Boolean);

const files = sourceRows.map((row) => {
  const match = row.match(
    /^(100644|100755) (blob) ([0-9a-f]{40})\s+(\d+)\t(.+)$/u,
  );
  if (!match) throw new Error(`unparseable git tree row: ${row}`);
  const [, sourceMode, sourceType, sourceBlobSha, sourceSize, sourcePath] = match;
  const sourceBytes = git("show", `${sourceCommit}:${sourcePath}`);
  const destinationPath = destinationFor(sourcePath!);
  const finalBytes = readFileSync(join(repositoryRoot, destinationPath));
  const sourceDigest = sha256(sourceBytes);
  const finalDigest = sha256(finalBytes);
  return {
    sourcePath,
    destinationPath,
    sourceMode,
    sourceType,
    sourceBlobSha,
    sourceSize: Number(sourceSize),
    sourceSha256: sourceDigest,
    destinationSha256BeforeAdaptation: sourceDigest,
    destinationSha256AfterAdaptation: finalDigest,
    adaptations: adaptationsFor(sourcePath!, sourceDigest, finalDigest),
  };
}).sort((left, right) => left.sourcePath!.localeCompare(right.sourcePath!));

if (files.length !== 57) {
  throw new Error(`pinned source file count drift: ${files.length}`);
}

const accounted = new Set(files.map((file) => file.destinationPath));
const evidencePath =
  "packages/lattice-crypto/provenance/lattice-lab-bun.lock";
accounted.add(evidencePath);

const generatedFiles = walk(packageRoot)
  .map(repositoryPath)
  .filter((path) =>
    path !== "packages/lattice-crypto/PROVENANCE.json"
    && !accounted.has(path)
  )
  .map((destinationPath) => ({
    destinationPath,
    destinationSha256: sha256(
      readFileSync(join(repositoryRoot, destinationPath)),
    ),
    reason: "M221 package provenance, verification, notice, or test evidence",
  }));

const workspacePaths = [
  ".github/workflows/lattice-crypto.yml",
  "bun.lock",
  "dev/tests/repo-invariants/lattice-crypto-import.test.ts",
  "eslint.config.mjs",
  "knip.json",
  "packages/encryption-invariants/package.json",
  "packages/encryption-invariants/stryker.config.mjs",
  "packages/encryption-invariants/src/node/source-inventory.ts",
  "packages/encryption-invariants/generated/encryption-coverage.md",
  "packages/encryption-invariants/tests/integration/dto-inventory-actual-source.test.ts",
  "packages/encryption-invariants/tests/integration/repository-inventory.test.ts",
  "packages/encryption-invariants/tests/integration/source-inventory-declarations.test.ts",
  "packaging/docker/Dockerfile",
].filter((path) => statSync(join(repositoryRoot, path)).isFile());

const workspaceAdaptations = workspacePaths.map((destinationPath) => ({
  destinationPath,
  destinationSha256AfterAdaptation: sha256(
    readFileSync(join(repositoryRoot, destinationPath)),
  ),
  adaptations: [
    "Register the dormant lattice-crypto workspace and enforce its M221 boundaries",
  ],
}));

const manifest = {
  schemaVersion: 1,
  source: {
    repository: "agentsea/lattice-lab",
    commit: sourceCommit,
    rootTree: sourceRootTree,
    objectFormat: "sha1",
  },
  sourceCommit,
  sourceRootTree,
  mechanicalImportCommit,
  manifestTrustBoundary: {
    excludedSelf: "packages/lattice-crypto/PROVENANCE.json",
    rule: "This manifest cannot hash itself; its reviewed Git blob authenticates it",
  },
  files,
  sourceRootEvidence: [{
    sourcePath: "bun.lock",
    destinationPath: evidencePath,
    sourceMode: "100644",
    sourceType: "blob",
    sourceBlobSha: "9eacbe994927bc8155afc29f5b7d03ef42928a87",
    sourceSize: 40_193,
    sourceSha256:
      "21404f3399ce3f5cf8132f0e495c6ed86df6620bd94922f4a22e2660c4d38cfe",
    purpose:
      "Preserves the audited Bun resolution, including @hpke/core 1.9.0 direct and 1.8.0 through ts-mls",
  }],
  generatedFiles,
  workspaceAdaptations,
};

writeFileSync(
  join(packageRoot, "PROVENANCE.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
