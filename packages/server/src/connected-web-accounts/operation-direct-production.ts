import { createHash } from "node:crypto";
import { canRunWebsiteTask } from "./website-task-contract";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedWebOperationProviderReferences, DirectDatabase } from "@nautilo/db";
import type { BrowserUseCloudAdapter } from "../browser-use/browser-use-cloud";
import { navigateBrowserUseCdpPage, resolveBrowserUseCdpWebSocketUrl } from "./cdp-navigator";
import { createServerDirectBrowserDirectoryAuthority } from "./direct-browser-directory-authority";
import { createServerDirectBrowserHarness, resolveServerVendoredAgentBrowserBinary } from "./direct-browser-harness";
import { DirectBrowserRouter } from "./direct-browser-router";
import { ConnectedWebOperationDirectRuntime } from "./operation-direct-runtime";
import { recoverDirectConnectedWebOperation, recoverDirectConnectedWebOperations } from "./operation-direct-recovery";
import type { ConnectedWebOperationSecrets } from "./operation-secrets";
import {
  hasExactOwnedConnectedWebGenie,
  isOwnersPersonalConnectedWebPrivateRoom,
} from "./read-tool-runtime-composition";
import type { ConnectedWebAccountStore, ConnectedWebOperation } from "./store";

export interface ConnectedWebOperationDirectProductionOptions {
  readonly db: DirectDatabase;
  readonly store: ConnectedWebAccountStore;
  readonly provider: BrowserUseCloudAdapter;
  readonly secrets: ConnectedWebOperationSecrets;
  /** Stable local instance identity; used only as input to path hashing. */
  readonly instanceIdentity: string;
}

export function directBrowserPrivateRoot(instanceIdentity: string, platform: NodeJS.Platform = process.platform): string {
  const suffix = createHash("sha256").update(instanceIdentity).digest("hex").slice(0, 16);
  return platform === "win32"
    ? join(tmpdir(), `nwc-${suffix}`)
    : `${platform === "darwin" ? "/private/tmp" : "/tmp"}/nwc-${suffix}`;
}

function secretContext(operation: { readonly id: string; readonly ownerUserId: string; readonly accountId: string | null }) {
  return { operationId: operation.id, ownerUserId: operation.ownerUserId, accountId: operation.accountId };
}

/** Listener-only production composition. No authority is constructed by inject(). */
export function createConnectedWebOperationDirectProductionRuntime(
  options: ConnectedWebOperationDirectProductionOptions,
): ConnectedWebOperationDirectRuntime {
  const directories = createServerDirectBrowserDirectoryAuthority({
    rootDirectory: directBrowserPrivateRoot(options.instanceIdentity),
    instanceIdentity: options.instanceIdentity,
  });
  const harness = createServerDirectBrowserHarness();
  const providerReferences = {
    unseal(input: { readonly operation: ConnectedWebOperation; readonly references: ConnectedWebOperationProviderReferences }) {
      const coordinates = options.secrets.unsealProviderReferences({
        context: secretContext(input.operation), references: input.references,
      });
      return Promise.resolve({ sessionId: coordinates.sessionId ?? null });
    },
    sealBrowserRef(input: { readonly operation: ConnectedWebOperation; readonly browserId: string }) {
      const context = secretContext(input.operation);
      const current = options.secrets.unsealProviderReferences({ context, references: input.operation.sealedProviderRefs });
      return Promise.resolve(options.secrets.sealProviderReferences({ context, coordinates: { ...current, browserId: input.browserId } }));
    },
  };
  const router = new DirectBrowserRouter({
    store: options.store,
    provider: options.provider,
    providerReferences,
    hostedLifecycle: {
      async hasTerminalProof({ operation }) {
        try {
          const runId = options.secrets.unsealProviderReferences({
            context: secretContext(operation), references: operation.sealedProviderRefs,
          }).runId;
          if (!runId) return false;
          const observed = await options.provider.pollHostedReadRun(runId);
          return !("kind" in observed)
            && observed.runId === runId
            && (observed.status === "completed" || observed.status === "failed" || observed.status === "cancelled");
        } catch { return false; }
      },
    },
    directories,
    harness,
    resolveCdpWebSocketUrl: resolveBrowserUseCdpWebSocketUrl,
    navigateSavedProfileBrowser: navigateBrowserUseCdpPage,
    // Browser Use V4 itself permits at most 240 minutes. This is provider
    // lifecycle policy, not an operation/Genie wall-clock limit.
    browserTimeoutMinutes: 240,
  });
  const facts = {
    hasExactOwnedGenie: (input: { readonly ownerUserId: string; readonly agentId: string }) => hasExactOwnedConnectedWebGenie(options.db, input),
    isOwnersPersonalPrivateRoom: (input: { readonly ownerUserId: string; readonly agentId: string; readonly roomId: string }) => isOwnersPersonalConnectedWebPrivateRoom(options.db, input),
  };
  return new ConnectedWebOperationDirectRuntime({
    authorizeOperation: (actor, operation) => {
      try {
        const intent = JSON.parse(options.secrets.unsealIntent({ context: secretContext(operation), sealedIntent: operation.sealedIntent })) as Record<string, unknown>;
        return intent["kind"] === "run_website_task" ? canRunWebsiteTask(actor)
          : intent["kind"] === "read_connected_web_account" && ["allow", "read_only"].includes(actor.memoryAccessEnvelope.toolPolicy["read_connected_web_account"] ?? "forbidden");
      } catch { return false; }
    },
    checkAvailability: async () => { await resolveServerVendoredAgentBrowserBinary(); },
    facts,
    store: options.store,
    router,
    recoverOperation: (operation) => recoverDirectConnectedWebOperation({
      store: options.store, secrets: options.secrets, provider: options.provider, directories, harness,
    }, operation),
    recover: () => recoverDirectConnectedWebOperations({
      store: options.store,
      secrets: options.secrets,
      provider: options.provider,
      directories,
      harness,
    }),
  });
}
