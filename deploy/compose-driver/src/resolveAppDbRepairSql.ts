import {
  buildCryptoRoleReconcilePsqlScript,
  buildFullLegacyRoleRepairSql,
} from "@nautilo/db";

/**
 * Canonical app-cluster repair stream.
 *
 * M231 deliberately attaches crypto-role reconciliation here because every
 * local/remote/staged deploy, upgrade, restore, rollback, and registry repair
 * already traverses this target-aware, fail-closed path.
 */
export function resolveAppDbRepairSql(): string {
  return [
    buildCryptoRoleReconcilePsqlScript(),
    buildFullLegacyRoleRepairSql(),
  ].join("\n");
}
