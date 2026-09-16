import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  liveShadowMessageClientVerificationRequestV1Schema,
  humanPeerLiveShadowAcknowledgementRequestV1Schema,
  humanPeerLiveShadowAcknowledgementPlanRequestV1Schema,
  sharedAgentLiveShadowAcknowledgementRequestV1Schema,
  sharedAgentLiveShadowAcknowledgementPlanRequestV1Schema,
  sharedAgentExecutionAuthorizationRequestV1Schema,
  runtimeInvocationAuthorizationRequestV1Schema,
  sharedAgentOutputReadPlanRequestV1Schema,
  liveShadowMessagePlanRequestSchema,
  type LiveShadowMessagePlanResponseV1,
} from "@nautilo/api-client";
import { decodeMessagePayloadV2 } from "@nautilo/lattice-bridge";
import type {
  LiveShadowTurnPlanInput,
  LiveShadowTurnPlanResult,
  HumanPeerLiveShadowPlanResult,
  SharedAgentLiveShadowPlanResult,
  LiveShadowClientVerificationInput,
  LiveShadowClientVerificationResult,
  LiveShadowTurnRecoveryResult,
} from "@nautilo/lattice-bridge/server";
import { liveShadowLargeRequestRouteOptions } from
  "./live-shadow-request-boundary";

export interface LiveShadowMessagePlanComposition {
  plan(input: LiveShadowTurnPlanInput): Promise<
    LiveShadowTurnPlanResult | HumanPeerLiveShadowPlanResult
      | SharedAgentLiveShadowPlanResult
  >;
  verifyClient(input: LiveShadowClientVerificationInput):
    Promise<LiveShadowClientVerificationResult>;
  admitSharedAgentRuntimeAuthorization?(input: Readonly<{
    operationId: string;
    roomId: string;
    clientActionSessionId: string;
    userId: string;
    actorId: string;
    authorizationPlanBytes: Uint8Array;
    authorizationBytes: Uint8Array;
    now: number;
  }>): Promise<"authorized" | "replayed" | "unavailable">;
  admitRuntimeInvocationAuthorization?(input: Readonly<{
    invocationId: string;
    roomId: string;
    clientActionSessionId: string;
    userId: string;
    actorId: string;
    authorizationPlanBytes: Uint8Array;
    authorizationBytes: Uint8Array;
    now: number;
  }>): Promise<"authorized" | "replayed" | "unavailable">;
  acknowledgeHumanPeer?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    acknowledgementBytes: Uint8Array;
    now: number;
  }>): Promise<"verified" | "replayed" | "conflict">;
  planHumanPeerAcknowledgement?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{
        status: "unavailable";
        reason: "operation_unavailable" | "current_read_authority_unavailable";
      }>
  >;
  acknowledgeSharedAgent?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    acknowledgementBytes: Uint8Array;
    now: number;
  }>): Promise<"verified" | "replayed" | "conflict">;
  planSharedAgentAcknowledgement?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    operationId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{
        status: "unavailable";
        reason: "operation_unavailable" | "current_read_authority_unavailable";
      }>
  >;
  planSharedAgentOutputRead?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    executionId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{
        status: "unavailable";
        reason: "operation_unavailable" | "current_read_authority_unavailable";
      }>
  >;
  acknowledgeSharedAgentOutput?(input: Readonly<{
    userId: string;
    actorId: string;
    roomId: string;
    executionId: string;
    acknowledgementBytes: Uint8Array;
    now: number;
  }>): Promise<"verified" | "replayed" | "conflict">;
  recover?(input: Readonly<{
    authority: LiveShadowTurnPlanInput["authority"];
    roomId: string;
    operationId: string;
  }>): Promise<LiveShadowTurnRecoveryResult>;
  /** Best-effort explicit logout teardown for this authenticated Human. */
  teardownForegroundAuthorizationSessions?(input: Readonly<{
    authority: LiveShadowTurnPlanInput["authority"];
  }>): Promise<void> | void;
  admitSharedAgentExecutionAuthorization?(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    userId: string;
    actorId: string;
    expectedContent: string;
    planBytes: Uint8Array;
    requestBytes: Uint8Array;
    ordinaryPayloadBytes: Uint8Array;
    encryptedPayloadBytes: Uint8Array;
    manifestBytes: Uint8Array;
    envelopeBytes: Uint8Array;
    grantBytes: Uint8Array;
    authorizationScheme: "foreground_session_v1";
    now: number;
  }>): Promise<"authorized" | "replayed" | "unavailable">;
}

