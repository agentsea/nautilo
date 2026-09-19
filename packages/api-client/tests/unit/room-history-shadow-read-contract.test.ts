import { describe, expect, test } from "bun:test";

import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";
import {
  roomHistoryShadowReadAcknowledgementRequestV1Schema,
  roomHistoryShadowReadResponseV1Schema,
} from "../../src/schemas/room-history-shadow-read";

const ROOM = "40000000-0000-4000-8000-000000000275";
const SESSION = "41000000-0000-4000-8000-000000000275";
const NAMESPACE = "42000000-0000-4000-8000-000000000275";
const DIGEST = "A".repeat(43);

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readySidecar() {
  return {
    responseVersion: 1,
    status: "ready",
    operationId: "history-read:one",
    clientRequestKey: "history-page:one",
    selectedCoordinateDigestBase64url: DIGEST,
    selectedCount: 1,
    selectedCoordinates: [{
      sessionId: SESSION,
      messageId: 27,
      editRevision: 0,
      role: "user",
      logicalMessageKey: "logical:27",
    }],
    eligibleCount: 1,
    authority: {
      scheme: "domain_key_v2",
      keyClass: "ai",
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
      coordinate: {
        sessionId: SESSION,
        messageId: 27,
        editRevision: 0,
        role: "user",
        logicalMessageKey: "logical:27",
      },
      shadowOperationId: "turn:27",
      shadowTranscriptOrdinal: 1,
      ordinaryPayloadBytesBase64url: "e30",
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
          editRevision: 0,
        },
        protectedPayload: { status: "pending", reason: "shadow_pending" },
      },
    }],
    signerEvidence: [],
    terminalExecutions: [],
    acknowledgement: {
      status: "required",
      tokenBase64url: "dG9rZW4",
      issuedAt: "2026-08-23T12:00:00.000Z",
      expiresAt: "2026-08-23T12:01:00.000Z",
    },
  } as const;
}

