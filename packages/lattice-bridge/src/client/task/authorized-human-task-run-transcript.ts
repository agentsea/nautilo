import type {
  NautiloApiClient,
  ProtectedTaskTranscriptReadReadyResponseV1,
  RoomHistoryShadowRecordV1,
} from "@nautilo/api-client/browser";
import type {
  TaskOperationRunTranscriptReadV1,
  TaskRunTranscriptMessage,
} from "@nautilo/types";

import {
  decodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type {
  ForegroundRoomHistoryShadowMessageReader,
} from "../message/foreground-shadow-client-composition.ts";
import type {
  RoomHistoryShadowFallbackReasonV1,
  RoomHistoryShadowRecordTransportV1,
  VaultRoomHistoryShadowReadResultV1,
} from "../message/vault-room-history-shadow-message-reader.ts";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
} from "../../transition/encryption-data-operation-owner.ts";

type Ready = ProtectedTaskTranscriptReadReadyResponseV1;

function decodeOrdinaryPayload(value: string): MessagePayloadV2 {
  let bytes: Uint8Array | undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
      throw new TypeError("invalid base64url");
    }
    bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")
        + "=".repeat((4 - value.length % 4) % 4)),
      character => character.charCodeAt(0),
    );
    return decodeMessagePayloadV2(bytes);
  } catch (error) {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Protected Task transcript ordinary parity is invalid",
      { cause: error },
    );
  } finally {
    bytes?.fill(0);
  }
}

function selectedSource(record: RoomHistoryShadowRecordV1) {
  if ("representationMode" in record
    && record.representationMode === "protected-only") {
    return record.selectedSource;
  }
  const projection = record.protectedMessage.projection;
  return Object.freeze({
    role: record.coordinate.role,
    ...(projection.logicalMessageKey === undefined ? {} : {
      logicalMessageKey: projection.logicalMessageKey,
    }),
    ...(projection.sourceUserId === undefined ? {} : {
      sourceUserId: projection.sourceUserId,
    }),
    ...(projection.authorAgentId === undefined ? {} : {
      authorAgentId: projection.authorAgentId,
    }),
  });
}

function ordinaryRepresentation(record: RoomHistoryShadowRecordV1) {
  if (!("ordinaryPayloadBytesBase64url" in record)
    || typeof record.ordinaryPayloadBytesBase64url !== "string") {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Protected Task transcript ordinary parity is missing",
    );
  }
  const payload = decodeOrdinaryPayload(record.ordinaryPayloadBytesBase64url);
  if (payload.role !== record.coordinate.role) {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Protected Task transcript ordinary role was substituted",
    );
  }
  const source = selectedSource(record);
  return Object.freeze({
    ordinaryPayloadBytesBase64url: record.ordinaryPayloadBytesBase64url,
    ordinarySibling: Object.freeze({
      payload,
      ...(source.logicalMessageKey === undefined ? {} : {
        logicalMessageKey: source.logicalMessageKey,
      }),
      ...(source.sourceUserId === undefined ? {} : {
        sourceUserId: source.sourceUserId,
      }),
      ...(source.authorAgentId === undefined ? {} : {
        authorAgentId: source.authorAgentId,
      }),
    }),
  });
}

