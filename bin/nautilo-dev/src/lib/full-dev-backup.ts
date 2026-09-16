import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateNautiloInstanceIdValue } from "@nautilo/config";
import type { MigrationLineageEntry } from "./migration-lineage";

export const FULL_DEV_BACKUP_FORMAT_VERSION = 2 as const;
export const FULL_DEV_BACKUP_MANIFEST = "manifest.json";

export interface BackupArtifact {
  file: string;
  bytes: number;
  sha256: string;
}

export interface DevFullBackupManifestV2 {
  formatVersion: typeof FULL_DEV_BACKUP_FORMAT_VERSION;
  name: string;
  createdAt: string;
  sourceInstanceId: string;
  sourceDeploymentMode: "dev-multi-instance" | "local-self-host";
  capture: {
    consistency: "quiesced";
    nautiloWriterStopped: boolean;
    logtoWriterStopped: boolean;
  };
  artifacts: {
    nautiloDatabase: BackupArtifact;
    logtoDatabase: BackupArtifact;
    instanceEnv: BackupArtifact;
    nautiloHome: BackupArtifact;
  };
  drizzle: {
    lastAppliedIndex: number;
    entries: MigrationLineageEntry[];
  };
  postgres: {
    nautiloMajor: number;
    logtoMajor: number;
  };
  rowAnchors: Record<string, number>;
  complete: true;
  cloneEligible: boolean;
  backupMode: "dump" | "basebackup";
}

export interface VerifiedFullBackup {
  dir: string;
  manifest: DevFullBackupManifestV2;
}

/**
 * M234's ordinary verifier remains intentionally narrow.  The canonical
 * default has a separate, explicit admission policy because a recovery
 * snapshot must not become cloneable merely by being discovered elsewhere.
 */
export type FullBackupEligibilityPolicy =
  | "named-clone"
  | "canonical-default-seed";

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArtifact(value: unknown, label: string): BackupArtifact {
  if (
    !isRecord(value) ||
    typeof value["file"] !== "string" ||
    !SAFE_FILE_RE.test(value["file"]) ||
    typeof value["bytes"] !== "number" ||
    !Number.isSafeInteger(value["bytes"]) ||
    value["bytes"] < 0 ||
    typeof value["sha256"] !== "string" ||
    !SHA256_RE.test(value["sha256"])
  ) {
    throw new Error(`Invalid full-backup artifact: ${label}`);
  }
  return {
    file: value["file"],
    bytes: value["bytes"],
    sha256: value["sha256"],
  };
}

function parseLineage(value: unknown): MigrationLineageEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid full-backup migration lineage");
  return value.map((entry, position) => {
    if (
      !isRecord(entry) ||
      entry["index"] !== position ||
      typeof entry["tag"] !== "string" ||
      entry["tag"].trim() === "" ||
      typeof entry["createdAt"] !== "number" ||
      !Number.isFinite(entry["createdAt"]) ||
      typeof entry["sha256"] !== "string" ||
      !SHA256_RE.test(entry["sha256"])
    ) {
      throw new Error(`Invalid full-backup migration lineage entry ${position}`);
    }
    return {
      index: entry["index"],
      tag: entry["tag"],
      createdAt: entry["createdAt"],
      sha256: entry["sha256"],
    };
  });
}

