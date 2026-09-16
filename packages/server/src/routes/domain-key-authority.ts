import {
  domainKeyAuthorityPlanRequestV2Schema,
  domainKeyAuthorityPublishRequestV2Schema,
  domainKeyEnvelopeAcknowledgeRequestV2Schema,
  domainKeyEnvelopeFetchRequestV2Schema,
  domainKeyPendingRequestListV2Schema,
  domainKeyPendingSourceListV2Schema,
  domainKeyRecipientFulfilRequestV2Schema,
  domainKeyRecipientRequestV2Schema,
  domainNamespaceBundlePlanRequestV2Schema,
  domainNamespaceBundlePublishRequestV2Schema,
} from "@nautilo/api-client";
import {
  and,
  asc,
  createPostgresJsBridgeConnection,
  eq,
  getSharedDirectCryptoDb,
  inArray,
  isNull,
  roomMembers,
  rooms,
} from "@nautilo/db";
import {
  createPostgresDomainKeyAuthorityRepositoryFactory,
  PostgresDomainKeyAuthorityRepository,
  PostgresNamespaceProductAuthority,
  type NamespaceProductAuthoritySnapshot,
} from "@nautilo/lattice-bridge/server";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { listHumanUserIdsInRoom } from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";
import {
  publishDomainKeyCatchUpDelivered,
  publishDomainKeyCatchUpRequested,
} from
  "../realtime/ws-publisher";

type Authority = Readonly<{ userId: string; humanActorId: string }>;
type RouteParams = Readonly<{ roomId: string; namespaceId: string }>;

export function selectDomainKeyCatchUpRoomId(
  rows: readonly Readonly<{ roomId: string }>[],
): string | null {
  return rows.length === 1 ? rows[0]!.roomId : null;
}