function transportRecord(
  record: RoomHistoryShadowRecordV1,
): RoomHistoryShadowRecordTransportV1 {
  const representation = "representationMode" in record
      && record.representationMode === "protected-only"
    ? Object.freeze({
        representationMode: "protected-only" as const,
        selectedSource: selectedSource(record),
      })
    : ordinaryRepresentation(record);
  const shared = {
    sessionId: record.coordinate.sessionId,
    messageId: String(record.coordinate.messageId),
    editRevision: record.coordinate.editRevision,
    protectedMessage: record.protectedMessage,
    ...representation,
  } as const;
  if (record.kind === "existing_representation") {
    return Object.freeze({
      kind: record.kind,
      ...shared,
      repair: record.repair,
      ...(!("retainedGeneration" in record)
          || record.retainedGeneration === undefined
        ? {}
        : { retainedGeneration: record.retainedGeneration }),
    }) as RoomHistoryShadowRecordTransportV1;
  }
  const retained = record.retainedGeneration;
  const retainedFields = {
    namespaceGeneration: retained.namespaceGeneration,
    namespaceAccessRevision: retained.accessRevision,
    namespaceHeadDigestBase64url: retained.headDigestBase64url,
    namespacePublicationDigestBase64url: retained.publicationDigestBase64url,
    namespacePublicationSetDigestBase64url:
      retained.publicationSetDigestBase64url,
    namespaceAudienceFingerprintBase64url:
      retained.audienceFingerprintBase64url,
  } as const;
  if (record.kind === "human_edited_representation") {
    return Object.freeze({
      kind: record.kind,
      ...shared,
      authorHumanId: record.authorHumanId,
      committerDeviceSigningPublicKeyBase64url:
        record.committerDeviceSigningPublicKeyBase64url,
      ...retainedFields,
    }) as RoomHistoryShadowRecordTransportV1;
  }
  if (record.kind === "task_runtime") {
    return Object.freeze({
      kind: record.kind,
      taskId: record.taskId,
      taskRunId: record.taskRunId,
      ...shared,
      ...retainedFields,
    }) as RoomHistoryShadowRecordTransportV1;
  }
  return Object.freeze({
    ...shared,
    shadowOperationId: record.shadowOperationId,
    ...(record.shadowOperationFamily === undefined ? {} : {
      shadowOperationFamily: record.shadowOperationFamily,
    }),
    shadowTranscriptOrdinal: record.shadowTranscriptOrdinal,
    ...retainedFields,
  }) as RoomHistoryShadowRecordTransportV1;
}

function fallbackReason(
  reason: RoomHistoryShadowFallbackReasonV1,
): Extract<TaskOperationRunTranscriptReadV1, {
  status: "unavailable";
}>["reason"] {
  return reason === "integrity_failure" || reason === "parity_mismatch"
    ? "integrity_failure"
    : "device_not_ready";
}

function authenticatedMessages(
  response: Ready,
  result: VaultRoomHistoryShadowReadResultV1,
): TaskOperationRunTranscriptReadV1 {
  if (result.records.length !== response.entries.length
    || result.eligibleCount !== response.entries.length
    || result.verifiedCount !== response.entries.length) {
    const fallback = result.records.find((record) => record.status === "fallback");
    return Object.freeze({
      status: "unavailable" as const,
      reason: fallback === undefined
        ? "integrity_failure" as const
        : fallbackReason(fallback.reason),
    });
  }
  const messages: TaskRunTranscriptMessage[] = [];
  for (const [index, entry] of response.entries.entries()) {
    const opened = result.records[index];
    if (opened === undefined
      || opened.status !== "verified"
      || opened.sessionId !== entry.sessionId
      || opened.messageId !== entry.messageId
      || opened.editRevision !== entry.editRevision
      || opened.payload.role !== entry.role) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "integrity_failure" as const,
      });
    }
    const callId = opened.payload.sensitiveMetadata?.["toolCallId"];
    const toolStatus = opened.payload.sensitiveMetadata?.["toolStatus"];
    messages.push(Object.freeze({
      role: opened.payload.role,
      content: opened.payload.content,
      toolName: opened.payload.toolName ?? null,
      toolCalls: opened.payload.role === "assistant"
        ? (opened.payload.toolCalls ?? []).map((call) => Object.freeze({
            name: call.name,
            args: { ...call.args },
            id: call.id ?? null,
          }))
        : null,
      ...(typeof callId === "string" && callId.length > 0
        ? { toolCallId: callId }
        : {}),
      ...(toolStatus === "success" || toolStatus === "error"
        ? { toolStatus }
        : {}),
      createdAt: entry.createdAt,
    }));
  }
  return Object.freeze({
    status: "ready" as const,
    messages: Object.freeze(messages),
    nextCursor: response.nextCursor,
  });
}

