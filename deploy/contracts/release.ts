import type { AuthPlanReport } from "./auth-plan.ts";

export type ReleaseArtifactMode = "source" | "registry";

/**
 * Read-only result of resolving the incoming server artifact. The identity is
 * deliberately Docker's immutable image ID, rather than a mutable registry tag.
 */
export type ReleaseArtifact = Readonly<{
  mode: ReleaseArtifactMode;
  requested: string;
  /**
   * Docker content-addressed image ID. This is always captured, including for
   * registry images, because a mutable tag is not recovery provenance.
   */
  immutableId: string;
  /** Registry digest when Docker exposes one for this image. */
  repoDigest?: string;
  /** Local retention tag created for a legacy source image. */
  archiveTag?: string;
}>;

export type ReleaseRecovery = "server-only" | "full-bundle";

/**
 * Durable, non-secret record of a release transition. `migrationsApplied` is
 * intentionally conservative: once the new server has been started, recovery
 * must assume its migrations may have committed and require a full bundle.
 */
export type ReleaseState = Readonly<{
  version: 1;
  createdAt: string;
  updatedAt: string;
  backupPath: string;
  legacy: ReleaseArtifact;
  incoming: ReleaseArtifact;
  migrationsApplied: boolean;
  recovery: ReleaseRecovery;
}>;

export type ReleasePlanReport = Readonly<{
  artifact: ReleaseArtifact;
  auth: AuthPlanReport;
  compatible: boolean;
  limitations: readonly string[];
}>;
