import { parseImageAssistanceSummary } from "@nautilo/types";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type CanonicalJsonValue,
  type CanonicalToolCallV2,
  type MessagePayloadV2,
  type ProtectedAgentRuntimeForegroundEntrypointId,
} from "@nautilo/lattice-bridge";
import { computeMessageFingerprint } from "@nautilo/agent";

import type {
  ActiveConversationRepository,
  AgentTranscriptOpenResult,
  ProtectedAgentMessageWritePreparer,
  ProtectedConversationProductReadAuthorization,
} from "./active-conversation-repository";
import type {
  ProtectedConversationExecutorTurnScope,
} from "./conversation-execution-services";
import type {
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";
import type {
  ProtectedMessageDtoV2,
} from "@nautilo/types";
import { sanitizeMessageForTranscript } from "../executors/persist-messages";
import type { RoomHistoryHit } from "../conductor/history-search";
import {
  withProtectedAgentTranscriptHistory,
} from "./protected-conversation-transcript";
export class ProtectedConversationPersistenceError extends Error {
  constructor(
    readonly phase: "prepare" | "commit",
    readonly outcome: string,
  ) {
    super(`Protected conversation ${phase} failed: ${outcome}`);
    this.name = "ProtectedConversationPersistenceError";
  }
}

class ProtectedConversationFreshReadClosedError extends Error {
  constructor() {
    super("Protected conversation fresh read authorization callback closed");
    this.name = "ProtectedConversationFreshReadClosedError";
  }
}

function isTransientContext(message: BaseMessage): boolean {
  return (
    message.additional_kwargs as
      | { readonly nautilo_transient_context?: unknown }
      | undefined
  )?.nautilo_transient_context === true;
}

function nativeToolArguments(
  type: "tool_use" | "tool_call" | "function",
  record: Readonly<Record<string, unknown>>,
): unknown {
  if (type === "tool_call") return record["args"];
  const nested = record["function"];
  // LangChain Anthropic streaming accumulates input_json_delta into a JSON
  // string in the native tool_use block, while tool_calls.args is parsed.
  // Parse only complete JSON here; the exact canonical comparison below still
  // rejects truncated, non-object, mismatched or unrepresented arguments.
  const value = type === "tool_use" ? record["input"] : typeof nested === "object" && nested !== null
    ? (nested as Readonly<Record<string, unknown>>)["arguments"]
    : record["arguments"] ?? record["args"];
  // Anthropic emits no input_json_delta for a zero-argument call. Its initial
  // input remains "", and LangChain collapseToolCallChunks canonically maps
  // that empty stream to {}. This still must match the exact canonical call.
  if (type === "tool_use" && value === "") return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function canonicalToolCallFingerprint(input: Readonly<{
  name: string;
  args: unknown;
}>): string | null {
  if (
    typeof input.args !== "object"
    || input.args === null
    || Array.isArray(input.args)
  ) return null;
  try {
    return new TextDecoder().decode(encodeMessagePayloadV2({
      role: "assistant",
      content: "",
      toolCalls: [{
        name: input.name,
        args: input.args as Readonly<Record<string, CanonicalJsonValue>>,
      }],
    }));
  } catch {
    return null;
  }
}

function visibleContent(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) {
    throw new TypeError("Protected conversation content is malformed");
  }
  return message.content.map((block) => {
    if (typeof block === "string") return block;
    if (typeof block !== "object" || block === null) {
      throw new TypeError("Protected conversation content block is malformed");
    }
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" || record["type"] === "output_text") {
      if (typeof record["text"] !== "string") {
        throw new TypeError("Protected conversation text block is malformed");
      }
      return record["text"];
    }
    if (record["type"] === "image" || record["type"] === "image_url") {
      // Binary image parts are transport for the model, not user-visible
      // transcript text. Keep any explicit text parts verbatim, but do not
      // manufacture a literal `[image]` marker in the persisted payload.
      return "";
    }
    if (
      AIMessage.isInstance(message)
      && (record["type"] === "tool_use"
        || record["type"] === "tool_call"
        || record["type"] === "function")
    ) {
      // Provider-native tool transport is represented canonically by
      // `message.tool_calls` below. Accept it only when LangChain produced that
      // canonical call too; otherwise dropping the block would lose secret
      // tool arguments from the protected transcript.
      const id = typeof record["id"] === "string" ? record["id"] : undefined;
      const name = typeof record["name"] === "string"
        ? record["name"]
        : typeof (record["function"] as Record<string, unknown> | undefined)?.["name"] === "string"
        ? (record["function"] as Record<string, unknown>)["name"] as string
        : undefined;
      const type = record["type"];
      const rawFingerprint = name === undefined
        ? null
        : canonicalToolCallFingerprint({
            name,
            args: nativeToolArguments(type, record),
          });
      const hasCanonicalCall = rawFingerprint !== null
        && message.tool_calls?.some((call) =>
          (id === undefined || call.id === id)
          && call.name === name
          && canonicalToolCallFingerprint({
            name: call.name,
            args: call.args,
          }) === rawFingerprint
        ) === true;
      if (!hasCanonicalCall) {
        throw new TypeError(
          "Protected Agent tool block lacks an exact canonical tool call",
        );
      }
      return "";
    }
    throw new TypeError(
      "Protected conversation content block is unsupported",
    );
  }).join("");
}

