import { describe, expect, test } from "bun:test";

import { NautiloApiClient, type NautiloApiFetch } from "../../src/client.ts";
import {
  LIVE_SHADOW_AGENT_GRANT_DOMAIN_COUNT,
  LIVE_SHADOW_AUTHORIZATION_RAW_BYTES,
  LIVE_SHADOW_MESSAGE_PLAN_RAW_BYTES,
  LIVE_SHADOW_SIGNED_REQUEST_RAW_BYTES,
  fullEncryptionMessagePreparedRequestV2Schema,
  fullEncryptionMessageRecoveryResponseV2Schema,
  fullEncryptionMessageSubmissionV2Schema,
  humanMessageEditPlanRequestV1Schema,
  humanMessageEditPreparedRequestV1Schema,
  liveShadowMessagePreparedRequestV1Schema,
  liveShadowMessagePlanRequestV1Schema,
  liveShadowMessagePlanRequestV2Schema,
  liveShadowMessagePlanRequestSchema,
  liveShadowMessagePlanResponseV1Schema,
  liveShadowMessageRecoveryResponseV1Schema,
  liveShadowMessageSendAttemptV1Schema,
  runtimeInvocationAuthorizationRequestV1Schema,
} from "../../src/schemas/live-shadow-message.ts";

const ROOM = "40000000-0000-4000-8000-000000000282";

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("live Shadow Message HTTP contract", () => {
  test("opts into five-minute planning without changing legacy or Full request versions", async () => {
    const legacy = {
      requestVersion: 1, clientActionSessionId: "socket:m322",
      clientDeviceId: "device:m322", idempotencyKey: "request:m322", requestShape: "text_only",
    } as const;
    const modern = { ...legacy, requestVersion: 2 } as const;
    expect(liveShadowMessagePlanRequestV1Schema.parse(legacy)).toEqual(legacy);
    expect(liveShadowMessagePlanRequestV1Schema.safeParse(modern).success).toBeFalse();
    expect(liveShadowMessagePlanRequestV2Schema.parse(modern)).toEqual(modern);
    for (const request of [legacy, modern]) {
      expect(liveShadowMessagePlanRequestSchema.parse(request)).toEqual(request);
      expect(liveShadowMessagePlanRequestSchema.safeParse({ ...request, content: "not a plan" }).success).toBeFalse();
    }
    expect(liveShadowMessagePlanRequestSchema.safeParse({ ...modern, requestVersion: 3 }).success).toBeFalse();
    const planned = {
      responseVersion: 1, status: "planned", planBytesBase64url: "AQ",
      authorizationScheme: "human_ai_readable_v2",
    } as const;
    const calls: unknown[] = [];
    const client = new NautiloApiClient("https://example.test", {
      fetchImpl: async (_target, init) => {
        calls.push(JSON.parse(init!.body as string));
        return response(planned);
      },
    });
    expect(await client.planLiveShadowRoomMessage(ROOM, modern)).toEqual(planned);
    expect(calls).toEqual([modern]);
    const prepared = {
      status: "prepared", operationId: "request:m322", authorizationScheme: "human_ai_readable_v2",
      planBytesBase64url: "AQ", signedRequestBytesBase64url: "Ag",
      encryptedPayloadBytesBase64url: "Aw", accessManifestBytesBase64url: "BA",
      namespaceEnvelopeBytesBase64url: "BQ",
    } as const;
    const shadow = { ...prepared, requestVersion: 1, ordinaryPayloadBytesBase64url: "AQ" } as const;
    const full = { ...prepared, requestVersion: 2, representationMode: "full_encryption" } as const;
    expect(liveShadowMessagePreparedRequestV1Schema.parse(shadow)).toEqual(shadow);
    expect(fullEncryptionMessagePreparedRequestV2Schema.parse(full)).toEqual(full);
    expect(fullEncryptionMessagePreparedRequestV2Schema.safeParse({ ...full, ordinaryPayloadBytesBase64url: "AQ" }).success).toBeFalse();
  });

  test("keeps Full Human edit transport protected-only and target-complete", async () => {
    expect(humanMessageEditPlanRequestV1Schema.parse({
      requestVersion: 1,
      clientDeviceId: "device:one",
      expectedRevision: 4,
      clientIdempotencyKey: "edit:one",
    })).toEqual({
      requestVersion: 1,
      clientDeviceId: "device:one",
      expectedRevision: 4,
      clientIdempotencyKey: "edit:one",
    });
    const prepared = humanMessageEditPreparedRequestV1Schema.parse({
      requestVersion: 1,
      representationMode: "full_encryption",
      planBytesBase64url: "AQ",
      signedRequestBytesBase64url: "Ag",
      preparedTargets: [{
        sessionId: ROOM,
        messageId: 42,
        encryptedPayloadBytesBase64url: "Aw",
        accessManifestBytesBase64url: "BA",
        namespaceEnvelopeBytesBase64url: "BQ",
      }],
    });
    expect(humanMessageEditPreparedRequestV1Schema.parse(prepared)).toEqual(prepared);
    for (const invalid of [
      { ...prepared, content: "plaintext" },
      { ...prepared, representationMode: "shadow" },
      { ...prepared, preparedTargets: [] },
      { ...prepared, preparedTargets: [prepared.preparedTargets[0], prepared.preparedTargets[0]] },
    ]) {
      expect(humanMessageEditPreparedRequestV1Schema.safeParse(invalid).success).toBeFalse();
    }

    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl: NautiloApiFetch = async (input, init) => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return response(calls.length === 1
        ? { responseVersion: 1, status: "planned", representationMode: "full_encryption", planBytesBase64url: "AQ" }
        : { responseVersion: 1, status: "published", representationMode: "full_encryption", editRevision: 5, targets: [{ sessionId: ROOM, messageId: 42, cryptoObjectId: "object:next" }] });
    };
    const client = new NautiloApiClient("https://example.test", { fetchImpl });
    await client.planProtectedHumanMessageEdit(ROOM, "42", {
      requestVersion: 1, clientDeviceId: "device:one", expectedRevision: 4, clientIdempotencyKey: "edit:one",
    });
    await client.publishProtectedHumanMessageEdit(ROOM, "42", prepared);
    expect(calls).toEqual([
      { url: `https://example.test/api/rooms/${ROOM}/messages/42/edit-plan`, method: "POST", body: { requestVersion: 1, clientDeviceId: "device:one", expectedRevision: 4, clientIdempotencyKey: "edit:one" } },
      { url: `https://example.test/api/rooms/${ROOM}/messages/42/protected`, method: "PATCH", body: prepared },
    ]);
    expect(JSON.stringify(calls)).not.toContain("plaintext");
  });

  test("keeps Full V2 protected-only and explicitly versioned", () => {
    const prepared = {
      requestVersion: 2,
      representationMode: "full_encryption",
      status: "prepared",
      operationId: "full:m318",
      planBytesBase64url: "AQ",
      signedRequestBytesBase64url: "Ag",
      encryptedPayloadBytesBase64url: "Aw",
      accessManifestBytesBase64url: "BA",
      namespaceEnvelopeBytesBase64url: "BQ",
      authorizationScheme: "human_peer_v1",
    } as const;
    expect(fullEncryptionMessagePreparedRequestV2Schema.parse(prepared))
      .toEqual(prepared);
    expect(fullEncryptionMessageSubmissionV2Schema.safeParse({
      submissionVersion: 2,
      representationMode: "full_encryption",
      prepared,
    }).success).toBeTrue();
    for (const malformed of [
      { ...prepared, requestVersion: 1 },
      { ...prepared, representationMode: "shadow" },
      { ...prepared, ordinaryPayloadBytesBase64url: "cGxhaW50ZXh0" },
      { ...prepared, encryptedPayloadBytesBase64url: "!" },
    ]) {
      expect(fullEncryptionMessagePreparedRequestV2Schema.safeParse(malformed).success)
        .toBeFalse();
    }
    const recovery = {
      responseVersion: 2,
      representationMode: "full_encryption",
      status: "absent",
    } as const;
    expect(fullEncryptionMessageRecoveryResponseV2Schema.parse(recovery))
      .toEqual(recovery);
    expect(fullEncryptionMessageRecoveryResponseV2Schema.safeParse({
      ...recovery,
      ordinaryPayloadBytesBase64url: "cGxhaW50ZXh0",
    }).success).toBeFalse();
  });
  test("accepts content-free failed planning diagnostics without fabricating a plan", () => {
    for (const reason of [
      "policy_unavailable", "device_unavailable", "agent_authority_unavailable",
      "domain_unavailable", "namespace_unavailable", "recipient_sync_required",
      "reservation_unavailable", "client_not_browser", "room_topology_unsupported",
      "request_shape_unsupported", "request_failed", "invalid_plan",
    ] as const) {
      const diagnostic = { requestVersion: 1, status: "plan_unavailable", reason } as const;
      expect(liveShadowMessageSendAttemptV1Schema.parse(diagnostic)).toEqual(diagnostic);
      for (const extra of [{ operationId: "fabricated" }, { planBytesBase64url: "AQ" },
        { encryptedPayloadBytesBase64url: "AQ" }, { verified: true }]) {
        expect(liveShadowMessageSendAttemptV1Schema.safeParse({ ...diagnostic, ...extra }).success)
          .toBeFalse();
      }
    }
    expect(liveShadowMessageSendAttemptV1Schema.safeParse({
      requestVersion: 1, status: "plan_unavailable", reason: "arbitrary_server_error",
    }).success).toBeFalse();
  });

  test("keeps published Human recovery separate from Agent turn completion", () => {
    const receipt = {
      responseVersion: 1, status: "human_published", operationId: "original-operation",
      authorizationScheme: "human_ai_readable_v1",
      acceptedHumanRequestDigestBase64url: "A".repeat(43),
      human: { protectedMessage: { dtoVersion: 2,
        projection: { messageId: "1", sessionId: ROOM, roomId: ROOM, namespaceId: ROOM,
          role: "user", editRevision: 0, createdAt: "2026-01-01T00:00:00.000Z" },
        protectedPayload: { status: "encrypted", cryptoObjectId: "original-object", payloadVersion: 2,
          keyClass: "ai", encryptedPayloadBytesBase64url: "AQ", accessManifestBytesBase64url: "Ag",
          namespaceEnvelopeBytesBase64url: "Aw" } } },
    } as const;
    expect(liveShadowMessageRecoveryResponseV1Schema.parse(receipt)).toEqual(receipt);
    const modernReceipt = { ...receipt, authorizationScheme: "human_ai_readable_v2" } as const;
    expect(liveShadowMessageRecoveryResponseV1Schema.parse(modernReceipt)).toEqual(modernReceipt);
    const fullModernReceipt = {
      ...modernReceipt, responseVersion: 2, representationMode: "full_encryption",
    } as const;
    expect(fullEncryptionMessageRecoveryResponseV2Schema.parse(fullModernReceipt)).toEqual(fullModernReceipt);
    for (const changed of [
      { ...receipt, acceptedHumanRequestDigestBase64url: "AQ" },
      { ...receipt, authorizationScheme: "unknown_v1" },
      { ...receipt, jobId: ROOM },
      { ...receipt, plaintext: "must not be returned" },
    ]) expect(liveShadowMessageRecoveryResponseV1Schema.safeParse(changed).success).toBeFalse();
  });

  test("uses a bodyless authenticated teardown before explicit logout", async () => {
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = typeof target === "string"
        ? target
        : target instanceof URL ? target.href : target.url;
      calls.push({ url, method: init?.method, body: init?.body });
      return new Response(null, { status: 204 });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("token");
    await client.teardownLiveShadowForegroundAuthorizationSessions();
    expect(calls).toEqual([{
      url: "https://nautilo.test/api/live-shadow/foreground-authorization-sessions",
      method: "DELETE",
      body: undefined,
    }]);
  });

  test("uses a coordinate-first plan and carries ordinary/protected siblings once", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = typeof target === "string"
        ? target
        : target instanceof URL ? target.href : target.url;
      if (typeof init?.body !== "string") throw new Error("request body missing");
      const body = JSON.parse(init.body) as unknown;
      calls.push({ url, body });
      if (url.endsWith("/live-shadow/plan")) {
        return response({
          responseVersion: 1,
          status: "planned",
          planBytesBase64url: "cGxhbg",
        });
      }
      return response({
        messageId: 282,
        jobId: "job-m282",
        accepted: true,
        attachments: [],
        coalesced: false,
        liveShadow: {
          responseVersion: 1,
          status: "human_verified",
          operationId: "live-shadow:m282:1",
        },
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("token");
    expect(await client.planLiveShadowRoomMessage(ROOM, {
      requestVersion: 1,
      clientActionSessionId: "client-action:m282",
      clientDeviceId: "device_m282_browser",
      idempotencyKey: "send:m282:1",
      requestShape: "text_only",
    })).toEqual({
      responseVersion: 1,
      status: "planned",
      planBytesBase64url: "cGxhbg",
    });

    const protectedSibling = {
      requestVersion: 1 as const,
      status: "prepared" as const,
      operationId: "live-shadow:m282:1",
      planBytesBase64url: "cGxhbg",
      signedRequestBytesBase64url: "cmVxdWVzdA",
      ordinaryPayloadBytesBase64url: "b3JkaW5hcnk",
      encryptedPayloadBytesBase64url: "ZW5jcnlwdGVk",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      grantBytesBase64url: "Z3JhbnQ",
    };
    expect((await client.sendRoomMessage(ROOM, {
      content: "one canonical message",
      clientActionSessionId: "client-action:m282",
      liveShadow: protectedSibling,
    })).liveShadow).toMatchObject({ status: "human_verified" });
    expect(calls).toEqual([
      {
        url: `https://nautilo.test/api/rooms/${ROOM}/live-shadow/plan`,
        body: {
          requestVersion: 1,
          clientActionSessionId: "client-action:m282",
          clientDeviceId: "device_m282_browser",
          idempotencyKey: "send:m282:1",
          requestShape: "text_only",
        },
      },
      {
        url: `https://nautilo.test/api/rooms/${ROOM}/messages`,
        body: {
          content: "one canonical message",
          clientActionSessionId: "client-action:m282",
          liveShadow: protectedSibling,
        },
      },
    ]);
  });

  test("keeps plan/result vocabularies closed and prepared bytes bounded", () => {
    const foregroundPrepared = {
      requestVersion: 1 as const,
      status: "prepared" as const,
      operationId: "live-shadow:m294:1",
      planBytesBase64url: "cGxhbg",
      signedRequestBytesBase64url: "cmVxdWVzdA",
      ordinaryPayloadBytesBase64url: "b3JkaW5hcnk",
      encryptedPayloadBytesBase64url: "ZW5jcnlwdGVk",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      authorizationScheme: "foreground_session_v1" as const,
    };
    expect(liveShadowMessagePreparedRequestV1Schema.safeParse(
      foregroundPrepared,
    ).success).toBeTrue();
    expect(liveShadowMessagePreparedRequestV1Schema.safeParse({
      ...foregroundPrepared,
      grantBytesBase64url: "Z3JhbnQ",
    }).success).toBeFalse();
    const { authorizationScheme: _authorizationScheme, ...withoutProof } =
      foregroundPrepared;
    expect(liveShadowMessagePreparedRequestV1Schema.safeParse(
      withoutProof,
    ).success).toBeFalse();
    expect(liveShadowMessagePlanRequestV1Schema.safeParse({
      requestVersion: 1,
      clientActionSessionId: "client-action:m282",
      clientDeviceId: "device:m282",
      idempotencyKey: "send:m282",
      requestShape: "text_only",
      roomId: ROOM,
    }).success).toBeFalse();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "ineligible",
      reason: "shared_room",
    }).success).toBeFalse();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "unavailable",
      reason: "namespace_unavailable",
    }).success).toBeFalse();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "unavailable",
      authorizationScheme: "human_peer_v1",
      reason: "namespace_unavailable",
      requiredNamespaceIds: [
        "40000000-0000-4000-8000-000000000290",
        "40000000-0000-4000-8000-000000000291",
      ],
    }).success).toBeTrue();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "unavailable",
      authorizationScheme: "agent_grant_v1",
      reason: "namespace_unavailable",
      requiredNamespaceIds: [
        "40000000-0000-4000-8000-000000000290",
      ],
    }).success).toBeFalse();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "unavailable",
      reason: "recipient_sync_required",
    }).success).toBeFalse();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "unavailable",
      reason: "recipient_sync_required",
      requiredNamespaceIds: [
        "40000000-0000-4000-8000-000000000290",
      ],
    }).success).toBeTrue();
    expect(liveShadowMessagePreparedRequestV1Schema.safeParse({
      requestVersion: 1,
      status: "prepared",
      operationId: "live-shadow:m282:1",
      planBytesBase64url: "cGxhbg",
      signedRequestBytesBase64url: "cmVxdWVzdA",
      ordinaryPayloadBytesBase64url: "b3JkaW5hcnk",
      encryptedPayloadBytesBase64url: "ZW5jcnlwdGVk",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      grantBytesBase64url: "Z3JhbnQ",
      plaintext: "must not travel twice",
    }).success).toBeFalse();
    expect(liveShadowMessageRecoveryResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "fallback",
      state: "failed",
      jobId: null,
      reason: "invented_failure",
    }).success).toBeFalse();
  });

  test("accepts a populated-clone-sized complete Namespace authority plan", async () => {
    // The m290-qa account has 37 readable Namespaces. Its canonical nested
    // Agent Grant plan alone is 9,242 raw bytes, so the complete plan is
    // necessarily larger than the former 10,923-character transport ceiling.
    const populatedClonePlanBytesBase64url = "A".repeat(13_500);
    expect(liveShadowMessagePlanResponseV1Schema.parse({
      responseVersion: 1,
      status: "planned",
      planBytesBase64url: populatedClonePlanBytesBase64url,
    })).toEqual({
      responseVersion: 1,
      status: "planned",
      planBytesBase64url: populatedClonePlanBytesBase64url,
    });
    expect(liveShadowMessagePreparedRequestV1Schema.safeParse({
      requestVersion: 1,
      status: "prepared",
      operationId: "live-shadow:m290:populated",
      planBytesBase64url: populatedClonePlanBytesBase64url,
      signedRequestBytesBase64url: "cmVxdWVzdA",
      ordinaryPayloadBytesBase64url: "b3JkaW5hcnk",
      encryptedPayloadBytesBase64url: "ZW5jcnlwdGVk",
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      namespaceEnvelopeBytesBase64url: "ZW52ZWxvcGU",
      grantBytesBase64url: "Z3JhbnQ",
    }).success).toBeTrue();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "planned",
      planBytesBase64url: "A".repeat(349_527),
    }).success).toBeTrue();
  });

  test("admits exact 16K authority coordinates and the matching wire ceilings", () => {
    const requiredNamespaceIds = Array.from(
      { length: LIVE_SHADOW_AGENT_GRANT_DOMAIN_COUNT },
      (_, index) => `namespace:${index.toString().padStart(5, "0")}`,
    );
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "unavailable",
      reason: "recipient_sync_required",
      requiredNamespaceIds,
    }).success).toBeTrue();
    expect(liveShadowMessagePlanResponseV1Schema.safeParse({
      responseVersion: 1,
      status: "unavailable",
      reason: "recipient_sync_required",
      requiredNamespaceIds: [
        ...requiredNamespaceIds,
        "namespace:16384",
      ],
    }).success).toBeFalse();

    const base = {
      requestVersion: 1 as const,
      status: "prepared" as const,
      operationId: "runtime:m315",
      clientActionSessionId: "session:m315",
      authorizationScheme: "runtime_foreground_v1" as const,
    };
    const maximumPlanCharacters = Math.ceil(
      LIVE_SHADOW_MESSAGE_PLAN_RAW_BYTES * 4 / 3,
    );
    const maximumAuthorizationCharacters = Math.ceil(
      LIVE_SHADOW_AUTHORIZATION_RAW_BYTES * 4 / 3,
    );
    const maximumSignedRequestCharacters = Math.ceil(
      LIVE_SHADOW_SIGNED_REQUEST_RAW_BYTES * 4 / 3,
    );
    expect(runtimeInvocationAuthorizationRequestV1Schema.safeParse({
      ...base,
      authorizationPlanBytesBase64url: "A".repeat(maximumPlanCharacters),
      authorizationBytesBase64url: "AQ",
    }).success).toBeTrue();
    expect(runtimeInvocationAuthorizationRequestV1Schema.safeParse({
      ...base,
      authorizationPlanBytesBase64url: "A".repeat(maximumPlanCharacters + 1),
      authorizationBytesBase64url: "AQ",
    }).success).toBeFalse();
    expect(runtimeInvocationAuthorizationRequestV1Schema.safeParse({
      ...base,
      authorizationPlanBytesBase64url: "AQ",
      authorizationBytesBase64url:
        "A".repeat(maximumAuthorizationCharacters),
    }).success).toBeTrue();
    expect(runtimeInvocationAuthorizationRequestV1Schema.safeParse({
      ...base,
      authorizationPlanBytesBase64url: "AQ",
      authorizationBytesBase64url:
        "A".repeat(maximumAuthorizationCharacters + 1),
    }).success).toBeFalse();

    const auxiliaryBytes = "A".repeat(1_398_102);
    expect(liveShadowMessagePreparedRequestV1Schema.safeParse({
      requestVersion: 1,
      status: "prepared",
      operationId: "message:m315",
      authorizationScheme: "foreground_session_v1",
      planBytesBase64url: "A".repeat(maximumPlanCharacters),
      signedRequestBytesBase64url:
        "A".repeat(maximumSignedRequestCharacters),
      ordinaryPayloadBytesBase64url: auxiliaryBytes,
      encryptedPayloadBytesBase64url: auxiliaryBytes,
      accessManifestBytesBase64url: auxiliaryBytes,
      namespaceEnvelopeBytesBase64url: auxiliaryBytes,
    }).success).toBeTrue();
  }, 30_000);

  test("recovers durable turn evidence through an idempotent GET", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = typeof target === "string"
        ? target
        : target instanceof URL ? target.href : target.url;
      calls.push({ url, method: init?.method });
      return response({ responseVersion: 1, status: "absent" });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("token");

    expect(await client.recoverLiveShadowRoomMessage(
      ROOM,
      "live-shadow:m282:recovery",
    )).toEqual({ responseVersion: 1, status: "absent" });
    expect(calls).toEqual([{
      url: `https://nautilo.test/api/rooms/${ROOM}/live-shadow/${
        encodeURIComponent("live-shadow:m282:recovery")
      }/recovery`,
      method: "GET",
    }]);
  });

});
