import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { setHostPortLivenessProbeExecutableForProcess } from "@nautilo/config";

/** This is integrity metadata only. D488 0C.6 signs the release root later. */
export const STANDALONE_ASSET_MANIFEST_SCHEMA = "nautilo-standalone-assets-v1";
const STANDALONE_SUPPORTED_PLATFORMS = ["darwin-arm64", "darwin-x64"] as const;

const GIT_COMMIT_RE = /^[a-f0-9]{40}$/;
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Files actually reached by the locked Compose lifecycle:
 *
 * - ComposeDriver reads docker-compose.yml directly;
 * - its remote/bundle paths read postgres-init.sh relative to templateDir;
 * - named-instance allocation runs the config host-port child probe.
 *
 * Examples and source-build contexts are deliberately not runtime assets.
 */
export const STANDALONE_RUNTIME_ASSET_PATHS = [
  "deploy/compose-driver/templates/docker-compose.yml",
  "infra/postgres-init.sh",
  "bin/host-port-probe",
] as const;

export type StandaloneAssetEntry = {
  path: string;
  size: number;
  sha256: string;
  mode: number;
};

export type StandaloneAssetManifest = {
  schema: typeof STANDALONE_ASSET_MANIFEST_SCHEMA;
  version: string;
  source: string;
  platform: string;
  assets: StandaloneAssetEntry[];
};

export type ResolvedStandaloneAssets = {
  source: "standalone" | "npm-dist" | "monorepo";
  assetRoot: string;
  templateDir: string;
  hostPortProbePath: string;
  manifest?: StandaloneAssetManifest;
};

export type StandaloneAssetResolverOptions = {
  /** Test seam; production relies on the module's real location. */
  moduleDir?: string;
  /** Test seam; production relies on the executing binary. */
  execPath?: string;
  /** Test seam; production detects Bun's compiled virtual filesystem. */
  compiled?: boolean;
};

function isCompiledBunModule(): boolean {
  return import.meta.url.startsWith("file:///$bunfs/");
}

function hasComposeTemplate(dir: string): boolean {
  try {
    const details = lstatSync(join(dir, "docker-compose.yml"));
    return details.isFile() && !details.isSymbolicLink();
  } catch {
    return false;
  }
}

function isNautiloMonorepoRoot(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name === "nautilo-monorepo";
  } catch {
    return false;
  }
}

function monorepoAssetRoot(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 12; depth++) {
    if (isNautiloMonorepoRoot(current)) {
      const templateDir = join(current, "deploy/compose-driver/templates");
      if (hasComposeTemplate(templateDir)) return current;
      return null;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid standalone asset manifest: ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(object: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid standalone asset manifest: ${label} has unexpected or missing fields.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid standalone asset manifest: ${label} must be a non-empty string.`);
  }
  return value;
}

function assertCliVersion(value: unknown): string {
  const version = assertNonEmptyString(value, "version");
  if (version.length > 128 || !SEMVER_RE.test(version)) {
    throw new Error("Invalid standalone asset manifest: version must be a strict semver-compatible CLI version.");
  }
  return version;
}

function assertSourceIdentity(value: unknown): string {
  const source = assertNonEmptyString(value, "source");
  if (!GIT_COMMIT_RE.test(source)) {
    throw new Error("Invalid standalone asset manifest: source must be a lowercase 40-character git commit ID.");
  }
  return source;
}

function assertSupportedPlatform(value: unknown): string {
  const platform = assertNonEmptyString(value, "platform");
  if (!(STANDALONE_SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
    throw new Error(`Invalid standalone asset manifest: unsupported platform ${platform}.`);
  }
  return platform;
}

function validateRelativeAssetPath(value: unknown): string {
  const path = assertNonEmptyString(value, "asset.path");
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid standalone asset manifest: asset path is not a safe relative POSIX path: ${path}.`);
  }
  return path;
}