function canonicalToolCalls(message: BaseMessage): CanonicalToolCallV2[] {
  if (!AIMessage.isInstance(message) || !message.tool_calls?.length) return [];
  return message.tool_calls.map((call) => {
    if (
      typeof call.name !== "string"
      || typeof call.args !== "object"
      || call.args === null
      || Array.isArray(call.args)
    ) {
      throw new TypeError("Protected Agent tool call is malformed");
    }
    return {
      ...(typeof call.id === "string" && call.id.length > 0
        ? { id: call.id }
        : {}),
      name: call.name,
      // This is the confidential canonical transcript, not the lossy
      // tool.start telemetry projection. Encoding below validates the full
      // JSON value and encryption protects it before any consumer gate.
      args: call.args as Readonly<Record<string, CanonicalJsonValue>>,
    };
  });
}

/**
 * Converts the existing in-memory LangChain message into the canonical
 * confidential payload. This function is intentionally Agent-only: Human
 * messages use the coordinate-first client encryption ceremony.
 */
export function protectedAgentMessagePayload(
  source: BaseMessage,
  foregroundExecutionId?: string,
): MessagePayloadV2 {
  if (HumanMessage.isInstance(source)) {
    throw new TypeError(
      "Human messages require coordinate-first protected persistence",
    );
  }
  const message = sanitizeMessageForTranscript(source);
  const content = visibleContent(message);
  let payload: MessagePayloadV2;
  if (AIMessage.isInstance(message)) {
    const toolCalls = canonicalToolCalls(message);
    payload = {
      role: "assistant",
      content,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(() => {
        const imageAssistance = parseImageAssistanceSummary(message.additional_kwargs["nautilo_image_assistance"]);
        return imageAssistance ? { sensitiveMetadata: { imageAssistance: { ...imageAssistance } } } : {};
      })(),
    };
  } else if (ToolMessage.isInstance(message)) {
    payload = {
      role: "tool",
      content,
      ...(typeof message.name === "string" && message.name.length > 0
        ? { toolName: message.name }
        : {}),
      ...(typeof message.tool_call_id === "string"
          && message.tool_call_id.length > 0
        ? {
          sensitiveMetadata: {
            toolCallId: message.tool_call_id,
          },
        }
        : {}),
    };
  } else if (SystemMessage.isInstance(message)) {
    payload = { role: "system", content };
  } else {
    throw new TypeError("Unsupported protected Agent message type");
  }
  if (foregroundExecutionId) {
    payload = {
      ...payload,
      sensitiveMetadata: {
        ...(payload.sensitiveMetadata ?? {}),
        foregroundExecutionId,
      },
    };
  }
  return decodeMessagePayloadV2(encodeMessagePayloadV2(payload));
}

