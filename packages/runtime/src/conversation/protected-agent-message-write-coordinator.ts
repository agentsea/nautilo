import type {
  ConversationAllocatedRevision,
  ConversationRepository,
  MessagePayloadV2,
  ProtectedAgentConversationSessionCryptoPreparer,
} from "@nautilo/lattice-bridge";
import {
  parseProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "@nautilo/types";

import type {
  ForegroundAuthorizationSessionRegistry,
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";
import type {
  ActiveConversationMutationResult,
  PreparedProtectedAgentMessageWrite,
  ProtectedAgentMessageWriteCommitter,
  ProtectedAgentMessageWritePreparer,
  ProtectedConversationProductReadAuthorization,
  ProtectedConversationProductReadPort,
} from "./active-conversation-repository";

export type ProtectedAgentConversationWriteAuthority = Readonly<{
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  publicationRepresentation: "ordinary_and_protected" | "protected_only";
}>;

export type ResolveProtectedAgentConversationWriteAuthority = (
  input: Readonly<{
    sessionId: string;
    agentId: string;
    authorization: ForegroundAuthorizationView;
    productReadAuthorization:
      ProtectedConversationProductReadAuthorization;
  }>,
) =>
  | ProtectedAgentConversationWriteAuthority
  | null
  | PromiseLike<ProtectedAgentConversationWriteAuthority | null>;

type PreparedState = {
  readonly allocation: ConversationAllocatedRevision;
  readonly prepared: Parameters<
    ConversationRepository["completeRevision"]
  >[0]["prepared"] | null;
  readonly productReadAuthorization:
    ProtectedConversationProductReadAuthorization;
  readonly agentId: string;
  status: "ready" | "committing" | "committed";
  committedMessage: ProtectedMessageDtoV2 | null;
};

function countedReply(payload: MessagePayloadV2): boolean {
  return payload.role === "assistant" && payload.content.length > 0;
}

function notificationEligible(
  payload: MessagePayloadV2,
  transcriptOrigin: "main" | "subagent",
): boolean {
  return transcriptOrigin === "main"
    && payload.role === "assistant"
    && payload.content.trim().length > 0;
}

function committedMessageMatches(
  message: ProtectedMessageDtoV2,
  state: PreparedState,
): boolean {
  const projection = message.projection;
  const payload = message.protectedPayload;
  return projection.messageId === String(state.allocation.messageId)
    && projection.sessionId === state.allocation.sessionId
    && projection.roomId === state.allocation.roomId
    && projection.namespaceId === state.allocation.namespaceId
    && projection.role === state.allocation.authorRole
    && projection.editRevision === state.allocation.revision
    && projection.authorAgentId === state.agentId
    && payload.status === "encrypted"
    && payload.cryptoObjectId === state.allocation.cryptoObjectId
    && payload.keyClass === "ai";
}

function pendingMessageMatches(
  message: ProtectedMessageDtoV2,
  state: PreparedState,
): boolean {
  const projection = message.projection;
  return projection.messageId === String(state.allocation.messageId)
    && projection.sessionId === state.allocation.sessionId
    && projection.roomId === state.allocation.roomId
    && projection.namespaceId === state.allocation.namespaceId
    && projection.role === state.allocation.authorRole
    && projection.editRevision === state.allocation.revision
    && projection.authorAgentId === state.agentId
    && message.protectedPayload.status === "pending";
}

/**
 * Couple one product-side Agent append allocation to one foreground-authorized
 * opaque crypto preparation and its durable completion. The WeakMap keeps the
 * prepared crypto revision out of Runtime-visible DTOs and makes forged tokens
 * unusable.
 */
export function createProtectedAgentMessageWriteCoordinator(input: Readonly<{
  mutations: ConversationRepository;
  productReads: ProtectedConversationProductReadPort;
  registry: Pick<
    ForegroundAuthorizationSessionRegistry,
    "leaseOperation" | "executeAgentConversationPreparation"
  >;
  cryptoPreparer: ProtectedAgentConversationSessionCryptoPreparer;
  resolveWriteAuthority: ResolveProtectedAgentConversationWriteAuthority;
  now?: () => number;
}>): Readonly<{
  preparer: ProtectedAgentMessageWritePreparer;
  committer: ProtectedAgentMessageWriteCommitter;
}> {
  const states = new WeakMap<object, PreparedState>();
  const now = input.now ?? Date.now;

  const preparer: ProtectedAgentMessageWritePreparer = Object.freeze({
    async prepare(
      request: Parameters<ProtectedAgentMessageWritePreparer["prepare"]>[0],
    ) {
      if (
        request.payload.role === "user"
        || request.entrypointId === undefined
        || request.agentId === undefined
        || request.appendContext === undefined
        || request.productReadAuthorization === undefined
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_invalid" as const,
        });
      }
      let authority: ProtectedAgentConversationWriteAuthority | null;
      try {
        authority = await input.resolveWriteAuthority({
          sessionId: request.sessionId,
          agentId: request.agentId,
          authorization: request.authorization,
          productReadAuthorization: request.productReadAuthorization,
        });
      } catch {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      if (authority === null) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }

      let allocation: ConversationAllocatedRevision;
      try {
        allocation = await input.mutations.append({
          sessionId: request.sessionId,
          idempotencyKey: request.idempotencyKey,
          content: request.payload.content,
          publicationPolicy: {
            expectedRevision: authority.expectedPolicyRevision,
            representation: authority.publicationRepresentation,
          },
          keyClass: "ai",
          authorRole: request.payload.role,
          toolCalls: request.payload.toolCalls === undefined
            ? null
            : JSON.stringify(request.payload.toolCalls),
          toolName: request.payload.toolName ?? null,
          fingerprint: request.idempotencyKey,
          humanTurnId: null,
          transcriptOrigin: request.appendContext.transcriptOrigin,
          parentThreadId: request.appendContext.parentThreadId,
          scopeId: request.appendContext.scopeId,
          metadata: null,
          subthreadRoomId: request.appendContext.subthreadRoomId,
          replyToMessageId: null,
          notificationContext:
            request.appendContext.notificationContext,
          structuralProjection: {
            notificationEligibility: notificationEligible(
              request.payload,
              request.appendContext.transcriptOrigin,
            )
              ? "eligible"
              : "excluded",
            subthreadReplyClassification: countedReply(request.payload)
              ? "counted"
              : "excluded",
          },
        });
      } catch {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      if (allocation.namespaceId !== authority.namespaceId) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }

      if (allocation.status === "replayed") {
        const replayState: PreparedState = {
          allocation,
          prepared: null,
          productReadAuthorization: request.productReadAuthorization,
          agentId: request.agentId,
          status: "ready",
          committedMessage: null,
        };
        let records: Awaited<
          ReturnType<ProtectedConversationProductReadPort["readAround"]>
        >;
        try {
          records = await input.productReads.readAround({
            authorization: request.productReadAuthorization,
            sessionId: allocation.sessionId,
            messageId: allocation.messageId,
            radius: 0,
          });
        } catch {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
        }
        if (records.length !== 1) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          });
        }
        let replayedMessage: ProtectedMessageDtoV2;
        try {
          replayedMessage = parseProtectedMessageDtoV2(records[0]!.dto);
        } catch {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "content_invalid" as const,
          });
        }
        if (committedMessageMatches(replayedMessage, replayState)) {
          const write = Object.freeze({
            sessionId: request.sessionId,
            idempotencyKey: request.idempotencyKey,
          }) as PreparedProtectedAgentMessageWrite;
          replayState.status = "committed";
          replayState.committedMessage = replayedMessage;
          states.set(write, replayState);
          return Object.freeze({
            status: "prepared" as const,
            write,
          });
        }
        if (!pendingMessageMatches(replayedMessage, replayState)) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "content_invalid" as const,
          });
        }
      }

      const leased = input.registry.leaseOperation({
        view: request.authorization,
        entrypointId: request.entrypointId,
        operation: "encrypt",
        namespaceId: authority.namespaceId,
        domainId: authority.domainId,
      });
      if (leased.status !== "leased") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      const prepared =
        await input.registry.executeAgentConversationPreparation(
          leased.lease,
          {
            contentPort: input.cryptoPreparer,
            expectedAccessRevision: authority.expectedAccessRevision,
            expectedPolicyRevision: authority.expectedPolicyRevision,
            agentId: request.agentId,
            objectId: allocation.cryptoObjectId,
            payload: request.payload,
            createdAt: now(),
            ...(request.signal === undefined
              ? {}
              : { signal: request.signal }),
          },
        );
      if (prepared.status !== "executed") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: prepared.reason === "content_invalid"
            ? "content_invalid" as const
            : prepared.reason === "content_unavailable"
              || prepared.reason === "execution_failed"
              ? "content_unavailable" as const
              : "authorization_unavailable" as const,
        });
      }

      const write = Object.freeze({
        sessionId: request.sessionId,
        idempotencyKey: request.idempotencyKey,
      }) as PreparedProtectedAgentMessageWrite;
      states.set(write, {
        allocation,
        prepared: prepared.value,
        productReadAuthorization: request.productReadAuthorization,
        agentId: request.agentId,
        status: "ready",
        committedMessage: null,
      });
      return Object.freeze({
        status: "prepared" as const,
        write,
      });
    },
  });

  const committer: ProtectedAgentMessageWriteCommitter = Object.freeze({
    async appendPrepared(
      write: PreparedProtectedAgentMessageWrite,
    ): Promise<ActiveConversationMutationResult> {
      const state = states.get(write);
      if (
        state === undefined
        || write.sessionId !== state.allocation.sessionId
      ) {
        return Object.freeze({ status: "conflict" });
      }
      if (
        state.status === "committed"
        && state.committedMessage !== null
      ) {
        return Object.freeze({
          status: "committed",
          message: state.committedMessage,
        });
      }
      if (state.status === "committing" || state.prepared === null) {
        return Object.freeze({ status: "conflict" });
      }
      state.status = "committing";
      try {
        const completion = await input.mutations.completeRevision({
          messageId: state.allocation.messageId,
          expectedRevision: state.allocation.revision,
          parityStatus: "server_verified",
          prepared: state.prepared,
        });
        if (completion.status === "orphaned") {
          state.status = "ready";
          return Object.freeze({ status: "conflict" });
        }
        const records = await input.productReads.readAround({
          authorization: state.productReadAuthorization,
          sessionId: state.allocation.sessionId,
          messageId: state.allocation.messageId,
          radius: 0,
        });
        if (records.length !== 1) {
          state.status = "ready";
          return Object.freeze({
            status: "unavailable",
            reason: "content_unavailable",
          });
        }
        let message: ProtectedMessageDtoV2;
        try {
          message = parseProtectedMessageDtoV2(records[0]!.dto);
        } catch {
          state.status = "ready";
          return Object.freeze({
            status: "unavailable",
            reason: "content_invalid",
          });
        }
        if (!committedMessageMatches(message, state)) {
          state.status = "ready";
          return Object.freeze({
            status: "unavailable",
            reason: "content_invalid",
          });
        }
        state.committedMessage = message;
        state.status = "committed";
        return Object.freeze({ status: "committed", message });
      } catch {
        state.status = "ready";
        return Object.freeze({ status: "pending_shadow" });
      }
    },
  });

  return Object.freeze({ preparer, committer });
}