export function parseStandaloneAssetManifest(raw: unknown): StandaloneAssetManifest {
  const manifest = assertPlainObject(raw, "root");
  assertExactKeys(manifest, ["schema", "version", "source", "platform", "assets"], "root");
  if (manifest["schema"] !== STANDALONE_ASSET_MANIFEST_SCHEMA) {
    throw new Error("Invalid standalone asset manifest: unsupported schema.");
  }
  const version = assertCliVersion(manifest["version"]);
  const source = assertSourceIdentity(manifest["source"]);
  const platform = assertSupportedPlatform(manifest["platform"]);
  if (!Array.isArray(manifest["assets"])) {
    throw new Error("Invalid standalone asset manifest: assets must be an array.");
  }

  const seen = new Set<string>();
  const assets = manifest["assets"].map((value, index) => {
    const asset = assertPlainObject(value, `assets[${index}]`);
    assertExactKeys(asset, ["path", "size", "sha256", "mode"], `assets[${index}]`);
    const path = validateRelativeAssetPath(asset["path"]);
    if (seen.has(path)) {
      throw new Error(`Invalid standalone asset manifest: duplicate asset path ${path}.`);
    }
    seen.add(path);
    const size = asset["size"];
    if (!Number.isSafeInteger(size) || (size as number) < 0) {
      throw new Error(`Invalid standalone asset manifest: asset size is invalid for ${path}.`);
    }
    const digest = asset["sha256"];
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Invalid standalone asset manifest: asset sha256 is invalid for ${path}.`);
    }
    const mode = asset["mode"];
    if (!Number.isSafeInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777) {
      throw new Error(`Invalid standalone asset manifest: asset mode is invalid for ${path}.`);
    }
    return { path, size: size as number, sha256: digest, mode: mode as number };
  });
  return { schema: STANDALONE_ASSET_MANIFEST_SCHEMA, version, source, platform, assets };
}

function walkAssetFiles(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    const details = lstatSync(fullPath);
    if (details.isSymbolicLink()) {
      throw new Error(`Standalone asset tree rejects symlink: ${relative(root, fullPath)}.`);
    }
    if (details.isDirectory()) {
      files.push(...walkAssetFiles(root, fullPath));
      continue;
    }
    if (!details.isFile()) {
      throw new Error(`Standalone asset tree rejects non-regular file: ${relative(root, fullPath)}.`);
    }
    files.push(relative(root, fullPath).split(sep).join("/"));
  }
  return files;
}

function containedPath(root: string, assetPath: string): string {
  const fullPath = resolve(root, assetPath);
  if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Standalone asset path escapes its root: ${assetPath}.`);
  }
  return fullPath;
}

/** Verify every shipped asset before a lifecycle command can reach Docker. */
export function verifyStandaloneAssetManifest(
  assetRoot: string,
  manifestInput: unknown,
): StandaloneAssetManifest {
  const root = resolve(assetRoot);
  let rootDetails;
  try {
    rootDetails = lstatSync(root);
  } catch {
    throw new Error(`Standalone asset root is missing: ${root}.`);
  }
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error(`Standalone asset root must be a real directory: ${root}.`);
  }
  const manifest = parseStandaloneAssetManifest(manifestInput);
  const actualFiles = walkAssetFiles(root);
  const expectedFiles = manifest.assets.map((asset) => asset.path).sort();
  const frozenFiles = [...STANDALONE_RUNTIME_ASSET_PATHS].sort();
  if (
    expectedFiles.length !== frozenFiles.length ||
    expectedFiles.some((path, index) => path !== frozenFiles[index])
  ) {
    throw new Error("Standalone asset manifest does not match the frozen runtime allowlist.");
  }
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((path, index) => path !== expectedFiles[index])
  ) {
    throw new Error("Standalone asset tree contains missing or unexpected files.");
  }
  for (const asset of manifest.assets) {
    const fullPath = containedPath(root, asset.path);
    const details = lstatSync(fullPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`Standalone asset must be a regular non-symlink file: ${asset.path}.`);
    }
    const bytes = readFileSync(fullPath);
    if (bytes.byteLength !== asset.size || sha256(bytes) !== asset.sha256) {
      throw new Error(`Standalone asset integrity check failed: ${asset.path}.`);
    }
    if ((details.mode & 0o777) !== asset.mode) {
      throw new Error(`Standalone asset mode check failed: ${asset.path}.`);
    }
  }
  return manifest;
}