/**
 * Sequentially prepares and commits protected Agent transcript rows.
 *
 * Ordering is load-bearing for tool traffic. A fingerprint is marked saved
 * only after the protected repository reports a durable commit, so an aborted
 * batch can be retried without silently losing a row.
 */
export async function persistProtectedAgentMessages(input: Readonly<{
  readonly sessionId: string;
  readonly messages: readonly BaseMessage[];
  readonly savedFingerprints: Set<string>;
  readonly preparer: ProtectedAgentMessageWritePreparer;
  readonly repository: Pick<
    ActiveConversationRepository,
    "appendPreparedAgent"
  >;
  readonly authorization: ForegroundAuthorizationView;
  readonly entrypointId?: ProtectedAgentRuntimeForegroundEntrypointId;
  readonly agentId?: string;
  readonly foregroundExecutionId?: string;
  readonly appendContext?: Parameters<
    ProtectedAgentMessageWritePreparer["prepare"]
  >[0]["appendContext"];
  readonly productReadAuthorization?:
    ProtectedConversationProductReadAuthorization;
  readonly signal?: AbortSignal;
}>): Promise<readonly ProtectedMessageDtoV2[]> {
  const committedMessages: ProtectedMessageDtoV2[] = [];
  for (const message of input.messages) {
    if (isTransientContext(message)) continue;
    if (HumanMessage.isInstance(message)) {
      throw new TypeError(
        "Human messages require coordinate-first protected persistence",
      );
    }
    const fingerprint = computeMessageFingerprint(message);
    if (input.savedFingerprints.has(fingerprint)) continue;
    const prepared = await input.preparer.prepare({
      sessionId: input.sessionId,
      idempotencyKey: fingerprint,
      payload: protectedAgentMessagePayload(
        message,
        input.foregroundExecutionId,
      ),
      authorization: input.authorization,
      ...(input.entrypointId === undefined
        ? {}
        : { entrypointId: input.entrypointId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.appendContext === undefined
        ? {}
        : { appendContext: input.appendContext }),
      ...(input.productReadAuthorization === undefined
        ? {}
        : {
          productReadAuthorization:
            input.productReadAuthorization,
        }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (prepared.status !== "prepared") {
      throw new ProtectedConversationPersistenceError(
        "prepare",
        prepared.reason,
      );
    }
    const committed = await input.repository.appendPreparedAgent(
      prepared.write,
    );
    if (committed.status !== "committed") {
      throw new ProtectedConversationPersistenceError(
        "commit",
        committed.status === "unavailable"
          ? committed.reason
          : committed.status,
      );
    }
    if (committed.message === undefined) {
      throw new ProtectedConversationPersistenceError(
        "commit",
        "committed_message_receipt_missing",
      );
    }
    committedMessages.push(committed.message);
    input.savedFingerprints.add(fingerprint);
  }
  return Object.freeze(committedMessages);
}

/**
 * Runs one protected foreground unit inside the repository's authorized
 * transcript callback. Both decrypted history and the only usable Agent
 * output writer expire when `execute` returns.
 */
export async function executeProtectedConversationTurn<Value>(
  input: Readonly<{
    readonly sessionId: string;
    readonly namespaceId: string;
    readonly upToMessageId?: number;
    readonly limit: number;
    readonly productReadAuthorization:
      ProtectedConversationProductReadAuthorization;
    readonly authorization: ForegroundAuthorizationView;
    readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly agentId: string;
    readonly appendContext: NonNullable<Parameters<
      ProtectedAgentMessageWritePreparer["prepare"]
    >[0]["appendContext"]>;
    readonly signal?: AbortSignal;
    readonly repository: Pick<
      ActiveConversationRepository,
      "withAgentTranscript" | "appendPreparedAgent"
    >;
    readonly preparer: ProtectedAgentMessageWritePreparer;
    readonly execute: (
      scope: ProtectedConversationExecutorTurnScope,
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<AgentTranscriptOpenResult<Value>> {
  const savedFingerprints = new Set<string>();
  return withProtectedAgentTranscriptHistory(input.repository, {
    sessionId: input.sessionId,
    namespaceId: input.namespaceId,
    ...(input.upToMessageId === undefined
      ? {}
      : { upToMessageId: input.upToMessageId }),
    limit: input.limit,
    productReadAuthorization: input.productReadAuthorization,
    authorization: input.authorization,
    entrypointId: input.entrypointId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    execute: async (history) => {
      let callbackLive = true;
      const readFreshHistory: ProtectedConversationExecutorTurnScope["readFreshHistory"] =
        async <ReadValue>(readInput: Readonly<{
          readonly throughMessageIdInclusive: number;
          readonly excludeMessageId: number;
          readonly excludeMessageIds?: readonly number[];
          readonly foregroundExecutionId?: string;
          readonly execute: (
            history: readonly RoomHistoryHit[],
          ) => ReadValue | PromiseLike<ReadValue>;
        }>): Promise<AgentTranscriptOpenResult<ReadValue>> => {
          if (
            !Number.isSafeInteger(readInput.throughMessageIdInclusive)
            || readInput.throughMessageIdInclusive < 1
            || !Number.isSafeInteger(readInput.excludeMessageId)
            || readInput.excludeMessageId < 1
            || readInput.throughMessageIdInclusive < readInput.excludeMessageId
          ) {
            throw new RangeError(
              "protected transcript refresh cut is out of bounds",
            );
          }
          const excludedMessageIds = new Set([
            readInput.excludeMessageId,
            ...(readInput.excludeMessageIds ?? []),
          ]);
          if ([...excludedMessageIds].some((id) =>
            !Number.isSafeInteger(id)
            || id < 1
            || id > readInput.excludeMessageId
          )) {
            throw new RangeError(
              "protected transcript refresh exclusion is out of bounds",
            );
          }
          if (!callbackLive) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            });
          }
          try {
            return await withProtectedAgentTranscriptHistory(input.repository, {
              sessionId: input.sessionId,
              namespaceId: input.namespaceId,
              upToMessageId: readInput.throughMessageIdInclusive,
              limit: input.limit,
              productReadAuthorization: input.productReadAuthorization,
              authorization: input.authorization,
              entrypointId: input.entrypointId,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              execute: (freshHistory) => {
                if (!callbackLive) {
                  throw new ProtectedConversationFreshReadClosedError();
                }
                return readInput.execute(
                  freshHistory.filter((hit) =>
                    (
                      hit.messageId < readInput.excludeMessageId
                      && !excludedMessageIds.has(hit.messageId)
                    )
                    || (
                      hit.messageId > readInput.excludeMessageId
                      && (hit.role === "assistant" || hit.role === "tool")
                      && (
                        readInput.foregroundExecutionId === undefined
                        || hit.foregroundExecutionId === readInput.foregroundExecutionId
                      )
                    )
                  ),
                );
              },
            });
          } catch (error) {
            if (error instanceof ProtectedConversationFreshReadClosedError) {
              return Object.freeze({
                status: "unavailable" as const,
                reason: "authorization_unavailable" as const,
              });
            }
            throw error;
          }
        };
      const persist = async (
        messages: readonly BaseMessage[],
        foregroundExecutionId?: string,
      ): Promise<readonly ProtectedMessageDtoV2[]> => {
        if (!callbackLive) {
          throw new ProtectedConversationPersistenceError(
            "commit",
            "authorization_callback_closed",
          );
        }
        return persistProtectedAgentMessages({
          sessionId: input.sessionId,
          messages,
          savedFingerprints,
          preparer: input.preparer,
          repository: input.repository,
          authorization: input.authorization,
          entrypointId: input.entrypointId,
          agentId: input.agentId,
          ...(foregroundExecutionId === undefined
            ? {}
            : { foregroundExecutionId }),
          appendContext: input.appendContext,
          productReadAuthorization:
            input.productReadAuthorization,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      };
      try {
        return await input.execute({ history, readFreshHistory, persist });
      } finally {
        callbackLive = false;
      }
    },
  });
}
