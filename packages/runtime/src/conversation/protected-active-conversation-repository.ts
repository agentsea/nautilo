import {
  assertConversationDurableKey,
  assertConversationMessageId,
  assertConversationRevision,
  assertConversationSessionId,
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type ConversationAllocatedRevision,
  type ConversationRepository,
  type MessagePayloadV2,
} from "@nautilo/lattice-bridge";
import {
  parseProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "@nautilo/types";

import {
  ACTIVE_CONVERSATION_MAX_READ_BATCH,
  type ActiveConversationHardDeleteResult,
  type ActiveConversationRepository,
  type ActiveConversationTranscriptMessage,
  type AgentTranscriptOpenResult,
  type AgentTranscriptOpenInput,
  type AllocatedHumanConversationRevision,
  type HumanConversationEditAllocation,
  type HumanConversationRead,
  type HumanConversationReadResult,
  type HumanConversationRevisionAllocation,
  type ProtectedAgentMessageWriteCommitter,
  type ProtectedConversationAgentContentOpener,
  type ProtectedConversationAgentObjectOutcome,
  type ProtectedConversationAgentObjectStatus,
  type ProtectedConversationProductReadPort,
  type ProtectedConversationProductReadRecord,
} from "./active-conversation-repository";

const MAX_AROUND_RADIUS = Math.floor(
  (ACTIVE_CONVERSATION_MAX_READ_BATCH - 1) / 2,
);
const MAX_PUBLIC_COORDINATE_BYTES = 4_096;
const textEncoder = new TextEncoder();

class AgentTranscriptExecutionFailure extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("Protected Agent transcript execution failed", { cause });
    this.name = "AgentTranscriptExecutionFailure";
    this.cause = cause;
  }
}

function runtimeArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export type ProtectedActiveConversationRepositoryOptions = Readonly<{
  readonly mutations: ConversationRepository;
  readonly productReads: ProtectedConversationProductReadPort;
  readonly agentContentOpener: ProtectedConversationAgentContentOpener;
  readonly agentWrites: ProtectedAgentMessageWriteCommitter;
}>;

function normalizedHumanPayload(payload: MessagePayloadV2): MessagePayloadV2 {
  const normalized = decodeMessagePayloadV2(encodeMessagePayloadV2(payload));
  if (normalized.role !== "user") {
    throw new TypeError("Human conversation writes require a user payload");
  }
  return normalized;
}

function normalizedHumanEditPayload(payload: MessagePayloadV2): MessagePayloadV2 {
  const normalized = normalizedHumanPayload(payload);
  if (
    normalized.toolCalls !== undefined
    || normalized.toolName !== undefined
    || normalized.sensitiveMetadata !== undefined
    || normalized.attachmentRefs !== undefined
  ) {
    throw new TypeError(
      "Human conversation edits may change content only",
    );
  }
  return normalized;
}

function allocatedHumanRevision(
  allocation: ConversationAllocatedRevision,
): AllocatedHumanConversationRevision {
  return Object.freeze({
    status: allocation.status,
    sessionId: allocation.sessionId,
    messageId: allocation.messageId,
    revision: allocation.revision,
    namespaceId: allocation.namespaceId,
    cryptoObjectId: allocation.cryptoObjectId,
  });
}

function allocationsMatch(
  left: ConversationAllocatedRevision,
  right: ConversationAllocatedRevision,
): boolean {
  return left.status === right.status
    && left.sessionId === right.sessionId
    && left.messageId === right.messageId
    && left.revision === right.revision
    && left.roomId === right.roomId
    && left.namespaceId === right.namespaceId
    && left.keyClass === right.keyClass
    && left.authorRole === right.authorRole
    && left.cryptoObjectId === right.cryptoObjectId;
}

