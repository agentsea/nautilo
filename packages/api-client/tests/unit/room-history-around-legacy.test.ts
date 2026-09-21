import { describe, expect, test } from "bun:test";

import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";

const ROOM = "40000000-0000-4000-8000-000000000275";
const SESSION = "41000000-0000-4000-8000-000000000275";
const NAMESPACE = "42000000-0000-4000-8000-000000000275";
const DIGEST = "A".repeat(43);

function legacyReadySidecar() {
  const coordinate = {
    sessionId: SESSION,
    messageId: 27,
    editRevision: 0,
    role: "user",
    logicalMessageKey: "logical:27",
  } as const;
  return {
    responseVersion: 1,
    status: "ready",
    operationId: "history-read:legacy",
    clientRequestKey: "history-around:legacy",
    selectedCoordinateDigestBase64url: DIGEST,
    selectedCount: 1,
    selectedCoordinates: [coordinate],
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
      coordinate,
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
    signerEvidence: [{
      kind: "human_ai_readable_live_shadow_request_v2",
      operationId: "turn:27",
      planBytesBase64url: "AQ",
      requestBytesBase64url: "Ag",
      requestDigestBase64url: DIGEST,
    }],
    acknowledgement: {
      status: "required",
      tokenBase64url: "dG9rZW4",
      issuedAt: "2026-08-23T12:00:00.000Z",
      expiresAt: "2026-08-23T12:01:00.000Z",
    },
  } as const;
}

describe("Room history around legacy-server compatibility", () => {
  test("parses an old ready sidecar and applies current metadata defaults", async () => {
    let requestedUrl = "";
    const fetchImpl: NautiloApiFetch = async (target) => {
      requestedUrl = typeof target === "string"
        ? target
        : target instanceof URL ? target.href : target.url;
      return new Response(JSON.stringify({
        messages: [],
        target: { createdAt: "2026-08-23T12:00:00.000Z", messageId: "27" },
        includedToolCallCompanion: false,
        hasOlder: false,
        hasNewer: false,
        shadowEncryption: legacyReadySidecar(),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("token");

    const page = await client.getRoomMessagesAround({
      roomId: ROOM,
      messageId: "27",
      shadowRead: {
        requestVersion: 1,
        clientRequestKey: "history-around:legacy",
        readerDeviceId: "device:browser",
      },
    });

    expect(new URL(requestedUrl).searchParams.get("shadowReadMetadataVersion"))
      .toBe("1");
    expect(page.shadowEncryption?.status).toBe("ready");
    if (page.shadowEncryption?.status !== "ready") {
      throw new Error("Expected ready legacy sidecar");
    }
    expect(page.shadowEncryption.terminalExecutions).toEqual([]);
    expect(page.shadowEncryption.signerEvidence[0]).not.toHaveProperty(
      "committerDeviceSigningPublicKeyBase64url",
    );
  });
});