export function createStandaloneAssetManifest(input: {
  assetRoot: string;
  version: string;
  source: string;
  platform: string;
}): StandaloneAssetManifest {
  const assetRoot = resolve(input.assetRoot);
  const assets = STANDALONE_RUNTIME_ASSET_PATHS.map((assetPath) => {
    const fullPath = containedPath(assetRoot, assetPath);
    const details = lstatSync(fullPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`Standalone build asset must be a regular non-symlink file: ${assetPath}.`);
    }
    const bytes = readFileSync(fullPath);
    return {
      path: assetPath,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      mode: details.mode & 0o777,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifest: StandaloneAssetManifest = {
    schema: STANDALONE_ASSET_MANIFEST_SCHEMA,
    version: assertCliVersion(input.version),
    source: assertSourceIdentity(input.source),
    platform: assertSupportedPlatform(input.platform),
    assets,
  };
  verifyStandaloneAssetManifest(assetRoot, manifest);
  return manifest;
}

function readPackagedManifest(path: string): StandaloneAssetManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Standalone artifact manifest is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseStandaloneAssetManifest(raw);
}

/**
 * Resolve Compose assets without allowing compiled Bun code to fall back into
 * an arbitrary source checkout. This function is called while creating the
 * driver, before any lifecycle provider or Docker call.
 */
export function resolveStandaloneAssets(
  options: StandaloneAssetResolverOptions = {},
): ResolvedStandaloneAssets {
  const moduleDir = options.moduleDir ?? import.meta.dirname;
  const compiled = options.compiled ?? isCompiledBunModule();
  if (compiled) {
    const executable = options.execPath ?? process.execPath;
    const bundleRoot = resolve(dirname(executable), "..");
    const assetRoot = join(bundleRoot, "share", "nautilo");
    const manifestPath = join(bundleRoot, "artifact-manifest.json");
    const manifest = verifyStandaloneAssetManifest(assetRoot, readPackagedManifest(manifestPath));
    const templateDir = join(assetRoot, "deploy/compose-driver/templates");
    if (!hasComposeTemplate(templateDir)) {
      throw new Error(`Standalone Compose template is missing from verified assets: ${templateDir}.`);
    }
    const hostPortProbePath = join(assetRoot, "bin/host-port-probe");
    setHostPortLivenessProbeExecutableForProcess(hostPortProbePath);
    return { source: "standalone", assetRoot, templateDir, hostPortProbePath, manifest };
  }

  const npmAssetRoot = resolve(moduleDir);
  const npmTemplateDir = join(npmAssetRoot, "deploy/compose-driver/templates");
  if (hasComposeTemplate(npmTemplateDir)) {
    return {
      source: "npm-dist",
      assetRoot: npmAssetRoot,
      templateDir: npmTemplateDir,
      hostPortProbePath: join(npmAssetRoot, "host-bundle-probe.cjs"),
    };
  }
  const monorepoRoot = monorepoAssetRoot(moduleDir);
  if (monorepoRoot !== null) {
    return {
      source: "monorepo",
      assetRoot: monorepoRoot,
      templateDir: join(monorepoRoot, "deploy/compose-driver/templates"),
      hostPortProbePath: join(monorepoRoot, "packages/config/src/host-bundle-probe.cjs"),
    };
  }
  throw new Error(
    "compose driver templates not found. Source/npm execution requires a packaged dist tree or Nautilo monorepo checkout.",
  );
}
