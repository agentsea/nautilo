import {
  reconcileHostedCluster,
  type HostedClusterAdminAdapter,
  type HostedClusterReconciliationResult,
} from "../utils/hosted-cluster-reconcile";
import {
  readHostedBootstrapConfig,
  type HostedBootstrapConfig,
  type HostedBootstrapEnvironment,
} from "./env";
import { createPostgresHostedClusterAdminAdapter } from "./postgres-adapter";

export { HostedBootstrapInputError, readHostedBootstrapConfig } from "./env";
export type {
  HostedBootstrapConfig,
  HostedBootstrapEnvironment,
  HostedBootstrapInputErrorCode,
} from "./env";
export interface ClosableHostedClusterAdminAdapter extends HostedClusterAdminAdapter {
  close(): Promise<void>;
}

export type HostedBootstrapAdapterFactory = (
  adminConnectionUrl: string,
) => ClosableHostedClusterAdminAdapter;

export type HostedBootstrapResult =
  | {
      readonly status: "succeeded";
      readonly clusters: readonly HostedClusterReconciliationResult[];
    }
  | {
      readonly status: "failed";
      readonly clusters: readonly HostedClusterReconciliationResult[];
      readonly failure: {
        readonly kind: "reconciliation-failed" | "adapter-construction-failed";
        readonly cluster: "app" | "logto";
      };
    };

async function reconcileOne(
  cluster: "app" | "logto",
  adminConnectionUrl: string,
  config: HostedBootstrapConfig,
  createAdapter: HostedBootstrapAdapterFactory,
): Promise<HostedClusterReconciliationResult | undefined> {
  let adapter: ClosableHostedClusterAdminAdapter | undefined;
  try {
    adapter = createAdapter(adminConnectionUrl);
    return await reconcileHostedCluster(
      adapter,
      cluster === "app"
        ? { cluster, credentials: config.app.credentials }
        : { cluster, credentials: config.logto.credentials },
    );
  } finally {
    await adapter?.close().catch(() => undefined);
  }
}

/**
 * Reconcile the two isolated clusters in dependency order. This is a one-shot
 * operation: any failed first cluster leaves a safe typed receipt and stops,
 * so retry can converge from the checkpoints without touching Logto early.
 */
export async function runHostedBootstrap(
  config: HostedBootstrapConfig,
  createAdapter: HostedBootstrapAdapterFactory = createPostgresHostedClusterAdminAdapter,
): Promise<HostedBootstrapResult> {
  const clusters: HostedClusterReconciliationResult[] = [];
  for (const cluster of ["app", "logto"] as const) {
    const adminConnectionUrl = cluster === "app"
      ? config.app.adminConnectionUrl
      : config.logto.adminConnectionUrl;
    let result: HostedClusterReconciliationResult | undefined;
    try {
      result = await reconcileOne(cluster, adminConnectionUrl, config, createAdapter);
    } catch {
      return {
        status: "failed",
        clusters,
        failure: { kind: "adapter-construction-failed", cluster },
      };
    }
    if (!result) {
      return {
        status: "failed",
        clusters,
        failure: { kind: "adapter-construction-failed", cluster },
      };
    }
    clusters.push(result);
    if (result.status === "failed") {
      return {
        status: "failed",
        clusters,
        failure: { kind: "reconciliation-failed", cluster },
      };
    }
  }
  return { status: "succeeded", clusters };
}

export async function runHostedBootstrapFromEnvironment(
  environment: HostedBootstrapEnvironment = process.env,
  createAdapter: HostedBootstrapAdapterFactory = createPostgresHostedClusterAdminAdapter,
): Promise<HostedBootstrapResult> {
  return runHostedBootstrap(readHostedBootstrapConfig(environment), createAdapter);
}
