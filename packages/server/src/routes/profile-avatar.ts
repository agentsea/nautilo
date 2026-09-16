import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getProfileAvatarsRoot } from "@nautilo/config";
import { persistUploadedServerImage } from "../lib/server-image-upload";
import { SHELL_AVATAR_REF, type AvatarRef } from "@nautilo/types";
import { db, eq, users } from "@nautilo/db";
import { getProfile } from "@nautilo/agent";
import { sendAvatar } from "./_helpers/avatar";

const uploadedAvatarDir = () => join(getProfileAvatarsRoot(), "uploaded");

export function profileAvatarRoutes(
  app: FastifyInstance,
  deps?: { ownerId?: string | undefined },
) {
  // M128 D4-A: `deps.ownerId` no longer participates in any auth gate —
  // routes are session-user-scoped by construction (resolveSubjectUserId
  // returns request.sessionUserId). Kept in the signature for back-compat
  // with the existing call sites (app.ts + tests).
  void deps;
  // M125 Phase 2.1 — drop the bootstrap-owner fallback on the canonical
  // profile resolver. Pre-M125 any non-operator viewer hitting
  // `/api/profile/avatar` resolved through `deps?.ownerId` (the seeded
  // operator) and saw the operator's avatar bytes. The resolver now
  // uses the SESSION's identity so each user sees their own agent avatar.
  const resolveSubjectUserId = (request: FastifyRequest): string =>
    request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";

  const resolveCanonicalProfileUserId = (request: FastifyRequest): string =>
    resolveSubjectUserId(request);

  app.get("/api/profile/avatar", async (request, reply) => {
    const role = request.policyContext?.actorRole ?? "guest";
    const avatar = await resolveVisibleAvatar(resolveCanonicalProfileUserId(request), role);
    return sendAvatar(request, reply, avatar);
  });

  app.post("/api/profile/avatar", async (request, reply) => {
    const sessionUserId = request.sessionUserId;
    if (!sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const avatar = await persistUploadedServerImage(request, reply, uploadedAvatarDir());
    if (!avatar) return;

    // Old uploaded avatar blobs are not garbage-collected here; a separate sweep job handles that.
    // D208 — write to users.human_avatar_ref (the human's avatar), NOT
    // profiles.avatar_ref (which is the agent's avatar). The previous
    // upsertProfile call clobbered the agent avatar; see ISSUE-D208 for
    // the full data-model rationale.
    await db
      .update(users)
      .set({ humanAvatarRef: avatar })
      .where(eq(users.id, sessionUserId));

    return reply.send({ avatar });
  });

}

/**
 * Privacy gate for the owner's agent avatar: guests/strangers always see
 * SHELL; household/teammate viewers see the agent's avatar only when
 * `publicProfile=true`; owners always see their own.
 */
async function resolveVisibleAvatar(ownerId: string, role: string): Promise<AvatarRef> {
  if (role === "guest" || role === "stranger") return SHELL_AVATAR_REF;

  const profile = await getProfile(ownerId);
  if (!profile) return SHELL_AVATAR_REF;

  return profile.avatar ?? SHELL_AVATAR_REF;
}
