/**
 * Local structural type for the profile shape consumed by the
 * ComposeDriver. Mirrors the M113 schema in
 * `apps/cli/src/lib/profile-schema.ts` for the fields the driver
 * actually reads. We keep a duck-typed local type to avoid a
 * `@nautilo/compose-driver` → `@nautilo/cli` workspace dep (cycle
 * with the verb wiring that lives in the CLI) — the schema is the
 * source of truth at the CLI boundary; everything inside this
 * package should treat the profile as already-validated.
 */
export interface SshProfile {
  host: string;
  user: string;
  identity_file?: string | undefined;
  /** Dedicated known_hosts file; enables strict host-key verification. */
  known_hosts_file?: string | undefined;
  port?: number | undefined;
}

export interface ComposeDriverProfile {
  name: string;
  transport: "local" | "remote";
  lifecycle: "compose" | "external";
  instance_id?: string | undefined;
  /** Internal invocation strategy supplied by deploy/upgrade, never persisted in a profile. */
  from_source?: boolean | undefined;
  /** Full image-reference override supplied by `nautilo upgrade --image`. */
  image_ref?: string | undefined;
  office?: boolean | undefined;
  tag?: string | undefined;
  ssh?: SshProfile | undefined;
  remote_path?: string | undefined;
  base_url?: string | undefined;
  domain?: string | undefined;
  https?: "off" | "letsencrypt" | undefined;
  acme_email?: string | undefined;
  acme_staging?: boolean | undefined;
  password_recovery?: "oss_relay" | "logto_native" | "disabled" | undefined;
}

/**
 * D420 1.2.2 — the locked product-location matrix. The product has three
 * deployment locations but only two transport adapters: `local` uses the
 * local adapter; `lan` and `remote` both use the remote adapter and are
 * distinguished by HTTPS (`lan` runs HTTPS off, `remote` runs
 * letsencrypt over a public domain). No third transport enum exists.
 */
export type UpgradeLocation = "local" | "lan" | "remote";

/**
 * D420 R3 — mutually exclusive incoming artifact choice. `source` builds
 * from the checkout; `image` uses the configured/default ready image or a
 * full `--image` override reference. The two flags cannot coexist.
 */
export type UpgradeArtifact = "source" | "image";

/**
 * D420 R4 — replacement scope. `server-only` (the default) replaces only
 * `nautilo-server`; `full` replaces the whole Compose stack.
 */
export type UpgradeScope = "server-only" | "full";

/**
 * D420 R6 — how the previous immutable server image is captured so a
 * rollback can re-pin it. `running-container` inspects the live
 * nautilo-server container (server-only path); `backup-bundle` records the
 * prior image in the full backup bundle manifest (full path).
 */
export type PreviousImageCapture = "running-container" | "backup-bundle";

/**
 * D420 1.2.2 — the typed strategy that makes every cell of the
 * local/LAN/remote × image/source × server-only/full matrix explicit.
 * `resolveUpgradeStrategy` is the single source of truth that drives
 * transport selection, artifact preparation, service scope, and
 * previous-image capture. The strategy is request-scoped and never
 * persisted on a profile.
 */
export interface UpgradeStrategy {
  location: UpgradeLocation;
  /** Adapter selected from the locked two-adapter set. */
  transport: "local" | "remote";
  /** HTTPS profile distinguishing the two remote-adapter locations. */
  https: "off" | "letsencrypt";
  artifact: UpgradeArtifact;
  /**
   * Validated incoming canonical image reference for `image` cells, or `null`
   * for a source build.
   */
  imageRef: string | null;
  scope: UpgradeScope;
  previousImageCapture: PreviousImageCapture;
}

// ---------------------------------------------------------------------------
// D420 (Wave 2 task 2.2.5) — owning maintenance operation handle.
//
// The drain preflight enters the durable lease, polls/cancels executable work
// to zero, and then RETAINS the lease (it does NOT clear it on successful
// drain completion). It hands back this handle so the upgrade transaction can
// drive the `draining → applying` transition immediately before stopping
// `nautilo-server`, and best-effort release the lease on a backup failure.
//
// The successful upgrade path intentionally leaves `applying` in place: final
// success/rollback completion fencing is owned by Wave 3.1.3. A restored or
// abandoned `applying` record is safe — the owning CLI clears it after a
// healthy rollback, otherwise hard-expiry returns the server to `normal`.
// ---------------------------------------------------------------------------

/** Outcome of a best-effort maintenance lease release (cancel). */
export interface MaintenanceLeaseReleaseOutcome {
  /**
   * True when the cancel request succeeded (the lease was cleared or was
   * already released). False when the cancel request itself failed; in that
   * case {@link error} carries the failure reason for reporting. Hard-expiry
   * remains the safety net either way.
   */
  cancelled: boolean;
  /** Failure reason when {@link cancelled} is false; undefined on success. */
  error?: string;
}

/**
 * D420 (Wave 3 task 3.1.3) — outcome of an owning-operation maintenance lease
 * completion (`applying → normal`). Returned only on success; a completion
 * that cannot be confirmed (network / auth / transition / malformed / non-2xx
 * / a 200 that did not move THIS operation to `normal`) FAILS CLOSED by
 * throwing from {@link MaintenanceDrainHandle.completeLease}, so a caller can
 * never mistake a failed completion for a cleared lease. Hard-expiry remains
 * the safety net for a CLI that dies or a completion that fails.
 */
export interface MaintenanceLeaseCompletionOutcome {
  /**
   * True when the completion request succeeded AND the server confirmed the
   * owning operation returned to `normal`. Always `true` when this outcome is
   * returned — a failure throws instead.
   */
  completed: boolean;
}

/**
 * Owning handle for a maintenance drain lease, returned by the CLI drain
 * preflight and consumed by `ComposeDriver.upgrade`/`releaseApply`. The handle
 * closes over the authenticated operator transport + operation id; it never
 * exposes prompt/room/lane/job/user payload.
 */
export interface MaintenanceDrainHandle {
  /** Owning operation id retained across the drain → applying transition. */
  operationId: string;
  /**
   * Transition the owning maintenance operation `draining → applying` via the
   * authenticated operator endpoint. Fails closed (throws) on transition /
   * network / auth / malformed errors so the caller never proceeds to stop
   * the server or start a backup against an unsettled lease. The thrown error
   * identifies the failing category.
   */
  transitionApplying: () => Promise<void>;
  /**
   * Best-effort release of the owning maintenance lease (cancel). Never
   * throws: errors are captured into the returned outcome so a failure-path
   * caller can include "lease cleared" / "lease clear failed" in its report.
   * Hard-expiry remains the safety net if the cancel request itself fails.
   */
  releaseLease: () => Promise<MaintenanceLeaseReleaseOutcome>;
  /**
   * D420 (Wave 3 task 3.1.3) — owning-operation completion of the maintenance
   * lease (`applying → normal`). This is the SUCCESS / healthy-rollback
   * completion, called ONLY after a healthy new deployment or a healthy
   * full-bundle rollback has been proven. Unlike {@link releaseLease} (a
   * best-effort cancel used on abort paths), it FAILS CLOSED: a network /
   * auth / transition / malformed / non-2xx error, or a 200 that did not move
   * THIS operation to `normal`, propagates as a thrown error so the caller
   * NEVER reports "completed" when the completion call did not succeed. The
   * thrown error identifies the failing category. Hard-expiry remains the
   * safety net for a CLI that dies or a completion that fails; the lease is
   * left in `applying` until either this method succeeds or hard-expiry
   * reclaims it.
   */
  completeLease: () => Promise<MaintenanceLeaseCompletionOutcome>;
}
