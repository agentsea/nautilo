import { LatticeCrypto, unixTimestamp } from "@nautilo/lattice-crypto";
import { HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1 } from
  "@nautilo/lattice-crypto/wire";
import {
  decodeHumanMemoryReadAcknowledgementV1,
  verifyHumanMemoryReadAcknowledgementV1,
} from "@nautilo/lattice-bridge";
import {
  resolveRoomHistoryReaderSigningPublicKey,
} from "@nautilo/lattice-bridge/server";
import {
  createPostgresJsBridgeConnection,
  consumeTrustedEncryptionTransitionObservationAdmission,
  ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_MAX_TTL_MS,
  issueEncryptionTransitionObservationAdmission,
  getSharedDirectCryptoDb,
  type PostgresJsBridgeConnection,
  type Database,
} from "@nautilo/db";
import {
  humanMemoryReadObservationRequestV1Schema,
} from "@nautilo/api-client";
import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";

import { getServerDirectDb } from "../lib/server-direct-db";

const READ_ACKNOWLEDGEMENT_TTL_MS = Math.min(
  HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1,
  ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_MAX_TTL_MS,
);

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function createHumanMemoryReadObservationIssuer(input: Readonly<{
  db: Pick<Database, "transaction">;
  now?: () => Date;
  issue?: typeof issueEncryptionTransitionObservationAdmission;
}>): NonNullable<Parameters<
  typeof import("@nautilo/lattice-bridge/server").createPostgresHumanMemoryProtectedProductRoutePort
>[0]["issueReadObservation"]> {
  return async (request) => {
    const issuedAt = (input.now ?? (() => new Date()))();
    const expiresAt = new Date(issuedAt.getTime() + READ_ACKNOWLEDGEMENT_TTL_MS);
    if (request.authority.actorId === null) return undefined;
    try {
      const admission = await (input.issue ?? issueEncryptionTransitionObservationAdmission)(
        input.db, {
        family: "memory", operation: "read", expiresAt, now: issuedAt,
        memoryReadBinding: {
          subjectHumanId: request.authority.actorId,
          memoryId: request.memoryId,
          cryptoObjectId: request.cryptoObjectId,
          contentRevision: request.contentRevision,
          cryptoAccessRevision: request.cryptoAccessRevision,
        },
        },
      );
      try {
        return Object.freeze({ tokenBase64url: base64url(admission.token),
          policyRevision: admission.policyRevision,
          issuedAt: issuedAt.getTime(), expiresAt: admission.expiresAt.getTime() });
      } finally { admission.token.fill(0); }
    } catch {
      warn("[memory-read-observation] admission unavailable");
      return undefined;
    }
  };
}

async function consumeHumanMemoryReadAcknowledgement(input: Readonly<{
  db: Pick<Database, "transaction">;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  acknowledgementBytes: Uint8Array;
  authority: Readonly<{ userId: string; humanActorId: string }>;
  now: Date;
}>): Promise<"accepted" | "conflict" | "unavailable"> {
  const decoded = decodeHumanMemoryReadAcknowledgementV1(input.acknowledgementBytes);
  let signingPublicKey: Uint8Array | undefined;
  let verified: ReturnType<typeof verifyHumanMemoryReadAcknowledgementV1> | undefined;
  try {
    if (decoded.subjectHumanId !== input.authority.humanActorId) return "conflict";
    signingPublicKey = await resolveRoomHistoryReaderSigningPublicKey(input.restricted, {
      subjectUserId: input.authority.userId,
      subjectHumanId: decoded.subjectHumanId,
      readerDeviceId: decoded.readerDeviceId,
      readerDeviceSigningKeyGeneration: decoded.readerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: decoded.hostAuthorizationRevision,
    }) ?? undefined;
    if (signingPublicKey === undefined) return "unavailable";
    verified = verifyHumanMemoryReadAcknowledgementV1(input.crypto, {
      bytes: input.acknowledgementBytes,
      now: unixTimestamp(input.now.getTime()),
      resolveSigningPublicKey: () => signingPublicKey!.slice(),
    });
    const consumed = await consumeTrustedEncryptionTransitionObservationAdmission(
      input.db, { token: verified.observationToken,
        expectedFamily: "memory", expectedOperation: "read",
        expectedPolicyRevision: verified.policyRevision,
        outcome: verified.outcome, reason: verified.reason,
        memoryReadBinding: {
          subjectHumanId: verified.subjectHumanId,
          memoryId: verified.memoryId,
          cryptoObjectId: verified.cryptoObjectId,
          contentRevision: verified.contentRevision,
          cryptoAccessRevision: verified.cryptoAccessRevision,
        },
        observedAt: input.now },
    );
    return consumed.status;
  } finally {
    signingPublicKey?.fill(0);
    verified?.observationToken.fill(0);
    verified?.signature.fill(0);
    decoded.observationToken.fill(0);
    decoded.signature.fill(0);
  }
}

export function registerHumanMemoryReadObservationRoutes(
  app: FastifyInstance,
  input?: Readonly<{
    db: Pick<Database, "transaction">;
    restricted: () => PostgresJsBridgeConnection;
    crypto: LatticeCrypto;
    now?: () => Date;
  }>,
): void {
  const resolved: NonNullable<typeof input> = input ?? Object.freeze({
    db: getServerDirectDb(),
    restricted: () => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
    crypto: new LatticeCrypto(),
  });
  app.post("/api/protected/memories/read-observation", async (request, reply) => {
    if (!request.sessionUserId || !request.sessionActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const parsed = humanMemoryReadObservationRequestV1Schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid_memory_read_observation" });
    }
    const acknowledgementBytes = Uint8Array.from(Buffer.from(
      parsed.data.acknowledgementBytesBase64url,
      "base64url",
    ));
    try {
      const status = await consumeHumanMemoryReadAcknowledgement({
        db: resolved.db,
        restricted: resolved.restricted(),
        crypto: resolved.crypto,
        acknowledgementBytes,
        authority: { userId: request.sessionUserId,
          humanActorId: request.sessionActorId },
        now: (resolved.now ?? (() => new Date()))(),
      });
      return reply.send({ status });
    } finally {
      acknowledgementBytes.fill(0);
    }
  });
}
