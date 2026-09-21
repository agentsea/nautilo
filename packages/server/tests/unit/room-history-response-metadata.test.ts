import { describe, expect, test } from "bun:test";
import {
  type RoomHistoryShadowReadResponseV1,
} from "@nautilo/api-client";
import { z } from "zod";

import {
  selectRoomHistoryResponseMetadata,
} from "../../src/routes/room-history-response-metadata";

const ROOM = "40000000-0000-4000-8000-000000000275";
const SESSION = "41000000-0000-4000-8000-000000000275";
const NAMESPACE = "42000000-0000-4000-8000-000000000275";
const HUMAN = "43000000-0000-4000-8000-000000000275";
const DIGEST = "A".repeat(43);

const legacySignerEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum([
      "human_ai_readable_live_shadow_request_v1",
      "human_ai_readable_live_shadow_request_v2",
    ]),
    operationId: z.string(),
    planBytesBase64url: z.string(),
    requestBytesBase64url: z.string(),
    requestDigestBase64url: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("agent_runtime_publication"),
    evidenceBytesBase64url: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("human_peer_live_shadow_request_v1"),
    operationId: z.string(),
    planBytesBase64url: z.string(),
    requestBytesBase64url: z.string(),
    requestDigestBase64url: z.string(),
    senderDeviceId: z.string(),
    senderDeviceSigningKeyGeneration: z.number(),
    senderDeviceSigningPublicKeyBase64url: z.string(),
  }).strict(),
]);

// Pin the strict top-level and signer-evidence shape accepted before retained
// terminal summaries and Human committer keys were added to the V1 response.
const legacyReadyResponseSchema = z.object({
  responseVersion: z.literal(1),
  status: z.literal("ready"),
  operationId: z.string(),
  clientRequestKey: z.string(),
  selectedCoordinateDigestBase64url: z.string(),
  selectedCount: z.number(),
  selectedCoordinates: z.array(z.unknown()),
  eligibleCount: z.number(),
  authority: z.unknown(),
  records: z.array(z.unknown()),
  signerEvidence: z.array(legacySignerEvidenceSchema),
  acknowledgement: z.unknown(),
}).strict();

function readyResponse(): Extract<
  RoomHistoryShadowReadResponseV1,
  { status: "ready" }
> {
  const coordinate = {
    sessionId: SESSION,
    messageId: 27,
    editRevision: 2,
    role: "user" as const,
    logicalMessageKey: "logical:27",
  };
  return {
    responseVersion: 1,
    status: "ready",
    operationId: "history-read:one",
    clientRequestKey: "history-page:one",
    selectedCoordinateDigestBase64url: DIGEST,
    selectedCount: 1,
    selectedCoordinates: [coordinate],
    eligibleCount: 1,
    authority: {
      scheme: "domain_key_v2",
      keyClass: "human",
      subjectHumanId: "human:one",
      readerDeviceId: "device:browser",
      readerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: 1,
      policyRevision: 1,
      roomId: ROOM,
      namespaceId: NAMESPACE,
      namespaceAccessRevision: 0,
      namespaceCurrentGeneration: 1,
      namespaceHeadDigestBase64url: DIGEST,
      domainId: "domain:one",
      domainKeyGeneration: 1,
      domainAuthorizationRevision: 1,
      domainHeadDigestBase64url: DIGEST,
      namespaceBundleRevision: 1,
      namespaceBundleDigestBase64url: DIGEST,
    },
    records: [{
      kind: "human_edited_representation",
      representationMode: "protected-only",
      coordinate,
      selectedSource: {
        role: "user",
        logicalMessageKey: "logical:27",
        sourceUserId: HUMAN,
      },
      authorHumanId: HUMAN,
      committerDeviceSigningPublicKeyBase64url: DIGEST,
      retainedGeneration: {
        namespaceGeneration: 1,
        accessRevision: 0,
        headDigestBase64url: DIGEST,
        publicationDigestBase64url: DIGEST,
        publicationSetDigestBase64url: DIGEST,
        audienceFingerprintBase64url: DIGEST,
      },
      protectedMessage: {
        dtoVersion: 2,
        projection: {
          messageId: "27",
          logicalMessageKey: "logical:27",
          sessionId: SESSION,
          roomId: ROOM,
          namespaceId: NAMESPACE,
          role: "user",
          createdAt: "2026-08-23T12:00:00.000Z",
          editRevision: 2,
        },
        protectedPayload: { status: "pending", reason: "shadow_pending" },
      },
    }],
    signerEvidence: [
      {
        kind: "human_ai_readable_live_shadow_request_v1",
        operationId: "turn:v1",
        planBytesBase64url: "AQ",
        requestBytesBase64url: "Ag",
        requestDigestBase64url: DIGEST,
        committerDeviceSigningPublicKeyBase64url: DIGEST,
      },
      {
        kind: "human_ai_readable_live_shadow_request_v2",
        operationId: "turn:v2",
        planBytesBase64url: "Aw",
        requestBytesBase64url: "BA",
        requestDigestBase64url: DIGEST,
        committerDeviceSigningPublicKeyBase64url: DIGEST,
      },
      {
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: "BQ",
      },
      {
        kind: "human_peer_live_shadow_request_v1",
        operationId: "turn:peer",
        planBytesBase64url: "Bg",
        requestBytesBase64url: "Bw",
        requestDigestBase64url: DIGEST,
        senderDeviceId: "device:sender",
        senderDeviceSigningKeyGeneration: 1,
        senderDeviceSigningPublicKeyBase64url: "CA",
      },
    ],
    terminalExecutions: [{
      messageId: 27,
      executionId: "execution:cancelled",
      classification: "cancelled",
    }],
    acknowledgement: {
      status: "required",
      tokenBase64url: "dG9rZW4",
      issuedAt: "2026-08-23T12:00:00.000Z",
      expiresAt: "2026-08-23T12:01:00.000Z",
    },
  };
}