function validateHumanEditAllocations(
  result: ConversationAllocatedRevision & Readonly<{
    readonly allocations: readonly ConversationAllocatedRevision[];
  }>,
  input: Readonly<{
    readonly messageId: number;
    readonly expectedRevision: number;
  }>,
): readonly ConversationAllocatedRevision[] {
  if (
    !runtimeArray(result.allocations)
    || result.allocations.length < 1
    || result.allocations.length > ACTIVE_CONVERSATION_MAX_READ_BATCH
    || (result.status !== "allocated" && result.status !== "replayed")
    || result.messageId !== input.messageId
    || result.revision !== input.expectedRevision + 1
  ) {
    throw new TypeError("Human edit allocation group is malformed");
  }
  const seen = new Set<string>();
  let targetCount = 0;
  let topLevelMatchCount = 0;
  for (const allocation of result.allocations) {
    try {
      assertConversationSessionId(allocation.sessionId);
      assertConversationMessageId(allocation.messageId);
      assertConversationRevision(allocation.revision);
      assertConversationDurableKey(
        "Conversation edit Room ID",
        allocation.roomId,
      );
      assertConversationDurableKey(
        "Conversation edit Namespace ID",
        allocation.namespaceId,
      );
      assertConversationDurableKey(
        "Conversation edit crypto object ID",
        allocation.cryptoObjectId,
      );
    } catch {
      throw new TypeError("Human edit allocation group is malformed");
    }
    const coordinate = `${allocation.sessionId}\u0000${
      allocation.messageId
    }\u0000${allocation.revision}`;
    if (
      seen.has(coordinate)
      || allocation.status !== result.status
      || allocation.revision !== input.expectedRevision + 1
      || allocation.roomId !== result.roomId
      || allocation.namespaceId !== result.namespaceId
      || allocation.keyClass !== result.keyClass
      || (
        allocation.keyClass !== "ai"
        && allocation.keyClass !== "human"
      )
      || allocation.authorRole !== "user"
    ) {
      throw new TypeError("Human edit allocation group is malformed");
    }
    seen.add(coordinate);
    if (allocation.messageId === input.messageId) targetCount += 1;
    if (allocationsMatch(allocation, result)) topLevelMatchCount += 1;
  }
  if (targetCount !== 1 || topLevelMatchCount !== 1) {
    throw new TypeError("Human edit allocation group is malformed");
  }
  return result.allocations;
}

function assertReadLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > ACTIVE_CONVERSATION_MAX_READ_BATCH
  ) {
    throw new RangeError("protected conversation read limit is out of bounds");
  }
}

function assertAroundRadius(radius: number): void {
  if (
    !Number.isSafeInteger(radius)
    || radius < 0
    || radius > MAX_AROUND_RADIUS
  ) {
    throw new RangeError(
      "protected conversation around radius is out of bounds",
    );
  }
}

function protectedDto(
  record: ProtectedConversationProductReadRecord,
): ProtectedMessageDtoV2 {
  return parseProtectedMessageDtoV2(record.dto);
}

function assertPublicCoordinate(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || textEncoder.encode(value).length > MAX_PUBLIC_COORDINATE_BYTES
    || [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new TypeError(`${label} is malformed`);
  }
}

function assertPublicAuthor(
  record: ProtectedConversationProductReadRecord,
): void {
  assertPublicCoordinate("conversation author actor ID", record.author.actorId);
  assertPublicCoordinate("conversation author handle", record.author.handle);
  assertPublicCoordinate(
    "conversation author display name",
    record.author.displayName,
  );
}

