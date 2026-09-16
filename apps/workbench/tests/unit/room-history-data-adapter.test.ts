import { describe, expect, test } from "bun:test";
import { roomHistoryShadowReadResponseV1Schema } from "@nautilo/api-client";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  encodeMessagePayloadV2,
} from "@nautilo/lattice-bridge";
import type {
  VaultRoomHistoryShadowReadInputV1,
  VaultRoomHistoryShadowReadResultV1,
} from "@nautilo/lattice-bridge/client/browser";

import { createRoomHistoryDataAdapter } from "../../src/adapters/room-history-data-adapter";

const ROOM_ID = "40000000-0000-4000-8000-000000000313";
const SESSION_ID = "41000000-0000-4000-8000-000000000313";
const NAMESPACE_ID = "42000000-0000-4000-8000-000000000313";
const PUBLISHER_HUMAN_ID = "43000000-0000-4000-8000-000000000313";
const DIGEST = "A".repeat(43);

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function authority(keyClass: "human" | "ai", domainKeyGeneration: number) {
  return {
    scheme: "domain_key_v2" as const,
    keyClass,
    subjectHumanId: "human:reader",
    readerDeviceId: "device:browser",
    readerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: 2,
    policyRevision: 3,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    namespaceAccessRevision: 4,
    namespaceCurrentGeneration: 5,
    namespaceHeadDigestBase64url: DIGEST,
    domainId: "domain:room",
    domainKeyGeneration,
    domainAuthorizationRevision: 6,
    domainHeadDigestBase64url: DIGEST,
    namespaceBundleRevision: 7,
    namespaceBundleDigestBase64url: DIGEST,
  };
}