describe("Room history Shadow-read HTTP contract", () => {
  test("projects one exact edited coordinate through the canonical sidecar route", async () => {
    let seen = "";
    let body: unknown;
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      seen = typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url;
      if (typeof init?.body !== "string") throw new Error("Expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return json(readySidecar());
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("token");
    await client.getRoomMessageShadowRead({ roomId: ROOM,
      intent: { requestVersion: 1, clientRequestKey: "edit:two", readerDeviceId: "device:browser" },
      coordinate: { sessionId: SESSION, messageId: 27, editRevision: 2,
        role: "user", logicalMessageKey: "logical:27" } });
    expect(seen).toEndWith(`/api/rooms/${ROOM}/messages/shadow-read`);
    expect(body).toMatchObject({ coordinate: { editRevision: 2 }, intent: { requestVersion: 1 } });
  });
  test("adds explicit intent to the canonical history page and parses its sidecar", async () => {
    let seen = "";
    const fetchImpl: NautiloApiFetch = async (target) => {
      seen = typeof target === "string"
        ? target
        : target instanceof URL ? target.href : target.url;
      return json({
        messages: [],
        pageInfo: { hasMoreBefore: false, oldestCursor: null },
        shadowEncryption: readySidecar(),
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("token");
    const page = await client.getOlderRoomMessages({
      roomId: ROOM,
      beforeId: "99",
      beforeCreatedAt: "2026-08-23T12:00:00.000Z",
      limit: 50,
      shadowRead: {
        requestVersion: 1,
        clientRequestKey: "history-page:one",
        readerDeviceId: "device:browser",
      },
    });
    expect(seen).toContain("shadowReadVersion=1");
    expect(seen).toContain("shadowReadRequestKey=history-page%3Aone");
    expect(seen).toContain("shadowReadDeviceId=device%3Abrowser");
    expect(page.shadowEncryption?.status).toBe("ready");
  });

  test("keeps authority closure and the eligible-record count strict", () => {
    const value = readySidecar();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse(value).success)
      .toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      authority: {
        ...value.authority,
        domainAuthorizationRevision: undefined,
      },
    }).success).toBeFalse();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      eligibleCount: 2,
    }).success).toBeFalse();
  });

  test("closes terminal summaries to selected Human inputs and stable execution identities", () => {
    const value = readySidecar();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      terminalExecutions: [
        { messageId: 27, executionId: "execution:cancelled", classification: "cancelled" },
        { messageId: 27, executionId: "execution:lost", classification: "process_lost" },
      ],
    }).success).toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      terminalExecutions: [
        { messageId: 28, executionId: "execution:foreign", classification: "cancelled" },
      ],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      terminalExecutions: [
        { messageId: 27, executionId: "execution:same", classification: "cancelled" },
        { messageId: 27, executionId: "execution:same", classification: "process_lost" },
      ],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      terminalExecutions: [
        { messageId: 27, executionId: "execution:bad", classification: "deadline_expired" },
      ],
    }).success).toBeFalse();
  });

  test("keeps plaintext history sidecars unchanged", () => {
    expect(roomHistoryShadowReadResponseV1Schema.parse({
      responseVersion: 1,
      status: "disabled",
      mode: "plaintext_only",
    })).toEqual({
      responseVersion: 1,
      status: "disabled",
      mode: "plaintext_only",
    });
  });

  test("accepts an optional retained Human signing key only at the exact wire size", () => {
    const value = readySidecar();
    const evidence = {
      kind: "human_ai_readable_live_shadow_request_v2" as const,
      operationId: "turn:shared-human",
      planBytesBase64url: "AQ",
      requestBytesBase64url: "Ag",
      requestDigestBase64url: DIGEST,
    };
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      signerEvidence: [{
        ...evidence,
        committerDeviceSigningPublicKeyBase64url: DIGEST,
      }],
    }).success).toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      signerEvidence: [{
        ...evidence,
        committerDeviceSigningPublicKeyBase64url: "A".repeat(42),
      }],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      signerEvidence: [evidence],
    }).success).toBeTrue();
  });

  test("preserves mixed-class authorities as one combined ready sidecar", () => {
    const value = readySidecar();
    const authorities = [
      value.authority,
      { ...value.authority, keyClass: "human" as const, domainKeyGeneration: 2 },
    ];
    const parsed = roomHistoryShadowReadResponseV1Schema.parse({
      ...value,
      authorities,
    });
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") throw new Error("Expected ready sidecar");
    expect(parsed.authority).toEqual(value.authority);
    expect(parsed.authorities).toEqual(authorities);
    expect(parsed.records).toHaveLength(1);
  });

  test("preserves legacy Runtime repair evidence and closes device evidence", () => {
    const value = readySidecar();
    const live = value.records[0];
    const runtimeRepair = {
      identityDigestBase64url: DIGEST,
      allocationDigestBase64url: DIGEST,
      attestationDigestBase64url: DIGEST,
      publisherSignerKeyId: "runtime:key:one",
      publisherSigningPublicKeyBase64url: DIGEST,
    };
    const runtimeRecord = {
      kind: "existing_representation" as const,
      coordinate: live.coordinate,
      protectedMessage: live.protectedMessage,
      repair: runtimeRepair,
    };
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      records: [{ ...runtimeRecord, ordinaryPayloadBytesBase64url: "e30" }],
    }).success).toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      records: [{
        ...runtimeRecord,
        repair: { ...runtimeRepair, publisherKind: "foreground_runtime" },
      }],
    }).success).toBeTrue();

    const deviceRecord = {
      ...runtimeRecord,
      repair: {
        ...runtimeRepair,
        publisherKind: "human_device" as const,
        publisherHumanId: "43000000-0000-4000-8000-000000000275",
      },
      retainedGeneration: live.retainedGeneration,
    };
    const parsed = roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value, records: [deviceRecord],
    });
    expect(parsed.success).toBeTrue();
    if (!parsed.success || parsed.data.status !== "ready") {
      throw new Error("Expected device existing-representation record");
    }
    expect(parsed.data.records[0]).toEqual(deviceRecord);
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      records: [{ ...deviceRecord, retainedGeneration: undefined }],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      records: [{
        ...deviceRecord,
        repair: { ...deviceRecord.repair, publisherHumanId: undefined },
      }],
    }).success).toBeFalse();
    const runtimeWithRetained = roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      records: [{ ...runtimeRecord, retainedGeneration: live.retainedGeneration }],
    });
    expect(runtimeWithRetained.success).toBeTrue();
    if (!runtimeWithRetained.success || runtimeWithRetained.data.status !== "ready") {
      throw new Error("Expected Runtime retained-generation evidence");
    }
    expect(runtimeWithRetained.data.records[0]).toMatchObject({
      repair: runtimeRepair,
      retainedGeneration: live.retainedGeneration,
    });
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      records: [{
        ...runtimeRecord,
        representationMode: "protected-only",
        selectedSource: { role: "user", logicalMessageKey: "logical:27" },
        ordinaryPayloadBytesBase64url: "e30",
      }],
    }).success).toBeFalse();
  });

  test("accepts only protected transport for an authenticated Human edit", () => {
    const value = readySidecar();
    const coordinate = { ...value.records[0].coordinate, editRevision: 2 };
    const record = {
      kind: "human_edited_representation", representationMode: "protected-only",
      coordinate, selectedSource: { role: "user", logicalMessageKey: "logical:27",
        sourceUserId: "43000000-0000-4000-8000-000000000275" },
      authorHumanId: "44000000-0000-4000-8000-000000000275",
      committerDeviceSigningPublicKeyBase64url: DIGEST,
      retainedGeneration: value.records[0].retainedGeneration,
      protectedMessage: { ...value.records[0].protectedMessage,
        projection: { ...value.records[0].protectedMessage.projection, editRevision: 2 } },
    };
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({ ...value,
      authority: { ...value.authority, keyClass: "human" },
      selectedCoordinates: [coordinate], records: [record] }).success).toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({ ...value,
      authority: { ...value.authority, keyClass: "human" },
      selectedCoordinates: [coordinate],
      records: [{ ...record, ordinaryPayloadBytesBase64url: "e30" }] }).success).toBeFalse();
  });

  test("requires structural source and forbids ordinary bytes for Full history", () => {
    const value = readySidecar();
    const ordinary = value.records[0];
    const { ordinaryPayloadBytesBase64url: _ordinary, ...protectedRecord } = ordinary;
    const fullRecord = {
      ...protectedRecord,
      representationMode: "protected-only" as const,
      selectedSource: { role: "user" as const, logicalMessageKey: "logical:27" },
    };
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value, records: [fullRecord],
    }).success).toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value, records: [{
        ...fullRecord,
        ordinaryPayloadBytesBase64url: ordinary.ordinaryPayloadBytesBase64url,
      }],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value, records: [{ ...protectedRecord, representationMode: "protected-only" }],
    }).success).toBeFalse();
  });

  test("admits Human-only history through Domain Key V2 and rejects old authority bytes", () => {
    const value = readySidecar();
    const human = {
      ...value,
      authority: {
        ...value.authority,
        scheme: "domain_key_v2" as const,
        keyClass: "human" as const,
        subjectHumanId: "human:peer",
      },
      signerEvidence: [{
        kind: "human_peer_live_shadow_request_v1" as const,
        operationId: "turn:human-peer",
        planBytesBase64url: "AQ",
        requestBytesBase64url: "Ag",
        requestDigestBase64url: DIGEST,
        senderDeviceId: "device:sender",
        senderDeviceSigningKeyGeneration: 1,
        senderDeviceSigningPublicKeyBase64url: "Aw",
      }],
    };
    expect(roomHistoryShadowReadResponseV1Schema.safeParse(human).success)
      .toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...human,
      authority: {
        ...human.authority,
        grantDomain: { grantDomainId: "retired" },
      },
    }).success).toBeFalse();
  });

  test("accepts the exact V4 establishment evidence ceiling", () => {
    const value = readySidecar();
    const evidence = {
      kind: "human_live_shadow_request_v4" as const,
      operationId: "turn:large-domain-set",
      planBytesBase64url: "A".repeat(350_000),
      requestBytesBase64url: "A".repeat(699_052),
      requestDigestBase64url: DIGEST,
    };
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      signerEvidence: [evidence],
    }).success).toBeTrue();
    expect(roomHistoryShadowReadResponseV1Schema.safeParse({
      ...value,
      signerEvidence: [{
        ...evidence,
        requestBytesBase64url: `${evidence.requestBytesBase64url}A`,
      }],
    }).success).toBeFalse();
  });

  test("submits only signed or closed pre-signing outcomes", async () => {
    let body: unknown;
    const fetchImpl: NautiloApiFetch = async (_target, init) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("expected a JSON request body");
      }
      body = JSON.parse(init.body);
      return json({
        responseVersion: 1,
        status: "accepted",
        operationId: "history-read:one",
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("token");
    await client.acknowledgeRoomHistoryShadowRead(ROOM, {
      requestVersion: 1,
      status: "client_unavailable",
      operationId: "history-read:one",
      tokenBase64url: "dG9rZW4",
      reason: "client_custody_unavailable",
    });
    expect(body).toEqual({
      requestVersion: 1,
      status: "client_unavailable",
      operationId: "history-read:one",
      tokenBase64url: "dG9rZW4",
      reason: "client_custody_unavailable",
    });
  });

  test("preserves exact V2 repair bytes and requires an explicit class in V3", () => {
    const coordinate = {
      sessionId: SESSION, messageId: 7, editRevision: 0,
      role: "user" as const, logicalMessageKey: "human:turn:7",
    };
    const repair = {
      version: 2 as const, purpose: "human_device_ordinary_repair" as const,
      operationId: "history:repair", policyRevision: 4,
      subjectHumanId: "human:one", readerDeviceId: "device:one",
      readerDeviceSigningKeyGeneration: 2, hostAuthorizationRevision: 3,
      roomId: ROOM, namespaceId: NAMESPACE, namespaceAccessRevision: 5,
      namespaceKeyGeneration: 6, sessionId: SESSION, messageId: 7,
      editRevision: 0, cryptoObjectId: "message:protected:7",
      authorRole: "user" as const, createdAt: 1_700_000_000_000,
      payloadDigestBase64url: DIGEST, payloadBytesBase64url: "e30",
      issuedAt: 1_700_000_000_000, deadlineAt: 1_700_000_060_000,
      signatureBase64url: "A".repeat(86),
    };
    const request = {
      requestVersion: 2 as const, status: "signed_with_ordinary_repairs" as const,
      operationId: "history:repair", tokenBase64url: "dG9rZW4",
      acknowledgementBytesBase64url: "AQ", selectedCoordinates: [coordinate],
      ordinaryRepairs: [repair],
    };
    expect(roomHistoryShadowReadAcknowledgementRequestV1Schema.safeParse(request).success)
      .toBeTrue();
    expect(roomHistoryShadowReadAcknowledgementRequestV1Schema.safeParse({
      ...request,
      ordinaryRepairs: [{ ...repair, keyClass: "human" }],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadAcknowledgementRequestV1Schema.safeParse({
      ...request,
      ordinaryRepairs: [{ ...repair, version: 3, keyClass: "ai" }],
    }).success).toBeTrue();
    expect(roomHistoryShadowReadAcknowledgementRequestV1Schema.safeParse({
      ...request,
      ordinaryRepairs: [{ ...repair, version: 3 }],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadAcknowledgementRequestV1Schema.safeParse({
      ...request,
      ordinaryRepairs: [{ ...repair, ordinaryPayloadBytesBase64url: "c2VjcmV0" }],
    }).success).toBeFalse();
    expect(roomHistoryShadowReadAcknowledgementRequestV1Schema.safeParse({
      ...request, ordinaryRepairs: [{ ...repair, policyRevision: 0 }],
    }).success).toBeFalse();
  });
});
