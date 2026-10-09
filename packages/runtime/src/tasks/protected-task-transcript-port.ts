import type { BaseMessage } from "@langchain/core/messages";
import { computeMessageFingerprint } from "@nautilo/agent";
import type { MessagePayloadV2 } from "@nautilo/lattice-bridge";

import { protectedAgentMessagePayload } from "../conversation/protected-conversation-executor-io";

export type ProtectedTaskTranscriptIdentity = Readonly<{
  taskId: string;
  taskRunId: string;
  graphThreadId: string;
  roomId: string;
  humanTurnId: string;
  agentId: string;
}>;

export type ProtectedTaskTranscriptMessagePublisher = (input: Readonly<{
  identity: ProtectedTaskTranscriptIdentity;
  idempotencyKey: string;
  fingerprint: string;
  payload: MessagePayloadV2;
  signal: AbortSignal;
}>) => Promise<void>;

function sameIdentity(
  expected: ProtectedTaskTranscriptIdentity,
  actual: ProtectedTaskTranscriptIdentity,
): boolean {
  return expected.taskId === actual.taskId
    && expected.taskRunId === actual.taskRunId
    && expected.graphThreadId === actual.graphThreadId
    && expected.roomId === actual.roomId
    && expected.humanTurnId === actual.humanTurnId
    && expected.agentId === actual.agentId;
}

function isTransientContext(message: BaseMessage): boolean {
  return (
    message.additional_kwargs as
      | { readonly nautilo_transient_context?: unknown }
      | undefined
  )?.nautilo_transient_context === true;
}

/**
 * Bind an exact Task segment to the Agent's transcript port. The publisher
 * must encrypt and durably map each payload before resolving; this adapter
 * does not retain plaintext or use the ordinary transcript writer.
 */
export function createProtectedTaskTranscriptPort(input: Readonly<{
  identity: ProtectedTaskTranscriptIdentity;
  signal: AbortSignal;
  publish: ProtectedTaskTranscriptMessagePublisher;
}>): Readonly<{
  quiesce(): Promise<Readonly<{ failedPublicationCount: number }>>;
  publishBatch(batch: Readonly<ProtectedTaskTranscriptIdentity & {
    messages: readonly BaseMessage[];
  }>): Promise<void>;
}> {
  const identity = Object.freeze({ ...input.identity });
  if (Object.values(identity).some((value) =>
    typeof value !== "string" || value.length === 0
  ) || !(input.signal instanceof AbortSignal)) {
    throw new TypeError("Protected Task transcript identity is invalid");
  }
  const active = new Set<Promise<void>>();
  let failedPublicationCount = 0;
  let closing: Promise<Readonly<{ failedPublicationCount: number }>> | null = null;
  return Object.freeze({
    quiesce() {
      closing ??= (async () => {
        await Promise.allSettled([...active]);
        return Object.freeze({ failedPublicationCount });
      })();
      return closing;
    },
    async publishBatch(batch) {
      if (closing !== null) {
        throw new Error("Protected Task transcript is closing");
      }
      // Register before calling the publisher, including reentrant callbacks.
      const messages = [...batch.messages];
      const batchIdentity = { ...batch, messages: undefined };
      const work = Promise.resolve().then(async () => {
        input.signal.throwIfAborted();
        if (!sameIdentity(identity, batchIdentity)) {
          throw new TypeError("Protected Task transcript identity changed");
        }
        for (const message of messages) {
          input.signal.throwIfAborted();
          if (isTransientContext(message)) continue;
          const fingerprint = computeMessageFingerprint(message);
          const payload = protectedAgentMessagePayload(message);
          await input.publish({
            identity,
            idempotencyKey: `task-transcript:${identity.taskRunId}:${fingerprint}`,
            fingerprint,
            payload,
            signal: input.signal,
          });
          input.signal.throwIfAborted();
        }
      });
      active.add(work);
      void work.then(
        () => active.delete(work),
        () => { active.delete(work); failedPublicationCount += 1; },
      );
      return work;
    },
  });
}
