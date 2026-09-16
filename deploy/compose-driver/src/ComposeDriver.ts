import { readArtifactRelocationBackup } from "./artifact-relocation-backup.ts";
import { ARTIFACT_RELOCATION_FILE_PROBE, planArtifactRelocation, applyArtifactRelocation, type ArtifactRelocationPlan, type ArtifactRelocationDeps, type RelocationTarget, type RelocationFile } from "./artifact-relocation.ts";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import {
  __resetResolvedInstanceForTests,
  passwordRecoveryUsesOssRelay,
  resolveInstance,
  type ResolvedInstance,
} from "@nautilo/config";
// D427 (Wave 4 task 4.1.1) — shared pure recovery/acceptance helpers. The
// Compose restore/upgrade path and the `nautilo-dev` restore/upgrade/verify
// path share credential reconciliation + runtime acceptance semantics through
// this module.
import {
  parseDotenv,
  planCredentialReconciliation,
  runRuntimeAcceptance,
  type RuntimeAcceptanceTransport,
} from "@nautilo/db";
import {
  LOGTO_ENV_KEY_NAMES,
  runBootstrap as defaultRunBootstrap,
} from "@nautilo/local/bootstrap-logto";
import {
  buildAppliedAuthContract,
  appliedAuthContractSchema,
  serializeAppliedAuthContract,
  type AppliedAuthContract,
} from "../../contracts/applied-auth-contract.ts";
import { classifyAuthPlan, type AuthPlanReport } from "../../contracts/auth-plan.ts";
import {
  buildAuthContract,
  parseAuthContract,
  type AuthContract,
} from "../../contracts/auth.ts";
import type {
  ReleaseArtifact,
  ReleasePlanReport,
  ReleaseState,
} from "../../contracts/release.ts";

import { bootstrapLogtoForProfile } from "./bootstrapLogtoForProfile.ts";
import { backupManifestSchema, type BackupManifest } from "./backup-manifest.ts";
import {
  BUNDLE_INTEGRITY_FILES,
  type BundleIntegrityKey,
  type FileIntegrity,
  type BackupManifestV2,
} from "./backup-manifest.ts";
import {
  verifyBundle as verifyBundleStandalone,
  type BundleProvenance,
  type BundleVerificationReport,
  type VerifyBundleDeps,
} from "./verify-bundle.ts";
import { buildCaddyfile } from "./buildCaddyfile.ts";
import { buildCaddyOverlay } from "./buildCaddyOverlay.ts";
import {
  buildPinnedImageOverlay,
  buildRegistryImageRef,
} from "./buildRegistryOverlay.ts";
import { buildComposeEnv } from "./buildComposeEnv.ts";
import { assertSourceBuildSha, resolveSourceBuildIdentity } from "./source-build-identity.ts";
import {
  buildDirectTransportBaselineInspectScript,
  DIRECT_TRANSPORT_BASELINE_EXIT,
  DIRECT_TRANSPORT_BASELINE_REFUSAL,
} from "./direct-transport-baseline.ts";
import {
  computeDependencyRefreshRecreate,
  FULL_DEPLOY_CHANGED_UPSTREAMS,
} from "./dependency-refresh-graph.ts";
import { buildRetiredTopologyCleanupScript } from "./retired-topology-cleanup.ts";
import {
  buildRetiredTopologyPresenceInspectScript,
  buildRetiredTopologyPresenceQueryScript,
  RETIRED_TOPOLOGY_PRESENCE_EXIT,
  RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT,
  RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT,
  RETIRED_TOPOLOGY_PRESENCE_REFUSAL,
} from "./retired-topology-presence.ts";
import { buildRestrictedRuntimePoolsProbe } from "./runtime-pool-probe.ts";
import {
  buildRemoteAuthRuntimeInspectScript,
  mergeManagedRemoteEnv,
  parseRemoteAuthRuntimePorts,
  type RemoteAuthRuntimePorts,
} from "./remote-auth-runtime.ts";
import {
  buildServerOverlayEnv,
  type InstanceLogtoEnv,
} from "./buildServerOverlayEnv.ts";
import { composeProjectName } from "./composeProjectName.ts";
import {
  ensureDbPasswords,
  ensureCryptoPasswordInDotenv,
  CRYPTO_DB_PASSWORD_RELATIVE_PATH,
  setCryptoPasswordInDotenv,
  defaultEnsureDbPasswordsDeps,
  type DbPasswords,
  type EnsureDbPasswordsArgs,
} from "./ensureDbPasswords.ts";
import {
  ensureForgotPasswordWebhookSecret,
  defaultEnsureWebhookSecretDeps,
  type EnsureWebhookSecretArgs,
} from "./ensureForgotPasswordWebhookSecret.ts";
import {
  ensureRemotePairingPepper,
  defaultEnsureRemotePairingPepperDeps,
  type EnsureRemotePairingPepperArgs,
} from "./ensureRemotePairingPepper.ts";
import {
  ensurePushTokenEncryptionKey,
  defaultEnsurePushTokenEncryptionKeyDeps,
  type EnsurePushTokenEncryptionKeyArgs,
} from "./ensurePushTokenEncryptionKey.ts";
import { gates } from "./gates.ts";
import { localInstanceRootDir } from "./instance-paths.ts";
import { httpsMode } from "./https-mode.ts";
import { resolveLogtoPublicUrl, resolveServerBaseUrl } from "./instance-urls.ts";
import {
  buildRemoteComposeCommand,
  type RemoteComposeCommandRequest,
  type RemoteComposeOverlayFlags,
  type RemoteComposeProfileName,
  type RemoteComposeServiceName,
} from "./remote-compose-command.ts";
import { resolveAppDbRepairSql } from "./resolveAppDbRepairSql.ts";
import { buildLogtoPreSeedRecoverySql } from "./resolveLogtoPreSeedRecoverySql.ts";
import { buildLogtoTenantPasswordResyncSql } from "./resolveLogtoTenantPasswordResyncSql.ts";
import {
  runAppDbRepair,
  type AppDbRepairContext,
  type AppDbRepairSqlProvider,
} from "./repairAppDb.ts";
import {
  runLogtoPreSeedRecovery,
  type LogtoPreSeedRecoveryContext,
  type LogtoPreSeedRecoverySqlProvider,
} from "./repairLogtoPreSeed.ts";
import {
  runLogtoCoreRecreate,
  type LogtoCoreRecreateContext,
} from "./recreateLogtoCore.ts";
import {
  runLogtoTenantPasswordResync,
  type LogtoTenantPasswordResyncContext,
  type LogtoTenantPasswordResyncSqlProvider,
} from "./resyncLogtoTenantPasswords.ts";
import {
  assertRemoteDeploymentManifestIdentity,
  migrateRemoteDeploymentManifest,
  remoteDeploymentManifestSchema,
  remoteDeploymentManifestV2Schema,
  type RemoteDeploymentManifest,
} from "./remote-deployment-manifest.ts";
import {
  buildSshHostKeyArgs,
  expandTilde,
  runLocal,
  shellQuote,
} from "./remote-exec.ts";
import type { RemoteFs } from "./remote-fs.ts";
import type { RemoteRuntimeAcceptanceTransport } from "./remote-runtime-acceptance-fetch.ts";
import { sqlPipelineExecForProfile } from "./sql-pipeline-exec.ts";
import {
  assertRestoredIdentity,
  assertRestoreIdentityCompatible,
  buildReadConnectedInstanceIdentityScript,
  parseConnectedInstanceIdentity,
  readRestoreInstanceIdentityFromDump,
  type RestoreInstanceIdentity,
} from "./restore-instance-identity.ts";
import { dockerEnvForProfile as dockerTransportEnvForProfile, dockerHostFor } from "./wrap-docker-host.ts";
import { openSshTunnel, type PortForward } from "./ssh-tunnel.ts";
import type {
  ComposeDriverProfile,
  MaintenanceDrainHandle,
  PreviousImageCapture,
  SshProfile,
  UpgradeArtifact,
  UpgradeLocation,
  UpgradeScope,
  UpgradeStrategy,
} from "./types.ts";

function isRemoteFs(fs: unknown): fs is RemoteFs {
  return typeof (fs as RemoteFs | null)?.syncToRemote === "function";
}

function usesRemoteTransport(profile: ComposeDriverProfile): boolean {
  return profile.transport === "remote";
}

/** M207 host-canonical registry mode (`from_source=false`). */
function usesRemoteRegistryMode(profile: ComposeDriverProfile): boolean {
  return usesRemoteTransport(profile) && profile.from_source === false;
}

function manifestImageFromReleaseArtifact(
  artifact: ReleaseArtifact,
): RemoteDeploymentManifest["image"] {
  if (artifact.mode === "registry") {
    if (artifact.requested.trim() === "") {
      throw new Error("deployment manifest commit refused: registry artifact reference is empty.");
    }
    return {
      mode: "registry",
      reference: artifact.requested,
    };
  }
  const reference = artifact.archiveTag ?? artifact.immutableId;
  if (reference.trim() === "") {
    throw new Error("deployment manifest commit refused: source artifact identity is empty.");
  }
  return {
    mode: "source",
    reference,
  };
}

function resolveRemoteBundleRestoreImage(
  image: BackupManifest["image"],
): {
  manifestImage: RemoteDeploymentManifest["image"];
  pull: boolean;
} {
  if (
    image.mode === "registry" &&
    image.repoDigest !== undefined &&
    isImmutableRegistryImageRef(image.repoDigest)
  ) {
    return {
      manifestImage: { mode: "registry", reference: image.repoDigest },
      pull: true,
    };
  }

  // Pre-D427 source stacks can report a Docker-synthesized local RepoDigest
  // even though their rollback image is not pullable. Prefer the retained
  // backup tag, then the configured local tag/image ID, and keep source mode.
  const reference = image.backupTag ?? image.tag ?? image.imageId;
  if (reference === undefined || reference.trim() === "") {
    throw new Error(
      "restore: remote bundle image is neither a pullable immutable registry reference nor an available local source-image tag.",
    );
  }
  return {
    manifestImage: { mode: "source", reference },
    pull: false,
  };
}

/**
 * D420 (Wave 2 task 2.2.2) — default maintenance-drain deadline when an
 * `upgrade` caller omits `waitForMs`. Matches the CLI's
 * `DEFAULT_WAIT_FOR_MS` (5m) so a direct driver caller gets the same bounded
 * drain ceiling as `nautilo upgrade`.
 */
const DEFAULT_UPGRADE_WAIT_FOR_MS = 5 * 60_000;

/**
 * D420 1.2.2 — typed strategy selection over the locked
 * local/LAN/remote × image/source × server-only/full matrix. The three
 * product locations map onto the two existing adapters: `local` uses the
 * local adapter; `lan` and `remote` both use the remote adapter and are
 * distinguished by HTTPS (`lan` runs HTTPS off, `remote` runs letsencrypt
 * over a public domain). No third transport enum is introduced. Artifact
 * is invocation-scoped (`--from-sources` / `--image` / configured ready
 * image); scope defaults light (server-only). The strategy is
 * request-scoped and never persisted on a profile.
 *
 * This is the single source of truth `upgrade()` consults to drive
 * transport/artifact/scope/previous-image capture behavior. Direct driver
 * callers that pass no canonical options retain the legacy
 * profile-selected strategy (full scope, profile.from_source).
 */
export function resolveUpgradeStrategy(
  profile: ComposeDriverProfile,
  opts?: UpgradeOptions,
): UpgradeStrategy {
  if (
    opts?.artifact === "source" &&
    typeof opts?.imageRef === "string" &&
    opts.imageRef.trim().length > 0
  ) {
    throw new Error("--from-sources and --image cannot be used together.");
  }

  const legacy =
    opts === undefined ||
    (opts.artifact === undefined &&
      opts.imageRef === undefined &&
      opts.scope === undefined &&
      opts.waitForMs === undefined);

  const scope: UpgradeScope =
    opts?.scope === "full"
      ? "full"
      : opts?.scope === "server-only"
        ? "server-only"
        : legacy
          ? "full"
          : "server-only";

  let artifact: UpgradeArtifact = "image";
  let imageRef: string | null = null;
  if (opts?.artifact === "source") {
    artifact = "source";
    imageRef = null;
  } else if (opts?.artifact === "image") {
    artifact = "image";
    const explicit = opts.imageRef?.trim();
    if (explicit) {
      imageRef = buildRegistryImageRef(explicit);
    } else {
      const preset = profile.image_ref?.trim();
      if (preset) {
        imageRef = buildRegistryImageRef(preset);
      } else {
        throw new Error(
          "upgrade requires a configured immutable runtime image or one of --image <full-image-ref> / --from-sources.",
        );
      }
    }
  } else {
    // Legacy direct driver caller: derive artifact from the profile's
    // existing request-scoped strategy so behavior is unchanged.
    if (profile.from_source === false) {
      artifact = "image";
      imageRef = buildRegistryImageRef(profile.image_ref?.trim() ?? "");
    } else {
      artifact = "source";
      imageRef = null;
    }
  }

  const transport = profile.transport;
  const https: "off" | "letsencrypt" =
    profile.https === "letsencrypt" ? "letsencrypt" : "off";
  const location: UpgradeLocation =
    transport === "local"
      ? "local"
      : https === "letsencrypt"
        ? "remote"
        : "lan";
  const previousImageCapture: PreviousImageCapture =
    scope === "server-only" ? "running-container" : "backup-bundle";

  return {
    location,
    transport,
    https,
    artifact,
    imageRef,
    scope,
    previousImageCapture,
  };
}

/**
 * Applies a resolved strategy to a profile, producing the request-scoped
 * effective profile that the upgrade transaction mutates. Artifact choice
 * is encoded as `from_source` + `image_ref`; location/transport/HTTPS are
 * inherited unchanged from the profile.
 */
export function applyUpgradeStrategy(
  profile: ComposeDriverProfile,
  strategy: UpgradeStrategy,
): ComposeDriverProfile {
  if (strategy.artifact === "source") {
    // Source builds carry no image reference; drop any preset override so
    // downstream registry-mode checks cannot fire on a source cell.
    const rest = { ...profile };
    delete rest.image_ref;
    return { ...rest, from_source: true };
  }
  if (strategy.imageRef) {
    return {
      ...profile,
      from_source: false,
      image_ref: buildRegistryImageRef(strategy.imageRef),
    };
  }
  throw new Error(
    "upgrade requires a configured immutable runtime image or one of --image <full-image-ref> / --from-sources.",
  );
}

function registryImageRef(profile: ComposeDriverProfile): string {
  return buildRegistryImageRef(profile.image_ref ?? "");
}

function isImmutableRegistryImageRef(image: string): boolean {
  // A digest pin avoids silently retargeting a legacy conversion when a tag
  // moves. Require a registry/repository path as well as a SHA-256 digest:
  // Docker may synthesize `nautilo-server@sha256:…` for a local source image,
  // but that is not pullable from any registry.
  return /^[^/]+\/.+@sha256:[a-f0-9]{64}$/i.test(image);
}

// Read only immutable identity fields, never image configuration or secrets.
const REGISTRY_IMAGE_IDENTITY_FORMAT = '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}';

function requestedRegistryDigest(requested: string, stdout: string, expectedImageId: string): string {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch {
    throw new Error("Registry image identity inspection returned invalid JSON.");
  }
  const identity = value as { id?: unknown; repoDigests?: unknown } | null;
  if (!isImmutableRegistryImageRef(requested) || identity === null || typeof identity !== "object" ||
    typeof identity.id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(identity.id) ||
    identity.id !== expectedImageId || !Array.isArray(identity.repoDigests) ||
    !identity.repoDigests.every((digest: unknown) => typeof digest === "string") ||
    !identity.repoDigests.includes(requested)) {
    throw new Error("Registry image identity does not prove the exact requested digest and image ID.");
  }
  // Identical bytes can retain multiple repositories, indexes or platform
  // digests. Their ordering never selects a deployment/recovery authority.
  return requested;
}

// ---------------------------------------------------------------------------
// Dependency injection seams
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: "inherit" | "pipe";
    /** Private process input; never include in command arguments or diagnostics. */
    stdin?: string;
  },
) => Promise<ExecResult>;

type FsAsync = {
  writeFile: typeof nodeFs.writeFile;
  mkdir: typeof nodeFs.mkdir;
  readFile: typeof nodeFs.readFile;
  rm: typeof nodeFs.rm;
};

export interface FirstDeployConsumeContext {
  profile: ComposeDriverProfile;
  instanceRootDir: string;
  /**
   * Path to `~/.config/nautilo/deploy.toml` (or wherever the operator
   * dropped it). The default resolver checks this XDG location.
   */
  deployTomlPath: string;
}

export interface ComposeDriverDeps {
  exec: ExecFn;
  fetch: typeof fetch;
  runBootstrap: typeof defaultRunBootstrap;
  fs: FsAsync;
  /**
   * Filesystem authority for operator-laptop paths. Remote drivers set `fs`
   * to RemoteFs, which maps every path into a deployment staging tree; local
   * backup and temporary auth paths must bypass that mapping.
   */
  localFs?: FsAsync;
  now: () => Date;
  /** Absolute path to `deploy/compose-driver/templates/`. */
  templateDir: string;
  /**
   * Optional control-plane-owned workload environment. Compose reads it on
   * the client between tenant configuration and internal server overrides.
   * It is never mounted into the container or copied into recovery bundles.
   */
  managedServerEnvPath?: string;
  composeBin?: string;
  composeArgs?: string[];
  /**
   * Per-instance home root resolver. Default uses `os.homedir()` +
   * `.nautilo${suffix}`. Tests override to point at a tmpdir.
   */
  resolveInstanceRootDir?: (profile: ComposeDriverProfile) => string;
  /**
   * Operator-laptop instance root used for backup/restore file paths
   * even on remote profiles (where `resolveInstanceRootDir` returns the
   * droplet path). Default: `localInstanceRootDir(home, profile.instance_id)`
   * via os.homedir() / process.env.HOME.
   */
  resolveLocalInstanceRootDir?: (profile: ComposeDriverProfile) => string;
  /** Test seam for profile-bound metadata without process-wide HOME/cache state. */
  resolveInstance?: () => ResolvedInstance;
  /** Always-local exec used by backup/restore pipelines (regardless of transport). Default: runLocal from remote-exec. */
  localExec?: ExecFn;
  /**
   * Resolve the clean operator-side checkout revision used by source builds.
   * Registry deploys never invoke this seam.
   */
  resolveSourceBuildSha?: () => Promise<string>;
  /**
   * Optional first-deploy hook. Called once per `deploy()` after the
   * server is healthy, with `deploy.toml` claim-redemption context.
   * Default no-op — wiring `consumeDeployConfigProviders` +
   * `markDeployConfigConsumed` + `redeem-claim` lives in the CLI verb
   * (M092 Step 5) where it has access to the `@nautilo/api-client` +
   * `@nautilo/deploy-config` deps without pulling them into this
   * package's transitive graph.
   */
  firstDeployConsume?: (
    ctx: FirstDeployConsumeContext,
  ) => Promise<void>;
  /**
   * Read post-bootstrap LOGTO_* keys off the suffixed `instance.env`.
   * Default reads via `fs.readFile` and parses dotenv lines. Tests
   * inject a fixture-returning fake.
   */
  readInstanceLogtoEnv?: (
    instanceRootDir: string,
  ) => Promise<InstanceLogtoEnv>;
  /**
   * Logto health poll deadline (ms). Default 60s.
   */
  logtoHealthTimeoutMs?: number;
  /** Server health poll deadline (ms). Default 120s. */
  serverHealthTimeoutMs?: number;
  /** Poll interval (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Logger. Default no-op (driver communicates via exit codes). */
  log?: (msg: string) => void;
  /** SSH tunnel for remote Logto bootstrap. Default `openSshTunnel`. */
  openSshTunnel?: (
    ssh: SshProfile,
    forwards: PortForward[],
  ) => Promise<{ close(): Promise<void> }>;
  /** M116 — resolve/generate per-instance DB passwords before compose env build. */
  ensureDbPasswords?: (args: EnsureDbPasswordsArgs) => Promise<DbPasswords>;
  /** M120 — resolve/generate the Logto http-email webhook relay secret. */
  ensureForgotPasswordWebhookSecret?: (
    args: EnsureWebhookSecretArgs,
  ) => Promise<string>;
  /** D458 — resolve/generate the stable remote-controller pairing pepper. */
  ensureRemotePairingPepper?: (
    args: EnsureRemotePairingPepperArgs,
  ) => Promise<string>;
  /** D468 — resolve/generate the stable per-instance push-token encryption key. */
  ensurePushTokenEncryptionKey?: (
    args: EnsurePushTokenEncryptionKeyArgs,
  ) => Promise<string>;
  /**
   * M118 drive-by: idempotent NAUTILO_BOOTSTRAP_TOKEN provisioner.
   *
   * Called from `up()` AFTER Logto bootstrap and BEFORE the remote
   * operator→droplet `instance.env` mirror, so the token lands in
   * both operator-side `~/.nautilo${suffix}/instance.env` (and
   * `~/.nautilo/bootstrap-tokens/<profile>`) and — for remote
   * profiles — gets carried to the droplet via the same mirror +
   * rsync that ships LOGTO_*.
   *
   * Without this, local-profile deploys can't authenticate the privileged
   * owner-claim controller install/direct-seed requests against the
   * containerized server: Docker port-forwarding makes them appear as a
   * bridge-gateway IP (not loopback) inside the container, so the
   * server requires the `Authorization: Bearer <token>` branch of
   * `requestAllowsPrivilegedSetup`, and `process.env.NAUTILO_BOOTSTRAP_TOKEN`
   * must be set at first-server-up time. Remote profiles use the trusted
   * SSH-local controller transport (request IS loopback in the droplet), but
   * still need the operator-side files for subsequent CLI verbs —
   * the same call covers both.
   *
   * Optional: tests omit it; production wires the
   * `ensureBootstrapToken` impl from
   * `apps/cli/src/lib/compose-driver-factory.ts` (kept there because
   * it shares the `~/.nautilo/bootstrap-tokens/<profile>` writer
   * with the rest of the CLI; moving the impl into this package
   * would drag bootstrap-tokens.ts along with it).
   *
   * Returns the active token (newly minted or pre-existing).
   */
  ensureBootstrapToken?: (
    profile: ComposeDriverProfile,
    operatorHome: string,
  ) => string;
  /**
   * M139 — preflight doctor for `upgrade`. Throws to abort the upgrade
   * before any backup/deploy. Default: no-op. Production wires the CLI's
   * remote/local doctor; tests inject a fake.
   */
  doctor?: (profile: ComposeDriverProfile) => Promise<void>;
  /**
   * CLI-owned active-work gate for `nautilo upgrade`. It must complete before the
   * running server is stopped; omitted only by callers that have no work
   * coordinator configured.
   */
  assertReleaseActiveWorkReady?: (profile: ComposeDriverProfile) => Promise<void>;
  /**
   * D420 (Wave 2 task 2.2.5) — CLI-owned maintenance drain preflight for
   * `upgrade`. Enters the durable drain lease, polls operator-maintained
   * aggregate work counts to zero (or cancels + reconciles at the deadline),
   * and RETAINS the owning lease by returning a {@link MaintenanceDrainHandle}
   * instead of clearing it on success. The handle drives the
   * `draining → applying` transition immediately before `nautilo-server` is
   * stopped and best-effort releases the lease if the post-stop backup fails.
   * On timeout or network/auth/malformed failure it clears the lease
   * best-effort and throws a no-mutation error so the upgrade never starts
   * stop/backup/deploy against an unsettled server. Omitted by callers that
   * have no operator maintenance endpoint configured (legacy tests); when
   * undefined, `upgrade` skips the drain and preserves prior behavior.
   */
  drainMaintenanceWork?: (
    profile: ComposeDriverProfile,
    waitForMs: number,
  ) => Promise<MaintenanceDrainHandle>;
  /**
   * M117 — resolve an ACME registration email for https=letsencrypt
   * profiles, falling back to `[admin].email` in deploy.toml. The
   * driver itself only checks profile.acme_email; the CLI factory
   * wires this callback to read deploy.toml when present. If
   * undefined, only profile.acme_email is consulted.
   */
  resolveAcmeEmail?: (profile: ComposeDriverProfile) => string | undefined;
  /**
   * D427 (Wave 3 task 3.1.2) — when true, `deploy()` deterministically
   * force-recreates Caddy after the main `up -d` when nautilo-server or
   * logto changed, so a changed upstream cannot leave a stale proxy IP.
   * A failed recreate throws and drives the existing rollback behavior
   * (fail closed). Defaults to false so legacy tests that assert the exact
   * deploy command sequence are unaffected; the CLI factory opts in for
   * production.
   */
  enableDependencyRefresh?: boolean;
  /**
   * M212 — canonical ownership/grant repair SQL for app-postgres. Default
   * resolves from `@nautilo/db` once published; tests inject a stub.
   */
  getAppDbRepairSql?: AppDbRepairSqlProvider;
  /**
   * M212 — test seam for the full repair runner (command construction +
   * exec). Production uses `runAppDbRepair`.
   */
  runAppDbRepair?: (
    ctx: AppDbRepairContext,
    deps: {
      exec: ExecFn;
      getAppDbRepairSql: AppDbRepairSqlProvider;
      log?: (msg: string) => void;
    },
  ) => Promise<void>;
  /**
   * M212-adjacent — canonical Logto pre-seed recovery SQL for logto-postgres.
   * Default resolves locally; tests inject a stub.
   */
  getLogtoPreSeedRecoverySql?: LogtoPreSeedRecoverySqlProvider;
  /**
   * M212-adjacent — test seam for Logto pre-seed recovery (command construction +
   * exec). Production uses `runLogtoPreSeedRecovery`.
   */
  runLogtoPreSeedRecovery?: (
    ctx: LogtoPreSeedRecoveryContext,
    deps: {
      exec: ExecFn;
      getLogtoPreSeedRecoverySql: LogtoPreSeedRecoverySqlProvider;
      log?: (msg: string) => void;
    },
  ) => Promise<void>;
  /**
   * M212-adjacent — canonical Logto tenant password resync SQL for logto-postgres.
   * Default resolves locally; tests inject a stub.
   */
  getLogtoTenantPasswordResyncSql?: LogtoTenantPasswordResyncSqlProvider;
  /**
   * M212-adjacent — test seam for Logto tenant password resync preflight
   * (command construction + exec). Production uses `runLogtoTenantPasswordResync`.
   */
  runLogtoTenantPasswordResync?: (
    ctx: LogtoTenantPasswordResyncContext,
    deps: {
      exec: ExecFn;
      getLogtoTenantPasswordResyncSql: LogtoTenantPasswordResyncSqlProvider;
      log?: (msg: string) => void;
    },
  ) => Promise<void>;
  /**
   * M212-adjacent — test seam for Logto core recreate after auth-profile up.
   * Production uses `runLogtoCoreRecreate`.
   */
  runLogtoCoreRecreate?: (
    ctx: LogtoCoreRecreateContext,
    deps: {
      exec: ExecFn;
      log?: (msg: string) => void;
    },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default dep wiring
// ---------------------------------------------------------------------------


function operatorHome(): string {
  return (
    process.env["HOME"]?.trim() ||
    process.env["USERPROFILE"]?.trim() ||
    homedir()
  );
}

function defaultResolveInstanceRootDir(
  profile: ComposeDriverProfile,
): string {
  return localInstanceRootDir(operatorHome(), profile.instance_id);
}

function defaultResolveLocalInstanceRootDir(
  profile: ComposeDriverProfile,
): string {
  return localInstanceRootDir(operatorHome(), profile.instance_id);
}

function dockerEnvForProfile(
  profile: ComposeDriverProfile,
): { env?: NodeJS.ProcessEnv } {
  return dockerTransportEnvForProfile(profile);
}

// D427 (Wave 4 task 4.1.1) — `parseDotenv` is now imported from @nautilo/db
// (shared with the `nautilo-dev` restore/verify path). The local definition
// was removed; the shared helper is byte-for-byte identical.

function defaultReadInstanceLogtoEnv(fs: FsAsync) {
  return async (instanceRootDir: string): Promise<InstanceLogtoEnv> => {
    const path = canonicalInstanceEnvPath(instanceRootDir);
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      return {};
    }
    const parsed = parseDotenv(raw);
    const out: InstanceLogtoEnv = {};
    for (const k of [
      "LOGTO_ENDPOINT",
      "LOGTO_ISSUER",
      "LOGTO_JWKS_URI",
      "LOGTO_RESOURCE",
      "LOGTO_WORKBENCH_APP_ID",
      "LOGTO_TUI_APP_ID",
      "LOGTO_TUI_LOOPBACK_APP_ID",
      "LOGTO_DESKTOP_APP_ID",
      "LOGTO_MOBILE_APP_ID",
      "LOGTO_MOBILE_WEB_APP_ID",
      "LOGTO_M2M_APP_ID",
      "LOGTO_M2M_APP_SECRET",
    ] as const) {
      const v = parsed[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envFileContents(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}

/**
 * Re-grants the Logto per-tenant DB roles (`logto_tenant_*`) their schema
 * access after a `DROP SCHEMA public CASCADE` + `pg_dump` restore wipes it.
 * See the call site in `restore()` for the full rationale. A single
 * DO-block statement (safe through the ssh+docker shell layers since it's
 * shell-quoted and `$$`/quotes stay inside single quotes), idempotent, and
 * a no-op when no such roles exist.
 */
const LOGTO_TENANT_REGRANT_SQL =
  "DO $$ DECLARE r record; BEGIN " +
  "FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'logto_tenant_%' LOOP " +
  "EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r.rolname); " +
  "EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r.rolname); " +
  "EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r.rolname); " +
  "EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', r.rolname); " +
  "END LOOP; END $$;";

// ---------------------------------------------------------------------------
// D420 (Wave 3 task 3.3.2) — restore-time role password reconciliation.
//
// A `pg_dump` of `nautilo` or `logto_nautilo` carries grants for the
// `nautilo` / `nautilo_agent` (app cluster) and `logto_tenant_*` (logto
// cluster) roles, but NOT the cluster-level role passwords — those stay
// whatever they were at restore time. A restored target can therefore boot
// with correct grants yet an OLD role password, so the server's runtime
// credentials (read from the restored `instance.env`) no longer match the
// live cluster roles and every connection fails with `password
// authentication failed`. The LAN restore rehearsal proved `/health` is
// green through this desync. The two builders (`buildAppRolePasswordReconcileSql`
// and `LOGTO_TENANT_PASSWORD_RESYNC_SQL`) now live in @nautilo/db
// (`restore-acceptance/reconcile.ts`) and are shared with the `nautilo-dev`
// restore/upgrade path. They run BEFORE application startup and fail closed
// via the restore pipeline's `ON_ERROR_STOP=1`.
// ---------------------------------------------------------------------------

/**
 * Remote-only overlay that re-points the postgres-init.sh bind mount from its
 * template-relative path to an absolute REMOTE path. The docker CLI sends
 * `volumes:` source paths to the daemon as-is; on a remote deploy the template
 * dir doesn't exist on the daemon's host, so we materialize the init script
 * into the staging tree (which is rsynced to `<remoteRoot>`) and override the
 * YAML to reference it at its post-sync path.
 *
 * Compose merges `volumes:` per service by REPLACE (not append), so we must
 * list every volume the service uses, not just the changed one.
 */
function remoteVolumesOverlayYaml(remoteRoot: string): string {
  return [
    "# Generated by @nautilo/compose-driver — do not edit by hand.",
    "# Re-points bind-mount sources to absolute remote paths for ",
    "# `docker compose -H ssh://...` deploys.",
    "services:",
    "  app-postgres:",
    "    volumes:",
    "      - app_pgdata:/var/lib/postgresql/data",
    `      - ${remoteRoot}/postgres-init.sh:/docker-entrypoint-initdb.d/01-nautilo.sh:ro`,
    "  logto-postgres:",
    "    volumes:",
    "      - logto_pgdata:/var/lib/postgresql/data",
    `      - ${remoteRoot}/postgres-init.sh:/docker-entrypoint-initdb.d/01-nautilo.sh:ro`,
    "",
  ].join("\n");
}

// D445 Phase 0 — the in-container path of the dedicated runtime-config
// directory mounted from the host, and the canonical instance.env inside it.
// config-guard mutations (Google OAuth set/clear, provider keys) write this
// file; compose reads the SAME host file via `env_file` below, so mutations
// survive container recreation. A directory mount (not a single file) keeps
// config-guard's atomic temp-write + rename durable (a single-file bind mount
// detaches from the host inode on rename). The mount exposes ONLY this dir.
export const CONFIG_CONTAINER_DIR = "/var/lib/nautilo/config";
export const CONFIG_CONTAINER_ENV_PATH = `${CONFIG_CONTAINER_DIR}/instance.env`;
export const RUNTIME_CONFIG_DIR_NAME = "runtime-config";

export function runtimeConfigDir(instanceRootDir: string): string {
  return join(instanceRootDir, RUNTIME_CONFIG_DIR_NAME);
}

export function canonicalInstanceEnvPath(instanceRootDir: string): string {
  return join(runtimeConfigDir(instanceRootDir), "instance.env");
}

/**
 * Establish one host-side config authority while retaining the historical
 * `<instanceRoot>/instance.env` lookup as a compatibility symlink.
 *
 * If an older/compatibility writer replaced the symlink with a regular file,
 * that file is adopted atomically as the newest canonical content before the
 * symlink is re-established. Thus there are never two writable copies.
 */
export async function ensureCanonicalConfigLayout(instanceRootDir: string): Promise<void> {
  const configDir = runtimeConfigDir(instanceRootDir);
  const canonical = canonicalInstanceEnvPath(instanceRootDir);
  const legacy = join(instanceRootDir, "instance.env");
  await nodeFs.mkdir(configDir, { recursive: true, mode: 0o700 });

  let legacyKind: "missing" | "symlink" | "other" = "missing";
  try {
    legacyKind = (await nodeFs.lstat(legacy)).isSymbolicLink() ? "symlink" : "other";
  } catch {
    /* missing */
  }

  if (legacyKind === "other") {
    // Compatibility writers may atomically rename over the symlink. Their
    // completed file is authoritative; move it into the narrow directory.
    await nodeFs.rename(legacy, canonical);
  } else if (legacyKind === "symlink") {
    // Preserve readable content from a legacy/nonstandard link before
    // replacing it with the canonical relative target.
    try {
      const canonicalExists = await nodeFs
        .stat(canonical)
        .then(() => true)
        .catch(() => false);
      if (!canonicalExists) {
        await nodeFs.writeFile(canonical, await nodeFs.readFile(legacy), { mode: 0o600 });
      }
    } catch {
      /* dangling link; initialize below */
    }
    await nodeFs.unlink(legacy);
  }

  const canonicalExists = await nodeFs
    .stat(canonical)
    .then(() => true)
    .catch(() => false);
  if (!canonicalExists) {
    await nodeFs.writeFile(
      canonical,
      "# Nautilo configuration — API keys and provider settings\n",
      { mode: 0o600 },
    );
  }
  await nodeFs.symlink(`${RUNTIME_CONFIG_DIR_NAME}/instance.env`, legacy);
}

export function serverOverlayYaml(
  serverEnvPath: string,
  instanceEnvPath: string,
  configDirDaemonPath: string = dirname(instanceEnvPath),
  managedServerEnvPath?: string,
): string {
  // Up to three env_files, evaluated in order — later wins on key collisions.
  //   1. instance.env  — full set of config-guard-managed keys
  //      (providers OPENAI_API_KEY / ANTHROPIC_API_KEY / etc., the
  //      eight LOGTO_* keys written by bootstrap, and anything else
  //      a future config-guard transaction adds). Container sees
  //      every host-side key without us tracking each name here.
  //   2. optional control-plane managed provider environment
  //   3. deploy.server.env — narrow container-DNS overrides
  //      (LOGTO_JWKS_URI rewritten to `http://logto:<corePort>...`
  //      and LOGTO_ENDPOINT_INTERNAL sibling). Must come AFTER
  //      instance.env so the rewrites win.
  //
  // D445 Phase 0 — `env_file` paths are parsed CLIENT-side (docker CLI loads
  // the file and injects vars as `environment`), so they take the
  // operator/client-side `instanceEnvPath`. The `volumes:` source is sent to
  // the daemon as-is and resolved on the daemon host, so it takes the
  // DAEMON-side `configDirDaemonPath` (remote root for ssh-native/remote,
  // local root for local — same as the parent of the canonical instance.env).
  return [
    "# Generated by @nautilo/compose-driver — do not edit by hand.",
    "# Layered onto the base compose template via `-f <base> -f <this>`",
    "# during the post-bootstrap nautilo-server `up -d --no-deps` step.",
    "services:",
    "  nautilo-server:",
    "    environment:",
    `      NAUTILO_DOTENV_PATH: ${CONFIG_CONTAINER_ENV_PATH}`,
    '      DB_CRYPTO_CONNECTION_STRING: "postgres://nautilo_crypto:${NAUTILO_CRYPTO_DB_PASSWORD:?NAUTILO_CRYPTO_DB_PASSWORD must be set}@app-postgres:5432/nautilo"',
    "    volumes:",
    "      - app_artifacts:/var/lib/nautilo/artifacts",
    "      - app_media:/var/lib/nautilo/media",
    "      - app_apps:/var/lib/nautilo/apps",
    `      - ${configDirDaemonPath}:${CONFIG_CONTAINER_DIR}`,
    "    env_file:",
    `      - ${instanceEnvPath}`,
    ...(managedServerEnvPath === undefined ? [] : [`      - ${managedServerEnvPath}`]),
    `      - ${serverEnvPath}`,
    "",
  ].join("\n");
}

function backupTimestamp(now: Date): string {
  // YYYYMMDDTHHMMSSZ — sortable, filename-safe.
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function firstInteger(stdout: string): number | undefined {
  const match = stdout.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

/**
 * D420 2.2.4 / R9A — wrap a DB dump producer (`pg_dump ...`) in a portable
 * POSIX-sh pipeline that cannot mask a producer failure behind a successful
 * `gzip`. Plain `sh` (the local and remote execution model) has no
 * `pipefail` / `PIPESTATUS`, so a naive `pg_dump | gzip > file` returns
 * gzip's exit status and exits 0 on an empty or truncated stream even when
 * `pg_dump` failed. We instead record the producer's exit status in a side
 * file before the pipe closes and fail with that status if it is nonzero;
 * `gzip`'s own status is checked second. The status file lives next to the
 * target dump (its directory already exists) and is removed regardless of
 * outcome. No credentials appear in the script: the producer command uses
 * peer/trust auth inside the container and the only interpolated value is
 * the dump file path.
 */
export function failClosedDumpScript(dumpProducer: string, target: string): string {
  const targetQuoted = shellQuote(target);
  // `'<target>'.dumprc.$$` keeps the path quoted while letting the shell
  // expand `$$` for per-process uniqueness.
  const statusAssign = `status=${shellQuote(target)}.dumprc.$$`;
  return [
    statusAssign,
    // fd 3 carries the producer's stderr to the shell's stderr (so it is
    // surfaced in the captured error) while stdout feeds gzip.
    `{ ${dumpProducer} 2>&3; printf '%s' "$?" >"$status"; } 3>&2 | gzip > ${targetQuoted}`,
    `gzip_rc=$?`,
    `dump_rc=$(cat "$status" 2>/dev/null || printf 0)`,
    `rm -f "$status"`,
    `if [ -n "$dump_rc" ] && [ "$dump_rc" != 0 ]; then exit "$dump_rc"; fi`,
    `exit "$gzip_rc"`,
  ].join("; ");
}

/**
 * D420 2.2.4 / R9A — integrity gate run after each DB dump and before the
 * bundle manifest is accepted. Rejects a missing, empty, or non-decompressible
 * artifact. The caller's `label` (e.g. "nautilo DB dump validation") names
 * which dump failed; the stderr reason carries no credentials or paths.
 */
export function validateDumpScript(target: string): string {
  const f = shellQuote(target);
  return [
    `f=${f}`,
    `[ -f "$f" ] || { printf 'dump missing\\n' >&2; exit 2; }`,
    `[ -s "$f" ] || { printf 'dump empty\\n' >&2; exit 3; }`,
    `gzip -t "$f" || { printf 'dump corrupt gzip\\n' >&2; exit 4; }`,
  ].join("; ");
}

/**
 * D420 3.1.1 / R9A — restore-side integrity gate. Validates a required
 * compressed DB dump is a regular, nonempty, `gzip -t`-valid file BEFORE any
 * destructive schema reset/DROP. Rejects missing (2), empty (3), or corrupt
 * (4) artifacts. The caller's `label` names which dump failed; the stderr
 * reason carries no credentials or paths.
 *
 * This is a restore-specific helper (NOT shared with the 2.2.4 backup path)
 * because it MUST be executable in a real POSIX shell: the statements are
 * joined with `"; "` so the `f=<path>` assignment persists for the subsequent
 * `[ -f "$f" ]` tests and each `}` group is properly terminated. The backup
 * helper's join form is intentionally left untouched (out of 3.1.1 scope).
 *
 * Exported for unit tests that exercise the gate in a real POSIX shell.
 */
export function validateRestoreDumpScript(target: string): string {
  const f = shellQuote(target);
  return [
    `f=${f}`,
    `[ -f "$f" ] || { printf 'dump missing\\n' >&2; exit 2; }`,
    `[ -s "$f" ] || { printf 'dump empty\\n' >&2; exit 3; }`,
    `gzip -t "$f" || { printf 'dump corrupt gzip\\n' >&2; exit 4; }`,
  ].join("; ");
}

/**
 * Full non-system schema wipe for `nautilo` before applying a pg_dump. The
 * `nautilo.allow_destructive` session GUC is the D374 seatbelt escape hatch.
 * Exported for unit tests that assert reset SQL is prepended atomically.
 */
export const NAUTILO_SCHEMA_RESET_SQL =
  "SET nautilo.allow_destructive = 'on'; " +
  "DROP SCHEMA IF EXISTS public CASCADE; " +
  "DO $$ DECLARE s text; BEGIN " +
  "FOR s IN SELECT nspname FROM pg_namespace " +
  "WHERE left(nspname, 3) <> 'pg_' AND nspname NOT IN ('information_schema', 'public') " +
  "LOOP EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s); END LOOP; END $$; " +
  "CREATE SCHEMA public; ALTER SCHEMA public OWNER TO pg_database_owner;";

/**
 * Full non-system schema wipe for `logto_nautilo` before applying a pg_dump.
 * Same all-schemas rationale as {@link NAUTILO_SCHEMA_RESET_SQL} without the
 * D374 seatbelt (Logto DB has no nautilo identity marker).
 */
export const LOGTO_SCHEMA_RESET_SQL =
  "DROP SCHEMA IF EXISTS public CASCADE; " +
  "DO $$ DECLARE s text; BEGIN " +
  "FOR s IN SELECT nspname FROM pg_namespace " +
  "WHERE left(nspname, 3) <> 'pg_' AND nspname NOT IN ('information_schema', 'public') " +
  "LOOP EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s); END LOOP; END $$; " +
  "CREATE SCHEMA public; ALTER SCHEMA public OWNER TO pg_database_owner;";

/**
 * D420 atomic restore — run schema reset + compressed dump load in ONE `psql`
 * invocation with `-X -v ON_ERROR_STOP=1 --single-transaction`, so any
 * dump/reset error rolls back the reset and the DB is never left empty by its
 * own failed import. Gzip integrity MUST be checked via
 * {@link validateRestoreDumpScript} before this script runs. Gunzip failures
 * are fail-closed via a side status file (same pattern as
 * {@link failClosedRestoreScript}). Legacy dump-only restores without a schema
 * reset continue to use {@link failClosedRestoreScript}.
 */
export function atomicDbRestoreScript(
  source: string,
  psqlCommand: string,
  resetSql: string,
): string {
  const sourceQuoted = shellQuote(source);
  const statusAssign = `status=${shellQuote(source)}.restorerc.$$`;
  return [
    statusAssign,
    `{ printf '%s\\n' ${shellQuote(resetSql)}; gunzip -c ${sourceQuoted} 2>&3; printf '%s' "$?" >"$status"; } 3>&2 | ${psqlCommand} -X -v ON_ERROR_STOP=1 --single-transaction`,
    `psql_rc=$?`,
    `gunzip_rc=$(cat "$status" 2>/dev/null || printf 0)`,
    `rm -f "$status"`,
    `if [ -n "$gunzip_rc" ] && [ "$gunzip_rc" != 0 ]; then exit "$gunzip_rc"; fi`,
    `exit "$psql_rc"`,
  ].join("; ");
}

/**
 * D420 3.1.1 / R9A — wrap a DB restore pipeline (`gunzip -c dump | psql ...`)
 * in a portable POSIX-sh form that cannot mask a decompression failure behind
 * a successful `psql`. Plain `sh` (the local and remote execution model) has
 * no `pipefail` / `PIPESTATUS`, so a naive `gunzip | psql` returns psql's exit
 * status and exits 0 when `gunzip` fails on a corrupt/truncated stream but
 * `psql` succeeds on the empty or partial input. We record `gunzip`'s exit
 * status in a side file before the pipe closes and fail with that status if it
 * is nonzero; `psql` is invoked with `-v ON_ERROR_STOP=1` so the first SQL
 * error aborts the restore instead of being skipped and leaving a partial DB.
 * The status file lives next to the source dump (its directory already exists)
 * and is removed regardless of outcome. No credentials appear in the script:
 * the only interpolated value is the source dump path; `psqlCommand` uses
 * peer/trust auth inside the container.
 *
 * Statements are joined with `"; "` so the `status=<path>` assignment persists
 * for the post-pipeline `cat "$status"` read and every group/command is
 * properly terminated — the script must be executable in a real POSIX `sh`,
 * not just pass faked-exec unit tests.
 *
 * Exported for unit tests that exercise the pipeline in a real POSIX shell
 * (with stub `psql`/gzip fixtures) to prove decompression and SQL errors are
 * not masked.
 */
export function failClosedRestoreScript(source: string, psqlCommand: string): string {
  const sourceQuoted = shellQuote(source);
  // `'<source>'.restorerc.$$` keeps the path quoted while letting the shell
  // expand `$$` for per-process uniqueness.
  const statusAssign = `status=${shellQuote(source)}.restorerc.$$`;
  return [
    statusAssign,
    // fd 3 carries gunzip's stderr (decompression errors) to the shell's
    // stderr so the reason surfaces in the captured error; stdout feeds psql.
    `{ gunzip -c ${sourceQuoted} 2>&3; printf '%s' "$?" >"$status"; } 3>&2 | ${psqlCommand} -v ON_ERROR_STOP=1`,
    `psql_rc=$?`,
    `gunzip_rc=$(cat "$status" 2>/dev/null || printf 0)`,
    `rm -f "$status"`,
    `if [ -n "$gunzip_rc" ] && [ "$gunzip_rc" != 0 ]; then exit "$gunzip_rc"; fi`,
    `exit "$psql_rc"`,
  ].join("; ");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint"
  ) {
    return String(err);
  }
  try {
    const json = JSON.stringify(err);
    if (json !== undefined) return json;
  } catch {
    /* fall through */
  }
  return "unknown error";
}

/**
 * D420 (Wave 3 task 3.1.3) — owning-operation completion of the maintenance
 * lease (`applying → normal`), called ONLY after a healthy new deployment or
 * a healthy full-bundle rollback. Completion is authenticated + ownership-
 * checked and fail-closed: on any transition / network / auth / malformed /
 * non-2xx error (or a 200 that did not move THIS operation to `normal`), the
 * lease is LEFT in `applying` and the returned fragment reports the failure
 * honestly — the caller never reports "completed" when the completion call
 * did not succeed. Hard-expiry remains the safety net for a CLI that dies or
 * a completion that fails. Returns `{ line: "", completed: true }` when no
 * handle is wired so unwired callers retain their existing output.
 */
async function completeMaintenanceLeaseForReport(
  handle: MaintenanceDrainHandle | undefined,
): Promise<{ line: string; completed: boolean }> {
  if (!handle) return { line: "", completed: true };
  try {
    await handle.completeLease();
    return { line: "; maintenance lease cleared", completed: true };
  } catch (error) {
    return {
      line: `; maintenance lease completion failed: ${
        error instanceof Error ? error.message : String(error)
      }; lease left in applying (hard-expiry will reclaim)`,
      completed: false,
    };
  }
}

export function sshRsyncSpec(profile: ComposeDriverProfile): string {
  if (profile.transport !== "remote" || profile.ssh === undefined) {
    throw new Error("sshRsyncSpec requires a remote profile with ssh config.");
  }
  const ssh = profile.ssh;
  const parts = [
    "ssh",
    "-p",
    String(ssh.port ?? 22),
    "-o",
    "BatchMode=yes",
    ...buildSshHostKeyArgs(ssh),
  ];
  if (ssh.identity_file !== undefined) {
    parts.push("-i", expandTilde(ssh.identity_file));
  }
  return parts.map(shellQuote).join(" ");
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export interface DestroyOptions {
  hard: boolean;
  /**
   * M117 — when true alongside `hard`, preserve `caddy_data` and
   * `caddy_config` named volumes so LE certs survive a full reset.
   * Implementation: run `docker compose down` (no -v) then explicitly
   * `docker volume rm <project>_app_pgdata <project>_logto_pgdata`.
   * No-op when `hard` is false.
   */
  keepCerts?: boolean;
}
export interface RestoreOptions {
  fromPath: string;
  force: boolean;
  mode?: "full" | "data-only" | "artifacts-only";
  stream?: boolean;
}
export interface BackupOptions {
  toPath?: string;
  noOperatorFiles?: boolean;
  tarball?: boolean;
  stream?: boolean;
  /** Running image captured before a consistent-backup server stop. */
  releaseLegacyImage?: ReleaseArtifact;
}

export interface ComposeStatusObservation {
  readonly composeProjectName: string;
  readonly serverUrl?: string;
  readonly compose: "present" | "absent" | "unknown";
  readonly health: "ready" | "unavailable";
  readonly setupState?: string;
  readonly claimRequired?: boolean;
}

export interface ComposeCleanupObservation {
  readonly containersAbsent: boolean;
  readonly networksAbsent: boolean;
  readonly dataVolumesAbsent: boolean;
  readonly preservedCertificateVolumes: readonly string[];
}

function composePresenceFromPs(stdout: string): "present" | "absent" | "unknown" {
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "[]") return "absent";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.length === 0 ? "absent" : "present";
    if (parsed !== null && typeof parsed === "object") return "present";
  } catch {
    // Docker Compose versions may emit one JSON object per line.
    if (trimmed.split(/\r?\n/).every((line) => {
      try {
        return typeof JSON.parse(line) === "object";
      } catch {
        return false;
      }
    })) return "present";
  }
  return "unknown";
}

export interface AuthReconcileOptions {
  /**
   * Required acknowledgement that bootstrapping Logto can affect active
   * sessions. This command intentionally has no implicit/non-interactive
   * confirmation path.
   */
  confirmSessionImpact: boolean;
}

export interface AuthReconcileResult {
  backupPath: string;
  preflight: AuthPlanReport;
  postflight: AuthPlanReport;
}
export interface UpgradeOptions {
  noRollback?: boolean;
  allowArtifactLoss?: boolean;
  /** D420 — source build or the configured/default/overridden ready image. */
  artifact?: "source" | "image";
  /** D420 — full registry reference supplied by `nautilo upgrade --image`. */
  imageRef?: string;
  /** D420 — default server-only replacement; `full` retains broad deploy behavior. */
  scope?: "server-only" | "full";
  /** D420 — maintenance-drain deadline (Wave 2 consumes it). */
  waitForMs?: number;
  /**
   * M139 — parent directory for the auto pre-upgrade backup bundle. The
   * bundle is written to `<backupDir>/auto-pre-upgrade-<stamp>/`. Defaults
   * to `<operator instance root>/backups` (i.e. `~/.nautilo${suffix}/backups`).
   */
  backupDir?: string;
}
export interface LogsOptions {
  follow: boolean;
  service?: string;
}

export interface RestartOptions {
  /**
   * Resume the deployed auth + app Compose profiles after a host reboot using
   * the images already present on the host, then restart every running service
   * so Docker DNS is refreshed.
   */
  full?: boolean;
}

export interface AdoptOptions {
  /** `confirm` is the explicit opt-in for the single manifest write. */
  dryRun?: boolean;
  confirm?: boolean;
  /**
   * D427 Wave 1 (task 1.2.1) — path to a recovery bundle that
   * `nautilo backup verify` has (or will) prove intact. Required for
   * `confirm`: a confirmed adoption persists the bundle's verified
   * provenance in the deployment manifest so a resumed bootstrap has a
   * known rollback target and never loses the original image identity.
   * Ignored by `dryRun` (which performs no mutation and no verification).
   */
  bundlePath?: string;
}

export interface BootstrapLegacyOptions {
  /** Read-only inspection; this is the default. */
  plan?: boolean;
  /** Separate acknowledgements prevent an accidental legacy conversion. */
  confirmAdoption?: boolean;
  confirmDeploy?: boolean;
  /** Required for every confirmed conversion and re-verified on resume. */
  bundlePath?: string;
  /** Immutable full registry image reference, persisted for every retry. */
  imageRef?: string;
}

export interface BootstrapLegacyReport {
  mode: "plan" | "confirmed";
  completedPhase: "adopted" | "materialized" | "deployed" | "auth-planned" | "accepted";
}

/** M092 Step 4 — host-side compose driver. */
export class ComposeDriver {
  private readonly deps: Required<
    Omit<
      ComposeDriverDeps,
      | "composeBin"
      | "composeArgs"
      | "managedServerEnvPath"
      | "firstDeployConsume"
      | "ensureDbPasswords"
      | "ensureForgotPasswordWebhookSecret"
      | "ensureRemotePairingPepper"
      | "ensurePushTokenEncryptionKey"
      | "ensureBootstrapToken"
      | "doctor"
      | "assertReleaseActiveWorkReady"
      | "drainMaintenanceWork"
      | "resolveAcmeEmail"
      | "enableDependencyRefresh"
      | "getAppDbRepairSql"
      | "runAppDbRepair"
      | "getLogtoPreSeedRecoverySql"
      | "runLogtoPreSeedRecovery"
      | "getLogtoTenantPasswordResyncSql"
      | "runLogtoTenantPasswordResync"
      | "runLogtoCoreRecreate"
    >
  > & {
    composeBin: string;
    composeArgs: string[];
    managedServerEnvPath: string | undefined;
    firstDeployConsume?: ((ctx: FirstDeployConsumeContext) => Promise<void>) | undefined;
    ensureDbPasswords: (args: EnsureDbPasswordsArgs) => Promise<DbPasswords>;
    ensureForgotPasswordWebhookSecret: (
      args: EnsureWebhookSecretArgs,
    ) => Promise<string>;
    ensureRemotePairingPepper: (
      args: EnsureRemotePairingPepperArgs,
    ) => Promise<string>;
    ensurePushTokenEncryptionKey: (
      args: EnsurePushTokenEncryptionKeyArgs,
    ) => Promise<string>;
    ensureBootstrapToken?: ComposeDriverDeps["ensureBootstrapToken"];
    doctor?: ComposeDriverDeps["doctor"];
    assertReleaseActiveWorkReady?: ComposeDriverDeps["assertReleaseActiveWorkReady"];
    drainMaintenanceWork?: ComposeDriverDeps["drainMaintenanceWork"];
    resolveAcmeEmail?: ((profile: ComposeDriverProfile) => string | undefined) | undefined;
    enableDependencyRefresh: boolean;
    getAppDbRepairSql: AppDbRepairSqlProvider;
    runAppDbRepair: ComposeDriverDeps["runAppDbRepair"];
    getLogtoPreSeedRecoverySql: LogtoPreSeedRecoverySqlProvider;
    runLogtoPreSeedRecovery: ComposeDriverDeps["runLogtoPreSeedRecovery"];
    getLogtoTenantPasswordResyncSql: LogtoTenantPasswordResyncSqlProvider;
    runLogtoTenantPasswordResync: ComposeDriverDeps["runLogtoTenantPasswordResync"];
    runLogtoCoreRecreate: ComposeDriverDeps["runLogtoCoreRecreate"];
    openSshTunnel: (
      ssh: SshProfile,
      forwards: PortForward[],
    ) => Promise<{ close(): Promise<void> }>;
  };
  constructor(deps: ComposeDriverDeps) {
    const fs = deps.fs;
    this.deps = {
      exec: deps.exec,
      fetch: deps.fetch,
      runBootstrap: deps.runBootstrap,
      fs,
      localFs: deps.localFs ?? nodeFs,
      now: deps.now,
      templateDir: deps.templateDir,
      composeBin: deps.composeBin ?? "docker",
      composeArgs: deps.composeArgs ?? ["compose"],
      managedServerEnvPath: deps.managedServerEnvPath,
      resolveInstanceRootDir:
        deps.resolveInstanceRootDir ?? defaultResolveInstanceRootDir,
      resolveLocalInstanceRootDir:
        deps.resolveLocalInstanceRootDir ?? defaultResolveLocalInstanceRootDir,
      resolveInstance: deps.resolveInstance ?? (() => resolveInstance()),
      localExec: deps.localExec ?? runLocal,
      resolveSourceBuildSha:
        deps.resolveSourceBuildSha ??
        (() => resolveSourceBuildIdentity({ templateDir: deps.templateDir, exec: deps.localExec ?? runLocal })),
      firstDeployConsume: deps.firstDeployConsume,
      readInstanceLogtoEnv:
        deps.readInstanceLogtoEnv ?? defaultReadInstanceLogtoEnv(fs),
      logtoHealthTimeoutMs: deps.logtoHealthTimeoutMs ?? 60_000,
      serverHealthTimeoutMs: deps.serverHealthTimeoutMs ?? 120_000,
      pollIntervalMs: deps.pollIntervalMs ?? 1_000,
      log: deps.log ?? (() => {}),
      openSshTunnel:
        deps.openSshTunnel ??
        ((ssh, forwards) => openSshTunnel(ssh, forwards)),
      ensureDbPasswords:
        deps.ensureDbPasswords ??
        ((args) =>
          ensureDbPasswords(
            args,
            defaultEnsureDbPasswordsDeps(
              args.dockerHost !== undefined
                ? { dockerHost: args.dockerHost }
                : undefined,
            ),
          )),
      ensureForgotPasswordWebhookSecret:
        deps.ensureForgotPasswordWebhookSecret ??
        ((args) =>
          ensureForgotPasswordWebhookSecret(
            args,
            defaultEnsureWebhookSecretDeps(),
          )),
      ensureRemotePairingPepper:
        deps.ensureRemotePairingPepper ??
        ((args) =>
          ensureRemotePairingPepper(
            args,
            defaultEnsureRemotePairingPepperDeps(),
          )),
      ensurePushTokenEncryptionKey:
        deps.ensurePushTokenEncryptionKey ??
        ((args) =>
          ensurePushTokenEncryptionKey(
            args,
            defaultEnsurePushTokenEncryptionKeyDeps(),
          )),
      ensureBootstrapToken: deps.ensureBootstrapToken,
      doctor: deps.doctor,
      assertReleaseActiveWorkReady: deps.assertReleaseActiveWorkReady,
      drainMaintenanceWork: deps.drainMaintenanceWork,
      resolveAcmeEmail: deps.resolveAcmeEmail,
      enableDependencyRefresh: deps.enableDependencyRefresh ?? false,
      getAppDbRepairSql: deps.getAppDbRepairSql ?? resolveAppDbRepairSql,
      runAppDbRepair: deps.runAppDbRepair ?? runAppDbRepair,
      getLogtoPreSeedRecoverySql:
        deps.getLogtoPreSeedRecoverySql ?? buildLogtoPreSeedRecoverySql,
      runLogtoPreSeedRecovery:
        deps.runLogtoPreSeedRecovery ?? runLogtoPreSeedRecovery,
      getLogtoTenantPasswordResyncSql:
        deps.getLogtoTenantPasswordResyncSql ?? buildLogtoTenantPasswordResyncSql,
      runLogtoTenantPasswordResync:
        deps.runLogtoTenantPasswordResync ?? runLogtoTenantPasswordResync,
      runLogtoCoreRecreate: deps.runLogtoCoreRecreate ?? runLogtoCoreRecreate,
    };
  }

  /**
   * CLI composition seam for the release-only active-work gate. Kept separate
   * from generic deploy/upgrade hooks so legacy upgrade behavior is unchanged.
   */
  setReleaseActiveWorkReadiness(
    gate: ComposeDriverDeps["assertReleaseActiveWorkReady"],
  ): void {
    this.deps.assertReleaseActiveWorkReady = gate;
  }

  /**
   * D420 (Wave 2 task 2.2.5) — CLI composition seam for the maintenance drain
   * preflight. The CLI factory wires the operator-endpoint-backed drain; tests
   * inject a stub or leave it undefined to preserve legacy no-drain behavior.
   * The wired drain returns a {@link MaintenanceDrainHandle} that retains the
   * owning lease through the stop-before-backup sequence.
   */
  setMaintenanceDrain(gate: ComposeDriverDeps["drainMaintenanceWork"]): void {
    this.deps.drainMaintenanceWork = gate;
  }

  /**
   * D427 (Wave 4 task 4.x) — CLI composition seam for the remote
   * runtime-acceptance + health-poll transport. When wired, remote-profile
   * runtime acceptance (`checkRuntimeAcceptance`) and the deploy/restore/
   * releaseApply health polls route HTTP through SSH authority on the target
   * (loopback docker-exec for `/health` + `/api/setup/status`, `--resolve`
   * vhost curl for HTTPS SPA/OIDC, direct host curl for LAN HTTP) instead of
   * `deps.fetch` on the operator's public DNS. This removes the false-result
   * vector where public DNS points at a different host than the target.
   * Local behavior is unchanged; unwired (tests/legacy) preserves `deps.fetch`.
   */
  setRemoteRuntimeAcceptanceTransport(
    transport: RemoteRuntimeAcceptanceTransport,
  ): void {
    this.remoteRuntimeAcceptanceTransport = transport;
  }

  private remoteRuntimeAcceptanceTransport?: RemoteRuntimeAcceptanceTransport;

  // -------------------------------------------------------------------------
  // Public verbs
  // -------------------------------------------------------------------------

  /**
   * Returns the operator-side path of the deploy.compose.env file if it
   * exists. Used by non-deploy verbs (destroy/status/restart/logs) to satisfy
   * `${VAR:?...}` interpolations in the compose YAML without having to
   * regenerate the env file. Returns `undefined` when the file isn't on
   * disk yet (e.g. `status` before the first deploy).
   */
  private existingComposeEnvPath(
    profile: ComposeDriverProfile,
  ): string | undefined {
    const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
    const remotePath = join(instanceRootDir, "deploy.compose.env");
    const localPath = isRemoteFs(this.deps.fs)
      ? this.deps.fs.toLocalStagingPath(remotePath)
      : remotePath;
    try {
      // Sync existence check on the operator side. The remote path doesn't
      // matter — docker CLI parses `--env-file` client-side.
      if (existsSync(localPath)) return localPath;
    } catch {
      /* fall through */
    }
    return undefined;
  }

  /**
   * Returns the operator-side server env overlay from a prior deploy. Full
   * recovery uses `up`, which may recreate nautilo-server; include this
   * overlay so the recreated container loads instance.env followed by
   * deploy.server.env (including its container-DNS Logto overrides).
   *
   * Remote source deploys parse this file on the operator side, so map its
   * remote path to the local staging tree just as we do for deploy.compose.env.
   */
  private existingServerOverlayPath(
    profile: ComposeDriverProfile,
  ): string | undefined {
    const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
    const remotePath = join(instanceRootDir, "deploy.server-overlay.yml");
    const localPath = isRemoteFs(this.deps.fs)
      ? this.deps.fs.toLocalStagingPath(remotePath)
      : remotePath;
    try {
      if (existsSync(localPath)) return localPath;
    } catch {
      /* fall through */
    }
    return undefined;
  }

  /**
   * Returns the pinned registry-image overlay written by a prior deploy.
   * Full local recovery runs `up --no-build`, which may recreate the server;
   * retaining this overlay prevents Compose from falling back to the base
   * template image when the invocation-scoped `from_source` flag is absent.
   */
  private existingRegistryOverlayPath(
    profile: ComposeDriverProfile,
  ): string | undefined {
    const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
    const path = join(instanceRootDir, "deploy.registry-overlay.yml");
    try {
      if (existsSync(path)) return path;
    } catch {
      /* fall through */
    }
    return undefined;
  }

  /**
   * Returns the operator-side path of the caddy-overlay YAML if a
   * previous LE-mode deploy wrote one. Non-deploy verbs (destroy,
   * status, restart, logs, restore, backup) must include this `-f`
   * so docker compose knows about the Caddy service + volumes +
   * network attachments. Otherwise Caddy gets orphaned at destroy
   * time and the deploy-net can't be removed.
   *
   * Returns `undefined` for https=off deploys (file never written).
   */
  private existingCaddyOverlayPath(
    profile: ComposeDriverProfile,
  ): string | undefined {
    const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
    const remotePath = join(instanceRootDir, "deploy.caddy-overlay.yml");
    const localPath = isRemoteFs(this.deps.fs)
      ? this.deps.fs.toLocalStagingPath(remotePath)
      : remotePath;
    try {
      if (existsSync(localPath)) return localPath;
    } catch {
      /* fall through */
    }
    return undefined;
  }

  /**
   * Returns the operator-side path of the volumes-overlay YAML if a prior
   * remote deploy wrote one. Remote profiles MUST include this `-f` on every
   * compose invocation that can (re)create containers (up / start / restart /
   * restore), so the postgres-init.sh bind mount resolves to its absolute
   * remote path. The base template uses operator-laptop-relative paths that
   * don't exist on the droplet. Local profiles never write one, so this
   * returns undefined (no-op).
   */
  private existingVolumesOverlayPath(
    profile: ComposeDriverProfile,
  ): string | undefined {
    const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
    const remotePath = join(instanceRootDir, "deploy.volumes-overlay.yml");
    const localPath = isRemoteFs(this.deps.fs)
      ? this.deps.fs.toLocalStagingPath(remotePath)
      : remotePath;
    try {
      if (existsSync(localPath)) return localPath;
    } catch {
      /* fall through */
    }
    return undefined;
  }

  async deploy(
    profile: ComposeDriverProfile,
    opts?: { allowArtifactLoss?: boolean },
  ): Promise<void> {
    gates(profile);
    if (usesRemoteRegistryMode(profile)) {
      const restoreEnv = this.setInstanceEnv(profile);
      try {
        await this.deployRemoteRegistry(profile, opts);
      } finally {
        restoreEnv();
      }
      return;
    }
    // Resolve source authority before filesystem, Docker, credential, or
    // provider mutation. Standalone archives and dirty/unresolvable checkouts
    // fail closed here instead of emitting an empty or invented image label.
    const sourceBuildSha = profile.from_source === false
      ? undefined
      : assertSourceBuildSha(await this.deps.resolveSourceBuildSha());
    await this.assertArtifactVolumePresentOrMigrated(profile, opts);
    const log = this.deps.log;
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      log(`deploy: starting (profile=${profile.name}, transport=${profile.transport})`);
      const inst = this.resolveInstanceForProfile();
      const projectName = composeProjectName(profile);
      const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
      await this.deps.fs.mkdir(instanceRootDir, { recursive: true });
      log(`deploy: instance root = ${instanceRootDir}`);
      const registryMode = profile.from_source === false;

      log("deploy: ensuring DB passwords (M116)...");
      // M116 — read/write passwords from operator-side ~/.nautilo${suffix}/
      // even when instanceRootDir above is the remote droplet path.
      const operatorInstanceRootDir =
        this.deps.resolveLocalInstanceRootDir(profile);
      // bootstrapLogtoForProfile writes the local applied-auth stamp beside
      // the operator's instance.env. Ensure that parent exists before
      // bootstrap so the atomic temp-file write cannot fail on first deploy
      // (including tests that override the deployment root separately).
      await this.deps.fs.mkdir(operatorInstanceRootDir, {
        recursive: true,
        mode: 0o700,
      });
      await ensureCanonicalConfigLayout(operatorInstanceRootDir);
      const passwordRecoveryDriver = profile.password_recovery ?? "oss_relay";
      const passwordRecoveryEnv = {
        ...process.env,
        NAUTILO_PASSWORD_RECOVERY_DRIVER: passwordRecoveryDriver,
      };
      const forgotPasswordWebhookSecret = passwordRecoveryUsesOssRelay(passwordRecoveryEnv)
        ? await this.deps.ensureForgotPasswordWebhookSecret({
            instanceRootDir: operatorInstanceRootDir,
          })
        : undefined;
      const remotePairingPepper = await this.deps.ensureRemotePairingPepper({
        instanceRootDir: operatorInstanceRootDir,
      });
      const pushTokenEncryptionKey =
        await this.deps.ensurePushTokenEncryptionKey({
          instanceRootDir: operatorInstanceRootDir,
        });
      const passwords = await this.deps.ensureDbPasswords({
        instanceRootDir: operatorInstanceRootDir,
        composeProjectName: projectName,
        appPostgresHostPort: inst.db.postgresHostPort,
        ...(profile.transport === "remote" && profile.ssh !== undefined
          ? { dockerHost: dockerHostFor(profile) }
          : {}),
      });
      log("deploy: DB passwords resolved");

      // Path mapper. For remote profiles, docker CLI flags
      // (`--env-file`, `-f`) must reference the operator-side staging
      // path because the docker CLI parses them client-side BEFORE
      // sending anything to the daemon over SSH. The fs.writeFile call
      // already maps writes into the staging tree; we just need the
      // local path for the CLI arg.
      const toLocal = (remotePath: string): string =>
        isRemoteFs(this.deps.fs)
          ? this.deps.fs.toLocalStagingPath(remotePath)
          : remotePath;
      await ensureCanonicalConfigLayout(toLocal(instanceRootDir));

      const mode = httpsMode(profile);
      let composeEnvOpts: { acmeEmail?: string; caddyfilePath?: string } | undefined;
      let caddyfilePath: string | undefined;
      let caddyOverlayPath: string | undefined;
      if (mode === "letsencrypt") {
        const fromProfile = profile.acme_email?.trim();
        const fromCallback = this.deps.resolveAcmeEmail?.(profile)?.trim();
        const acmeEmail = (fromProfile && fromProfile.length > 0)
          ? fromProfile
          : (fromCallback && fromCallback.length > 0 ? fromCallback : undefined);
        if (!acmeEmail) {
          throw new Error(
            "https=letsencrypt requires an ACME email. Set acme_email on the profile or [admin].email in ~/.config/nautilo/deploy.toml.",
          );
        }
        if (!profile.domain || profile.domain.trim().length === 0) {
          throw new Error(
            "https=letsencrypt requires a non-empty profile.domain.",
          );
        }
        caddyfilePath = join(instanceRootDir, "deploy.Caddyfile");
        composeEnvOpts = { acmeEmail, caddyfilePath };
      }
      const composeEnv = buildComposeEnv(profile, inst, passwords, {
        ...composeEnvOpts,
        ...(sourceBuildSha === undefined ? {} : { sourceBuildSha }),
      });
      const composeEnvPath = join(instanceRootDir, "deploy.compose.env");
      await this.deps.fs.writeFile(
        composeEnvPath,
        envFileContents(composeEnv),
        { mode: 0o600 },
      );
      log(`deploy: wrote ${composeEnvPath}`);

      if (mode === "letsencrypt" && caddyfilePath !== undefined) {
        await this.deps.fs.writeFile(
          caddyfilePath,
          buildCaddyfile({ profile, inst, acmeEmail: composeEnvOpts!.acmeEmail! }),
          { mode: 0o644 },
        );
        log(`deploy: wrote ${caddyfilePath}`);
        caddyOverlayPath = join(instanceRootDir, "deploy.caddy-overlay.yml");
        await this.deps.fs.writeFile(
          caddyOverlayPath,
          buildCaddyOverlay(),
          { mode: 0o600 },
        );
        log(`deploy: wrote ${caddyOverlayPath}`);
      }

      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      const sourceOverlayPath = join(this.deps.templateDir, "docker-compose.source.yml");
      let registryOverlayPath: string | undefined;
      if (registryMode) {
        registryOverlayPath = join(instanceRootDir, "deploy.registry-overlay.yml");
        await this.deps.fs.writeFile(
          registryOverlayPath,
          buildPinnedImageOverlay(registryImageRef(profile)),
          { mode: 0o600 },
        );
        log(`deploy: wrote ${registryOverlayPath}`);
      }

      // Remote profiles: ship postgres-init.sh into staging so it ends up on
      // the remote at <remoteRoot>/postgres-init.sh, and generate a
      // volumes-overlay YAML that rewrites the host path to that absolute
      // remote location. See remoteVolumesOverlayYaml() for rationale.
      let volumesOverlayPath: string | undefined;
      if (isRemoteFs(this.deps.fs)) {
        log("deploy: staging remote bind-mount file (postgres-init.sh)...");
        const postgresInit = await nodeFs.readFile(
          join(this.deps.templateDir, "..", "..", "..", "infra", "postgres-init.sh"),
          "utf8",
        );
        await this.deps.fs.writeFile(
          join(instanceRootDir, "postgres-init.sh"),
          postgresInit,
          { mode: 0o755 },
        );
        volumesOverlayPath = join(instanceRootDir, "deploy.volumes-overlay.yml");
        await this.deps.fs.writeFile(
          volumesOverlayPath,
          remoteVolumesOverlayYaml(instanceRootDir),
          { mode: 0o600 },
        );
      }

      if (isRemoteFs(this.deps.fs)) {
        log("deploy: rsync to remote (this may take a few seconds)...");
        await this.deps.fs.syncToRemote();
        log("deploy: rsync complete");
      }

      // Build the base compose argv. Remote profiles get the volumes
      // overlay layered on top of the base.
      const baseComposeArgs = (extra: string[]): string[] => {
        const args: string[] = [
          "--project-name",
          projectName,
          "-f",
          baseYml,
        ];
        if (!registryMode) {
          args.push("-f", sourceOverlayPath);
        }
        if (volumesOverlayPath !== undefined) {
          args.push("-f", toLocal(volumesOverlayPath));
        }
        if (caddyOverlayPath !== undefined) {
          args.push("-f", toLocal(caddyOverlayPath));
        }
        if (registryOverlayPath !== undefined) {
          args.push("-f", toLocal(registryOverlayPath));
        }
        return args.concat(extra);
      };

      if (registryMode) {
        log("deploy: docker compose pull nautilo-server (registry mode)...");
        // D248 — include `--profile auth` so `logto` is in the active
        // project graph. The caddy overlay's `caddy` service declares
        // `depends_on: logto`, and compose validates that dependency
        // against the enabled profiles BEFORE running the named pull.
        // Without `auth`, the pull errors with "service 'caddy' depends
        // on undefined service 'logto'". Same M117 reasoning as the
        // re-up/up/down steps below; `pull nautilo-server` stays a single
        // named-service pull regardless of the wider profile set.
        await this.runCompose(
          baseComposeArgs([
            "--env-file",
            toLocal(composeEnvPath),
            "--profile",
            "auth",
            "--profile",
            "app",
            "pull",
            "nautilo-server",
          ]),
          { stdio: "inherit" },
        );
      }

      const deployEnvAndProfiles = this.deployEnvAndProfileArgs(
        profile,
        toLocal(composeEnvPath),
      );

      // M215 — refuse topology mutation when an existing nautilo-server still
      // routes runtime DB traffic through the pre-M212 proxy/db.localtest.me path.
      await this.assertDirectTransportBaseline(profile, projectName);

      // M212 — materialize app-postgres (and its volume) before any
      // nautilo-server start so legacy postgres-owned objects can be
      // repaired as the postgres superuser inside the container.
      log("deploy: starting app-postgres before M212 ownership repair...");
      await this.runCompose(
        baseComposeArgs([
          ...deployEnvAndProfiles,
          "up",
          "-d",
          "--wait",
          ...(registryMode ? [] : ["--build"]),
          "app-postgres",
        ]),
        { stdio: "inherit" },
      );
      await this.repairAppDbOwnership(
        {
          transport: "local_compose",
          composeBin: this.deps.composeBin,
          composeArgs: this.deps.composeArgs,
          composeProjectArgs: baseComposeArgs(deployEnvAndProfiles),
        },
        this.sqlPipelineExec(profile),
      );

      log("deploy: starting logto-postgres before Logto pre-seed recovery...");
      await this.runCompose(
        baseComposeArgs([
          ...deployEnvAndProfiles,
          "up",
          "-d",
          "--wait",
          ...(registryMode ? [] : ["--build"]),
          "logto-postgres",
        ]),
        { stdio: "inherit" },
      );
      await this.preflightLogtoPreSeedRecovery(
        {
          transport: "local_compose",
          composeBin: this.deps.composeBin,
          composeArgs: this.deps.composeArgs,
          composeProjectArgs: baseComposeArgs(deployEnvAndProfiles),
        },
        this.sqlPipelineExec(profile),
      );
      await this.preflightLogtoTenantPasswordResync(
        {
          transport: "local_compose",
          composeBin: this.deps.composeBin,
          composeArgs: this.deps.composeArgs,
          composeProjectArgs: baseComposeArgs(deployEnvAndProfiles),
        },
        this.sqlPipelineExec(profile),
      );

      // Up the auth + app profiles without nautilo-server. Starting the server
      // before Logto bootstrap used to race its database migrations against the
      // post-bootstrap server recreate. A long fresh migration could be killed
      // halfway through and leave a poisoned volume that no retry could reuse.
      // The server starts exactly once below, after its complete env exists.
      log(
        registryMode
          ? "deploy: docker compose up -d (auth + app profiles, registry mode)..."
          : "deploy: docker compose up -d --build (auth + app profiles)...",
      );
      await this.runCompose(
        baseComposeArgs([
          ...deployEnvAndProfiles,
          "up",
          "-d",
          "--scale",
          "nautilo-server=0",
          ...(registryMode ? [] : ["--build"]),
        ]),
        { stdio: "inherit" },
      );

      await this.recreateLogtoCoreAfterAuthUp({
        transport: "local_compose",
        composeBin: this.deps.composeBin,
        composeArgs: this.deps.composeArgs,
        composeProjectArgs: baseComposeArgs(deployEnvAndProfiles),
        registryMode,
      });

      // D427 (Wave 3 task 3.1.2) — deterministically refresh Caddy when
      // nautilo-server or logto changed so a changed upstream cannot leave
      // a stale reverse-proxy IP. A failed recreate throws and drives the
      // existing rollback behavior (fail closed).
      if (this.deps.enableDependencyRefresh) {
        const changedUpstreams = registryMode
          ? ["nautilo-server"]
          : FULL_DEPLOY_CHANGED_UPSTREAMS;
        const recreate = computeDependencyRefreshRecreate(changedUpstreams, profile);
        for (const svc of recreate) {
          log(
            `deploy: refreshing dependency proxy '${svc}' (deterministic recreate after upstream change)...`,
          );
          await this.runCompose(
            baseComposeArgs([
              "--env-file",
              toLocal(composeEnvPath),
              "--profile",
              "auth",
              "--profile",
              "app",
              ...(profile.office === true ? ["--profile", "office"] : []),
              "up",
              "-d",
              "--force-recreate",
              "--no-deps",
              svc,
            ]),
            { stdio: "inherit" },
          );
        }
      }

      log(`deploy: polling Logto health at ${composeEnv["LOGTO_ENDPOINT"]}...`);
      await this.pollLogtoHealth(composeEnv["LOGTO_ENDPOINT"]!);
      log("deploy: Logto healthy");

      log("deploy: bootstrapping Logto (apps, resource, roles, admin user)...");
      if (profile.transport === "remote" && profile.ssh !== undefined) {
        const tunnel = await this.deps.openSshTunnel(profile.ssh, [
          {
            local: inst.logto.corePort,
            remoteHost: "127.0.0.1",
            remote: inst.logto.corePort,
          },
          {
            local: inst.logto.adminPort,
            remoteHost: "127.0.0.1",
            remote: inst.logto.adminPort,
          },
          {
            local: inst.logto.dbPort,
            remoteHost: "127.0.0.1",
            remote: inst.logto.dbPort,
          },
        ]);
        try {
          await bootstrapLogtoForProfile(profile, {
            runBootstrap: this.deps.runBootstrap,
            dbPasswords: passwords,
            writeAppliedAuthContract: (stamp) =>
              this.writeLocalAppliedAuthContract(stamp, operatorInstanceRootDir),
            ...(forgotPasswordWebhookSecret !== undefined
              ? { forgotPasswordWebhookSecret }
              : {}),
          });
        } finally {
          await tunnel.close();
        }
      } else {
        await bootstrapLogtoForProfile(profile, {
          runBootstrap: this.deps.runBootstrap,
          dbPasswords: passwords,
          writeAppliedAuthContract: (stamp) =>
            this.writeLocalAppliedAuthContract(stamp, operatorInstanceRootDir),
          ...(forgotPasswordWebhookSecret !== undefined
            ? { forgotPasswordWebhookSecret }
            : {}),
        });
      }
      // M118 drive-by: provision NAUTILO_BOOTSTRAP_TOKEN to
      // operator-side `instance.env` + `~/.nautilo/bootstrap-tokens/<profile>`
      // BEFORE the remote mirror + first server up. See the
      // `ensureBootstrapToken` field on ComposeDriverDeps for rationale.
      // Idempotent: returns the existing token if one is already
      // present. For remote profiles, the very next block mirrors
      // operator-side instance.env to the droplet so the freshly
      // written line travels along the same rsync path as LOGTO_*.
      if (this.deps.ensureBootstrapToken) {
        const home =
          process.env["HOME"]?.trim() ||
          process.env["USERPROFILE"]?.trim() ||
          homedir();
        log("deploy: provisioning NAUTILO_BOOTSTRAP_TOKEN (operator-side)...");
        this.deps.ensureBootstrapToken(profile, home);
        // The compatibility helper may atomically rename over the legacy
        // symlink. Adopt that completed file back into runtime-config before
        // mirroring it to the deployment host.
        await ensureCanonicalConfigLayout(operatorInstanceRootDir);
      }

      if (profile.transport === "remote") {
        const home =
          process.env["HOME"]?.trim() ||
          process.env["USERPROFILE"]?.trim() ||
          homedir();
        const operatorInstanceEnv = canonicalInstanceEnvPath(
          localInstanceRootDir(home, profile.instance_id),
        );
        let operatorEnvContents = "";
        try {
          operatorEnvContents = await nodeFs.readFile(operatorInstanceEnv, "utf8");
        } catch {
          /* bootstrap may have written nothing if LOGTO already provisioned */
        }
        await this.deps.fs.writeFile(
          canonicalInstanceEnvPath(instanceRootDir),
          operatorEnvContents,
          { mode: 0o600 },
        );
      }

      const instanceEnv = await this.deps.readInstanceLogtoEnv(instanceRootDir);
      const overlayEnv = buildServerOverlayEnv(inst, instanceEnv, {
        passwordRecoveryDriver,
        forgotPasswordWebhookSecret,
        remotePairingPepper,
        pushTokenEncryptionKey,
      });
      const serverEnvPath = join(instanceRootDir, "deploy.server.env");
      await this.deps.fs.writeFile(
        serverEnvPath,
        envFileContents(overlayEnv),
        { mode: 0o600 },
      );
      const overlayYmlPath = join(instanceRootDir, "deploy.server-overlay.yml");
      const instanceEnvPath = canonicalInstanceEnvPath(instanceRootDir);
      // `env_file:` paths inside compose YAML are parsed client-side
      // (docker CLI loads the file and injects vars as `environment:`
      // in the container spec sent to the daemon). For remote
      // profiles this must point at the operator-side staging file,
      // not the remote path. Same gotcha as `--env-file`. The
      // `volumes:` source, by contrast, is resolved daemon-side, so
      // the config-dir mount takes the daemon-side parent of
      // instance.env (D445 Phase 0).
      await this.deps.fs.writeFile(
        overlayYmlPath,
        serverOverlayYaml(
          toLocal(serverEnvPath),
          toLocal(instanceEnvPath),
          runtimeConfigDir(instanceRootDir),
          this.deps.managedServerEnvPath,
        ),
        { mode: 0o600 },
      );

      if (isRemoteFs(this.deps.fs)) {
        log("deploy: rsync (post-bootstrap, includes instance.env)...");
        await this.deps.fs.syncToRemote();
      }

      // Re-up the server with the overlay so it picks up LOGTO_* +
      // anything else currently in instance.env. Up to three env_files are
      // wired into the overlay — see serverOverlayYaml() comment.
      // Note: serverOverlayYaml above embeds the REMOTE paths (read by
      // the daemon); here we use LOCAL paths (parsed by the client).
      // M117 — include `--profile auth` so `logto` is in the active
      // project graph. Even with `--no-deps nautilo-server`, compose
      // validates the Caddy overlay's `depends_on: logto` against
      // enabled profiles BEFORE honoring --no-deps. Without `auth`,
      // the re-up errors with: "service 'caddy' depends on undefined
      // service 'logto'". The actual up operation is still narrowed
      // to nautilo-server by --no-deps + named service.
      const serverUpArgs = baseComposeArgs([
        "-f",
        toLocal(overlayYmlPath),
        "--env-file",
        toLocal(composeEnvPath),
        "--profile",
        "auth",
        "--profile",
        "app",
        "up",
        "-d",
        "--no-deps",
        ...(registryMode ? ["--no-build"] : []),
        "nautilo-server",
      ]);
      log("deploy: re-upping nautilo-server with LOGTO_* overlay...");
      await this.runCompose(serverUpArgs, { stdio: "inherit" });

      const serverBaseUrl = resolveServerBaseUrl(profile, inst);
      log(`deploy: polling server health at ${serverBaseUrl}/health (timeout ${this.deps.serverHealthTimeoutMs}ms)...`);
      await this.pollServerHealthForProfile(profile, serverBaseUrl);
      log("deploy: server healthy");

      if (
        profile.transport === "remote" &&
        profile.from_source !== false &&
        isRemoteFs(this.deps.fs)
      ) {
        const running = await this.captureRunningServerArtifact(profile);
        const { repoDigest: _syntheticRepoDigest, ...sourceIdentity } = running;
        await this.commitRemoteDeploymentManifestArtifact(profile, {
          ...sourceIdentity,
          mode: "source",
          requested: "compose-source",
        });
      }

      // First-deploy provider hook (provider apply + consumed sentinel).
      // Owner setup is a separate post-health CLI protocol and never runs
      // inside this driver hook.
      //
      // For remote profiles, the hook's `instanceRootDir` MUST be the
      // operator-side path. Everything the hook reads/writes —
      // `instance.json` (by `resolveInstance()`), the consumed-at
      // sentinel, provider env writes to `instance.env`,
      // `ensureBootstrapToken` — is operator-side state. The remote
      // `<remoteRoot>` is only meaningful to the daemon.
      if (this.deps.firstDeployConsume) {
        log("deploy: applying frozen first-deploy provider configuration...");
        const deployTomlPath = join(
          process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
          "nautilo",
          "deploy.toml",
        );
        const hookInstanceRootDir = this.deps.resolveLocalInstanceRootDir(profile);
        await this.deps.firstDeployConsume({
          profile,
          instanceRootDir: hookInstanceRootDir,
          deployTomlPath,
        });
        await ensureCanonicalConfigLayout(hookInstanceRootDir);
        if (profile.transport === "remote") {
          const hookEnvContents = await nodeFs.readFile(
            canonicalInstanceEnvPath(hookInstanceRootDir),
            "utf8",
          );
          await this.deps.fs.writeFile(
            canonicalInstanceEnvPath(instanceRootDir),
            hookEnvContents,
            { mode: 0o600 },
          );
          if (isRemoteFs(this.deps.fs)) {
            await this.deps.fs.syncToRemote();
          }
        }

        // The hook may have written new keys to instance.env
        // (providers, future config-guard-managed values). The
        // container's env was snapshotted at the previous up -d, so
        // re-up the server one more time to surface them. Idempotent
        // when no env changed — compose recreates only when needed.
        log("deploy: re-upping server after first-deploy hook...");
        await this.runCompose(serverUpArgs, { stdio: "inherit" });
      }
      await this.acceptAndCleanupRetiredTopologyIfPresent(profile, projectName);
      log("deploy: done");
    } finally {
      restoreEnv();
    }
  }

  /**
   * Attach the manifest required by the SSH-native day-two path to a running
   * legacy source-mode remote Compose install. Inspection never invokes
   * Compose, builds, pulls, or changes containers or volumes.
   */
  async adopt(
    profile: ComposeDriverProfile,
    opts: AdoptOptions = {},
  ): Promise<void> {
    if (profile.transport !== "remote" || profile.ssh === undefined) {
      throw new Error("adopt requires a remote compose profile with an SSH target.");
    }
    if (profile.lifecycle !== "compose") {
      throw new Error("adopt requires a compose-lifecycle profile.");
    }
    if (profile.from_source === false) {
      throw new Error(
        "adopt only supports legacy source-mode installs; registry-mode targets must already have a manifest.",
      );
    }
    if (opts.confirm === true && opts.dryRun === true) {
      throw new Error("--dry-run and --confirm cannot be used together.");
    }
    // D427 Wave 1 (task 1.2.1) — confirmed adoption requires a verified
    // recovery bundle so a resumed bootstrap has a proven rollback target.
    // Dry-run is mutation-free and never verifies or reads the bundle.
    let verifiedProvenance: BundleProvenance | undefined;
    if (opts.confirm === true) {
      const bundlePath = opts.bundlePath?.trim();
      if (!bundlePath) {
        throw new Error(
          "adopt --confirm requires a verified recovery bundle reference (--bundle <path>). Run `nautilo backup verify <path>` first.",
        );
      }
      const report = await this.verifyBundle(profile, bundlePath);
      if (!report.ok || report.provenance === undefined) {
        const failed = report.checks
          .filter((c) => c.status === "fail")
          .map((c) => `${c.name}: ${c.detail ?? "failed"}`)
          .join("; ");
        throw new Error(
          `adopt refused: recovery bundle '${bundlePath}' did not pass verification${
            failed ? ` (${failed})` : ""
          }. No files were changed.`,
        );
      }
      verifiedProvenance = report.provenance;
    }

    const remoteRoot = this.deps.resolveInstanceRootDir(profile);
    const projectName = composeProjectName(profile);
    const manifestPath = posix.join(remoteRoot, "deployment-manifest.json");
    const requiredServices = [
      "nautilo-server",
      "app-postgres",
      "logto-postgres",
      "logto",
      ...(profile.https === "letsencrypt" ? ["caddy"] : []),
    ];
    const inspectScript = [
      "set -eu",
      `root=${shellQuote(remoteRoot)}`,
      `project=${shellQuote(projectName)}`,
      `manifest=${shellQuote(manifestPath)}`,
      'if [ -e "$manifest" ]; then exit 40; fi',
      'if [ ! -d "$root" ] || [ ! -r "$root" ]; then exit 41; fi',
      'if ! docker info >/dev/null 2>&1; then exit 42; fi',
      'ids="$(docker ps -q --filter "label=com.docker.compose.project=$project")"',
      'if [ -z "$ids" ]; then exit 43; fi',
      'services="$(docker inspect --format "{{index .Config.Labels \\"com.docker.compose.service\\"}}={{.State.Status}}={{.Config.Image}}={{index .Config.Labels \\"com.docker.compose.project.working_dir\\"}}" $ids)"',
      'legacy_working_dir=""',
      `for service in ${requiredServices.map(shellQuote).join(" ")}; do`,
      '  line="$(printf "%s\\n" "$services" | awk -F= -v service="$service" \'$1 == service { line = $0; count++ } END { if (count != 1) exit 1; print line }\')" || exit 44',
      '  status="${line#*=}"; status="${status%%=*}"',
      '  image="${line#*=}"; image="${image#*=}"; image="${image%%=*}"',
      '  working_dir="${line##*=}"',
      '  if [ "$status" != "running" ] || [ -z "$image" ] || [ "$image" = "<no value>" ]; then exit 45; fi',
      // Legacy source stacks record the operator checkout as working_dir even
      // though persistent bytes live under remoteRoot. A partially completed
      // registry migration legitimately has both that one legacy label and
      // remoteRoot labels (newly recreated services). Accept that bounded
      // pair, but fail closed if services report two different non-root
      // origins; that would be an ambiguous mixed deployment.
      '  if [ "$working_dir" != "$root" ]; then if [ -z "$legacy_working_dir" ]; then legacy_working_dir="$working_dir"; elif [ "$working_dir" != "$legacy_working_dir" ]; then exit 47; fi; fi',
      "done",
      'if [ -z "$(printf "%s\\n" "$services" | awk -F= \'$1 == "caddy" { print; exit }\')" ]; then :; elif [ "' +
        (profile.https === "letsencrypt" ? "yes" : "no") +
        '" = "no" ]; then exit 47; fi',
      `for volume in ${shellQuote(`${projectName}_app_artifacts`)} ${shellQuote(`${projectName}_app_media`)}; do`,
      '  docker volume inspect "$volume" >/dev/null 2>&1 || exit 46',
      "done",
      'server_image="$(printf "%s\\n" "$services" | awk -F= \'$1 == "nautilo-server" { print $3; exit }\')"',
      'printf "%s\\n" "$server_image"',
    ].join("\n");
    const inspection = await this.execWithoutDockerHost("sh", ["-lc", inspectScript], {
      stdio: "pipe",
    });
    if (inspection.code !== 0) {
      if (this.looksLikeSshFailure(inspection.stderr)) {
        throw new Error(
          `adopt refused: SSH target for profile '${profile.name}' could not be inspected (exit ${inspection.code}).`,
        );
      }
      const reason: Record<number, string> = {
        40: "a deployment manifest is already present",
        41: "the expected remote root is missing or unreadable",
        42: "Docker is unavailable on the SSH target",
        43: "no containers carry the expected Compose project label",
        44: "the Compose service set is missing or ambiguous",
        45: "a required Compose service is unhealthy or has no running image",
        46: "a required persistent artifact/media volume is missing",
        47: "the profile root or HTTPS mode does not match the running Compose target",
      };
      throw new Error(
        `adopt refused: ${reason[inspection.code] ?? "remote inspection failed"} (exit ${inspection.code}). No files were changed.`,
      );
    }

    const baseUrl = resolveServerBaseUrl(profile, this.resolveInstanceForProfile());
    let health: Response;
    try {
      health = await this.deps.fetch(`${baseUrl}/health`);
    } catch {
      throw new Error(
        `adopt refused: public health check ${baseUrl}/health could not be reached. No files were changed.`,
      );
    }
    if (!health.ok) {
      throw new Error(
        `adopt refused: public health check ${baseUrl}/health returned HTTP ${health.status}. No files were changed.`,
      );
    }

    const image = inspection.stdout.trim();
    if (image === "") {
      throw new Error(
        "adopt refused: the running nautilo-server image could not be determined. No files were changed.",
      );
    }
    const now = this.deps.now().toISOString();
    const contracts: {
      legacyAdopted: true;
      adoption?: {
        phase: "confirmed";
        confirmedAt: string;
        bundle: {
          manifestSha256: string;
          createdAt: string;
          verifiedAt: string;
          imageMode: "registry" | "source";
          imageReference: string;
        };
        runningImageReference: string;
      };
    } = { legacyAdopted: true };
    if (verifiedProvenance) {
      contracts.adoption = {
        phase: "confirmed",
        confirmedAt: now,
        bundle: {
          manifestSha256: verifiedProvenance.manifestSha256,
          createdAt: verifiedProvenance.createdAt,
          verifiedAt: verifiedProvenance.verifiedAt,
          imageMode: verifiedProvenance.imageMode,
          imageReference: verifiedProvenance.imageReference,
        },
        runningImageReference: image,
      };
    }
    const manifest = remoteDeploymentManifestV2Schema.parse({
      version: 2,
      instanceId: (profile.instance_id ?? "").trim(),
      composeProjectName: projectName,
      lifecycle: "compose",
      image: { mode: "source", reference: image },
      remoteRoot,
      https: profile.https === "letsencrypt" ? "letsencrypt" : "off",
      contracts,
      createdAt: now,
      updatedAt: now,
    });

    this.deps.log(
      `adopt: validated ${projectName} at ${remoteRoot}; source image=${image}`,
    );
    if (opts.confirm !== true) {
      this.deps.log("adopt: dry run complete; no files were changed.");
      return;
    }

    const encoded = Buffer.from(
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    ).toString("base64");
    const writeScript = [
      "set -eu",
      `manifest=${shellQuote(manifestPath)}`,
      'if [ -e "$manifest" ]; then exit 40; fi',
      'tmp="${manifest}.tmp-$$"',
      "umask 077",
      `printf %s ${shellQuote(encoded)} | base64 -d > "$tmp"`,
      'chmod 600 "$tmp"',
      // `ln` publishes a fully-written inode without replacing a manifest
      // created after the preflight; unlike `mv`, it fails when the target
      // already exists.
      'ln "$tmp" "$manifest" || { rm -f -- "$tmp"; if [ -e "$manifest" ]; then exit 40; fi; exit 48; }',
      'rm -f -- "$tmp"',
    ].join("; ");
    const write = await this.execWithoutDockerHost("sh", ["-lc", writeScript], {
      stdio: "pipe",
    });
    if (write.code === 40) {
      throw new Error(
        "adopt refused: a deployment manifest appeared during validation; no existing manifest was overwritten.",
      );
    }
    if (write.code === 48) {
      throw new Error(
        "adopt failed: atomic deployment manifest publication failed without creating a manifest.",
      );
    }
    if (write.code !== 0) {
      if (this.looksLikeSshFailure(write.stderr)) {
        throw new Error(
          `adopt failed: SSH target disconnected before the manifest write (exit ${write.code}).`,
        );
      }
      throw new Error(
        `adopt failed: atomic deployment manifest write failed (exit ${write.code}).`,
      );
    }
    this.deps.log(`adopt: wrote ${manifestPath}`);
  }

  /**
   * D427 Wave 2 — the deliberately narrow legacy conversion transaction.
   * Its cursor is stored beside the adopted manifest, so an operator with
   * SSH/Docker access can resume without an operator-laptop secret mirror.
   */
  async bootstrapLegacy(
    profile: ComposeDriverProfile,
    opts: BootstrapLegacyOptions = {},
  ): Promise<BootstrapLegacyReport> {
    if (profile.transport !== "remote" || profile.ssh === undefined || profile.lifecycle !== "compose") {
      throw new Error("bootstrap legacy requires a remote compose profile with an SSH target.");
    }
    const plan = opts.plan !== false;
    const bundlePath = opts.bundlePath?.trim();
    const imageRef = opts.imageRef?.trim();
    if (!plan && (!opts.confirmAdoption || !opts.confirmDeploy)) {
      throw new Error(
        "bootstrap legacy confirmed mode requires both --confirm-adoption and --confirm-deploy.",
      );
    }
    if (!plan && !bundlePath) {
      throw new Error(
        "bootstrap legacy confirmed mode requires --bundle <verified recovery bundle path>.",
      );
    }
    if (!plan && !imageRef) {
      throw new Error(
        "bootstrap legacy confirmed mode requires --image <full immutable registry reference>.",
      );
    }
    if (imageRef && !isImmutableRegistryImageRef(imageRef)) {
      throw new Error(
        "bootstrap legacy --image must be a full immutable registry reference with an @sha256 digest.",
      );
    }

    // Plan mode is intentionally limited to observation. `adopt` performs
    // the remote Docker/health inspection without writes; bundle verification
    // is local read-only; authPlan is a pure classifier.
    if (plan) {
      this.deps.log("bootstrap legacy plan: doctor (read-only requirements listed)");
      this.deps.log("bootstrap legacy plan: verified bundle");
      this.deps.log(
        `bootstrap legacy plan: registry image=${imageRef ?? "(required for confirmed mode)"}`,
      );
      if (bundlePath) {
        const report = await this.verifyBundle(profile, bundlePath);
        if (!report.ok) throw new Error("bootstrap legacy plan: supplied recovery bundle did not verify.");
      }
      await this.adopt(profile, { dryRun: true });
      await this.authPlan(profile);
      this.deps.log(
        "bootstrap legacy plan: adoption confirmation → remote materialization → pinned registry deploy → auth plan → runtime acceptance",
      );
      return { mode: "plan", completedPhase: "adopted" };
    }

    let completed: BootstrapLegacyReport["completedPhase"] = "adopted";
    try {
      if (this.deps.doctor) await this.deps.doctor(profile);
      const verification = await this.verifyBundle(profile, bundlePath!);
      if (!verification.ok) {
        throw new Error("verified recovery bundle did not pass verification.");
      }

      let manifest: RemoteDeploymentManifest;
      try {
        manifest = await this.readRemoteDeploymentManifest(profile);
      } catch (error) {
        // A missing manifest is the sole case that begins adoption. Any
        // malformed/unreachable manifest is fail-closed rather than guessed.
        if (!/missing or unreadable/.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
        await this.adopt(profile, { confirm: true, bundlePath: bundlePath! });
        manifest = await this.readRemoteDeploymentManifest(profile);
      }
      if (
        manifest.version !== 2 ||
        manifest.contracts.legacyAdopted !== true ||
        manifest.contracts.adoption === undefined
      ) {
        throw new Error("bootstrap legacy refused: remote manifest is not a confirmed legacy adoption.");
      }
      const persistedImage = manifest.contracts.legacyBootstrap?.imageReference;
      if (persistedImage !== undefined && persistedImage !== imageRef) {
        throw new Error(
          `bootstrap legacy refused: resume image '${imageRef}' does not match the originally confirmed image '${persistedImage}'.`,
        );
      }
      completed = manifest.contracts.legacyBootstrap?.phase ?? "adopted";
      const pinnedImage = persistedImage ?? imageRef!;
      if (persistedImage === undefined) {
        await this.updateLegacyBootstrapPhase(manifest, "adopted", pinnedImage);
        manifest = await this.readRemoteDeploymentManifest(profile);
      }

      // deploy() is SSH-native and idempotently materializes the remote
      // template/env/overlay before pulling the pinned registry image.
      await this.deploy({ ...profile, from_source: false, image_ref: pinnedImage });
      manifest = await this.readRemoteDeploymentManifest(profile);
      await this.updateLegacyBootstrapPhase(manifest, "materialized", pinnedImage);
      await this.updateLegacyBootstrapPhase(manifest, "deployed", pinnedImage);
      completed = "deployed";

      const auth = await this.authPlan(profile);
      if (auth.classification === "unknown" || auth.classification === "incompatible") {
        throw new Error(
          `bootstrap legacy paused after deploy: auth plan is ${auth.classification}; review the plan and complete any auth/session confirmation before retrying.`,
        );
      }
      manifest = await this.readRemoteDeploymentManifest(profile);
      await this.updateLegacyBootstrapPhase(manifest, "auth-planned", pinnedImage);
      completed = "auth-planned";

      // deploy() has already proven runtime health. Persist acceptance only
      // after the auth plan is known compatible.
      manifest = await this.readRemoteDeploymentManifest(profile);
      await this.updateLegacyBootstrapPhase(manifest, "accepted", pinnedImage);
      return { mode: "confirmed", completedPhase: "accepted" };
    } catch (error) {
      throw new Error(
        `bootstrap legacy interrupted after phase '${completed}'; recovery bundle=${bundlePath}. Retry the same command after fixing the cause: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async status(profile: ComposeDriverProfile): Promise<ComposeStatusObservation> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      if (usesRemoteRegistryMode(profile)) {
        return await this.statusRemote(profile);
      }

      const projectName = composeProjectName(profile);
      const baseYml = join(this.deps.templateDir, "docker-compose.yml");

      const cleanup = await this.inspectCleanup(profile);
      if (cleanup.containersAbsent && cleanup.networksAbsent && cleanup.dataVolumesAbsent) {
        return {
          composeProjectName: projectName,
          compose: "absent",
          health: "unavailable",
        };
      }

      // M116 — the compose YAML uses `${NAUTILO_DB_PASSWORD:?...}` style
      // mandatory substitutions. Every verb that parses the YAML (ps,
      // logs, restart, down) must supply --env-file or compose errors
      // out before reaching the verb. Use the deploy.compose.env from
      // the previous deploy() if it exists.
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
      if (!composeEnvPath) {
        return {
          composeProjectName: projectName,
          compose: "unknown",
          health: "unavailable",
        };
      }

      const psArgs = [
        "--project-name",
        projectName,
        "-f",
        baseYml,
      ];
      if (composeEnvPath) psArgs.push("--env-file", composeEnvPath);
      if (caddyOverlayPath) psArgs.push("-f", caddyOverlayPath);
      psArgs.push("ps", "--format", "json");

      const ps = await this.runCompose(psArgs, { stdio: "pipe" });
      this.deps.log(ps.stdout);

      const compose = composePresenceFromPs(ps.stdout);

      if (compose === "absent") {
        return {
          composeProjectName: projectName,
          compose,
          health: "unavailable",
        };
      }
      const inst = this.resolveInstanceForProfile();
      const baseUrl = resolveServerBaseUrl(profile, inst);
      const healthRes = await this.deps.fetch(`${baseUrl}/health`);
      if (!healthRes.ok) {
        throw new Error(
          `status: GET ${baseUrl}/health failed: HTTP ${healthRes.status}`,
        );
      }
      this.deps.log(await healthRes.text());
      const setupRes = await this.deps.fetch(`${baseUrl}/api/setup/status`);
      if (!setupRes.ok) {
        throw new Error(
          `status: GET ${baseUrl}/api/setup/status failed: HTTP ${setupRes.status}`,
        );
      }
      const setupBody = await setupRes.text();
      this.deps.log(setupBody);
      let setupState: string | undefined;
      let claimRequired: boolean | undefined;
      try {
        const parsed = JSON.parse(setupBody) as { setupState?: string; claimRequired?: boolean };
        const state = parsed.setupState ?? "unknown";
        setupState = parsed.setupState;
        claimRequired = parsed.claimRequired;
        const claim = parsed.claimRequired === true ? "claim REQUIRED" : "claim done";
        this.deps.log(`\n→ ${baseUrl}: setupState=${state}, ${claim}\n`);
      } catch {
        /* tolerate non-JSON */
      }
      return {
        composeProjectName: projectName,
        serverUrl: baseUrl,
        compose,
        health: "ready",
        ...(setupState === undefined ? {} : { setupState }),
        ...(claimRequired === undefined ? {} : { claimRequired }),
      };
    } finally {
      restoreEnv();
    }
  }

  /**
   * Read the durable auth stamp and inspect the running Logto image. This
   * deliberately performs no compose, container, manifest, database, or
   * environment writes.
   *
   * The bundled contract is the currently available incoming-contract source.
   * An artifact-specific image reader belongs to the forthcoming release verb;
   * this method accepts an injected contract so that verb can supply one
   * without changing classification semantics.
   */
  async authPlan(
    profile: ComposeDriverProfile,
    incomingContract: AuthContract = buildAuthContract(),
  ): Promise<AuthPlanReport> {
    gates(profile);
    try {
      if (profile.transport === "remote") {
        const manifest = await this.readRemoteDeploymentManifest(profile);
        return classifyAuthPlan({
          incoming: incomingContract,
          applied:
            manifest.version === 2 ? manifest.contracts.authApplied ?? null : null,
          liveLogtoEngineImage: await this.readRunningLogtoImage(
            profile,
            manifest.composeProjectName,
          ),
        });
      }

      const stampPath = join(
        this.deps.resolveInstanceRootDir(profile),
        "auth-contract-applied.json",
      );
      let applied = null;
      try {
        const raw = await this.deps.fs.readFile(stampPath, "utf8");
        applied = appliedAuthContractSchema.parse(JSON.parse(raw));
      } catch {
        // The pure classifier intentionally fails closed for missing or
        // malformed local stamps without repairing or replacing anything.
      }
      return classifyAuthPlan({
        incoming: incomingContract,
        applied,
        liveLogtoEngineImage: await this.readRunningLogtoImage(
          profile,
          composeProjectName(profile),
        ),
      });
    } catch (error) {
      const plan = classifyAuthPlan({ incoming: incomingContract, applied: null });
      return {
        ...plan,
        reasons: [
          `Unable to inspect the persisted remote auth stamp: ${error instanceof Error ? error.message : String(error)}`,
          ...plan.reasons,
        ],
      };
    }
  }

  private async inspectRemoteAuthRuntime(
    profile: ComposeDriverProfile,
    projectName: string,
    failurePrefix = "auth reconcile refused: ",
    failureEffect = "No backup or auth changes were made.",
  ): Promise<RemoteAuthRuntimePorts> {
    const result = await this.execWithoutDockerHost(
      "sh",
      ["-lc", buildRemoteAuthRuntimeInspectScript(projectName)],
      { stdio: "pipe" },
    );
    if (result.code !== 0) {
      throw new Error(
        `${failurePrefix}unable to discover the running Logto port bindings for ` +
          `profile '${profile.name}' (exit ${result.code}): ${result.stderr.trim() || "remote inspection failed"}. ` +
          failureEffect,
      );
    }
    try {
      return parseRemoteAuthRuntimePorts(result.stdout);
    } catch (error) {
      throw new Error(
        `${failurePrefix}running Logto port inspection returned invalid data for ` +
          `profile '${profile.name}': ${errorMessage(error)}. ${failureEffect}`,
      );
    }
  }

  private async readRemoteCanonicalInstanceEnv(
    remoteRoot: string,
  ): Promise<{ contents: string; parsed: Record<string, string> }> {
    const path = posix.join(
      remoteRoot,
      RUNTIME_CONFIG_DIR_NAME,
      "instance.env",
    );
    const result = await this.execWithoutDockerHost("cat", [path], {
      stdio: "pipe",
    });
    if (result.code !== 0 || result.stdout.trim() === "") {
      throw new Error(
        `auth reconcile refused: canonical remote instance.env is missing or unreadable at ${path}. ` +
          "No backup or auth changes were made.",
      );
    }
    return { contents: result.stdout, parsed: parseDotenv(result.stdout) };
  }

  /**
   * Explicit maintenance lane for applying the current managed Logto desired
   * state. It is deliberately separate from upgrade/release: reconciliation
   * takes a full backup first, never repairs missing durable state, and only
   * records the new applied stamp after the reconciled live image proves
   * compatible with the incoming contract.
   */
  async authReconcile(
    profile: ComposeDriverProfile,
    opts: AuthReconcileOptions,
  ): Promise<AuthReconcileResult> {
    if (opts.confirmSessionImpact !== true) {
      throw new Error(
        "auth reconcile refused: pass --confirm-session-impact because reconciliation may affect existing sessions.",
      );
    }
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      const incoming = buildAuthContract();
      const remoteManifest =
        profile.transport === "remote"
          ? await this.readRemoteDeploymentManifest(profile)
          : undefined;
      const isLegacyAdoptedWithoutAuthStamp =
        remoteManifest?.version === 2 &&
        remoteManifest.contracts.legacyAdopted === true &&
        remoteManifest.contracts.authApplied === undefined;
      const preflight = isLegacyAdoptedWithoutAuthStamp
        ? classifyAuthPlan({
            incoming,
            // This is an in-memory compatibility probe only. The durable
            // applied stamp is still written exclusively after backup,
            // reconciliation, and compatible postflight verification.
            applied: buildAppliedAuthContract(this.deps.now().toISOString(), incoming),
            liveLogtoEngineImage: await this.readRunningLogtoImage(
              profile,
              remoteManifest.composeProjectName,
            ),
          })
        : await this.authPlan(profile, incoming);
      if (
        preflight.classification === "unknown" ||
        preflight.classification === "incompatible"
      ) {
        throw new Error(
          `auth reconcile refused: auth plan is ${preflight.classification}; ` +
            "reconciliation does not adopt missing state or perform auth migration.",
        );
      }

      // A v1 remote manifest has no durable auth stamp field. Do not silently
      // migrate/adopt it as part of reconciliation; that remains an explicit
      // separate operation. A v2 manifest without the narrow `legacyAdopted`
      // provenance marker remains unknown and fails closed above.
      if (remoteManifest !== undefined && remoteManifest.version !== 2) {
        throw new Error(
          "auth reconcile refused: remote deployment manifest has no applied-auth stamp; reconciliation does not migrate or adopt legacy manifests.",
        );
      }

      const operatorInstanceRootDir =
        this.deps.resolveLocalInstanceRootDir(profile);
      const inst = this.resolveInstanceForProfile();
      const passwordRecoveryDriver = profile.password_recovery ?? "oss_relay";
      const usesPasswordRecoveryRelay = passwordRecoveryUsesOssRelay({
        ...process.env,
        NAUTILO_PASSWORD_RECOVERY_DRIVER: passwordRecoveryDriver,
      });
      let remoteRuntime: RemoteAuthRuntimePorts | undefined;
      let remoteCanonicalEnv:
        | { contents: string; parsed: Record<string, string> }
        | undefined;
      if (profile.transport === "remote") {
        if (profile.ssh === undefined || remoteManifest === undefined) {
          throw new Error(
            "auth reconcile requires an SSH profile and deployment manifest for remote deployments.",
          );
        }
        this.deps.log(
          "auth reconcile: discovering running remote Logto port bindings...",
        );
        remoteRuntime = await this.inspectRemoteAuthRuntime(
          profile,
          remoteManifest.composeProjectName,
        );
        this.deps.log(
          `auth reconcile: resolved remote Logto ports ` +
            `(core=${remoteRuntime.logtoCore}, admin=${remoteRuntime.logtoAdmin}, db=${remoteRuntime.logtoDb}).`,
        );
        this.deps.log(
          "auth reconcile: reading canonical remote auth configuration...",
        );
        remoteCanonicalEnv = await this.readRemoteCanonicalInstanceEnv(
          remoteManifest.remoteRoot,
        );
        if (!remoteCanonicalEnv.parsed["LOGTO_DB_PASSWORD"]?.trim()) {
          throw new Error(
            "auth reconcile refused: canonical remote instance.env has no LOGTO_DB_PASSWORD. " +
              "No backup or auth changes were made.",
          );
        }
        if (
          usesPasswordRecoveryRelay &&
          !remoteCanonicalEnv.parsed[
            "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET"
          ]?.trim()
        ) {
          throw new Error(
            "auth reconcile refused: canonical remote instance.env has no " +
              "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET required by the oss_relay password-recovery driver. " +
              "No backup or auth changes were made.",
          );
        }
      }

      const bundleDir = join(
        operatorInstanceRootDir,
        "backups",
        `auto-pre-auth-reconcile-${backupTimestamp(this.deps.now())}`,
      );
      this.deps.log(`auth reconcile: creating pre-reconcile backup at ${bundleDir}`);
      const backupPath = await this.backup(profile, { toPath: bundleDir });

      let temporaryRemoteEnvPath: string | undefined;
      try {
        const passwords =
          remoteCanonicalEnv === undefined
            ? await this.deps.ensureDbPasswords({
                instanceRootDir: operatorInstanceRootDir,
                composeProjectName: composeProjectName(profile),
                appPostgresHostPort: inst.db.postgresHostPort,
              })
            : {
                logto: remoteCanonicalEnv.parsed["LOGTO_DB_PASSWORD"]!.trim(),
              };
        const forgotPasswordWebhookSecret =
          remoteCanonicalEnv !== undefined
            ? usesPasswordRecoveryRelay
              ? remoteCanonicalEnv.parsed[
                  "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET"
                ]?.trim()
              : undefined
            : usesPasswordRecoveryRelay
              ? await this.deps.ensureForgotPasswordWebhookSecret({
                  instanceRootDir: operatorInstanceRootDir,
                })
              : undefined;

        if (remoteCanonicalEnv !== undefined) {
          await this.deps.localFs.mkdir(operatorInstanceRootDir, {
            recursive: true,
          });
          temporaryRemoteEnvPath = join(
            operatorInstanceRootDir,
            `.auth-reconcile-instance.env.${process.pid}.${Date.now()}`,
          );
          await this.deps.localFs.writeFile(
            temporaryRemoteEnvPath,
            remoteCanonicalEnv.contents,
            { encoding: "utf8", mode: 0o600 },
          );
        }

        const bootstrapDeps = {
          runBootstrap: this.deps.runBootstrap,
          dbPasswords: passwords,
          // Bootstrap normally writes this record. Hold it until the postflight
          // inspection below has proved the live state compatible.
          writeAppliedAuthContract: async (): Promise<void> => {},
          ...(temporaryRemoteEnvPath !== undefined
            ? { resolveDotenvPath: () => temporaryRemoteEnvPath! }
            : {}),
          ...(forgotPasswordWebhookSecret !== undefined
            ? { forgotPasswordWebhookSecret }
            : {}),
          ...(remoteRuntime !== undefined
            ? {
                remoteTunnelPorts: {
                  core: remoteRuntime.logtoCore,
                  admin: remoteRuntime.logtoAdmin,
                  db: remoteRuntime.logtoDb,
                },
              }
            : {}),
        };

        if (profile.transport === "remote") {
          if (
            profile.ssh === undefined ||
            remoteRuntime === undefined ||
            remoteManifest === undefined ||
            remoteCanonicalEnv === undefined ||
            temporaryRemoteEnvPath === undefined
          ) {
            throw new Error(
              "auth reconcile internal error: remote runtime preflight was not retained.",
            );
          }
          this.deps.log(
            `auth reconcile: opening SSH forwards ` +
              `(local ${remoteRuntime.logtoCore}/${remoteRuntime.logtoAdmin}/${remoteRuntime.logtoDb} → ` +
              `remote ${remoteRuntime.logtoCore}/${remoteRuntime.logtoAdmin}/${remoteRuntime.logtoDb})...`,
          );
          const tunnel = await this.deps.openSshTunnel(profile.ssh, [
            {
              local: remoteRuntime.logtoCore,
              remoteHost: "127.0.0.1",
              remote: remoteRuntime.logtoCore,
            },
            {
              local: remoteRuntime.logtoAdmin,
              remoteHost: "127.0.0.1",
              remote: remoteRuntime.logtoAdmin,
            },
            {
              local: remoteRuntime.logtoDb,
              remoteHost: "127.0.0.1",
              remote: remoteRuntime.logtoDb,
            },
          ]);
          try {
            await bootstrapLogtoForProfile(profile, bootstrapDeps);
          } catch (error) {
            throw new Error(
              `auth reconcile failed during bounded Logto bootstrap; no applied-auth stamp was advanced. ` +
                `Recovery bundle: ${backupPath}. ${errorMessage(error)}`,
            );
          } finally {
            await tunnel.close();
          }

          const reconciledRemoteEnv = await this.deps.localFs.readFile(
            temporaryRemoteEnvPath,
            "utf8",
          );
          let currentRemoteEnv:
            | { contents: string; parsed: Record<string, string> }
            | undefined;
          try {
            currentRemoteEnv = await this.readRemoteCanonicalInstanceEnv(
              remoteManifest.remoteRoot,
            );
          } catch (error) {
            throw new Error(
              `auth reconcile could not reread canonical remote instance.env after bootstrap; ` +
                `no managed configuration or applied-auth stamp was published. ` +
                `Recovery bundle: ${backupPath}. ${errorMessage(error)}`,
            );
          }
          for (const credentialKey of [
            "LOGTO_DB_PASSWORD",
            ...(usesPasswordRecoveryRelay
              ? ["NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET"]
              : []),
          ]) {
            if (
              currentRemoteEnv.parsed[credentialKey] !==
              remoteCanonicalEnv.parsed[credentialKey]
            ) {
              throw new Error(
                `auth reconcile stopped because canonical remote ${credentialKey} changed during bootstrap; ` +
                  `no managed configuration or applied-auth stamp was published. ` +
                  `Recovery bundle: ${backupPath}.`,
              );
            }
          }
          const mergedRemoteEnv = mergeManagedRemoteEnv(
            currentRemoteEnv.contents,
            reconciledRemoteEnv,
            LOGTO_ENV_KEY_NAMES,
          );
          this.deps.log(
            "auth reconcile: publishing reconciled managed Logto configuration to canonical remote instance.env...",
          );
          await this.writeRemoteFiles(remoteManifest.remoteRoot, [
            {
              relative: `${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
              contents: mergedRemoteEnv,
              mode: 0o600,
            },
          ]);
        } else {
          await bootstrapLogtoForProfile(profile, bootstrapDeps);
        }

        const applied = buildAppliedAuthContract(
          this.deps.now().toISOString(),
          incoming,
        );
        const postflight = classifyAuthPlan({
          incoming,
          applied,
          liveLogtoEngineImage: await this.readRunningLogtoImage(
            profile,
            remoteManifest?.composeProjectName ?? composeProjectName(profile),
          ),
        });
        if (postflight.classification !== "compatible") {
          throw new Error(
            `auth reconcile failed postflight verification: auth plan is ${postflight.classification}; applied stamp was not advanced.`,
          );
        }

        if (remoteManifest !== undefined) {
          const manifest = remoteDeploymentManifestV2Schema.parse({
            ...remoteManifest,
            contracts: { ...remoteManifest.contracts, authApplied: applied },
            updatedAt: this.deps.now().toISOString(),
          });
          await this.writeRemoteFiles(manifest.remoteRoot, [
            {
              relative: "deployment-manifest.json",
              contents: `${JSON.stringify(manifest, null, 2)}\n`,
              mode: 0o600,
            },
          ]);
        } else {
          await this.writeLocalAppliedAuthContract(
            applied,
            this.deps.resolveInstanceRootDir(profile),
          );
        }

        this.deps.log(
          `auth reconcile: success. Pre-reconcile bundle: ${backupPath}`,
        );
        return { backupPath, preflight, postflight };
      } finally {
        if (temporaryRemoteEnvPath !== undefined) {
          await this.deps.localFs.rm(temporaryRemoteEnvPath, { force: true });
        }
      }
    } finally {
      restoreEnv();
    }
  }

  /**
   * Resolves the incoming server image and proves its auth contract is safe
   * before any lifecycle mutation. Remote invocations intentionally execute
   * on the SSH host; this never uses Docker's ssh:// transport.
   */
  async releasePlan(profile: ComposeDriverProfile): Promise<ReleasePlanReport> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      const prepared = await this.prepareReleaseArtifact(profile);
      const { authContract, ...artifact } = prepared;
      const auth = await this.authPlan(profile, authContract);
      return {
        artifact,
        auth,
        compatible: auth.classification === "compatible",
        limitations: auth.classification === "compatible"
          ? []
          : ["Only an auth plan classified as compatible may enter `nautilo upgrade`."],
      };
    } finally {
      restoreEnv();
    }
  }

  /**
   * D420 (Wave 3 task 3.1.2 / 3.1.3) — unified full-bundle rollback for every
   * strategy. After a recovery bundle exists, any deploy/startup/health
   * failure (server-only or full, image or source, local/LAN/remote)
   * restores DB/config/volumes plus the prior immutable image, then
   * health-checks the restored server. A restore error is NEVER swallowed,
   * and rollback is NEVER claimed unless the restored server proves healthy
   * — the success message always carries `post-rollback health = ready`.
   * `--no-rollback` is the only opt-out: it leaves the failed target in
   * place and emits explicit recovery-bundle guidance. Down-migrations are
   * never attempted; the snapshot owns forward migrations, so a failure
   * after possible migrations uses full-bundle restore, not a prior-image
   * restart.
   *
   * D420 (Wave 3 task 3.1.3) — maintenance completion fencing. A healthy
   * rollback completes the owning lease AFTER the rollback health check
   * passes (fail-closed: a completion failure is reported honestly and the
   * lease is left in `applying` for hard-expiry to reclaim; it is never
   * claimed "cleared"). The `--no-rollback` and double-failure (restore or
   * rollback-health failure) paths RETAIN `applying` — completion is never
   * attempted on an unproven state; hard-expiry is the recovery mechanism
   * for an abandoned CLI. Always throws (the thrown error is the operator-
   * visible outcome); the caller's surrounding `finally` still runs.
   */
  private async rollbackToRecoveryBundle(
    profile: ComposeDriverProfile,
    bundleDir: string,
    originalError: unknown,
    noRollback: boolean,
    context: { label: string; phase: string },
    maintenanceHandle?: MaintenanceDrainHandle,
  ): Promise<never> {
    const { label, phase } = context;
    if (noRollback) {
      // Retain applying; do NOT attempt completion on an unproven state.
      // Hard-expiry reclaims an abandoned CLI. Report the exact recovery
      // bundle + state.
      throw new Error(
        `${label} failed (${phase}); --no-rollback set, leaving the failed target as-is; ` +
          `maintenance lease left in applying (hard-expiry will reclaim). ` +
          `Manual recovery bundle: ${bundleDir} ` +
          `(restore with: nautilo restore ${bundleDir} --force). ` +
          `${errorMessage(originalError)}`,
      );
    }
    this.deps.log(
      `${label}: rolling back — restoring the recovery bundle ` +
        `(restores DB/config/volumes + re-pins the prior immutable image)...`,
    );
    let rollbackError: unknown;
    try {
      await this.restore(profile, { fromPath: bundleDir, force: true });
      await this.checkServerHealth(profile);
      await this.removeRetiredTopologyContainers(
        profile,
        composeProjectName(profile),
      );
    } catch (err) {
      rollbackError = err;
    }
    if (rollbackError === undefined) {
      // Healthy rollback proven — complete the owning lease AFTER the
      // rollback health check. Fail-closed: a completion failure is reported
      // honestly (lease left in applying for hard-expiry) and never claimed
      // "cleared". Completion is never attempted before health is proven.
      const completion = await completeMaintenanceLeaseForReport(maintenanceHandle);
      throw new Error(
        `${label} failed (${phase}); full-bundle rollback succeeded — rolled back to the prior image ` +
          `(restored DB/config/volumes + re-pinned the prior immutable image); ` +
          `post-rollback health = ready${completion.line}. Bundle: ${bundleDir}. ` +
          `${errorMessage(originalError)}`,
      );
    }
    // Double failure: restore OR rollback-health failed. Retain applying;
    // do NOT attempt completion on an unproven state. Hard-expiry reclaims.
    throw new Error(
      `CRITICAL: ${label} failed (${phase}) AND full-bundle rollback failed; ` +
        `post-rollback health = FAILED; maintenance lease left in applying (hard-expiry will reclaim). ` +
        `Manual recovery required. Bundle: ${bundleDir}. ` +
        `Rollback error: ${errorMessage(rollbackError)}. ` +
        `Original error: ${errorMessage(originalError)}`,
    );
  }

  /**
   * Narrow routine release lane. It never bootstraps or reconciles auth and
   * only recreates the server process after a consistent backup.
   */
  async releaseApply(
    profile: ComposeDriverProfile,
    opts?: Pick<UpgradeOptions, "noRollback">,
    maintenanceHandle?: MaintenanceDrainHandle,
  ): Promise<ReleasePlanReport> {
    let enteredApplying = false;
    const trackedHandle =
      maintenanceHandle === undefined
        ? undefined
        : {
            ...maintenanceHandle,
            transitionApplying: async (): Promise<void> => {
              await maintenanceHandle.transitionApplying();
              enteredApplying = true;
            },
          };
    try {
      return await this.releaseApplyTransaction(profile, opts, trackedHandle);
    } catch (error) {
      // The drain belongs to this release and the server has not been stopped.
      // Cancel it immediately instead of rejecting new work until hard-expiry.
      // Once applying begins, the transaction's health/rollback paths own lease
      // completion and deliberately retain it when recovery is unproven.
      if (maintenanceHandle && !enteredApplying) {
        await this.releaseDrainingLeaseAfterFailure(
          maintenanceHandle,
          error,
          "release",
        );
      }
      throw error;
    }
  }

  private async releaseDrainingLeaseAfterFailure(
    maintenanceHandle: MaintenanceDrainHandle,
    originalError: unknown,
    label: string,
  ): Promise<void> {
    const release = await maintenanceHandle.releaseLease();
    if (release.cancelled) {
      this.deps.log(
        `${label}: pre-apply failure; maintenance drain lease cleared.`,
      );
      return;
    }
    throw new Error(
      `${errorMessage(originalError)} Maintenance drain lease release failed; ` +
        `hard-expiry will reclaim it: ${release.error ?? "unknown release error"}`,
    );
  }

  private async releaseApplyTransaction(
    profile: ComposeDriverProfile,
    opts?: Pick<UpgradeOptions, "noRollback">,
    maintenanceHandle?: MaintenanceDrainHandle,
  ): Promise<ReleasePlanReport> {
    gates(profile);
    let projectName = composeProjectName(profile);
    let remoteManifest: RemoteDeploymentManifest | undefined;
    if (usesRemoteRegistryMode(profile)) {
      remoteManifest = await this.readRemoteDeploymentManifest(profile);
      projectName = remoteManifest.composeProjectName;
      await this.preflightRemoteCryptoCredential(remoteManifest.remoteRoot);
      await this.assertRemoteArtifactVolumePresentOrMigrated(
        profile,
        remoteManifest.composeProjectName,
      );
    } else {
      await this.preflightLocalCryptoCredential(profile);
      await this.assertArtifactVolumePresentOrMigrated(profile);
    }
    if (this.deps.doctor) {
      this.deps.log("release: running doctor preflight...");
      await this.deps.doctor(profile);
    }
    if (this.deps.assertReleaseActiveWorkReady && !maintenanceHandle) {
      this.deps.log("release: checking active-work readiness...");
      await this.deps.assertReleaseActiveWorkReady(profile);
    }

    // Topology refusal is enforced in upgrade() before drain acquisition. When
    // releaseApply is invoked directly (no maintenance handle), keep the same
    // read-only preflight here so standalone callers fail before mutation.
    if (!maintenanceHandle) {
      this.deps.log(
        "release: checking for retired neon-proxy/db-host containers (server-only preflight)...",
      );
      await this.assertRetiredTopologyAbsentForServerOnlyUpgrade(profile, projectName);
    }

    // Pin the live source image BEFORE releasePlan/prepareReleaseArtifact.
    // `compose build` retags nautilo-server:local-dev onto the incoming image;
    // under the containerd image store that can make the prior image ID
    // unaddressable (docker tag sha256:… → "No such image") while the
    // still-running container continues to report it. Pin by the live name
    // first so the prior bits remain tagged for backup/rollback.
    const stamp = backupTimestamp(this.deps.now());
    const bundleDir = join(
      this.deps.resolveLocalInstanceRootDir(profile),
      "backups",
      `auto-pre-release-${stamp}`,
    );
    const legacy = await this.captureRunningServerArtifact(profile);
    const incomingIsRegistry = profile.from_source === false;
    const pinTag =
      legacy.mode === "source"
        ? incomingIsRegistry
          ? `nautilo-server:first-cutover-${stamp}`
          : `nautilo-server:upgrade-pin-${stamp}`
        : undefined;
    const archivedLegacy =
      pinTag !== undefined
        ? await this.pinLegacySourceImage(profile, legacy, pinTag)
        : legacy;

    const plan = await this.releasePlan(profile);
    if (!plan.compatible) {
      throw new Error(
        `nautilo upgrade refused: auth plan is ${plan.auth.classification}; ` +
          "run `nautilo auth plan` and perform explicit auth maintenance first.",
      );
    }

    let state: ReleaseState = {
      version: 1,
      createdAt: this.deps.now().toISOString(),
      updatedAt: this.deps.now().toISOString(),
      backupPath: bundleDir,
      legacy: archivedLegacy,
      incoming: plan.artifact,
      migrationsApplied: false,
      recovery: "server-only",
    };
    await this.writeReleaseState(profile, state);

    // A source→registry remote release switches from the operator-side
    // Compose client to SSH-native Compose. A registry-backed legacy-adopted
    // deployment also needs this refresh on every release: its operator-local
    // instance ports are not authoritative for the running remote stack.
    // Materialize host-canonical inputs before the first Compose mutation.
    // This intentionally does not write the incoming registry overlay: stop
    // and backup-failure restart must still address the running artifact.
    if (
      plan.artifact.mode === "registry" &&
      (remoteManifest?.image.mode === "source" ||
        (remoteManifest?.version === 2 &&
          remoteManifest.contracts.legacyAdopted === true))
    ) {
      await this.materializeHostCanonicalRemoteComposeInputs(profile, remoteManifest);
    }

    // D420 (Wave 2 task 2.2.5) — stop-before-backup ordering. Transition the
    // owning maintenance operation `draining → applying` IMMEDIATELY before
    // stopping nautilo-server. The transition fails closed (throws) on any
    // transition / network / auth / malformed error, so the server is never
    // stopped and no backup is started against an unsettled lease. The lease
    // is retained through the stop+snapshot; it is NOT cleared here. Wave 3
    // task 3.1.3 fences completion AFTER the relevant health check: a healthy
    // new deployment or a healthy full-bundle rollback completes the lease
    // (fail-closed); `--no-rollback`, restore failure, rollback-health
    // failure, and an abandoned CLI retain `applying` for hard-expiry to
    // reclaim.
    if (maintenanceHandle) {
      this.deps.log("release: transitioning maintenance drain → applying before server stop...");
      await maintenanceHandle.transitionApplying();
    }

    this.deps.log(`release: creating pre-release backup at ${bundleDir}`);
    await this.releaseServerAction(profile, "stop");
    try {
      await this.backup(profile, {
        toPath: bundleDir,
        releaseLegacyImage: archivedLegacy,
      });
    } catch (error) {
      // R9/R10 — reopen admission only after the prior server is healthy.
      // Unproven restart/health retains `applying` for hard-expiry.
      let recoveryError: unknown;
      try {
        await this.releaseServerAction(profile, "start");
        await this.checkServerHealth(profile);
      } catch (err) {
        recoveryError = err;
      }
      if (recoveryError === undefined) {
        const completion = await completeMaintenanceLeaseForReport(maintenanceHandle);
        throw new Error(
          `nautilo upgrade aborted: pre-upgrade backup failed; old server restarted; ` +
            `post-restart health = ready${completion.line}: ${errorMessage(error)}`,
        );
      }
      throw new Error(
        `CRITICAL: nautilo upgrade pre-upgrade backup failed and prior-server recovery is unproven; ` +
          (maintenanceHandle
            ? `maintenance lease left in applying (hard-expiry will reclaim). `
            : "") +
          `Recovery error: ${errorMessage(recoveryError)}. Backup error: ${errorMessage(error)}`,
      );
    }
    try {
      await this.releaseServerUp(profile, plan.artifact);
    } catch (error) {
      // D420 (Wave 3 task 3.1.2) — a deploy/startup failure AFTER a recovery
      // bundle exists uses the SAME full-bundle rollback semantics as a
      // post-migration health failure (and as the full upgrade path): restore
      // DB/config/volumes + the prior immutable image, then health-check the
      // restored server. The restore error is never swallowed and rollback is
      // never claimed unless health is proven; `--no-rollback` is the only
      // opt-out. A pre-migration failure still has a deterministic safe
      // outcome because the recovery bundle owns the prior state.
      await this.rollbackToRecoveryBundle(profile, bundleDir, error, opts?.noRollback === true, {
        label: "nautilo upgrade",
        phase: "before migrations could be assumed applied",
      }, maintenanceHandle);
    }
    // Starting the incoming process can run schema migrations before its
    // health endpoint responds. From this point, a server-only rollback can
    // leave an old binary against a newer schema, so never attempt one.
    state = {
      ...state,
      updatedAt: this.deps.now().toISOString(),
      migrationsApplied: true,
      recovery: "full-bundle",
    };
    await this.writeReleaseState(profile, state);
    try {
      await this.checkServerHealth(profile);
      if (profile.transport === "remote") {
        await this.commitRemoteDeploymentManifestArtifact(profile, plan.artifact);
      }
    } catch (error) {
      // D420 (Wave 3 task 3.1.2) — a post-migration health failure MUST use
      // full-bundle restore (not a prior-image restart), because the incoming
      // server may have already applied forward schema migrations that an old
      // binary cannot run against. The unified rollback restores the snapshot
      // + prior image and proves health; `--no-rollback` is the only opt-out.
      await this.rollbackToRecoveryBundle(profile, bundleDir, error, opts?.noRollback === true, {
        label: "nautilo upgrade",
        phase: "after migrations may have applied",
      }, maintenanceHandle);
    }
    this.deps.log(`release: success. Pre-release bundle: ${bundleDir}`);
    // D420 (Wave 3 task 3.1.3) — complete the owning maintenance lease AFTER
    // the healthy new deployment is proven (checkServerHealth above
    // succeeded). Completion is authenticated + ownership-checked and
    // fail-closed: a completion failure is reported honestly (the lease is
    // left in `applying` for hard-expiry to reclaim) and never reported as
    // "cleared". Completion is never attempted on an unproven state.
    if (maintenanceHandle) {
      const completion = await completeMaintenanceLeaseForReport(maintenanceHandle);
      if (completion.completed) {
        this.deps.log(
          `release: success; maintenance lease cleared (applying → normal). Bundle: ${bundleDir}.`,
        );
      } else {
        this.deps.log(
          `release: success; ${completion.line.slice(2)}. Bundle: ${bundleDir}.`,
        );
      }
    }
    return plan;
  }

  private async captureRunningServerArtifact(
    profile: ComposeDriverProfile,
  ): Promise<ReleaseArtifact> {
    const project = composeProjectName(profile);
    const inspectArgs = [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=nautilo-server",
    ];
    const ps = await this.runReleaseDocker(profile, inspectArgs);
    const container = ps.stdout.trim().split(/\s+/)[0];
    if (ps.code !== 0 || !container) {
      throw new Error("nautilo upgrade refused: could not identify the running nautilo-server image.");
    }
    const inspected = await this.runReleaseDocker(
      profile,
      [
        "inspect",
        "--format",
        "{{.Image}}\n{{.Config.Image}}",
        container,
      ],
    );
    const [immutableId = "", requested = ""] = inspected.stdout
      .trim()
      .split(/\r?\n/);
    if (inspected.code !== 0 || !immutableId || !requested) {
      throw new Error("nautilo upgrade refused: could not inspect the running nautilo-server image.");
    }
    if (isImmutableRegistryImageRef(requested)) {
      const identity = await this.runReleaseDocker(profile,
        ["image", "inspect", "--format", REGISTRY_IMAGE_IDENTITY_FORMAT, requested]);
      if (identity.code !== 0) throw new Error("Unable to inspect the running immutable registry image.");
      return { mode: "registry", requested, immutableId,
        repoDigest: requestedRegistryDigest(requested, identity.stdout, immutableId) };
    }
    // Keep historical tag/source capture semantics separate from exact pins.
    const imageInspection = await this.runReleaseDocker(
      profile,
      ["image", "inspect", "--format", "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}", requested],
    );
    const inspectedRepoDigest =
      imageInspection.code === 0 ? imageInspection.stdout.trim() : "";
    const repoDigest = isImmutableRegistryImageRef(inspectedRepoDigest)
      ? inspectedRepoDigest
      : "";
    return {
      mode: repoDigest ? "registry" : "source",
      requested,
      immutableId,
      ...(repoDigest ? { repoDigest } : {}),
    };
  }

  /**
   * Retain the currently running source image under a stable tag before any
   * build/pull that may move `nautilo-server:local-dev` (or equivalent).
   * Prefers tagging by the live configured name so the operation still works
   * when the content-addressable ID has already become unaddressable after an
   * earlier retag (containerd image store).
   */
  private async pinLegacySourceImage(
    profile: ComposeDriverProfile,
    legacy: ReleaseArtifact,
    archiveTag: string,
  ): Promise<ReleaseArtifact> {
    if (legacy.archiveTag) return legacy;
    const sources = [legacy.requested, legacy.immutableId].filter(
      (value, index, all) => value.trim() !== "" && all.indexOf(value) === index,
    );
    let lastErr = "";
    for (const source of sources) {
      const tagged = await this.runReleaseDocker(profile, ["tag", source, archiveTag]);
      if (tagged.code === 0) {
        return { ...legacy, archiveTag };
      }
      lastErr = tagged.stderr.trim();
    }
    throw new Error(
      `nautilo upgrade refused: could not pin legacy source image ` +
        `(${sources.join(" | ")} → ${archiveTag}): ${lastErr}`,
    );
  }

  /** Executes image inspection/tagging on the actual remote host, not via a
   * local Docker CLI with DOCKER_HOST. */
  private async runReleaseDocker(
    profile: ComposeDriverProfile,
    args: string[],
  ): Promise<ExecResult> {
    if (profile.transport === "remote") {
      const command = `exec ${shellQuote(this.deps.composeBin)} ${args.map(shellQuote).join(" ")}`;
      return this.execWithoutDockerHost("sh", ["-lc", command], { stdio: "pipe" });
    }
    return this.deps.exec(this.deps.composeBin, args, {
      stdio: "pipe",
      ...dockerEnvForProfile(profile),
    });
  }

  private async writeReleaseState(
    profile: ComposeDriverProfile,
    state: ReleaseState,
  ): Promise<void> {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    if (profile.transport === "remote") {
      await this.writeRemoteFiles(this.deps.resolveInstanceRootDir(profile), [
        { relative: "release-state.json", contents, mode: 0o600 },
      ]);
      return;
    }
    await this.deps.fs.writeFile(
      join(this.deps.resolveInstanceRootDir(profile), "release-state.json"),
      contents,
      { mode: 0o600 },
    );
  }

  private async prepareReleaseArtifact(
    profile: ComposeDriverProfile,
  ): Promise<ReleaseArtifact & { authContract: AuthContract }> {
    const registry = profile.from_source === false;
    const requested = registry
      ? registryImageRef(profile)
      : "compose-source";

    if (!registry) {
      return this.prepareSourceReleaseArtifact(profile, requested);
    }

    if (profile.transport === "remote") {
      this.deps.log(`release: pulling incoming remote image ${requested}...`);
      const pulled = await this.runReleaseDocker(profile, ["pull", requested]);
      if (pulled.code !== 0) {
        throw new Error(
          `release plan: unable to pull incoming remote image '${requested}': ${pulled.stderr.trim()}`,
        );
      }
      this.deps.log(`release: pulled incoming remote image ${requested}`);
      const immutableId = await this.inspectRemoteImageId(requested);
      return {
        mode: "registry",
        requested,
        immutableId,
        repoDigest: await this.inspectRemoteRepoDigest(requested, immutableId),
        authContract: await this.readRemoteImageAuthContract(requested),
      };
    }

    const pulled = await this.deps.exec(this.deps.composeBin, ["pull", requested], {
      stdio: "inherit",
    });
    if (pulled.code !== 0) {
      throw new Error(`release plan: unable to pull ${requested}: ${pulled.stderr}`);
    }
    const immutableId = await this.inspectLocalImageId(requested);
    return {
      mode: "registry",
      requested,
      immutableId,
      repoDigest: await this.inspectLocalRepoDigest(requested, immutableId),
      authContract: await this.readLocalImageAuthContract(requested),
    };
  }

  /**
   * Source builds intentionally use the Docker-over-SSH Compose client for
   * remote profiles. The source tree exists on the operator machine, while a
   * remote source stack does not guarantee a compatible Compose CLI on the
   * target host.
   */
  private async prepareSourceReleaseArtifact(
    profile: ComposeDriverProfile,
    requested: string,
  ): Promise<ReleaseArtifact & { authContract: AuthContract }> {
    // A day-two source release may run from a newer checkout than the
    // original deploy. Refresh the persisted Compose input from the same
    // clean source authority immediately before every source build; never
    // label new bytes with the previous deploy's SHA.
    await this.refreshSourceBuildIdentity(profile);
    const args = this.releaseLocalComposeArgs(profile, ["build", "nautilo-server"]);
    await this.runCompose(args, { stdio: "inherit" });
    const images = await this.runCompose(
      this.releaseLocalComposeArgs(
        profile,
        ["--profile", "auth", "--profile", "app", "config", "--images"],
      ),
      { stdio: "pipe" },
    );
    return {
      mode: "source",
      requested,
      immutableId: await this.inspectLocalImageId(this.releaseServerImage(images.stdout)),
      authContract: await this.readLocalImageAuthContract(
        this.releaseServerImage(images.stdout),
      ),
    };
  }

  private async refreshSourceBuildIdentity(
    profile: ComposeDriverProfile,
  ): Promise<string> {
    const sourceBuildSha = assertSourceBuildSha(await this.deps.resolveSourceBuildSha());
    const composeEnvPath = this.existingComposeEnvPath(profile);
    if (composeEnvPath === undefined) {
      throw new Error(
        "source build refused before mutation: deploy.compose.env is missing; run a clean source deploy before release/upgrade.",
      );
    }
    let raw: string;
    try {
      raw = await this.deps.localFs.readFile(composeEnvPath, "utf8");
    } catch {
      throw new Error(
        "source build refused before mutation: deploy.compose.env is unreadable; repair the exact profile before release/upgrade.",
      );
    }
    const refreshed = envFileContents({
      ...parseDotenv(raw),
      NAUTILO_SOURCE_SHA: sourceBuildSha,
    });
    const temporary = `${composeEnvPath}.source-sha-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await nodeFs.writeFile(temporary, refreshed, { mode: 0o600, flag: "wx" });
      await nodeFs.rename(temporary, composeEnvPath);
    } catch (error) {
      await nodeFs.rm(temporary, { force: true }).catch(() => {});
      throw new Error(
        `source build refused before mutation: could not atomically refresh deploy.compose.env (${errorMessage(error)}).`,
      );
    }
    return sourceBuildSha;
  }

  private releaseServerImage(images: string): string {
    const image = images
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.includes("nautilo-server"));
    if (!image) {
      throw new Error("release plan: incoming compose artifact has no nautilo-server image");
    }
    return image;
  }

  private async inspectLocalImageId(image: string): Promise<string> {
    const inspected = await this.deps.exec(
      this.deps.composeBin,
      ["image", "inspect", "--format", "{{.Id}}", image],
      { stdio: "pipe" },
    );
    if (inspected.code !== 0 || !inspected.stdout.trim()) {
      throw new Error(`release plan: unable to inspect incoming image '${image}'`);
    }
    return inspected.stdout.trim();
  }

  private async inspectRemoteImageId(image: string): Promise<string> {
    const inspected = await this.execWithoutDockerHost(
      "sh",
      ["-lc", `docker image inspect --format '{{.Id}}' ${shellQuote(image)}`],
      { stdio: "pipe" },
    );
    if (inspected.code !== 0 || !inspected.stdout.trim()) {
      throw new Error(`release plan: unable to inspect incoming remote image '${image}'`);
    }
    return inspected.stdout.trim();
  }

  private async inspectLocalRepoDigest(image: string, expectedImageId: string): Promise<string> {
    const inspected = await this.deps.exec(
      this.deps.composeBin,
      ["image", "inspect", "--format", REGISTRY_IMAGE_IDENTITY_FORMAT, image],
      { stdio: "pipe" },
    );
    if (inspected.code !== 0 || !inspected.stdout.trim()) {
      throw new Error(`release plan: unable to resolve registry digest for '${image}'`);
    }
    return requestedRegistryDigest(image, inspected.stdout, expectedImageId);
  }

  private async inspectRemoteRepoDigest(image: string, expectedImageId: string): Promise<string> {
    const inspected = await this.execWithoutDockerHost(
      "sh",
      ["-lc", `docker image inspect --format ${shellQuote(REGISTRY_IMAGE_IDENTITY_FORMAT)} ${shellQuote(image)}`],
      { stdio: "pipe" },
    );
    if (inspected.code !== 0 || !inspected.stdout.trim()) {
      throw new Error(`release plan: unable to resolve remote registry digest for '${image}'`);
    }
    return requestedRegistryDigest(image, inspected.stdout, expectedImageId);
  }

  /**
   * Docker has no direct file-inspection API, so create an unstarted
   * container, copy the image-embedded contract, then remove it in a shell
   * trap. The bytes are emitted over SSH; no daemon is exposed via DOCKER_HOST.
   */
  private async readRemoteImageAuthContract(image: string): Promise<AuthContract> {
    const script = [
      "set -eu",
      `container="$(docker create ${shellQuote(image)})"`,
      'cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }',
      "trap cleanup EXIT",
      'docker cp "$container:/srv/contracts/auth-contract.json" - | tar -xO',
    ].join("\n");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      throw new Error(
        `release plan: unable to read auth contract from incoming remote image '${image}'`,
      );
    }
    return parseAuthContract(result.stdout);
  }

  /** Reads an image contract without ever starting the temporary container. */
  private async readLocalImageAuthContract(image: string): Promise<AuthContract> {
    const tempDir = await nodeFs.mkdtemp(join(tmpdir(), "nautilo-release-contract-"));
    const target = join(tempDir, "auth-contract.json");
    let container = "";
    try {
      const created = await this.deps.exec(this.deps.composeBin, ["create", image], {
        stdio: "pipe",
      });
      if (created.code !== 0 || !created.stdout.trim()) {
        throw new Error(`unable to create inspection container for '${image}'`);
      }
      container = created.stdout.trim();
      const copied = await this.deps.exec(
        this.deps.composeBin,
        ["cp", `${container}:/srv/contracts/auth-contract.json`, target],
        { stdio: "pipe" },
      );
      if (copied.code !== 0) {
        throw new Error(`unable to copy auth contract from '${image}'`);
      }
      return parseAuthContract(await nodeFs.readFile(target, "utf8"));
    } catch (error) {
      throw new Error(
        `release plan: unable to read auth contract from incoming image '${image}': ${errorMessage(error)}`,
      );
    } finally {
      if (container) {
        await this.deps.exec(this.deps.composeBin, ["rm", "-f", container], {
          stdio: "pipe",
        }).catch(() => {});
      }
      await nodeFs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private releaseLocalComposeArgs(
    profile: ComposeDriverProfile,
    command: string[],
    registryOverlay?: string,
  ): string[] {
    const args = ["--project-name", composeProjectName(profile), "-f", join(this.deps.templateDir, "docker-compose.yml")];
    if (profile.from_source !== false) {
      args.push("-f", join(this.deps.templateDir, "docker-compose.source.yml"));
    }
    const env = this.existingComposeEnvPath(profile);
    const volumes = this.existingVolumesOverlayPath(profile);
    const caddy = this.existingCaddyOverlayPath(profile);
    const server = this.existingServerOverlayPath(profile);
    if (env) args.push("--env-file", env);
    if (volumes) args.push("-f", volumes);
    if (caddy) args.push("-f", caddy);
    if (server) args.push("-f", server);
    if (registryOverlay) args.push("-f", registryOverlay);
    return args.concat(command);
  }

  private async releaseServerAction(
    profile: ComposeDriverProfile,
    action: "stop" | "start",
  ): Promise<void> {
    if (profile.transport === "remote") {
      let manifest: RemoteDeploymentManifest | undefined;
      try {
        manifest = await this.readRemoteDeploymentManifest(profile);
      } catch (error) {
        // Legacy source-only remote installs intentionally have no manifest
        // and continue through the operator-side Docker-over-SSH path.
        if (
          profile.from_source === false ||
          !errorMessage(error).includes("is missing or unreadable")
        ) {
          throw error;
        }
      }
      // Registry-current stacks are always SSH-native. A registry incoming
      // profile is also SSH-native after source→registry canonicalization.
      if (manifest?.image.mode === "registry" || profile.from_source === false) {
        await this.runRemoteReleaseCompose(
          profile,
          { verb: action, service: "nautilo-server" },
          manifest?.image.mode === "registry",
        );
        return;
      }
    }
    await this.runCompose(
      this.releaseLocalComposeArgs(profile, [action, "nautilo-server"]),
      { stdio: "inherit" },
    );
  }

  private async releaseServerUp(
    profile: ComposeDriverProfile,
    artifact: ReleaseArtifact,
  ): Promise<void> {
    const imageRef =
      artifact.mode === "registry" ? artifact.requested : artifact.archiveTag;
    if (profile.transport === "remote" && profile.from_source === false) {
      const manifest = await this.readRemoteDeploymentManifest(profile);
      // Server-only upgrades must carry forward base Compose contract changes
      // (including the hardened Bun health probe), not only replace the image.
      // releaseApply reaches this boundary after creating the recovery bundle,
      // so rollback still owns the prior Compose material.
      await this.materializeRemoteDayTwoComposeTemplate(manifest);
      if (imageRef !== undefined) {
        await this.writeRemoteFiles(manifest.remoteRoot, [
          {
            relative: "deploy.registry-overlay.yml",
            contents: buildPinnedImageOverlay(imageRef),
            mode: 0o600,
          },
        ]);
      }
      await this.prepareReleaseAppDb(profile, undefined, manifest);
      await this.runRemoteReleaseCompose(
        profile,
        { verb: "up", noBuild: true, noDeps: true, service: "nautilo-server" },
        imageRef !== undefined,
      );
      return;
    }
    let overlay: string | undefined;
    if (imageRef !== undefined) {
      const root = this.deps.resolveInstanceRootDir(profile);
      overlay = join(root, "deploy.release-registry-overlay.yml");
      await this.deps.fs.writeFile(overlay, buildPinnedImageOverlay(imageRef), {
        mode: 0o600,
      });
    }
    await this.prepareReleaseAppDb(profile, overlay);
    await this.runCompose(
      this.releaseLocalComposeArgs(
        profile,
        ["up", "-d", "--no-build", "--no-deps", "nautilo-server"],
        overlay,
      ),
      { stdio: "inherit" },
    );
  }

  /**
   * Bring app-postgres onto the incoming Compose environment and reconcile all
   * canonical application roles before the incoming server can run migrations.
   * releaseApply calls this only after the recovery bundle exists, so any
   * failure is handled by the existing full-bundle rollback boundary.
   */
  private async prepareReleaseAppDb(
    profile: ComposeDriverProfile,
    registryOverlay?: string,
    remoteManifest?: RemoteDeploymentManifest,
  ): Promise<void> {
    this.deps.log(
      "release: preparing app-postgres roles before incoming server startup...",
    );
    if (remoteManifest !== undefined) {
      await this.runRemoteComposeAtRoot(
        profile,
        remoteManifest.remoteRoot,
        remoteManifest.composeProjectName,
        remoteManifest.https === "letsencrypt",
        {
          verb: "up",
          wait: true,
          forceRecreate: true,
          service: "app-postgres",
        },
      );
      await this.repairAppDbOwnership({
        transport: "remote_ssh",
        remoteRoot: remoteManifest.remoteRoot,
        projectName: remoteManifest.composeProjectName,
        overlays: this.remoteRegistryRepairOverlays(
          remoteManifest.https === "letsencrypt",
          true,
        ),
        profiles: this.remoteDeployProfiles(profile),
      });
      return;
    }

    const profileArgs = this.remoteDeployProfiles(profile).flatMap((name) => [
      "--profile",
      name,
    ]);
    const composeProjectArgs = this.releaseLocalComposeArgs(
      profile,
      profileArgs,
      registryOverlay,
    );
    await this.runCompose(
      this.releaseLocalComposeArgs(
        profile,
        [
          ...profileArgs,
          "up",
          "-d",
          "--wait",
          "--no-build",
          "--force-recreate",
          "app-postgres",
        ],
        registryOverlay,
      ),
      { stdio: "inherit" },
    );
    await this.repairAppDbOwnership(
      {
        transport: "local_compose",
        composeBin: this.deps.composeBin,
        composeArgs: this.deps.composeArgs,
        composeProjectArgs,
      },
      this.sqlPipelineExec(profile),
    );
  }

  private async runRemoteReleaseCompose(
    profile: ComposeDriverProfile,
    request: RemoteComposeCommandRequest,
    registry: boolean,
    stdio: "inherit" | "pipe" = "inherit",
  ): Promise<ExecResult> {
    const manifest = await this.readRemoteDeploymentManifest(profile);
    const built = buildRemoteComposeCommand({
      remoteRoot: manifest.remoteRoot,
      projectName: manifest.composeProjectName,
      overlays: {
        volumes: true,
        caddy: manifest.https === "letsencrypt",
        registry,
        server: true,
      },
      profiles: this.remoteDeployProfiles(profile),
      request,
    });
    const result = await this.execWithoutDockerHost(built.command, [...built.args], { stdio });
    if (result.code !== 0) {
      throw new Error(`release: remote docker compose ${request.verb} failed (exit ${result.code})`);
    }
    return result;
  }

  /**
   * Reads Docker's configured image for the running Logto container. Both
   * commands are inspection-only; failures deliberately become `null` so the
   * auth classifier fails closed as `unknown`.
   */
  private async readRunningLogtoImage(
    profile: ComposeDriverProfile,
    projectName: string,
  ): Promise<string | null> {
    const filters = [
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--filter",
      "label=com.docker.compose.service=logto",
    ];
    try {
      if (profile.transport === "remote") {
        const filterArgs = filters.map(shellQuote).join(" ");
        const script = [
          `container="$(docker ps -q ${filterArgs})"`,
          'test -n "$container"',
          'docker inspect --format "{{.Config.Image}}" "$container"',
        ].join(" && ");
        const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
          stdio: "pipe",
        });
        return result.code === 0 ? result.stdout.trim() || null : null;
      }

      const listed = await this.deps.exec(
        this.deps.composeBin,
        ["ps", "-q", ...filters],
        { stdio: "pipe" },
      );
      const container = listed.code === 0 ? listed.stdout.trim().split(/\s+/)[0] : "";
      if (!container) return null;
      const inspected = await this.deps.exec(
        this.deps.composeBin,
        ["inspect", "--format", "{{.Config.Image}}", container],
        { stdio: "pipe" },
      );
      return inspected.code === 0 ? inspected.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  /**
   * Bootstrap resolves its stamp root from the active instance environment.
   * Create that exact parent at write time, then atomically publish the
   * secret-free stamp with restrictive permissions.
   */
  private async writeLocalAppliedAuthContract(
    stamp: AppliedAuthContract,
    instanceRootDir: string,
  ): Promise<void> {
    await nodeFs.mkdir(instanceRootDir, { recursive: true, mode: 0o700 });
    const target = join(instanceRootDir, "auth-contract-applied.json");
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await nodeFs.writeFile(temporary, serializeAppliedAuthContract(stamp), {
      encoding: "utf8",
      mode: 0o600,
    });
    await nodeFs.rename(temporary, target);
  }

  async restart(profile: ComposeDriverProfile, opts: RestartOptions = {}): Promise<void> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      if (opts.full === true) {
        // `logto-seed` is a completed one-shot job. A service-less Compose
        // restart tries to restart it and returns nonzero after the healthy
        // long-running services have already restarted. Keep the recovery
        // set explicit so success means every requested daemon restarted.
        const restartServices: RemoteComposeServiceName[] = [
          "app-postgres",
          "logto-postgres",
          "logto",
          "nautilo-server",
          ...(profile.office === true
            ? ["office", "collabora"] as const
            : []),
        ];
        if (usesRemoteRegistryMode(profile)) {
          await this.runRemoteCompose(
            profile,
            { verb: "up", noBuild: true },
            { stdio: "inherit", profiles: this.remoteDeployProfiles(profile) },
          );
          await this.runRemoteCompose(
            profile,
            { verb: "restart", services: restartServices },
            { stdio: "inherit", profiles: this.remoteDeployProfiles(profile) },
          );
          return;
        }

        const projectName = composeProjectName(profile);
        const baseYml = join(this.deps.templateDir, "docker-compose.yml");
        const composeEnvPath = this.existingComposeEnvPath(profile);
        const volumesOverlayPath = this.existingVolumesOverlayPath(profile);
        const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
        const serverOverlayPath = this.existingServerOverlayPath(profile);
        const registryOverlayPath = this.existingRegistryOverlayPath(profile);
        const args = ["--project-name", projectName, "-f", baseYml];
        if (composeEnvPath) args.push("--env-file", composeEnvPath);
        if (volumesOverlayPath) args.push("-f", volumesOverlayPath);
        if (caddyOverlayPath) args.push("-f", caddyOverlayPath);
        if (serverOverlayPath) args.push("-f", serverOverlayPath);
        if (registryOverlayPath) args.push("-f", registryOverlayPath);
        args.push(
          "--profile",
          "auth",
          "--profile",
          "app",
          ...(profile.office === true ? ["--profile", "office"] : []),
          "up",
          "-d",
          "--no-build",
        );
        await this.runCompose(args, { stdio: "inherit" });
        await this.runCompose(
          [...args.slice(0, -3), "restart", ...restartServices],
          { stdio: "inherit" },
        );
        return;
      }

      if (usesRemoteRegistryMode(profile)) {
        await this.runRemoteCompose(
          profile,
          { verb: "restart", service: "nautilo-server" },
          { stdio: "inherit" },
        );
        return;
      }

      const projectName = composeProjectName(profile);
      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const volumesOverlayPath = this.existingVolumesOverlayPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
      const args = ["--project-name", projectName, "-f", baseYml];
      if (composeEnvPath) args.push("--env-file", composeEnvPath);
      if (volumesOverlayPath) args.push("-f", volumesOverlayPath);
      if (caddyOverlayPath) args.push("-f", caddyOverlayPath);
      args.push("restart", "nautilo-server");
      await this.runCompose(args, { stdio: "inherit" });
    } finally {
      restoreEnv();
    }
  }

  async logs(
    profile: ComposeDriverProfile,
    opts: LogsOptions,
  ): Promise<void> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      if (usesRemoteRegistryMode(profile)) {
        const request: RemoteComposeCommandRequest = { verb: "logs" };
        if (opts.follow === true) request.follow = true;
        if (opts.service !== undefined) {
          request.service = opts.service as RemoteComposeServiceName;
        }
        await this.runRemoteCompose(profile, request, { stdio: "inherit" });
        return;
      }

      const projectName = composeProjectName(profile);
      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
      const args = ["--project-name", projectName, "-f", baseYml];
      if (composeEnvPath) args.push("--env-file", composeEnvPath);
      if (caddyOverlayPath) args.push("-f", caddyOverlayPath);
      args.push("logs");
      if (opts.follow) args.push("-f");
      if (opts.service) args.push(opts.service);
      await this.runCompose(args, { stdio: "inherit" });
    } finally {
      restoreEnv();
    }
  }

  async upgrade(
    profile: ComposeDriverProfile,
    opts?: UpgradeOptions,
  ): Promise<void> {
    const strategy = resolveUpgradeStrategy(profile, opts);
    const effectiveProfile = applyUpgradeStrategy(profile, strategy);
    // The legacy server-only readiness probe is a no-mutation preflight. Run
    // it before acquiring a maintenance lease: a transport/auth failure here
    // must not leave an otherwise idle server stranded in `draining`.
    if (
      strategy.scope === "server-only" &&
      this.deps.drainMaintenanceWork &&
      this.deps.assertReleaseActiveWorkReady
    ) {
      this.deps.log("upgrade: checking active-work readiness...");
      await this.deps.assertReleaseActiveWorkReady(effectiveProfile);
    }
    // M215 — read-only retired-topology preflight BEFORE maintenance drain.
    // A refusal here must not leave server_maintenance stranded in `draining`.
    if (strategy.scope === "server-only") {
      const projectName = await this.resolveServerOnlyUpgradeProjectName(effectiveProfile);
      this.deps.log(
        "upgrade: checking for retired neon-proxy/db-host containers (server-only preflight)...",
      );
      await this.assertRetiredTopologyAbsentForServerOnlyUpgrade(
        effectiveProfile,
        projectName,
      );
    }
    // D420 (Wave 2 task 2.2.5) — bounded maintenance drain preflight. Runs
    // BEFORE the server-only/full split so both paths settle executable work
    // before any stop/backup/deploy mutation. The drain RETAINS the owning
    // lease and returns a {@link MaintenanceDrainHandle}; each branch
    // transitions `draining → applying` immediately before stopping
    // nautilo-server (fail-closed before stop/backup), awaits the stop, then
    // starts the validated snapshot. On a post-stop backup failure the branch
    // restarts the previous server and best-effort clears the lease. Wave 3
    // task 3.1.3 fences completion AFTER the relevant health check: a healthy
    // new deployment or a healthy full-bundle rollback completes the lease
    // (fail-closed); `--no-rollback`, restore failure, rollback-health
    // failure, and an abandoned CLI retain `applying` for hard-expiry to
    // reclaim. Skipped when no drain dep is wired (legacy tests / callers
    // without an operator maintenance endpoint).
    let maintenanceHandle: MaintenanceDrainHandle | undefined;
    if (this.deps.drainMaintenanceWork) {
      const waitForMs = opts?.waitForMs ?? DEFAULT_UPGRADE_WAIT_FOR_MS;
      maintenanceHandle = await this.deps.drainMaintenanceWork(
        effectiveProfile,
        waitForMs,
      );
    }
    if (strategy.scope === "server-only") {
      const restoreEnv = this.setInstanceEnv(effectiveProfile);
      try {
        await this.releaseApply(
          effectiveProfile,
          opts?.noRollback === true ? { noRollback: true } : undefined,
          maintenanceHandle,
        );
      } finally {
        restoreEnv();
      }
      return;
    }

    gates(effectiveProfile);
    if (usesRemoteRegistryMode(effectiveProfile)) {
      // M207 safety boundary: never begin M139's backup/rollback sequence
      // until the host we will mutate proves its profile identity.
      const manifest = await this.readRemoteDeploymentManifest(effectiveProfile);
      await this.assertRemoteArtifactVolumePresentOrMigrated(
        effectiveProfile,
        manifest.composeProjectName,
        { allowArtifactLoss: opts?.allowArtifactLoss === true },
      );
    } else {
      // Must happen before the consistent-backup stop below: a pre-volume
      // server's media/artifact bytes are only recoverable while it is alive.
      await this.assertArtifactVolumePresentOrMigrated(effectiveProfile, {
        allowArtifactLoss: opts?.allowArtifactLoss === true,
      });
    }
    const restoreEnv = this.setInstanceEnv(effectiveProfile);
    let enteredApplying = false;
    try {
      const log = this.deps.log;

      if (this.deps.doctor) {
        log("upgrade: running doctor preflight...");
        await this.deps.doctor(effectiveProfile);
      }

      const projectName = composeProjectName(effectiveProfile);
      log("upgrade: verifying M212 direct-transport baseline on existing stack...");
      await this.assertDirectTransportBaseline(effectiveProfile, projectName);

      const stamp = backupTimestamp(this.deps.now());
      const localRoot = this.deps.resolveLocalInstanceRootDir(effectiveProfile);
      const backupParentDir = opts?.backupDir?.trim()
        ? opts.backupDir.trim()
        : join(localRoot, "backups");
      const bundleDir = join(backupParentDir, `auto-pre-upgrade-${stamp}`);
      log(`upgrade: pre-upgrade bundle will be written to ${bundleDir}`);

      // D420 (Wave 2 task 2.2.5) — stop-before-backup ordering. Transition
      // the owning maintenance operation `draining → applying` IMMEDIATELY
      // before stopping nautilo-server. The transition fails closed (throws)
      // on any transition / network / auth / malformed error, so the server is
      // never stopped and no backup is started against an unsettled lease.
      if (maintenanceHandle) {
        log("upgrade: transitioning maintenance drain → applying before server stop...");
        await maintenanceHandle.transitionApplying();
        enteredApplying = true;
      }
      // The consistent snapshot stops nautilo-server before copying durable
      // bytes. Resolve its image only after the applying transition succeeds,
      // while it is still running, then hand that strategy-free identity to
      // backup for the rollback manifest.
      const runningImage = await this.captureRunningServerArtifact(effectiveProfile);
      log("upgrade: stopping nautilo-server for a consistent pre-upgrade backup...");
      await this.composeServer(effectiveProfile, "stop");
      try {
        await this.backup(effectiveProfile, {
          toPath: bundleDir,
          releaseLegacyImage: runningImage,
        });
      } catch (err) {
        // R9/R10 — reopen admission only after the prior server is healthy.
        // Unproven restart/health retains `applying` for hard-expiry.
        let recoveryError: unknown;
        try {
          await this.composeServer(effectiveProfile, "start");
          await this.checkServerHealth(effectiveProfile);
        } catch (recoveryErr) {
          recoveryError = recoveryErr;
        }
        if (recoveryError === undefined) {
          const completion = await completeMaintenanceLeaseForReport(maintenanceHandle);
          throw new Error(
            `upgrade: pre-upgrade backup failed; aborted before deploy; old server restarted; ` +
              `post-restart health = ready${completion.line}: ${errorMessage(err)}`,
          );
        }
        throw new Error(
          `CRITICAL: upgrade pre-upgrade backup failed and prior-server recovery is unproven; ` +
            (maintenanceHandle
              ? `maintenance lease left in applying (hard-expiry will reclaim). `
              : "") +
            `Recovery error: ${errorMessage(recoveryError)}. Backup error: ${errorMessage(err)}`,
        );
      }

      let deployFailed: unknown;
      try {
        await this.deploy(effectiveProfile, {
          allowArtifactLoss: opts?.allowArtifactLoss === true,
        });
        await this.checkServerHealth(effectiveProfile);
        await this.removeRetiredTopologyContainers(effectiveProfile, projectName);
      } catch (err) {
        deployFailed = err;
      }

      if (deployFailed === undefined) {
        // D420 (Wave 3 task 3.1.3) — complete the owning maintenance lease
        // AFTER the healthy new deployment is proven (deploy + checkServerHealth
        // above succeeded). Completion is authenticated + ownership-checked and
        // fail-closed: a completion failure is reported honestly (the lease is
        // left in `applying` for hard-expiry to reclaim) and never reported as
        // "cleared". Completion is never attempted on an unproven state.
        if (maintenanceHandle) {
          const completion = await completeMaintenanceLeaseForReport(maintenanceHandle);
          if (completion.completed) {
            log(
              `upgrade: success; maintenance lease cleared (applying → normal). Bundle: ${bundleDir}.`,
            );
          } else {
            log(`upgrade: success; ${completion.line.slice(2)}. Bundle: ${bundleDir}.`);
          }
        }
        log(`upgrade: success. Pre-upgrade bundle: ${bundleDir} (rollback with: nautilo restore ${bundleDir} --force)`);
        return;
      }

      log(`upgrade: FAILED during deploy/health: ${errorMessage(deployFailed)}`);
      // D420 (Wave 3 task 3.1.2) — the full upgrade path shares the same
      // unified full-bundle rollback as the server-only releaseApply lane:
      // restore DB/config/volumes + the prior immutable image, then prove the
      // restored server is healthy. `--no-rollback` is the only opt-out.
      // Wave 3.1.3 threads the maintenance handle so a healthy rollback
      // completes the lease after the rollback health check; double failure
      // and `--no-rollback` retain `applying` (hard-expiry reclaims).
      await this.rollbackToRecoveryBundle(effectiveProfile, bundleDir, deployFailed, opts?.noRollback === true, {
        label: "upgrade",
        phase: "during deploy/health",
      }, maintenanceHandle);
    } catch (error) {
      if (maintenanceHandle && !enteredApplying) {
        await this.releaseDrainingLeaseAfterFailure(
          maintenanceHandle,
          error,
          "upgrade",
        );
      }
      throw error;
    } finally {
      restoreEnv();
    }
  }

  async checkServerHealth(profile: ComposeDriverProfile): Promise<void> {
    // D420 (Wave 3 task 3.3.2) — the deploy/rollback health gate now runs
    // full runtime acceptance instead of `/health` alone. Callers that stub
    // `checkServerHealth` (the upgrade/rollback orchestration tests) still
    // intercept the whole gate; the real path adds target/profile identity,
    // SPA availability, credentialed app-role connection probes, and Logto
    // OIDC discovery. A failure throws, which the upgrade/rollback callers
    // already treat as rollback-worthy / report-failed.
    await this.checkRuntimeAcceptance(profile);
  }

  /**
   * D420 (Wave 3 task 3.3.2) — runtime acceptance gate run after a new
   * deploy proves healthy and after a rollback proves healthy. It retains
   * the normal `/health` poll and adds, without requiring a browser or
   * end-user session:
   *   1. target/profile instance identity via `GET /api/setup/status`
   *      (the live `instanceId` must match the profile's instance id);
   *   2. SPA availability (the public surface serves HTML);
   *   3. real credentialed app-role connection probes — `nautilo` and
   *      `nautilo_agent` each authenticate against the restored cluster
   *      with the runtime credentials from `instance.env` (privilege
   *      checks alone are insufficient);
   *   4. Logto OIDC discovery (the well-known doc is live after tenant-
   *      role password reconciliation).
   * Any failure throws so the caller never reports success on a partially
   * restored target and drives the existing rollback behavior.
   */
  async checkRuntimeAcceptance(profile: ComposeDriverProfile): Promise<void> {
    const inst = this.resolveInstanceForProfile();
    const serverBaseUrl = resolveServerBaseUrl(profile, inst);
    // Compose deployments serve the Workbench through nautilo-server's public
    // origin. `instance.json.workbench.url` is a dev-server endpoint and may
    // be unset or point at a stale port after a restore.
    const spaUrl = serverBaseUrl;
    const expectedInstanceId = (profile.instance_id ?? "").trim();
    const logtoPublicUrl = resolveLogtoPublicUrl(profile, inst);
    const oidcUrl = `${logtoPublicUrl}/oidc/.well-known/openid-configuration`;
    const projectName = composeProjectName(profile);

    // 4. Real credentialed app-role connection probes. Read the password only
    //    inside app-postgres from the container environment already wired by
    //    docker-compose.yml. This verifies the target's actual runtime
    //    configuration without putting a DB secret in host process arguments,
    //    connection URLs, or command strings.
    const appRoleProbeSpecs: Array<{ role: string; passwordEnv: string }> = [
      { role: "nautilo", passwordEnv: "NAUTILO_DB_PASSWORD" },
      { role: "nautilo_agent", passwordEnv: "NAUTILO_AGENT_DB_PASSWORD" },
      { role: "nautilo_crypto", passwordEnv: "NAUTILO_CRYPTO_DB_PASSWORD" },
    ];
    const appContainerFilter = shellQuote(`name=${projectName}-app-postgres`);
    // The command is deliberately sent to the profile's Docker daemon:
    // dockerEnvForProfile supplies DOCKER_HOST=ssh://... for LAN/remote
    // profiles. Without that env, this would inspect the operator's local
    // daemon and could turn an unrelated healthy stack into a false green.
    const appRoleExecPrefix =
      `${this.deps.composeBin} exec -i ` +
      `"$(${this.deps.composeBin} ps -q --filter ${appContainerFilter} | head -n1)" `;
    const appRoleProbes = appRoleProbeSpecs.map((probe) => {
      const containerProbe =
        `PGPASSWORD="\${${probe.passwordEnv}:?${probe.passwordEnv} is not set}" ` +
        `psql -U ${shellQuote(probe.role)} -h 127.0.0.1 -d nautilo ` +
        `-t -A -c ${shellQuote("SELECT 1")}`;
      return { role: probe.role, cmd: `${appRoleExecPrefix}sh -c ${shellQuote(containerProbe)}` };
    });

    const runtimePoolProbe = buildRestrictedRuntimePoolsProbe({
      composeBin: this.deps.composeBin,
      projectName,
    });

    // D427 (Wave 4 task 4.1.1) — the gate (check catalog, ordering, fail-closed
    // semantics, canonical error messages) is the shared @nautilo/db helper.
    // The Compose-specific probe command construction and Docker routing stay
    // here; the helper runs them via the injected transport. `throwOnFirstFailure`
    // preserves the Wave 3 contract: a single failing check throws
    // `runtime acceptance failed: ...` so the upgrade/rollback orchestration
    // never reports success on a partially restored target.
    // D427 (Wave 4 task 4.x) — for remote profiles, route the gate's HTTP
    // (health poll, /api/setup/status identity, SPA, OIDC discovery) through
    // the SSH-local remote transport when the CLI factory has wired it. This
    // avoids the operator's public DNS: a split-DNS upgrade where public DNS
    // points at v2 while v1 is the live target would otherwise fetch v2's
    // /health + /api/setup/status and falsely fail/validate v1. The exec
    // probes (app-role psql + direct postgres.js pool) already route Docker to the target
    // via DOCKER_HOST and expand credentials inside the target container, so
    // they are unaffected. Local profiles keep `deps.fetch` + pollServerHealth.
    const remoteTransport =
      profile.transport === "remote" ? this.remoteRuntimeAcceptanceTransport : undefined;
    const transport: RuntimeAcceptanceTransport = {
      fetch: (url) =>
        remoteTransport !== undefined
          ? remoteTransport.fetch(url)
          : this.deps.fetch(url),
      execSh: (cmd) =>
        this.deps
          .exec("sh", ["-c", cmd], {
            ...dockerEnvForProfile(profile),
            stdio: "pipe",
          })
          .then((res) => ({ code: res.code, stderr: res.stderr })),
      pollHealth: (baseUrl) =>
        remoteTransport !== undefined
          ? remoteTransport.pollHealth(baseUrl)
          : this.pollServerHealth(baseUrl),
      log: this.deps.log,
    };

    await runRuntimeAcceptance(
      transport,
      {
        serverBaseUrl,
        spaUrl,
        expectedInstanceId,
        oidcUrl,
        appRoleProbes,
        directPostgresProbe: runtimePoolProbe,
      },
      { throwOnFirstFailure: true },
    );
  }

  async backup(profile: ComposeDriverProfile, opts?: BackupOptions): Promise<string> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      const requestedBundlePath = opts?.toPath?.trim();
      if (!requestedBundlePath) {
        this.deps.log(
          "backup: no <path> given — legacy single-nautilo-DB backup (deprecated; pass a <path> for a full bundle).",
        );
        const localRoot = this.deps.resolveLocalInstanceRootDir(profile);
        await ensureCanonicalConfigLayout(localRoot);
        const backupsDir = join(localRoot, "backups");
        await nodeFs.mkdir(backupsDir, { recursive: true });

        const stamp = backupTimestamp(this.deps.now());
        const target = join(backupsDir, `${stamp}.sql.gz`);
        const projectName = composeProjectName(profile);
        const baseYml = join(this.deps.templateDir, "docker-compose.yml");
        const composeEnvPath = this.existingComposeEnvPath(profile);
        const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
        const envFileFlag = composeEnvPath ? `--env-file ${shellQuote(composeEnvPath)} ` : "";
        const caddyFlag = caddyOverlayPath ? `-f ${shellQuote(caddyOverlayPath)} ` : "";

        const dumpProducer =
          `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ` +
          `--project-name ${shellQuote(projectName)} -f ${shellQuote(baseYml)} ${caddyFlag}${envFileFlag}` +
          `exec -T app-postgres pg_dump -U postgres nautilo`;
        // D420 2.2.4 / R9A — fail-closed pipeline: a pg_dump failure cannot
        // be masked by gzip exiting 0 on an empty/truncated stream.
        const res = await this.deps.localExec(
          "sh",
          ["-c", failClosedDumpScript(dumpProducer, target)],
          {
            stdio: "inherit",
            ...dockerEnvForProfile(profile),
          },
        );
        if (res.code !== 0) {
          throw new Error(
            `backup: nautilo DB dump failed (exit ${res.code}): ${res.stderr.trim()}`,
          );
        }
        this.deps.log(target);
        return target;
      }

      const bundlePath = requestedBundlePath;
      await nodeFs.mkdir(bundlePath, { recursive: true, mode: 0o700 });
      await nodeFs.chmod(bundlePath, 0o700);
      this.deps.log(
        `backup: warning: ${bundlePath} contains plaintext secrets (instance.env, Logto DB, bootstrap tokens, cert private keys). Keep it encrypted or access-restricted.`,
      );

      const stamp = backupTimestamp(this.deps.now());
      const createdAt = this.deps.now().toISOString();
      const projectName = composeProjectName(profile);
      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
      const mode = httpsMode(profile);
      const isRemote = profile.transport === "remote";
      const streamMode = isRemote && opts?.stream === true;
      const stagedMode = isRemote && !streamMode;
      const localRoot = this.deps.resolveLocalInstanceRootDir(profile);
      const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
      const remoteStagingDir = join(instanceRootDir, `.backup-staging-${stamp}`);
      const stageDir = stagedMode ? remoteStagingDir : bundlePath;
      const volumeStageDir = stagedMode ? remoteStagingDir : bundlePath;
      const dockerEnv = dockerEnvForProfile(profile);
      await ensureCanonicalConfigLayout(localRoot);
      if (isRemote) {
        await this.ensureRemoteCanonicalConfigLayout(instanceRootDir);
      } else {
        await ensureCanonicalConfigLayout(instanceRootDir);
      }

      if (streamMode) {
        this.deps.log(
          "backup: --stream enabled for remote profile; transfer is NOT resumable. Re-run without --stream when remote disk allows staged rsync.",
        );
      }

      const composeFlags =
        `--project-name ${shellQuote(projectName)} -f ${shellQuote(baseYml)} ` +
        (caddyOverlayPath ? `-f ${shellQuote(caddyOverlayPath)} ` : "") +
        (composeEnvPath ? `--env-file ${shellQuote(composeEnvPath)} ` : "");
      const composePrefix = `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ${composeFlags}`;

      const runChecked = async (
        label: string,
        exec: ExecFn,
        cmd: string,
        args: string[],
        execOpts: { env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" },
      ): Promise<ExecResult> => {
        this.deps.log(`backup: → ${label}: ${cmd} ${args.join(" ")}`);
        const started = this.deps.now().getTime();
        const res = await exec(cmd, args, execOpts);
        if (res.code !== 0) {
          throw new Error(
            `backup: ${label} failed (exit ${res.code}): ${res.stderr.trim()}`,
          );
        }
        this.deps.log(
          `backup: ✓ ${label} (${this.deps.now().getTime() - started}ms)`,
        );
        return res;
      };

      const runPipeline = async (
        label: string,
        command: string,
        tolerateFailure = false,
      ): Promise<boolean> => {
        // For remote staged backups this intentionally uses non-`docker`
        // `deps.exec("sh", ...)` with no DOCKER_HOST. The remote driver
        // SSH-wraps non-docker commands onto the droplet, so the entire
        // pg_dump/tar pipeline writes to the droplet staging dir instead
        // of live-streaming artifact bytes over the operator connection.
        const exec = stagedMode ? this.deps.exec : this.deps.localExec;
        const execOpts = stagedMode
          ? { stdio: "pipe" as const }
          : { stdio: "inherit" as const, ...dockerEnv };
        this.deps.log(`backup: → ${label}`);
        this.deps.log(`backup:   $ ${command}`);
        const started = this.deps.now().getTime();
        const res = await exec("sh", ["-c", command], execOpts);
        if (res.code === 0) {
          this.deps.log(
            `backup: ✓ ${label} (${this.deps.now().getTime() - started}ms)`,
          );
          return true;
        }
        if (tolerateFailure) {
          this.deps.log(
            `backup: warning: ${label} skipped (exit ${res.code}): ${res.stderr.trim()}`,
          );
          return false;
        }
        throw new Error(`backup: ${label} failed (exit ${res.code}): ${res.stderr.trim()}`);
      };

      // D420 2.2.4 / R9A — mandatory, fail-closed DB dump + integrity gate.
      // Both Nautilo and Logto dumps must succeed and validate before the
      // bundle manifest is accepted; a missing or corrupt dump aborts the
      // upgrade. The dump pipeline cannot mask a `pg_dump` failure behind a
      // successful gzip, and the validation step rejects empty or
      // non-decompressible output. The `label` identifies which dump failed
      // without surfacing credentials.
      const runDumpWithValidation = async (
        label: string,
        dumpProducer: string,
        target: string,
      ): Promise<void> => {
        await runPipeline(label, failClosedDumpScript(dumpProducer, target));
        await runPipeline(`${label} validation`, validateDumpScript(target));
      };

      const estimateRemoteStagedSizeBytes = async (): Promise<number> => {
        const dbSizeSql =
          "select coalesce(sum(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass)),0)::bigint from pg_tables where schemaname not in ('pg_catalog','information_schema')";
        const nautiloDbSizeCmd =
          `${this.dbExecPrefix({ staged: stagedMode, projectName, service: "app-postgres", composePrefix })}` +
          `psql -U postgres -d nautilo -Atc ` +
          shellQuote(dbSizeSql);
        const logtoDbSizeCmd =
          `${this.dbExecPrefix({ staged: stagedMode, projectName, service: "logto-postgres", composePrefix })}` +
          `psql -U postgres -d logto_nautilo -Atc ` +
          shellQuote(dbSizeSql);
        const artifactsSizeCmd =
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_app_artifacts:/data`)} ` +
          "alpine sh -c 'du -sb /data 2>/dev/null | awk \"{print \\$1}\"'";
        const mediaSizeCmd =
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_app_media:/data`)} ` +
          "alpine sh -c 'du -sb /data 2>/dev/null | awk \"{print \\$1}\"'";
        const appsSizeCmd =
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_app_apps:/data`)} ` +
          "alpine sh -c 'du -sb /data 2>/dev/null | awk \"{print \\$1}\"'";
        const nautiloDb = await runChecked(
          "remote nautilo DB size estimate",
          this.deps.exec,
          "sh",
          ["-c", nautiloDbSizeCmd],
          { stdio: "pipe" },
        );
        const logtoDb = await runChecked(
          "remote logto DB size estimate",
          this.deps.exec,
          "sh",
          ["-c", logtoDbSizeCmd],
          { stdio: "pipe" },
        );
        const artifacts = await runChecked(
          "remote artifact size estimate",
          this.deps.exec,
          "sh",
          ["-c", artifactsSizeCmd],
          { stdio: "pipe" },
        );
        const media = await runChecked(
          "remote media size estimate",
          this.deps.exec,
          "sh",
          ["-c", mediaSizeCmd],
          { stdio: "pipe" },
        );
        const apps = await runChecked(
          "remote apps size estimate",
          this.deps.exec,
          "sh",
          ["-c", appsSizeCmd],
          { stdio: "pipe" },
        );
        return (
          (firstInteger(nautiloDb.stdout) ?? 0) +
          (firstInteger(logtoDb.stdout) ?? 0) +
          (firstInteger(artifacts.stdout) ?? 0) +
          (firstInteger(media.stdout) ?? 0) +
          (firstInteger(apps.stdout) ?? 0)
        );
      };

      const assertRemoteStagingSpace = async (): Promise<void> => {
        const estimated = await estimateRemoteStagedSizeBytes();
        const df = await runChecked(
          "remote free-space check",
          this.deps.exec,
          "df",
          ["-B1", "--output=avail", instanceRootDir],
          { stdio: "pipe" },
        );
        const available = firstInteger(df.stdout);
        if (available === undefined) {
          throw new Error(
            `backup: could not parse remote free-space check output: ${df.stdout.trim()}`,
          );
        }
        if (available < estimated) {
          throw new Error(
            `backup: remote staging needs about ${estimated} bytes but only ${available} bytes are available; re-run with --stream for the non-resumable fallback.`,
          );
        }
      };

      if (stagedMode) {
        await assertRemoteStagingSpace();
        await runChecked(
          "remote staging mkdir",
          this.deps.exec,
          "mkdir",
          ["-p", remoteStagingDir],
          { stdio: "pipe" },
        );
      }

      const contents = {
        nautiloDb: false,
        logtoDb: false,
        artifacts: false,
        media: false,
        apps: false,
        composeTemplate: false,
        instanceEnv: false,
        operatorFiles: false,
        caddyData: false,
        caddyConfig: false,
        localCaCerts: false,
      };

      // Remote day-two deploys use the compose template already materialized
      // at the remote root. Preserve that exact prior template in the bundle
      // before a server-only upgrade can replace it, so rollback restores the
      // topology that produced the captured data and image. A capture failure
      // aborts the backup rather than producing a falsely complete bundle.
      if (isRemote) {
        const remoteTemplatePath = join(instanceRootDir, "docker-compose.yml");
        const capturedTemplatePath = join(bundlePath, "docker-compose.yml");
        if (streamMode) {
          const captured = await runChecked(
            "remote compose template capture",
            this.deps.exec,
            "cat",
            [remoteTemplatePath],
            { stdio: "pipe" },
          );
          await nodeFs.writeFile(capturedTemplatePath, captured.stdout, {
            mode: 0o644,
          });
        } else {
          await runChecked(
            "remote compose template capture",
            this.deps.exec,
            "cp",
            [remoteTemplatePath, join(stageDir, "docker-compose.yml")],
            { stdio: "pipe" },
          );
        }
        contents.composeTemplate = true;
      }

      // D420 2.2.4 / R9A — both DB dumps are mandatory and fail-closed; each
      // is validated (regular, non-empty, decompressible) before the bundle
      // manifest is accepted. A missing or corrupt Nautilo or Logto dump
      // aborts the upgrade before bundle acceptance.
      await runDumpWithValidation(
        "nautilo DB dump",
        `${this.dbExecPrefix({ staged: stagedMode, projectName, service: "app-postgres", composePrefix })}pg_dump -U postgres nautilo`,
        join(stageDir, "nautilo.sql.gz"),
      );
      contents.nautiloDb = true;
      await runDumpWithValidation(
        "logto DB dump",
        `${this.dbExecPrefix({ staged: stagedMode, projectName, service: "logto-postgres", composePrefix })}pg_dump -U postgres logto_nautilo`,
        join(stageDir, "logto_nautilo.sql.gz"),
      );
      contents.logtoDb = true;

      if (streamMode) {
        contents.artifacts = await runPipeline(
          "artifact volume tar",
          `${composePrefix}exec -T nautilo-server tar czf - -C /var/lib/nautilo/artifacts . > ${shellQuote(join(bundlePath, "artifacts.tgz"))}`,
        );
      } else {
        contents.artifacts = await runPipeline(
          "artifact volume tar",
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_app_artifacts:/data`)} -v ${shellQuote(`${volumeStageDir}:/out`)} alpine tar czf /out/artifacts.tgz -C /data .`,
        );
      }
      if (streamMode) {
        contents.media = await runPipeline(
          "media volume tar",
          `${composePrefix}exec -T nautilo-server tar czf - -C /var/lib/nautilo/media . > ${shellQuote(join(bundlePath, "media.tgz"))}`,
        );
      } else {
        contents.media = await runPipeline(
          "media volume tar",
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_app_media:/data`)} -v ${shellQuote(`${volumeStageDir}:/out`)} alpine tar czf /out/media.tgz -C /data .`,
        );
      }
      if (streamMode) {
        contents.apps = await runPipeline(
          "apps volume tar",
          `${composePrefix}exec -T nautilo-server tar czf - -C /var/lib/nautilo/apps . > ${shellQuote(join(bundlePath, "apps.tgz"))}`,
        );
      } else {
        contents.apps = await runPipeline(
          "apps volume tar",
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_app_apps:/data`)} -v ${shellQuote(`${volumeStageDir}:/out`)} alpine tar czf /out/apps.tgz -C /data .`,
        );
      }

      if (mode === "letsencrypt") {
        contents.caddyData = await runPipeline(
          "caddy_data volume tar",
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_caddy_data:/data`)} -v ${shellQuote(`${volumeStageDir}:/out`)} alpine tar czf /out/caddy_data.tgz -C /data .`,
        );
        contents.caddyConfig = await runPipeline(
          "caddy_config volume tar",
          `${this.deps.composeBin} run --rm -v ${shellQuote(`${projectName}_caddy_config:/data`)} -v ${shellQuote(`${volumeStageDir}:/out`)} alpine tar czf /out/caddy_config.tgz -C /data .`,
        );
      }

      const certsPath = join(instanceRootDir, "certs");
      if (isRemote) {
        const testCerts = await this.deps.exec("test", ["-d", certsPath], { stdio: "pipe" });
        if (testCerts.code === 0) {
          contents.localCaCerts = await runPipeline(
            "local CA certs tar",
            `tar czf ${shellQuote(join(stageDir, "certs.tgz"))} -C ${shellQuote(certsPath)} .`,
          );
        }
      } else if (existsSync(certsPath)) {
        contents.localCaCerts = await runPipeline(
          "local CA certs tar",
          `tar czf ${shellQuote(join(bundlePath, "certs.tgz"))} -C ${shellQuote(certsPath)} .`,
        );
      }

      const instanceEnvPath = canonicalInstanceEnvPath(instanceRootDir);
      if (isRemote) {
        const testEnv = await this.deps.exec("test", ["-f", instanceEnvPath], { stdio: "pipe" });
        if (testEnv.code === 0) {
          await runChecked(
            "remote instance.env copy",
            this.deps.exec,
            "cp",
            [instanceEnvPath, join(stageDir, "instance.env")],
            { stdio: "pipe" },
          );
          contents.instanceEnv = true;
        }
      } else if (existsSync(instanceEnvPath)) {
        await nodeFs.copyFile(instanceEnvPath, join(bundlePath, "instance.env"));
        contents.instanceEnv = true;
      }

      if (opts?.noOperatorFiles !== true) {
        const operatorTargets: Array<{ src: string; dest: string }> = [
          {
            src: join(operatorHome(), ".nautilo", "profiles", `${profile.name}.toml`),
            dest: join(bundlePath, "operator", "profiles", `${profile.name}.toml`),
          },
          {
            src: join(operatorHome(), ".nautilo", "bootstrap-tokens", profile.name),
            dest: join(bundlePath, "operator", "bootstrap-tokens", profile.name),
          },
          {
            src: join(localRoot, "instance.json"),
            dest: join(bundlePath, "operator", "instance.json"),
          },
        ];
        for (const file of operatorTargets) {
          if (!existsSync(file.src)) continue;
          await nodeFs.mkdir(join(file.dest, ".."), { recursive: true });
          await nodeFs.copyFile(file.src, file.dest);
          contents.operatorFiles = true;
        }
      }

      if (stagedMode) {
        if (profile.ssh === undefined) {
          throw new Error("backup: remote staged backup requires profile.ssh.");
        }
        const rsyncSource = `${profile.ssh.user}@${profile.ssh.host}:${remoteStagingDir.replace(/\/$/, "")}/`;
        const rsyncTarget = bundlePath.replace(/\/$/, "") + "/";
        this.deps.log(`backup: rsyncing bundle down from ${rsyncSource} ...`);
        await runChecked(
          "rsync remote staging",
          this.deps.localExec,
          "rsync",
          [
            ...(await this.rsyncResumeArgs()),
            "-e",
            sshRsyncSpec(profile),
            rsyncSource,
            rsyncTarget,
          ],
          { stdio: "inherit" },
        );
        // rsync preserves the remote staging directory's mode, which is
        // commonly 0755. The bundle contains plaintext credentials, so
        // reassert the local confidentiality boundary after transfer.
        await nodeFs.chmod(bundlePath, 0o700);
        await runChecked(
          "remote staging cleanup",
          this.deps.exec,
          "rm",
          ["-rf", remoteStagingDir],
          { stdio: "pipe" },
        );
      }

      const image =
        await (async (): Promise<BackupManifest["image"]> => {
          // Profiles no longer persist an artifact strategy. Capture the
          // running server's configured image instead, so backup records what
          // can actually be restored rather than inferring an image from
          // profile.image_ref/from_source. Upgrade paths capture this immediately
          // before stopping the server and pass it through here.
          const running =
            opts?.releaseLegacyImage ??
            await this.captureRunningServerArtifact(profile);
          if (running.mode === "registry") {
            if (!running.repoDigest) {
              throw new Error(
                `backup: running registry image '${running.requested}' has no repo digest.`,
              );
            }
            return {
              mode: "registry",
              repoDigest: running.repoDigest,
              tag: running.requested,
            };
          }
          const backupTag = running.archiveTag ?? `nautilo-server:backup-${stamp}`;
          if (!running.archiveTag) {
            // Prefer the live name, then the immutable id — same containerd
            // untag hazard as upgrade pin (see pinLegacySourceImage).
            const sources = [running.requested, running.immutableId].filter(
              (value, index, all) => value.trim() !== "" && all.indexOf(value) === index,
            );
            let lastErr = "";
            let taggedOk = false;
            for (const source of sources) {
              const tagged = await this.runReleaseDocker(
                profile,
                ["tag", source, backupTag],
              );
              if (tagged.code === 0) {
                taggedOk = true;
                break;
              }
              lastErr = tagged.stderr.trim();
            }
            if (!taggedOk) {
              throw new Error(
                `backup: could not tag running source image ` +
                  `(${sources.join(" | ")} → ${backupTag}): ${lastErr}`,
              );
            }
          }
          return {
            mode: "source",
            imageId: running.immutableId,
            backupTag,
            tag: running.requested,
          };
        })();

      // D427 Wave 1 (task 1.1.1) — compute per-file integrity for every
      // captured bundle member so `nautilo backup verify` and `adopt
      // --confirm` can prove the recovery bundle is intact before any
      // mutation. Files are read from the local bundlePath (after rsync for
      // remote staged backups). Operator files have no single member and
      // are intentionally not inventoried; image identity lives in `image`.
      const integrity = await this.computeBundleIntegrity(bundlePath, contents);

      const manifest = backupManifestSchema.parse({
        version: 2,
        createdAt,
        profileName: profile.name,
        instanceId: profile.instance_id ?? "",
        transport: profile.transport,
        composeProjectName: projectName,
        image,
        contents,
        https: mode === "letsencrypt" ? "letsencrypt" : "off",
        integrity,
      });
      await nodeFs.writeFile(
        join(bundlePath, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        { mode: 0o600 },
      );

      if (opts?.tarball === true) {
        await runChecked(
          "bundle tarball",
          this.deps.localExec,
          "tar",
          ["czf", `${bundlePath}.tgz`, "-C", bundlePath, "."],
          { stdio: "inherit" },
        );
      }

      const imageSummary =
        image.mode === "registry" ? image.repoDigest : image.backupTag ?? image.imageId;
      this.deps.log(`backup: wrote full bundle ${bundlePath} (image=${imageSummary})`);
      return bundlePath;
    } finally {
      restoreEnv();
    }
  }

  /**
   * D427 Wave 1 (task 1.1.1) — compute the per-file integrity inventory for
   * every bundle member that was actually captured and is present on disk.
   *
   * The strict fail-closed gate lives in `nautilo backup verify`: a missing
   * or mismatched member is rejected there before adoption. Backup itself
   * already validates DB dumps via `validateDumpScript` (gzip -t + non-empty)
   * and aborts on tar/dump pipeline failure, so a `true` content flag implies
   * the file exists in a real run. If a file is nonetheless absent here
   * (e.g. an interrupted run), its inventory entry is omitted and a warning
   * is logged so `verify` will flag the bundle unverifiable rather than
   * ship a partial inventory silently.
   */
  private async computeBundleIntegrity(
    bundlePath: string,
    contents: BackupManifest["contents"],
  ): Promise<BackupManifestV2["integrity"]> {
    const integrity: BackupManifestV2["integrity"] = {};
    for (const key of Object.keys(BUNDLE_INTEGRITY_FILES) as BundleIntegrityKey[]) {
      if (!contents[key]) continue;
      const file = BUNDLE_INTEGRITY_FILES[key];
      const filePath = join(bundlePath, file);
      try {
        integrity[key] = await this.hashFile(filePath);
      } catch {
        this.deps.log(
          `backup: warning: integrity inventory skipped missing member ${file}; bundle will fail verification.`,
        );
      }
    }
    return integrity;
  }

  private async hashFile(filePath: string): Promise<FileIntegrity> {
    const stat = await nodeFs.stat(filePath);
    const stream = createReadStream(filePath);
    const hash = createHash("sha256");
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return { sha256: hash.digest("hex"), sizeBytes: stat.size };
  }

  /**
   * D427 Wave 1 (task 1.1.2) — read-only recovery-bundle verification. Thin
   * method wrapper over the standalone verifier so the CLI verb can route
   * through the driver and tests can inject `deps`. The profile is accepted
   * for CLI-verb symmetry but is not used: verification is bundle-local and
   * never connects to a running stack or reads secrets.
   */
  async verifyBundle(
    _profile: ComposeDriverProfile,
    bundlePath: string,
  ): Promise<BundleVerificationReport> {
    const deps: VerifyBundleDeps = {
      fs: nodeFs,
      statSync,
      exec: this.deps.localExec,
      now: this.deps.now,
    };
    return verifyBundleStandalone(bundlePath, deps);
  }

  /** Explicit metadata-only repair; byte files and service lifecycle stay unchanged. */
  async relocateArtifacts(
    profile: ComposeDriverProfile,
    options: { sourceRoot: string; backupPath: string } | { plan: ArtifactRelocationPlan; planSha256: string; rollback: boolean },
  ): Promise<ArtifactRelocationPlan | { outcome: string; planSha256: string }> {
    gates(profile);
    const project = composeProjectName(profile);
    const execute = (command: string, args: string[], stdin?: string) => this.deps.exec(command, args, {
      stdio: "pipe", ...(stdin !== undefined ? { stdin } : {}),
    });
    const checked = async (command: string, args: string[], stdin?: string): Promise<string> => {
      const result = await execute(command, args, stdin);
      if (result.code !== 0) throw new Error(`Artifact relocation target check failed (exit ${result.code}); private diagnostics withheld`);
      return result.stdout.trim();
    };
    const container = async (service: string): Promise<string> => {
      const output = await checked(this.deps.composeBin, ["ps", "--filter", `label=com.docker.compose.project=${project}`,
        "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.ID}}", "--no-trunc"]);
      const ids = output.split(/\s+/).filter(Boolean);
      if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!)) throw new Error("Artifact relocation requires one exact running container per service");
      return ids[0]!;
    };
    let target: RelocationTarget | undefined;
    const dependencies: ArtifactRelocationDeps = {
      target: async () => {
        const serverContainer = await container("nautilo-server");
        const databaseContainer = await container("app-postgres");
        const imageId = await checked(this.deps.composeBin, ["inspect", "--format", "{{.Image}}", serverContainer]);
        if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Artifact relocation image identity unavailable");
        const config = JSON.parse(await checked(this.deps.composeBin, ["exec", serverContainer, "bun", "-e",
          'console.log(JSON.stringify({instanceId:process.env.NAUTILO_INSTANCE_ID,artifactsRoot:process.env.NAUTILO_ARTIFACTS_ROOT}))'])) as { instanceId?: string; artifactsRoot?: string };
        if (config.instanceId !== (profile.instance_id ?? "default") || typeof config.artifactsRoot !== "string") {
          throw new Error("Artifact relocation runtime identity/configured root differs from profile");
        }
        target = { instanceId: config.instanceId, project, serverContainer, databaseContainer, imageId, artifactsRoot: config.artifactsRoot };
        return target;
      },
      sql: async (input) => {
        if (!target) throw new Error("Artifact relocation target not admitted");
        return checked(this.deps.composeBin, ["exec", "-i", "-u", "postgres", target.databaseContainer,
          "psql", "-X", "-q", "-At", "-d", "nautilo", "-v", "ON_ERROR_STOP=1", "-f", "-"], input);
      },
      sourceFiles: async (root, paths) => {
        if (!target) throw new Error("Artifact relocation target not admitted");
        const bundlePath = "sourceRoot" in options ? options.backupPath : options.plan.source.bundlePath;
        const report = await this.verifyBundle(profile, bundlePath);
        return readArtifactRelocationBackup({ bundlePath, report, instanceId: target.instanceId, project: target.project, root, paths });
      },
      files: async (root, paths, configuredRoot) => {
        if (!target) throw new Error("Artifact relocation target not admitted");
        return JSON.parse(await checked(this.deps.composeBin, ["exec", "-i", target.serverContainer, "bun", "-e", ARTIFACT_RELOCATION_FILE_PROBE], JSON.stringify({ root, paths, configuredRoot }))) as RelocationFile[];
      },
    };
    if ("sourceRoot" in options) return planArtifactRelocation(options.sourceRoot, dependencies);
    return applyArtifactRelocation(options.plan, options.planSha256, dependencies, options.rollback);
  }

  async migrateArtifactsToVolume(profile: ComposeDriverProfile): Promise<void> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      const projectName = composeProjectName(profile);
      const volumeName = `${projectName}_app_artifacts`;
      const dockerEnv = dockerEnvForProfile(profile);

      // 1. Idempotency: if the volume exists AND is non-empty, no-op.
      const inspectRes = await this.deps.exec(
        this.deps.composeBin,
        ["volume", "inspect", volumeName],
        { ...dockerEnv, stdio: "pipe" },
      );
      if (inspectRes.code === 0) {
        // Volume exists — check non-empty via a throwaway alpine container.
        const lsRes = await this.deps.exec(
          this.deps.composeBin,
          [
            "run", "--rm",
            "-v", `${volumeName}:/v`,
            "alpine", "sh", "-c", "ls -A /v",
          ],
          { ...dockerEnv, stdio: "pipe" },
        );
        if (lsRes.code === 0 && lsRes.stdout.trim() !== "") {
          this.deps.log(
            `migrate-artifacts-to-volume: '${volumeName}' already exists and is non-empty — already migrated (no-op).`,
          );
          return;
        }
      }

      // 2. Resolve the OLD artifacts root inside the running nautilo-server.
      //    Confirm the container is running first; fail clearly if not.
      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);

      // Probe $HOME inside the running server (artifacts default to
      // $HOME/.nautilo/artifacts when NAUTILO_ARTIFACTS_ROOT is unset).
      const homeProbe = await this.runComposeCapture(
        profile,
        baseYml,
        composeEnvPath,
        caddyOverlayPath,
        ["exec", "-T", "nautilo-server", "sh", "-c", "echo $HOME"],
      );
      if (homeProbe.code !== 0 || homeProbe.stdout.trim() === "") {
        throw new Error(
          `migrate-artifacts-to-volume: could not exec into a running nautilo-server for project '${projectName}'. ` +
            `This command must run while the PRE-Phase-1 server (no volume) is still running, BEFORE you deploy the Phase-1 template. ` +
            `(exit ${homeProbe.code}: ${homeProbe.stderr.trim()})`,
        );
      }
      const remoteHome = homeProbe.stdout.trim();
      const oldRoot = `${remoteHome}/.nautilo/artifacts`;

      const composeFlags =
        `--project-name ${shellQuote(projectName)} -f ${shellQuote(baseYml)} ` +
        (caddyOverlayPath ? `-f ${shellQuote(caddyOverlayPath)} ` : "") +
        (composeEnvPath ? `--env-file ${shellQuote(composeEnvPath)} ` : "");

      // 2b. Probe whether the OLD artifacts dir actually exists AND is
      //     non-empty inside the running server. The directory is created
      //     lazily on first artifact write (getArtifactsRoot has no
      //     import-time side effect), so its absence means "no artifacts
      //     were ever saved" — NOT a failure. We must distinguish that
      //     from a real copy error so a swallowed tar failure can never
      //     leave behind a misleading empty volume that defeats the
      //     Phase-1 deploy/upgrade guard.
      const sourceProbe = await this.runComposeCapture(
        profile,
        baseYml,
        composeEnvPath,
        caddyOverlayPath,
        [
          "exec",
          "-T",
          "nautilo-server",
          "sh",
          "-c",
          `if [ -d ${shellQuote(oldRoot)} ]; then ls -A ${shellQuote(oldRoot)}; else echo __NO_DIR__; fi`,
        ],
      );
      if (sourceProbe.code !== 0) {
        throw new Error(
          `migrate-artifacts-to-volume: could not inspect ${oldRoot} inside the running nautilo-server (exit ${sourceProbe.code}): ${sourceProbe.stderr.trim()}`,
        );
      }
      const probeOut = sourceProbe.stdout.trim();
      const sourceEmpty = probeOut === "" || probeOut === "__NO_DIR__";

      // Create the destination volume (idempotent) regardless — deploy
      // needs it to exist so the guard passes.
      const createRes = await this.deps.exec(
        this.deps.composeBin,
        ["volume", "create", volumeName],
        { ...dockerEnv, stdio: "pipe" },
      );
      if (createRes.code !== 0) {
        throw new Error(
          `migrate-artifacts-to-volume: docker volume create ${volumeName} failed (exit ${createRes.code}): ${createRes.stderr.trim()}`,
        );
      }

      if (sourceEmpty) {
        this.deps.log(
          `migrate-artifacts-to-volume: no artifacts found at ${oldRoot} inside the running server ` +
            `(the directory is created lazily on first artifact write, so this means none were ever saved). ` +
            `Created an EMPTY '${volumeName}' volume so \`nautilo deploy\`/\`nautilo upgrade\` can proceed safely — nothing to migrate.`,
        );
        return;
      }

      // 3. Copy old bytes into the volume via a tar pipe: exec tar out of
      //    the old container | tar into a helper alpine container with the
      //    volume mounted. `set -o pipefail` ensures a failure in the
      //    producing `tar` (e.g. a missing/relocated source dir) fails the
      //    whole pipeline instead of being masked by the receiving tar.
      const pipe =
        `set -o pipefail; ` +
        `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ${composeFlags}` +
        `exec -T nautilo-server tar czf - -C ${shellQuote(oldRoot)} . | ` +
        `${this.deps.composeBin} run --rm -i -v ${shellQuote(`${volumeName}:/dst`)} alpine sh -c ${shellQuote("tar xzf - -C /dst")}`;
      const copyRes = await this.deps.localExec("sh", ["-c", pipe], {
        stdio: "inherit",
        ...dockerEnv,
      });
      if (copyRes.code !== 0) {
        throw new Error(
          `migrate-artifacts-to-volume: copy from ${oldRoot} into '${volumeName}' FAILED (exit ${copyRes.code}). ` +
            `No artifacts were migrated. Do NOT deploy/upgrade yet — the empty volume would strand the originals. ` +
            `${copyRes.stderr.trim()}`,
        );
      }

      // Verify the destination actually received bytes — a defensive
      // check so we never claim success on an empty copy.
      const verifyRes = await this.deps.exec(
        this.deps.composeBin,
        ["run", "--rm", "-v", `${volumeName}:/v`, "alpine", "sh", "-c", "ls -A /v"],
        { ...dockerEnv, stdio: "pipe" },
      );
      if (verifyRes.code === 0 && verifyRes.stdout.trim() === "") {
        throw new Error(
          `migrate-artifacts-to-volume: copy reported success but '${volumeName}' is still empty. ` +
            `Aborting so a deploy/upgrade does not strand the original artifacts. Investigate ${oldRoot} on the server.`,
        );
      }

      this.deps.log(
        `migrate-artifacts-to-volume: copied artifacts from ${oldRoot} into '${volumeName}'. ` +
          `Now run \`nautilo deploy\`/\`nautilo upgrade\` to recreate the server on the Phase-1 template; the populated volume will be mounted as-is.`,
      );
    } finally {
      restoreEnv();
    }
  }

  /**
   * M139 — one-time migration for custom avatars and the server icon that
   * pre-volume servers kept below $HOME/.nautilo[-instance]. This deliberately
   * runs only on operator request while that old container is still alive.
   */
  async migrateMediaToVolume(profile: ComposeDriverProfile): Promise<void> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      const projectName = composeProjectName(profile);
      const volumeName = `${projectName}_app_media`;
      const dockerEnv = dockerEnvForProfile(profile);

      const inspectRes = await this.deps.exec(
        this.deps.composeBin,
        ["volume", "inspect", volumeName],
        { ...dockerEnv, stdio: "pipe" },
      );
      if (inspectRes.code === 0) {
        const lsRes = await this.deps.exec(
          this.deps.composeBin,
          ["run", "--rm", "-v", `${volumeName}:/v`, "alpine", "sh", "-c", "ls -A /v"],
          { ...dockerEnv, stdio: "pipe" },
        );
        if (lsRes.code === 0 && lsRes.stdout.trim() !== "") {
          this.deps.log(
            `migrate-media-to-volume: '${volumeName}' already exists and is non-empty — already migrated (no-op).`,
          );
          return;
        }
      }

      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
      const homeProbe = await this.runComposeCapture(
        profile,
        baseYml,
        composeEnvPath,
        caddyOverlayPath,
        ["exec", "-T", "nautilo-server", "sh", "-c", "echo $HOME"],
      );
      if (homeProbe.code !== 0 || homeProbe.stdout.trim() === "") {
        throw new Error(
          `migrate-media-to-volume: could not exec into a running nautilo-server for project '${projectName}'. ` +
            `This command must run while the pre-volume server is still running, BEFORE you deploy the media-volume template. ` +
            `(exit ${homeProbe.code}: ${homeProbe.stderr.trim()})`,
        );
      }

      const instanceId = (profile.instance_id ?? "").trim();
      const oldRoot = `${homeProbe.stdout.trim()}/.nautilo${instanceId ? `-${instanceId}` : ""}`;
      const sourceProbe = await this.runComposeCapture(
        profile,
        baseYml,
        composeEnvPath,
        caddyOverlayPath,
        [
          "exec",
          "-T",
          "nautilo-server",
          "sh",
          "-c",
          [
            "for item in profile-avatars server-icon; do",
            `dir=${shellQuote(oldRoot)}/"$item"`,
            'if [ -d "$dir" ] && [ -n "$(ls -A -- "$dir" 2>/dev/null)" ]; then printf "%s\\n" "$item"; fi',
            "done",
          ].join(" "),
        ],
      );
      if (sourceProbe.code !== 0) {
        throw new Error(
          `migrate-media-to-volume: could not inspect ${oldRoot} inside the running nautilo-server (exit ${sourceProbe.code}): ${sourceProbe.stderr.trim()}`,
        );
      }
      const sourceItems = ["profile-avatars", "server-icon"].filter((item) =>
        sourceProbe.stdout.split(/\r?\n/).includes(item),
      );

      const createRes = await this.deps.exec(
        this.deps.composeBin,
        ["volume", "create", volumeName],
        { ...dockerEnv, stdio: "pipe" },
      );
      if (createRes.code !== 0) {
        throw new Error(
          `migrate-media-to-volume: docker volume create ${volumeName} failed (exit ${createRes.code}): ${createRes.stderr.trim()}`,
        );
      }
      if (sourceItems.length === 0) {
        this.deps.log(
          `migrate-media-to-volume: no avatar or server-icon media found at ${oldRoot}. Created an EMPTY '${volumeName}' volume so \`nautilo deploy\`/\`nautilo upgrade\` can proceed safely.`,
        );
        return;
      }

      const composeFlags =
        `--project-name ${shellQuote(projectName)} -f ${shellQuote(baseYml)} ` +
        (caddyOverlayPath ? `-f ${shellQuote(caddyOverlayPath)} ` : "") +
        (composeEnvPath ? `--env-file ${shellQuote(composeEnvPath)} ` : "");
      const pipe =
        `set -o pipefail; ` +
        `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ${composeFlags}` +
        `exec -T nautilo-server tar czf - -C ${shellQuote(oldRoot)} ${sourceItems.map(shellQuote).join(" ")} | ` +
        `${this.deps.composeBin} run --rm -i -v ${shellQuote(`${volumeName}:/dst`)} alpine sh -c ${shellQuote("tar xzf - -C /dst")}`;
      const copyRes = await this.deps.localExec("sh", ["-c", pipe], {
        stdio: "inherit",
        ...dockerEnv,
      });
      if (copyRes.code !== 0) {
        throw new Error(
          `migrate-media-to-volume: copy from ${oldRoot} into '${volumeName}' FAILED (exit ${copyRes.code}). ` +
            `No media was migrated. Do NOT deploy/upgrade yet — the empty volume would strand the originals. ${copyRes.stderr.trim()}`,
        );
      }

      const verifyRes = await this.deps.exec(
        this.deps.composeBin,
        ["run", "--rm", "-v", `${volumeName}:/v`, "alpine", "sh", "-c", "ls -A /v"],
        { ...dockerEnv, stdio: "pipe" },
      );
      if (verifyRes.code !== 0) {
        throw new Error(
          `migrate-media-to-volume: could not verify '${volumeName}' after copy (exit ${verifyRes.code}): ${verifyRes.stderr.trim()}`,
        );
      }
      if (verifyRes.stdout.trim() === "") {
        throw new Error(
          `migrate-media-to-volume: copy reported success but '${volumeName}' is still empty. Aborting so a deploy/upgrade does not strand the original media. Investigate ${oldRoot} on the server.`,
        );
      }
      this.deps.log(
        `migrate-media-to-volume: copied ${sourceItems.join(" + ")} from ${oldRoot} into '${volumeName}'. ` +
          "Now run `nautilo deploy`/`nautilo upgrade` to recreate the server with durable media.",
      );
    } finally {
      restoreEnv();
    }
  }

  async restore(
    profile: ComposeDriverProfile,
    opts: RestoreOptions,
  ): Promise<void> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      const isBundle =
        existsSync(join(opts.fromPath, "manifest.json")) &&
        (() => {
          try {
            return statSync(opts.fromPath).isDirectory();
          } catch {
            return false;
          }
        })();

      if (isBundle) {
        const mode = opts.mode ?? "full";
        const shouldLoadData = mode === "full" || mode === "data-only";
        const manifest = backupManifestSchema.parse(
          JSON.parse(await nodeFs.readFile(join(opts.fromPath, "manifest.json"), "utf8")),
        );
        if (
          (mode === "full" || mode === "data-only") &&
          (!manifest.contents.nautiloDb || !manifest.contents.logtoDb)
        ) {
          throw new Error(
            "restore refused: full/data bundle must declare both Nautilo and Logto DB dumps",
          );
        }
        const bundleIdentity = shouldLoadData
          ? await readRestoreInstanceIdentityFromDump(
              join(opts.fromPath, "nautilo.sql.gz"),
            )
          : undefined;
        assertRestoreIdentityCompatible({
          bundle: bundleIdentity,
          target: undefined,
          manifestInstanceId: manifest.instanceId,
          targetInstanceId: (profile.instance_id ?? "").trim(),
        });
        const projectName = composeProjectName(profile);
        if (manifest.composeProjectName !== projectName) {
          this.deps.log(
            `restore: warning: bundle composeProjectName=${manifest.composeProjectName} differs from target ${projectName}`,
          );
        }
        if (manifest.transport !== profile.transport) {
          this.deps.log(
            `restore: warning: bundle transport=${manifest.transport} differs from target ${profile.transport}`,
          );
        }

        if (!opts.force) {
          // Conservative: refuse if a healthy stack reports
          // setupState=ready (i.e. it has data the operator might lose).
          const inst2 = this.resolveInstanceForProfile();
          const baseUrl = resolveServerBaseUrl(profile, inst2);
          let probeBody: string | undefined;
          try {
            const probeRes = await this.deps.fetch(`${baseUrl}/api/setup/status`);
            if (probeRes.ok) probeBody = await probeRes.text();
          } catch {
            // Server unreachable — proceed with restore.
          }
          if (probeBody && /"setupState"\s*:\s*"ready"/.test(probeBody)) {
            throw new Error(
              "restore refused: stack is healthy and setupState=ready. Re-run with --force to overwrite.",
            );
          }
        }

        // `from_source` is invocation-scoped and intentionally stripped from
        // persisted profiles. After a legacy bootstrap, therefore, the remote
        // deployment manifest—not a stale profile field—is authoritative for
        // selecting the SSH-native registry restore path.
        let remoteManifestAvailable = false;
        let remoteManifestRegistry = false;
        if (profile.transport === "remote" && !usesRemoteRegistryMode(profile)) {
          try {
            const remoteManifest = await this.readRemoteDeploymentManifest(profile);
            remoteManifestAvailable = true;
            remoteManifestRegistry = remoteManifest.image.mode === "registry";
          } catch (err) {
            const message = errorMessage(err);
            if (!message.includes("is missing or unreadable")) throw err;
          }
        }
        if (
          usesRemoteRegistryMode(profile) ||
          remoteManifestRegistry ||
          (mode === "full" && remoteManifestAvailable && opts.stream !== true)
        ) {
          await this.restoreRemoteBundle(
            profile,
            opts,
            manifest,
            mode,
            bundleIdentity,
          );
          return;
        }

        const stamp = backupTimestamp(this.deps.now());
        const baseYml = join(this.deps.templateDir, "docker-compose.yml");
        const composeEnvPath = this.existingComposeEnvPath(profile);
        const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
        const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
        const localRoot = this.deps.resolveLocalInstanceRootDir(profile);
        const dockerEnv = dockerEnvForProfile(profile);
        // Remote registry bundle restore returned through restoreRemoteBundle() above.
        const isRemote = profile.transport === "remote";
        const streamMode = isRemote && opts.stream === true;
        const stagedMode = isRemote && !streamMode;
        const remoteStagingDir = join(instanceRootDir, `.restore-staging-${stamp}`);
        const stageDir = stagedMode ? remoteStagingDir : opts.fromPath;
        const toLocal = (remotePath: string): string =>
          isRemoteFs(this.deps.fs)
            ? this.deps.fs.toLocalStagingPath(remotePath)
            : remotePath;
        await ensureCanonicalConfigLayout(localRoot);
        await ensureCanonicalConfigLayout(toLocal(instanceRootDir));
        // Remote profiles bind-mount postgres-init.sh. The base template
        // references it by operator-laptop-relative paths that do NOT exist on
        // the remote daemon, so recreating app-postgres during a restore/
        // rollback fails. Mirror deploy(): stage the init script to the remote
        // root and emit a volumes-overlay that re-points the mount to its
        // absolute remote path, then layer it into every restore compose
        // invocation below.
        let volumesOverlayPath: string | undefined;
        if (isRemoteFs(this.deps.fs)) {
          const postgresInit = await nodeFs.readFile(
            join(this.deps.templateDir, "..", "..", "..", "infra", "postgres-init.sh"),
            "utf8",
          );
          await this.deps.fs.writeFile(
            join(instanceRootDir, "postgres-init.sh"),
            postgresInit,
            { mode: 0o755 },
          );
          volumesOverlayPath = join(instanceRootDir, "deploy.volumes-overlay.yml");
          await this.deps.fs.writeFile(
            volumesOverlayPath,
            remoteVolumesOverlayYaml(instanceRootDir),
            { mode: 0o600 },
          );
          await this.deps.fs.syncToRemote();
        }
        const runChecked = async (
          label: string,
          exec: ExecFn,
          cmd: string,
          args: string[],
          execOpts: { env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" },
        ): Promise<ExecResult> => {
          this.deps.log(`restore: → ${label}: ${cmd} ${args.join(" ")}`);
          const started = this.deps.now().getTime();
          const res = await exec(cmd, args, execOpts);
          if (res.code !== 0) {
            throw new Error(
              `restore: ${label} failed (exit ${res.code}): ${res.stderr.trim()}`,
            );
          }
          this.deps.log(
            `restore: ✓ ${label} (${this.deps.now().getTime() - started}ms)`,
          );
          return res;
        };
        // The server env overlay (NAUTILO_INSTANCE_ID + LOGTO_* container-DNS
        // overrides) is regenerated from the restored instance.env below and
        // layered into every restore compose invocation. It MUST come before
        // the image-pin restore overlay so the pin still wins on `image:`.
        // Without it, a rolled-back nautilo-server came up with no instance id
        // (self-IDing as the default instance) and no Logto config at all.
        let serverOverlayPath: string | undefined;
        const composeArgs = (extra: string[], overlayPath?: string): string[] => {
          const args = ["--project-name", projectName, "-f", baseYml];
          if (volumesOverlayPath) args.push("-f", toLocal(volumesOverlayPath));
          if (caddyOverlayPath) args.push("-f", caddyOverlayPath);
          if (serverOverlayPath) args.push("-f", toLocal(serverOverlayPath));
          if (overlayPath) args.push("-f", toLocal(overlayPath));
          if (composeEnvPath) args.push("--env-file", composeEnvPath);
          args.push(...extra);
          return args;
        };
        const composeFlags = (overlayPath?: string): string =>
          `--project-name ${shellQuote(projectName)} -f ${shellQuote(baseYml)} ` +
          (volumesOverlayPath ? `-f ${shellQuote(toLocal(volumesOverlayPath))} ` : "") +
          (caddyOverlayPath ? `-f ${shellQuote(caddyOverlayPath)} ` : "") +
          (serverOverlayPath ? `-f ${shellQuote(toLocal(serverOverlayPath))} ` : "") +
          (overlayPath ? `-f ${shellQuote(toLocal(overlayPath))} ` : "") +
          (composeEnvPath ? `--env-file ${shellQuote(composeEnvPath)} ` : "");
        let restoreOverlayPath: string | undefined;

        // Restore is a continuity operation. Read the target's current marker
        // before a full restore can start a fresh server (and thereby mint a
        // new marker), then fail before schema reset if this bundle belongs to
        // a different logical server. Starting app-postgres alone is safe on a
        // fresh host and leaves the marker absent.
        if (shouldLoadData) {
          if (mode === "full") {
            await this.runCompose(
              composeArgs([
                "--profile",
                "app",
                "up",
                "-d",
                "--wait",
                "--no-build",
                "app-postgres",
              ]),
              { stdio: "inherit" },
            );
          }
          const identityComposePrefix =
            `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ${composeFlags()}`;
          const identityPgExec = this.dbExecPrefix({
            staged: stagedMode,
            projectName,
            service: "app-postgres",
            composePrefix: identityComposePrefix,
          });
          const targetIdentity = await this.readConnectedRestoreIdentity(
            profile,
            identityPgExec,
            stagedMode,
            "target identity preflight",
          );
          assertRestoreIdentityCompatible({
            bundle: bundleIdentity,
            target: targetIdentity,
            manifestInstanceId: manifest.instanceId,
            targetInstanceId: (profile.instance_id ?? "").trim(),
          });
        }

        if (mode === "full") {
          const operatorTargets: Array<{ src: string; dest: string }> = [
            {
              src: join(opts.fromPath, "operator", "profiles", `${profile.name}.toml`),
              dest: join(operatorHome(), ".nautilo", "profiles", `${profile.name}.toml`),
            },
            {
              src: join(opts.fromPath, "operator", "bootstrap-tokens", profile.name),
              dest: join(operatorHome(), ".nautilo", "bootstrap-tokens", profile.name),
            },
            {
              src: join(opts.fromPath, "operator", "instance.json"),
              dest: join(localRoot, "instance.json"),
            },
          ];
          for (const file of operatorTargets) {
            if (existsSync(file.dest) || !existsSync(file.src)) continue;
            await nodeFs.mkdir(join(file.dest, ".."), { recursive: true });
            await nodeFs.copyFile(file.src, file.dest);
          }

          if (manifest.contents.instanceEnv && existsSync(join(opts.fromPath, "instance.env"))) {
            let envContents = await nodeFs.readFile(
              join(opts.fromPath, "instance.env"),
              "utf8",
            );
            let currentComposeEnv = "";
            if (composeEnvPath !== undefined) {
              try {
                currentComposeEnv = await this.deps.fs.readFile(
                  composeEnvPath,
                  "utf8",
                );
              } catch {
                currentComposeEnv = "";
              }
            }
            const currentCryptoPassword =
              parseDotenv(currentComposeEnv)["NAUTILO_CRYPTO_DB_PASSWORD"];
            const restoredCrypto = ensureCryptoPasswordInDotenv(
              envContents,
              () =>
                currentCryptoPassword?.trim() ||
                randomBytes(24).toString("hex"),
            );
            envContents = restoredCrypto.raw;
            await this.deps.fs.mkdir(instanceRootDir, { recursive: true });
            await this.deps.fs.mkdir(
              join(instanceRootDir, ".bootstrap"),
              { recursive: true, mode: 0o700 },
            );
            await ensureCanonicalConfigLayout(toLocal(instanceRootDir));
            await this.deps.fs.writeFile(canonicalInstanceEnvPath(instanceRootDir), envContents, {
              mode: 0o600,
            });
            await this.deps.fs.writeFile(
              join(instanceRootDir, CRYPTO_DB_PASSWORD_RELATIVE_PATH),
              `${restoredCrypto.secret}\n`,
              { mode: 0o600 },
            );
            if (composeEnvPath !== undefined) {
              await this.deps.fs.writeFile(
                composeEnvPath,
                setCryptoPasswordInDotenv(
                  currentComposeEnv,
                  restoredCrypto.secret,
                ),
                { mode: 0o600 },
              );
            }
          }

          // Regenerate the server overlay from the just-restored instance.env
          // and layer it into the compose invocations (via serverOverlayPath +
          // the closures above). This is the fix for the rollback identity/auth
          // regression: the image-pin restore overlay alone recreated
          // nautilo-server WITHOUT NAUTILO_INSTANCE_ID (→ default-instance
          // self-identity + D374 marker oscillation) and WITHOUT any LOGTO_*
          // env (→ auth dead behind a green /health). We rebuild the same
          // overlay deploy() writes so a rolled-back server's runtime env is
          // identical to a freshly deployed one. Regenerated (not reused) so
          // the LOGTO_* container-DNS rewrites match the restored instance.env.
          const overlayInst = this.resolveInstanceForProfile();
          const restorePasswordRecoveryDriver =
            profile.password_recovery ?? "oss_relay";
          const restoreForgotPasswordWebhookSecret = passwordRecoveryUsesOssRelay(
            {
              ...process.env,
              NAUTILO_PASSWORD_RECOVERY_DRIVER: restorePasswordRecoveryDriver,
            },
          )
            ? await this.deps.ensureForgotPasswordWebhookSecret({
                instanceRootDir: localRoot,
              })
            : undefined;
          const restoreRemotePairingPepper =
            await this.deps.ensureRemotePairingPepper({
              instanceRootDir: localRoot,
            });
          const restorePushTokenEncryptionKey =
            await this.deps.ensurePushTokenEncryptionKey({
              instanceRootDir: localRoot,
            });
          const restoreInstanceEnv =
            await this.deps.readInstanceLogtoEnv(instanceRootDir);
          const restoreOverlayEnv = buildServerOverlayEnv(
            overlayInst,
            restoreInstanceEnv,
            {
              passwordRecoveryDriver: restorePasswordRecoveryDriver,
              ...(restoreForgotPasswordWebhookSecret !== undefined
                ? {
                    forgotPasswordWebhookSecret:
                      restoreForgotPasswordWebhookSecret,
                  }
                : {}),
              remotePairingPepper: restoreRemotePairingPepper,
              pushTokenEncryptionKey: restorePushTokenEncryptionKey,
            },
          );
          const restoreServerEnvPath = join(instanceRootDir, "deploy.server.env");
          await this.deps.fs.writeFile(
            restoreServerEnvPath,
            envFileContents(restoreOverlayEnv),
            { mode: 0o600 },
          );
          const restoreServerOverlayYmlPath = join(
            instanceRootDir,
            "deploy.server-overlay.yml",
          );
          await this.deps.fs.writeFile(
            restoreServerOverlayYmlPath,
            serverOverlayYaml(
              toLocal(restoreServerEnvPath),
              toLocal(canonicalInstanceEnvPath(instanceRootDir)),
              runtimeConfigDir(instanceRootDir),
              this.deps.managedServerEnvPath,
            ),
            { mode: 0o600 },
          );
          serverOverlayPath = restoreServerOverlayYmlPath;
          if (isRemoteFs(this.deps.fs)) {
            await this.deps.fs.syncToRemote();
          }

          let imageRef: string;
          if (manifest.image.mode === "registry") {
            if (!manifest.image.repoDigest) {
              throw new Error("restore: registry-mode bundle missing image.repoDigest");
            }
            imageRef = manifest.image.repoDigest;
          } else {
            const backupTag = manifest.image.backupTag;
            if (!backupTag) {
              throw new Error("restore: source-mode bundle missing image.backupTag");
            }
            const inspect = await this.deps.exec(
              this.deps.composeBin,
              ["image", "inspect", backupTag],
              { ...dockerEnv, stdio: "pipe" },
            );
            if (inspect.code !== 0) {
              throw new Error(
                "restore: source-mode clean-host disaster recovery cannot re-pin an image to a daemon that never built it; use registry mode for disaster recovery.",
              );
            }
            imageRef = backupTag;
          }

          restoreOverlayPath = join(instanceRootDir, "deploy.restore-overlay.yml");
          await this.deps.fs.writeFile(
            restoreOverlayPath,
            buildPinnedImageOverlay(imageRef),
            { mode: 0o600 },
          );
          if (isRemoteFs(this.deps.fs)) {
            await this.deps.fs.syncToRemote();
          }

          if (manifest.image.mode === "registry") {
            await this.runCompose(
              composeArgs(
                ["--profile", "auth", "--profile", "app", "pull", "nautilo-server"],
                restoreOverlayPath,
              ),
              { stdio: "inherit" },
            );
          }
          this.deps.log(
            "restore: starting logto-postgres before Logto pre-seed recovery...",
          );
          await this.runCompose(
            composeArgs(
              ["--profile", "auth", "up", "-d", "--wait", "--no-build", "logto-postgres"],
              restoreOverlayPath,
            ),
            { stdio: "inherit" },
          );
          const restoreLogtoPreflightPrefix = this.dbExecPrefix({
            staged: stagedMode,
            projectName,
            service: "logto-postgres",
            composePrefix: `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ${composeFlags(stagedMode ? undefined : restoreOverlayPath)}`,
          });
          await this.preflightLogtoPreSeedRecovery(
            stagedMode
              ? {
                  transport: "staged_compose",
                  execPrefix: restoreLogtoPreflightPrefix,
                }
              : {
                  transport: "local_compose",
                  composeBin: this.deps.composeBin,
                  composeArgs: this.deps.composeArgs,
                  composeProjectArgs: composeArgs(
                    ["--profile", "auth", "--profile", "app"],
                    restoreOverlayPath,
                  ),
                },
            stagedMode ? this.deps.exec : this.sqlPipelineExec(profile),
          );
          await this.preflightLogtoTenantPasswordResync(
            stagedMode
              ? {
                  transport: "staged_compose",
                  execPrefix: restoreLogtoPreflightPrefix,
                }
              : {
                  transport: "local_compose",
                  composeBin: this.deps.composeBin,
                  composeArgs: this.deps.composeArgs,
                  composeProjectArgs: composeArgs(
                    ["--profile", "auth", "--profile", "app"],
                    restoreOverlayPath,
                  ),
                },
            stagedMode ? this.deps.exec : this.sqlPipelineExec(profile),
          );
          await this.runCompose(
            composeArgs(
              [
                "--profile",
                "auth",
                "--profile",
                "app",
                "up",
                "-d",
                "--no-build",
              ],
              restoreOverlayPath,
            ),
            { stdio: "inherit" },
          );
        }

        if (stagedMode) {
          if (profile.ssh === undefined) {
            throw new Error("restore: remote staged restore requires profile.ssh.");
          }
          await runChecked(
            "remote staging mkdir",
            this.deps.exec,
            "mkdir",
            ["-p", remoteStagingDir],
            { stdio: "pipe" },
          );
          await runChecked(
            "rsync bundle to remote staging",
            this.deps.localExec,
            "rsync",
            [
              ...(await this.rsyncResumeArgs()),
              "-e",
              sshRsyncSpec(profile),
              opts.fromPath.replace(/\/$/, "") + "/",
              `${profile.ssh.user}@${profile.ssh.host}:${remoteStagingDir.replace(/\/$/, "")}/`,
            ],
            { stdio: "inherit" },
          );
        }

        if (streamMode) {
          this.deps.log(
            "restore: --stream enabled for remote profile; transfer is NOT resumable. Re-run without --stream when remote disk allows staged rsync.",
          );
        }

        await this.runCompose(
          composeArgs(["stop", "nautilo-server"], restoreOverlayPath),
          { stdio: "inherit" },
        );

        const runPipeline = async (label: string, command: string): Promise<void> => {
          const exec = stagedMode ? this.deps.exec : this.deps.localExec;
          const execOpts = stagedMode
            ? { stdio: "pipe" as const }
            : { stdio: "inherit" as const, ...dockerEnv };
          this.deps.log(`restore:   $ ${command}`);
          await runChecked(label, exec, "sh", ["-c", command], execOpts);
        };
        const composePrefix =
          `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ${composeFlags(stagedMode ? undefined : restoreOverlayPath)}`;
        const shouldLoadArtifacts = mode === "full" || mode === "artifacts-only";

        const appPgExec = this.dbExecPrefix({
          staged: stagedMode,
          projectName,
          service: "app-postgres",
          composePrefix,
        });
        const logtoPgExec = this.dbExecPrefix({
          staged: stagedMode,
          projectName,
          service: "logto-postgres",
          composePrefix,
        });

        // D420 3.1.1 / R9A — validate EVERY required compressed DB dump BEFORE
        // any destructive schema reset. A corrupt/truncated gzip must fail
        // before either DB schema is destroyed, so both dumps are gated up
        // front rather than each just before its own DROP. `validateDumpScript`
        // rejects missing/empty/non-decompressible artifacts with no credential
        // leakage; the failure surfaces through runChecked.
        if (shouldLoadData) {
          const requiredDumps: Array<{ label: string; path: string }> = [];
          if (manifest.contents.nautiloDb) {
            requiredDumps.push({
              label: "nautilo DB dump validation",
              path: join(stageDir, "nautilo.sql.gz"),
            });
          }
          if (manifest.contents.logtoDb) {
            requiredDumps.push({
              label: "logto DB dump validation",
              path: join(stageDir, "logto_nautilo.sql.gz"),
            });
          }
          for (const { label, path } of requiredDumps) {
            await runPipeline(label, validateRestoreDumpScript(path));
          }
        }

        if (shouldLoadData && manifest.contents.nautiloDb) {
          // Atomic reset+restore: schema wipe and dump load share one psql
          // `--single-transaction` so a failed import rolls back the reset.
          // See {@link NAUTILO_SCHEMA_RESET_SQL} for the full wipe rationale.
          await runPipeline(
            "nautilo DB restore",
            atomicDbRestoreScript(
              join(stageDir, "nautilo.sql.gz"),
              `${appPgExec}psql -U postgres -d nautilo`,
              NAUTILO_SCHEMA_RESET_SQL,
            ),
          );
          const restoredIdentity = await this.readConnectedRestoreIdentity(
            profile,
            appPgExec,
            stagedMode,
            "restored identity verification",
          );
          assertRestoredIdentity(bundleIdentity, restoredIdentity);
          await this.repairAppDbOwnership(
            { transport: "staged_compose", execPrefix: appPgExec },
            stagedMode ? this.deps.exec : this.sqlPipelineExec(profile),
          );
        }

        if (shouldLoadData && manifest.contents.logtoDb) {
          await runPipeline(
            "logto DB restore",
            atomicDbRestoreScript(
              join(stageDir, "logto_nautilo.sql.gz"),
              `${logtoPgExec}psql -U postgres -d logto_nautilo`,
              LOGTO_SCHEMA_RESET_SQL,
            ),
          );
          // CRITICAL: Logto OSS is multi-tenant via cluster-global per-tenant
          // roles (`logto_tenant_<db>[_admin|_default]`) + RLS. Those roles
          // need USAGE on `public` + table/sequence/function privileges to see
          // their own data. `DROP SCHEMA public CASCADE` above wipes the
          // schema's grants, and `pg_dump` does NOT carry the schema-level
          // grants to those roles — so without this re-grant, every tenant
          // (incl. `admin`, which the deploy's bootstrap needs) fails with
          // `42P01 relation does not exist` and Logto returns 500. RLS still
          // enforces tenant isolation; these grants only restore visibility.
          // Idempotent + role-agnostic: loops over whatever logto_tenant_*
          // roles exist (no-op on a fresh host where none do yet).
          await runPipeline(
            "logto tenant-role grants",
            `${logtoPgExec}psql -U postgres -d logto_nautilo -c ${shellQuote(LOGTO_TENANT_REGRANT_SQL)}`,
          );
          if (mode === "full") {
            await this.preflightLogtoTenantPasswordResync(
              stagedMode
                ? {
                    transport: "staged_compose",
                    execPrefix: logtoPgExec,
                  }
                : {
                    transport: "local_compose",
                    composeBin: this.deps.composeBin,
                    composeArgs: this.deps.composeArgs,
                    composeProjectArgs: composeArgs(
                      ["--profile", "auth", "--profile", "app"],
                      restoreOverlayPath,
                    ),
                  },
              stagedMode ? this.deps.exec : this.sqlPipelineExec(profile),
            );
          }
        }

        // D420 (Wave 3 task 3.3.2) — re-pin app + Logto tenant role passwords
        // to the restored instance.env / tenants table BEFORE application
        // startup so a rolled-back server does not boot green behind a
        // password desync. Idempotent; fail-closed with private SQL input.
        if (shouldLoadData) {
          let instanceEnvRaw = "";
          try {
            instanceEnvRaw = await this.deps.fs.readFile(
              canonicalInstanceEnvPath(instanceRootDir),
              "utf8",
            );
          } catch {
            // data-only restores of a bundle without instance.env keep the
            // pre-existing target instance.env; if none is readable yet the
            // app-role reconcile step skips (logto tenant resync still runs).
            instanceEnvRaw = "";
          }
          await this.reconcileRestoredDbPasswords({
            appPgExec,
            logtoPgExec,
            instanceEnvRaw,
            reconcileNautilo: manifest.contents.nautiloDb === true,
            reconcileLogto: manifest.contents.logtoDb === true,
            exec: stagedMode ? this.deps.exec : this.sqlPipelineExec(profile),
          });
        }

        const loadVolume = async (label: string, volumeName: string, fileName: string): Promise<void> => {
          if (streamMode) {
            await runPipeline(
              label,
              `cat ${shellQuote(join(opts.fromPath, fileName))} | ${this.deps.composeBin} run --rm -i -v ${shellQuote(`${volumeName}:/dst`)} alpine sh -c ${shellQuote("rm -rf /dst/* && tar xzf - -C /dst")}`,
            );
            return;
          }
          await runPipeline(
            label,
            `${this.deps.composeBin} run --rm -v ${shellQuote(`${volumeName}:/dst`)} -v ${shellQuote(`${stageDir}:/in`)} alpine sh -c ${shellQuote(`rm -rf /dst/* && tar xzf /in/${fileName} -C /dst`)}`,
          );
        };

        if (shouldLoadArtifacts && manifest.contents.artifacts) {
          await loadVolume("artifact volume restore", `${projectName}_app_artifacts`, "artifacts.tgz");
        }
        // `artifacts-only` is the existing persistent-byte-volume restore mode:
        // restore durable UI media alongside artifacts without touching DBs.
        if (shouldLoadArtifacts && manifest.contents.media) {
          await loadVolume("media volume restore", `${projectName}_app_media`, "media.tgz");
        }
        if (shouldLoadArtifacts && manifest.contents.apps) {
          await loadVolume("apps volume restore", `${projectName}_app_apps`, "apps.tgz");
        }
        if (mode === "full" && manifest.contents.caddyData) {
          await loadVolume("caddy_data volume restore", `${projectName}_caddy_data`, "caddy_data.tgz");
        }
        if (mode === "full" && manifest.contents.caddyConfig) {
          await loadVolume("caddy_config volume restore", `${projectName}_caddy_config`, "caddy_config.tgz");
        }
        if (mode === "full" && manifest.contents.localCaCerts) {
          const certsPath = join(instanceRootDir, "certs");
          if (streamMode && profile.ssh !== undefined) {
            await runChecked(
              "local CA certs restore",
              this.deps.localExec,
              "sh",
              [
                "-c",
                `cat ${shellQuote(join(opts.fromPath, "certs.tgz"))} | ${sshRsyncSpec(profile)} ${shellQuote(`${profile.ssh.user}@${profile.ssh.host}`)} ${shellQuote(`mkdir -p ${shellQuote(certsPath)} && tar xzf - -C ${shellQuote(certsPath)}`)}`,
              ],
              { stdio: "inherit" },
            );
          } else {
            await runPipeline(
              "local CA certs restore",
              `mkdir -p ${shellQuote(certsPath)} && rm -rf ${shellQuote(certsPath)}/* && tar xzf ${shellQuote(join(stageDir, "certs.tgz"))} -C ${shellQuote(certsPath)}`,
            );
          }
        }

        await this.runCompose(
          composeArgs(["start", "nautilo-server"], restoreOverlayPath),
          { stdio: "inherit" },
        );
        if (mode === "full" || mode === "data-only") {
          const inst = this.resolveInstanceForProfile();
          await this.pollServerHealthForProfile(
            profile,
            resolveServerBaseUrl(profile, inst),
          );
        }
        if (
          mode === "full" &&
          profile.transport === "remote" &&
          remoteManifestAvailable
        ) {
          await this.reconcileRemoteDeploymentManifestFromBundle(
            profile,
            resolveRemoteBundleRestoreImage(manifest.image).manifestImage,
          );
        }

        if (stagedMode) {
          await runChecked(
            "remote staging cleanup",
            this.deps.exec,
            "rm",
            ["-rf", remoteStagingDir],
            { stdio: "pipe" },
          );
        }
        this.deps.log(
          `restore: restored ${mode} bundle ${opts.fromPath} into ${projectName}`,
        );
        return;
      }

      if (!opts.force) {
        // Conservative: refuse if a healthy stack reports
        // setupState=ready (i.e. it has data the operator might lose).
        const inst2 = this.resolveInstanceForProfile();
        const baseUrl = resolveServerBaseUrl(profile, inst2);
        let probeBody: string | undefined;
        try {
          const probeRes = await this.deps.fetch(`${baseUrl}/api/setup/status`);
          if (probeRes.ok) probeBody = await probeRes.text();
        } catch {
          // Server unreachable — proceed with restore.
        }
        if (probeBody && /"setupState"\s*:\s*"ready"/.test(probeBody)) {
          throw new Error(
            "restore refused: stack is healthy and setupState=ready. Re-run with --force to overwrite.",
          );
        }
      }

      const projectName = composeProjectName(profile);
      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const volumesOverlayPath = this.existingVolumesOverlayPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
      const stopArgs = ["--project-name", projectName, "-f", baseYml];
      if (composeEnvPath) stopArgs.push("--env-file", composeEnvPath);
      if (volumesOverlayPath) stopArgs.push("-f", volumesOverlayPath);
      if (caddyOverlayPath) stopArgs.push("-f", caddyOverlayPath);
      stopArgs.push("stop", "nautilo-server");
      await this.runCompose(stopArgs, { stdio: "inherit" });
      const envFileFlag = composeEnvPath ? `--env-file ${composeEnvPath} ` : "";
      const volumesFlag = volumesOverlayPath ? `-f ${volumesOverlayPath} ` : "";
      const caddyFlag = caddyOverlayPath ? `-f ${caddyOverlayPath} ` : "";
      const dockerEnv = dockerEnvForProfile(profile);
      // D420 3.1.1 / R9A — validate the compressed SQL dump before piping it
      // into the DB, and run the restore as a fail-closed pipeline: a gunzip
      // failure cannot be masked by psql exiting 0 on empty/partial input, and
      // `psql -v ON_ERROR_STOP=1` aborts on the first SQL error. The previous
      // form ignored the pipeline's exit status entirely, so a failed legacy
      // restore was reported successful and the server restarted on a partial
      // DB. The exit status is now checked so restore fails closed.
      const validateCmd = validateRestoreDumpScript(opts.fromPath);
      this.deps.log(`restore:   $ ${validateCmd}`);
      const validateRes = await this.deps.localExec("sh", ["-c", validateCmd], {
        stdio: "inherit",
        ...dockerEnv,
      });
      if (validateRes.code !== 0) {
        throw new Error(
          `restore: legacy SQL dump validation failed (exit ${validateRes.code}): ${validateRes.stderr.trim()}`,
        );
      }
      const psqlPrefix =
        `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ` +
        `--project-name ${projectName} -f ${baseYml} ${volumesFlag}${caddyFlag}${envFileFlag}` +
        `exec -T app-postgres psql -U postgres nautilo`;
      const restoreCmd = failClosedRestoreScript(opts.fromPath, psqlPrefix);
      this.deps.log(`restore:   $ ${restoreCmd}`);
      const restoreRes = await this.deps.localExec("sh", ["-c", restoreCmd], {
        stdio: "inherit",
        ...dockerEnv,
      });
      if (restoreRes.code !== 0) {
        throw new Error(
          `restore: legacy SQL restore failed (exit ${restoreRes.code}): ${restoreRes.stderr.trim()}`,
        );
      }
      const legacyRepairPrefix =
        `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")} ` +
        `--project-name ${projectName} -f ${baseYml} ${volumesFlag}${caddyFlag}${envFileFlag}` +
        `exec -T app-postgres `;
      await this.repairAppDbOwnership(
        { transport: "staged_compose", execPrefix: legacyRepairPrefix },
        this.deps.localExec,
      );
      const startArgs = ["--project-name", projectName, "-f", baseYml];
      if (composeEnvPath) startArgs.push("--env-file", composeEnvPath);
      if (volumesOverlayPath) startArgs.push("-f", volumesOverlayPath);
      if (caddyOverlayPath) startArgs.push("-f", caddyOverlayPath);
      startArgs.push("start", "nautilo-server");
      await this.runCompose(startArgs, { stdio: "inherit" });
    } finally {
      restoreEnv();
    }
  }

  async destroy(
    profile: ComposeDriverProfile,
    opts: DestroyOptions,
  ): Promise<void> {
    gates(profile);
    const restoreEnv = this.setInstanceEnv(profile);
    try {
      const projectName = composeProjectName(profile);
      const baseYml = join(this.deps.templateDir, "docker-compose.yml");
      // M116 — the compose YAML's `${VAR:?...}` interpolations are
      // evaluated even on `down`, so --env-file is required if a
      // previous deploy left a deploy.compose.env on disk.
      // Without it, `compose down` fails with "required variable
      // NAUTILO_DB_PASSWORD is missing a value". Also defends against
      // the auto-loaded `templates/.env` shadowing `--project-name`
      // via `name: ${COMPOSE_PROJECT_NAME:-...}` in the YAML.
      const composeEnvPath = this.existingComposeEnvPath(profile);
      const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
      const args = ["--project-name", projectName, "-f", baseYml];
      if (composeEnvPath) args.push("--env-file", composeEnvPath);
      if (caddyOverlayPath) args.push("-f", caddyOverlayPath);
      args.push("--profile", "auth", "--profile", "app", "--profile", "office", "down");
      const keepCerts = opts.hard && opts.keepCerts === true;
      if (opts.hard && !keepCerts) {
        args.push("-v");
      }
      await this.runCompose(args, { stdio: "inherit" });

      if (keepCerts) {
        // Explicit per-volume cleanup of DB + persistent byte volumes, preserving caddy_data
        // and caddy_config (LE cert lives in caddy_data).
        const dataVolumes = [
          `${projectName}_app_pgdata`,
          `${projectName}_logto_pgdata`,
          `${projectName}_app_artifacts`,
          `${projectName}_app_media`,
          `${projectName}_app_apps`,
        ];
        for (const vol of dataVolumes) {
          // Use docker volume rm via the configured exec; tolerate
          // "volume not found" so re-runs are idempotent.
          const res = await this.deps.exec(this.deps.composeBin, ["volume", "rm", "-f", vol], {
            ...dockerEnvForProfile(profile),
            stdio: "pipe",
          });
          if (res.code !== 0 && !/no such volume|not found/i.test(res.stderr)) {
            this.deps.log(`destroy: warning: docker volume rm ${vol} failed (exit ${res.code}): ${res.stderr.trim()}`);
          }
        }
        this.deps.log(`destroy: --keep-certs preserved caddy_data + caddy_config`);
      }

      if (opts.hard) {
        const instanceRootDir = this.deps.resolveInstanceRootDir(profile);
        const bootstrapDir = join(instanceRootDir, ".bootstrap");
        await this.deps.fs.rm(bootstrapDir, { recursive: true, force: true });

        // Operator-side state also needs a wipe so the next deploy
        // re-runs provider consumption from the operator's frozen deploy
        // plan. Without this, `instance.json` still carries
        // `deployConfigConsumedAt` from the previous run and
        // provider-consumed sentinel and silently skips the provider apply.
        // Owner creation is handled independently after health. For local
        // profiles this is a no-op (operator root == instance root).
        const operatorRoot = this.deps.resolveLocalInstanceRootDir(profile);
        if (operatorRoot !== instanceRootDir) {
          await nodeFs.rm(join(operatorRoot, ".bootstrap"), {
            recursive: true,
            force: true,
          });
        }
        try {
          const instanceJsonPath = join(operatorRoot, "instance.json");
          const raw = await nodeFs.readFile(instanceJsonPath, "utf8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if ("deployConfigConsumedAt" in parsed) {
            delete parsed["deployConfigConsumedAt"];
            await nodeFs.writeFile(
              instanceJsonPath,
              JSON.stringify(parsed, null, 2),
              { mode: 0o600 },
            );
          }
        } catch {
          // instance.json may not exist or may be malformed; either way
          // a fresh deploy will write a clean one. Silent is correct.
        }
      }
    } finally {
      restoreEnv();
    }
  }

  /** Read-only exact-project absence proof used after hard destroy. */
  async inspectCleanup(
    profile: ComposeDriverProfile,
    keepCerts = false,
  ): Promise<ComposeCleanupObservation> {
    gates(profile);
    const projectName = composeProjectName(profile);
    const dockerEnv = dockerEnvForProfile(profile);
    const query = async (args: string[]): Promise<string[]> => {
      const result = await this.deps.exec(this.deps.composeBin, args, {
        ...dockerEnv,
        stdio: "pipe",
      });
      if (result.code !== 0) {
        throw new Error(`destroy cleanup verification failed (exit ${result.code})`);
      }
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    };
    const label = `label=com.docker.compose.project=${projectName}`;
    const [containers, networks, volumes] = await Promise.all([
      query(["ps", "-aq", "--filter", label]),
      query(["network", "ls", "-q", "--filter", label]),
      query(["volume", "ls", "-q", "--filter", label]),
    ]);
    const allowed = new Set(
      keepCerts
        ? [`${projectName}_caddy_data`, `${projectName}_caddy_config`]
        : [],
    );
    return {
      containersAbsent: containers.length === 0,
      networksAbsent: networks.length === 0,
      dataVolumesAbsent: volumes.every((volume) => allowed.has(volume)),
      preservedCertificateVolumes: volumes.filter((volume) => allowed.has(volume)),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * M215 — inspect the project-labelled nautilo-server container and refuse
   * topology mutation when runtime DB URLs still route through db.localtest.me
   * or the retired Neon proxy. Fresh deploys (no running server) pass through.
   */
  private async assertDirectTransportBaseline(
    profile: ComposeDriverProfile,
    projectName: string,
  ): Promise<void> {
    const script = buildDirectTransportBaselineInspectScript(projectName);
    const execOpts = { stdio: "pipe" as const, ...dockerEnvForProfile(profile) };
    const result =
      profile.transport === "remote"
        ? await this.execWithoutDockerHost("sh", ["-lc", script], execOpts)
        : await this.deps.exec("sh", ["-lc", script], execOpts);
    if (result.code === 0) return;
    if (result.code === DIRECT_TRANSPORT_BASELINE_EXIT) {
      const detail = result.stderr.trim() || DIRECT_TRANSPORT_BASELINE_REFUSAL;
      throw new Error(detail);
    }
    throw new Error(
      `direct-transport baseline preflight failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }

  /**
   * M215 — authoritative Compose project label for server-only upgrade
   * preflight. Local profiles use {@link composeProjectName}; remote registry
   * profiles use the persisted deployment manifest (not the profile-derived
   * default).
   */
  private async resolveServerOnlyUpgradeProjectName(
    profile: ComposeDriverProfile,
  ): Promise<string> {
    if (usesRemoteRegistryMode(profile)) {
      const manifest = await this.readRemoteDeploymentManifest(profile);
      return manifest.composeProjectName;
    }
    return composeProjectName(profile);
  }

  /**
   * M215 — read-only server-only preflight. Refuses before stop/backup/mutation
   * when project-labelled retired topology containers remain.
   */
  private async assertRetiredTopologyAbsentForServerOnlyUpgrade(
    profile: ComposeDriverProfile,
    projectName: string,
  ): Promise<void> {
    const script = buildRetiredTopologyPresenceInspectScript(projectName);
    const result = await this.runRetiredTopologyPresenceScript(profile, script);
    if (result.code === 0) return;
    if (result.code === RETIRED_TOPOLOGY_PRESENCE_EXIT) {
      const detail = result.stderr.trim() || RETIRED_TOPOLOGY_PRESENCE_REFUSAL;
      throw new Error(detail);
    }
    throw new Error(
      `retired-topology presence preflight failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }

  /**
   * M215 — read-only boolean query for project-labelled retired topology
   * containers (stopped or running). Shares exact label filters and remote
   * routing with the server-only refusal preflight.
   */
  private async hasRetiredTopologyContainers(
    profile: ComposeDriverProfile,
    projectName: string,
  ): Promise<boolean> {
    const script = buildRetiredTopologyPresenceQueryScript(projectName);
    const result = await this.runRetiredTopologyPresenceScript(profile, script);
    if (result.code === RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT) return true;
    if (result.code === RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT) return false;
    throw new Error(
      `retired-topology presence query failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }

  /**
   * M215 — after public health, run full runtime acceptance and scoped cleanup
   * only when retired topology containers remain. Never cleanup before acceptance.
   */
  private async acceptAndCleanupRetiredTopologyIfPresent(
    profile: ComposeDriverProfile,
    projectName: string,
  ): Promise<void> {
    if (!(await this.hasRetiredTopologyContainers(profile, projectName))) {
      return;
    }
    this.deps.log(
      "deploy: running full runtime acceptance before retired-topology cleanup...",
    );
    await this.checkServerHealth(profile);
    await this.removeRetiredTopologyContainers(profile, projectName);
  }

  private async runRetiredTopologyPresenceScript(
    profile: ComposeDriverProfile,
    script: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const execOpts = { stdio: "pipe" as const, ...dockerEnvForProfile(profile) };
    return profile.transport === "remote"
      ? await this.execWithoutDockerHost("sh", ["-lc", script], execOpts)
      : await this.deps.exec("sh", ["-lc", script], execOpts);
  }

  /**
   * M215 — sync the current M215-capable Compose template to the remote root
   * before day-two compose mutations so cleanup removes stale containers only
   * after the direct topology is rendered from the updated template.
   */
  private async materializeRemoteDayTwoComposeTemplate(
    manifest: RemoteDeploymentManifest,
  ): Promise<void> {
    await this.writeRemoteFiles(manifest.remoteRoot, [
      {
        relative: "docker-compose.yml",
        contents: await nodeFs.readFile(
          join(this.deps.templateDir, "docker-compose.yml"),
          "utf8",
        ),
        mode: 0o644,
      },
    ]);
  }

  /**
   * M215 — after the direct topology is healthy, stop/remove ONLY containers
   * labelled with both the validated Compose project and a retired service
   * (`neon-proxy`, `db-host`). Never touches volumes or unrelated projects.
   */
  private async removeRetiredTopologyContainers(
    profile: ComposeDriverProfile,
    projectName: string,
  ): Promise<void> {
    const script = buildRetiredTopologyCleanupScript(projectName);
    const execOpts = { stdio: "pipe" as const, ...dockerEnvForProfile(profile) };
    const result =
      profile.transport === "remote"
        ? await this.execWithoutDockerHost("sh", ["-lc", script], execOpts)
        : await this.deps.exec("sh", ["-lc", script], execOpts);
    if (result.code !== 0) {
      throw new Error(
        `retired topology cleanup failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    this.deps.log(
      `deploy: removed retired neon-proxy/db-host containers for compose project '${projectName}' (if any were present)`,
    );
  }

  /**
   * M207 remote bundle restore. Compose mutations are deliberately executed
   * only through the manifest-backed remote command builder. The M139 staged
   * transfer and droplet-local Docker data pipelines remain separate: they
   * move/load backup bytes, but never parse operator-side compose files or use
   * DOCKER_HOST.
   */
  private async restoreRemoteBundle(
    profile: ComposeDriverProfile,
    opts: RestoreOptions,
    bundle: BackupManifest,
    mode: NonNullable<RestoreOptions["mode"]>,
    bundleIdentity: RestoreInstanceIdentity | undefined,
  ): Promise<void> {
    const deployment = await this.readRemoteDeploymentManifest(profile);
    if (opts.stream === true) {
      throw new Error(
        "restore: remote --stream bundle restore is not M207-safe because its legacy pipeline uses operator-side Docker/Compose. Re-run without --stream for staged SSH-native restore.",
      );
    }
    const restoredImage = resolveRemoteBundleRestoreImage(bundle.image);
    const restoredManifestImage = restoredImage.manifestImage;
    const remoteRegistryImage = restoredImage.pull;
    const restoreImageRef = restoredManifestImage.reference;

    const remoteRoot = deployment.remoteRoot;
    const shouldLoadData = mode === "full" || mode === "data-only";
    await this.ensureRemoteCanonicalConfigLayout(remoteRoot);
    const projectName = deployment.composeProjectName;
    const stamp = backupTimestamp(this.deps.now());
    const stageDir = posix.join(remoteRoot, `.restore-staging-${stamp}`);
    const localRoot = this.deps.resolveLocalInstanceRootDir(profile);
    await ensureCanonicalConfigLayout(localRoot);
    let composeTemplate = await nodeFs.readFile(
      join(this.deps.templateDir, "docker-compose.yml"),
      "utf8",
    );
    if (mode === "full" && bundle.contents.composeTemplate) {
      try {
        composeTemplate = await nodeFs.readFile(
          join(opts.fromPath, "docker-compose.yml"),
          "utf8",
        );
      } catch {
        throw new Error(
          "restore: bundle declares a captured compose template but docker-compose.yml is missing or unreadable",
        );
      }
    }
    const files: Array<{ relative: string; contents: string; mode: number }> = [
      {
        relative: "docker-compose.yml",
        contents: composeTemplate,
        mode: 0o644,
      },
      {
        relative: "postgres-init.sh",
        contents: await nodeFs.readFile(
          join(this.deps.templateDir, "..", "..", "..", "infra", "postgres-init.sh"),
          "utf8",
        ),
        mode: 0o755,
      },
      {
        relative: "deploy.volumes-overlay.yml",
        contents: remoteVolumesOverlayYaml(remoteRoot),
        mode: 0o600,
      },
    ];

    let restoreOverlay = false;
    if (mode === "full") {
      const operatorTargets: Array<{ src: string; dest: string }> = [
        {
          src: join(opts.fromPath, "operator", "profiles", `${profile.name}.toml`),
          dest: join(operatorHome(), ".nautilo", "profiles", `${profile.name}.toml`),
        },
        {
          src: join(opts.fromPath, "operator", "bootstrap-tokens", profile.name),
          dest: join(operatorHome(), ".nautilo", "bootstrap-tokens", profile.name),
        },
        {
          src: join(opts.fromPath, "operator", "instance.json"),
          dest: join(localRoot, "instance.json"),
        },
      ];
      for (const file of operatorTargets) {
        if (existsSync(file.dest) || !existsSync(file.src)) continue;
        await nodeFs.mkdir(join(file.dest, ".."), { recursive: true });
        await nodeFs.copyFile(file.src, file.dest);
      }

      let instanceEnv = "";
      if (bundle.contents.instanceEnv && existsSync(join(opts.fromPath, "instance.env"))) {
        instanceEnv = await nodeFs.readFile(join(opts.fromPath, "instance.env"), "utf8");
        const remoteComposeEnvPath = posix.join(
          remoteRoot,
          "deploy.compose.env",
        );
        const currentComposeEnvResult = await this.execWithoutDockerHost(
          "cat",
          [remoteComposeEnvPath],
          { stdio: "pipe" },
        );
        const currentComposeEnv =
          currentComposeEnvResult.code === 0
            ? currentComposeEnvResult.stdout
            : "";
        const currentCryptoPassword =
          parseDotenv(currentComposeEnv)["NAUTILO_CRYPTO_DB_PASSWORD"];
        const restoredCrypto = ensureCryptoPasswordInDotenv(
          instanceEnv,
          () =>
            currentCryptoPassword?.trim() ||
            randomBytes(24).toString("hex"),
        );
        instanceEnv = restoredCrypto.raw;
        files.push({
          relative: `${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
          contents: instanceEnv,
          mode: 0o600,
        });
        files.push({
          relative: CRYPTO_DB_PASSWORD_RELATIVE_PATH,
          contents: `${restoredCrypto.secret}\n`,
          mode: 0o600,
        });
        files.push({
          relative: "deploy.compose.env",
          contents: setCryptoPasswordInDotenv(
            currentComposeEnv,
            restoredCrypto.secret,
          ),
          mode: 0o600,
        });
      }

      const restoredLogtoEnv: InstanceLogtoEnv = {};
      const parsedInstanceEnv = parseDotenv(instanceEnv);
      for (const key of [
        "LOGTO_ENDPOINT",
        "LOGTO_ISSUER",
        "LOGTO_JWKS_URI",
        "LOGTO_RESOURCE",
        "LOGTO_WORKBENCH_APP_ID",
        "LOGTO_TUI_APP_ID",
        "LOGTO_TUI_LOOPBACK_APP_ID",
        "LOGTO_DESKTOP_APP_ID",
        "LOGTO_MOBILE_APP_ID",
        "LOGTO_MOBILE_WEB_APP_ID",
        "LOGTO_M2M_APP_ID",
        "LOGTO_M2M_APP_SECRET",
      ] as const) {
        const value = parsedInstanceEnv[key];
        if (value !== undefined) restoredLogtoEnv[key] = value;
      }
      const passwordRecoveryDriver = profile.password_recovery ?? "oss_relay";
      // M207: remote bundle restore must not generate operator-local secrets.
      // The webhook secret stays canonical in the restored remote instance.env;
      // deploy.server.env only carries container-DNS overrides.
      const serverEnv = buildServerOverlayEnv(
        this.resolveInstanceForProfile(),
        restoredLogtoEnv,
        {
          passwordRecoveryDriver,
        },
      );
      files.push(
        {
          relative: "deploy.server.env",
          contents: envFileContents(serverEnv),
          mode: 0o600,
        },
        {
          relative: "deploy.server-overlay.yml",
          contents: serverOverlayYaml(
            posix.join(remoteRoot, "deploy.server.env"),
            posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME, "instance.env"),
          ),
          mode: 0o600,
        },
        {
          relative: "deploy.restore-overlay.yml",
          contents: buildPinnedImageOverlay(restoreImageRef),
          mode: 0o600,
        },
      );
      restoreOverlay = true;
    }

    // The manifest was validated before this first remote write. Do not use
    // RemoteFs here: its staging tree is an operator-side compose input.
    await this.writeRemoteFiles(remoteRoot, files);
    if (mode === "full") {
      await this.ensureRemoteHostCanonicalPushSecrets(remoteRoot);
    }

    if (shouldLoadData) {
      if (mode === "full") {
        await this.runRemoteComposeAtRoot(
          profile,
          remoteRoot,
          projectName,
          deployment.https === "letsencrypt",
          { verb: "up", wait: true, service: "app-postgres" },
          true,
          restoreOverlay,
        );
      }
      const identityPgExec = this.dbExecPrefix({
        staged: true,
        projectName,
        service: "app-postgres",
        composePrefix: `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")}`,
      });
      const targetIdentity = await this.readConnectedRestoreIdentity(
        profile,
        identityPgExec,
        true,
        "target identity preflight",
      );
      assertRestoreIdentityCompatible({
        bundle: bundleIdentity,
        target: targetIdentity,
        manifestInstanceId: bundle.instanceId,
        targetInstanceId: (profile.instance_id ?? "").trim(),
      });
    }

    if (mode === "full") {
      if (remoteRegistryImage) {
        await this.runRemoteComposeAtRoot(
          profile,
          remoteRoot,
          projectName,
          deployment.https === "letsencrypt",
          { verb: "pull", service: "nautilo-server" },
          true,
          restoreOverlay,
        );
      } else {
        this.deps.log(
          `restore: using recorded local source image ${restoreImageRef}; skipping registry pull.`,
        );
      }
      await this.runRemoteComposeAtRoot(
        profile,
        remoteRoot,
        projectName,
        deployment.https === "letsencrypt",
        { verb: "up", wait: true, service: "logto-postgres" },
        true,
        restoreOverlay,
      );
      await this.preflightLogtoPreSeedRecovery({
        transport: "remote_ssh",
        remoteRoot,
        projectName,
        overlays: this.remoteRegistryRepairOverlays(
          deployment.https === "letsencrypt",
          true,
          restoreOverlay,
        ),
        profiles: this.remoteDeployProfiles(profile),
      });
      await this.preflightLogtoTenantPasswordResync({
        transport: "remote_ssh",
        remoteRoot,
        projectName,
        overlays: this.remoteRegistryRepairOverlays(
          deployment.https === "letsencrypt",
          true,
          restoreOverlay,
        ),
        profiles: this.remoteDeployProfiles(profile),
      });
      await this.runRemoteComposeAtRoot(
        profile,
        remoteRoot,
        projectName,
        deployment.https === "letsencrypt",
        { verb: "up", noBuild: true },
        true,
        restoreOverlay,
      );
    }

    const runChecked = async (
      label: string,
      exec: ExecFn,
      cmd: string,
      args: string[],
      execOpts: { stdio: "inherit" | "pipe" },
    ): Promise<void> => {
      this.deps.log(`restore: → ${label}: ${cmd} ${args.join(" ")}`);
      const result = await exec(cmd, args, execOpts);
      if (result.code !== 0) {
        throw new Error(
          `restore: ${label} failed (exit ${result.code}): ${result.stderr.trim()}`,
        );
      }
    };
    const runPipeline = async (label: string, command: string): Promise<void> => {
      this.deps.log(`restore:   $ ${command}`);
      await runChecked(label, this.deps.exec, "sh", ["-c", command], {
        stdio: "pipe",
      });
    };

    if (profile.ssh === undefined) {
      throw new Error("restore: remote staged restore requires profile.ssh.");
    }
    await runChecked(
      "remote staging mkdir",
      this.deps.exec,
      "mkdir",
      ["-p", stageDir],
      { stdio: "pipe" },
    );
    await runChecked(
      "rsync bundle to remote staging",
      this.deps.localExec,
      "rsync",
      [
        ...(await this.rsyncResumeArgs()),
        "-e",
        sshRsyncSpec(profile),
        opts.fromPath.replace(/\/$/, "") + "/",
        `${profile.ssh.user}@${profile.ssh.host}:${stageDir}/`,
      ],
      { stdio: "inherit" },
    );

    await this.runRemoteComposeAtRoot(
      profile,
      remoteRoot,
      projectName,
      deployment.https === "letsencrypt",
      { verb: "stop", service: "nautilo-server" },
      true,
      restoreOverlay,
    );

    const composePrefix = `${this.deps.composeBin} ${this.deps.composeArgs.join(" ")}`;
    const appPgExec = this.dbExecPrefix({
      staged: true,
      projectName,
      service: "app-postgres",
      composePrefix,
    });
    const logtoPgExec = this.dbExecPrefix({
      staged: true,
      projectName,
      service: "logto-postgres",
      composePrefix,
    });
    const shouldLoadArtifacts = mode === "full" || mode === "artifacts-only";

    // D420 3.1.1 / R9A — validate EVERY required compressed DB dump BEFORE any
    // destructive schema reset. A corrupt/truncated gzip must fail before
    // either DB schema is destroyed, so both dumps are gated up front. The
    // dumps already live on the remote staging dir after the rsync above.
    if (shouldLoadData) {
      const requiredDumps: Array<{ label: string; path: string }> = [];
      if (bundle.contents.nautiloDb) {
        requiredDumps.push({
          label: "nautilo DB dump validation",
          path: posix.join(stageDir, "nautilo.sql.gz"),
        });
      }
      if (bundle.contents.logtoDb) {
        requiredDumps.push({
          label: "logto DB dump validation",
          path: posix.join(stageDir, "logto_nautilo.sql.gz"),
        });
      }
      for (const { label, path } of requiredDumps) {
        await runPipeline(label, validateRestoreDumpScript(path));
      }
    }

    if (shouldLoadData && bundle.contents.nautiloDb) {
      await runPipeline(
        "nautilo DB restore",
        atomicDbRestoreScript(
          posix.join(stageDir, "nautilo.sql.gz"),
          `${appPgExec}psql -U postgres -d nautilo`,
          NAUTILO_SCHEMA_RESET_SQL,
        ),
      );
      const restoredIdentity = await this.readConnectedRestoreIdentity(
        profile,
        appPgExec,
        true,
        "restored identity verification",
      );
      assertRestoredIdentity(bundleIdentity, restoredIdentity);
      await this.repairAppDbOwnership(
        { transport: "staged_compose", execPrefix: appPgExec },
        this.deps.exec,
      );
    }

    if (shouldLoadData && bundle.contents.logtoDb) {
      await runPipeline(
        "logto DB restore",
        atomicDbRestoreScript(
          posix.join(stageDir, "logto_nautilo.sql.gz"),
          `${logtoPgExec}psql -U postgres -d logto_nautilo`,
          LOGTO_SCHEMA_RESET_SQL,
        ),
      );
      await runPipeline(
        "logto tenant-role grants",
        `${logtoPgExec}psql -U postgres -d logto_nautilo -c ${shellQuote(LOGTO_TENANT_REGRANT_SQL)}`,
      );
      if (mode === "full") {
        await this.preflightLogtoTenantPasswordResync(
          { transport: "staged_compose", execPrefix: logtoPgExec },
          this.deps.exec,
        );
      }
    }

    // D420 (Wave 3 task 3.3.2) — re-pin app + Logto tenant role passwords
    // before application startup. The remote registry path re-reads the
    // bundle's instance.env from the operator side (the same content
    // written to the remote root above); a bundle without instance.env
    // passes "" and skips the app-role step while still resyncing Logto
    // tenant roles.
    if (shouldLoadData) {
      let remoteInstanceEnvRaw = "";
      if (
        bundle.contents.instanceEnv &&
        existsSync(join(opts.fromPath, "instance.env"))
      ) {
        remoteInstanceEnvRaw = await nodeFs.readFile(
          join(opts.fromPath, "instance.env"),
          "utf8",
        );
      }
      await this.reconcileRestoredDbPasswords({
        appPgExec,
        logtoPgExec,
        instanceEnvRaw: remoteInstanceEnvRaw,
        reconcileNautilo: bundle.contents.nautiloDb === true,
        reconcileLogto: bundle.contents.logtoDb === true,
        exec: this.deps.exec,
      });
    }

    const loadVolume = async (
      label: string,
      volumeName: string,
      fileName: string,
    ): Promise<void> => {
      await runPipeline(
        label,
        `${this.deps.composeBin} run --rm -v ${shellQuote(`${volumeName}:/dst`)} -v ${shellQuote(`${stageDir}:/in`)} alpine sh -c ${shellQuote(`rm -rf /dst/* && tar xzf /in/${fileName} -C /dst`)}`,
      );
    };
    if (shouldLoadArtifacts && bundle.contents.artifacts) {
      await loadVolume("artifact volume restore", `${projectName}_app_artifacts`, "artifacts.tgz");
    }
    if (shouldLoadArtifacts && bundle.contents.media) {
      await loadVolume("media volume restore", `${projectName}_app_media`, "media.tgz");
    }
    if (shouldLoadArtifacts && bundle.contents.apps) {
      await loadVolume("apps volume restore", `${projectName}_app_apps`, "apps.tgz");
    }
    if (mode === "full" && bundle.contents.caddyData) {
      await loadVolume("caddy_data volume restore", `${projectName}_caddy_data`, "caddy_data.tgz");
    }
    if (mode === "full" && bundle.contents.caddyConfig) {
      await loadVolume("caddy_config volume restore", `${projectName}_caddy_config`, "caddy_config.tgz");
    }
    if (mode === "full" && bundle.contents.localCaCerts) {
      const certsPath = posix.join(remoteRoot, "certs");
      await runPipeline(
        "local CA certs restore",
        `mkdir -p ${shellQuote(certsPath)} && rm -rf ${shellQuote(certsPath)}/* && tar xzf ${shellQuote(posix.join(stageDir, "certs.tgz"))} -C ${shellQuote(certsPath)}`,
      );
    }

    await this.runRemoteComposeAtRoot(
      profile,
      remoteRoot,
      projectName,
      deployment.https === "letsencrypt",
      { verb: "start", service: "nautilo-server" },
      true,
      restoreOverlay,
    );
    if (mode === "full" || mode === "data-only") {
      await this.pollServerHealthForProfile(
        profile,
        resolveServerBaseUrl(profile, this.resolveInstanceForProfile()),
      );
    }
    if (mode === "full") {
      await this.reconcileRemoteDeploymentManifestFromBundle(
        profile,
        restoredManifestImage,
      );
    }
    await runChecked(
      "remote staging cleanup",
      this.deps.exec,
      "rm",
      ["-rf", stageDir],
      { stdio: "pipe" },
    );
    this.deps.log(`restore: restored ${mode} bundle ${opts.fromPath} into ${projectName}`);
  }

  private execWithoutDockerHost(
    cmd: string,
    args: string[],
    opts: { stdio: "inherit" | "pipe" },
  ): Promise<ExecResult> {
    return this.deps.exec(cmd, args, { stdio: opts.stdio });
  }

  private remoteManifestMissingHint(
    profile: ComposeDriverProfile,
    remoteRoot: string,
  ): string {
    return (
      "No deployment changes were made. " +
      `If this is an existing legacy install, first run \`nautilo adopt --dry-run --profile ${profile.name}\`. ` +
      `Only if ${remoteRoot} is confirmed fresh and empty should you run ` +
      `\`nautilo deploy --profile ${profile.name}\`.`
    );
  }

  private remoteManifestInvalidHint(manifestPath: string): string {
    return (
      "No deployment changes were made. Do not deploy or adopt over this invalid manifest. " +
      `Restore ${manifestPath} from a verified backup, or inspect and repair it manually before retrying.`
    );
  }

  private looksLikeSshFailure(stderr: string): boolean {
    const lower = stderr.toLowerCase();
    return (
      /\bssh\b/.test(lower) ||
      lower.includes("permission denied") ||
      lower.includes("connection refused") ||
      lower.includes("connection timed out") ||
      lower.includes("could not resolve hostname") ||
      lower.includes("host key verification failed") ||
      lower.includes("no route to host")
    );
  }

  private async readRemoteDeploymentManifest(
    profile: ComposeDriverProfile,
  ): Promise<RemoteDeploymentManifest> {
    const remoteRoot = this.deps.resolveInstanceRootDir(profile);
    const manifestPath = join(remoteRoot, "deployment-manifest.json");
    const instanceId = (profile.instance_id ?? "").trim();
    const expectedProjectName = composeProjectName(profile);
    const hint = this.remoteManifestMissingHint(profile, remoteRoot);

    const result = await this.execWithoutDockerHost("cat", [manifestPath], {
      stdio: "pipe",
    });

    if (result.code !== 0) {
      if (this.looksLikeSshFailure(result.stderr)) {
        throw new Error(
          `Remote deployment manifest unavailable: could not read ${manifestPath} over SSH (exit ${result.code}). ${hint}`,
        );
      }
      throw new Error(
        `Remote deployment manifest unavailable: ${manifestPath} is missing or unreadable (exit ${result.code}). ${hint}`,
      );
    }

    const raw = result.stdout.trim();
    if (raw === "") {
      throw new Error(
        `Remote deployment manifest invalid: ${manifestPath} is empty. ${this.remoteManifestInvalidHint(manifestPath)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Remote deployment manifest invalid: ${manifestPath} is not valid JSON. ${this.remoteManifestInvalidHint(manifestPath)}`,
      );
    }

    const validated = remoteDeploymentManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Remote deployment manifest invalid: ${manifestPath} failed schema validation. ${this.remoteManifestInvalidHint(manifestPath)}`,
      );
    }

    assertRemoteDeploymentManifestIdentity(validated.data, {
      instanceId,
      composeProjectName: expectedProjectName,
      remoteRoot,
    });

    return validated.data;
  }

  /**
   * Remote registry deployments have two deliberately separate paths:
   *
   * - an existing, validated manifest is a day-two operation and must remain
   *   entirely on the remote host;
   * - a missing manifest is either a fresh install or an adoption boundary.
   *
   * In particular, do not let a missing manifest fall through to the old
   * staged/DOCKER_HOST path: that path can overwrite a manually managed
   * remote root before the operator has explicitly adopted it.
   */
  private async deployRemoteRegistry(
    profile: ComposeDriverProfile,
    opts?: { allowArtifactLoss?: boolean },
  ): Promise<void> {
    const remoteRoot = this.deps.resolveInstanceRootDir(profile);
    const manifestPath = posix.join(remoteRoot, "deployment-manifest.json");
    const manifestResult = await this.execWithoutDockerHost("cat", [manifestPath], {
      stdio: "pipe",
    });

    if (manifestResult.code === 0) {
      const manifest = this.parseAndAssertRemoteDeploymentManifest(
        profile,
        remoteRoot,
        manifestPath,
        manifestResult.stdout,
      );
      await this.deployRemoteRegistryDayTwo(profile, manifest, opts);
      return;
    }

    if (this.looksLikeSshFailure(manifestResult.stderr)) {
      throw new Error(
        `Remote SSH connection failed while reading ${manifestPath} (exit ${manifestResult.code}). Check SSH connectivity and credentials for profile '${profile.name}'.`,
      );
    }

    const state = await this.inspectRemoteRegistryInstallState(profile, remoteRoot);
    if (state !== "fresh") {
      throw new Error(
        `Remote registry deployment requires explicit adoption: ${remoteRoot} already contains Nautilo configuration or project/container state. No files were changed. Adopt or remove the existing remote deployment before retrying profile '${profile.name}'.`,
      );
    }

    await this.deployRemoteRegistryFirstInstall(profile, remoteRoot);
  }

  private parseAndAssertRemoteDeploymentManifest(
    profile: ComposeDriverProfile,
    remoteRoot: string,
    manifestPath: string,
    rawValue: string,
  ): RemoteDeploymentManifest {
    const raw = rawValue.trim();
    if (raw === "") {
      throw new Error(
        `Remote deployment manifest invalid: ${manifestPath} is empty. Re-deploy the instance or fix the file on the remote host.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Remote deployment manifest invalid: ${manifestPath} is not valid JSON. Re-deploy the instance or fix the file on the remote host.`,
      );
    }

    const validated = remoteDeploymentManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Remote deployment manifest invalid: ${manifestPath} failed schema validation. Re-deploy the instance or fix the file on the remote host.`,
      );
    }
    assertRemoteDeploymentManifestIdentity(validated.data, {
      instanceId: (profile.instance_id ?? "").trim(),
      composeProjectName: composeProjectName(profile),
      remoteRoot,
    });
    return validated.data;
  }

  /**
   * Read-only remote inspection used only when the manifest is absent. The
   * command intentionally treats an unreadable manifest, a nonempty root, or
   * any compose-labelled/container state as adoption-required. A Docker
   * inspection failure is also refused rather than guessed to be fresh.
   */
  private async inspectRemoteRegistryInstallState(
    profile: ComposeDriverProfile,
    remoteRoot: string,
  ): Promise<"fresh" | "existing"> {
    const projectName = composeProjectName(profile);
    const script = [
      "set -eu",
      `root=${shellQuote(remoteRoot)}`,
      `project=${shellQuote(projectName)}`,
      'if [ -e "$root" ] && [ ! -d "$root" ]; then printf %s existing; exit 0; fi',
      'if [ -d "$root" ] && [ -n "$(ls -A -- "$root" 2>/dev/null)" ]; then printf %s existing; exit 0; fi',
      'if ! ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"; then exit 73; fi',
      'if [ -n "$ids" ]; then printf %s existing; exit 0; fi',
      'if docker volume inspect "${project}_app_artifacts" >/dev/null 2>&1; then printf %s existing; exit 0; fi',
      'if docker volume inspect "${project}_app_media" >/dev/null 2>&1; then printf %s existing; exit 0; fi',
      "printf %s fresh",
    ].join("; ");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      if (this.looksLikeSshFailure(result.stderr)) {
        throw new Error(
          `Remote SSH connection failed while inspecting ${remoteRoot} (exit ${result.code}). Check SSH connectivity and credentials for profile '${profile.name}'.`,
        );
      }
      throw new Error(
        `Remote Docker inspection failed while checking ${remoteRoot} (exit ${result.code}). Refusing to treat the host as a fresh install.`,
      );
    }
    return result.stdout.trim() === "fresh" ? "fresh" : "existing";
  }

  private async deployRemoteRegistryDayTwo(
    profile: ComposeDriverProfile,
    manifest: RemoteDeploymentManifest,
    opts?: { allowArtifactLoss?: boolean },
  ): Promise<void> {
    const requestedRef = registryImageRef(profile);
    const imageChanged = requestedRef !== manifest.image.reference;

    this.deps.log(
      "deploy: verifying M212 direct-transport baseline on existing remote stack...",
    );
    await this.assertDirectTransportBaseline(profile, manifest.composeProjectName);

    // M231 legacy preflight must complete before Docker Compose parses the
    // newly required app-postgres credential.
    await this.preflightRemoteCryptoCredential(manifest.remoteRoot);

    await this.assertRemoteArtifactVolumePresentOrMigrated(
      profile,
      manifest.composeProjectName,
      opts,
    );

    await this.ensureRemoteCanonicalConfigLayout(manifest.remoteRoot);
    await this.materializeRemoteDayTwoComposeTemplate(manifest);
    if (manifest.image.mode === "source") {
      await this.materializeHostCanonicalRemoteComposeInputs(profile, manifest);
    } else {
      await this.materializeLegacyAdoptedRemoteComposeBootstrap(profile, manifest);
    }
    await this.ensureRemoteHostCanonicalPushSecrets(manifest.remoteRoot);

    if (imageChanged) {
      await this.pullRemoteImageDirect(requestedRef);
      await this.writeRemoteFiles(manifest.remoteRoot, [
        {
          relative: "deploy.registry-overlay.yml",
          contents: buildPinnedImageOverlay(requestedRef),
          mode: 0o600,
        },
      ]);
      await this.runRemoteComposeAtRoot(
        profile,
        manifest.remoteRoot,
        manifest.composeProjectName,
        manifest.https === "letsencrypt",
        { verb: "up", wait: true, service: "app-postgres" },
      );
    } else {
      await this.runRemoteComposeAtRoot(
        profile,
        manifest.remoteRoot,
        manifest.composeProjectName,
        manifest.https === "letsencrypt",
        { verb: "pull", service: "nautilo-server" },
      );
      await this.runRemoteComposeAtRoot(
        profile,
        manifest.remoteRoot,
        manifest.composeProjectName,
        manifest.https === "letsencrypt",
        { verb: "up", wait: true, service: "app-postgres" },
      );
    }

    await this.repairAppDbOwnership({
      transport: "remote_ssh",
      remoteRoot: manifest.remoteRoot,
      projectName: manifest.composeProjectName,
      overlays: this.remoteRegistryRepairOverlays(
        manifest.https === "letsencrypt",
        true,
      ),
      profiles: this.remoteDeployProfiles(profile),
    });

    await this.runRemoteComposeAtRoot(
      profile,
      manifest.remoteRoot,
      manifest.composeProjectName,
      manifest.https === "letsencrypt",
      { verb: "up", wait: true, service: "logto-postgres" },
    );
    await this.preflightLogtoPreSeedRecovery({
      transport: "remote_ssh",
      remoteRoot: manifest.remoteRoot,
      projectName: manifest.composeProjectName,
      overlays: this.remoteRegistryRepairOverlays(
        manifest.https === "letsencrypt",
        true,
      ),
      profiles: this.remoteDeployProfiles(profile),
    });
    await this.preflightLogtoTenantPasswordResync({
      transport: "remote_ssh",
      remoteRoot: manifest.remoteRoot,
      projectName: manifest.composeProjectName,
      overlays: this.remoteRegistryRepairOverlays(
        manifest.https === "letsencrypt",
        true,
      ),
      profiles: this.remoteDeployProfiles(profile),
    });

    await this.runRemoteComposeAtRoot(
      profile,
      manifest.remoteRoot,
      manifest.composeProjectName,
      manifest.https === "letsencrypt",
      { verb: "up" },
    );

    await this.recreateLogtoCoreAfterAuthUp({
      transport: "remote_ssh",
      remoteRoot: manifest.remoteRoot,
      projectName: manifest.composeProjectName,
      overlays: this.remoteRegistryRepairOverlays(
        manifest.https === "letsencrypt",
        true,
      ),
      profiles: this.remoteDeployProfiles(profile),
    });

    // Logto's container listener is instance-specific and may change when the
    // day-two Compose inputs are reconciled. Any server overlay materialized
    // before that reconciliation describes the old listener. Re-read the
    // running auth topology only after Logto has reached its final port, then
    // recreate just the API so JWT verification cannot retain a stale JWKS
    // endpoint (for example logto:4001 after Logto moved to logto:5901).
    await this.refreshHostCanonicalRemoteServerOverlay(profile, manifest);
    await this.runRemoteComposeAtRoot(
      profile,
      manifest.remoteRoot,
      manifest.composeProjectName,
      manifest.https === "letsencrypt",
      {
        verb: "up",
        service: "nautilo-server",
        noDeps: true,
        forceRecreate: true,
      },
    );

    const hasRetiredTopology = await this.hasRetiredTopologyContainers(
      profile,
      manifest.composeProjectName,
    );
    try {
      if (hasRetiredTopology) {
        await this.checkServerHealth(profile);
      } else {
        await this.pollServerHealthForProfile(
          profile,
          resolveServerBaseUrl(profile, this.resolveInstanceForProfile()),
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Remote runtime acceptance failed after compose update: ${detail}`);
    }
    if (hasRetiredTopology) {
      await this.removeRetiredTopologyContainers(profile, manifest.composeProjectName);
    }

    await this.commitRemoteDeploymentManifestArtifact(profile, {
      mode: "registry",
      requested: requestedRef,
      immutableId: requestedRef,
    });
  }

  /**
   * Atomically upgrades an existing SSH-native deployment's five-password
   * config before any Compose interpolation. The role-only file is the
   * durable authority; deploy.compose.env is only its Postgres-facing
   * projection, and server-mounted instance.env is sanitized.
   */
  private async preflightRemoteCryptoCredential(
    remoteRoot: string,
  ): Promise<void> {
    const composeEnvPath = posix.join(remoteRoot, "deploy.compose.env");
    const instanceEnvPath = posix.join(
      remoteRoot,
      RUNTIME_CONFIG_DIR_NAME,
      "instance.env",
    );
    const secretPath = posix.join(
      remoteRoot,
      CRYPTO_DB_PASSWORD_RELATIVE_PATH,
    );
    const script = [
      "set -eu",
      "umask 077",
      "# M231 role-only crypto credential preflight",
      `compose_env=${shellQuote(composeEnvPath)}`,
      `instance_env=${shellQuote(instanceEnvPath)}`,
      `secret_file=${shellQuote(secretPath)}`,
      'test -s "$compose_env"',
      'mkdir -p "$(dirname "$secret_file")"',
      'secret=""',
      'if test -s "$secret_file"; then secret="$(tr -d \'\\r\\n\' < "$secret_file")"; fi',
      'if test -z "$secret"; then secret="$(sed -n \'s/^NAUTILO_CRYPTO_DB_PASSWORD=//p\' "$compose_env" | tail -n 1)"; fi',
      'if test -z "$secret" && test -f "$instance_env"; then secret="$(sed -n \'s/^NAUTILO_CRYPTO_DB_PASSWORD=//p\' "$instance_env" | tail -n 1)"; fi',
      'if test -z "$secret"; then secret="$(od -An -N24 -tx1 /dev/urandom | tr -d \' \\n\')"; fi',
      'test -n "$secret"',
      'printf \'%s\\n\' "$secret" > "$secret_file.tmp"',
      'chmod 600 "$secret_file.tmp"',
      'mv "$secret_file.tmp" "$secret_file"',
      'awk -F= \'$1 != "NAUTILO_CRYPTO_DB_PASSWORD"\' "$compose_env" > "$compose_env.tmp"',
      'printf \'NAUTILO_CRYPTO_DB_PASSWORD=%s\\n\' "$secret" >> "$compose_env.tmp"',
      'chmod 600 "$compose_env.tmp"',
      'mv "$compose_env.tmp" "$compose_env"',
      'if test -f "$instance_env"; then awk -F= \'$1 != "NAUTILO_CRYPTO_DB_PASSWORD"\' "$instance_env" > "$instance_env.tmp"; chmod 600 "$instance_env.tmp"; mv "$instance_env.tmp" "$instance_env"; fi',
    ].join("\n");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      throw new Error(
        `M231 crypto credential preflight refused for ${remoteRoot} (exit ${result.code}); credential values were redacted`,
      );
    }
  }

  private async preflightLocalCryptoCredential(
    profile: ComposeDriverProfile,
  ): Promise<void> {
    const composeEnvPath = this.existingComposeEnvPath(profile);
    if (composeEnvPath === undefined) return;
    const inst = this.resolveInstanceForProfile();
    const instanceRootDir = this.deps.resolveLocalInstanceRootDir(profile);
    await ensureCanonicalConfigLayout(instanceRootDir);
    const passwords = await this.deps.ensureDbPasswords({
      instanceRootDir,
      composeProjectName: composeProjectName(profile),
      appPostgresHostPort: inst.db.postgresHostPort,
    });
    const current = await nodeFs.readFile(composeEnvPath, "utf8");
    await nodeFs.writeFile(
      composeEnvPath,
      setCryptoPasswordInDotenv(current, passwords.nautiloCrypto),
      { mode: 0o600 },
    );
  }

  private async updateLegacyBootstrapPhase(
    manifest: RemoteDeploymentManifest,
    phase: NonNullable<
      Extract<RemoteDeploymentManifest, { version: 2 }>["contracts"]["legacyBootstrap"]
    >["phase"],
    imageReference: string,
  ): Promise<void> {
    if (manifest.version !== 2 || manifest.contracts.legacyAdopted !== true) return;
    const updated = {
      ...manifest,
      updatedAt: this.deps.now().toISOString(),
      contracts: {
        ...manifest.contracts,
        legacyBootstrap: {
          phase,
          imageReference,
          updatedAt: this.deps.now().toISOString(),
        },
      },
    };
    await this.writeRemoteFiles(manifest.remoteRoot, [
      {
        relative: "deployment-manifest.json",
        contents: JSON.stringify(updated, null, 2) + "\n",
        mode: 0o600,
      },
    ]);
    this.deps.log(`bootstrap legacy: completed ${phase}`);
  }

  /**
   * Legacy source installs used the operator-side template through DOCKER_HOST,
   * so their otherwise-valid remote root intentionally has no base compose
   * file or post-bootstrap server overlay. `adopt --confirm` records that
   * provenance without mutating the running deployment. Once a validated
   * adopted manifest enters the SSH-native registry path, materialize the
   * missing canonical inputs before any remote compose command. The remaining
   * root-owned compose env, volumes overlay, and bind-mount files are the
   * existing legacy deployment state. The server overlay directly requires
   * instance.env, so publish its canonical operator-side copy fail-closed.
   */
  private async materializeLegacyAdoptedRemoteComposeBootstrap(
    profile: ComposeDriverProfile,
    manifest: RemoteDeploymentManifest,
  ): Promise<void> {
    if (manifest.version !== 2 || manifest.contracts.legacyAdopted !== true) {
      return;
    }
    await this.materializeHostCanonicalRemoteComposeInputs(profile, manifest);
  }

  /**
   * Materialize SSH-native compose inputs from the remote host's canonical
   * instance.env. Used for any remote source→registry transition and does not
   * read operator-side staging state.
   */
  private async materializeHostCanonicalRemoteComposeInputs(
    profile: ComposeDriverProfile,
    manifest: RemoteDeploymentManifest,
  ): Promise<void> {
    const remoteRoot = manifest.remoteRoot;
    const serverOverlayFiles = await this.buildHostCanonicalRemoteServerOverlayFiles(
      profile,
      manifest,
    );
    await this.writeRemoteFiles(remoteRoot, [
      {
        relative: "postgres-init.sh",
        contents: await nodeFs.readFile(
          join(this.deps.templateDir, "..", "..", "..", "infra", "postgres-init.sh"),
          "utf8",
        ),
        mode: 0o755,
      },
      {
        relative: "deploy.volumes-overlay.yml",
        contents: remoteVolumesOverlayYaml(remoteRoot),
        mode: 0o600,
      },
      {
        relative: "docker-compose.yml",
        contents: await nodeFs.readFile(
          join(this.deps.templateDir, "docker-compose.yml"),
          "utf8",
        ),
        mode: 0o644,
      },
      ...serverOverlayFiles,
    ]);
  }

  private async refreshHostCanonicalRemoteServerOverlay(
    profile: ComposeDriverProfile,
    manifest: RemoteDeploymentManifest,
  ): Promise<void> {
    await this.writeRemoteFiles(
      manifest.remoteRoot,
      await this.buildHostCanonicalRemoteServerOverlayFiles(profile, manifest),
    );
  }

  private async buildHostCanonicalRemoteServerOverlayFiles(
    profile: ComposeDriverProfile,
    manifest: RemoteDeploymentManifest,
  ): Promise<Array<{ relative: string; contents: string; mode: number }>> {
    const remoteRoot = manifest.remoteRoot;
    const remoteRuntime = await this.inspectRemoteAuthRuntime(
      profile,
      manifest.composeProjectName,
      "Remote server overlay generation refused: ",
      "Remote server overlay was not regenerated.",
    );
    const remoteInstanceEnv = await this.execWithoutDockerHost(
      "cat",
      [posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME, "instance.env")],
      { stdio: "pipe" },
    );
    if (remoteInstanceEnv.code !== 0 || remoteInstanceEnv.stdout.trim() === "") {
      throw new Error(
        `Remote registry bootstrap refused: canonical remote instance.env is missing or unreadable at ${posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME, "instance.env")}. No remote files were changed.`,
      );
    }
    const parsedInstanceEnv = parseDotenv(remoteInstanceEnv.stdout);
    const serverEnv = buildServerOverlayEnv(
      this.resolveInstanceForProfile(),
      parsedInstanceEnv,
      {
        passwordRecoveryDriver: profile.password_recovery ?? "oss_relay",
        containerCorePort: remoteRuntime.logtoCoreContainer,
        remotePairingPepper: parsedInstanceEnv["NAUTILO_REMOTE_PAIRING_PEPPER"],
        pushTokenEncryptionKey:
          parsedInstanceEnv["NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY"],
      },
    );
    return [
      {
        relative: "deploy.server.env",
        contents: envFileContents(serverEnv),
        mode: 0o600,
      },
      {
        relative: "deploy.server-overlay.yml",
        contents: serverOverlayYaml(
          posix.join(remoteRoot, "deploy.server.env"),
          posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME, "instance.env"),
        ),
        mode: 0o600,
      },
    ];
  }

  /**
   * After successful health/runtime acceptance, atomically publish the
   * deployment manifest's running artifact identity. Never called before
   * health is proven.
   */
  private async commitRemoteDeploymentManifestArtifact(
    profile: ComposeDriverProfile,
    running: ReleaseArtifact,
  ): Promise<void> {
    const remoteRoot = this.deps.resolveInstanceRootDir(profile);
    const now = this.deps.now().toISOString();
    let manifest: RemoteDeploymentManifest;
    try {
      manifest = await this.readRemoteDeploymentManifest(profile);
    } catch (error) {
      if (!/missing or unreadable/.test(errorMessage(error))) {
        throw error;
      }
      const created = remoteDeploymentManifestSchema.parse({
        version: 2,
        instanceId: (profile.instance_id ?? "").trim(),
        composeProjectName: composeProjectName(profile),
        lifecycle: "compose",
        image: manifestImageFromReleaseArtifact(running),
        remoteRoot,
        https: profile.https === "letsencrypt" ? "letsencrypt" : "off",
        contracts: {
          authApplied: buildAppliedAuthContract(now),
        },
        createdAt: now,
        updatedAt: now,
      });
      await this.writeRemoteFiles(remoteRoot, [
        {
          relative: "deployment-manifest.json",
          contents: JSON.stringify(created, null, 2) + "\n",
          mode: 0o600,
        },
      ]);
      return;
    }
    const migrated = migrateRemoteDeploymentManifest(manifest);
    const updated: RemoteDeploymentManifest = {
      ...migrated,
      image: manifestImageFromReleaseArtifact(running),
      updatedAt: now,
    };
    await this.writeRemoteFiles(manifest.remoteRoot, [
      {
        relative: "deployment-manifest.json",
        contents: JSON.stringify(updated, null, 2) + "\n",
        mode: 0o600,
      },
    ]);
  }

  /** Reconcile the remote manifest from a restored full bundle's image record. */
  private async reconcileRemoteDeploymentManifestFromBundle(
    profile: ComposeDriverProfile,
    restoredImage: RemoteDeploymentManifest["image"],
  ): Promise<void> {
    const manifest = await this.readRemoteDeploymentManifest(profile);
    const migrated = migrateRemoteDeploymentManifest(manifest);
    const updated: RemoteDeploymentManifest = {
      ...migrated,
      image: restoredImage,
      updatedAt: this.deps.now().toISOString(),
    };
    await this.writeRemoteFiles(manifest.remoteRoot, [
      {
        relative: "deploy.registry-overlay.yml",
        contents: buildPinnedImageOverlay(restoredImage.reference),
        mode: 0o600,
      },
      {
        relative: "deployment-manifest.json",
        contents: JSON.stringify(updated, null, 2) + "\n",
        mode: 0o600,
      },
    ]);
  }

  private async pullRemoteImageDirect(imageRef: string): Promise<void> {
    const script = ["set -eu", `exec docker pull ${shellQuote(imageRef)}`].join("; ");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "inherit",
    });
    if (result.code !== 0) {
      if (this.looksLikeSshFailure(result.stderr)) {
        throw new Error(
          `Remote SSH execution failed (exit ${result.code}): docker pull could not reach the remote host.`,
        );
      }
      throw new Error(
        `Remote docker pull failed for ${imageRef} (exit ${result.code}). Check registry credentials on the remote host.`,
      );
    }
  }

  /**
   * M139 persistent-byte guard for SSH-native remote day-two registry deploys.
   * Inspects the remote Docker host directly — no DOCKER_HOST or local staging.
   */
  private async assertRemoteArtifactVolumePresentOrMigrated(
    profile: ComposeDriverProfile,
    projectName: string,
    opts?: { allowArtifactLoss?: boolean },
  ): Promise<void> {
    const nameFilter = `${projectName}-nautilo-server`;
    const script = [
      "set -eu",
      `name_filter=${shellQuote("name=" + nameFilter)}`,
      'names="$(docker ps --filter "$name_filter" --filter status=running --format "{{.Names}}" 2>/dev/null || true)"',
      'if [ -z "$names" ]; then exit 0; fi',
      'missing=""',
      `if ! docker volume inspect ${shellQuote(`${projectName}_app_artifacts`)} >/dev/null 2>&1; then missing="$missing artifacts"; fi`,
      `if ! docker volume inspect ${shellQuote(`${projectName}_app_media`)} >/dev/null 2>&1; then missing="$missing media"; fi`,
      'printf %s "$missing"',
    ].join("; ");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      if (this.looksLikeSshFailure(result.stderr)) {
        throw new Error(
          `Remote SSH connection failed while checking persistent volumes (exit ${result.code}). Check SSH connectivity and credentials for profile '${profile.name}'.`,
        );
      }
      throw new Error(
        `Remote Docker inspection failed while checking persistent volumes (exit ${result.code}).`,
      );
    }
    const missing = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (missing.length === 0) {
      return;
    }

    if (opts?.allowArtifactLoss === true) {
      this.deps.log(
        `deploy: warning: nautilo-server is running for project '${projectName}' but ${missing.join(" + ")} persistent volume(s) do not exist — artifact and/or media bytes may be lost on container recreate`,
      );
      return;
    }

    throw new Error(this.persistentVolumeGuardMessage(projectName, profile.name, missing));
  }

  /**
   * First-install exception for a manifestless remote registry root. All
   * generated deployment files are written to a remote temporary directory,
   * validated remotely, then promoted only while the root remains empty.
   * Secrets never travel through RemoteFs or an operator-side compose command.
   */
  private async deployRemoteRegistryFirstInstall(
    profile: ComposeDriverProfile,
    remoteRoot: string,
  ): Promise<void> {
    const inst = this.resolveInstanceForProfile();
    const projectName = composeProjectName(profile);
    const mode = httpsMode(profile);
    const stageRoot = `${remoteRoot}.nautilo-stage-${process.pid}-${Date.now()}`;
    const operatorInstanceRootDir = this.deps.resolveLocalInstanceRootDir(profile);
    const passwordRecoveryDriver = profile.password_recovery ?? "oss_relay";
    const passwordRecoveryEnv = {
      ...process.env,
      NAUTILO_PASSWORD_RECOVERY_DRIVER: passwordRecoveryDriver,
    };
    const forgotPasswordWebhookSecret = passwordRecoveryUsesOssRelay(passwordRecoveryEnv)
      ? await this.deps.ensureForgotPasswordWebhookSecret({
          instanceRootDir: operatorInstanceRootDir,
        })
      : undefined;
    const remotePairingPepper = await this.deps.ensureRemotePairingPepper({
      instanceRootDir: operatorInstanceRootDir,
    });
    const pushTokenEncryptionKey =
      await this.deps.ensurePushTokenEncryptionKey({
        instanceRootDir: operatorInstanceRootDir,
      });
    const passwords = await this.deps.ensureDbPasswords({
      instanceRootDir: operatorInstanceRootDir,
      composeProjectName: projectName,
      appPostgresHostPort: inst.db.postgresHostPort,
    });

    let composeEnvOpts: { acmeEmail?: string; caddyfilePath?: string } | undefined;
    if (mode === "letsencrypt") {
      const fromProfile = profile.acme_email?.trim();
      const fromCallback = this.deps.resolveAcmeEmail?.(profile)?.trim();
      const acmeEmail = fromProfile && fromProfile.length > 0
        ? fromProfile
        : (fromCallback && fromCallback.length > 0 ? fromCallback : undefined);
      if (!acmeEmail || !profile.domain?.trim()) {
        throw new Error(
          "https=letsencrypt requires a non-empty domain and ACME email before remote first install.",
        );
      }
      composeEnvOpts = {
        acmeEmail,
        caddyfilePath: posix.join(stageRoot, "deploy.Caddyfile"),
      };
    }

    const composeEnv = buildComposeEnv(profile, inst, passwords, composeEnvOpts);
    const template = async (relativePath: string): Promise<string> =>
      nodeFs.readFile(join(this.deps.templateDir, relativePath), "utf8");
    const files: Array<{ relative: string; contents: string; mode: number }> = [
      { relative: "docker-compose.yml", contents: await template("docker-compose.yml"), mode: 0o644 },
      {
        relative: "postgres-init.sh",
        contents: await nodeFs.readFile(
          join(this.deps.templateDir, "..", "..", "..", "infra", "postgres-init.sh"),
          "utf8",
        ),
        mode: 0o755,
      },
      { relative: "deploy.compose.env", contents: envFileContents(composeEnv), mode: 0o600 },
      { relative: "deploy.registry-overlay.yml", contents: buildPinnedImageOverlay(registryImageRef(profile)), mode: 0o600 },
      { relative: "deploy.volumes-overlay.yml", contents: remoteVolumesOverlayYaml(stageRoot), mode: 0o600 },
    ];
    if (composeEnvOpts?.acmeEmail !== undefined) {
      files.push(
        {
          relative: "deploy.Caddyfile",
          contents: buildCaddyfile({
            profile,
            inst,
            acmeEmail: composeEnvOpts.acmeEmail,
          }),
          mode: 0o600,
        },
        { relative: "deploy.caddy-overlay.yml", contents: buildCaddyOverlay(), mode: 0o600 },
      );
    }

    await this.writeRemoteFiles(stageRoot, files);
    await this.runRemoteComposeAtRoot(
      profile,
      stageRoot,
      projectName,
      mode === "letsencrypt",
      { verb: "config" },
      false,
    );
    await this.promoteRemoteFirstInstall(stageRoot, remoteRoot);
    // The staged config is validated with staged absolute bind-mount paths.
    // After the atomic rename, rewrite generated path overlays and the
    // compose env file to point at the active root before the first compose
    // invocation on the promoted tree.
    const postPromotionFiles: Array<{ relative: string; contents: string; mode: number }> = [
      {
        relative: "deploy.volumes-overlay.yml",
        contents: remoteVolumesOverlayYaml(remoteRoot),
        mode: 0o600,
      },
    ];
    if (mode === "letsencrypt" && composeEnvOpts?.acmeEmail !== undefined) {
      const activeComposeEnv = buildComposeEnv(profile, inst, passwords, {
        acmeEmail: composeEnvOpts.acmeEmail,
        caddyfilePath: posix.join(remoteRoot, "deploy.Caddyfile"),
      });
      postPromotionFiles.push({
        relative: "deploy.compose.env",
        contents: envFileContents(activeComposeEnv),
        mode: 0o600,
      });
    }
    await this.writeRemoteFiles(remoteRoot, postPromotionFiles);

    await this.runRemoteComposeAtRoot(
      profile,
      remoteRoot,
      projectName,
      mode === "letsencrypt",
      { verb: "pull", service: "nautilo-server" },
      false,
    );
    await this.runRemoteComposeAtRoot(
      profile,
      remoteRoot,
      projectName,
      mode === "letsencrypt",
      { verb: "up", wait: true, service: "app-postgres" },
      false,
    );
    await this.repairAppDbOwnership({
      transport: "remote_ssh",
      remoteRoot,
      projectName,
      overlays: this.remoteRegistryRepairOverlays(mode === "letsencrypt", false),
      profiles: this.remoteDeployProfiles(profile),
    });
    await this.runRemoteComposeAtRoot(
      profile,
      remoteRoot,
      projectName,
      mode === "letsencrypt",
      { verb: "up", wait: true, service: "logto-postgres" },
      false,
    );
    await this.preflightLogtoPreSeedRecovery({
      transport: "remote_ssh",
      remoteRoot,
      projectName,
      overlays: this.remoteRegistryRepairOverlays(mode === "letsencrypt", false),
      profiles: this.remoteDeployProfiles(profile),
    });
    await this.preflightLogtoTenantPasswordResync({
      transport: "remote_ssh",
      remoteRoot,
      projectName,
      overlays: this.remoteRegistryRepairOverlays(mode === "letsencrypt", false),
      profiles: this.remoteDeployProfiles(profile),
    });
    await this.runRemoteComposeAtRoot(
      profile,
      remoteRoot,
      projectName,
      mode === "letsencrypt",
      { verb: "up" },
      false,
    );

    await this.recreateLogtoCoreAfterAuthUp({
      transport: "remote_ssh",
      remoteRoot,
      projectName,
      overlays: this.remoteRegistryRepairOverlays(mode === "letsencrypt", false),
      profiles: this.remoteDeployProfiles(profile),
    });

    await this.pollLogtoHealth(composeEnv["LOGTO_ENDPOINT"]!);
    if (profile.ssh === undefined) {
      throw new Error("Remote first install requires an SSH profile.");
    }
    const tunnel = await this.deps.openSshTunnel(profile.ssh, [
      { local: inst.logto.corePort, remoteHost: "127.0.0.1", remote: inst.logto.corePort },
      { local: inst.logto.adminPort, remoteHost: "127.0.0.1", remote: inst.logto.adminPort },
      { local: inst.logto.dbPort, remoteHost: "127.0.0.1", remote: inst.logto.dbPort },
    ]);
    try {
      await bootstrapLogtoForProfile(profile, {
        runBootstrap: this.deps.runBootstrap,
        dbPasswords: passwords,
        ...(forgotPasswordWebhookSecret !== undefined ? { forgotPasswordWebhookSecret } : {}),
      });
    } finally {
      await tunnel.close();
    }

    if (this.deps.ensureBootstrapToken) {
      this.deps.ensureBootstrapToken(profile, operatorHome());
    }
    await this.writeRemoteFirstInstallServerConfig(
      profile,
      remoteRoot,
      inst,
      passwordRecoveryDriver,
      forgotPasswordWebhookSecret,
      remotePairingPepper,
      pushTokenEncryptionKey,
    );
    await this.runRemoteComposeAtRoot(profile, remoteRoot, projectName, mode === "letsencrypt", {
      verb: "up",
    });

    const serverBaseUrl = resolveServerBaseUrl(profile, inst);
    await this.pollServerHealthForProfile(profile, serverBaseUrl);
    if (this.deps.firstDeployConsume) {
      await this.deps.firstDeployConsume({
        profile,
        instanceRootDir: operatorInstanceRootDir,
        deployTomlPath: join(
          process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
          "nautilo",
          "deploy.toml",
        ),
      });
      await this.writeRemoteFirstInstallServerConfig(
        profile,
        remoteRoot,
        inst,
        passwordRecoveryDriver,
        forgotPasswordWebhookSecret,
        remotePairingPepper,
        pushTokenEncryptionKey,
      );
      await this.runRemoteComposeAtRoot(profile, remoteRoot, projectName, mode === "letsencrypt", {
        verb: "up",
      });
      await this.pollServerHealthForProfile(profile, serverBaseUrl);
    }

    const now = this.deps.now().toISOString();
    const manifest = remoteDeploymentManifestSchema.parse({
      version: 2,
      instanceId: (profile.instance_id ?? "").trim(),
      composeProjectName: projectName,
      lifecycle: "compose",
      image: { mode: "registry", reference: registryImageRef(profile) },
      remoteRoot,
      https: mode === "letsencrypt" ? "letsencrypt" : "off",
      contracts: {
        authApplied: buildAppliedAuthContract(this.deps.now().toISOString()),
      },
      createdAt: now,
      updatedAt: now,
    });
    await this.writeRemoteFiles(remoteRoot, [
      {
        relative: "deployment-manifest.json",
        contents: JSON.stringify(manifest, null, 2) + "\n",
        mode: 0o600,
      },
    ]);
  }

  private async writeRemoteFirstInstallServerConfig(
    profile: ComposeDriverProfile,
    remoteRoot: string,
    inst: ResolvedInstance,
    passwordRecoveryDriver: NonNullable<ComposeDriverProfile["password_recovery"]>,
    forgotPasswordWebhookSecret: string | undefined,
    remotePairingPepper: string,
    pushTokenEncryptionKey: string,
  ): Promise<void> {
    const localRoot = this.deps.resolveLocalInstanceRootDir(profile);
    await ensureCanonicalConfigLayout(localRoot);
    let instanceEnv = "";
    try {
      instanceEnv = await nodeFs.readFile(canonicalInstanceEnvPath(localRoot), "utf8");
    } catch {
      // Bootstrap may legitimately not have emitted optional LOGTO_* keys.
    }
    const logtoEnv = await this.deps.readInstanceLogtoEnv(localRoot);
    const serverEnv = buildServerOverlayEnv(inst, logtoEnv, {
      passwordRecoveryDriver,
      ...(forgotPasswordWebhookSecret !== undefined ? { forgotPasswordWebhookSecret } : {}),
      remotePairingPepper,
      pushTokenEncryptionKey,
    });
    await this.writeRemoteFiles(remoteRoot, [
      {
        relative: `${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
        contents: instanceEnv,
        mode: 0o600,
      },
      { relative: "deploy.server.env", contents: envFileContents(serverEnv), mode: 0o600 },
      {
        relative: "deploy.server-overlay.yml",
        contents: serverOverlayYaml(
          posix.join(remoteRoot, "deploy.server.env"),
          posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME, "instance.env"),
        ),
        mode: 0o600,
      },
    ]);
  }

  private async ensureRemoteCanonicalConfigLayout(remoteRoot: string): Promise<void> {
    const configDir = posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME);
    const canonical = posix.join(configDir, "instance.env");
    const legacy = posix.join(remoteRoot, "instance.env");
    const script = [
      "set -eu",
      "umask 077",
      `mkdir -p -- ${shellQuote(configDir)}`,
      // A regular legacy file is the newest output of a compatibility writer;
      // adopt it atomically. A correct symlink is simply re-established.
      `if [ -e ${shellQuote(legacy)} ] && [ ! -L ${shellQuote(legacy)} ]; then mv -f -- ${shellQuote(legacy)} ${shellQuote(canonical)}; fi`,
      `if [ ! -f ${shellQuote(canonical)} ]; then printf '%s\\n' '# Nautilo configuration — API keys and provider settings' > ${shellQuote(canonical)}; chmod 600 ${shellQuote(canonical)}; fi`,
      `rm -f -- ${shellQuote(legacy)}`,
      `ln -s ${shellQuote(`${RUNTIME_CONFIG_DIR_NAME}/instance.env`)} ${shellQuote(legacy)}`,
    ].join("; ");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      throw new Error(
        `Remote canonical config layout failed at ${configDir} (exit ${result.code}).`,
      );
    }
  }

  /**
   * D458/D468 — upgrade a remote host in place without copying its pairing
   * pepper or push-token encryption key through operator memory or creating an
   * operator-side authority. A bounded host lock serializes concurrent
   * upgrades; canonical instance.env wins and the server overlay is regenerated
   * from those same values.
   */
  private async ensureRemoteHostCanonicalPushSecrets(
    remoteRoot: string,
  ): Promise<void> {
    const configDir = posix.join(remoteRoot, RUNTIME_CONFIG_DIR_NAME);
    const canonical = posix.join(configDir, "instance.env");
    const serverEnv = posix.join(remoteRoot, "deploy.server.env");
    const lock = posix.join(configDir, ".push-secrets.lock");
    const script = [
      "set -eu",
      "umask 077",
      `canonical=${shellQuote(canonical)}`,
      `server_env=${shellQuote(serverEnv)}`,
      `lock=${shellQuote(lock)}`,
      "pepper_key=NAUTILO_REMOTE_PAIRING_PEPPER",
      "push_key=NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY",
      "attempt=0",
      'until mkdir -- "$lock" 2>/dev/null; do attempt=$((attempt + 1)); if [ "$attempt" -ge 100 ]; then exit 74; fi; sleep 0.05; done',
      `trap 'rmdir -- "$lock" 2>/dev/null || true' EXIT HUP INT TERM`,
      'pepper="$(sed -n "s/^${pepper_key}=//p" "$canonical" | tail -n 1)"',
      'if [ -n "$pepper" ]; then if ! printf %s "$pepper" | grep -Eq "^[[:xdigit:]]{64,}$" || [ $(( ${#pepper} % 2 )) -ne 0 ]; then exit 65; fi; fi',
      'if [ -z "$pepper" ]; then pepper="$(od -An -N32 -tx1 /dev/urandom | tr -d " \\n")"; fi',
      'push_key_value="$(sed -n "s/^${push_key}=//p" "$canonical" | tail -n 1)"',
      'if [ -n "$push_key_value" ] && ! printf %s "$push_key_value" | grep -Eq "^[[:xdigit:]]{64}$"; then exit 66; fi',
      'if [ -z "$push_key_value" ]; then push_key_value="$(od -An -N32 -tx1 /dev/urandom | tr -d " \\n")"; fi',
      'config_tmp="${canonical}.tmp.$$"',
      'grep -v -e "^${pepper_key}=" -e "^${push_key}=" "$canonical" > "$config_tmp" || true',
      'printf "%s=%s\\n" "$pepper_key" "$pepper" >> "$config_tmp"',
      'printf "%s=%s\\n" "$push_key" "$push_key_value" >> "$config_tmp"',
      'chmod 600 "$config_tmp"',
      'mv -f -- "$config_tmp" "$canonical"',
      'server_tmp="${server_env}.tmp.$$"',
      'if [ -f "$server_env" ]; then grep -v -e "^${pepper_key}=" -e "^${push_key}=" "$server_env" > "$server_tmp" || true; else : > "$server_tmp"; fi',
      'printf "%s=%s\\n" "$pepper_key" "$pepper" >> "$server_tmp"',
      'printf "%s=%s\\n" "$push_key" "$push_key_value" >> "$server_tmp"',
      'chmod 600 "$server_tmp"',
      'mv -f -- "$server_tmp" "$server_env"',
    ].join("; ");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      throw new Error(
        `Remote server secret provisioning failed at canonical host config (exit ${result.code}).`,
      );
    }
  }

  private async writeRemoteFiles(
    remoteRoot: string,
    files: Array<{ relative: string; contents: string; mode: number }>,
  ): Promise<void> {
    const commands = ["set -eu", "umask 077", `mkdir -p -- ${shellQuote(remoteRoot)}`];
    for (const file of files) {
      const path = posix.join(remoteRoot, file.relative);
      const temporary = `${path}.tmp-$$`;
      const encoded = Buffer.from(file.contents, "utf8").toString("base64");
      commands.push(
        `mkdir -p -- ${shellQuote(posix.dirname(path))}`,
        `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(temporary)}`,
        `chmod ${file.mode.toString(8)} ${shellQuote(temporary)}`,
        `mv -f -- ${shellQuote(temporary)} ${shellQuote(path)}`,
      );
    }
    if (
      files.some(
        (file) => file.relative === `${RUNTIME_CONFIG_DIR_NAME}/instance.env`,
      )
    ) {
      const legacy = posix.join(remoteRoot, "instance.env");
      commands.push(
        `rm -f -- ${shellQuote(legacy)}`,
        `ln -s ${shellQuote(`${RUNTIME_CONFIG_DIR_NAME}/instance.env`)} ${shellQuote(legacy)}`,
      );
    }
    const result = await this.execWithoutDockerHost("sh", ["-lc", commands.join("; ")], {
      stdio: "pipe",
    });
    if (result.code !== 0) {
      if (this.looksLikeSshFailure(result.stderr)) {
        throw new Error(`Remote SSH connection failed while writing deployment configuration (exit ${result.code}).`);
      }
      throw new Error(`Remote configuration write failed (exit ${result.code}).`);
    }
  }

  private async promoteRemoteFirstInstall(
    stageRoot: string,
    remoteRoot: string,
  ): Promise<void> {
    const script = [
      "set -eu",
      `stage=${shellQuote(stageRoot)}`,
      `root=${shellQuote(remoteRoot)}`,
      'if [ -e "$root" ] && [ ! -d "$root" ]; then exit 42; fi',
      'if [ -d "$root" ] && [ -n "$(ls -A -- "$root" 2>/dev/null)" ]; then exit 42; fi',
      'mkdir -p -- "$(dirname -- "$root")"',
      'if [ -d "$root" ]; then rmdir -- "$root"; fi',
      'mv -- "$stage" "$root"',
    ].join("; ");
    const result = await this.execWithoutDockerHost("sh", ["-lc", script], {
      stdio: "pipe",
    });
    if (result.code === 42) {
      throw new Error(
        `Remote registry deployment requires explicit adoption: ${remoteRoot} became nonempty during first-install promotion. No existing files were overwritten.`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `Remote first-install promotion failed (exit ${result.code}). The staged configuration was not promoted over an existing root.`,
      );
    }
  }

  private remoteDeployProfiles(profile: ComposeDriverProfile): RemoteComposeProfileName[] {
    const profiles: RemoteComposeProfileName[] = ["auth", "app"];
    if (profile.office === true) {
      profiles.push("office");
    }
    return profiles;
  }

  private async runRemoteComposeAtRoot(
    profile: ComposeDriverProfile,
    remoteRoot: string,
    projectName: string,
    caddy: boolean,
    request: RemoteComposeCommandRequest,
    server = true,
    restore = false,
  ): Promise<void> {
    const built = buildRemoteComposeCommand({
      remoteRoot,
      projectName,
      overlays: { volumes: true, caddy, registry: !restore, server, restore },
      profiles: this.remoteDeployProfiles(profile),
      request,
    });
    const result = await this.execWithoutDockerHost(built.command, [...built.args], {
      // `docker compose config` renders every resolved environment value,
      // including database credentials. Validate it without forwarding that
      // secret-bearing output to the operator terminal.
      stdio: request.verb === "config" ? "pipe" : "inherit",
    });
    if (result.code !== 0) {
      if (this.looksLikeSshFailure(result.stderr)) {
        throw new Error(
          `Remote SSH execution failed (exit ${result.code}): docker compose ${request.verb} could not reach the remote host. Check SSH connectivity and credentials for profile '${profile.name}'.`,
        );
      }
      throw new Error(
        `Remote Docker/Compose failure during ${request.verb} (exit ${result.code}). Check container logs on the remote host (profile '${profile.name}').`,
      );
    }
  }

  private async runRemoteCompose(
    profile: ComposeDriverProfile,
    request: RemoteComposeCommandRequest,
    opts: {
      stdio: "inherit" | "pipe";
      profiles?: readonly RemoteComposeProfileName[];
    },
  ): Promise<ExecResult> {
    const manifest = await this.readRemoteDeploymentManifest(profile);
    const built = buildRemoteComposeCommand({
      remoteRoot: manifest.remoteRoot,
      projectName: manifest.composeProjectName,
      overlays: {
        volumes: true,
        caddy: manifest.https === "letsencrypt",
        registry: true,
        server: true,
      },
      profiles: opts.profiles,
      request,
    });

    const result = await this.execWithoutDockerHost(
      built.command,
      [...built.args],
      opts,
    );

    if (result.code !== 0) {
      if (this.looksLikeSshFailure(result.stderr)) {
        throw new Error(
          `Remote SSH execution failed (exit ${result.code}): docker compose ${request.verb} could not reach the remote host. Check SSH connectivity and credentials for profile '${profile.name}'.`,
        );
      }
      throw new Error(
        `Remote docker compose ${request.verb} failed (exit ${result.code}). Check container logs on the remote host (profile '${profile.name}').`,
      );
    }

    return result;
  }

  private async statusRemote(profile: ComposeDriverProfile): Promise<ComposeStatusObservation> {
    const inst = this.resolveInstanceForProfile();
    const ps = await this.runRemoteCompose(profile, { verb: "ps" }, {
      stdio: "pipe",
    });
    this.deps.log(ps.stdout);

    const baseUrl = resolveServerBaseUrl(profile, inst);
    const base = {
      composeProjectName: composeProjectName(profile),
      serverUrl: baseUrl,
      compose: composePresenceFromPs(ps.stdout),
    } as const;
    try {
      const healthRes = await this.deps.fetch(`${baseUrl}/health`);
      if (!healthRes.ok) {
        this.deps.log(
          `status: HTTP API unavailable... (GET ${baseUrl}/health: HTTP ${healthRes.status})`,
        );
        return { ...base, health: "unavailable" };
      }
      this.deps.log(await healthRes.text());

      try {
        const setupRes = await this.deps.fetch(`${baseUrl}/api/setup/status`);
        if (!setupRes.ok) {
          this.deps.log(
            `status: HTTP API unavailable... (GET ${baseUrl}/api/setup/status: HTTP ${setupRes.status})`,
          );
          return { ...base, health: "unavailable" };
        }
        const setupBody = await setupRes.text();
        this.deps.log(setupBody);
        let setupState: string | undefined;
        let claimRequired: boolean | undefined;
        try {
          const parsed = JSON.parse(setupBody) as {
            setupState?: string;
            claimRequired?: boolean;
          };
          const state = parsed.setupState ?? "unknown";
          setupState = parsed.setupState;
          claimRequired = parsed.claimRequired;
          const claim =
            parsed.claimRequired === true ? "claim REQUIRED" : "claim done";
          this.deps.log(`\n→ ${baseUrl}: setupState=${state}, ${claim}\n`);
        } catch {
          /* tolerate non-JSON */
        }
        return {
          ...base,
          health: "ready",
          ...(setupState === undefined ? {} : { setupState }),
          ...(claimRequired === undefined ? {} : { claimRequired }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.log(`status: HTTP API unavailable... (${msg})`);
        return { ...base, health: "unavailable" };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log(`status: HTTP API unavailable... (${msg})`);
      return { ...base, health: "unavailable" };
    }
  }

  /**
   * Save NAUTILO_INSTANCE_ID, set it to the profile's id, reset the
   * resolveInstance() cache. Returns a thunk that restores both.
   */
  private setInstanceEnv(profile: ComposeDriverProfile): () => void {
    const id = (profile.instance_id ?? "").trim();
    const prev = process.env["NAUTILO_INSTANCE_ID"];
    const hadKey = "NAUTILO_INSTANCE_ID" in process.env;
    const prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
    const hadDotenv = "NAUTILO_DOTENV_PATH" in process.env;
    process.env["NAUTILO_INSTANCE_ID"] = id;
    process.env["NAUTILO_DOTENV_PATH"] = canonicalInstanceEnvPath(
      this.deps.resolveLocalInstanceRootDir(profile),
    );
    __resetResolvedInstanceForTests();
    return () => {
      if (hadKey) {
        process.env["NAUTILO_INSTANCE_ID"] = prev;
      } else {
        delete process.env["NAUTILO_INSTANCE_ID"];
      }
      if (hadDotenv) {
        process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
      } else {
        delete process.env["NAUTILO_DOTENV_PATH"];
      }
      __resetResolvedInstanceForTests();
    };
  }

  private resolveInstanceForProfile(): ResolvedInstance {
    return this.deps.resolveInstance();
  }

  async assertArtifactVolumePresentOrMigrated(
    profile: ComposeDriverProfile,
    opts?: { allowArtifactLoss?: boolean },
  ): Promise<void> {
    const projectName = composeProjectName(profile);
    const psRes = await this.deps.exec(
      this.deps.composeBin,
      [
        "ps",
        "-a",
        "--filter",
        `name=${projectName}-nautilo-server`,
        "--filter",
        "status=running",
        "--format",
        "{{.Names}}",
      ],
      { ...dockerEnvForProfile(profile), stdio: "pipe" },
    );
    if (psRes.code !== 0 || psRes.stdout.trim() === "") {
      return;
    }

    const missing: string[] = [];
    for (const [kind, volumeName] of [
      ["artifacts", `${projectName}_app_artifacts`],
      ["media", `${projectName}_app_media`],
    ] as const) {
      const inspectRes = await this.deps.exec(
        this.deps.composeBin,
        ["volume", "inspect", volumeName],
        { ...dockerEnvForProfile(profile), stdio: "pipe" },
      );
      if (inspectRes.code !== 0) missing.push(kind);
    }
    if (missing.length === 0) {
      return;
    }

    if (opts?.allowArtifactLoss === true) {
      this.deps.log(
        `deploy: warning: nautilo-server is running for project '${projectName}' but ${missing.join(" + ")} persistent volume(s) do not exist — artifact and/or media bytes may be lost on container recreate`,
      );
      return;
    }

    throw new Error(this.persistentVolumeGuardMessage(projectName, profile.name, missing));
  }

  private persistentVolumeGuardMessage(
    projectName: string,
    profileName: string,
    missing: readonly string[],
  ): string {
    const migrations = [
      ...(missing.includes("artifacts")
        ? [`\`nautilo migrate-artifacts-to-volume ${profileName}\``]
        : []),
      ...(missing.includes("media")
        ? [`\`nautilo migrate-media-to-volume ${profileName}\``]
        : []),
    ];
    return (
      `Refusing to deploy/upgrade: a nautilo-server is running for project '${projectName}' but its ${missing.join(" + ")} persistent volume(s) do not exist. ` +
      "Existing artifact and/or media bytes would be stranded on container recreate. Run " +
      `${migrations.join(" and ")} first, or pass --allow-artifact-loss to override.`
    );
  }

  private async runComposeCapture(
    profile: ComposeDriverProfile,
    baseYml: string,
    composeEnvPath: string | undefined,
    caddyOverlayPath: string | undefined,
    extra: string[],
  ): Promise<ExecResult> {
    const projectName = composeProjectName(profile);
    const args = ["--project-name", projectName, "-f", baseYml];
    if (caddyOverlayPath) args.push("-f", caddyOverlayPath);
    if (composeEnvPath) args.push("--env-file", composeEnvPath);
    args.push(...extra);
    const fullArgs = [...this.deps.composeArgs, ...args];
    return this.deps.exec(this.deps.composeBin, fullArgs, {
      ...dockerEnvForProfile(profile),
      stdio: "pipe",
    });
  }

  /**
   * M139 — `exec` prefix for backup/restore DB dump/load pipelines.
   *
   * In STAGED remote mode the pipeline is SSH-executed ON THE DROPLET, where
   * the operator-local compose template (`-f <baseYml>`) and `deploy.compose.env`
   * do NOT exist — so `docker compose -f <local-path> exec` cannot work there
   * (it fails before reaching the container). Instead resolve the running
   * container by its compose-conventional name (`<project>-<service>`) and use
   * plain `docker exec`, which needs no compose project context on the host.
   *
   * In local / `--stream` mode the command runs on the OPERATOR with the local
   * docker CLI (with `DOCKER_HOST` pointed at the remote daemon for stream),
   * where the template IS present, so the original `docker compose -f <baseYml>
   * exec -T <service>` form is correct and unchanged.
   *
   * Returns a prefix ending in a trailing space; callers append the in-container
   * command (e.g. `pg_dump ...`, `psql ...`).
   */
  /**
   * M139 — rsync flags for resumable staged transfers, adapted to the
   * local rsync version. `--partial` (the core resume-on-retry behavior,
   * present since rsync 2.x) is always used. `--append-verify` is only
   * added when rsync >= 3.0 supports it — macOS still ships rsync 2.6.9,
   * which errors out on the flag. Probed once and cached.
   */
  private rsyncAppendVerifySupported: boolean | undefined;
  private async rsyncResumeArgs(): Promise<string[]> {
    const base = ["-az", "--partial"];
    if (this.rsyncAppendVerifySupported === undefined) {
      let supported = false;
      try {
        const res = await this.deps.localExec("rsync", ["--version"], {
          stdio: "pipe",
        });
        const m = res.stdout.match(/version\s+(\d+)\.(\d+)/);
        supported = m !== null && Number(m[1]) >= 3;
        this.deps.log(
          `backup/restore: local rsync ${supported ? ">=3 — using --append-verify" : "<3 (e.g. macOS 2.6.9) — using --partial only (still resumable)"}`,
        );
      } catch {
        supported = false;
      }
      this.rsyncAppendVerifySupported = supported;
    }
    if (this.rsyncAppendVerifySupported) base.push("--append-verify");
    return base;
  }

  private deployEnvAndProfileArgs(
    profile: ComposeDriverProfile,
    composeEnvPath: string,
  ): string[] {
    const args = ["--env-file", composeEnvPath, "--profile", "auth", "--profile", "app"];
    if (profile.office === true) {
      args.push("--profile", "office");
    }
    return args;
  }

  /** Local shell + DOCKER_HOST for remote-source SQL pipelines; see `sql-pipeline-exec.ts`. */
  private sqlPipelineExec(profile: ComposeDriverProfile): ExecFn {
    return sqlPipelineExecForProfile(profile, {
      exec: this.deps.exec,
      localExec: this.deps.localExec,
    });
  }

  private remoteRegistryRepairOverlays(
    caddy: boolean,
    server: boolean,
    restore = false,
  ): RemoteComposeOverlayFlags {
    return {
      volumes: true,
      caddy,
      registry: !restore,
      server,
      restore,
    };
  }

  private async preflightLogtoPreSeedRecovery(
    ctx: LogtoPreSeedRecoveryContext,
    exec: ExecFn = this.deps.exec,
  ): Promise<void> {
    const runner = this.deps.runLogtoPreSeedRecovery ?? runLogtoPreSeedRecovery;
    await runner(ctx, {
      exec,
      getLogtoPreSeedRecoverySql: this.deps.getLogtoPreSeedRecoverySql,
      log: this.deps.log,
    });
  }

  /** Idempotent preflight after logto-postgres + pre-seed, before auth-profile up. */
  private async preflightLogtoTenantPasswordResync(
    ctx: LogtoTenantPasswordResyncContext,
    exec: ExecFn = this.deps.exec,
  ): Promise<void> {
    const runner =
      this.deps.runLogtoTenantPasswordResync ?? runLogtoTenantPasswordResync;
    await runner(ctx, {
      exec,
      getLogtoTenantPasswordResyncSql: this.deps.getLogtoTenantPasswordResyncSql,
      log: this.deps.log,
    });
  }

  /**
   * Recreate Logto core after auth-profile up so tenant pool config matches
   * resynced passwords. Never restarts logto-postgres.
   */
  private async recreateLogtoCoreAfterAuthUp(
    ctx: LogtoCoreRecreateContext,
    exec: ExecFn = this.deps.exec,
  ): Promise<void> {
    const runner = this.deps.runLogtoCoreRecreate ?? runLogtoCoreRecreate;
    await runner(ctx, { exec, log: this.deps.log });
  }

  private async repairAppDbOwnership(
    ctx: AppDbRepairContext,
    exec: ExecFn = this.deps.exec,
  ): Promise<void> {
    const runner = this.deps.runAppDbRepair ?? runAppDbRepair;
    await runner(ctx, {
      exec,
      getAppDbRepairSql: this.deps.getAppDbRepairSql,
      log: this.deps.log,
    });
  }

  private async readConnectedRestoreIdentity(
    profile: ComposeDriverProfile,
    appPgExec: string,
    executeOnRemoteHost: boolean,
    phase: string,
  ): Promise<RestoreInstanceIdentity | undefined> {
    const command = buildReadConnectedInstanceIdentityScript(
      `${appPgExec}psql -U postgres -d nautilo`,
    );
    this.deps.log(`restore: checking ${phase}...`);
    const result = await (executeOnRemoteHost
      ? this.deps.exec("sh", ["-c", command], { stdio: "pipe" })
      : this.deps.localExec("sh", ["-c", command], {
          ...dockerEnvForProfile(profile),
          stdio: "pipe",
        }));
    if (result.code !== 0) {
      throw new Error(
        `restore refused: ${phase} failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    return parseConnectedInstanceIdentity(result.stdout);
  }

  private dbExecPrefix(args: {
    staged: boolean;
    projectName: string;
    service: string;
    composePrefix: string;
  }): string {
    if (args.staged) {
      const filter = shellQuote(`name=${args.projectName}-${args.service}`);
      return (
        `${this.deps.composeBin} exec -i ` +
        `"$(${this.deps.composeBin} ps -q --filter ${filter} | head -n1)" `
      );
    }
    return `${args.composePrefix}exec -T ${args.service} `;
  }

  /**
   * D420 (Wave 3 task 3.3.2) — re-pin the `nautilo` / `nautilo_agent`
   * app-cluster role passwords to the restored `instance.env` and resync
   * the Logto per-tenant role passwords to the restored `tenants` table,
   * BEFORE application startup. Idempotent (no-op when passwords already
   * match) and fail-closed (a nonzero psql exit propagates via
   * private-input execution and aborts the restore). Does NOT invoke
   * broad `authReconcile()`.
   */
  private async reconcileRestoredDbPasswords(args: {
    appPgExec: string;
    logtoPgExec: string;
    instanceEnvRaw: string;
    reconcileNautilo: boolean;
    reconcileLogto: boolean;
    exec: ExecFn;
  }): Promise<void> {
    // D427 (Wave 4 task 4.1.1) — the reconciliation plan (which SQL to emit,
    // in which order, gated on which scopes) is built by the shared
    // @nautilo/db helper so the Compose path and the `nautilo-dev` path
    // share the exact contract. The transport-specific psql invocation
    // (compose-exec prefix, target DB) stays here.
    const plan = planCredentialReconciliation({
      instanceEnvRaw: args.instanceEnvRaw,
      reconcileNautilo: args.reconcileNautilo,
      reconcileLogto: args.reconcileLogto,
    });
    for (const pipeline of plan.pipelines) {
      const targetDb = pipeline.kind === "app" ? "postgres" : "logto_nautilo";
      const execPrefix = pipeline.kind === "app" ? args.appPgExec : args.logtoPgExec;
      // SQL contains role passwords. Keep it out of shell/SSH/psql argv,
      // command logs, and raw psql diagnostics (which can echo SQL on error).
      this.deps.log(`restore: → ${pipeline.label}`);
      let result: ExecResult;
      try {
        result = await args.exec(
          "sh",
          ["-c", `${execPrefix}psql -X -U postgres -d ${targetDb} -v ON_ERROR_STOP=1 -f -`],
          { stdio: "pipe", stdin: pipeline.sql },
        );
      } catch {
        throw new Error(
          `restore: ${pipeline.label} failed to execute; sensitive SQL diagnostics withheld`,
        );
      }
      if (result.code !== 0) {
        throw new Error(
          `restore: ${pipeline.label} failed (exit ${result.code}); sensitive SQL diagnostics withheld`,
        );
      }
    }
  }

  private async composeServer(
    profile: ComposeDriverProfile,
    action: "stop" | "start",
  ): Promise<void> {
    if (usesRemoteRegistryMode(profile)) {
      await this.runRemoteCompose(
        profile,
        { verb: action, service: "nautilo-server" },
        { stdio: "inherit" },
      );
      return;
    }
    const projectName = composeProjectName(profile);
    const baseYml = join(this.deps.templateDir, "docker-compose.yml");
    const composeEnvPath = this.existingComposeEnvPath(profile);
    const volumesOverlayPath = this.existingVolumesOverlayPath(profile);
    const caddyOverlayPath = this.existingCaddyOverlayPath(profile);
    const args = ["--project-name", projectName, "-f", baseYml];
    if (composeEnvPath) args.push("--env-file", composeEnvPath);
    if (volumesOverlayPath) args.push("-f", volumesOverlayPath);
    if (caddyOverlayPath) args.push("-f", caddyOverlayPath);
    args.push(action, "nautilo-server");
    await this.runCompose(args, { stdio: "inherit" });
  }

  private async runCompose(
    args: string[],
    opts: { stdio: "inherit" | "pipe" },
  ): Promise<ExecResult> {
    const fullArgs = [...this.deps.composeArgs, ...args];
    const result = await this.deps.exec(this.deps.composeBin, fullArgs, {
      stdio: opts.stdio,
    });
    if (result.code !== 0) {
      throw new Error(
        `docker compose failed (exit ${result.code}): ${this.deps.composeBin} ${fullArgs.join(" ")}\n${result.stderr}`,
      );
    }
    return result;
  }

  private async pollLogtoHealth(endpoint: string): Promise<void> {
    const url = `${endpoint}/oidc/.well-known/openid-configuration`;
    const deadline = Date.now() + this.deps.logtoHealthTimeoutMs;
    let lastErr: unknown;
    while (true) {
      try {
        const res = await this.deps.fetch(url);
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, this.deps.pollIntervalMs));
    }
    throw new Error(
      `Logto discovery doc never became ready within ${this.deps.logtoHealthTimeoutMs}ms (${url}): ${String(lastErr)}`,
    );
  }

  private async pollServerHealth(baseUrl: string): Promise<void> {
    const url = `${baseUrl}/health`;
    const deadline = Date.now() + this.deps.serverHealthTimeoutMs;
    let lastErr: unknown;
    while (true) {
      try {
        const res = await this.deps.fetch(url);
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, this.deps.pollIntervalMs));
    }
    throw new Error(
      `nautilo-server /health never became ready within ${this.deps.serverHealthTimeoutMs}ms (${url}): ${String(lastErr)}`,
    );
  }

  /**
   * D427 (Wave 4 task 4.x) — profile-aware health poll used by the deploy/
   * restore/releaseApply/bootstrap paths that determine deployment success or
   * rollback success. For remote profiles with the SSH-local transport wired,
   * `/health` is polled over container loopback on the target
   * (`ssh <target> -- docker exec <nautilo-server> curl http://127.0.0.1:3001
   * /health`), never the operator's public DNS — so a split-DNS upgrade
   * cannot falsely fail/validate the live target via the v2 host. Local
   * profiles and unwired remote profiles retain the legacy `deps.fetch` poll.
   */
  private async pollServerHealthForProfile(
    profile: ComposeDriverProfile,
    baseUrl: string,
  ): Promise<void> {
    if (
      profile.transport === "remote" &&
      this.remoteRuntimeAcceptanceTransport !== undefined
    ) {
      await this.remoteRuntimeAcceptanceTransport.pollHealth(baseUrl);
      return;
    }
    await this.pollServerHealth(baseUrl);
  }
}

// ---------------------------------------------------------------------------
// Default factory
// ---------------------------------------------------------------------------

export interface CreateComposeDriverOptions {
  templateDir: string;
  /** Explicit operator home for reusable callers. CLI callers may omit it. */
  operatorHome?: string;
  /** Optional control-plane-owned provider environment file. */
  managedServerEnvPath?: string;
  composeBin?: string;
  composeArgs?: string[];
  firstDeployConsume?: ComposeDriverDeps["firstDeployConsume"];
  /** Optional progress logger (one-line messages). Default no-op. */
  log?: (msg: string) => void;
  /** M118 — see `ComposeDriverDeps.ensureBootstrapToken`. */
  ensureBootstrapToken?: ComposeDriverDeps["ensureBootstrapToken"];
  /** M139 — see `ComposeDriverDeps.doctor`. */
  doctor?: ComposeDriverDeps["doctor"];
  /**
   * D427 (Wave 3 task 3.1.2) — opt in to deterministic dependency proxy
   * refresh in `deploy()`. Defaults to true when unset (production). Tests
   * that assert the exact deploy command sequence pass `false` explicitly.
   */
  enableDependencyRefresh?: boolean;
  /** Preflighted clean source revision; source deploys fail closed when absent/unresolvable. */
  resolveSourceBuildSha?: ComposeDriverDeps["resolveSourceBuildSha"];
}

/** Wires real `child_process.spawn`, `node:fs/promises`, and `fetch`. */
export function createComposeDriver(
  options: CreateComposeDriverOptions,
): ComposeDriver {
  const deps: ComposeDriverDeps = {
    exec: runLocal,
    fetch: globalThis.fetch.bind(globalThis),
    runBootstrap: defaultRunBootstrap,
    fs: nodeFs,
    now: () => new Date(),
    templateDir: options.templateDir,
  };
  if (options.operatorHome !== undefined) {
    deps.resolveInstanceRootDir = (profile) =>
      localInstanceRootDir(options.operatorHome!, profile.instance_id);
    deps.resolveLocalInstanceRootDir = deps.resolveInstanceRootDir;
  }
  if (options.managedServerEnvPath !== undefined) {
    deps.managedServerEnvPath = options.managedServerEnvPath;
  }
  if (options.composeBin !== undefined) deps.composeBin = options.composeBin;
  if (options.composeArgs !== undefined) deps.composeArgs = options.composeArgs;
  if (options.firstDeployConsume !== undefined) {
    deps.firstDeployConsume = options.firstDeployConsume;
  }
  if (options.log !== undefined) deps.log = options.log;
  if (options.ensureBootstrapToken !== undefined) {
    deps.ensureBootstrapToken = (profile, providedHome) =>
      options.ensureBootstrapToken!(profile, options.operatorHome ?? providedHome);
  }
  if (options.resolveSourceBuildSha !== undefined) {
    deps.resolveSourceBuildSha = options.resolveSourceBuildSha;
  }
  if (options.doctor !== undefined) {
    deps.doctor = options.doctor;
  }
  deps.enableDependencyRefresh = options.enableDependencyRefresh ?? true;
  return new ComposeDriver(deps);
}
