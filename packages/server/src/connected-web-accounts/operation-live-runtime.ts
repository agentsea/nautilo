import {
  getConnectedWebOperationToolRuntime,
  getConnectedWebOperationDirectToolRuntime,
  setConnectedWebOperationDirectToolRuntime,
  setConnectedWebOperationToolRuntime,
} from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";

import {
  BROWSER_USE_DEFAULT_MODEL,
  type BrowserUseCloudAdapter,
} from "../browser-use/browser-use-cloud";
import {
  createConnectedWebOperationProductionRuntime,
  type ConnectedWebOperationProductionRuntimeScheduler,
} from "./operation-production-runtime";
import { ConnectedWebOperationSecrets } from "./operation-secrets";
import { createConnectedWebOperationManagementProductionRuntime } from "./read-tool-runtime-composition";
import type { ConnectedWebAccountStore } from "./store";
import type { ConnectedWebOperationDirectRuntime } from "./operation-direct-runtime";

export interface ConnectedWebOperationLiveRuntimeOptions {
  readonly db: DirectDatabase;
  readonly store: ConnectedWebAccountStore;
  readonly provider: BrowserUseCloudAdapter;
  /** Stable server-owned material resolved only after the HTTP listener exists. */
  readonly stableServerSecret?: string;
  /** Caller may share the exact listener-owned codec with read admission. */
  readonly secrets?: ConnectedWebOperationSecrets;
  /** Test-only scheduling seam inherited from the durable production pump. */
  readonly scheduler?: ConnectedWebOperationProductionRuntimeScheduler;
  /** Installed only by the listener once its direct Browser Use authorities exist. */
  readonly directRuntime?: ConnectedWebOperationDirectRuntime;
}

/**
 * One listener-owned connected-web runtime. The same domain-separated secret
 * instance opens management coordinates and durable supervisor checkpoints.
 */
export function createConnectedWebOperationLiveRuntime(
  options: ConnectedWebOperationLiveRuntimeOptions,
): { start(): Promise<void>; stop(): Promise<void> } {
  const secrets = options.secrets ?? (options.stableServerSecret === undefined
    ? (() => { throw new Error("connected website operation secret is required"); })()
    : new ConnectedWebOperationSecrets({ stableServerSecret: options.stableServerSecret }));
  const management = createConnectedWebOperationManagementProductionRuntime({
    db: options.db,
    store: options.store,
    provider: options.provider,
    secrets,
    continuationModel: BROWSER_USE_DEFAULT_MODEL,
    ...(options.directRuntime === undefined ? {} : { direct: options.directRuntime }),
  });
  const production = createConnectedWebOperationProductionRuntime({
    db: options.db,
    store: options.store,
    provider: options.provider,
    secrets,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  let started = false;

  return {
    async start() {
      if (started) return;
      try {
        await options.directRuntime?.recover();
        production.start();
        setConnectedWebOperationToolRuntime(management);
        setConnectedWebOperationDirectToolRuntime(options.directRuntime ?? null);
        started = true;
      } catch (error) {
        production.stop();
        if (getConnectedWebOperationToolRuntime() === management) {
          setConnectedWebOperationToolRuntime(null);
        }
        if (getConnectedWebOperationDirectToolRuntime() === options.directRuntime) {
          setConnectedWebOperationDirectToolRuntime(null);
        }
        throw error;
      }
    },
    async stop() {
      production.stop();
      if (getConnectedWebOperationToolRuntime() === management) {
        setConnectedWebOperationToolRuntime(null);
      }
      if (getConnectedWebOperationDirectToolRuntime() === options.directRuntime) {
        setConnectedWebOperationDirectToolRuntime(null);
      }
      // The private agent-browser daemon must exit and the exact Browser Use
      // browser must be stopped before listener-owned filesystem authority is
      // allowed to disappear.
      await options.directRuntime?.stop();
      started = false;
    },
  };
}