export interface LiveShadowMessageClientSessionInspector {
  inspect(input: Readonly<{
    clientActionSessionId: string;
    actorId: string;
  }>): Readonly<{ initiatingClientSurface: string }> | null;
}

function signedInAuthority(request: FastifyRequest): Readonly<{
  userId: string;
  humanActorId: string;
}> | null {
  if (
    request.sessionUserId === null
    || request.sessionActorId === null
    || request.policyContext?.actorRole === "guest"
  ) return null;
  return Object.freeze({
    userId: request.sessionUserId,
    humanActorId: request.sessionActorId,
  });
}

function response(
  result: LiveShadowTurnPlanResult | HumanPeerLiveShadowPlanResult
    | SharedAgentLiveShadowPlanResult,
): LiveShadowMessagePlanResponseV1 {
  if (result.status === "disabled") {
    return Object.freeze({
      responseVersion: 1,
      status: "disabled",
      mode: "plaintext_only",
    });
  }
  if (result.status === "planned") {
    return Object.freeze({
      responseVersion: 1,
      status: "planned",
      planBytesBase64url: Buffer.from(result.planBytes).toString("base64url"),
      ...("authorizationScheme" in result
          && result.authorizationScheme === "human_ai_readable_v2"
        ? { authorizationScheme: "human_ai_readable_v2" as const } : {}),
      ...(result.representationMode === "full_encryption"
        ? { representationMode: "full_encryption" as const }
        : {}),
    });
  }
  if (result.status === "ineligible") {
    return Object.freeze({
      responseVersion: 1,
      status: "ineligible",
      reason: result.reason,
    });
  }
  return Object.freeze({
    responseVersion: 1,
    status: "unavailable",
    ...("authorizationScheme" in result
      ? { authorizationScheme: result.authorizationScheme }
      : {}),
    reason: result.reason,
    ...(result.reason === "namespace_unavailable"
        || result.reason === "recipient_sync_required"
      ? { requiredNamespaceIds: [...(result.requiredNamespaceIds ?? [])] }
      : {}),
  });
}

function decodeBase64url(value: string): Uint8Array | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 && decoded.toString("base64url") === value
      ? Uint8Array.from(decoded)
      : null;
  } catch {
    return null;
  }
}

function isForegroundWorkbenchSurface(value: string | undefined): boolean {
  return value === "workbench.browser" || value === "workbench.desktop";
}

/**
 * Coordinate-first foreground Workbench plan endpoint. It contains no
 * plaintext content; the ordinary and protected siblings arrive together on
 * the existing send.
 */
