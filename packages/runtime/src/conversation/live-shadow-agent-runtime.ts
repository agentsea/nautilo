import { AIMessage, ToolMessage, type BaseMessage } from
  "@langchain/core/messages";
import {
  LiveShadowToolProtectionRequiredError,
  LiveShadowToolProtectionTerminalError,
  type LiveShadowToolBoundary,
} from "@nautilo/agent";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  StrictShadowEnforcementError,
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type StrictShadowEnforcementPolicy,
  type DataOperationPolicyBinding,
  type MessagePayloadV2,
} from "@nautilo/lattice-bridge";
import type {
  LiveShadowAgentMessageReservation,
  LiveShadowAgentOrdinaryPublication,
  LiveShadowAgentPublishedMessage,
  LiveShadowAgentSessionFailureReason,
  LiveShadowAgentSessionResult,
  LiveShadowAgentStreamFrameResult,
  LiveShadowAgentStreamReservation,
  LiveShadowAgentTurnSession,
} from "@nautilo/lattice-bridge/server";

import { protectedAgentMessagePayload } from
  "./protected-conversation-executor-io.ts";

function openedMessage(
  payload: MessagePayloadV2,
  source: BaseMessage,
): AIMessage | ToolMessage {
  if (payload.role === "assistant") {
    const message = new AIMessage({
      content: payload.content,
      additional_kwargs: { ...(source.additional_kwargs ?? {}) },
    });
    if (payload.toolCalls !== undefined) {
      message.tool_calls = payload.toolCalls.map((call) => ({
        ...(call.id === undefined ? {} : { id: call.id }),
        name: call.name,
        args: { ...call.args },
        type: "tool_call" as const,
      }));
    }
    if (typeof source.id === "string") message.id = source.id;
    return message;
  }
  if (payload.role === "tool") {
    const toolCallId = payload.sensitiveMetadata?.["toolCallId"];
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      throw new TypeError(
        "Opened live Shadow Tool Message lacks its canonical call ID",
      );
    }
    const message = new ToolMessage({
      content: payload.content,
      tool_call_id: toolCallId,
      ...(payload.toolName === undefined ? {} : { name: payload.toolName }),
      additional_kwargs: { ...(source.additional_kwargs ?? {}) },
    });
    if (typeof source.id === "string") message.id = source.id;
    return message;
  }
  throw new TypeError("Live Shadow Runtime accepts only Agent/Tool payloads");
}

export interface LiveShadowAgentRuntimeTurn {
  readonly representationMode: "shadow_encryption" | "full_encryption";
  readonly sharedAgentPlanBytesBase64url: string | null;
  readonly toolBoundary: LiveShadowToolBoundary;
  reserveAssistantStream(input: Readonly<{
    assistantMessageKey: string;
    createdAt: number;
  }>): Promise<LiveShadowAgentStreamReservation | null>;
  sealAssistantStreamChunk(input: Readonly<{
    assistantMessageKey: string;
    ordinaryChunk: Uint8Array;
    done: boolean;
    finalMessage?: BaseMessage;
  }>): Promise<LiveShadowAgentStreamFrameResult | null>;
  publishMessages(
    messages: readonly BaseMessage[],
  ): Promise<LiveShadowAgentPublishBatchResult>;
}

export type LiveShadowAgentPublishBatchResult =
  | Readonly<{
      status: "protected";
      protectedMessages: readonly LiveShadowAgentPublishedMessage[];
    }>
  | Readonly<{
      status: "ordinary_fallback";
      protectedMessages: readonly LiveShadowAgentPublishedMessage[];
      ordinaryPublications: readonly LiveShadowAgentOrdinaryPublication[];
      ordinaryMessages: readonly BaseMessage[];
      failureStage?: string;
      failureReason?: string;
    }>;

