import { parseImageAssistanceSummary } from "@nautilo/types";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ServerEvent } from "@nautilo/types";

import type {
  LiveShadowAgentRuntimeTurn,
} from "./live-shadow-agent-runtime";
import type { LiveShadowAgentPublishedMessage } from
  "@nautilo/lattice-bridge/server";

export type LiveShadowStreamState = Readonly<{
  ordinals: Map<string, number>;
}>;

/** Certified Task signers publish only through durable V5 records because the
 * realtime V2 transport cannot carry their signer certificate. */
export function filterDurableOnlyLiveShadowEvents(
  events: readonly ServerEvent[],
  durableOnly: boolean,
): readonly ServerEvent[] {
  if (!durableOnly || events.every(event => event.type !== "message.tokens")) {
    return events;
  }
  return Object.freeze(events.filter(event => event.type !== "message.tokens"));
}

/**
 * Frame one assistant token through the canonical Runtime turn owner. A false
 * `handled` result is already an authorized fallback decision from that owner;
 * this adapter never reclassifies a crypto/publication failure itself.
 */
export async function protectLiveShadowAssistantToken(input: Readonly<{
  runtime: LiveShadowAgentRuntimeTurn;
  operationId: string;
  laneKey: string;
  state: LiveShadowStreamState;
  event: ServerEvent;
  messagesToPersist: readonly BaseMessage[];
  foregroundExecutionId?: string;
  durableOnly?: true;
}>): Promise<Readonly<{
  events: readonly ServerEvent[];
  handled: boolean;
}>> {
  const event = input.event;
  if (filterDurableOnlyLiveShadowEvents(
    [event],
    input.durableOnly === true,
  ).length === 0) {
    return Object.freeze({ events: Object.freeze([]), handled: true });
  }
  const full = input.runtime.representationMode === "full_encryption";
  if (
    event.type !== "message.tokens"
    || "protection" in event
    || event.assistantMessageKey === undefined
  ) return Object.freeze({ events: Object.freeze([]), handled: false });

  const protectedEvents: ServerEvent[] = [];
  let reserved = input.state.ordinals.has(event.assistantMessageKey);
  if (!reserved) {
    const start = await input.runtime.reserveAssistantStream({
      assistantMessageKey: event.assistantMessageKey,
      createdAt: Date.now(),
    });
    if (start !== null) {
      input.state.ordinals.set(
        event.assistantMessageKey,
        start.reservation.transcriptOrdinal,
      );
      reserved = true;
      protectedEvents.push(input.runtime.sharedAgentPlanBytesBase64url === null
        ? {
            wireVersion: full ? 2 : 1,
            type: "message.shadow_stream_start",
            laneKey: input.laneKey,
            operationId: input.operationId,
            transcriptOrdinal: start.reservation.transcriptOrdinal,
            streamStartBytesBase64url:
              Buffer.from(start.startBytes).toString("base64url"),
          }
        : {
            wireVersion: full ? 2 : 1,
            type: "message.shared_agent_stream_start",
            laneKey: input.laneKey,
            operationId: input.operationId,
            transcriptOrdinal: start.reservation.transcriptOrdinal,
            planBytesBase64url:
              input.runtime.sharedAgentPlanBytesBase64url,
            streamStartBytesBase64url:
              Buffer.from(start.startBytes).toString("base64url"),
          });
      start.startBytes.fill(0);
    }
  }
  if (!reserved) {
    return Object.freeze({
      events: Object.freeze(protectedEvents),
      handled: false,
    });
  }
  const finalMessage = event.done
    ? input.messagesToPersist.find((message) => AIMessage.isInstance(message))
    : undefined;
  const ordinaryChunk = new TextEncoder().encode(event.content);
  const frame = await input.runtime.sealAssistantStreamChunk({
    assistantMessageKey: event.assistantMessageKey,
    ordinaryChunk,
    done: event.done,
    ...(finalMessage === undefined ? {} : { finalMessage }),
    ...(input.foregroundExecutionId === undefined
      ? {}
      : { foregroundExecutionId: input.foregroundExecutionId }),
  });
  ordinaryChunk.fill(0);
  if (frame === null) {
    return Object.freeze({
      events: Object.freeze(protectedEvents),
      handled: false,
    });
  }
  const frameEvent = {
    type: input.runtime.sharedAgentPlanBytesBase64url === null
      ? "message.shadow_stream_frame" as const
      : "message.shared_agent_stream_frame" as const,
    laneKey: input.laneKey,
    operationId: input.operationId,
    transcriptOrdinal: input.state.ordinals.get(event.assistantMessageKey)!,
    frameBytesBase64url: Buffer.from(frame.frameBytes).toString("base64url"),
    done: frame.terminal,
  };
  protectedEvents.push(full
    ? { ...frameEvent, wireVersion: 2 }
    : { ...frameEvent, wireVersion: 1, ordinaryChunk: event.content });
  frame.frameBytes.fill(0);
  return Object.freeze({
    events: Object.freeze(protectedEvents),
    handled: true,
  });
}

