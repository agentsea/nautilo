import type { FastifyInstance } from "fastify";
import { error as logError } from "@nautilo/logger";
import { updateOwnerName, updateOwnerHandle } from "@nautilo/db";
import { normalizeHandle, validateHandle } from "@nautilo/config";
import { isLocalhostIp } from "@nautilo/config-guard";
import type { PinChallengeProvider } from "@nautilo/trust";

export interface OwnerRouteDeps {
  ownerId: string;
  pinProvider: PinChallengeProvider;
}

export function ownerRoutes(app: FastifyInstance, deps: OwnerRouteDeps) {
  const { ownerId, pinProvider } = deps;

  async function canMutateOwner(request: { ip: string; sessionUserId?: string | null }): Promise<boolean> {
    // M128 D5 (2026-05-28): "owner of agent" is retired as an RBAC
    // concept. This route mutates the *bootstrap-owner singleton's* user
    // row (the `ownerId` captured at routing construction); the per-
    // profile gate is "is the caller that same user?" Pre-PIN onboarding
    // remains loopback-only as before.
    const enrolled = await pinProvider.isEnrolled(ownerId);
    if (!enrolled) return isLocalhostIp(request.ip);
    return request.sessionUserId === ownerId;
  }

  /**
   * PUT /api/owner — update the owner's display name.
   * Called during the onboarding wizard Owner Setup screen.
   * Public during initial setup (before PIN enrolled); after PIN enrolled
   * this is called with a Bearer token from the wizard.
   */
  app.put<{ Body: { name?: string; displayName?: string; handle?: string } }>("/api/owner", async (request, reply) => {
    if (!(await canMutateOwner(request))) {
      return reply.code(401).send({ error: "owner required" });
    }
    const { name, displayName, handle } = request.body ?? {};
    const nextName = typeof displayName === "string" ? displayName : name;
    if (!nextName || typeof nextName !== "string" || nextName.trim().length === 0) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (nextName.trim().length > 100) {
      return reply.code(400).send({ error: "name must be 100 characters or fewer" });
    }

    try {
      await updateOwnerName(ownerId, nextName.trim());
      let handleResult:
        | { handle: string; federatedId: string }
        | null = null;
      if (typeof handle === "string" && handle.trim().length > 0) {
        const normalized = normalizeHandle(handle);
        const validation = validateHandle(normalized);
        if (!validation.ok) {
          return reply.code(400).send({ error: validation.reason });
        }
        const result = await updateOwnerHandle(ownerId, normalized);
        if (!result.ok) {
          return reply.code(409).send({ error: result.reason });
        }
        handleResult = {
          handle: result.handle,
          federatedId: result.federatedId,
        };
      }
      return reply.send({ ok: true, name: nextName.trim(), ...handleResult });
    } catch (e) {
      logError("[owner] PUT /api/owner failed:", e instanceof Error ? e.stack ?? e.message : String(e));
      return reply.code(500).send({ error: "Failed to update owner name." });
    }
  });

  /**
   * M042C — PUT /api/owner/handle: update the owner's federated-id
   * handle (local part of `@handle@server`). Used by the onboarding
   * wizard and by future settings UIs. Atomically rebinds any
   * `channel_identities` rows that carried the old federated form.
   *
   * Requires the caller to be the owner actor. Onboarding runs this
   * before PIN is enrolled — in that window `/api/owner` (this file's
   * sibling route) is also public; we gate `/api/owner/handle` the
   * same way by checking that either (a) no PIN is enrolled yet
   * (wizard path) or (b) the caller has actor role 'owner' (post-PIN
   * settings path).
   *
   * In M042C onboarding is the sole wizard-era consumer; the settings
   * UI ships read-only per decision #20. So this route is exercised
   * exclusively by the wizard — but it's still gated in case a
   * future settings UI calls it.
   */
  app.put<{ Body: { handle: string } }>(
    "/api/owner/handle",
    async (request, reply) => {
      const body = request.body ?? { handle: "" };
      const raw = typeof body.handle === "string" ? body.handle : "";
      const normalized = normalizeHandle(raw);
      const validation = validateHandle(normalized);
      if (!validation.ok) {
        return reply.code(400).send({ error: validation.reason });
      }

      if (!(await canMutateOwner(request))) {
        return reply.code(401).send({ error: "owner required" });
      }

      try {
        const result = await updateOwnerHandle(ownerId, normalized);
        if (!result.ok) {
          return reply.code(409).send({ error: result.reason });
        }
        return reply.send({
          handle: result.handle,
          federatedId: result.federatedId,
        });
      } catch (e) {
        logError(
          "[owner] PUT /api/owner/handle failed:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply
          .code(500)
          .send({ error: "Failed to update owner handle." });
      }
    },
  );

  /**
   * M042C — POST /api/setup/validate-handle: pure format check used by
   * the onboarding wizard to validate the chosen handle before
   * calling PUT /api/owner/handle. Public (no auth): wizard runs
   * before PIN enrollment. Returns `{ ok, reason? }`.
   */
  app.post<{ Body: { handle?: string } }>(
    "/api/setup/validate-handle",
    async (request, reply) => {
      const raw =
        typeof request.body?.handle === "string" ? request.body.handle : "";
      const normalized = normalizeHandle(raw);
      const validation = validateHandle(normalized);
      if (validation.ok) {
        return reply.send({ ok: true, valid: true, normalized });
      }
      return reply.send({ ok: false, valid: false, reason: validation.reason });
    },
  );
}