/** Runtime adapter for the one callback-scoped server cryptographic session. */
export function createLiveShadowAgentRuntimeTurn(
  session: LiveShadowAgentTurnSession,
  enforcementPolicy: StrictShadowEnforcementPolicy,
  observeBoundary: ((input: Readonly<{
    boundaryId?:
      | "conversation.write.runtime_persist"
      | "conversation.read.foreground_history"
      | "conversation.read.foreground_journal"
      | "conversation.read.foreground_records"
      | "conversation.read.foreground_memory";
    state: "verified" | "waiting_for_authority" | "failed" | "unsupported";
    reason:
      | "none"
      | "publication_failure"
      | "unsupported_operation"
      | "domain_authority_converging"
      | "deadline_expired"
      | "integrity_failure";
    retryable?: boolean;
  }>) => Promise<void>) | undefined,
  livePolicy: DataOperationPolicyBinding | undefined,
): LiveShadowAgentRuntimeTurn {
  if (livePolicy === undefined) {
    throw new Error("Protected Runtime requires a live data-operation policy binding");
  }
  const representationMode = enforcementPolicy.mode === "encrypted_only"
    ? "full_encryption" : "shadow_encryption";
  if ((session.representationMode ?? "shadow_encryption") !== representationMode) {
    throw new Error("Agent encryption session does not match the admitted representation policy");
  }
  const isTerminalReason = (
    reason: LiveShadowAgentSessionFailureReason,
  ): boolean => reason === "integrity_failure"
    || reason === "parity_mismatch"
    || reason === "deadline_expired";
  const deadlineExpiredError = (
    actorClass: "agent" | "tool",
  ): StrictShadowEnforcementError => new StrictShadowEnforcementError({
    boundaryId: "conversation.write.runtime_persist",
    family: "message",
    operation: "write",
    actorClass,
    state: "failed",
    reason: "deadline_expired",
    retryable: false,
    policyRevision: enforcementPolicy.revision,
  });
  const throwTerminalAgentFailure = (
    reason: LiveShadowAgentSessionFailureReason,
  ): never => {
    if (reason === "deadline_expired") throw deadlineExpiredError("agent");
    throw new Error(`Live Shadow Agent protection failed terminally: ${reason}`);
  };
  const throwTerminalToolFailure = (
    reason: LiveShadowAgentSessionFailureReason,
  ): never => {
    if (reason === "deadline_expired") throw deadlineExpiredError("tool");
    throw new LiveShadowToolProtectionTerminalError();
  };
  const dataOperationOwner = bindEncryptionDataOperationOwner({
    policy: {
      async resolve() {
        const current = await livePolicy.resolve();
        if (
          current.revalidationToken !== enforcementPolicy.revision
          || current.policy.mode !== enforcementPolicy.mode
          || current.policy.shadowBehavior !== enforcementPolicy.shadowBehavior
        ) {
          throw new ClassifiedDataOperationError(
            "stale",
            "Protected Runtime admission policy changed",
          );
        }
        return current;
      },
      revalidate: (token) => livePolicy.revalidate(token),
    },
  });
  const selectRecoverableOperation = async <Value>(
    protectedOperation: () => Promise<Value>,
    ordinaryOperation: () => Promise<Value>,
    actorClass: "agent" | "tool" = "agent",
    requireAuthorization?: () => void,
  ): Promise<Value> => {
    try {
      return (await dataOperationOwner.read({
        protected: protectedOperation,
        ordinary: () => {
          requireAuthorization?.();
          return ordinaryOperation();
        },
        consumeProtected: (value) => value,
        consumeOrdinary: (value) => value,
      })).value;
    } catch (error) {
      if (
        error instanceof ClassifiedDataOperationError
        && error.failureClass === "recoverable_availability"
      ) {
        if (actorClass === "tool") {
          throw new LiveShadowToolProtectionRequiredError();
        }
        throw new StrictShadowEnforcementError({
          boundaryId: "conversation.write.runtime_persist",
          family: "message",
          operation: "write",
          actorClass,
          state: "failed",
          reason: "publication_failure",
          retryable: false,
          policyRevision: enforcementPolicy.revision,
        });
      }
      throw error;
    }
  };
  const sharedAgentPlanBytes =
    session.sharedAgentRealtimePlanBytes?.() ?? null;
  const sharedAgentPlanBytesBase64url = sharedAgentPlanBytes === null
    ? null
    : Buffer.from(sharedAgentPlanBytes).toString("base64url");
  sharedAgentPlanBytes?.fill(0);
  const published = new WeakMap<object, LiveShadowAgentPublishedMessage>();
  const publishedByPayload = new Map<string, LiveShadowAgentPublishedMessage>();
  const publishingByPayload = new Map<string, Promise<
    LiveShadowAgentSessionResult<LiveShadowAgentPublishedMessage>
  >>();
  const streams = new Map<string, Promise<LiveShadowAgentStreamReservation | null>>();
  const requireActiveAuthorization = (
    stage: "assistant_stream" | "assistant_message" | "tool_call" | "tool_result",
  ): void => {
    const deadlineExpired = session.authorizationDeadlineAt !== undefined
      && Date.now() >= session.authorizationDeadlineAt;
    if (!deadlineExpired && session.authorizationSignal?.aborted !== true) return;
    const reason = deadlineExpired
      ? "deadline_expired" as const
      : "protected_unavailable" as const;
    session.fail(stage, reason);
    if (deadlineExpired) {
      throw deadlineExpiredError(
        stage === "tool_call" || stage === "tool_result" ? "tool" : "agent",
      );
    }
    if (stage === "tool_call" || stage === "tool_result") {
      throw new LiveShadowToolProtectionTerminalError();
    }
    throw new Error("Live Shadow Agent authorization is unavailable");
  };

  const publish = async (
    source: BaseMessage,
    stage: "assistant_message" | "tool_call" | "tool_result",
    reservation?: LiveShadowAgentMessageReservation,
  ): Promise<LiveShadowAgentSessionResult<LiveShadowAgentPublishedMessage>> => {
    requireActiveAuthorization(stage);
    const prior = published.get(source);
    if (prior !== undefined) {
      return Object.freeze({ status: "protected" as const, value: prior });
    }
    // Keep the protected payload byte-identical to the canonical ordinary
    // transcript representation. `ToolMessage.status` is execution-local and
    // `session_messages` does not persist it, so including it here would make
    // Browser parity impossible to reconstruct after the ordinary commit.
    let payload: MessagePayloadV2;
    try {
      payload = protectedAgentMessagePayload(source);
    } catch (error) {
      session.fail(stage, "integrity_failure");
      await observeBoundary?.({
        state: "failed",
        reason: "publication_failure",
      });
      if (stage === "tool_call" || stage === "tool_result") {
        throw new LiveShadowToolProtectionTerminalError();
      }
      throw error;
    }
    const canonical = encodeMessagePayloadV2(payload);
    const payloadKey = Buffer.from(canonical).toString("base64url");
    canonical.fill(0);
    const semanticPrior = publishedByPayload.get(payloadKey);
    if (semanticPrior !== undefined) {
      published.set(source, semanticPrior);
      return Object.freeze({
        status: "protected" as const,
        value: semanticPrior,
      });
    }
    let pending = publishingByPayload.get(payloadKey);
    if (pending === undefined) {
      let fallback: LiveShadowAgentSessionResult<LiveShadowAgentPublishedMessage> | undefined;
      pending = selectRecoverableOperation(async () => {
          const attempted = await session.publishMessage({
            payload,
            stage,
            ...(reservation === undefined ? {} : { reservation }),
          });
          if (attempted.status === "protected") {
            requireActiveAuthorization(stage);
            return attempted;
          }
          if (isTerminalReason(attempted.reason)) {
            if (stage === "tool_call" || stage === "tool_result") {
              throwTerminalToolFailure(attempted.reason);
            }
            throwTerminalAgentFailure(attempted.reason);
          }
          requireActiveAuthorization(stage);
          fallback = attempted;
          session.fail(stage, "protected_unavailable");
          throw new ClassifiedDataOperationError(
            "recoverable_availability", "Protected Runtime publication unavailable",
          );
        }, () => Promise.resolve(fallback ?? Object.freeze({
          status: "ordinary_fallback" as const,
          stage,
          reason: "protected_unavailable" as const,
        })), stage === "tool_call" || stage === "tool_result" ? "tool" : "agent",
        () => requireActiveAuthorization(stage));
      publishingByPayload.set(payloadKey, pending);
    }
    let result: LiveShadowAgentSessionResult<LiveShadowAgentPublishedMessage>;
    try {
      result = await pending;
    } finally {
      if (publishingByPayload.get(payloadKey) === pending) {
        publishingByPayload.delete(payloadKey);
      }
    }
    requireActiveAuthorization(stage);
    if (result.status !== "protected") {
      await observeBoundary?.({
        state: "failed",
        reason: "publication_failure",
      });
      if (isTerminalReason(result.reason)) {
        if (stage === "tool_call" || stage === "tool_result") {
          throwTerminalToolFailure(result.reason);
        }
        throwTerminalAgentFailure(result.reason);
      }
      return result;
    }
    await observeBoundary?.({
      state: "verified",
      reason: "none",
    });
    const opened = openedMessage(result.value.openedPayload, source);
    published.set(source, result.value);
    published.set(opened, result.value);
    // This cache only joins the consumer and durable gates for one logical
    // Message. It is not a transcript/product ceiling: long turns may keep
    // publishing after the oldest dedupe entry is no longer useful.
    if (publishedByPayload.size >= 256) {
      const oldest = publishedByPayload.keys().next().value;
      if (oldest !== undefined) publishedByPayload.delete(oldest);
    }
    publishedByPayload.set(payloadKey, result.value);
    return Object.freeze({
      status: "protected" as const,
      value: Object.freeze({
        ...result.value,
        // Re-decode the canonical bytes so callers never depend on a mutable
        // source Message object after the self-open gate.
        openedPayload: decodeMessagePayloadV2(
          encodeMessagePayloadV2(result.value.openedPayload),
        ),
      }),
    });
  };

  const toolBoundary: LiveShadowToolBoundary = Object.freeze({
    protectAssistantToolCall: async (message: AIMessage) => {
      try {
        // Tool consumption may overtake the awaited stream allocation. Join that
        // allocation before publishing, so both gates use one transcript ordinal.
        const stream = Array.from(streams.entries()).at(-1);
        const reservation = stream === undefined
          ? undefined
          : (await stream[1])?.reservation;
        const result = await publish(message, "tool_call", reservation);
        if (result.status !== "protected") {
          return null;
        }
        if (
          stream !== undefined
          && reservation === result.value.reservation
        ) streams.delete(stream[0]);
        return openedMessage(result.value.openedPayload, message) as AIMessage;
      } catch (error) {
        if (
          error instanceof LiveShadowToolProtectionRequiredError
          || error instanceof LiveShadowToolProtectionTerminalError
          || error instanceof StrictShadowEnforcementError
        ) throw error;
        session.fail("tool_call", "integrity_failure");
        await observeBoundary?.({
          state: "failed",
          reason: "integrity_failure",
        });
        throw new LiveShadowToolProtectionTerminalError();
      }
    },
    protectToolResult: async (message: ToolMessage) => {
      try {
        const result = await publish(message, "tool_result");
        if (result.status !== "protected") {
          return null;
        }
        return openedMessage(result.value.openedPayload, message) as ToolMessage;
      } catch (error) {
        if (
          error instanceof LiveShadowToolProtectionRequiredError
          || error instanceof LiveShadowToolProtectionTerminalError
          || error instanceof StrictShadowEnforcementError
        ) throw error;
        session.fail("tool_result", "integrity_failure");
        await observeBoundary?.({
          state: "failed",
          reason: "integrity_failure",
        });
        throw new LiveShadowToolProtectionTerminalError();
      }
    },
  });

  return Object.freeze({
    representationMode,
    sharedAgentPlanBytesBase64url,
    toolBoundary,
    async reserveAssistantStream(input: Readonly<{
      assistantMessageKey: string;
      createdAt: number;
    }>) {
      requireActiveAuthorization("assistant_stream");
      const prior = streams.get(input.assistantMessageKey);
      if (prior !== undefined) return null;
      const pending = (async () => {
        const result = await selectRecoverableOperation<
          LiveShadowAgentSessionResult<LiveShadowAgentStreamReservation>
        >(async () => {
          const attempted = await session.reserveAssistantStream(input);
          if (attempted.status === "protected") {
            requireActiveAuthorization("assistant_stream");
            return attempted;
          }
          if (isTerminalReason(attempted.reason)) throwTerminalAgentFailure(attempted.reason);
          requireActiveAuthorization("assistant_stream");
          session.fail("assistant_stream", "protected_unavailable");
          await observeBoundary?.({ state: "failed", reason: "publication_failure" });
          throw new ClassifiedDataOperationError(
            "recoverable_availability", "Protected stream reservation unavailable",
          );
        }, () => Promise.resolve({
          status: "ordinary_fallback" as const,
          stage: "assistant_stream" as const,
          reason: "protected_unavailable" as const,
        }), "agent", () => requireActiveAuthorization("assistant_stream"));
        requireActiveAuthorization("assistant_stream");
        if (result.status !== "protected") {
          return null;
        }
        return result.value;
      })();
      // Register before yielding: a tool boundary can run while storage awaits.
      streams.set(input.assistantMessageKey, pending);
      return pending;
    },
    async sealAssistantStreamChunk(input: Readonly<{
      assistantMessageKey: string;
      ordinaryChunk: Uint8Array;
      done: boolean;
      finalMessage?: BaseMessage;
    }>) {
      requireActiveAuthorization("assistant_stream");
      const stream = streams.get(input.assistantMessageKey);
      const reservation = stream === undefined ? undefined : (await stream)?.reservation;
      if (reservation === undefined) {
        return selectRecoverableOperation(
          () => Promise.reject(new ClassifiedDataOperationError(
            "recoverable_availability", "Protected stream reservation is missing",
          )),
          () => Promise.resolve(null),
          "agent",
          () => requireActiveAuthorization("assistant_stream"),
        );
      }
      let finalPayload: MessagePayloadV2 | undefined;
      if (input.done) {
        if (input.finalMessage === undefined) {
          return selectRecoverableOperation(
            () => Promise.reject(new ClassifiedDataOperationError(
              "recoverable_availability", "Protected final stream message is missing",
            )),
            () => Promise.resolve(null),
            "agent",
            () => requireActiveAuthorization("assistant_stream"),
          );
        }
        try {
          finalPayload = protectedAgentMessagePayload(input.finalMessage);
        } catch (error) {
          session.fail("assistant_stream", "integrity_failure");
          throw error;
        }
      }
      const result = await selectRecoverableOperation(async () => {
        const attempted = await Promise.resolve(session.sealAssistantStreamChunk({
          reservation,
          ordinaryChunk: input.ordinaryChunk,
          done: input.done,
          ...(finalPayload === undefined ? {} : { finalPayload }),
        }));
        if (attempted.status === "protected") {
          requireActiveAuthorization("assistant_stream");
          return attempted;
        }
        if (isTerminalReason(attempted.reason)) throwTerminalAgentFailure(attempted.reason);
        requireActiveAuthorization("assistant_stream");
        session.fail("assistant_stream", "protected_unavailable");
        throw new ClassifiedDataOperationError(
          "recoverable_availability", "Protected stream frame unavailable",
        );
      }, () => Promise.resolve(null), "agent", () =>
        requireActiveAuthorization("assistant_stream"));
      requireActiveAuthorization("assistant_stream");
      if (result === null) return null;
      return result.value;
    },
    async publishMessages(messages: readonly BaseMessage[]) {
      requireActiveAuthorization("assistant_message");
      const results: LiveShadowAgentPublishedMessage[] = [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        if (!AIMessage.isInstance(message) && !ToolMessage.isInstance(message)) {
          return selectRecoverableOperation(
            () => Promise.reject(new ClassifiedDataOperationError(
              "unsupported", "Runtime message role is not protectable",
            )),
            () => Promise.resolve(Object.freeze({
            status: "ordinary_fallback" as const,
            protectedMessages: Object.freeze(results),
            ordinaryPublications: Object.freeze([]),
            ordinaryMessages: Object.freeze(messages.slice(index)),
            })),
            "agent",
            () => requireActiveAuthorization("assistant_message"),
          );
        }
        const key = AIMessage.isInstance(message)
          ? Array.from(streams.entries()).at(-1)
          : undefined;
        const result = await publish(
          message,
          AIMessage.isInstance(message) ? "assistant_message" : "tool_result",
          key === undefined ? undefined : (await key[1])?.reservation,
        );
        if (result.status !== "protected") {
          const ordinaryPublication = result.ordinaryPublication;
          return Object.freeze({
            status: "ordinary_fallback" as const,
            failureStage: result.stage,
            failureReason: result.reason,
            protectedMessages: Object.freeze(results),
            ordinaryPublications: Object.freeze(
              ordinaryPublication === undefined ? [] : [ordinaryPublication],
            ),
            ordinaryMessages: Object.freeze(messages.slice(
              index + (ordinaryPublication === undefined ? 0 : 1),
            )),
          });
        }
        results.push(result.value);
        if (key !== undefined
          && (await key[1])?.reservation === result.value.reservation) {
          streams.delete(key[0]);
        }
      }
      return Object.freeze({
        status: "protected" as const,
        protectedMessages: Object.freeze(results),
      });
    },
  });
}