/** Project one already-committed protected receipt onto the established
 * realtime wire. Callers remain responsible for audience and Room authority. */
export function projectLiveShadowPublishedMessageEvent(input: Readonly<{
  message: LiveShadowAgentPublishedMessage;
  representationMode: "shadow_encryption" | "full_encryption";
  sharedAgentPlanBytesBase64url: string | null;
  operationId: string;
  laneKey: string;
}>): ServerEvent {
  const messageRepresentation = input.message.representationMode
    ?? "shadow_encryption";
  if (messageRepresentation !== input.representationMode) {
    throw new Error(
      "Agent durable evidence representation disagrees with transport policy",
    );
  }
  const common = {
    laneKey: input.laneKey,
    operationId: input.operationId,
    policyRevision: input.message.policyRevision,
    transcriptOrdinal: input.message.reservation.transcriptOrdinal,
    protectedMessage: input.message.protectedMessage,
    durableEventDigestBase64url:
      Buffer.from(input.message.durableEventDigest).toString("base64url"),
  };
  const protectedEvent = input.sharedAgentPlanBytesBase64url === null
    ? { ...common, type: "message.shadow_durable" as const }
    : {
      ...common,
      type: "message.shared_agent_output_shadow" as const,
      planBytesBase64url: input.sharedAgentPlanBytesBase64url,
    };
  return input.representationMode === "full_encryption"
    ? { ...protectedEvent, wireVersion: 2 as const }
    : {
      ...protectedEvent,
      wireVersion: 1 as const,
      ordinaryPayloadBytesBase64url:
        Buffer.from(input.message.ordinaryPayloadBytes).toString("base64url"),
    };
}

/** Frame one canonical Runtime publication batch. `publishMessages` owns policy,
 * exact receipts and fallback classification; never retry it after rejection. */
export async function publishLiveShadowRuntimeMessages(input: Readonly<{
  runtime: LiveShadowAgentRuntimeTurn;
  operationId: string;
  laneKey: string;
  agentId: string;
  messages: readonly BaseMessage[];
  foregroundExecutionId?: string;
  persistOrdinary(messages: readonly BaseMessage[]): Promise<void>;
  onCommittedMessageIds?: (ids: readonly number[]) => void;
  warn(message: string): void;
}>): Promise<readonly ServerEvent[]> {
  const batch = await input.runtime.publishMessages(
    input.messages,
    input.foregroundExecutionId,
  );
  const full = input.runtime.representationMode === "full_encryption";
  const events: ServerEvent[] = batch.protectedMessages.map((message) =>
    projectLiveShadowPublishedMessageEvent({
      message,
      representationMode: input.runtime.representationMode,
      sharedAgentPlanBytesBase64url:
        input.runtime.sharedAgentPlanBytesBase64url,
      operationId: input.operationId,
      laneKey: input.laneKey,
    })
  );
  input.onCommittedMessageIds?.(batch.protectedMessages.map((message) => message.reservation.messageId));
  if (batch.status !== "ordinary_fallback") return Object.freeze(events);
  if (full) throw new Error("Full encryption cannot publish ordinary fallback output");
  input.warn(
    `[live-shadow] Agent publication downgraded at ${
      batch.failureStage ?? "durable_transcript"
    }: ${batch.failureReason ?? "protected_unavailable"}`,
  );
  input.onCommittedMessageIds?.(batch.ordinaryPublications.map((publication) => publication.reservation.messageId));
  for (const publication of batch.ordinaryPublications) {
    if (publication.payload.role !== "assistant") continue;
    events.push({
      type: "message.new",
      laneKey: input.laneKey,
      messageId: String(publication.reservation.messageId),
      ...(publication.createdAt ? { createdAt: publication.createdAt } : {}),
      role: "ai",
      content: publication.payload.content,
      ...(() => {
        const imageAssistance = parseImageAssistanceSummary(publication.payload.sensitiveMetadata?.["imageAssistance"]);
        return imageAssistance ? { imageAssistance } : {};
      })(),
      ...(input.agentId ? { authorAgentId: input.agentId } : {}),
      ...(publication.assistantMessageKey === null
        ? {}
        : { assistantMessageKey: publication.assistantMessageKey }),
    });
  }
  if (batch.ordinaryMessages.length > 0) {
    await input.persistOrdinary(batch.ordinaryMessages);
  }
  return Object.freeze(events);
}
