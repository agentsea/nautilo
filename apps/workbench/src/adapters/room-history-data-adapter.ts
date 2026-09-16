import {
  ClassifiedDataOperationError,
  classifyDataOperationFailure,
  decodeMessagePayloadV2,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import type {
  BrowserRoomHistoryShadowAcknowledgementInput,
  VaultRoomHistoryShadowReadInputV1,
  VaultRoomHistoryShadowReadResultV1,
} from "@nautilo/lattice-bridge/client/browser";
import {
  assertCryptoAdmissionAccess,
  getCryptoAdmissionSnapshot,
} from "../lib/crypto-admission-access";
import {
  roomHistoryShadowOrdinarySibling,
  type RoomHistoryShadowReadAdapter,
} from "./session-rehydrate";
import { consumeRoomHistoryRows } from "./room-history-row-access";
import type { MessageBackfillUrgentSelection } from "@nautilo/api-client/browser";

function decodeOrdinaryPayload(encoded: string) {
  try {
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")
        + "=".repeat((4 - encoded.length % 4) % 4)),
      character => character.charCodeAt(0),
    );
    return decodeMessagePayloadV2(bytes);
  } catch (error) {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Selected ordinary history payload is invalid",
      { cause: error },
    );
  }
}

/** Trusted device composition. The owner selects the acknowledgement's
 * ordinary-repair publication; the codec binds exact structural coordinates.
 * Neither Room UI nor the Desktop transport chooses the representation. */