function validateHumanRecords(
  records: readonly ProtectedConversationProductReadRecord[],
  input: Exclude<HumanConversationRead, Readonly<{ readonly kind: "search" }>>,
): readonly ProtectedMessageDtoV2[] {
  const maximum =
    input.kind === "page" ? input.limit : (input.radius * 2) + 1;
  if (!runtimeArray(records) || records.length > maximum) {
    throw new TypeError("protected conversation read batch is malformed");
  }
  const seen = new Set<string>();
  let roomId: string | null = null;
  let namespaceId: string | null = null;
  let previousCreatedAt = Number.NEGATIVE_INFINITY;
  let previousMessageId = 0;
  return records.map((record) => {
    assertPublicAuthor(record);
    const dto = protectedDto(record);
    const messageId = Number(dto.projection.messageId);
    const createdAt = Date.parse(dto.projection.createdAt);
    roomId ??= dto.projection.roomId;
    namespaceId ??= dto.projection.namespaceId;
    if (
      dto.projection.sessionId !== input.sessionId
      || dto.projection.roomId !== roomId
      || dto.projection.namespaceId !== namespaceId
      || seen.has(dto.projection.messageId)
      || createdAt < previousCreatedAt
      || (
        createdAt === previousCreatedAt
        && messageId <= previousMessageId
      )
    ) {
      throw new TypeError("protected conversation read coordinate is invalid");
    }
    seen.add(dto.projection.messageId);
    previousCreatedAt = createdAt;
    previousMessageId = messageId;
    return dto;
  });
}

function assertHumanReadWindow(
  dtos: readonly ProtectedMessageDtoV2[],
  input: Exclude<HumanConversationRead, Readonly<{ readonly kind: "search" }>>,
): void {
  if (input.kind === "page") {
    if (
      input.beforeMessageId !== undefined
      && dtos.some(
        (dto) => Number(dto.projection.messageId) >= input.beforeMessageId!,
      )
    ) {
      throw new TypeError("protected conversation page cursor was violated");
    }
    return;
  }
  const anchorIndex = dtos.findIndex(
    (dto) => Number(dto.projection.messageId) === input.messageId,
  );
  if (
    anchorIndex < 0
    || anchorIndex > input.radius
    || (dtos.length - anchorIndex - 1) > input.radius
  ) {
    throw new TypeError("protected conversation around anchor was violated");
  }
}

function contentFreeOutcome(
  outcome: ProtectedConversationAgentObjectOutcome,
): ProtectedConversationAgentObjectStatus {
  if (outcome.status === "opened") {
    return Object.freeze({
      messageId: outcome.messageId,
      revision: outcome.revision,
      status: outcome.status,
    });
  }
  if (outcome.status === "pending") {
    return Object.freeze({
      messageId: outcome.messageId,
      revision: outcome.revision,
      status: outcome.status,
      reason: outcome.reason,
    });
  }
  return Object.freeze({
    messageId: outcome.messageId,
    revision: outcome.revision,
    status: outcome.status,
    reason: outcome.reason,
  });
}

function unavailableReason(
  outcomes: readonly ProtectedConversationAgentObjectOutcome[],
): Exclude<AgentTranscriptOpenResult<never>, { readonly status: "executed" }>[
  "reason"
] {
  if (
    outcomes.some((outcome) =>
      outcome.status === "unavailable"
      && (
        outcome.reason === "unsupported_version"
        || outcome.reason === "corrupt"
      )
    )
  ) {
    return "content_invalid";
  }
  if (
    outcomes.some((outcome) =>
      outcome.status === "unavailable"
      && (
        outcome.reason === "missing_grant"
        || outcome.reason === "stale_grant"
        || outcome.reason === "unauthorized"
        || outcome.reason === "removed"
      )
    )
  ) {
    return "authorization_unavailable";
  }
  return "content_unavailable";
}

