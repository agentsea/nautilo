/**
 * Test helper — installs a stub preHandler that emulates bearer resolution
 * via the in-memory test `SessionStore` (unit harness; production uses Logto JWT).
 *
 *   1. Initialize `request.sessionActorId` / `sessionUserId` to null.
 *   2. Extract `Authorization: Bearer <token>`.
 *   3. Look up the token in the test's `SessionStore`.
 *   4. On hit, decorate `request.sessionUserId` + a non-guest
 *      `policyContext`. On miss, leave decorations as guest.
 *
 * Pre-M052 the auth route handlers each did their own
 * `extractBearerToken + sessionStore.validateSession` check; M052
 * moved that responsibility to the global preHandler in `app.ts`.
 * Tests that construct Fastify directly (without going through
 * `createApp`) need this stub so the routes-under-test see the
 * same `request.policyContext` / `request.sessionUserId` shape they
 * would in production.
 *
 * The stub is deliberately minimal — it does NOT call into the trust
 * package's `policyResolver` / `getFederatedIdForActor`. Tests that
 * need real policy semantics should use the integration test surface
 * (`createApp`) instead.
 */

import type { FastifyInstance } from "fastify";
import type { SessionRecord, SessionStore } from "../../helpers/test-session-store";

interface StubGuestContext {
  actorRole: "guest";
  actorId: "guest";
}

export type LocalAuthPreHandlerStubPolicyRole = "owner" | "household" | "teammate";

export type LocalAuthPreHandlerStubOptions = {
  /**
   * Override `policyContext.actorRole` for authenticated sessions.
   * Default: `"owner"` for every valid bearer (legacy unit-test shape).
   */
  policyRoleForSession?: (
    session: Pick<SessionRecord, "actorId" | "userId" | "ownerId">,
  ) => LocalAuthPreHandlerStubPolicyRole;
  /**
   * M101 — when a valid bearer session exists, set `request.accessTokenIssuedAt`
   * to this Unix-seconds `iat` value so routes can run `requireFreshLogtoAccessToken`.
   * Omitted or `null` → `null` (treated as stale by freshness helpers).
   */
  accessTokenIssuedAtSeconds?: number | null;
  /**
   * M125 Phase 2.4 — auth resume routes now read
   * `request.memoryEnvelope?.agentId` instead of the bootstrap default.
   * Tests that exercise the happy-path resume flow must supply an
   * agent id here; the stub stamps it on `request.memoryEnvelope.agentId`
   * for authenticated sessions. Default: `"stub-envelope-agent"` so
   * pre-M125 tests that don't care about the value continue to work.
   */
  agentIdForSession?: (
    session: Pick<SessionRecord, "actorId" | "userId" | "ownerId">,
  ) => string;
};

export function installLocalAuthPreHandlerStub(
  app: FastifyInstance,
  sessionStore: SessionStore,
  options?: LocalAuthPreHandlerStubOptions,
): void {
  app.decorateRequest("policyContext", null);
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("accessTokenIssuedAt", null);

  app.addHook("preHandler", (request, _reply, done) => {
    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    const session = bearer ? sessionStore.validateSession(bearer) : null;

    if (session) {
      request.sessionActorId = session.actorId;
      request.sessionUserId = session.userId;
      const role = options?.policyRoleForSession?.(session) ?? "owner";
      const policyCtx = {
        actorRole: role,
        actorId: session.actorId,
      };
      // We cast to the production type via `unknown` because the stub
      // intentionally produces a thinner shape than the full
      // `RuntimePolicyContext`. The auth handlers under test only
      // read `actorRole`; everything else they read goes through the
      // sessionUserId / sessionActorId decorations above.
      request.policyContext =
        policyCtx as unknown as typeof request.policyContext;
      // M125 Phase 2.4 — stamp an envelope agentId so resume routes
      // don't 409 in unit tests. Production preHandler sets a full
      // RuntimePolicyContext + envelope; this stub mirrors just the
      // bits the auth resume routes read.
      const envelopeAgentId =
        options?.agentIdForSession?.(session) ?? "stub-envelope-agent";
      const envelopeStub = {
        ownerId: session.ownerId,
        actorId: session.actorId,
        agentId: envelopeAgentId,
        roomId: "",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        // The trust-layer `ToolPolicy` shape is owned by `@nautilo/trust`;
        // this stub only exists to satisfy the resume routes that read
        // `envelope.agentId`. Cast through `unknown` to avoid pulling in
        // the full builder.
        toolPolicy: {},
      };
      request.memoryEnvelope =
        envelopeStub as unknown as typeof request.memoryEnvelope;
      const r = request as typeof request & {
        accessTokenIssuedAt: number | null;
      };
      const iatOpt = options?.accessTokenIssuedAtSeconds;
      r.accessTokenIssuedAt =
        typeof iatOpt === "number" && Number.isFinite(iatOpt) ? iatOpt : null;
    } else {
      request.sessionActorId = null;
      request.sessionUserId = null;
      const r = request as typeof request & {
        accessTokenIssuedAt: number | null;
      };
      r.accessTokenIssuedAt = null;
      const guestCtx: StubGuestContext = {
        actorRole: "guest",
        actorId: "guest",
      };
      request.policyContext =
        guestCtx as unknown as typeof request.policyContext;
    }
    done();
  });
}