export function createRoomHistoryDataAdapter(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  readerDeviceId: string;
  prioritize?(selection: MessageBackfillUrgentSelection): void;
  onAuthorityWaiting?(roomId: string): void;
  read(
    readerInput: VaultRoomHistoryShadowReadInputV1,
    acknowledgement: Omit<BrowserRoomHistoryShadowAcknowledgementInput, "result">,
  ): Promise<VaultRoomHistoryShadowReadResultV1>;
}>): RoomHistoryShadowReadAdapter {
  return Object.freeze({
    createIntent: () => Object.freeze({
      requestVersion: 1 as const,
      clientRequestKey: globalThis.crypto.randomUUID(),
      readerDeviceId: input.readerDeviceId,
    }),
    async reconcile(reconcileInput: Parameters<RoomHistoryShadowReadAdapter["reconcile"]>[0]) {
      assertCryptoAdmissionAccess();
      const generation = getCryptoAdmissionSnapshot().generation;
      const { roomId, messages, sidecar } = reconcileInput;
      const selectedMessages = messages.filter((message) =>
        Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0
      );
      const mappedCoordinates = sidecar.status === "ready"
        ? new Set(sidecar.records.map((record) =>
            `${record.coordinate.messageId}\u0000${record.coordinate.editRevision}`
          ))
        : null;
      const visible = mappedCoordinates === null
        ? selectedMessages[0]
        : selectedMessages.find((message) => !mappedCoordinates.has(
            `${Number(message.id)}\u0000${message.editRevision ?? 0}`,
          ));
      if (visible !== undefined) input.prioritize?.({roomId, messageId: Number(visible.id), revision: visible.editRevision ?? 0});
      if (sidecar.status !== "ready") {
        const reason = sidecar.status === "unavailable" ? sidecar.reason : null;
        if (reason === "current_read_authority_unavailable") {
          input.onAuthorityWaiting?.(roomId);
        }
        // The page already passed current product membership and admission.
        // A pending Domain/Namespace head is key availability, not a revoked
        // account fence. The shared owner still decides whether fallback is allowed.
        const failureClass = reason === "current_read_authority_unavailable" ? "key_waiting"
          : reason === "selection_changed" ? "stale"
          : reason === "projection_corrupt" ? "integrity"
          : sidecar.status === "disabled" ? "stale"
          : "key_waiting";
        return consumeRoomHistoryRows(input.owner, messages, [], {
          requireVerified: reconcileInput.requireVerified,
          pageFailure: failureClass,
        });
      }
    const ordinaryById = new Map(messages.map((message) => [
      `${message.id}\u0000${String(message.editRevision ?? 0)}`,
      message,
    ]));
    const records = sidecar.records.map((record) => {
      const ordinary = ordinaryById.get(
        `${String(record.coordinate.messageId)}\u0000${String(record.coordinate.editRevision)}`,
      );
      const sibling = ordinary === undefined
        ? null
        : roomHistoryShadowOrdinarySibling(ordinary);
      if (ordinary === undefined) {
        throw new ClassifiedDataOperationError("integrity", "Selected Room history structural row is missing");
      }
      const selectedRole = ordinary.role === "user"
          || ordinary.role === "assistant"
          || ordinary.role === "tool"
          || ordinary.role === "system"
        ? ordinary.role
        : (() => {
          throw new ClassifiedDataOperationError("integrity", "Selected Room history role is invalid");
        })();
      if (selectedRole !== record.coordinate.role) {
        throw new ClassifiedDataOperationError("integrity", "Selected Room history role disagrees");
      }
      const selectedSource = Object.freeze({
        role: selectedRole,
        ...(ordinary.logicalMessageKey === undefined ? {} : {
          logicalMessageKey: ordinary.logicalMessageKey,
        }),
        ...(selectedRole === "system" || ordinary.sourceUserId === undefined ? {} : {
          sourceUserId: ordinary.sourceUserId,
        }),
        ...(selectedRole === "system" || ordinary.authorAgentId === undefined ? {} : {
          authorAgentId: ordinary.authorAgentId,
        }),
      });
      if (record.kind === "human_edited_representation") {
        const editedOrdinary = "ordinaryPayloadBytesBase64url" in record
            && typeof record.ordinaryPayloadBytesBase64url === "string"
          ? record.ordinaryPayloadBytesBase64url : null;
        return Object.freeze({
          kind: "human_edited_representation" as const,
          sessionId: record.coordinate.sessionId,
          messageId: String(record.coordinate.messageId),
          editRevision: record.coordinate.editRevision,
          ...("representationMode" in record
              && record.representationMode === "protected-only"
            ? { representationMode: "protected-only" as const, selectedSource }
            : { representationMode: "ordinary-and-protected" as const,
                ordinaryPayloadBytesBase64url: editedOrdinary ?? (() => {
                  throw new ClassifiedDataOperationError("integrity", "Selected ordinary edited payload is invalid");
                })(),
                ordinarySibling: { ...(sibling ?? (() => {
                  throw new ClassifiedDataOperationError("integrity", "Selected ordinary edited history row is invalid");
                })()), ...(ordinary.sourceUserId === undefined ? {}
                  : { sourceUserId: ordinary.sourceUserId }) } }),
          authorHumanId: record.authorHumanId,
          committerDeviceSigningPublicKeyBase64url:
            record.committerDeviceSigningPublicKeyBase64url,
          namespaceGeneration: record.retainedGeneration.namespaceGeneration,
          namespaceAccessRevision: record.retainedGeneration.accessRevision,
          namespaceHeadDigestBase64url: record.retainedGeneration.headDigestBase64url,
          namespacePublicationDigestBase64url:
            record.retainedGeneration.publicationDigestBase64url,
          namespacePublicationSetDigestBase64url:
            record.retainedGeneration.publicationSetDigestBase64url,
          namespaceAudienceFingerprintBase64url:
            record.retainedGeneration.audienceFingerprintBase64url,
          protectedMessage: record.protectedMessage,
        });
      }
      if (record.kind === "existing_representation") {
        const ordinaryPayloadBytesBase64url = "ordinaryPayloadBytesBase64url" in record
            && typeof record.ordinaryPayloadBytesBase64url === "string"
          ? record.ordinaryPayloadBytesBase64url
          : null;
        const canonicalOrdinaryPayload = ordinaryPayloadBytesBase64url === null
          ? null : decodeOrdinaryPayload(ordinaryPayloadBytesBase64url);
        if (canonicalOrdinaryPayload !== null
            && canonicalOrdinaryPayload.role !== selectedRole) {
          throw new ClassifiedDataOperationError(
            "integrity",
            "Selected ordinary history payload role disagrees",
          );
        }
        const exactSibling = sibling === null ? null : Object.freeze({
          ...sibling,
          ...(canonicalOrdinaryPayload === null ? {} : {
            payload: canonicalOrdinaryPayload,
          }),
        });
        return Object.freeze({
          kind: "existing_representation" as const,
          sessionId: record.coordinate.sessionId,
          messageId: String(record.coordinate.messageId),
          editRevision: record.coordinate.editRevision,
          repair: record.repair,
          ...(!("retainedGeneration" in record) ? {} : {
            retainedGeneration: record.retainedGeneration,
          }),
          protectedMessage: record.protectedMessage,
          ...("representationMode" in record
              && record.representationMode === "protected-only"
            ? { representationMode: "protected-only" as const, selectedSource }
            : {
              ...(ordinaryPayloadBytesBase64url === null ? {} : {
                ordinaryPayloadBytesBase64url,
              }),
              ordinarySibling: {
                ...(exactSibling ?? (() => {
                  throw new ClassifiedDataOperationError("integrity", "Selected ordinary history row is invalid");
                })()),
                ...(selectedRole === "system" || ordinary.sourceUserId === undefined
                  ? {} : { sourceUserId: ordinary.sourceUserId }),
                ...(selectedRole === "system" || ordinary.authorAgentId === undefined
                  ? {} : { authorAgentId: ordinary.authorAgentId }),
              },
            }),
        });
      }
      return Object.freeze({
        sessionId: record.coordinate.sessionId,
        messageId: String(record.coordinate.messageId),
        editRevision: record.coordinate.editRevision,
        shadowOperationId: record.shadowOperationId,
        ...(record.shadowOperationFamily === undefined ? {} : {
          shadowOperationFamily: record.shadowOperationFamily,
        }),
        shadowTranscriptOrdinal: record.shadowTranscriptOrdinal,
        ...("representationMode" in record
            && record.representationMode === "protected-only"
          ? { representationMode: "protected-only" as const, selectedSource }
          : {
            ordinaryPayloadBytesBase64url:
              "ordinaryPayloadBytesBase64url" in record
                ? record.ordinaryPayloadBytesBase64url
                : (() => {
                  throw new ClassifiedDataOperationError("integrity", "Selected Shadow history payload is missing");
                })(),
            ordinarySibling: sibling ?? (() => {
              throw new ClassifiedDataOperationError("integrity", "Selected ordinary history row is invalid");
            })(),
          }),
        namespaceGeneration:
          record.retainedGeneration.namespaceGeneration,
        namespaceAccessRevision: record.retainedGeneration.accessRevision,
        namespaceHeadDigestBase64url:
          record.retainedGeneration.headDigestBase64url,
        namespacePublicationDigestBase64url:
          record.retainedGeneration.publicationDigestBase64url,
        namespacePublicationSetDigestBase64url:
          record.retainedGeneration.publicationSetDigestBase64url,
        namespaceAudienceFingerprintBase64url:
          record.retainedGeneration.audienceFingerprintBase64url,
        protectedMessage: record.protectedMessage,
      });
    });

      const readerInput = Object.freeze({
        sourceRoomId: roomId,
        authority: sidecar.authority,
        ...(sidecar.authorities === undefined ? {} : {
          authorities: sidecar.authorities,
        }),
        signerEvidence: sidecar.signerEvidence,
        records,
      });
      const acknowledgement = Object.freeze({
        roomId,
        operationId: sidecar.operationId,
        clientRequestKey: sidecar.clientRequestKey,
        policyRevision: sidecar.authority.policyRevision,
        subjectHumanId: sidecar.authority.subjectHumanId,
        readerDeviceSigningKeyGeneration: sidecar.authority.readerDeviceSigningKeyGeneration,
        hostAuthorizationRevision: sidecar.authority.hostAuthorizationRevision,
        selectedCoordinateDigestBase64url: sidecar.selectedCoordinateDigestBase64url,
        selectedCoordinates: sidecar.selectedCoordinates,
        eligibleCoordinates: sidecar.records.map((record) => record.coordinate),
        eligibleRecords: records,
        acknowledgement: sidecar.acknowledgement,
      });
      const readAndAcknowledge = async (allowOrdinaryRepairs: boolean) => {
        assertCryptoAdmissionAccess(generation);
        const result = await input.read(readerInput, {
          ...acknowledgement,
          allowOrdinaryRepairs,
        });
        assertCryptoAdmissionAccess(generation);
        return result;
      };
      let result: VaultRoomHistoryShadowReadResultV1;
      try {
        // The existing history transport atomically couples authentication and
        // signed read acknowledgement (including optional reverse repair).
        result = await input.owner.runMutation({
          ordinary: () => Promise.reject(new ClassifiedDataOperationError(
            "stale", "Protected history admission changed to Plain",
          )),
          dual: () => readAndAcknowledge(true),
          protected: () => readAndAcknowledge(false),
          // A signed acknowledgement may have committed before a failure.
          // Never retry this transport as ordinary; per-row reads below own
          // eligible consumption fallback without publishing again.
          classifyFailure: () => "unknown",
        });
      } catch (error) {
        assertCryptoAdmissionAccess(generation);
        const failureClass = classifyDataOperationFailure(error);
        if (failureClass !== "key_waiting" && failureClass !== "recoverable_availability") throw error;
        return consumeRoomHistoryRows(input.owner, messages, [], {
          requireVerified: reconcileInput.requireVerified,
          pageFailure: failureClass,
        });
      }
      return consumeRoomHistoryRows(input.owner, messages, result.records, {
        requireVerified: reconcileInput.requireVerified,
        expectedResults: records,
      });
    },
  });
}
