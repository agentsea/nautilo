import type { FastifyInstance, FastifyReply } from "fastify";
import {
  connectedWebAccountCreateRequestSchema,
  connectedWebAccountCancelLoginRequestSchema,
  connectedWebAccountCancelLoginResponseSchema,
  connectedWebAccountCancelReadRequestSchema,
  connectedWebAccountCancelReadResponseSchema,
  connectedWebAccountClosePageRequestSchema,
  connectedWebAccountClosePageResponseSchema,
  connectedWebAccountDisconnectResponseSchema,
  connectedWebAccountFinishRequestSchema,
  connectedWebAccountIdSchema,
  connectedWebAccountListResponseSchema,
  connectedWebAccountLoginResponseSchema,
  connectedWebAccountOpenPageRequestSchema,
  connectedWebAccountReconnectRequestSchema,
  connectedWebAccountReadActivitySchema,
  connectedWebAccountReadWatchRequestSchema,
  connectedWebAccountReadWatchSchema,
  connectedWebAccountActionActivitySchema,
  connectedWebAccountActionDeliveryIdSchema,
  connectedWebAccountActionWatchRequestSchema,
  connectedWebAccountActionWatchSchema,
  connectedWebAccountStopActionRequestSchema,
  connectedWebAccountStopActionResponseSchema,
  connectedWebAccountSchema,
  type ConnectedWebAccount,
  type ConnectedWebAccountCreateRequest,
  type ConnectedWebAccountLoginResponse,
  type ConnectedWebAccountReadActivity,
  type ConnectedWebAccountReadWatch,
  type ConnectedWebAccountActionActivity,
  type ConnectedWebAccountActionWatch,
  type ConnectedWebAccountProviderSetupStatus,
} from "@nautilo/types";
import { ConnectedWebAccountStoreError } from "../connected-web-accounts/store";
import { ConnectedWebAccountControllerError } from "../connected-web-accounts/controller";

const WEBSITE_SESSION_WARNING = "Disconnecting Nautilo does not sign you out of the website. Use the website's sign out other sessions control if needed." as const;

/**
 * Provider-aware orchestration is injected here rather than made an HTTP
 * concern. Routes expose only owner-scoped product types; the Browser Use
 * lifecycle and bearer capabilities stay inside the injected controller.
 */