export function liveShadowMessageRoutes(
  app: FastifyInstance,
  options: Readonly<{
    composition: LiveShadowMessagePlanComposition;
    clientSessions: LiveShadowMessageClientSessionInspector;
    now?: () => number;
  }>,
): void {
  const now = options.now ?? Date.now;
  app.post<{ Params: { roomId: string }; Body: unknown }>(
    "/api/rooms/:roomId/live-shadow/plan",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      const parsed = liveShadowMessagePlanRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const session = options.clientSessions.inspect({
        clientActionSessionId: parsed.data.clientActionSessionId,
        actorId: authority.humanActorId,
      });
      if (!isForegroundWorkbenchSurface(session?.initiatingClientSurface)) {
        return reply.send({
          responseVersion: 1,
          status: "ineligible",
          reason: "client_not_browser",
        } satisfies LiveShadowMessagePlanResponseV1);
      }
      return reply.send(response(await options.composition.plan({
        ...(parsed.data.requestVersion === 2 ? { requestVersion: 2 as const } : {}),
        authority,
        roomId: request.params.roomId,
        clientActionSessionId: parsed.data.clientActionSessionId,
        clientDeviceId: parsed.data.clientDeviceId,
        idempotencyKey: parsed.data.idempotencyKey,
        now: now(),
      })));
    },
  );

  app.post<{
    Params: { roomId: string; invocationId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/runtime-invocation/:invocationId/authorize",
    liveShadowLargeRequestRouteOptions,
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = runtimeInvocationAuthorizationRequestV1Schema.safeParse(
        request.body,
      );
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.invocationId
      ) return reply.code(400).send({ error: "invalid_request" });
      const session = options.clientSessions.inspect({
        clientActionSessionId: parsed.data.clientActionSessionId,
        actorId: authority.humanActorId,
      });
      if (session === null) {
        return reply.code(409).send({ error: "client_session_unavailable" });
      }
      const authorizationPlanBytes = decodeBase64url(
        parsed.data.authorizationPlanBytesBase64url,
      );
      const authorizationBytes = decodeBase64url(
        parsed.data.authorizationBytesBase64url,
      );
      if (authorizationPlanBytes === null || authorizationBytes === null) {
        authorizationPlanBytes?.fill(0);
        authorizationBytes?.fill(0);
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const status = await options.composition
          .admitRuntimeInvocationAuthorization?.({
            invocationId: request.params.invocationId,
            roomId: request.params.roomId,
            clientActionSessionId: parsed.data.clientActionSessionId,
            userId: authority.userId,
            actorId: authority.humanActorId,
            authorizationPlanBytes,
            authorizationBytes,
            now: now(),
          }) ?? "unavailable";
        return reply.send({
          responseVersion: 1,
          status,
          invocationId: request.params.invocationId,
        });
      } finally {
        authorizationPlanBytes.fill(0);
        authorizationBytes.fill(0);
      }
    },
  );

  app.post<{
    Params: { roomId: string; executionId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/shared-agent/:executionId/authorize",
    liveShadowLargeRequestRouteOptions,
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = sharedAgentExecutionAuthorizationRequestV1Schema.safeParse(
        request.body,
      );
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.executionId
      ) return reply.code(400).send({ error: "invalid_request" });
      const session = options.clientSessions.inspect({
        clientActionSessionId: parsed.data.clientActionSessionId,
        actorId: authority.humanActorId,
      });
      if (session === null) {
        return reply.code(409).send({ error: "client_session_unavailable" });
      }
      const decode = (value: string) => decodeBase64url(value);
      if (parsed.data.authorizationScheme === "runtime_foreground_v1") {
        const authorizationPlanBytes = decode(
          parsed.data.authorizationPlanBytesBase64url,
        );
        const authorizationBytes = decode(
          parsed.data.authorizationBytesBase64url,
        );
        if (authorizationPlanBytes === null || authorizationBytes === null) {
          authorizationPlanBytes?.fill(0);
          authorizationBytes?.fill(0);
          return reply.code(400).send({ error: "invalid_request" });
        }
        try {
          const status = await options.composition
            .admitSharedAgentRuntimeAuthorization?.({
              operationId: request.params.executionId,
              roomId: request.params.roomId,
              clientActionSessionId: parsed.data.clientActionSessionId,
              userId: authority.userId,
              actorId: authority.humanActorId,
              authorizationPlanBytes,
              authorizationBytes,
              now: now(),
            }) ?? "unavailable";
          return reply.send({
            responseVersion: 1,
            status,
            executionId: request.params.executionId,
          });
        } finally {
          authorizationPlanBytes.fill(0);
          authorizationBytes.fill(0);
        }
      }
      const planBytes = decode(parsed.data.planBytesBase64url);
      const requestBytes = decode(parsed.data.signedRequestBytesBase64url);
      const ordinaryPayloadBytes = decode(
        parsed.data.ordinaryPayloadBytesBase64url,
      );
      const encryptedPayloadBytes = decode(
        parsed.data.encryptedPayloadBytesBase64url,
      );
      const manifestBytes = decode(parsed.data.accessManifestBytesBase64url);
      const envelopeBytes = decode(
        parsed.data.namespaceEnvelopeBytesBase64url,
      );
      if (
        planBytes === null
        || requestBytes === null
        || ordinaryPayloadBytes === null
        || encryptedPayloadBytes === null
        || manifestBytes === null
        || envelopeBytes === null
      ) {
        [planBytes, requestBytes, ordinaryPayloadBytes, encryptedPayloadBytes,
          manifestBytes, envelopeBytes].forEach((value) => value?.fill(0));
        return reply.code(400).send({ error: "invalid_request" });
      }
      const emptyGrant = new Uint8Array(0);
      try {
        const payload = decodeMessagePayloadV2(ordinaryPayloadBytes);
        if (payload.role !== "user" || payload.toolCalls !== undefined) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        const status = await options.composition
          .admitSharedAgentExecutionAuthorization?.({
            operationId: request.params.executionId,
            clientActionSessionId: parsed.data.clientActionSessionId,
            userId: authority.userId,
            actorId: authority.humanActorId,
            expectedContent: payload.content,
            planBytes,
            requestBytes,
            ordinaryPayloadBytes,
            encryptedPayloadBytes,
            manifestBytes,
            envelopeBytes,
            grantBytes: emptyGrant,
            authorizationScheme: "foreground_session_v1",
            now: now(),
          }) ?? "unavailable";
        return reply.send({
          responseVersion: 1,
          status,
          executionId: request.params.executionId,
        });
      } catch {
        return reply.send({
          responseVersion: 1,
          status: "unavailable",
          executionId: request.params.executionId,
        });
      } finally {
        planBytes.fill(0);
        requestBytes.fill(0);
        ordinaryPayloadBytes.fill(0);
        encryptedPayloadBytes.fill(0);
        manifestBytes.fill(0);
        envelopeBytes.fill(0);
      }
    },
  );
  app.post<{
    Params: { roomId: string; executionId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/ack",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = sharedAgentLiveShadowAcknowledgementRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.executionId
        || options.composition.acknowledgeSharedAgentOutput === undefined
      ) return reply.code(400).send({ error: "invalid_request" });
      const acknowledgementBytes = decodeBase64url(
        parsed.data.acknowledgementBytesBase64url,
      );
      if (acknowledgementBytes === null) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const result = await options.composition.acknowledgeSharedAgentOutput({
          userId: authority.userId,
          actorId: authority.humanActorId,
          roomId: request.params.roomId,
          executionId: request.params.executionId,
          acknowledgementBytes,
          now: now(),
        });
        if (result === "conflict") {
          return reply.code(409).send({ error: "authority_conflict" });
        }
        return reply.send({
          responseVersion: 1,
          operationId: request.params.executionId,
          status: result,
        });
      } finally {
        acknowledgementBytes.fill(0);
      }
    },
  );
  app.delete(
    "/api/live-shadow/foreground-authorization-sessions",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      await options.composition.teardownForegroundAuthorizationSessions?.({
        authority,
      });
      return reply.code(204).send();
    },
  );
  app.post<{
    Params: { roomId: string; operationId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/:operationId/verify",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      const parsed = liveShadowMessageClientVerificationRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.operationId
      ) return reply.code(400).send({ error: "invalid_request" });
      const verificationBytes = decodeBase64url(
        parsed.data.verificationBytesBase64url,
      );
      if (verificationBytes === null) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const result = await options.composition.verifyClient({
          authority,
          roomId: request.params.roomId,
          operationId: request.params.operationId,
          verificationBytes,
          now: now(),
        });
        if (result.status !== "verified" && result.status !== "replayed") {
          request.log.warn({
            roomId: request.params.roomId,
            operationId: request.params.operationId,
            verificationStatus: result.status,
          }, "Live Shadow Browser terminal verification rejected");
          return reply.code(409).send({
            error: result.status === "conflict"
              ? "verification_conflict"
              : "verification_unavailable",
          });
        }
        request.log.info({
          roomId: request.params.roomId,
          operationId: request.params.operationId,
          verificationStatus: result.status,
        }, "Live Shadow Browser terminal verification accepted");
        return reply.send({
          responseVersion: 1,
          status: result.status,
          operationId: result.operationId,
        });
      } finally {
        verificationBytes.fill(0);
      }
    },
  );
  app.post<{
    Params: { roomId: string; operationId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/human-peer/:operationId/ack",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = humanPeerLiveShadowAcknowledgementRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.operationId
        || options.composition.acknowledgeHumanPeer === undefined
      ) return reply.code(400).send({ error: "invalid_request" });
      const acknowledgementBytes = decodeBase64url(
        parsed.data.acknowledgementBytesBase64url,
      );
      if (acknowledgementBytes === null) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const result = await options.composition.acknowledgeHumanPeer({
          userId: authority.userId,
          actorId: authority.humanActorId,
          roomId: request.params.roomId,
          operationId: request.params.operationId,
          acknowledgementBytes,
          now: now(),
        });
        if (result === "conflict") {
          return reply.code(409).send({ error: "authority_conflict" });
        }
        return reply.send({
          responseVersion: 1,
          operationId: request.params.operationId,
          status: result,
        });
      } finally {
        acknowledgementBytes.fill(0);
      }
    },
  );
  app.post<{
    Params: { roomId: string; operationId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/human-peer/:operationId/ack-plan",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = humanPeerLiveShadowAcknowledgementPlanRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.operationId
        || options.composition.planHumanPeerAcknowledgement === undefined
      ) return reply.code(400).send({ error: "invalid_request" });
      const result = await options.composition.planHumanPeerAcknowledgement({
        userId: authority.userId,
        actorId: authority.humanActorId,
        roomId: request.params.roomId,
        operationId: request.params.operationId,
        clientDeviceId: parsed.data.clientDeviceId,
      });
      return reply.send({ responseVersion: 1, ...result });
    },
  );
  app.post<{
    Params: { roomId: string; operationId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = sharedAgentLiveShadowAcknowledgementRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.operationId
        || options.composition.acknowledgeSharedAgent === undefined
      ) return reply.code(400).send({ error: "invalid_request" });
      const acknowledgementBytes = decodeBase64url(
        parsed.data.acknowledgementBytesBase64url,
      );
      if (acknowledgementBytes === null) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const result = await options.composition.acknowledgeSharedAgent({
          userId: authority.userId,
          actorId: authority.humanActorId,
          roomId: request.params.roomId,
          operationId: request.params.operationId,
          acknowledgementBytes,
          now: now(),
        });
        if (result === "conflict") {
          return reply.code(409).send({ error: "authority_conflict" });
        }
        return reply.send({
          responseVersion: 1,
          operationId: request.params.operationId,
          status: result,
        });
      } finally {
        acknowledgementBytes.fill(0);
      }
    },
  );
  app.post<{
    Params: { roomId: string; operationId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack-plan",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = sharedAgentLiveShadowAcknowledgementPlanRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.operationId
        || options.composition.planSharedAgentAcknowledgement === undefined
      ) return reply.code(400).send({ error: "invalid_request" });
      const result = await options.composition.planSharedAgentAcknowledgement({
        userId: authority.userId,
        actorId: authority.humanActorId,
        roomId: request.params.roomId,
        operationId: request.params.operationId,
        clientDeviceId: parsed.data.clientDeviceId,
      });
      return reply.send({ responseVersion: 1, ...result });
    },
  );
  app.post<{
    Params: { roomId: string; executionId: string };
    Body: unknown;
  }>(
    "/api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/read-plan",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = sharedAgentOutputReadPlanRequestV1Schema
        .safeParse(request.body);
      if (
        !parsed.success
        || parsed.data.operationId !== request.params.executionId
        || options.composition.planSharedAgentOutputRead === undefined
      ) return reply.code(400).send({ error: "invalid_request" });
      const result = await options.composition.planSharedAgentOutputRead({
        userId: authority.userId,
        actorId: authority.humanActorId,
        roomId: request.params.roomId,
        executionId: request.params.executionId,
        clientDeviceId: parsed.data.clientDeviceId,
      });
      return reply.send({ responseVersion: 1, ...result });
    },
  );
  app.get<{ Params: { roomId: string; operationId: string } }>(
    "/api/rooms/:roomId/live-shadow/:operationId/recovery",
    async (request, reply) => {
      const authority = signedInAuthority(request);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (options.composition.recover === undefined) {
        return reply.code(503).send({ error: "recovery_unavailable" });
      }
      const recovered = await options.composition.recover({
        authority,
        roomId: request.params.roomId,
        operationId: request.params.operationId,
      });
      return reply.send({
        responseVersion: 1,
        ...recovered,
        ...("human" in recovered && recovered.human !== undefined
          ? { human: { protectedMessage: recovered.human } }
          : {}),
      });
    },
  );
}
