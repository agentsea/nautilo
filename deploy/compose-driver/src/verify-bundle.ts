import { createHash } from "node:crypto";
import { createReadStream, statSync as nodeStatSync, type Stats } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  backupManifestSchema,
  BUNDLE_INTEGRITY_FILES,
  manifestHasIntegrity,
  type BackupManifest,
  type BundleIntegrityKey,
  type FileIntegrity,
} from "./backup-manifest.ts";
import { runLocal } from "./remote-exec.ts";
import type { ExecFn, ExecResult } from "./ComposeDriver.ts";

/**
 * D427 Wave 1 (task 1.1.2) — read-only recovery-bundle verification.
 *
 * `nautilo backup verify <path>` calls this. It validates mandatory
 * members, per-file checksums/inventory (v2 only), DB-dump integrity,
 * manifest image identity, and restrictive local permissions — without
 * ever reading secret material (instance.env contents, dump rows) to
 * stdout. The returned report is the only thing the CLI prints.
 *
 * v1 bundles remain readable but cannot establish verified provenance:
 * they lack the per-file integrity inventory, so `ok` is false and no
 * `provenance` is produced. `adopt --confirm` requires a verified v2
 * bundle, so a v1 bundle is refused for confirmed adoption.
 */

export interface VerifyBundleDeps {
  fs: Pick<typeof nodeFs, "readFile" | "stat">;
  statSync: (path: string) => Stats;
  exec: ExecFn;
  now: () => Date;
}

export interface BundleVerificationCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export interface BundleProvenance {
  /** sha256 of the canonical manifest.json bytes on disk. */
  manifestSha256: string;
  /** Bundle creation timestamp from the manifest. */
  createdAt: string;
  /** When verification confirmed this bundle. */
  verifiedAt: string;
  imageMode: "registry" | "source";
  /** repoDigest (registry) or imageId/backupTag (source). */
  imageReference: string;
}

export interface BundleVerificationReport {
  ok: boolean;
  manifestVersion: 1 | 2;
  bundlePath: string;
  createdAt: string;
  profileName: string;
  instanceId: string;
  composeProjectName: string;
  transport: "local" | "remote";
  image: BackupManifest["image"];
  checks: BundleVerificationCheck[];
  provenance: BundleProvenance | undefined;
}

const MANDATORY_DUMPS: BundleIntegrityKey[] = ["nautiloDb", "logtoDb"];

function failCheck(
  checks: BundleVerificationCheck[],
  name: string,
  detail: string,
): void {
  checks.push({ name, status: "fail", detail });
}

function passCheck(
  checks: BundleVerificationCheck[],
  name: string,
  detail?: string,
): void {
  checks.push({ name, status: "pass", ...(detail ? { detail } : {}) });
}

function skipCheck(
  checks: BundleVerificationCheck[],
  name: string,
  detail: string,
): void {
  checks.push({ name, status: "skip", detail });
}

