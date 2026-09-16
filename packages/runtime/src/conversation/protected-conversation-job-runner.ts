import type { ServerEvent } from "@nautilo/types";
import {
  parseProtectedMessageRealtimeEventV2,
  type ProtectedMessageDtoV2,
  type ProtectedMessageRealtimeEventV2,
} from "@nautilo/types";

import type { RoomHistoryHit } from "../conductor/history-search";
import type {
  ConversationJobRunner,
  ProtectedConversationInvocation,
} from "./conversation-job-executor";
import type {
  ProtectedConversationExecutionServices,
} from "./conversation-execution-services";
import {
  executeProtectedConversationTurn,
} from "./protected-conversation-executor-io";

const PROTECTED_TRANSCRIPT_EXECUTION_LIMIT = 256;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

export type ProtectedConversationAuthorizedCoreRunner = (
  input: Record<string, unknown>,
  jobId: string,
  laneKey: string,
  signal: AbortSignal,
  services: ProtectedConversationExecutionServices,
  invocation: ProtectedConversationInvocation,
  scope: Readonly<{
    readonly history: readonly RoomHistoryHit[];
    readonly persist: Parameters<
      Parameters<typeof executeProtectedConversationTurn>[0]["execute"]
    >[0]["persist"];
  }>,
) => AsyncIterable<ServerEvent>;

export class ProtectedConversationExecutionUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Protected conversation execution is unavailable: ${reason}`);
    this.name = "ProtectedConversationExecutionUnavailableError";
  }
}

type ChannelRecord<Value> = {
  readonly value: Value;
  readonly delivered: () => void;
  readonly failed: (cause: unknown) => void;
};

class BackpressuredEventChannel<Value> {
  readonly #records: ChannelRecord<Value>[] = [];
  readonly #readers: Array<{
    readonly resolve: (result: IteratorResult<Value>) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  #closed = false;
  #failure: Error | null = null;

  write(value: Value): Promise<void> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#closed) {
      return Promise.reject(new Error("Protected event channel is closed"));
    }
    return new Promise<void>((resolve, reject) => {
      const reader = this.#readers.shift();
      if (reader !== undefined) {
        reader.resolve({ done: false, value });
        resolve();
        return;
      }
      this.#records.push({ value, delivered: resolve, failed: reject });
    });
  }

  close(): void {
    this.#closed = true;
    this.#finishReaders();
  }

  fail(cause: unknown): void {
    if (this.#failure !== null) return;
    const failure = cause instanceof Error
      ? cause
      : new Error("Protected conversation execution failed", { cause });
    this.#failure = failure;
    for (const record of this.#records.splice(0)) {
      record.failed(failure);
    }
    for (const reader of this.#readers.splice(0)) {
      reader.reject(failure);
    }
  }

  cancel(): void {
    if (this.#closed || this.#failure !== null) return;
    this.fail(new Error("Protected conversation event consumer closed"));
  }

  async next(): Promise<IteratorResult<Value>> {
    if (this.#failure !== null) throw this.#failure;
    const record = this.#records.shift();
    if (record !== undefined) {
      record.delivered();
      this.#finishReaders();
      return { done: false, value: record.value };
    }
    if (this.#closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<Value>>((resolve, reject) => {
      this.#readers.push({ resolve, reject });
    });
  }

  #finishReaders(): void {
    if (!this.#closed || this.#records.length > 0) return;
    for (const reader of this.#readers.splice(0)) {
      reader.resolve({ done: true, value: undefined });
    }
  }
}

function requiredRoomLane(
  input: Readonly<Record<string, unknown>>,
  laneKey: string | null,
): `room:${string}` {
  const roomId = input["roomId"];
  const expected = typeof roomId === "string" && UUID.test(roomId)
    ? `room:${roomId}` as const
    : null;
  if (expected === null || laneKey !== expected) {
    throw new TypeError(
      "Protected conversation requires its exact canonical Room lane",
    );
  }
  return expected;
}

function tokenSuppressedEvent(
  input: Readonly<Record<string, unknown>>,
  laneKey: `room:${string}`,
): ProtectedMessageRealtimeEventV2 {
  const turnId = input["turnId"];
  const authorAgentId = input["agentId"];
  return parseProtectedMessageRealtimeEventV2({
    wireVersion: 2,
    type: "message.tokens",
    protection: "protected",
    laneKey,
    streaming: "suppressed",
    done: true,
    ...(typeof turnId === "string" && PORTABLE_ID.test(turnId)
      ? { turnId }
      : {}),
    ...(typeof authorAgentId === "string" && UUID.test(authorAgentId)
      ? { authorAgentId }
      : {}),
  });
}

function requiredAgentId(
  input: Readonly<Record<string, unknown>>,
): string {
  const agentId = input["agentId"];
  if (typeof agentId !== "string" || !UUID.test(agentId)) {
    throw new TypeError(
      "Protected conversation requires its exact Agent identity",
    );
  }
  return agentId;
}

function optionalUuid(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = input[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`Protected conversation ${field} is malformed`);
  }
  return value;
}

function optionalPortable(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = input[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !PORTABLE_ID.test(value)) {
    throw new TypeError(`Protected conversation ${field} is malformed`);
  }
  return value;
}

function finalMessageEvent(
  laneKey: `room:${string}`,
  message: ProtectedMessageDtoV2,
): ProtectedMessageRealtimeEventV2 {
  return parseProtectedMessageRealtimeEventV2({
    wireVersion: 2,
    type: "message.new",
    protection: "protected",
    laneKey,
    message,
  });
}

function isProtectedRealtime(event: ServerEvent): boolean {
  return "protection" in event && event.protection === "protected";
}

/**
 * Adapt one ordinary async event-producing executor core to the protected
 * transcript callback. The rendezvous channel applies consumer backpressure,
 * so the authorization callback remains live until every event is consumed.
 */
export function createProtectedConversationJobRunner(input: Readonly<{
  readonly entrypointId: "foreground.main" | "foreground.fork";
  readonly run: ProtectedConversationAuthorizedCoreRunner;
}>): ConversationJobRunner {
  return async function* (
    jobInput,
    jobId,
    laneKey,
    signal,
    services,
    invocation,
  ): AsyncGenerator<ServerEvent> {
    const roomLane = requiredRoomLane(jobInput, laneKey);
    const agentId = requiredAgentId(jobInput);
    const causalHumanUserId =
      optionalUuid(jobInput, "causalHumanUserId");
    const causalHumanTurnId = causalHumanUserId === null
      ? null
      : optionalPortable(jobInput, "turnId");
    if (invocation.namespaceId.length < 1) {
      throw new TypeError("Protected conversation Namespace is missing");
    }
    const channel = new BackpressuredEventChannel<ServerEvent>();
    let suppressedTokensEmitted = false;
    const operation = (async () => {
      const result = await executeProtectedConversationTurn({
        sessionId: invocation.sessionId,
        namespaceId: invocation.namespaceId,
        limit: PROTECTED_TRANSCRIPT_EXECUTION_LIMIT,
        productReadAuthorization:
          invocation.productReadAuthorization,
        authorization: services.authorization,
        entrypointId: input.entrypointId,
        agentId,
        appendContext: {
          transcriptOrigin: "main",
          parentThreadId: null,
          scopeId: null,
          subthreadRoomId: optionalUuid(jobInput, "subthreadRoomId"),
          notificationContext: {
            mentionedHumanUserIds: Object.freeze([]),
            causalHumanUserId,
            causalHumanTurnId,
          },
        },
        signal,
        repository: services.repository,
        preparer: services.protectedAgentMessagePreparer,
        execute: async (scope) => {
          const protectedScope = Object.freeze({
            history: scope.history,
            persist: async (
              messages: Parameters<typeof scope.persist>[0],
            ) => {
              const committed = await scope.persist(messages);
              for (const message of committed) {
                await channel.write(finalMessageEvent(roomLane, message));
              }
              return committed;
            },
          });
          for await (const event of input.run(
            jobInput,
            jobId,
            roomLane,
            signal,
            services,
            invocation,
            protectedScope,
          )) {
            if (event.type === "message.tokens") {
              if (!suppressedTokensEmitted) {
                suppressedTokensEmitted = true;
                await channel.write(
                  tokenSuppressedEvent(jobInput, roomLane),
                );
              }
              continue;
            }
            if (event.type === "tool.start" || event.type === "tool.end") {
              continue;
            }
            if (
              (
                event.type === "message.new"
                || event.type === "message.updated"
              )
              && !isProtectedRealtime(event)
            ) {
              throw new TypeError(
                "Protected conversation core emitted plaintext message realtime",
              );
            }
            await channel.write(event);
          }
        },
      });
      if (result.status === "unavailable") {
        throw new ProtectedConversationExecutionUnavailableError(
          result.reason,
        );
      }
      channel.close();
    })().catch((cause: unknown) => {
      channel.fail(cause);
    });

    try {
      while (true) {
        const event = await channel.next();
        if (event.done) break;
        yield event.value;
      }
    } finally {
      channel.cancel();
      await operation;
    }
  };
}
