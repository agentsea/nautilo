export { createApp } from "./app";
export { findAvailablePort } from "./utils/find-port";
export { ensureCerts, loadCACert, type TlsCerts } from "./lib/tls";
export { startMdns, stopMdns, type MdnsOptions } from "./lib/mdns";
export { markReady, resetReadyState, readyState, type ReadyState } from "./routes/health";
// D120 A2 — shared direct pool for lightweight server read paths. Pool
// shutdown is registered lazily inside getSharedDirectDb(). Exported here
// (rather than letting callers reach into ./lib/...) to keep cross-package
// imports going through the workspace package boundary.
export { getServerDirectDb } from "./lib/server-direct-db";
export {
  createExactVeniceMediaQuotePort,
  createMediaGenerationDbRepository,
  createProductionMediaGenerationRuntime,
  installProductionMediaGenerationRuntime,
  resetProductionMediaGenerationRuntime,
  resolveMediaGenerationWritableScope,
  type CreateProductionMediaGenerationRuntimeOptions,
  type InstallProductionMediaGenerationRuntimeOptions,
  type MediaGenerationDbOperations,
} from "./media-generation/production-runtime";
export {
  MEDIA_GENERATION_MAX_BYTES,
  createMediaGenerationWorkerScheduler,
  createProductionMediaArtifactCustody,
  createProductionMediaGenerationWorkerRepository,
  installProductionMediaGenerationWorker,
  stopProductionMediaGenerationWorker,
  type InstallProductionMediaGenerationWorkerOptions,
  type MediaGenerationWorkerScheduler,
  type ProductionMediaArtifactCustodyOptions,
} from "./media-generation/production-worker";
export { hydrateBootstrapOwnerState } from "./lib/bootstrap-owner-state";
export {
  readPostureSidecar,
  writePostureSidecar,
  ensurePostureSidecar,
} from "./lib/posture-sidecar";
export {
  registerInstalledAppTools,
  registerAppToolsForApp,
  jsonSchemaToZod,
  type AppToolRegistrationResult,
  type RegisterAppToolsOptions,
} from "./apps/app-tool-registration";
export {
  timeStage,
  type TelemetryStage,
  type RequestTelemetryContext,
} from "./telemetry";

// `bin/nautilo-dev mint-user` (dev-only quick-and-dirty user-provisioning
// helper) reuses this primitive so the dev path matches what the real
// invite-redeem HTTP route does — Logto user create + nautilo
// `users`/`actors` insert + landing-room membership in one atomic step.
// Once D094 ships its `nautilo users add` command this export can stay or
// be retracted; the production CLI will call this same primitive.
export {
  redeemInviteAtomically,
  type RedeemInput,
  type RedeemResult,
  type RedeemSuccess,
  type RedeemFailure,
} from "./lib/redeem-invite";

// D488 — image-resident, sealed portable recovery execution.  The public
// surface remains intentionally small: provider orchestration supplies only
// opaque job IDs and explicit in-memory authority.
export {
  PORTABLE_RECOVERY_MEMBERS,
  PortableRecoveryJobError,
  createDefaultPortableRecoveryObjectStore,
  createNodePortableRecoveryFilesystem,
  createNodePortableRecoveryRunner,
  createPortableRecoveryFreshTargetPrecondition,
  readPortableRecoveryJobEnvironment,
  runPortableRecoveryJob,
  type PortableRecoveryDirection,
  type PortableRecoveryFilesystem,
  type PortableRecoveryFreshTargetPrecondition,
  type PortableRecoveryJobEnvironment,
  type PortableRecoveryJobResult,
  type PortableRecoveryObjectStore,
  type PortableRecoveryProcessRunner,
  type RunPortableRecoveryJobInput,
} from "./maintenance/portable-recovery-job";
