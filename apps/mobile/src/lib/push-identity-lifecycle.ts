/**
 * D468 — one exact-binding cleanup seam for Human identity transitions.
 *
 * A push binding is a server capability belonging to one verified Human, not
 * merely to a URL in the Mobile registry.  This module is deliberately
 * imperative so AuthProvider can run it before it erases the old bearer or
 * viewer.  It never persists or returns a bearer: failed authenticated
 * cleanup falls back to the binding's revoke-only proof tombstone.
 */
import { NautiloApiClient } from "@nautilo/api-client/browser";

import {
  clearPushBinding,
  loadPushBinding,
  queuePushBindingRevokeAndClear,
  type PushBinding,
  type PushBindingStore,
} from "./push-binding-store";
import { beginServerIdentityTransition } from "./server-store";

type AuthenticatedPushClient = Pick<NautiloApiClient, "setToken" | "revokePushInstallation">;

export type PushIdentityReleaseResult =
  | "no_binding"
  | "unchanged_owner"
  | "authenticated_revoked"
  | "proof_tombstoned"
  | "superseded";

export interface PushIdentityLifecycleDeps {
  readonly loadBinding: (serverId: string) => Promise<PushBinding | null>;
  readonly clearBinding: PushBindingStore["clearBinding"];
  readonly queueRevokeAndClearBinding: PushBindingStore["queueRevokeAndClearBinding"];
  readonly beginIdentityTransition: (serverId: string) => void;
  readonly createClient: (serverUrl: string) => AuthenticatedPushClient;
}

const defaultDeps: PushIdentityLifecycleDeps = {
  loadBinding: loadPushBinding,
  clearBinding: clearPushBinding,
  queueRevokeAndClearBinding: queuePushBindingRevokeAndClear,
  beginIdentityTransition: beginServerIdentityTransition,
  createClient: (serverUrl) => new NautiloApiClient(serverUrl),
};

export interface ReleasePushBindingForIdentityInput {
  readonly serverId: string;
  readonly serverUrl: string;
  /** Present only while an old session can still authorize exact revocation. */
  readonly bearerToken: string | null;
  /**
   * Omit for logout/terminal session loss.  Supplying a different verified
   * Human releases the old binding before the new bearer may be committed.
   */
  readonly nextOwnerUserId?: string;
}

export interface PushIdentityLifecycle {
  releaseForIdentity(input: ReleasePushBindingForIdentityInput): Promise<PushIdentityReleaseResult>;
}

function validOwnerUserId(value: string | undefined): boolean {
  return value === undefined || (value.trim().length > 0 && value.length <= 180);
}

/**
 * Coalesce only same-server transitions.  The lifecycle revision fence is
 * installed before network work, so an in-flight registration/refresh cannot
 * acknowledge or commit after this operation has begun.
 */
export function createPushIdentityLifecycle(
  supplied: Partial<PushIdentityLifecycleDeps> = {},
): PushIdentityLifecycle {
  const deps: PushIdentityLifecycleDeps = { ...defaultDeps, ...supplied };
  const tails = new Map<string, Promise<void>>();

  function serialize<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const prior = tails.get(serverId) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(operation);
    const tail = result.then(() => {}, () => {});
    tails.set(serverId, tail);
    void tail.finally(() => {
      if (tails.get(serverId) === tail) tails.delete(serverId);
    });
    return result;
  }

  return {
    releaseForIdentity(input) {
      if (!validOwnerUserId(input.nextOwnerUserId)) {
        return Promise.reject(new Error("invalid Mobile push binding owner"));
      }
      return serialize(input.serverId, async () => {
        const binding = await deps.loadBinding(input.serverId);
        if (!binding) {
          // Explicit logout/session loss still fences a concurrently running
          // token refresh even if this Human never granted notifications.
          if (input.nextOwnerUserId === undefined) deps.beginIdentityTransition(input.serverId);
          return "no_binding";
        }
        const sameOwner = input.nextOwnerUserId !== undefined
          && binding.ownerUserId === input.nextOwnerUserId;

        // Explicit logout/session loss has to fence refresh/reconciliation even
        // if the user never granted push. Account-preserving refreshes do not.
        if (!sameOwner) deps.beginIdentityTransition(input.serverId);
        if (sameOwner) return "unchanged_owner";

        if (input.bearerToken) {
          try {
            const client = deps.createClient(input.serverUrl);
            client.setToken(input.bearerToken);
            await client.revokePushInstallation(binding.bindingId);
            return (await deps.clearBinding({
              serverId: input.serverId,
              bindingId: binding.bindingId,
            })) ? "authenticated_revoked" : "superseded";
          } catch {
            // The proof-only path below is intentionally the only recovery.
            // It persists no Logto access or refresh credential.
          }
        }

        return (await deps.queueRevokeAndClearBinding({
          serverId: input.serverId,
          serverUrl: input.serverUrl,
          expectedBindingId: binding.bindingId,
        })) ? "proof_tombstoned" : "superseded";
      });
    },
  };
}

const defaultLifecycle = createPushIdentityLifecycle();

export const releasePushBindingForIdentity = defaultLifecycle.releaseForIdentity.bind(defaultLifecycle);