describe("Room history data adapter", () => {
  test.each(["fallback", "strict"] as const)("pending public membership keys preserve %s policy", async (shadowBehavior) => {
    const waitingRooms: string[] = [];
    const adapter = createRoomHistoryDataAdapter({
      onAuthorityWaiting: (roomId) => { waitingRooms.push(roomId); },
      readerDeviceId: "device:browser",
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({ policy: { mode: "shadow_encryption", shadowBehavior }, revalidationToken: 1 }),
        revalidate: async () => undefined,
      } }),
      read: () => { throw new Error("No protected projection is available yet"); },
    });
    const input = {
      roomId: ROOM_ID,
      messages: [{ id: "27", sessionId: SESSION_ID, role: "user", content: "member-authorized ordinary sibling", editRevision: 0 }],
      sidecar: roomHistoryShadowReadResponseV1Schema.parse({
        responseVersion: 1, status: "unavailable", operationId: "history:waiting",
        clientRequestKey: "history:waiting-page", policyRevision: 3,
        selectedCoordinateDigestBase64url: DIGEST, selectedCount: 1, eligibleCount: 1,
        reason: "current_read_authority_unavailable",
      }),
    };
    const result = await adapter.reconcile(input);
    expect(waitingRooms).toEqual([ROOM_ID]);
    expect(result[0]?.content).toBe(shadowBehavior === "fallback"
      ? "member-authorized ordinary sibling" : "Encrypted history is unavailable on this device.");
    expect(result[0]?.historyUnavailable).toBe(shadowBehavior === "strict" ? true : undefined);
    const failure = await adapter.reconcile({ ...input, requireVerified: true })
      .then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ failureClass: "key_waiting" });
  });

  test.each(["projection_corrupt", "selection_changed", "client_crypto_unavailable", "disabled", "ineligible"] as const)("%s does not request recipient authority", async (reason) => {
    const waitingRooms: string[] = [];
    const adapter = createRoomHistoryDataAdapter({
      readerDeviceId: "device:browser",
      onAuthorityWaiting: (roomId) => { waitingRooms.push(roomId); },
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({ policy: { mode: "shadow_encryption", shadowBehavior: "fallback" }, revalidationToken: 1 }),
        revalidate: async () => undefined,
      } }),
      read: () => { throw new Error("No protected projection is available"); },
    });
    const sidecar = roomHistoryShadowReadResponseV1Schema.parse(reason === "disabled"
      ? { responseVersion: 1, status: "disabled", mode: "plaintext_only" }
      : reason === "ineligible"
        ? { responseVersion: 1, status: "ineligible", selectedCount: 1, eligibleCount: 0 }
        : {
          responseVersion: 1, status: "unavailable", operationId: "history:waiting",
          clientRequestKey: "history:waiting-page", policyRevision: 3,
          selectedCoordinateDigestBase64url: DIGEST, selectedCount: 1, eligibleCount: 1, reason,
        });
    await adapter.reconcile({ roomId: ROOM_ID, sidecar, messages: [
      { id: "27", sessionId: SESSION_ID, role: "user", content: "ordinary sibling", editRevision: 0 },
    ] }).catch(() => undefined);
    expect(waitingRooms).toEqual([]);
  });

  test("a true policy authority failure never falls back while Room keys are pending", async () => {
    const adapter = createRoomHistoryDataAdapter({
      readerDeviceId: "device:browser",
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({ policy: { mode: "shadow_encryption", shadowBehavior: "fallback" }, revalidationToken: 1 }),
        revalidate: async () => { throw new ClassifiedDataOperationError("authority", "Admission was revoked"); },
      } }),
      read: () => { throw new Error("No protected projection is available yet"); },
    });
    const failure = await adapter.reconcile({
      roomId: ROOM_ID,
      messages: [{ id: "27", sessionId: SESSION_ID, role: "user", content: "must not escape", editRevision: 0 }],
      sidecar: roomHistoryShadowReadResponseV1Schema.parse({
        responseVersion: 1, status: "unavailable", operationId: "history:waiting",
        clientRequestKey: "history:waiting-page", policyRevision: 3,
        selectedCoordinateDigestBase64url: DIGEST, selectedCount: 1, eligibleCount: 1,
        reason: "current_read_authority_unavailable",
      }),
    }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ failureClass: "authority" });
  });

  test("passes mixed authorities and device retained evidence through one read/ack call", async () => {
    const retainedGeneration = {
      namespaceGeneration: 5,
      accessRevision: 4,
      headDigestBase64url: DIGEST,
      publicationDigestBase64url: DIGEST,
      publicationSetDigestBase64url: DIGEST,
      audienceFingerprintBase64url: DIGEST,
    };
    const repair = {
      identityDigestBase64url: DIGEST,
      allocationDigestBase64url: DIGEST,
      attestationDigestBase64url: DIGEST,
      publisherSignerKeyId: "device:key:one",
      publisherSigningPublicKeyBase64url: DIGEST,
      publisherKind: "human_device" as const,
      publisherHumanId: PUBLISHER_HUMAN_ID,
    };
    const authorities = [authority("ai", 8), authority("human", 9)];
    const coordinate = {
      sessionId: SESSION_ID,
      messageId: 27,
      editRevision: 0,
      role: "user" as const,
      logicalMessageKey: "logical:27",
    };
    const sidecar = roomHistoryShadowReadResponseV1Schema.parse({
      responseVersion: 1,
      status: "ready",
      operationId: "history:read:one",
      clientRequestKey: "history:page:one",
      selectedCoordinateDigestBase64url: DIGEST,
      selectedCount: 1,
      selectedCoordinates: [coordinate],
      eligibleCount: 1,
      authority: authorities[0],
      authorities,
      records: [{
        kind: "existing_representation",
        coordinate,
        protectedMessage: {
          dtoVersion: 2,
          projection: {
            messageId: "27",
            logicalMessageKey: "logical:27",
            sessionId: SESSION_ID,
            roomId: ROOM_ID,
            namespaceId: NAMESPACE_ID,
            role: "user",
            createdAt: "2026-09-08T12:00:00.000Z",
            editRevision: 0,
          },
          protectedPayload: { status: "pending", reason: "shadow_pending" },
        },
        repair,
        retainedGeneration,
      }],
      signerEvidence: [],
      acknowledgement: { status: "already_recorded" },
    });
    let calls = 0;
    let seen: VaultRoomHistoryShadowReadInputV1 | undefined;
    const result: VaultRoomHistoryShadowReadResultV1 = {
      records: [{
        sessionId: SESSION_ID,
        messageId: "27",
        editRevision: 0,
        status: "fallback",
        reason: "retained_key_material_unavailable",
      }],
      eligibleCount: 1,
      verifiedCount: 0,
      fallbackCounts: { retained_key_material_unavailable: 1 },
    };
    const adapter = createRoomHistoryDataAdapter({
      readerDeviceId: "device:browser",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: async () => ({
            policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
                       revalidationToken: 1,
          }),
          revalidate: async () => undefined,
        },
      }),
      read: async (readerInput) => {
        calls += 1;
        seen = readerInput;
        return result;
      },
    });

    await adapter.reconcile({
      roomId: ROOM_ID,
      messages: [{
        id: "27",
        sessionId: SESSION_ID,
        role: "user",
        content: "ordinary sibling",
        logicalMessageKey: "logical:27",
        editRevision: 0,
      }],
      sidecar,
    });

    expect(calls).toBe(1);
    expect(seen?.authorities).toEqual(authorities);
    expect(seen?.records).toHaveLength(1);
    expect(seen?.records[0]).toMatchObject({
      kind: "existing_representation",
      repair,
      retainedGeneration,
    });
  });

  test("prioritizes the first selected Message absent from a ready sidecar", async () => {
    const mappedCoordinate = {
      sessionId: SESSION_ID,
      messageId: 27,
      editRevision: 0,
      role: "user" as const,
      logicalMessageKey: "logical:27",
    };
    const sidecar = roomHistoryShadowReadResponseV1Schema.parse({
      responseVersion: 1,
      status: "ready",
      operationId: "history:read:urgent",
      clientRequestKey: "history:page:urgent",
      selectedCoordinateDigestBase64url: DIGEST,
      selectedCount: 2,
      selectedCoordinates: [mappedCoordinate, {
        ...mappedCoordinate,
        messageId: 28,
        editRevision: 3,
        logicalMessageKey: "logical:28",
      }],
      eligibleCount: 1,
      authority: authority("ai", 8),
      records: [{
        kind: "existing_representation",
        coordinate: mappedCoordinate,
        protectedMessage: {
          dtoVersion: 2,
          projection: {
            messageId: "27",
            logicalMessageKey: "logical:27",
            sessionId: SESSION_ID,
            roomId: ROOM_ID,
            namespaceId: NAMESPACE_ID,
            role: "user",
            createdAt: "2026-09-08T12:00:00.000Z",
            editRevision: 0,
          },
          protectedPayload: { status: "pending", reason: "shadow_pending" },
        },
        repair: {
          identityDigestBase64url: DIGEST,
          allocationDigestBase64url: DIGEST,
          attestationDigestBase64url: DIGEST,
          publisherSignerKeyId: "runtime:key:one",
          publisherSigningPublicKeyBase64url: DIGEST,
        },
      }],
      signerEvidence: [],
      acknowledgement: { status: "already_recorded" },
    });
    const prioritized: unknown[] = [];
    const adapter = createRoomHistoryDataAdapter({
      readerDeviceId: "device:browser",
      prioritize: (selection) => prioritized.push(selection),
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: async () => ({
            policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
            revalidationToken: 1,
          }),
          revalidate: async () => undefined,
        },
      }),
      read: async () => ({
        records: [{
          sessionId: SESSION_ID,
          messageId: "27",
          editRevision: 0,
          status: "fallback",
          reason: "retained_key_material_unavailable",
        }],
        eligibleCount: 1,
        verifiedCount: 0,
        fallbackCounts: { retained_key_material_unavailable: 1 },
      }),
    });

    await adapter.reconcile({
      roomId: ROOM_ID,
      messages: [{
        id: "27",
        sessionId: SESSION_ID,
        role: "user",
        content: "already mapped",
        logicalMessageKey: "logical:27",
        editRevision: 0,
      }, {
        id: "28",
        sessionId: SESSION_ID,
        role: "user",
        content: "missing protected row",
        logicalMessageKey: "logical:28",
        editRevision: 3,
      }],
      sidecar,
    });

    expect(prioritized).toEqual([{
      roomId: ROOM_ID,
      messageId: 28,
      revision: 3,
    }]);

    await adapter.reconcile({
      roomId: ROOM_ID,
      messages: [{
        id: "27",
        sessionId: SESSION_ID,
        role: "user",
        content: "already mapped",
        logicalMessageKey: "logical:27",
        editRevision: 0,
      }],
      sidecar,
    });
    expect(prioritized).toHaveLength(1);
  });

  test("does not infer a system Message author from ordinary Room metadata", async () => {
    const coordinate = {
      sessionId: SESSION_ID,
      messageId: 28,
      editRevision: 0,
      role: "system" as const,
      logicalMessageKey: "logical:28",
    };
    const runtimeRepair = {
      identityDigestBase64url: DIGEST,
      allocationDigestBase64url: DIGEST,
      attestationDigestBase64url: DIGEST,
      publisherSignerKeyId: "runtime:key:one",
      publisherSigningPublicKeyBase64url: DIGEST,
    };
    const systemPayload = {
      role: "system" as const,
      content: "system event",
      sensitiveMetadata: {
        event: "membership_changed",
        audience: ["human:one", "human:two"],
      },
    };
    const baseRecord = {
      kind: "existing_representation" as const,
      coordinate,
      protectedMessage: {
        dtoVersion: 2 as const,
        projection: {
          messageId: "28",
          logicalMessageKey: "logical:28",
          sessionId: SESSION_ID,
          roomId: ROOM_ID,
          namespaceId: NAMESPACE_ID,
          role: "system" as const,
          createdAt: "2026-09-08T12:00:00.000Z",
          editRevision: 0,
        },
        protectedPayload: { status: "pending" as const, reason: "shadow_pending" as const },
      },
      repair: runtimeRepair,
      ordinaryPayloadBytesBase64url: base64url(
        encodeMessagePayloadV2(systemPayload),
      ),
    };
    const seen: VaultRoomHistoryShadowReadInputV1[] = [];
    const adapter = createRoomHistoryDataAdapter({
      readerDeviceId: "device:browser",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: async () => ({
            policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
            revalidationToken: 1,
          }),
          revalidate: async () => undefined,
        },
      }),
      read: async (readerInput) => {
        seen.push(readerInput);
        return {
          records: [{ sessionId: SESSION_ID, messageId: "28", editRevision: 0,
            status: "fallback", reason: "retained_key_material_unavailable" }],
          eligibleCount: 1,
          verifiedCount: 0,
          fallbackCounts: { retained_key_material_unavailable: 1 },
        };
      },
    });
    const ordinaryMessage = {
      id: "28",
      sessionId: SESSION_ID,
      role: "system" as const,
      content: "system event",
      logicalMessageKey: "logical:28",
      editRevision: 0,
      sourceUserId: PUBLISHER_HUMAN_ID,
      authorAgentId: "44000000-0000-4000-8000-000000000313",
    };
    const baseSidecar = {
      responseVersion: 1 as const,
      status: "ready" as const,
      operationId: "history:read:system",
      clientRequestKey: "history:page:system",
      selectedCoordinateDigestBase64url: DIGEST,
      selectedCount: 1,
      selectedCoordinates: [coordinate],
      eligibleCount: 1,
      authority: authority("ai", 8),
      records: [baseRecord],
      signerEvidence: [],
      acknowledgement: { status: "already_recorded" as const },
    };

    await adapter.reconcile({
      roomId: ROOM_ID,
      messages: [ordinaryMessage],
      sidecar: roomHistoryShadowReadResponseV1Schema.parse(baseSidecar),
    });
    const { ordinaryPayloadBytesBase64url: _ordinaryBytes, ...protectedRecord } =
      baseRecord;
    await adapter.reconcile({
      roomId: ROOM_ID,
      messages: [ordinaryMessage],
      sidecar: roomHistoryShadowReadResponseV1Schema.parse({
        ...baseSidecar,
        records: [{
          ...protectedRecord,
          representationMode: "protected-only",
          selectedSource: { role: "system", logicalMessageKey: "logical:28" },
        }],
      }),
    });

    const ordinarySibling = seen[0]?.records[0]?.kind === "existing_representation"
      && "ordinarySibling" in seen[0].records[0]
      ? seen[0].records[0].ordinarySibling : undefined;
    const selectedSource = seen[1]?.records[0]?.kind === "existing_representation"
      && "selectedSource" in seen[1].records[0]
      ? seen[1].records[0].selectedSource : undefined;
    expect(ordinarySibling).toMatchObject({ payload: systemPayload });
    expect(seen[0]?.records[0]).toHaveProperty(
      "ordinaryPayloadBytesBase64url",
      baseRecord.ordinaryPayloadBytesBase64url,
    );
    expect(ordinarySibling).not.toHaveProperty("sourceUserId");
    expect(ordinarySibling).not.toHaveProperty("authorAgentId");
    expect(selectedSource).toEqual({ role: "system", logicalMessageKey: "logical:28" });
    expect(seen[1]?.records[0]).not.toHaveProperty("ordinaryPayloadBytesBase64url");
  });
});
