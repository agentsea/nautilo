/** D468 authenticated Mobile push-installation lifecycle surface. */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  mobilePushInstallationBadgePreferenceRequestSchema,
  mobilePushInstallationDisableRequestSchema,
  mobilePushInstallationProofRevokeRequestSchema,
  mobilePushInstallationRegisterRequestSchema,
  mobilePushInstallationTestRequestSchema,
} from "@nautilo/types";
import { z } from "zod";

import {
  getPushInstallationStore,
  PushInstallationStoreError,
  type PushInstallationStore,
} from "../push/push-installation-store";

const bindingIdParamsSchema = z.object({ bindingId: z.string().uuid() }).strict();

export interface PushNotificationRoutesDeps {
  readonly store?: PushInstallationStore;
}

function invalid(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: "Invalid push installation request",
    code: "invalid_push_installation",
  });
}

function storeError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!(error instanceof PushInstallationStoreError)) return null;
  switch (error.code) {
    case "invalid":
    case "not_found":
      // Both malformed and not-owned identifiers are intentionally rendered
      // as the same public error so an authenticated caller cannot probe
      // another Human's binding UUID.
      return invalid(reply);
    case "stale_generation":
      return reply.code(409).send({
        error: "This push token generation is no longer current",
        code: "stale_push_token_generation",
      });
    case "revoked":
      return reply.code(410).send({
        error: "This push installation has been revoked",
        code: "push_installation_revoked",
      });
    case "permission_denied":
      return reply.code(403).send({
        error: "Push delivery is disabled for this installation",
        code: "push_permission_denied",
      });
    case "unavailable":
      return reply.code(503).send({
        error: "Push delivery is temporarily unavailable",
        code: "push_unavailable",
      });
    case "test_rate_limited":
      return reply.code(429).send({
        error: "Please wait before sending another push test",
        code: "push_test_rate_limited",
      });
  }
}

async function requireAuthenticatedUser(
  request: { sessionUserId: string | null },
  reply: FastifyReply,
): Promise<string | null> {
  const userId = request.sessionUserId;
  if (!userId) {
    await reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

/**
 * The proof-only endpoint deliberately remains under the normal trust
 * preHandler as an anonymous request. It accepts no bearer token and returns
 * the same empty success for valid, invalid, absent, and already-revoked
 * bindings, so the proof is a deletion-only capability rather than discovery.
 */
export function pushNotificationRoutes(
  app: FastifyInstance,
  deps: PushNotificationRoutesDeps = {},
): void {
  const store = deps.store ?? getPushInstallationStore();

  app.post("/api/push/installations", async (request, reply) => {
    const userId = await requireAuthenticatedUser(request, reply);
    if (!userId) return;
    const body = mobilePushInstallationRegisterRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(reply);
    try {
      return reply.send(await store.register({ userId, request: body.data }));
    } catch (error) {
      const handled = storeError(reply, error);
      if (handled) return handled;
      throw error;
    }
  });

  app.get<{ Params: { bindingId: string } }>(
    "/api/push/installations/:bindingId",
    async (request, reply) => {
      const userId = await requireAuthenticatedUser(request, reply);
      if (!userId) return;
      const params = bindingIdParamsSchema.safeParse(request.params);
      if (!params.success) return invalid(reply);
      try {
        return reply.send(await store.getStatus({ userId, bindingId: params.data.bindingId }));
      } catch (error) {
        const handled = storeError(reply, error);
        if (handled) return handled;
        throw error;
      }
    },
  );

  app.patch<{ Params: { bindingId: string } }>(
    "/api/push/installations/:bindingId",
    async (request, reply) => {
      const userId = await requireAuthenticatedUser(request, reply);
      if (!userId) return;
      const params = bindingIdParamsSchema.safeParse(request.params);
      const body = mobilePushInstallationDisableRequestSchema.safeParse(request.body);
      if (!params.success || !body.success || params.data.bindingId !== body.data.bindingId) {
        return invalid(reply);
      }
      try {
        return reply.send(await store.disable({ userId, request: body.data }));
      } catch (error) {
        const handled = storeError(reply, error);
        if (handled) return handled;
        throw error;
      }
    },
  );

  app.put<{ Params: { bindingId: string } }>(
    "/api/push/installations/:bindingId/badge-preference",
    async (request, reply) => {
      const userId = await requireAuthenticatedUser(request, reply);
      if (!userId) return;
      const params = bindingIdParamsSchema.safeParse(request.params);
      const body = mobilePushInstallationBadgePreferenceRequestSchema.safeParse(request.body);
      if (!params.success || !body.success || params.data.bindingId !== body.data.bindingId) {
        return invalid(reply);
      }
      try {
        return reply.send(await store.setBadgePreference({ userId, request: body.data }));
      } catch (error) {
        const handled = storeError(reply, error);
        if (handled) return handled;
        throw error;
      }
    },
  );

  app.delete<{ Params: { bindingId: string } }>(
    "/api/push/installations/:bindingId",
    async (request, reply) => {
      const userId = await requireAuthenticatedUser(request, reply);
      if (!userId) return;
      const params = bindingIdParamsSchema.safeParse(request.params);
      if (!params.success) return invalid(reply);
      try {
        await store.revokeForUser({ userId, bindingId: params.data.bindingId });
        return reply.code(204).send();
      } catch (error) {
        const handled = storeError(reply, error);
        if (handled) return handled;
        throw error;
      }
    },
  );

  app.post<{ Params: { bindingId: string } }>(
    "/api/push/installations/:bindingId/revoke",
    async (request, reply) => {
      const params = bindingIdParamsSchema.safeParse(request.params);
      const body = mobilePushInstallationProofRevokeRequestSchema.safeParse(request.body);
      // Do not emit a distinct parse/status result on this capability route.
      // A malformed proof is exactly as non-enumerating as a wrong proof.
      if (!params.success || !body.success || params.data.bindingId !== body.data.bindingId) {
        return reply.code(204).send();
      }
      try {
        await store.revokeWithProof({
          bindingId: params.data.bindingId,
          revokeProof: body.data.revokeProof,
        });
      } catch (error) {
        // A storage outage must not claim terminal cleanup; all proof/content
        // failures remain deliberately indistinguishable success responses.
        if (error instanceof PushInstallationStoreError && error.code === "unavailable") {
          return storeError(reply, error)!;
        }
        if (!(error instanceof PushInstallationStoreError)) {
          throw error;
        }
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { bindingId: string } }>(
    "/api/push/installations/:bindingId/test",
    async (request, reply) => {
      const userId = await requireAuthenticatedUser(request, reply);
      if (!userId) return;
      const params = bindingIdParamsSchema.safeParse(request.params);
      const body = mobilePushInstallationTestRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) return invalid(reply);
      try {
        const testIntent = await store.enqueueGenericTest({
          userId,
          bindingId: params.data.bindingId,
        });
        return reply.send({ accepted: true, notificationId: testIntent.notificationId });
      } catch (error) {
        const handled = storeError(reply, error);
        if (handled) return handled;
        throw error;
      }
    },
  );
}
