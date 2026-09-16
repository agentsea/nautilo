// D427 (Wave 4) — shared recovery/acceptance helpers used by both the
// Compose restore/upgrade path and the `nautilo-dev` restore/upgrade/verify
// path. See reconcile.ts (credential reconciliation SQL + planner) and
// acceptance.ts (transport-parameterized runtime acceptance gate).
export {
  sqlLiteral,
  parseDotenv,
  buildAppRolePasswordReconcileSql,
  LOGTO_TENANT_PASSWORD_RESYNC_SQL,
  planCredentialReconciliation,
  type CredentialReconcileKind,
  type CredentialReconcilePipeline,
  type CredentialReconcilePlan,
} from "./reconcile";
export {
  runRuntimeAcceptance,
  type RuntimeAcceptanceCheckId,
  type RuntimeAcceptanceResponse,
  type RuntimeAcceptanceExecResult,
  type RuntimeAcceptanceTransport,
  type RuntimeAcceptanceAppRoleProbe,
  type RuntimeAcceptanceDirectPostgresProbe,
  type RuntimeAcceptanceTargets,
  type RuntimeAcceptanceCheck,
  type RuntimeAcceptanceReport,
  type RuntimeAcceptanceOptions,
} from "./acceptance";