function validateAgentRecords(
  records: readonly ProtectedConversationProductReadRecord[],
  expected: Readonly<{
    readonly sessionId: string;
    readonly roomId: string;
    readonly namespaceId: string;
    readonly upToMessageId?: number;
    readonly limit: number;
  }>,
): readonly ProtectedMessageDtoV2[] {
  if (!runtimeArray(records) || records.length > expected.limit) {
    throw new TypeError("protected Agent transcript batch is malformed");
  }
  const seen = new Set<string>();
  let previousCreatedAt = Number.NEGATIVE_INFINITY;
  let previousMessageId = 0;
  return records.map((record) => {
    assertPublicAuthor(record);
    const dto = protectedDto(record);
    const messageId = Number(dto.projection.messageId);
    const createdAt = Date.parse(dto.projection.createdAt);
    if (
      dto.projection.sessionId !== expected.sessionId
      || dto.projection.roomId !== expected.roomId
      || dto.projection.namespaceId !== expected.namespaceId
      || (
        expected.upToMessageId !== undefined
        && messageId > expected.upToMessageId
      )
      || seen.has(dto.projection.messageId)
      || createdAt < previousCreatedAt
      || (
        createdAt === previousCreatedAt
        && messageId <= previousMessageId
      )
    ) {
      throw new TypeError(
        "protected Agent transcript coordinate is invalid",
      );
    }
    seen.add(dto.projection.messageId);
    previousCreatedAt = createdAt;
    previousMessageId = messageId;
    return dto;
  });
}

function agentTranscriptMessages(
  records: readonly ProtectedConversationProductReadRecord[],
  dtos: readonly ProtectedMessageDtoV2[],
  outcomes: readonly ProtectedConversationAgentObjectOutcome[],
): readonly ActiveConversationTranscriptMessage[] | null {
  if (!runtimeArray(outcomes) || outcomes.length !== records.length) {
    return null;
  }
  const messages: ActiveConversationTranscriptMessage[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const dto = dtos[index]!;
    const outcome = outcomes[index]!;
    const messageId = Number(dto.projection.messageId);
    if (
      outcome.messageId !== messageId
      || outcome.revision !== dto.projection.editRevision
    ) {
      return null;
    }
    if (outcome.status === "pending") {
      if (
        dto.protectedPayload.status !== "pending"
        || dto.protectedPayload.reason !== outcome.reason
      ) return null;
      continue;
    }
    if (outcome.status === "unavailable") {
      if (
        dto.protectedPayload.status !== "unavailable"
        || dto.protectedPayload.reason !== outcome.reason
      ) return null;
      continue;
    }
    if (dto.protectedPayload.status !== "encrypted") return null;
    let payload: MessagePayloadV2;
    try {
      payload = decodeMessagePayloadV2(
        encodeMessagePayloadV2(outcome.payload),
      );
    } catch {
      return null;
    }
    if (payload.role !== dto.projection.role) return null;
    messages.push(Object.freeze({
      messageId,
      revision: outcome.revision,
      createdAt: new Date(dto.projection.createdAt),
      author: Object.freeze({ ...record.author }),
      payload,
    }));
  }
  return Object.freeze(messages);
}

/**
 * Dormant protected Active-conversation adapter. It composes only explicitly
 * injected bridge ports and is intentionally not installed at a product
 * composition root in Wave 9.
 */