export function parseFullBackupManifest(value: unknown): DevFullBackupManifestV2 {
  if (!isRecord(value) || value["formatVersion"] !== FULL_DEV_BACKUP_FORMAT_VERSION) {
    throw new Error("Unsupported or invalid full-backup manifest version");
  }
  if (
    typeof value["name"] !== "string" ||
    typeof value["createdAt"] !== "string" ||
    Number.isNaN(Date.parse(value["createdAt"])) ||
    typeof value["sourceInstanceId"] !== "string" ||
    (value["sourceDeploymentMode"] !== "dev-multi-instance" &&
      value["sourceDeploymentMode"] !== "local-self-host") ||
    value["complete"] !== true ||
    typeof value["cloneEligible"] !== "boolean" ||
    (value["backupMode"] !== "dump" && value["backupMode"] !== "basebackup") ||
    !isRecord(value["capture"]) ||
    value["capture"]["consistency"] !== "quiesced" ||
    typeof value["capture"]["nautiloWriterStopped"] !== "boolean" ||
    typeof value["capture"]["logtoWriterStopped"] !== "boolean" ||
    !isRecord(value["artifacts"]) ||
    !isRecord(value["drizzle"]) ||
    !isRecord(value["postgres"]) ||
    !isRecord(value["rowAnchors"])
  ) {
    throw new Error("Invalid full-backup manifest");
  }
  const entries = parseLineage(value["drizzle"]["entries"]);
  const lastAppliedIndex = value["drizzle"]["lastAppliedIndex"];
  if (
    typeof lastAppliedIndex !== "number" ||
    !Number.isInteger(lastAppliedIndex) ||
    lastAppliedIndex !== (entries.at(-1)?.index ?? -1)
  ) {
    throw new Error("Invalid full-backup last-applied migration index");
  }
  const nautiloMajor = value["postgres"]["nautiloMajor"];
  const logtoMajor = value["postgres"]["logtoMajor"];
  if (
    typeof nautiloMajor !== "number" ||
    !Number.isInteger(nautiloMajor) ||
    nautiloMajor < 1 ||
    typeof logtoMajor !== "number" ||
    !Number.isInteger(logtoMajor) ||
    logtoMajor < 1
  ) {
    throw new Error("Invalid full-backup PostgreSQL version metadata");
  }
  const rowAnchors: Record<string, number> = {};
  for (const [key, count] of Object.entries(value["rowAnchors"])) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`Invalid full-backup row anchor: ${key}`);
    }
    rowAnchors[key] = count as number;
  }

  return {
    formatVersion: FULL_DEV_BACKUP_FORMAT_VERSION,
    name: value["name"],
    createdAt: value["createdAt"],
    sourceInstanceId: value["sourceInstanceId"],
    sourceDeploymentMode: value["sourceDeploymentMode"],
    capture: {
      consistency: "quiesced",
      nautiloWriterStopped: value["capture"]["nautiloWriterStopped"],
      logtoWriterStopped: value["capture"]["logtoWriterStopped"],
    },
    artifacts: {
      nautiloDatabase: parseArtifact(
        value["artifacts"]["nautiloDatabase"],
        "nautiloDatabase",
      ),
      logtoDatabase: parseArtifact(value["artifacts"]["logtoDatabase"], "logtoDatabase"),
      instanceEnv: parseArtifact(value["artifacts"]["instanceEnv"], "instanceEnv"),
      nautiloHome: parseArtifact(value["artifacts"]["nautiloHome"], "nautiloHome"),
    },
    drizzle: { lastAppliedIndex, entries },
    postgres: { nautiloMajor, logtoMajor },
    rowAnchors,
    complete: true,
    cloneEligible: value["cloneEligible"],
    backupMode: value["backupMode"],
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function describeBackupArtifact(
  dir: string,
  file: string,
): Promise<BackupArtifact> {
  if (!SAFE_FILE_RE.test(file)) throw new Error(`Unsafe backup artifact name: ${file}`);
  const path = join(dir, file);
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Backup artifact is not a file: ${file}`);
  await chmod(path, 0o600);
  return {
    file,
    bytes: details.size,
    sha256: await sha256File(path),
  };
}

function artifactPathWithin(dir: string, artifact: BackupArtifact): string {
  const root = resolve(dir);
  const path = resolve(dir, artifact.file);
  if (path === root || !path.startsWith(`${root}/`)) {
    throw new Error(`Backup artifact escapes its directory: ${artifact.file}`);
  }
  return path;
}

function assertFullBackupEligible(
  manifest: DevFullBackupManifestV2,
  policy: FullBackupEligibilityPolicy = "named-clone",
): void {
  const common =
    manifest.complete &&
    manifest.backupMode === "dump" &&
    // `false` truthfully means that writer was not running and therefore did
    // not need pausing; quiescence itself is the capture safety assertion.
    manifest.capture.consistency === "quiesced";
  if (policy === "named-clone") {
    if (
      !common ||
      !manifest.cloneEligible ||
      manifest.sourceDeploymentMode !== "dev-multi-instance" ||
      manifest.sourceInstanceId === ""
    ) {
      throw new Error(`Backup ${manifest.name} is not clone-eligible`);
    }
    return;
  }
  if (
    !common ||
    // Default captures deliberately remain recovery-only to every generic
    // discovery path.  Only the caller selecting this policy may admit one.
    manifest.cloneEligible ||
    manifest.sourceDeploymentMode !== "local-self-host" ||
    manifest.sourceInstanceId !== ""
  ) {
    throw new Error(`Backup ${manifest.name} is not eligible for canonical default cloning`);
  }
}

export async function verifyFullBackupDirectory(
  dir: string,
  policy: FullBackupEligibilityPolicy = "named-clone",
): Promise<VerifiedFullBackup> {
  const manifestPath = join(dir, FULL_DEV_BACKUP_MANIFEST);
  const manifest = parseFullBackupManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const dirDetails = await stat(dir);
  if (!dirDetails.isDirectory() || (dirDetails.mode & 0o077) !== 0) {
    throw new Error(`Backup directory is not owner-only: ${dir}`);
  }
  if (
    manifest.name !== basename(dir) ||
    validateNautiloInstanceIdValue(manifest.sourceInstanceId) !== null
  ) {
    throw new Error("Backup manifest identity does not match its published directory");
  }
  const artifactFiles = Object.values(manifest.artifacts).map(
    (artifact) => artifact.file,
  );
  if (new Set(artifactFiles).size !== artifactFiles.length) {
    throw new Error("Backup manifest aliases required artifacts");
  }
  for (const artifact of Object.values(manifest.artifacts)) {
    const path = artifactPathWithin(dir, artifact);
    const details = await stat(path);
    if (
      !details.isFile() ||
      details.size !== artifact.bytes ||
      (details.mode & 0o077) !== 0 ||
      (details.mode & 0o400) === 0
    ) {
      throw new Error(`Backup artifact size mismatch: ${artifact.file}`);
    }
    if ((await sha256File(path)) !== artifact.sha256) {
      throw new Error(`Backup artifact hash mismatch: ${artifact.file}`);
    }
  }
  assertFullBackupEligible(manifest, policy);
  return { dir, manifest };
}

/** Explicit-only verifier; do not substitute this for generic snapshot discovery. */
export async function verifyCanonicalDefaultFullBackupDirectory(
  dir: string,
): Promise<VerifiedFullBackup> {
  return verifyFullBackupDirectory(dir, "canonical-default-seed");
}

export async function writeManifestFile(
  dir: string,
  manifest: DevFullBackupManifestV2,
): Promise<void> {
  const path = join(dir, FULL_DEV_BACKUP_MANIFEST);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(path, 0o600);
}

export async function discoverVerifiedFullBackups(
  snapshotsDir: string,
  sourceInstanceId: string,
): Promise<VerifiedFullBackup[]> {
  if (!existsSync(snapshotsDir)) return [];
  const verified: VerifiedFullBackup[] = [];
  for (const name of await readdir(snapshotsDir)) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const dir = join(snapshotsDir, name);
    try {
      const candidate = await verifyFullBackupDirectory(dir);
      if (candidate.manifest.sourceInstanceId === sourceInstanceId) {
        verified.push(candidate);
      }
    } catch {
      // Legacy, partial, corrupt, and ineligible snapshots are recovery-only.
    }
  }
  return verified.sort((a, b) =>
    b.manifest.createdAt.localeCompare(a.manifest.createdAt),
  );
}
