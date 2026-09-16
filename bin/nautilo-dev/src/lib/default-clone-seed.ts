import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { save } from "../commands/save";
import {
  assertCanonicalDefaultSourceEvidenceUnchanged,
  captureCanonicalDefaultSourceEvidence,
} from "../commands/clone";
import type { CloneSourceSelection } from "./clone-source-selection";
import {
  cloneSeedPaths,
  readCurrentCloneSeed,
  refreshCloneSeed,
  type CloneSeedHandle,
  type CloneSeedProvenance,
  type RefreshCloneSeedInput,
} from "./clone-seed-store";
import {
  verifyCanonicalDefaultFullBackupDirectory,
  type VerifiedFullBackup,
} from "./full-dev-backup";

export const CANONICAL_DEFAULT_CLONE_SEED_FORMAT_VERSION = 1 as const;
const CAPTURE_DIRECTORY = "capture";
const CAPTURE_NAME = "canonical-default";

export interface CanonicalDefaultSeedResult {
  readonly formatVersion: typeof CANONICAL_DEFAULT_CLONE_SEED_FORMAT_VERSION;
  readonly authority: "canonical-default";
  readonly freshness: "reused" | "fresh";
  readonly seed: CloneSeedHandle;
}

export interface CanonicalDefaultSourceEvidence {
  readonly capture: () => Promise<unknown>;
  readonly assertUnchanged: (before: unknown) => Promise<void>;
  /** Evaluated after capture against the verified manifest row anchors. */
  readonly assertManifestAnchors: (backup: VerifiedFullBackup) => Promise<void>;
}

/**
 * The production proof has no opt-out. Tests may inject the same three
 * observations, but dev-stack can call this directly rather than reconstruct
 * config/identity, ledger, Docker project/volume, and writer-state checks.
 */
export function createCanonicalDefaultSourceEvidence(
  source: CloneSourceSelection,
): CanonicalDefaultSourceEvidence {
  return {
    capture: () => captureCanonicalDefaultSourceEvidence(source),
    assertUnchanged: (before) => assertCanonicalDefaultSourceEvidenceUnchanged(
      before as Awaited<ReturnType<typeof captureCanonicalDefaultSourceEvidence>>,
      source,
    ),
    // `save` compares anchors while the source is quiesced, then the explicit
    // canonical verifier hashes that manifest. Re-querying after writers have
    // resumed would turn legitimate new writes into a false capture failure.
    assertManifestAnchors: () => Promise.resolve(),
  };
}

export interface PrepareCanonicalDefaultCloneSeedInput {
  /** Must be the explicit selector, never an alias parsed from user input. */
  readonly source: CloneSourceSelection;
  readonly root: string;
  readonly provenance: CloneSeedProvenance;
  readonly capture: () => Promise<VerifiedFullBackup>;
  /** Runs after an attempted fresh capture to bound known temporary state. */
  readonly cleanupCapture?: () => Promise<void>;
  readonly forceRefresh?: boolean;
  readonly now?: Date;
  readonly maxAgeMs?: number;
  /** Required before/after source-isolation proof; only its mechanics are injectable. */
  readonly sourceEvidence: CanonicalDefaultSourceEvidence;
  /** Narrow unit-test seam; production calls the bounded seed store directly. */
  readonly refresh?: (input: RefreshCloneSeedInput) => Promise<CloneSeedHandle>;
}

function assertCanonicalDefaultSource(source: CloneSourceSelection): void {
  if (source.kind !== "canonical-default" || source.instanceId !== "") {
    throw new Error("Canonical default seed capture requires the explicit canonical-default selector");
  }
}

function seedMatchesRequestedLineage(
  seed: CloneSeedHandle,
  expected: CloneSeedProvenance["lineage"],
): boolean {
  const actual = seed.operation.source.lineage;
  return actual.appliedMigrationCount === expected.appliedMigrationCount &&
    actual.lastAppliedIndex === expected.lastAppliedIndex &&
    actual.sha256 === expected.sha256;
}

function shouldRefreshForAge(
  seed: CloneSeedHandle,
  now: Date | undefined,
  maxAgeMs: number | undefined,
): boolean {
  if (now === undefined || maxAgeMs === undefined) return false;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error("Canonical clone-seed max age must be a nonnegative finite duration");
  }
  const capturedAt = Date.parse(seed.operation.capture.capturedAt);
  if (capturedAt > now.getTime()) {
    throw new Error("Canonical clone seed capture time is from the future; refusing refresh");
  }
  return now.getTime() - capturedAt > maxAgeMs;
}

/**
 * Read the current verified seed when it is valid for this checkout, otherwise
 * capture exactly one new source boundary.  A forced refresh is explicit in
 * the result; callers must not describe a reused seed as live-current data.
 */