/** Restrictive permission check: no access for group or other. */
function modeIsRestrictive(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function imageReferenceOf(image: BackupManifest["image"]): string | undefined {
  if (image.mode === "registry") return image.repoDigest;
  return image.imageId ?? image.backupTag;
}

async function sha256OfFile(filePath: string): Promise<FileIntegrity> {
  const stat = await nodeFs.stat(filePath);
  const stream = createReadStream(filePath);
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return { sha256: hash.digest("hex"), sizeBytes: stat.size };
}

async function runDumpIntegrity(
  deps: VerifyBundleDeps,
  filePath: string,
): Promise<{ ok: boolean; reason?: string }> {
  // validateDumpScript: [ -f ] [ -s ] gzip -t. Re-implemented here so verify
  // stays a single local exec without importing the dump-script helper.
  const script = [
    `f=${shellQuote(filePath)}`,
    `[ -f "$f" ] || { printf 'dump missing\\n' >&2; exit 2; }`,
    `[ -s "$f" ] || { printf 'dump empty\\n' >&2; exit 3; }`,
    `gzip -t "$f" || { printf 'dump corrupt gzip\\n' >&2; exit 4; }`,
  ].join("; ");
  let res: ExecResult;
  try {
    res = await deps.exec("sh", ["-c", script], { stdio: "pipe" });
  } catch (e) {
    return { ok: false, reason: `exec failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.code === 0) return { ok: true };
  const reason = res.stderr.trim() || `exit ${res.code}`;
  return { ok: false, reason };
}

// Minimal shellQuote mirror of remote-exec.ts to avoid a cross-module import
// cycle; verify only interpolates an already-normalized bundle path.
function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function verifyBundle(
  rawBundlePath: string,
  deps?: Partial<VerifyBundleDeps>,
): Promise<BundleVerificationReport> {
  const fs = deps?.fs ?? nodeFs;
  const statSync = deps?.statSync ?? nodeStatSync;
  const exec = deps?.exec ?? runLocal;
  const now = deps?.now ?? (() => new Date());

  const checks: BundleVerificationCheck[] = [];
  const bundlePath = resolve(rawBundlePath);

  // Bundle directory exists and is a directory.
  try {
    const st = statSync(bundlePath);
    if (!st.isDirectory()) {
      failCheck(checks, "bundle directory", "path is not a directory");
      return negativeReport(bundlePath, checks);
    }
  } catch {
    failCheck(checks, "bundle directory", "bundle path does not exist or is unreadable");
    return negativeReport(bundlePath, checks);
  }

  // manifest.json readable + parses.
  const manifestPath = join(bundlePath, "manifest.json");
  let rawManifest: string;
  try {
    rawManifest = await fs.readFile(manifestPath, "utf8");
  } catch {
    failCheck(checks, "manifest", "manifest.json is missing or unreadable");
    return negativeReport(bundlePath, checks);
  }
  const manifestSha256 = createHash("sha256").update(rawManifest, "utf8").digest("hex");
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(rawManifest) as unknown;
  } catch {
    manifestJson = undefined;
  }
  const parsed = backupManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    failCheck(checks, "manifest", "manifest.json is not a valid backup manifest");
    return negativeReport(bundlePath, checks);
  }
  const manifest = parsed.data;
  passCheck(checks, "manifest", `v${manifest.version}`);

  // Local permission checks (fail-closed: bundle carries plaintext secrets).
  permissionChecks(bundlePath, manifestPath, statSync, checks, manifest);

  // Mandatory dump members exist.
  let mandatoryOk = true;
  for (const key of MANDATORY_DUMPS) {
    const file = BUNDLE_INTEGRITY_FILES[key];
    try {
      const st = statSync(join(bundlePath, file));
      if (!st.isFile()) {
        failCheck(checks, `mandatory member ${file}`, "not a regular file");
        mandatoryOk = false;
      }
    } catch {
      failCheck(checks, `mandatory member ${file}`, "missing");
      mandatoryOk = false;
    }
  }
  if (mandatoryOk) passCheck(checks, "mandatory members", "nautilo + logto dumps present");

  // Dump integrity (gzip -t + non-empty) for both mandatory dumps.
  let dumpIntegrityOk = true;
  for (const key of MANDATORY_DUMPS) {
    const file = BUNDLE_INTEGRITY_FILES[key];
    const filePath = join(bundlePath, file);
    try {
      statSync(filePath);
    } catch {
      // Already reported missing above; skip integrity.
      continue;
    }
    const res = await runDumpIntegrity({ fs, statSync, exec, now }, filePath);
    if (res.ok) {
      passCheck(checks, `dump integrity ${file}`);
    } else {
      failCheck(checks, `dump integrity ${file}`, res.reason ?? "failed");
      dumpIntegrityOk = false;
    }
  }

  // Image identity present.
  const imageRef = imageReferenceOf(manifest.image);
  if (manifest.image.mode === "registry" && manifest.image.repoDigest) {
    passCheck(checks, "image identity", `registry ${manifest.image.repoDigest}`);
  } else if (manifest.image.mode === "source" && imageRef) {
    passCheck(checks, "image identity", `source ${imageRef}`);
  } else {
    failCheck(checks, "image identity", "manifest has no usable image reference");
  }

  // Per-file integrity inventory (v2 only).
  let integrityOk = false;
  if (!manifestHasIntegrity(manifest)) {
    skipCheck(
      checks,
      "integrity inventory",
      "v1 manifest has no per-file integrity inventory; cannot establish verified provenance",
    );
  } else {
    integrityOk = await verifyIntegrity(bundlePath, manifest, checks);
  }

  const allPass =
    checks.every((c) => c.status !== "fail") &&
    mandatoryOk &&
    dumpIntegrityOk &&
    integrityOk &&
    manifestHasIntegrity(manifest) &&
    imageRef !== undefined;

  const verifiedAt = now().toISOString();
  const provenance: BundleProvenance | undefined =
    allPass && manifestHasIntegrity(manifest) && imageRef
      ? {
          manifestSha256,
          createdAt: manifest.createdAt,
          verifiedAt,
          imageMode: manifest.image.mode,
          imageReference: imageRef,
        }
      : undefined;

  return {
    ok: allPass,
    manifestVersion: manifest.version,
    bundlePath,
    createdAt: manifest.createdAt,
    profileName: manifest.profileName,
    instanceId: manifest.instanceId,
    composeProjectName: manifest.composeProjectName,
    transport: manifest.transport,
    image: manifest.image,
    checks,
    provenance,
  };
}

function negativeReport(
  bundlePath: string,
  checks: BundleVerificationCheck[],
): BundleVerificationReport {
  return {
    ok: false,
    manifestVersion: 1,
    bundlePath,
    createdAt: "",
    profileName: "",
    instanceId: "",
    composeProjectName: "",
    transport: "local",
    image: { mode: "registry" },
    checks,
    provenance: undefined,
  };
}

function permissionChecks(
  bundlePath: string,
  manifestPath: string,
  statSync: (path: string) => Stats,
  checks: BundleVerificationCheck[],
  manifest: BackupManifest,
): void {
  try {
    const mode = statSync(bundlePath).mode & 0o777;
    if (modeIsRestrictive(mode)) {
      passCheck(checks, "bundle permissions", `dir ${mode.toString(8)}`);
    } else {
      failCheck(
        checks,
        "bundle permissions",
        `bundle dir mode ${mode.toString(8)} grants group/other access (expected 0700)`,
      );
    }
  } catch {
    failCheck(checks, "bundle permissions", "bundle dir not statable");
  }
  try {
    const mode = statSync(manifestPath).mode & 0o777;
    if (modeIsRestrictive(mode)) {
      passCheck(checks, "manifest permissions", `manifest ${mode.toString(8)}`);
    } else {
      failCheck(
        checks,
        "manifest permissions",
        `manifest mode ${mode.toString(8)} grants group/other access (expected 0600)`,
      );
    }
  } catch {
    failCheck(checks, "manifest permissions", "manifest not statable");
  }
  if (manifest.contents.instanceEnv) {
    try {
      const envPath = join(bundlePath, "instance.env");
      const mode = statSync(envPath).mode & 0o777;
      if (modeIsRestrictive(mode)) {
        passCheck(checks, "instance.env permissions", `env ${mode.toString(8)}`);
      } else {
        failCheck(
          checks,
          "instance.env permissions",
          `instance.env mode ${mode.toString(8)} grants group/other access (expected 0600)`,
        );
      }
    } catch {
      failCheck(checks, "instance.env permissions", "instance.env not statable");
    }
  }
}

async function verifyIntegrity(
  bundlePath: string,
  manifest: BackupManifest & { version: 2 },
  checks: BundleVerificationCheck[],
): Promise<boolean> {
  let allOk = true;
  for (const key of Object.keys(BUNDLE_INTEGRITY_FILES) as BundleIntegrityKey[]) {
    const expected = manifest.integrity[key];
    const file = BUNDLE_INTEGRITY_FILES[key];
    const filePath = join(bundlePath, file);
    if (expected === undefined) {
      // Declared content but no inventory entry: only fail if the content
      // flag is true (the file should have been inventoried). Otherwise
      // the member was simply not captured.
      if (manifest.contents[key]) {
        failCheck(checks, `integrity ${file}`, "contents flag set but no inventory entry");
        allOk = false;
      }
      continue;
    }
    let actual: FileIntegrity;
    try {
      actual = await sha256OfFile(filePath);
    } catch {
      failCheck(checks, `integrity ${file}`, "member file missing or unreadable");
      allOk = false;
      continue;
    }
    if (actual.sha256 !== expected.sha256) {
      failCheck(
        checks,
        `integrity ${file}`,
        `checksum mismatch (expected ${expected.sha256.slice(0, 12)}…, got ${actual.sha256.slice(0, 12)}…)`,
      );
      allOk = false;
    } else if (actual.sizeBytes !== expected.sizeBytes) {
      failCheck(
        checks,
        `integrity ${file}`,
        `size mismatch (expected ${expected.sizeBytes}, got ${actual.sizeBytes})`,
      );
      allOk = false;
    } else {
      passCheck(checks, `integrity ${file}`, `${actual.sizeBytes} bytes`);
    }
  }
  return allOk;
}