function exactReady(
  response: Ready,
  request: Readonly<{ taskId: string; taskRunId: string; agentId: string }>,
): boolean {
  if (response.taskId !== request.taskId
    || response.taskRunId !== request.taskRunId
    || response.agentId !== request.agentId
    || response.sourceRoomId !== response.history.authority.roomId
    || response.entries.length !== response.history.selectedCoordinates.length
    || response.entries.length !== response.history.records.length) return false;
  return response.entries.every((entry, index) => {
    const selected = response.history.selectedCoordinates[index];
    const record = response.history.records[index];
    return selected !== undefined
      && record !== undefined
      && entry.sessionId === selected.sessionId
      && Number(entry.messageId) === selected.messageId
      && entry.editRevision === selected.editRevision
      && entry.role === selected.role
      && entry.sessionId === record.coordinate.sessionId
      && Number(entry.messageId) === record.coordinate.messageId
      && entry.editRevision === record.coordinate.editRevision
      && entry.role === record.coordinate.role
      && entry.createdAt === record.protectedMessage.projection.createdAt;
  });
}

/** Protected-only Task transcript reader over the canonical Room history custody. */
export function createAuthorizedHumanTaskRunTranscriptReaderV1(input: Readonly<{
  api: Pick<NautiloApiClient, "readProtectedTaskRunTranscriptV1">;
  owner: EncryptionDataOperationOwner;
  history: ForegroundRoomHistoryShadowMessageReader;
  createClientRequestKey(): string;
}>) {
  return Object.freeze({
    async read(request: Readonly<{
      taskId: string;
      taskRunId: string;
      agentId: string;
      cursor?: string;
      limit?: number;
    }>): Promise<TaskOperationRunTranscriptReadV1> {
      const read = await input.owner.read({
        ordinary: () => Promise.reject(new ClassifiedDataOperationError(
          "stale",
          "Protected Task transcript admission changed to Plain",
        )),
        protected: open,
        consumeOrdinary: (value: TaskOperationRunTranscriptReadV1) => value,
        consumeProtected: (value: TaskOperationRunTranscriptReadV1) => value,
        classifyFailure: () => "unsupported",
      });
      return read.value;

      async function open(): Promise<TaskOperationRunTranscriptReadV1> {
        const clientRequestKey = input.createClientRequestKey();
        const response = await input.api.readProtectedTaskRunTranscriptV1({
          readVersion: 1,
          taskId: request.taskId,
          taskRunId: request.taskRunId,
          agentId: request.agentId,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          historyRead: {
            requestVersion: 1,
            clientRequestKey,
            readerDeviceId: input.history.readerDeviceId,
          },
        });
        if (response.taskId !== request.taskId
          || response.taskRunId !== request.taskRunId
          || response.agentId !== request.agentId) {
          throw new ClassifiedDataOperationError(
            "integrity",
            "Protected Task transcript identity was substituted",
          );
        }
        if (response.status !== "ready") {
          return response.status === "waiting"
            ? Object.freeze({ status: "waiting" as const, reason: response.reason })
            : Object.freeze({
                status: "unavailable" as const,
                reason: response.reason,
              });
        }
        if (!exactReady(response, request)) {
          throw new ClassifiedDataOperationError(
            "integrity",
            "Protected Task transcript page was substituted",
          );
        }
        if (response.history.clientRequestKey !== clientRequestKey) {
          throw new ClassifiedDataOperationError(
            "integrity",
            "Protected Task transcript read intent was substituted",
          );
        }
        const records = response.history.records.map(transportRecord);
        const result = await input.history.reconcile({
          sourceRoomId: response.sourceRoomId,
          authority: response.history.authority,
          ...(response.history.authorities === undefined ? {} : {
            authorities: response.history.authorities,
          }),
          signerEvidence: response.history.signerEvidence,
          records,
        });
        await input.history.acknowledge({
          roomId: response.sourceRoomId,
          operationId: response.history.operationId,
          clientRequestKey: response.history.clientRequestKey,
          policyRevision: response.history.authority.policyRevision,
          subjectHumanId: response.history.authority.subjectHumanId,
          readerDeviceSigningKeyGeneration:
            response.history.authority.readerDeviceSigningKeyGeneration,
          hostAuthorizationRevision:
            response.history.authority.hostAuthorizationRevision,
          selectedCoordinateDigestBase64url:
            response.history.selectedCoordinateDigestBase64url,
          selectedCoordinates: response.history.selectedCoordinates,
          eligibleCoordinates: response.history.records.map(
            record => record.coordinate,
          ),
          eligibleRecords: records,
          allowOrdinaryRepairs: false,
          acknowledgement: response.history.acknowledgement,
          result,
        });
        return authenticatedMessages(response, result);
      }
    },
  });
}
