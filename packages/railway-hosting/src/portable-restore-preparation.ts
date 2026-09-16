/** Pure fresh-target preparation derived from the canonical Railway compiler. */

import {
  compileRailwayPreparationDesiredStates,
  type RailwayDesiredStateCompilationBlockerCode,
  type RailwayDesiredStateTarget,
} from "./desired-state";
import type { RailwayEnvironmentVariables } from "./operations";
import type { RailwayReconcileDesiredState } from "./reconcile-types";
import type { RailwayTopology, RailwayTransientBootstrapIntent } from "./topology";
import type { RailwayVariableProjectionInputs } from "./variable-projection";

export type RailwayPortableRestorePreparationBlockerCode = RailwayDesiredStateCompilationBlockerCode;

export interface RailwayPortableRestoreMaintenanceImageIntent {
  readonly serviceName: "nautilo-server";
  /** Exact immutable image held separately until the transfer target connects it. */
  readonly image: string;
  readonly releaseId: string;
}

export interface RailwayPortableRestorePreparation {
  /** Starts the two PostgreSQL services with canonical projected authority. */
  readonly databases: RailwayReconcileDesiredState;
  /** Empty Logto + Nautilo public scaffolds; neither carries an image or deploys. */
  readonly publicScaffold: RailwayReconcileDesiredState;
  /** Existing bootstrap lifecycle consumes these request-memory values. */
  readonly databaseBootstrapVariables: RailwayEnvironmentVariables;
  /** Existing lifecycle metadata; this module does not implement bootstrap. */
  readonly databaseBootstrapIntent: RailwayTransientBootstrapIntent;
  readonly maintenanceImage: RailwayPortableRestoreMaintenanceImageIntent;
}

export type RailwayPortableRestorePreparationResult =
  | { readonly ok: true; readonly preparation: RailwayPortableRestorePreparation }
  | { readonly ok: false; readonly blockers: readonly { readonly code: RailwayPortableRestorePreparationBlockerCode }[] };

/**
 * Derive the restore-specific vertical slice from the already canonical
 * preparation compiler. This keeps secret projection and receipt boundaries in
 * one place while explicitly omitting its logtoSeed/logtoCore phases.
 */
export function compileRailwayPortableRestorePreparation(
  topology: RailwayTopology,
  inputs: RailwayVariableProjectionInputs,
  target: RailwayDesiredStateTarget,
): RailwayPortableRestorePreparationResult {
  if (topology.qualifications.some((qualification) => qualification.disposition === "blocking")) {
    return { ok: false, blockers: [{ code: "railway.desired-state.topology-qualification" }] };
  }
  const compiled = compileRailwayPreparationDesiredStates(topology, inputs, target);
  if (!compiled.ok) return compiled;
  const server = topology.finalServices.find((service) => service.name === "nautilo-server");
  if (
    server === undefined
    || compiled.preparation.databases.services.length !== 2
    || compiled.preparation.databases.volumes.length !== 2
    || compiled.preparation.publicScaffold.services.length !== 2
    || compiled.preparation.publicScaffold.volumes.length !== 1
    || compiled.preparation.publicScaffold.domains.length !== 2
  ) return { ok: false, blockers: [{ code: "railway.desired-state.projection-mismatch" }] };
  return {
    ok: true,
    preparation: {
      databases: compiled.preparation.databases,
      publicScaffold: compiled.preparation.publicScaffold,
      databaseBootstrapVariables: compiled.preparation.databaseBootstrapVariables,
      databaseBootstrapIntent: topology.transientBootstrap,
      maintenanceImage: { serviceName: "nautilo-server", image: server.image, releaseId: topology.releaseId },
    },
  };
}