export async function prepareCanonicalDefaultCloneSeed(
  input: PrepareCanonicalDefaultCloneSeedInput,
): Promise<CanonicalDefaultSeedResult> {
  assertCanonicalDefaultSource(input.source);
  const verify = verifyCanonicalDefaultFullBackupDirectory;
  const before = await input.sourceEvidence.capture();
  let sourceProofComplete = false;
  try {
    if (!input.forceRefresh) {
      const existing = await readCurrentCloneSeed({ root: input.root, verify });
      if (
        existing !== null &&
        seedMatchesRequestedLineage(existing, input.provenance.lineage) &&
        !shouldRefreshForAge(existing, input.now, input.maxAgeMs)
      ) {
        return {
          formatVersion: CANONICAL_DEFAULT_CLONE_SEED_FORMAT_VERSION,
          authority: "canonical-default",
          freshness: "reused",
          seed: existing,
        };
      }
    }
    const refresh = input.refresh ?? refreshCloneSeed;
    const seed = await refresh({
      root: input.root,
      // This proof intentionally lives inside the refresh capture callback:
      // refreshCloneSeed cannot publish its pointer until every source fact
      // (including manifest row anchors) still matches the pre-capture view.
      capture: async () => {
        const captured = await input.capture();
        const verified = await verify(captured.dir);
        await input.sourceEvidence.assertManifestAnchors(verified);
        await input.sourceEvidence.assertUnchanged(before);
        sourceProofComplete = true;
        return verified;
      },
      verify,
      provenance: input.provenance,
      ...(input.cleanupCapture === undefined ? {} : { cleanupCapture: input.cleanupCapture }),
      ...(input.now === undefined ? {} : { now: () => input.now! }),
    });
    return {
      formatVersion: CANONICAL_DEFAULT_CLONE_SEED_FORMAT_VERSION,
      authority: "canonical-default",
      freshness: "fresh",
      seed,
    };
  } finally {
    if (!sourceProofComplete) await input.sourceEvidence.assertUnchanged(before);
  }
}

export interface CanonicalDefaultCloneSeedReport {
  readonly formatVersion: typeof CANONICAL_DEFAULT_CLONE_SEED_FORMAT_VERSION;
  readonly authority: "canonical-default";
  readonly freshness: "reused" | "fresh";
  readonly capturedAt: string;
  readonly sourceLineage: CloneSeedProvenance["lineage"];
  readonly artifactBytes: number;
  readonly artifactCount: number;
  readonly seedGeneration: string;
}

export function canonicalDefaultCloneSeedReport(
  result: CanonicalDefaultSeedResult,
): CanonicalDefaultCloneSeedReport {
  return {
    formatVersion: CANONICAL_DEFAULT_CLONE_SEED_FORMAT_VERSION,
    authority: "canonical-default",
    freshness: result.freshness,
    capturedAt: result.seed.operation.capture.capturedAt,
    sourceLineage: result.seed.operation.source.lineage,
    artifactBytes: result.seed.operation.capture.artifactBytes,
    artifactCount: result.seed.operation.capture.artifactCount,
    seedGeneration: result.seed.generation,
  };
}

export function formatCanonicalDefaultCloneSeedReport(
  result: CanonicalDefaultSeedResult,
  json = false,
): string {
  const report = canonicalDefaultCloneSeedReport(result);
  if (json) return JSON.stringify(report);
  return (
    `[clone-default] ${report.freshness === "fresh" ? "captured fresh" : "reusing verified"} ` +
    `canonical default seed ${report.seedGeneration}; captured ${report.capturedAt}; ` +
    `migration ${report.sourceLineage.lastAppliedIndex}; ${report.artifactBytes} bytes ` +
    `across ${report.artifactCount} owner-only artifacts.`
  );
}

/** Dedicated, bounded temporary location -- never ordinary dev-snapshots. */
function canonicalDefaultSeedCaptureRoot(storeRoot: string): string {
  return join(resolve(storeRoot), CAPTURE_DIRECTORY);
}

function assertCaptureRootContained(storeRoot: string, captureRoot: string): void {
  const root = cloneSeedPaths(storeRoot).root;
  if (!captureRoot.startsWith(`${root}/`)) {
    throw new Error("Canonical clone-seed capture root escapes its seed store");
  }
}

async function clearBoundedCaptureDirectory(captureRoot: string): Promise<void> {
  await mkdir(captureRoot, { recursive: true, mode: 0o700 });
  await chmod(captureRoot, 0o700);
  // The name and staging prefix are controlled solely by this module. This is
  // intentionally not a broad recovery-snapshot cleanup.
  for (const entry of await readdir(captureRoot)) {
    if (entry === CAPTURE_NAME || entry.startsWith(`.${CAPTURE_NAME}.staging-`)) {
      await rm(join(captureRoot, entry), { recursive: true, force: true });
      continue;
    }
    throw new Error("Canonical clone-seed capture directory contains an unexpected entry");
  }
}

/**
 * Production capture callback for the seed repository. `save` retains its
 * normal cloneEligible=false default for empty-ID/local-self-host backups;
 * this function validates the artifact only with the explicit policy above.
 */
export function createCanonicalDefaultSeedCapture(storeRoot: string): () => Promise<VerifiedFullBackup> {
  const root = canonicalDefaultSeedCaptureRoot(storeRoot);
  return async () => {
    assertCaptureRootContained(storeRoot, root);
    await clearBoundedCaptureDirectory(root);
    try {
      await save(CAPTURE_NAME, {
        snapshotRoot: root,
        instanceEnv: {
          HOME: process.env["HOME"]?.trim() || homedir(),
          USERPROFILE: process.env["USERPROFILE"],
          PATH: process.env["PATH"],
          NAUTILO_INSTANCE_ID: "",
        },
      });
      return verifyCanonicalDefaultFullBackupDirectory(join(root, CAPTURE_NAME));
    } catch (error) {
      await rm(join(root, CAPTURE_NAME), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };
}

/** Remove only the known temporary capture after refresh has copied it. */
export async function cleanupCanonicalDefaultSeedCapture(storeRoot: string): Promise<void> {
  const root = canonicalDefaultSeedCaptureRoot(storeRoot);
  assertCaptureRootContained(storeRoot, root);
  await clearBoundedCaptureDirectory(root);
}
