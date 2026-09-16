import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  createStandaloneAssetManifest,
  parseStandaloneAssetManifest,
  STANDALONE_RUNTIME_ASSET_PATHS,
  verifyStandaloneAssetManifest,
} from "../src/lib/standalone-assets.ts";
import {
  auditStandaloneNativeBinary,
  type StandaloneNativeAuditReceipt,
} from "../src/lib/standalone-native-audit.ts";
import { createStandaloneDependencyEvidence } from "../src/lib/standalone-dependency-evidence.ts";
import { VERSION } from "../src/version.ts";
import {
  signStandaloneNativeExecutable,
  type StandaloneCompilerConfigurationReceiptV1,
} from "./compile-standalone-native.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SCRIPT_DIR, "..");
const MONOREPO_ROOT = resolve(CLI_ROOT, "..", "..");

export type StandaloneBuildOptions = {
  output: string;
  target: string;
  version: string;
  source: string;
};

export type ArchiveEntry = {
  path: string;
  bytes: Buffer;
  mode: number;
};

export function assertStandaloneVersionBinding(candidateVersion: string, compiledVersion = VERSION): void {
  if (candidateVersion !== compiledVersion) {
    throw new Error(
      `Standalone candidate version ${candidateVersion} does not match compiled CLI version ${compiledVersion}.`,
    );
  }
}

export function standaloneQualificationInstanceId(qualificationRoot: string): string {
  return `q-${createHash("sha256").update(qualificationRoot).digest("hex").slice(0, 12)}`;
}

function requireValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sourceIdentity(): string {
  try {
    const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: MONOREPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (dirty.trim() !== "") {
      throw new Error("Standalone builds require a clean source tree; commit or discard unrelated changes first.");
    }
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: MONOREPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.startsWith("Standalone builds require")
        ? error.message
        : "Cannot determine standalone source identity from a clean git HEAD; pass --source explicitly for test-only builds.",
    );
  }
}

function cliVersion(): string {
  const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
    throw new Error("apps/cli/package.json has no usable version.");
  }
  return pkg.version;
}

export function nativeStandaloneBunTarget(): string {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) {
    throw new Error(
      `Standalone native candidates are currently supported only on macOS arm64/x64; current host is ${process.platform}-${process.arch}.`,
    );
  }
  return `bun-darwin-${process.arch}`;
}

function assertGitSourceIdentity(source: string): string {
  if (!/^[a-f0-9]{40}$/.test(source)) {
    throw new Error("Standalone build source must be an exact lowercase 40-character git commit ID.");
  }
  return source;
}

export function parseStandaloneBuildOptions(
  argv: readonly string[],
  nativeTarget: string = nativeStandaloneBunTarget(),
): StandaloneBuildOptions {
  const output = requireValue(argv, "output");
  if (output === undefined || output.trim() === "") {
    throw new Error("Standalone build requires --output <empty directory>.");
  }
  const target = requireValue(argv, "target") ?? nativeTarget;
  if (target !== nativeTarget) {
    throw new Error(
      `Standalone candidate target must equal this native macOS host (${nativeTarget}); cross-target builds are not accepted.`,
    );
  }
  const version = requireValue(argv, "version") ?? cliVersion();
  const source = assertGitSourceIdentity(requireValue(argv, "source") ?? sourceIdentity());
  return { output: resolve(output), target, version, source };
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  target.write(encoded, offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`USTAR field is too long: ${value}.`);
  bytes.copy(target, offset);
}

function splitUstarPath(path: string): { name: string; prefix?: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path };
  const separator = path.lastIndexOf("/");
  if (separator <= 0) throw new Error(`USTAR path is too long: ${path}.`);
  const prefix = path.slice(0, separator);
  const name = path.slice(separator + 1);
  if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
    throw new Error(`USTAR path is too long: ${path}.`);
  }
  return { name, prefix };
}