export function createProtectedActiveConversationRepository(
  options: ProtectedActiveConversationRepositoryOptions,
): ActiveConversationRepository {
  const repository: ActiveConversationRepository = {
    async allocateHumanAppend(input): Promise<
      HumanConversationRevisionAllocation
    > {
      const payload = normalizedHumanPayload(input.legacyPayload);
      const allocation = await options.mutations.append({
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        content: payload.content,
        keyClass: input.keyClass,
        authorRole: payload.role,
        toolCalls:
          payload.toolCalls === undefined
            ? null
            : JSON.stringify(payload.toolCalls),
        toolName: payload.toolName ?? null,
        fingerprint: input.fingerprint,
        humanTurnId: input.humanTurnId,
        transcriptOrigin: input.transcriptOrigin,
        parentThreadId: input.parentThreadId,
        scopeId: input.scopeId,
        metadata: payload.sensitiveMetadata ?? null,
        subthreadRoomId: input.subthreadRoomId,
        replyToMessageId: input.replyToMessageId,
        notificationContext: input.notificationContext,
        structuralProjection: input.structuralProjection,
      });
      return allocatedHumanRevision(allocation);
    },

    async allocateHumanEdit(input): Promise<HumanConversationEditAllocation> {
      assertConversationMessageId(input.messageId);
      assertConversationRevision(input.expectedRevision);
      assertConversationRevision(input.expectedRevision + 1);
      const payload = normalizedHumanEditPayload(input.legacyPayload);
      const result = await options.mutations.edit({
        messageId: input.messageId,
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        content: payload.content,
        subthreadReplyClassification:
          input.subthreadReplyClassification,
      });
      const allocations = validateHumanEditAllocations(result, input);
      return Object.freeze({
        status: result.status,
        allocations: Object.freeze(
          allocations.map(allocatedHumanRevision),
        ),
      });
    },

    async completeHumanRevision(input) {
      return options.mutations.completeRevision({
        messageId: input.messageId,
        expectedRevision: input.expectedRevision,
        parityStatus: "client_verified",
        prepared: input.preparedClientRevision,
      });
    },

    appendPreparedAgent(write) {
      return options.agentWrites.appendPrepared(write);
    },

    async hardDelete(input): Promise<ActiveConversationHardDeleteResult> {
      const result = await options.mutations.hardDelete(input);
      if (result.status === "missing") {
        return Object.freeze({ status: "missing" });
      }
      if (
        result.status === "stale"
        || result.status === "message_anchors_thread"
      ) {
        return Object.freeze({ status: "conflict" });
      }
      if (!("effects" in result)) {
        return Object.freeze({ status: "conflict" });
      }
      return Object.freeze({
        status: "committed",
        disposition: result.status,
        effects: result.effects,
      });
    },

    async readHumanMessages(
      query: HumanConversationRead,
    ): Promise<HumanConversationReadResult> {
      if (query.kind === "search") {
        return Object.freeze({
          status: "unavailable",
          reason: "search_unavailable",
        });
      }
      assertConversationSessionId(query.sessionId);
      if (query.kind === "page") {
        assertReadLimit(query.limit);
        if (query.beforeMessageId !== undefined) {
          assertConversationMessageId(query.beforeMessageId);
        }
      } else {
        assertConversationMessageId(query.messageId);
        assertAroundRadius(query.radius);
      }
      try {
        const records = query.kind === "page"
          ? await options.productReads.readPage({
            authorization: query.authorization,
            sessionId: query.sessionId,
            ...(query.beforeMessageId === undefined
              ? {}
              : { beforeMessageId: query.beforeMessageId }),
            limit: query.limit,
          })
          : await options.productReads.readAround({
            authorization: query.authorization,
            sessionId: query.sessionId,
            messageId: query.messageId,
            radius: query.radius,
          });
        const dtos = validateHumanRecords(records, query);
        assertHumanReadWindow(dtos, query);
        return Object.freeze({
          status: "available",
          messages: Object.freeze(
            dtos.map((dto) => Object.freeze({
              mode: "protected" as const,
              dto,
            })),
          ),
        });
      } catch (error) {
        if (
          error instanceof TypeError
          || error instanceof RangeError
        ) {
          return Object.freeze({
            status: "unavailable",
            reason: "content_invalid",
          });
        }
        return Object.freeze({
          status: "unavailable",
          reason: "content_unavailable",
        });
      }
    },

    async withAgentTranscript<Value>(
      input: AgentTranscriptOpenInput<Value>,
    ): Promise<AgentTranscriptOpenResult<Value>> {
      assertConversationSessionId(input.sessionId);
      assertConversationDurableKey(
        "Conversation Namespace ID",
        input.namespaceId,
      );
      assertReadLimit(input.limit);
      if (input.upToMessageId !== undefined) {
        assertConversationMessageId(input.upToMessageId);
      }

      let batch;
      try {
        batch = await options.productReads.readAgentTranscript({
          authorization: input.productReadAuthorization,
          sessionId: input.sessionId,
          namespaceId: input.namespaceId,
          ...(input.upToMessageId === undefined
            ? {}
            : { upToMessageId: input.upToMessageId }),
          limit: input.limit,
        });
      } catch {
        return Object.freeze({
          status: "unavailable",
          reason: "content_unavailable",
        });
      }
      if (batch === null) {
        return Object.freeze({
          status: "unavailable",
          reason: "content_unavailable",
        });
      }
      if (
        batch.sessionId !== input.sessionId
        || batch.namespaceId !== input.namespaceId
      ) {
        return Object.freeze({
          status: "unavailable",
          reason: "content_invalid",
        });
      }
      try {
        assertConversationDurableKey("Conversation Room ID", batch.roomId);
        assertConversationDurableKey(
          "Conversation Domain ID",
          batch.domainId,
        );
        assertConversationRevision(batch.expectedAccessRevision);
        assertConversationRevision(batch.expectedPolicyRevision);
      } catch {
        return Object.freeze({
          status: "unavailable",
          reason: "content_invalid",
        });
      }

      let dtos: readonly ProtectedMessageDtoV2[];
      try {
        dtos = validateAgentRecords(batch.messages, {
          sessionId: input.sessionId,
          roomId: batch.roomId,
          namespaceId: input.namespaceId,
          ...(input.upToMessageId === undefined
            ? {}
            : { upToMessageId: input.upToMessageId }),
          limit: input.limit,
        });
      } catch {
        return Object.freeze({
          status: "unavailable",
          reason: "content_invalid",
        });
      }

      let callbackLive = true;
      let callbackCalls = 0;
      let callbackResult: AgentTranscriptOpenResult<Value> | undefined;
      let opened;
      try {
        opened = await options.agentContentOpener.openBatch<
          AgentTranscriptOpenResult<Value>
        >({
          authorizationSession: input.authorization,
          entrypointId: input.entrypointId,
          namespaceId: input.namespaceId,
          domainId: batch.domainId,
          expectedAccessRevision: batch.expectedAccessRevision,
          expectedPolicyRevision: batch.expectedPolicyRevision,
          messages: batch.messages,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          execute: async (outcomes) => {
            if (!callbackLive || callbackCalls !== 0) {
              return Object.freeze({
                status: "unavailable" as const,
                reason: "content_invalid" as const,
              });
            }
            callbackCalls += 1;
            if (!runtimeArray(outcomes)) {
              callbackResult = Object.freeze({
                status: "unavailable" as const,
                reason: "content_invalid" as const,
              });
              return callbackResult;
            }
            const statuses = Object.freeze(
              outcomes.map(contentFreeOutcome),
            );
            const messages = agentTranscriptMessages(
              batch.messages,
              dtos,
              outcomes,
            );
            if (messages === null) {
              callbackResult = Object.freeze({
                status: "unavailable" as const,
                reason: "content_invalid" as const,
                outcomes: statuses,
              });
              return callbackResult;
            }
            if (outcomes.some((outcome) => outcome.status !== "opened")) {
              callbackResult = Object.freeze({
                status: "unavailable" as const,
                reason: unavailableReason(outcomes),
                outcomes: statuses,
              });
              return callbackResult;
            }
            let value: Value;
            try {
              value = await input.execute(messages);
            } catch (cause) {
              throw new AgentTranscriptExecutionFailure(cause);
            }
            callbackResult = Object.freeze({
              status: "executed" as const,
              value,
            });
            return callbackResult;
          },
        });
      } catch (error) {
        if (error instanceof AgentTranscriptExecutionFailure) {
          throw error.cause;
        }
        return Object.freeze({
          status: "unavailable",
          reason: "content_unavailable",
        });
      } finally {
        callbackLive = false;
      }
      if (opened.status === "unavailable") return opened;
      if (callbackCalls !== 1 || opened.value !== callbackResult) {
        return Object.freeze({
          status: "unavailable",
          reason: "content_invalid",
        });
      }
      return callbackResult;
    },
  };
  return Object.freeze(repository);
}
