import {
  RailwayGraphqlReconcileExecutor,
  type RailwayGraphqlReconcileExecutorOptions,
} from "./reconcile-executor";
import type { RailwayWholeManifestUpgradeExecutor } from "./whole-manifest-upgrade";

/**
 * Concrete Railway GraphQL executor for the durable whole-manifest state
 * machine. The coordinator, rather than this adapter, owns create-once
 * migration recovery and every effect checkpoint.
 */
export class RailwayGraphqlWholeManifestUpgradeExecutor
  extends RailwayGraphqlReconcileExecutor
  implements RailwayWholeManifestUpgradeExecutor {
  constructor(options: RailwayGraphqlReconcileExecutorOptions) {
    super(options);
  }
}

export type RailwayGraphqlWholeManifestUpgradeExecutorOptions = RailwayGraphqlReconcileExecutorOptions;