describe("Room history response metadata compatibility", () => {
  test("projects ready responses into the legacy strict shape without mutating signer controls", () => {
    const response = readyResponse();
    expect(legacyReadyResponseSchema.safeParse(response).success).toBeFalse();
    const projected = selectRoomHistoryResponseMetadata(response, {});

    expect(legacyReadyResponseSchema.safeParse(projected).success).toBeTrue();
    expect(projected).not.toBe(response);
    expect(projected).not.toHaveProperty("terminalExecutions");
    if (projected.status !== "ready") {
      throw new Error("Expected projected ready history response");
    }
    expect(projected.signerEvidence.slice(0, 2).every((evidence) =>
      !("committerDeviceSigningPublicKeyBase64url" in evidence)
    )).toBeTrue();
    expect(projected.signerEvidence.slice(2)).toEqual(response.signerEvidence.slice(2));
    expect(projected.signerEvidence[3]).toHaveProperty(
      "senderDeviceSigningPublicKeyBase64url",
      "CA",
    );
    expect(projected.records[0]).toEqual(response.records[0]);
    expect(projected.records[0]).toHaveProperty(
      "committerDeviceSigningPublicKeyBase64url",
      DIGEST,
    );
    expect(response).toHaveProperty("terminalExecutions");
    expect(response.signerEvidence[0]).toHaveProperty(
      "committerDeviceSigningPublicKeyBase64url",
      DIGEST,
    );
  });

  test("returns opted-in, disabled, and unavailable responses by identity", () => {
    const ready = readyResponse();
    expect(selectRoomHistoryResponseMetadata(ready, {
      shadowReadMetadataVersion: "1",
    })).toBe(ready);

    const disabled = {
      responseVersion: 1,
      status: "disabled",
      mode: "plaintext_only",
    } as const;
    const unavailable = {
      responseVersion: 1,
      status: "unavailable",
      operationId: "history-read:unavailable",
      clientRequestKey: "history-page:unavailable",
      policyRevision: 1,
      selectedCoordinateDigestBase64url: DIGEST,
      selectedCount: 0,
      eligibleCount: 1,
      reason: "current_read_authority_unavailable",
    } as const;
    expect(selectRoomHistoryResponseMetadata(disabled, null)).toBe(disabled);
    expect(selectRoomHistoryResponseMetadata(unavailable, {})).toBe(unavailable);
  });

  test("treats malformed metadata opt-ins as legacy requests", () => {
    for (const query of [
      null,
      "shadowReadMetadataVersion=1",
      {},
      { shadowReadMetadataVersion: 1 },
      { shadowReadMetadataVersion: "2" },
      { shadowReadMetadataVersion: ["1"] },
    ]) {
      const projected = selectRoomHistoryResponseMetadata(readyResponse(), query);
      expect(projected).not.toHaveProperty("terminalExecutions");
      if (projected.status !== "ready") {
        throw new Error("Expected projected ready history response");
      }
      expect(projected.signerEvidence[0]).not.toHaveProperty(
        "committerDeviceSigningPublicKeyBase64url",
      );
    }
  });
});
