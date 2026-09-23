import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  ServerProviderCredentialsDeniedError,
  assertCanUseServerProviderCredentials,
  envelopeWritableNamespaces,
} from "@nautilo/trust";
import { getUserCapabilities } from "@nautilo/trust";
import {
  ConnectedAppDisconnectResponseSchema,
  ConnectedAppOAuthAttemptResponseSchema,
  ConnectedAppOAuthStartResponseSchema,
  ConnectedAppProviderSetupRequestSchema,
  ConnectedAppProviderSetupSchema,
  ConnectedAppProviderIdSchema,
  ConnectedAppsResponseSchema,
} from "@nautilo/types";
import {
  ConnectedAppService,
  ConnectedAppServiceError,
} from "../connected-apps/service";
import {
  ConnectedAppResultMediaError,
  type ConnectedAppResultPresenter,
} from "../connected-apps/result-presentation";

const ProviderParamsSchema = z.object({ providerId: ConnectedAppProviderIdSchema }).strict();
const ProviderAttemptParamsSchema = ProviderParamsSchema.extend({ attemptId: z.string().uuid() }).strict();
const ResultMediaQuerySchema = z.object({
  ref: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  roomId: z.string().uuid(),
}).strict();

function scope(request: FastifyRequest): { userId: string; namespaceId: string } {
  if (!request.sessionUserId) {
    throw new ConnectedAppServiceError("authentication_required", 401);
  }
  const namespaceId = envelopeWritableNamespaces(request.memoryEnvelope)[0];
  if (!namespaceId) {
    throw new ConnectedAppServiceError("connected_app_namespace_required", 409);
  }
  return { userId: request.sessionUserId, namespaceId };
}

async function sendSafely(
  reply: FastifyReply,
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectedAppServiceError) {
      return reply.code(error.status).send({ error: error.code });
    }
    if (error instanceof ConnectedAppResultMediaError) {
      return reply.code(error.status).send({ error: error.code });
    }
    if (error instanceof ServerProviderCredentialsDeniedError) {
      return reply.code(403).send({ error: error.code });
    }
    throw error;
  }
}