function ustarHeader(entry: ArchiveEntry): Buffer {
  if (entry.path.startsWith("/") || entry.path.includes("..")) {
    throw new Error(`Unsafe or unsupported archive path: ${entry.path}.`);
  }
  const path = splitUstarPath(entry.path);
  const header = Buffer.alloc(512, 0);
  writeString(header, 0, 100, path.name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  if (path.prefix !== undefined) writeString(header, 345, 155, path.prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

/** Deterministic USTAR+gzip bytes: stable order, zero ownership and epoch mtime. */
export function createDeterministicArchive(entries: readonly ArchiveEntry[]): Buffer {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const names = new Set<string>();
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    if (names.has(entry.path)) throw new Error(`Duplicate archive path: ${entry.path}.`);
    names.add(entry.path);
    chunks.push(ustarHeader(entry), entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  // Node/Bun's gzip writer emits mtime=0 by default for reproducible archives.
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function assertRegularSourceAsset(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Standalone source asset must be a regular non-symlink file: ${path}.`);
  }
}

function copyRuntimeAssets(assetRoot: string): void {
  for (const relativePath of STANDALONE_RUNTIME_ASSET_PATHS) {
    if (relativePath === "bin/host-port-probe") continue;
    const source = join(MONOREPO_ROOT, relativePath);
    assertRegularSourceAsset(source);
    const destination = join(assetRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    cpSync(source, destination, { preserveTimestamps: false });
    chmodSync(destination, lstatSync(source).mode & 0o777);
  }
}

function compileHostPortProbe(assetRoot: string, target: string): void {
  const helper = join(assetRoot, "bin/host-port-probe");
  mkdirSync(dirname(helper), { recursive: true, mode: 0o755 });
  const compile = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    "packages/config/src/host-bundle-probe.cjs",
    `--target=${target}`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    `--outfile=${helper}`,
  ], { cwd: MONOREPO_ROOT, stdout: "pipe", stderr: "pipe" });
  if (compile.exitCode !== 0) {
    throw new Error(`Standalone host port probe compile failed: ${new TextDecoder().decode(compile.stderr)}`);
  }
  chmodSync(helper, 0o755);
  signStandaloneNativeExecutable(helper);
}

function compileNativeExecutable(input: {
  entrypoint: string;
  outfile: string;
  target: string;
  metafile?: string;
  configurationReceipt?: string;
}): void {
  const compile = Bun.spawnSync([
    process.execPath,
    join(SCRIPT_DIR, "compile-standalone-native.ts"),
    `--entrypoint=${input.entrypoint}`,
    `--outfile=${input.outfile}`,
    `--target=${input.target}`,
    ...(input.metafile === undefined ? [] : [`--metafile=${input.metafile}`]),
    ...(input.configurationReceipt === undefined ? [] : [`--configuration-receipt=${input.configurationReceipt}`]),
  ], { cwd: CLI_ROOT, stdout: "pipe", stderr: "pipe" });
  if (compile.exitCode !== 0) {
    throw new Error(`Standalone native compile failed: ${new TextDecoder().decode(compile.stderr)}`);
  }
}

export function parseExactBooleanReceipt(input: {
  stdout: Uint8Array;
  expectedPlatform: string;
  booleanFields: readonly string[];
  label: string;
}): void {
  let receipt: unknown;
  try {
    receipt = JSON.parse(new TextDecoder().decode(input.stdout));
  } catch {
    throw new Error(`Standalone qualification ${input.label} returned an invalid receipt.`);
  }
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`Standalone qualification ${input.label} returned an invalid receipt.`);
  }
  const record = receipt as Record<string, unknown>;
  const expectedKeys = ["schemaVersion", "platform", ...input.booleanFields].sort();
  if (
    Object.keys(record).sort().join(",") !== expectedKeys.join(",") ||
    record["schemaVersion"] !== 1 ||
    record["platform"] !== input.expectedPlatform ||
    input.booleanFields.some((field) => record[field] !== true)
  ) {
    throw new Error(`Standalone qualification ${input.label} returned an invalid receipt.`);
  }
}

export function assertStandaloneHostPlanReceipt(input: {
  exitCode: number;
  stdout: string;
  stderr: string;
  providerCanary: string;
}): void {
  let receipt: unknown;
  try {
    receipt = JSON.parse(input.stdout);
  } catch {
    throw new Error("Standalone qualification host plan did not return JSON.");
  }
  if (
    input.exitCode !== 2 ||
    input.stderr !== "" ||
    input.stdout.includes(input.providerCanary) ||
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    !("schemaVersion" in receipt) ||
    receipt.schemaVersion !== 1 ||
    !("operation" in receipt) ||
    receipt.operation !== "plan" ||
    !("backend" in receipt) ||
    receipt.backend !== "railway" ||
    !("mutationAuthorized" in receipt) ||
    receipt.mutationAuthorized !== false ||
    !("outcome" in receipt) ||
    typeof receipt.outcome !== "string" ||
    receipt.outcome.length === 0
  ) {
    throw new Error("Standalone qualification host plan violated its redacted mutation-free JSON contract.");
  }
}

function platformFromTarget(target: string): string {
  return target.replace(/^bun-/, "");
}

function archiveEntries(bundleRoot: string, bundleName: string): ArchiveEntry[] {
  const paths = [
    "artifact-manifest.json",
    "bin/nautilo",
    ...STANDALONE_RUNTIME_ASSET_PATHS.map((path) => `share/nautilo/${path}`),
  ];
  return paths.map((relativePath) => {
    const fullPath = join(bundleRoot, relativePath);
    const details = lstatSync(fullPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`Standalone archive input must be a regular non-symlink file: ${relativePath}.`);
    }
    return {
      path: `${bundleName}/${relativePath}`,
      bytes: readFileSync(fullPath),
      mode: details.mode & 0o777,
    };
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertEmptyStandaloneOutputDirectory(output: string): void {
  const outputParent = dirname(output);
  mkdirSync(outputParent, { recursive: true, mode: 0o755 });
  mkdirSync(output, { recursive: true, mode: 0o755 });
  if (readdirSync(output).length !== 0) {
    throw new Error("Standalone build output directory must be empty.");
  }
}

export function buildStandaloneCandidate(options: StandaloneBuildOptions): {
  bundleRoot: string;
  archivePath: string;
  archiveSha256: string;
  sbomPath: string;
  licenseInventoryPath: string;
  compilerConfiguration: StandaloneCompilerConfigurationReceiptV1;
  nativeAudit: StandaloneNativeAuditReceipt;
} {
  assertStandaloneVersionBinding(options.version);
  const outputParent = dirname(options.output);
  assertEmptyStandaloneOutputDirectory(options.output);
  const workRoot = mkdtempSync(join(outputParent, ".nautilo-standalone-build-"));
  const bundleName = `nautilo-cli-${options.version}-${platformFromTarget(options.target)}`;
  const stagedBundle = join(workRoot, bundleName);
  const stagedBinary = join(stagedBundle, "bin", "nautilo");
  const compilerMetafile = join(workRoot, "compiler-metafile.json");
  const compilerConfigurationPath = join(workRoot, "compiler-configuration.json");
  const assetRoot = join(stagedBundle, "share", "nautilo");
  try {
    mkdirSync(dirname(stagedBinary), { recursive: true, mode: 0o755 });
    compileNativeExecutable({
      entrypoint: join(CLI_ROOT, "src/server-admin-index.ts"),
      outfile: stagedBinary,
      target: options.target,
      metafile: compilerMetafile,
      configurationReceipt: compilerConfigurationPath,
    });
    chmodSync(stagedBinary, 0o755);
    const nativeAudit = auditStandaloneNativeBinary({
      binaryPath: stagedBinary,
      platform: platformFromTarget(options.target),
      forbiddenRoots: [MONOREPO_ROOT],
    });
    copyRuntimeAssets(assetRoot);
    compileHostPortProbe(assetRoot, options.target);
    const manifest = createStandaloneAssetManifest({
      assetRoot,
      version: options.version,
      source: options.source,
      platform: platformFromTarget(options.target),
    });
    const manifestPath = join(stagedBundle, "artifact-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    verifyStandaloneAssetManifest(assetRoot, JSON.parse(readFileSync(manifestPath, "utf8")));

    const stagedArchive = join(workRoot, `${bundleName}.tar.gz`);
    writeFileSync(
      stagedArchive,
      createDeterministicArchive(archiveEntries(stagedBundle, bundleName)),
      { mode: 0o644 },
    );
    const finalBundle = join(options.output, bundleName);
    const finalArchive = join(options.output, `${bundleName}.tar.gz`);
    const finalSbom = join(options.output, `${bundleName}.sbom.cdx.json`);
    const finalLicenses = join(options.output, `${bundleName}.licenses.json`);
    if (exists(finalBundle) || exists(finalArchive)) {
      throw new Error(`Standalone output already contains ${bundleName}; choose an empty output directory.`);
    }
    renameSync(stagedBundle, finalBundle);
    renameSync(stagedArchive, finalArchive);
    const archiveSha256 = sha256(finalArchive);
    const compilerConfiguration = JSON.parse(
      readFileSync(compilerConfigurationPath, "utf8"),
    ) as StandaloneCompilerConfigurationReceiptV1;
    const dependencyEvidence = createStandaloneDependencyEvidence({
      metafileBytes: readFileSync(compilerMetafile),
      monorepoRoot: MONOREPO_ROOT,
      compilerWorkingDirectory: CLI_ROOT,
      source: options.source,
      platform: platformFromTarget(options.target),
      version: options.version,
      archiveSha256,
      compilerInputSha256Overrides: {
        [compilerConfiguration.embeddedNativeBindingInput]: compilerConfiguration.embeddedNativeBindingSha256,
      },
    });
    writeFileSync(finalSbom, `${JSON.stringify(dependencyEvidence.sbom, null, 2)}\n`, { mode: 0o644 });
    writeFileSync(finalLicenses, `${JSON.stringify(dependencyEvidence.licenses, null, 2)}\n`, { mode: 0o644 });
    return {
      bundleRoot: finalBundle,
      archivePath: finalArchive,
      archiveSha256,
      sbomPath: finalSbom,
      licenseInventoryPath: finalLicenses,
      compilerConfiguration,
      nativeAudit,
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

export type StandaloneRuntimeQualificationReceiptV1 = {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly version: string;
  readonly platform: string;
  readonly archiveSha256: string;
  readonly versionAndHelp: true;
  readonly composeAssetBoundary: true;
  readonly nativePortProbe: true;
  readonly hostPlanRedacted: true;
  readonly keychainWriteReadDelete: true;
  readonly durableCredentialStore: true;
  readonly railwayOauthPkce: true;
};

/**
 * Checkout-free, no-provider-mutation acceptance for a current-platform
 * candidate. A fake docker executable records the first Compose argv, then
 * returns harmless JSON; `status` is expected to stop at its local HTTP probe.
 */
export function qualifyStandaloneCandidate(candidate: {
  archivePath: string;
}): StandaloneRuntimeQualificationReceiptV1 {
  const qualificationRoot = mkdtempSync(join(tmpdir(), "nautilo-standalone-qualification-"));
  try {
    const extracted = join(qualificationRoot, "extracted");
    mkdirSync(extracted, { recursive: true, mode: 0o755 });
    const untar = Bun.spawnSync(["tar", "-xzf", candidate.archivePath, "-C", extracted], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (untar.exitCode !== 0) {
      throw new Error(`Standalone qualification could not extract archive: ${new TextDecoder().decode(untar.stderr)}`);
    }
    const entries = readdirSync(extracted);
    if (entries.length !== 1) throw new Error("Standalone qualification expected one versioned archive root.");
    const bundleRoot = join(extracted, entries[0]!);
    const binary = join(bundleRoot, "bin/nautilo");
    const helper = join(bundleRoot, "share/nautilo/bin/host-port-probe");
    const template = join(bundleRoot, "share/nautilo/deploy/compose-driver/templates/docker-compose.yml");
    for (const required of [binary, helper, template, join(bundleRoot, "artifact-manifest.json")]) {
      const details = lstatSync(required);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error(`Standalone qualification archive is missing a regular required file: ${required}.`);
      }
    }
    const artifactManifest = parseStandaloneAssetManifest(JSON.parse(
      readFileSync(join(bundleRoot, "artifact-manifest.json"), "utf8"),
    ));
    auditStandaloneNativeBinary({
      binaryPath: binary,
      platform: artifactManifest.platform,
      forbiddenRoots: [MONOREPO_ROOT],
    });

    for (const args of [["--version"], ["--help"]] as const) {
      const smoke = Bun.spawnSync([binary, ...args], { stdout: "pipe", stderr: "pipe" });
      if (smoke.exitCode !== 0) {
        throw new Error(`Standalone qualification ${args[0]} failed: ${new TextDecoder().decode(smoke.stderr)}`);
      }
    }

    const home = join(qualificationRoot, "home");
    const fakeBin = join(qualificationRoot, "fake-bin");
    const dockerArgs = join(qualificationRoot, "docker-args.txt");
    const qualificationInstanceId = standaloneQualificationInstanceId(qualificationRoot);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(fakeBin, { recursive: true, mode: 0o755 });
    const fakeDocker = join(fakeBin, "docker");
    writeFileSync(fakeDocker, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$NAUTILO_FAKE_DOCKER_ARGS\"\nprintf '[]\\n'\n", { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    const qualificationEnv = {
      HOME: home,
      PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      NAUTILO_FAKE_DOCKER_ARGS: dockerArgs,
    };
    // Qualification must exercise the shipped onboarding surface rather than
    // fabricating its private profile files. The public command owns both the
    // TOML schema and active-profile selection for a fresh Compose operator.
    const profileAdd = Bun.spawnSync([
      binary,
      "profile",
      "add",
      "qualification",
      "--transport=local",
      "--lifecycle=compose",
      `--instance-id=${qualificationInstanceId}`,
      "--yes",
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: qualificationEnv,
    });
    if (profileAdd.exitCode !== 0) {
      throw new Error(`Standalone qualification profile add failed: ${new TextDecoder().decode(profileAdd.stderr)}`);
    }
    const profileList = Bun.spawnSync([binary, "profile", "list"], {
      stdout: "pipe",
      stderr: "pipe",
      env: qualificationEnv,
    });
    if (
      profileList.exitCode !== 0 ||
      !new TextDecoder().decode(profileList.stdout).split("\n").includes("qualification")
    ) {
      throw new Error(`Standalone qualification profile list failed: ${new TextDecoder().decode(profileList.stderr)}`);
    }
    const boundary = Bun.spawnSync([binary, "status"], {
      stdout: "pipe",
      stderr: "pipe",
      env: qualificationEnv,
    });
    // A unique qualification instance cannot collide with retained local
    // Compose resources. The fake Docker inventory therefore proves the
    // mutation-free, clean-absent status contract without making an HTTP call.
    if (boundary.exitCode !== 0) {
      throw new Error(`Standalone qualification status expected clean absence, got ${boundary.exitCode}.`);
    }
    const recorded = readFileSync(dockerArgs, "utf8");
    if (!recorded.includes(`label=com.docker.compose.project=nautilo-${qualificationInstanceId}`)) {
      throw new Error("Standalone qualification did not inspect the isolated Compose project.");
    }
    const providerCanary = `sk-or-v1-${"q".repeat(48)}`;
    const hostPlan = Bun.spawnSync([binary, "host", "plan", "--backend", "railway", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        HOME: home,
        PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        NAUTILO_RAILWAY_OAUTH_PERSISTENCE: "memory",
        OPENROUTER_API_KEY: providerCanary,
      },
    });
    const hostPlanStdout = new TextDecoder().decode(hostPlan.stdout);
    const hostPlanStderr = new TextDecoder().decode(hostPlan.stderr);
    assertStandaloneHostPlanReceipt({
      exitCode: hostPlan.exitCode,
      stdout: hostPlanStdout,
      stderr: hostPlanStderr,
      providerCanary,
    });

    const keyringProbe = join(qualificationRoot, "qualify-keyring");
    compileNativeExecutable({
      entrypoint: join(SCRIPT_DIR, "qualify-standalone-keyring.ts"),
      outfile: keyringProbe,
      target: `bun-${artifactManifest.platform}`,
    });
    const keyring = Bun.spawnSync([keyringProbe], { stdout: "pipe", stderr: "pipe" });
    if (keyring.exitCode !== 0) {
      throw new Error(`Standalone qualification Keychain probe failed: ${new TextDecoder().decode(keyring.stderr)}`);
    }
    parseExactBooleanReceipt({
      stdout: keyring.stdout,
      expectedPlatform: artifactManifest.platform,
      booleanFields: ["keychainWriteRead", "keychainDeleteVerified"],
      label: "Keychain probe",
    });

    const durableStore = Bun.spawnSync([binary, "host", "plan", "--backend", "railway", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        HOME: home,
        PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      },
    });
    let durableStoreReceipt: unknown;
    try {
      durableStoreReceipt = JSON.parse(new TextDecoder().decode(durableStore.stdout));
    } catch {
      throw new Error("Standalone qualification durable credential store returned an invalid receipt.");
    }
    if (
      durableStoreReceipt === null ||
      typeof durableStoreReceipt !== "object" ||
      Array.isArray(durableStoreReceipt)
    ) {
      throw new Error("Standalone qualification could not open the shipped main binary durable credential store.");
    }
    const durableStoreRecord = durableStoreReceipt as Record<string, unknown>;
    const durableStoreError = durableStoreRecord["error"] as Record<string, unknown> | undefined;
    if (
      durableStore.exitCode !== 2 ||
      durableStoreRecord["outcome"] !== "authorization-required" ||
      durableStoreError?.["reason"] !== "reauthorization-required"
    ) {
      throw new Error("Standalone qualification could not open the shipped main binary durable credential store.");
    }

    const oauthProbe = join(qualificationRoot, "qualify-railway-oauth");
    compileNativeExecutable({
      entrypoint: join(SCRIPT_DIR, "qualify-standalone-railway-oauth.ts"),
      outfile: oauthProbe,
      target: `bun-${artifactManifest.platform}`,
    });
    const oauth = Bun.spawnSync([oauthProbe], { stdout: "pipe", stderr: "pipe" });
    if (oauth.exitCode !== 0) {
      throw new Error(`Standalone qualification Railway OAuth probe failed: ${new TextDecoder().decode(oauth.stderr)}`);
    }
    parseExactBooleanReceipt({
      stdout: oauth.stdout,
      expectedPlatform: artifactManifest.platform,
      booleanFields: [
        "fixedLoopbackCallback",
        "pkceTokenFormValidated",
        "browserBoundaryLocalOnly",
        "tokenRedacted",
      ],
      label: "Railway OAuth probe",
    });
    return {
      schemaVersion: 1,
      source: artifactManifest.source,
      version: artifactManifest.version,
      platform: artifactManifest.platform,
      archiveSha256: sha256(candidate.archivePath),
      versionAndHelp: true,
      composeAssetBoundary: true,
      nativePortProbe: true,
      hostPlanRedacted: true,
      keychainWriteReadDelete: true,
      durableCredentialStore: true,
      railwayOauthPkce: true,
    };
  } finally {
    rmSync(qualificationRoot, { recursive: true, force: true });
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  try {
    const options = parseStandaloneBuildOptions(process.argv.slice(2));
    const result = buildStandaloneCandidate(options);
    const runtimeQualification = process.argv.includes("--qualify")
      ? qualifyStandaloneCandidate(result)
      : undefined;
    process.stdout.write(`${JSON.stringify({ ...result, ...(runtimeQualification === undefined ? {} : { runtimeQualification }) })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
