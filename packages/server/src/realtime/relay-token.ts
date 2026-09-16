/**
 * M056 — Relay token validation helper, used inside the
 * `relay:register` switch arm of `relay-endpoint.ts`.
 *
 * The `/relay` Fastify WebSocket route bypasses the trust preHandler
 * (preHandler runs on HTTP route handlers, not WS upgrades), so token
 * validation MUST live in the message handler itself. This helper
 * resolves a plaintext relay token to its owning `(userId, actorId)`
 * pair so the endpoint can:
 *
 *   1. Reject missing / invalid / revoked tokens (Logto-backed
 *      deployments only).
 *   2. STAMP `validated.userId` over `msg.userId` before calling
 *      `registry.register(...)` — this is the spoof-closure: a relay
 *      holding any valid token can no longer impersonate other users
 *      by lying in the register payload.
 *   3. Best-effort touch `last_seen_at` so the Manage Devices UI
 *      reflects connection activity.
 */

import { createHash } from "node:crypto";
import { getRelayTokenStore } from "../lib/relay-token-store";

export interface ValidatedRelayToken {
  readonly userId: string;
  readonly actorId: string;
  /**
   * The validated relay-token row id. D418 Commit 2 — this is the
   * server-derived `pairingGeneration`: it changes on explicit re-pair and
   * is never client-authored. The relay endpoint stamps it onto the relay
   * registry entry so the binding provider + plan re-validation can pin a
   * Full Workstation session to an exact pairing generation.
   */
  readonly tokenId: string;
}

/** Token format prefix (192 bits base64url after the underscore). */
export const RELAY_TOKEN_PREFIX = "rty_";

/**
 * Returns the validated `(userId, actorId, tokenId)` for the
 * supplied plaintext token, or null if the token is missing,
 * malformed, unknown, or revoked. Never throws.
 *
 * Successful lookups schedule a fire-and-forget last-seen update;
 * its failure is swallowed and does NOT reject the validation
 * promise.
 */
export async function validateRelayToken(
  plaintextToken: string | undefined,
): Promise<ValidatedRelayToken | null> {
  if (!plaintextToken || !plaintextToken.startsWith(RELAY_TOKEN_PREFIX)) {
    return null;
  }
  const hash = createHash("sha256").update(plaintextToken).digest("hex");
  const store = getRelayTokenStore();
  const row = await store.findActiveByHash(hash);
  if (!row) return null;

  // Best-effort last-seen bump. Failures here must NOT propagate —
  // a transient DB hiccup shouldn't deny a valid relay registration.
  void store.touchLastSeen(row.id).catch(() => {
    /* swallow */
  });

  return { userId: row.userId, actorId: row.actorId, tokenId: row.id };
}