/** Human×Namespace connected-app API. Driver routing handles never cross it. */
export function connectedAppsRoutes(
  app: FastifyInstance,
  serviceOrServices: ConnectedAppService | readonly ConnectedAppService[] | (() => readonly ConnectedAppService[]),
  options: {
    getCapabilities?: typeof getUserCapabilities;
    assertServerFunding?: typeof assertCanUseServerProviderCredentials;
    resultPresenter?: ConnectedAppResultPresenter;
  } = {},
): void {
  const services = (): readonly ConnectedAppService[] => typeof serviceOrServices === "function"
    ? serviceOrServices()
    : Array.isArray(serviceOrServices)
      ? serviceOrServices as readonly ConnectedAppService[]
      : [serviceOrServices as ConnectedAppService];
  const serviceFor = (providerId: string): ConnectedAppService => {
    const current = services();
    const service = current.find((candidate) => candidate.providerId === providerId);
    if (!service) throw new ConnectedAppServiceError("connected_app_provider_not_found", 404);
    return service;
  };
  const resolveCapabilities = options.getCapabilities ?? getUserCapabilities;
  const requireHostedFunding = async (service: ConnectedAppService, userId: string, origin: string): Promise<void> => {
    if (service.usesHostedDriver) {
      await (options.assertServerFunding ?? assertCanUseServerProviderCredentials)(userId, origin);
    }
  };
  const canManage = async (request: FastifyRequest): Promise<boolean> => {
    if (!request.sessionUserId) throw new ConnectedAppServiceError("authentication_required", 401);
    return (await resolveCapabilities(request.sessionUserId)).includes("manage_connection_providers");
  };
  const requireManager = async (request: FastifyRequest): Promise<void> => {
    if (!(await canManage(request))) throw new ConnectedAppServiceError("connected_app_setup_forbidden", 403);
  };
  app.get("/connections/oauth/complete", async (_request, reply) => reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Nautilo</title><style>body{margin:0;background:#111;color:#f5f5f5;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:32rem;padding:2rem;text-align:center}p{color:#aaa;line-height:1.5}</style></head><body><main><h1>Return to Nautilo</h1><p>Your account has returned control to Nautilo. Go back to the Nautilo app while it verifies your connection. You can close this page.</p></main></body></html>`));

  app.get<{ Querystring: { ref: string; roomId: string } }>("/api/connected-apps/result-media", async (request, reply) =>
    sendSafely(reply, async () => {
      const actorScope = scope(request);
      const parsed = ResultMediaQuerySchema.safeParse(request.query);
      if (!parsed.success || !options.resultPresenter) {
        throw new ConnectedAppResultMediaError("connected_app_preview_not_found", 404);
      }
      const preview = await options.resultPresenter.readPreview({
        scope: actorScope,
        ref: parsed.data.ref,
      });
      return reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        .header("X-Content-Type-Options", "nosniff")
        .type(preview.contentType)
        .send(Readable.from(preview.chunks));
    }));

  app.get("/api/connected-apps", async (request, reply) =>
    sendSafely(reply, async () => {
      const actorScope = scope(request);
      const scopeRoomId = request.memoryEnvelope?.roomId;
      if (!scopeRoomId) {
        throw new ConnectedAppServiceError("connected_app_room_required", 409);
      }
      const canManageConnectionProviders = await canManage(request);
      return ConnectedAppsResponseSchema.parse({
        status: "ok",
        scopeRoomId,
        apps: (await Promise.all(services().map((service) => service.list(
          actorScope,
          { canManageConnectionProviders },
        )))).flat(),
      });
    }));

  app.get<{ Params: { providerId: string } }>("/api/connected-apps/:providerId/setup", async (request, reply) =>
    sendSafely(reply, async () => {
      scope(request);
      await requireManager(request);
      const parsed = ProviderParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new ConnectedAppServiceError("connected_app_provider_not_found", 404);
      return ConnectedAppProviderSetupSchema.parse(await serviceFor(parsed.data.providerId).getProviderSetup());
    }));

  app.put<{ Params: { providerId: string } }>("/api/connected-apps/:providerId/setup", async (request, reply) =>
    sendSafely(reply, async () => {
      const actorScope = scope(request);
      await requireManager(request);
      const parsedParams = ProviderParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw new ConnectedAppServiceError("connected_app_provider_not_found", 404);
      const body = ConnectedAppProviderSetupRequestSchema.safeParse(request.body);
      if (!body.success) throw new ConnectedAppServiceError("connected_app_setup_input_invalid", 400);
      return ConnectedAppProviderSetupSchema.parse(
        await serviceFor(parsedParams.data.providerId).configureProvider(actorScope, body.data),
      );
    }));

  app.post<{ Params: { providerId: string } }>("/api/connected-apps/:providerId/oauth", async (request, reply) =>
    sendSafely(reply, async () => {
      const parsed = ProviderParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new ConnectedAppServiceError("connected_app_provider_not_found", 404);
      const service = serviceFor(parsed.data.providerId);
      const actorScope = scope(request);
      await requireHostedFunding(service, actorScope.userId, "connected_app_oauth_start");
      return ConnectedAppOAuthStartResponseSchema.parse(
        await service.startOauth(actorScope),
      );
    }));

  app.get<{ Params: { providerId: string; attemptId: string } }>(
    "/api/connected-apps/:providerId/oauth/:attemptId",
    async (request, reply) => sendSafely(reply, async () => {
      const parsed = ProviderAttemptParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new ConnectedAppServiceError("connected_app_attempt_not_found", 404);
      const service = serviceFor(parsed.data.providerId);
      const actorScope = scope(request);
      await requireHostedFunding(service, actorScope.userId, "connected_app_oauth_inspect");
      return ConnectedAppOAuthAttemptResponseSchema.parse(
        await service.inspectAttempt(actorScope, parsed.data.attemptId),
      );
    }),
  );

  app.delete<{ Params: { providerId: string; attemptId: string } }>(
    "/api/connected-apps/:providerId/oauth/:attemptId",
    async (request, reply) => sendSafely(reply, async () => {
      const parsed = ProviderAttemptParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new ConnectedAppServiceError("connected_app_attempt_not_found", 404);
      return ConnectedAppOAuthAttemptResponseSchema.parse(
        await serviceFor(parsed.data.providerId).cancelAttempt(scope(request), parsed.data.attemptId),
      );
    }),
  );

  app.delete<{ Params: { providerId: string } }>("/api/connected-apps/:providerId", async (request, reply) =>
    sendSafely(reply, async () => {
      const parsed = ProviderParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new ConnectedAppServiceError("connected_app_provider_not_found", 404);
      return ConnectedAppDisconnectResponseSchema.parse(
        await serviceFor(parsed.data.providerId).disconnect(scope(request)),
      );
    }));
}