export interface ConnectedWebAccountRoutesController {
  providerSetupStatus(): ConnectedWebAccountProviderSetupStatus;
  create(input: { readonly ownerUserId: string; readonly account: ConnectedWebAccountCreateRequest }): Promise<ConnectedWebAccountLoginResponse>;
  list(ownerUserId: string): Promise<readonly ConnectedWebAccount[]>;
  get(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount | null>;
  finish(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount>;
  reconnect(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountLoginResponse>;
  openPage(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountLoginResponse>;
  closePage(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount>;
  cancelLogin(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount>;
  readActivity(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountReadActivity>;
  watchRead(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountReadWatch>;
  cancelRead(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount>;
  actionActivity(input: { readonly ownerUserId: string; readonly deliveryId: string }): Promise<ConnectedWebAccountActionActivity>;
  watchAction(input: { readonly ownerUserId: string; readonly deliveryId: string }): Promise<ConnectedWebAccountActionWatch>;
  stopAction(input: { readonly ownerUserId: string; readonly deliveryId: string }): Promise<ConnectedWebAccountActionActivity>;
  disconnect(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount>;
}

function providerSetupError(
  status: ConnectedWebAccountProviderSetupStatus,
  reply: FastifyReply,
): FastifyReply | null {
  if (status === "ready") return null;
  return reply.code(503).send({
    error: status === "api_key_required"
      ? "browser_use_api_key_required"
      : "browser_use_api_key_invalid",
  });
}

export interface ConnectedWebAccountRoutesDeps {
  readonly controller: ConnectedWebAccountRoutesController;
}

function owner(request: { readonly sessionUserId: string | null; readonly policyContext?: { readonly actorRole?: string } | null }, reply: FastifyReply): string | null {
  if (!request.sessionUserId) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  if (request.policyContext?.actorRole === "guest") {
    reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return request.sessionUserId;
}

function replyForStoreError(error: unknown, reply: FastifyReply): never {
  if (error instanceof ConnectedWebAccountControllerError) {
    if (error.kind === "server_funding_required") {
      return reply.code(403).send({ error: "server_provider_credentials_required" }) as never;
    }
    if (error.kind === "invalid_target") {
      return reply.code(400).send({ error: "Invalid website address" }) as never;
    }
    if (error.kind === "authentication_incomplete") {
      return reply.code(409).send({ error: "connected_web_account_authentication_incomplete" }) as never;
    }
    return reply.code(503).send({ error: "Connected website is temporarily unavailable" }) as never;
  }
  if (error instanceof ConnectedWebAccountStoreError) {
    if (error.kind === "not_found") return reply.code(404).send({ error: "connected_web_account_not_found" }) as never;
    if (error.kind === "conflict") return reply.code(409).send({ error: "connected_web_account_conflict" }) as never;
    return reply.code(503).send({ error: "connected_web_account_provider_unavailable" }) as never;
  }
  throw error;
}

function accountId(params: unknown, reply: FastifyReply): string | null {
  const parsed = connectedWebAccountIdSchema.safeParse((params as { id?: unknown }).id);
  if (!parsed.success) {
    reply.code(400).send({ error: "Invalid connected web account request" });
    return null;
  }
  return parsed.data;
}

function deliveryId(params: unknown, reply: FastifyReply): string | null {
  const parsed = connectedWebAccountActionDeliveryIdSchema.safeParse((params as { deliveryId?: unknown }).deliveryId);
  if (!parsed.success) { reply.code(400).send({ error: "Invalid connected web action request" }); return null; }
  return parsed.data;
}

/** Owner-authenticated public facade. It deliberately has no Agent/Room scope. */
export function connectedWebAccountRoutes(app: FastifyInstance, deps: ConnectedWebAccountRoutesDeps): void {
  app.get("/api/connected-web-accounts", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    try {
      return reply.send(connectedWebAccountListResponseSchema.parse({
        accounts: await deps.controller.list(ownerUserId),
        providerSetupStatus: deps.controller.providerSetupStatus(),
      }));
    } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post("/api/connected-web-accounts", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const parsed = connectedWebAccountCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid connected web account request" });
    const setupError = providerSetupError(deps.controller.providerSetupStatus(), reply);
    if (setupError !== null) return setupError;
    try {
      return reply.send(connectedWebAccountLoginResponseSchema.parse(await deps.controller.create({ ownerUserId, account: parsed.data })));
    } catch (error) { return replyForStoreError(error, reply); }
  });

  app.get<{ Params: { id: string } }>("/api/connected-web-accounts/:id", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    try {
      const result = await deps.controller.get({ ownerUserId, accountId: id });
      return result ? reply.send(connectedWebAccountSchema.parse(result)) : reply.code(404).send({ error: "connected_web_account_not_found" });
    } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/connected-web-accounts/:id/finish", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    if (!connectedWebAccountFinishRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web account request" });
    try { return reply.send(connectedWebAccountSchema.parse(await deps.controller.finish({ ownerUserId, accountId: id }))); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/connected-web-accounts/:id/reconnect", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    if (!connectedWebAccountReconnectRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web account request" });
    const setupError = providerSetupError(deps.controller.providerSetupStatus(), reply);
    if (setupError !== null) return setupError;
    try { return reply.send(connectedWebAccountLoginResponseSchema.parse(await deps.controller.reconnect({ ownerUserId, accountId: id }))); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/connected-web-accounts/:id/open-page", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    if (!connectedWebAccountOpenPageRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web account request" });
    const setupError = providerSetupError(deps.controller.providerSetupStatus(), reply);
    if (setupError !== null) return setupError;
    try { return reply.send(connectedWebAccountLoginResponseSchema.parse(await deps.controller.openPage({ ownerUserId, accountId: id }))); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/connected-web-accounts/:id/close-page", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    if (!connectedWebAccountClosePageRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web account request" });
    try { return reply.send(connectedWebAccountClosePageResponseSchema.parse({ account: await deps.controller.closePage({ ownerUserId, accountId: id }) })); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/connected-web-accounts/:id/cancel-login", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    if (!connectedWebAccountCancelLoginRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web account request" });
    try { return reply.send(connectedWebAccountCancelLoginResponseSchema.parse({ account: await deps.controller.cancelLogin({ ownerUserId, accountId: id }) })); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.get<{ Params: { id: string } }>("/api/connected-web-accounts/:id/read-activity", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    try { return reply.send(connectedWebAccountReadActivitySchema.parse(await deps.controller.readActivity({ ownerUserId, accountId: id }))); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/connected-web-accounts/:id/watch-read", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    if (!connectedWebAccountReadWatchRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web account request" });
    try {
      reply.header("cache-control", "no-store");
      return reply.send(connectedWebAccountReadWatchSchema.parse(await deps.controller.watchRead({ ownerUserId, accountId: id })));
    } catch (error) { return replyForStoreError(error, reply); }
  });

  app.post<{ Params: { id: string } }>("/api/connected-web-accounts/:id/cancel-read", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    if (!connectedWebAccountCancelReadRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web account request" });
    try { return reply.send(connectedWebAccountCancelReadResponseSchema.parse({ account: await deps.controller.cancelRead({ ownerUserId, accountId: id }) })); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.get<{ Params: { deliveryId: string } }>("/api/connected-web-actions/:deliveryId/activity", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = deliveryId(request.params, reply); if (!id) return;
    try { return reply.send(connectedWebAccountActionActivitySchema.parse(await deps.controller.actionActivity({ ownerUserId, deliveryId: id }))); } catch (error) { return replyForStoreError(error, reply); }
  });
  app.post<{ Params: { deliveryId: string } }>("/api/connected-web-actions/:deliveryId/watch", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = deliveryId(request.params, reply); if (!id) return;
    if (!connectedWebAccountActionWatchRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web action request" });
    try { reply.header("cache-control", "no-store"); return reply.send(connectedWebAccountActionWatchSchema.parse(await deps.controller.watchAction({ ownerUserId, deliveryId: id }))); } catch (error) { return replyForStoreError(error, reply); }
  });
  app.post<{ Params: { deliveryId: string } }>("/api/connected-web-actions/:deliveryId/stop", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = deliveryId(request.params, reply); if (!id) return;
    if (!connectedWebAccountStopActionRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web action request" });
    try { return reply.send(connectedWebAccountStopActionResponseSchema.parse({ activity: await deps.controller.stopAction({ ownerUserId, deliveryId: id }) })); } catch (error) { return replyForStoreError(error, reply); }
  });

  app.delete<{ Params: { id: string } }>("/api/connected-web-accounts/:id", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = accountId(request.params, reply); if (!id) return;
    try {
      const body = connectedWebAccountDisconnectResponseSchema.parse({
        account: await deps.controller.disconnect({ ownerUserId, accountId: id }),
        websiteSessionWarning: WEBSITE_SESSION_WARNING,
      });
      return reply.send(body);
    } catch (error) { return replyForStoreError(error, reply); }
  });
}