function signedIn(request: FastifyRequest): Authority | null {
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

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
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

function headPlanResponse(
  plan: Awaited<ReturnType<PostgresDomainKeyAuthorityRepository["planHead"]>>,
) {
  if (plan.status === "unavailable") {
    return { responseVersion: 2 as const, ...plan };
  }
  if (plan.status === "create_required") {
    return {
      responseVersion: 2 as const,
      status: plan.status,
      domainId: plan.domainId,
      participantDigestBase64url: base64url(plan.participantDigest),
      participantCount: plan.participantCount,
      keyClass: plan.keyClass,
      domainKeyGeneration: plan.domainKeyGeneration,
      authorizationRevision: plan.authorizationRevision,
      previousHeadDigestBase64url: plan.previousHeadDigest === null
        ? null
        : base64url(plan.previousHeadDigest),
      issuerHumanId: plan.issuerHumanId,
      issuerDeviceId: plan.issuerDeviceId,
      issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
      issuerSigningPublicKeyBase64url: base64url(plan.issuerSigningPublicKey),
      recipientEncryptionPublicKeyBase64url:
        base64url(plan.recipientEncryptionPublicKey),
      recipientPublicKeyDigestBase64url:
        base64url(plan.recipientPublicKeyDigest),
      recoveryKeyId: plan.recoveryKeyId,
      recoveryKeyGeneration: plan.recoveryKeyGeneration,
      recoveryPublicKeyBase64url: base64url(plan.recoveryPublicKey),
      recoveryPublicKeyDigestBase64url:
        base64url(plan.recoveryPublicKeyDigest),
      issuedAt: plan.issuedAt,
      deadlineAt: plan.deadlineAt,
    };
  }
  const base = {
    responseVersion: 2 as const,
    status: plan.status,
    domainId: plan.domainId,
    participantDigestBase64url: base64url(plan.participantDigest),
    participantCount: plan.participantCount,
    keyClass: plan.keyClass,
    domainKeyGeneration: plan.domainKeyGeneration,
    authorizationRevision: plan.authorizationRevision,
    headDigestBase64url: base64url(plan.headDigest),
    headBytesBase64url: base64url(plan.headBytes),
    issuerSigningPublicKeyBase64url: base64url(plan.issuerSigningPublicKey),
    recipientDeviceSigningGeneration: plan.recipientDeviceSigningGeneration,
    recipientDeviceRevision: plan.recipientDeviceRevision,
    recipientEnvelope: plan.recipientEnvelope === null ? null : {
      envelopeBytesBase64url: base64url(
        plan.recipientEnvelope.envelopeBytes,
      ),
      envelopeDigestBase64url: base64url(
        plan.recipientEnvelope.envelopeDigest,
      ),
      issuerSigningPublicKeyBase64url: base64url(
        plan.recipientEnvelope.issuerSigningPublicKey,
      ),
    },
  };
  return base;
}

function bundlePlanResponse(
  plan: Awaited<
    ReturnType<PostgresDomainKeyAuthorityRepository["planNamespaceBundle"]>
  >,
) {
  if (plan.status === "unavailable") {
    return { responseVersion: 2 as const, ...plan };
  }
  if (plan.status === "ready") {
    return {
      responseVersion: 2 as const,
      status: plan.status,
      domainId: plan.domainId,
      keyClass: plan.keyClass,
      bindingBytesBase64url: base64url(plan.bindingBytes),
      bindingDigestBase64url: base64url(plan.bindingDigest),
      issuerSigningPublicKeyBase64url: base64url(plan.issuerSigningPublicKey),
    };
  }
  const base = {
    responseVersion: 2 as const,
    status: plan.status,
    domainId: plan.domainId,
    participantDigestBase64url: base64url(plan.participantDigest),
    participantCount: plan.participantCount,
    keyClass: plan.keyClass,
    domainKeyGeneration: plan.domainKeyGeneration,
    domainAuthorizationRevision: plan.domainAuthorizationRevision,
    domainHeadDigestBase64url: base64url(plan.domainHeadDigest),
    namespaceId: plan.namespaceId,
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceCurrentGeneration: plan.namespaceCurrentGeneration,
    bundleRevision: plan.bundleRevision,
    retainedGenerationCount: plan.retainedGenerationCount,
    previousBindingDigestBase64url: plan.previousBindingDigest === null
      ? null
      : base64url(plan.previousBindingDigest),
    issuerHumanId: plan.issuerHumanId,
    issuerDeviceId: plan.issuerDeviceId,
    issuerDeviceSigningGeneration: plan.issuerDeviceSigningGeneration,
    issuerSigningPublicKeyBase64url: base64url(plan.issuerSigningPublicKey),
  };
  if (plan.status === "create_required") return base;
  return {
    ...base,
    advanceGeneration: plan.advanceGeneration,
    sourceBindingBytesBase64url: base64url(plan.sourceBindingBytes),
    sourceBindingDigestBase64url: base64url(plan.sourceBindingDigest),
    sourceIssuerSigningPublicKeyBase64url:
      base64url(plan.sourceIssuerSigningPublicKey),
    sourceEnvelopeBytesBase64url: base64url(plan.sourceEnvelopeBytes),
    sourceEnvelopeDigestBase64url: base64url(plan.sourceEnvelopeDigest),
    sourceEnvelopeIssuerSigningPublicKeyBase64url:
      base64url(plan.sourceEnvelopeIssuerSigningPublicKey),
    sourceRecipientDeviceSigningGeneration:
      plan.sourceRecipientDeviceSigningGeneration,
  };
}

export function registerProductionDomainKeyAuthority(app: FastifyInstance) {
  const productAuthority = new PostgresNamespaceProductAuthority(
    createPostgresJsBridgeConnection(getServerDirectDb()),
  );
  const restricted = createPostgresJsBridgeConnection(
    getSharedDirectCryptoDb(),
  );
  const domainKeyRepository =
    createPostgresDomainKeyAuthorityRepositoryFactory(restricted);
  const withNamespace = <Value>(input: Readonly<{
    authority: Authority;
    roomId: string;
    namespaceId: string;
    keyClass: "human" | "ai";
    serverId: string;
    use(
      repository: PostgresDomainKeyAuthorityRepository,
      snapshot: NamespaceProductAuthoritySnapshot,
    ): Promise<Value>;
  }>) => productAuthority.withCurrentReadableNamespace({
    subjectUserId: input.authority.userId,
    subjectHumanId: input.authority.humanActorId,
    sourceRoomId: input.roomId,
    namespaceId: input.namespaceId,
    keyClass: input.keyClass,
    use: (snapshot) => input.use(
      domainKeyRepository(input.serverId),
      snapshot,
    ),
  });

  app.post(
    "/api/live-shadow/domain-key/source/pending",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyPendingSourceListV2Schema.safeParse(request.body);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const coordinates = await domainKeyRepository(parsed.data.serverId)
        .listPendingSourceCoordinates({
          product: createPostgresJsBridgeConnection(getServerDirectDb()),
          humanId: authority.humanActorId,
          clientDeviceId: parsed.data.clientDeviceId,
          ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
          now: Date.now(),
        });
      if (coordinates === null) {
        return reply.code(503).send({ error: "authority_changed" });
      }
      if (coordinates.length === 0) {
        return reply.send({ responseVersion: 2, work: [] });
      }
      const namespaceIds = [...new Set(
        coordinates.map((coordinate) => coordinate.namespaceId),
      )];
      const authorityRooms = await getServerDirectDb().select({
        roomId: rooms.id,
        namespaceId: rooms.namespaceId,
      }).from(rooms).innerJoin(
        roomMembers,
        and(
          eq(roomMembers.roomId, rooms.id),
          eq(roomMembers.actorId, authority.humanActorId),
        ),
      ).where(and(
        inArray(rooms.namespaceId, namespaceIds),
        isNull(rooms.parentRoomId),
        isNull(rooms.archivedAt),
      )).orderBy(asc(rooms.id));
      const roomByNamespace = new Map<string, string>();
      for (const row of authorityRooms) {
        if (row.namespaceId !== null && !roomByNamespace.has(row.namespaceId)) {
          roomByNamespace.set(row.namespaceId, row.roomId);
        }
      }
      return reply.send({
        responseVersion: 2,
        work: coordinates.flatMap((coordinate) => {
          const sourceRoomId = roomByNamespace.get(coordinate.namespaceId);
          return sourceRoomId === undefined ? [] : [{
            sourceRoomId,
            namespaceId: coordinate.namespaceId,
            keyClass: coordinate.keyClass,
          }];
        }),
      });
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/plan",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyAuthorityPlanRequestV2Schema.safeParse(
        request.body,
      );
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const result = await withNamespace({
        authority,
        roomId: request.params.roomId,
        namespaceId: request.params.namespaceId,
        keyClass: parsed.data.keyClass,
        serverId: parsed.data.serverId,
        use: (repository, snapshot) => repository.planHead({
          authority: snapshot,
          keyClass: parsed.data.keyClass,
          clientDeviceId: parsed.data.clientDeviceId,
          now: Date.now(),
        }),
      });
      return result === null
        ? reply.code(403).send({ error: "forbidden" })
        : reply.send(headPlanResponse(result));
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/publish",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyAuthorityPublishRequestV2Schema.safeParse(
        request.body,
      );
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const headBytes = decodeBase64url(parsed.data.headBytesBase64url);
      const envelopeBytes = decodeBase64url(parsed.data.envelopeBytesBase64url);
      const authorizationBytes = decodeBase64url(
        parsed.data.authorizationBytesBase64url,
      );
      const recoveryEnvelopeBytes = decodeBase64url(
        parsed.data.recoveryEnvelopeBytesBase64url,
      );
      const recoveryAuthorizationBytes = decodeBase64url(
        parsed.data.recoveryAuthorizationBytesBase64url,
      );
      if (
        headBytes === null
        || envelopeBytes === null
        || authorizationBytes === null
        || recoveryEnvelopeBytes === null
        || recoveryAuthorizationBytes === null
      ) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const result = await withNamespace({
          authority,
          roomId: request.params.roomId,
          namespaceId: request.params.namespaceId,
          keyClass: parsed.data.keyClass,
          serverId: parsed.data.serverId,
          use: (repository, snapshot) => repository.publishHead({
            authority: snapshot,
            keyClass: parsed.data.keyClass,
            clientDeviceId: parsed.data.clientDeviceId,
            operationId: parsed.data.operationId,
            idempotencyKey: parsed.data.idempotencyKey,
            headBytes,
            envelopeBytes,
            authorizationBytes,
            recoveryEnvelopeBytes,
            recoveryAuthorizationBytes,
            now: Date.now(),
          }),
        });
        return result === null
          ? reply.code(403).send({ error: "forbidden" })
          : reply.send({
              responseVersion: 2,
              status: result.status,
              operationId: result.operationId,
              domainId: result.domainId,
              keyClass: result.keyClass,
              domainKeyGeneration: result.domainKeyGeneration,
              authorizationRevision: result.authorizationRevision,
              headDigestBase64url: base64url(result.headDigest),
              envelopeDigestBase64url: base64url(result.envelopeDigest),
              recoveryEnvelopeDigestBase64url:
                base64url(result.recoveryEnvelopeDigest),
            });
      } finally {
        headBytes.fill(0);
        envelopeBytes.fill(0);
        authorizationBytes.fill(0);
        recoveryEnvelopeBytes.fill(0);
        recoveryAuthorizationBytes.fill(0);
      }
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/request",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyRecipientRequestV2Schema.safeParse(request.body);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const requestBytes = decodeBase64url(parsed.data.requestBytesBase64url);
      if (requestBytes === null) return reply.code(400).send({ error: "invalid_request" });
      try {
        const result = await withNamespace({
          authority,
          roomId: request.params.roomId,
          namespaceId: request.params.namespaceId,
          keyClass: parsed.data.keyClass,
          serverId: parsed.data.serverId,
          use: (repository, snapshot) => repository.requestRecipient({
            authority: snapshot,
            keyClass: parsed.data.keyClass,
            clientDeviceId: parsed.data.clientDeviceId,
            requestId: parsed.data.requestId,
            idempotencyKey: parsed.data.idempotencyKey,
            requestBytes,
            now: Date.now(),
          }),
        });
        if (result === null) return reply.code(403).send({ error: "forbidden" });
        if (result.status !== "already_delivered") {
          const targetRooms = await getServerDirectDb().select({
            roomId: rooms.id,
          }).from(rooms).where(and(
            eq(rooms.namespaceId, request.params.namespaceId),
            isNull(rooms.parentRoomId),
            isNull(rooms.archivedAt),
          ));
          const catchUpRoomId = selectDomainKeyCatchUpRoomId(targetRooms);
          if (catchUpRoomId !== null) {
            publishDomainKeyCatchUpRequested({
              roomId: catchUpRoomId,
              namespaceId: request.params.namespaceId,
              keyClass: parsed.data.keyClass,
              recipientUserIds: await listHumanUserIdsInRoom(catchUpRoomId),
            });
          }
        }
        return reply.send({
          responseVersion: 2,
          status: result.status,
          requestId: result.requestId,
          requestDigestBase64url: base64url(result.requestDigest),
        });
      } finally {
        requestBytes.fill(0);
      }
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/pending",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyPendingRequestListV2Schema.safeParse(request.body);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const result = await withNamespace({
        authority,
        roomId: request.params.roomId,
        namespaceId: request.params.namespaceId,
        keyClass: parsed.data.keyClass,
        serverId: parsed.data.serverId,
        use: (repository, snapshot) => repository.listPendingRequests({
          authority: snapshot,
          keyClass: parsed.data.keyClass,
          clientDeviceId: parsed.data.clientDeviceId,
          ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
          now: Date.now(),
        }),
      });
      if (result === null) return reply.code(403).send({ error: "forbidden" });
      return reply.send({
        responseVersion: 2,
        requests: result.map((entry) => ({
          requestId: entry.requestId,
          requestBytesBase64url: base64url(entry.requestBytes),
          requestDigestBase64url: base64url(entry.requestDigest),
          domainId: entry.domainId,
          keyClass: entry.keyClass,
          domainKeyGeneration: entry.domainKeyGeneration,
          authorizationRevision: entry.authorizationRevision,
          headDigestBase64url: base64url(entry.headDigest),
          recipientHumanId: entry.recipientHumanId,
          recipientDeviceId: entry.recipientDeviceId,
          recipientDeviceGeneration: entry.recipientDeviceGeneration,
          recipientSigningPublicKeyBase64url:
            base64url(entry.recipientSigningPublicKey),
          recipientEncryptionPublicKeyBase64url:
            base64url(entry.recipientEncryptionPublicKey),
          recipientPublicKeyDigestBase64url:
            base64url(entry.recipientPublicKeyDigest),
        })),
      });
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/fulfil",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyRecipientFulfilRequestV2Schema.safeParse(
        request.body,
      );
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const authorizationBytes = decodeBase64url(
        parsed.data.authorizationBytesBase64url,
      );
      if (authorizationBytes === null) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const result = await withNamespace({
          authority,
          roomId: request.params.roomId,
          namespaceId: request.params.namespaceId,
          keyClass: parsed.data.keyClass,
          serverId: parsed.data.serverId,
          use: (repository, snapshot) => repository.fulfilRecipientRequest({
            authority: snapshot,
            keyClass: parsed.data.keyClass,
            clientDeviceId: parsed.data.clientDeviceId,
            requestId: parsed.data.requestId,
            authorizationBytes,
            now: Date.now(),
          }),
        });
        if (result === null) return reply.code(403).send({ error: "forbidden" });
        if (result.status !== "lost_race") {
          publishDomainKeyCatchUpDelivered({
            roomId: request.params.roomId,
            namespaceId: request.params.namespaceId,
            keyClass: parsed.data.keyClass,
            recipientUserIds: await listHumanUserIdsInRoom(request.params.roomId),
          });
        }
        return reply.send({
          responseVersion: 2,
          status: result.status,
          requestId: result.requestId,
          envelopeDigestBase64url: base64url(result.envelopeDigest),
          authorizationDigestBase64url:
            base64url(result.authorizationDigest),
        });
      } finally {
        authorizationBytes.fill(0);
      }
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/fetch",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyEnvelopeFetchRequestV2Schema.safeParse(request.body);
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const result = await withNamespace({
        authority,
        roomId: request.params.roomId,
        namespaceId: request.params.namespaceId,
        keyClass: parsed.data.keyClass,
        serverId: parsed.data.serverId,
        use: (repository, snapshot) => repository.fetchEnvelope({
          authority: snapshot,
          keyClass: parsed.data.keyClass,
          clientDeviceId: parsed.data.clientDeviceId,
          ...(parsed.data.recipientKind === undefined
            ? {}
            : { recipientKind: parsed.data.recipientKind }),
          ...(parsed.data.recoveryKeyId === undefined
            ? {}
            : { recoveryKeyId: parsed.data.recoveryKeyId }),
          ...(parsed.data.recoveryKeyGeneration === undefined
            ? {}
            : { recoveryKeyGeneration: parsed.data.recoveryKeyGeneration }),
          now: Date.now(),
        }),
      });
      if (result === null) return reply.code(403).send({ error: "forbidden" });
      if (result.status !== "ready") {
        return reply.send({ responseVersion: 2, status: result.status });
      }
      return reply.send({
        responseVersion: 2,
        status: result.status,
        requestDigestBase64url: result.requestDigest === null
          ? null
          : base64url(result.requestDigest),
        envelopeBytesBase64url: base64url(result.envelopeBytes),
        envelopeDigestBase64url: base64url(result.envelopeDigest),
        issuerSigningPublicKeyBase64url:
          base64url(result.issuerSigningPublicKey),
      });
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/recipient/acknowledge",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainKeyEnvelopeAcknowledgeRequestV2Schema.safeParse(
        request.body,
      );
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const acknowledgementBytes = decodeBase64url(
        parsed.data.acknowledgementBytesBase64url,
      );
      if (acknowledgementBytes === null) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      try {
        const result = await withNamespace({
          authority,
          roomId: request.params.roomId,
          namespaceId: request.params.namespaceId,
          keyClass: parsed.data.keyClass,
          serverId: parsed.data.serverId,
          use: (repository, snapshot) => repository.acknowledgeEnvelope({
            authority: snapshot,
            keyClass: parsed.data.keyClass,
            clientDeviceId: parsed.data.clientDeviceId,
            acknowledgementBytes,
            now: Date.now(),
          }),
        });
        return result === null
          ? reply.code(403).send({ error: "forbidden" })
          : reply.send({
              responseVersion: 2,
              status: result.status,
              acknowledgementDigestBase64url:
                base64url(result.acknowledgementDigest),
            });
      } finally {
        acknowledgementBytes.fill(0);
      }
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/bundle/plan",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainNamespaceBundlePlanRequestV2Schema.safeParse(
        request.body,
      );
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const result = await withNamespace({
        authority,
        roomId: request.params.roomId,
        namespaceId: request.params.namespaceId,
        keyClass: parsed.data.keyClass,
        serverId: parsed.data.serverId,
        use: (repository, snapshot) => repository.planNamespaceBundle({
          authority: snapshot,
          keyClass: parsed.data.keyClass,
          clientDeviceId: parsed.data.clientDeviceId,
        }),
      });
      return result === null
        ? reply.code(403).send({ error: "forbidden" })
        : reply.send(bundlePlanResponse(result));
    },
  );

  app.post<{ Params: RouteParams }>(
    "/api/rooms/:roomId/live-shadow/domain-key/:namespaceId/bundle/publish",
    async (request, reply) => {
      const authority = signedIn(request);
      const parsed = domainNamespaceBundlePublishRequestV2Schema.safeParse(
        request.body,
      );
      if (authority === null) return reply.code(401).send({ error: "unauthorized" });
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const bindingBytes = decodeBase64url(parsed.data.bindingBytesBase64url);
      if (bindingBytes === null) return reply.code(400).send({ error: "invalid_request" });
      try {
        const result = await withNamespace({
          authority,
          roomId: request.params.roomId,
          namespaceId: request.params.namespaceId,
          keyClass: parsed.data.keyClass,
          serverId: parsed.data.serverId,
          use: (repository, snapshot) => repository.publishNamespaceBundle({
            authority: snapshot,
            keyClass: parsed.data.keyClass,
            clientDeviceId: parsed.data.clientDeviceId,
            operationId: parsed.data.operationId,
            idempotencyKey: parsed.data.idempotencyKey,
            bindingBytes,
            now: Date.now(),
          }),
        });
        if (result === null) return reply.code(403).send({ error: "forbidden" });
        // A recipient can already hold the current Domain key while the Room
        // bundle is still waiting on a historical source. Wake it only after
        // the replacement is durable, in the target Room rather than the
        // unrelated foreground Room through which repair was requested.
        const targetRooms = await getServerDirectDb().select({
          roomId: rooms.id,
        }).from(rooms).where(and(
          eq(rooms.namespaceId, result.namespaceId),
          isNull(rooms.parentRoomId),
          isNull(rooms.archivedAt),
        ));
        const catchUpRoomId = selectDomainKeyCatchUpRoomId(targetRooms);
        if (catchUpRoomId !== null) {
          publishDomainKeyCatchUpDelivered({
            roomId: catchUpRoomId,
            namespaceId: result.namespaceId,
            keyClass: result.keyClass,
            recipientUserIds: await listHumanUserIdsInRoom(catchUpRoomId),
          });
        }
        return reply.send({
          responseVersion: 2,
          status: result.status,
          operationId: result.operationId,
          namespaceId: result.namespaceId,
          domainId: result.domainId,
          keyClass: result.keyClass,
          bindingDigestBase64url: base64url(result.bindingDigest),
        });
      } finally {
        bindingBytes.fill(0);
      }
    },
  );
}
