import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { acceptedForegroundMessages } from "@nautilo/agent";
export { acceptedForegroundMessages } from "@nautilo/agent";
import { estimateTokenCount, type RebuildForegroundContext } from "@nautilo/agent";
import type { ForegroundRecordContextPort } from "@nautilo/reflection/foreground";
import { getContentAsString } from "@nautilo/message-invariants";
import { RECENT_CONVERSATION_LIMIT_DEFAULT, type ResolvedServerContextConfig } from "@nautilo/db";
import { buildForegroundHistoryMessages } from "../context/foreground-history";
import { buildProtectedRoomHybridContext } from "../context/build-transcript-context";
import type { ProtectedConversationExecutorTurnScope } from "../conversation/conversation-execution-services";
import type { RoomHistoryHit } from "../conductor/history-search";
import { imageAssistanceHistory } from "./image-assistance";
import { defaultBuildTranscriptContextDeps } from "../context/build-transcript-context-deps";

async function readRoomContextPolicy(): Promise<ResolvedServerContextConfig | undefined> {
  const deps = defaultBuildTranscriptContextDeps();
  try { return await deps.readRoomContextPolicy?.(); }
  finally { await deps.close(); }
}

/** Only committed row receipts advance this execution's history read fence. */
export class ForegroundContextReceipts {
  triggerMessageId: number | undefined;
  throughMessageIdInclusive: number | undefined;
  readonly #humanMessageIds = new WeakMap<BaseMessage, number>();
  readonly #humanMessageIdsByCheckpointId = new Map<string, number>();

  constructor(triggerMessageId?: number, private readonly captureTrigger = true) {
    this.triggerMessageId = triggerMessageId;
    this.throughMessageIdInclusive = triggerMessageId;
  }

  readonly recordIds = (ids: readonly number[]): void => {
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid committed transcript coordinate");
      this.throughMessageIdInclusive = Math.max(this.throughMessageIdInclusive ?? id, id);
    }
  };

  readonly recordRows = (rows: readonly { id: string; role: string }[]): void => {
    this.recordIds(rows.map((row) => Number(row.id)));
    if (this.captureTrigger && this.triggerMessageId === undefined) {
      const human = rows.find((row) => row.role === "user");
      if (human) this.triggerMessageId = Number(human.id);
    }
  };

  readonly recordMessages = (
    rows: readonly { id: string; role: string }[],
    messages: readonly BaseMessage[],
  ): void => {
    if (rows.length !== messages.length) {
      throw new Error("Committed transcript receipts do not align with their messages");
    }
    this.recordRows(rows);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const message = messages[index]!;
      if (row.role !== "user" || !HumanMessage.isInstance(message)) continue;
      const messageId = Number(row.id);
      this.#humanMessageIds.set(message, messageId);
      if (message.id) this.#humanMessageIdsByCheckpointId.set(message.id, messageId);
    }
  };

  readonly acceptedMessageCoordinates = (
    acceptedMessages: readonly BaseMessage[],
    prior: readonly Readonly<{
      acceptedMessageIndex: number;
      messageId: number;
    }>[] = [],
  ): readonly Readonly<{ acceptedMessageIndex: number; messageId: number }>[] => {
    const byIndex = new Map<number, number>();
    const usedMessageIds = new Set<number>();
    for (const coordinate of prior) {
      if (
        !Number.isSafeInteger(coordinate.acceptedMessageIndex)
        || coordinate.acceptedMessageIndex < 0
        || coordinate.acceptedMessageIndex >= acceptedMessages.length
        || !Number.isSafeInteger(coordinate.messageId)
        || coordinate.messageId < 1
        || byIndex.has(coordinate.acceptedMessageIndex)
        || usedMessageIds.has(coordinate.messageId)
      ) continue;
      byIndex.set(coordinate.acceptedMessageIndex, coordinate.messageId);
      usedMessageIds.add(coordinate.messageId);
    }
    for (let index = 0; index < acceptedMessages.length; index += 1) {
      if (byIndex.has(index)) continue;
      const acceptedMessage = acceptedMessages[index]!;
      const messageId = this.#humanMessageIds.get(acceptedMessage)
        ?? (acceptedMessage.id
          ? this.#humanMessageIdsByCheckpointId.get(acceptedMessage.id)
          : undefined);
      if (messageId !== undefined && !usedMessageIds.has(messageId)) {
        byIndex.set(index, messageId);
        usedMessageIds.add(messageId);
      }
    }
    return [...byIndex]
      .sort(([left], [right]) => left - right)
      .map(([acceptedMessageIndex, messageId]) => ({ acceptedMessageIndex, messageId }));
  };
}

/**
 * A settled segment normally re-enters through its committed transcript rows.
 * A parked segment has no request-local receipt on the later resume, so retain
 * its exact live sequence after the last transient narrative block instead of
 * guessing a newer database cut or re-persisting the accepted Human reply.
 */
function sameCheckpointMessage(left: BaseMessage, right: BaseMessage): boolean {
  if (left === right) return true;
  return left.constructor.name === right.constructor.name
    && left.id === right.id
    && left.name === right.name
    && JSON.stringify(left.content) === JSON.stringify(right.content)
    && JSON.stringify(left.additional_kwargs) === JSON.stringify(right.additional_kwargs)
    && JSON.stringify(left.response_metadata) === JSON.stringify(right.response_metadata);
}

function liveSegmentForRebuild(
  messages: readonly BaseMessage[],
  acceptedSource: readonly BaseMessage[],
): Readonly<{
  messages: BaseMessage[];
  narrativeInsertionIndex: number;
}> {
  let selected: readonly BaseMessage[] | undefined;
  if (acceptedSource.length > 0 && acceptedSource.length <= messages.length) {
    for (let start = 0; start < messages.length; start += 1) {
      if (!sameCheckpointMessage(acceptedSource[0]!, messages[start]!)) continue;
      let cursor = start + 1;
      let sourceIndex = 1;
      while (sourceIndex < acceptedSource.length && cursor < messages.length) {
        if (sameCheckpointMessage(acceptedSource[sourceIndex]!, messages[cursor]!)) {
          sourceIndex += 1;
        }
        cursor += 1;
      }
      if (sourceIndex === acceptedSource.length) {
        selected = messages.slice(start);
        break;
      }
    }
  }
  if (selected === undefined) {
    let narrativeEnd = -1;
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]!.additional_kwargs["nautilo_transient_context"] === true) {
        narrativeEnd = index;
      }
    }
    selected = messages.slice(narrativeEnd + 1);
  }
  const live: BaseMessage[] = [];
  let narrativeInsertionIndex: number | undefined;
  for (const message of selected) {
    if (message.additional_kwargs["nautilo_room_context_budgeted"] === true) {
      narrativeInsertionIndex ??= live.length;
      continue;
    }
    live.push(message);
  }
  return {
    messages: live,
    narrativeInsertionIndex: narrativeInsertionIndex ?? 0,
  };
}

export function createForegroundContextRebuilder(input: Readonly<{
  roomId: string;
  ownerId: string;
  agentId: string;
  receipts: ForegroundContextReceipts;
  protectedTurn?: ProtectedConversationExecutorTurnScope;
  recordContext?: ForegroundRecordContextPort;
  onAuthorizedHistory?: (hits: readonly RoomHistoryHit[]) => void;
}>, deps: Readonly<{
  readHistory: typeof buildForegroundHistoryMessages;
  readRoomContextPolicy?: () => Promise<ResolvedServerContextConfig | undefined>;
}> = { readHistory: buildForegroundHistoryMessages, readRoomContextPolicy }): RebuildForegroundContext {
  return async ({ state, request, signal }) => {
    signal?.throwIfAborted();
    const source = state.foregroundContextRefreshSource;
    const trigger = input.receipts.triggerMessageId ?? source?.triggerMessageId;
    const receiptCut = input.receipts.throughMessageIdInclusive;
    const sourceCut = source?.throughMessageIdInclusive;
    const through = receiptCut === undefined
      ? sourceCut
      : sourceCut === undefined
        ? receiptCut
        : Math.max(receiptCut, sourceCut);
    if (!source || trigger === undefined || through === undefined || through < trigger) {
      throw new Error("Cannot refresh foreground context without its committed transcript boundary");
    }
    const accepted = acceptedForegroundMessages(source.acceptedMessages, state.messages);
    const cutAdvanced = receiptCut !== undefined
      && (sourceCut === undefined || receiptCut > sourceCut);
    const acceptedMessageCoordinates = input.receipts.acceptedMessageCoordinates(
      accepted,
      source.acceptedMessageCoordinates,
    );
    const coordinatedPostTrigger = cutAdvanced
      ? acceptedMessageCoordinates.filter((coordinate) => coordinate.messageId > trigger)
      : [];
    const coordinatedAcceptedIndexes = new Set(
      coordinatedPostTrigger.map((coordinate) => coordinate.acceptedMessageIndex),
    );
    const acceptedPrefix = accepted.filter(
      (_message, index) => !coordinatedAcceptedIndexes.has(index),
    );
    const acceptedHumanMessages = coordinatedPostTrigger.map((coordinate) => ({
      messageId: coordinate.messageId,
      message: accepted[coordinate.acceptedMessageIndex]!,
    }));
    // Keep authorized steering rows as chronology anchors. The renderer
    // replaces each row with its exact accepted Human message once.
    const anchoredHumanIds = new Set(acceptedHumanMessages.map((entry) => entry.messageId));
    const excludeMessageIds = source.acceptedMessageIds?.filter((id) => !anchoredHumanIds.has(id));
    const retained = cutAdvanced
      ? { messages: [], narrativeInsertionIndex: 0 }
      : liveSegmentForRebuild(state.messages, source.acceptedMessages);
    const retainedLiveSegment = retained.messages;
    const retainedMessages = retainedLiveSegment.filter(
      (message) => !HumanMessage.isInstance(message),
    );
    const narrativeMaximumCharacters = Math.max(
      0,
      request.maximumContextCharacters
        - Math.max(
          0,
          estimateTokenCount(retainedMessages)
            - estimateTokenCount(source.retainedMessages ?? []),
        ) * 4,
    );
    const currentHumanText = accepted.map((message) => getContentAsString(message.content)).join("\n");
    let history: BaseMessage[];
    if (input.protectedTurn !== undefined) {
      const roomPolicy = await deps.readRoomContextPolicy?.();
      const result = await input.protectedTurn.readFreshHistory({
        throughMessageIdInclusive: through,
        maximumContextCharacters: narrativeMaximumCharacters,
        recentConversationLimit: roomPolicy?.recentConversationLimit ?? RECENT_CONVERSATION_LIMIT_DEFAULT,
        excludeMessageId: trigger,
        ...(excludeMessageIds === undefined ? {} : { excludeMessageIds }),
        ...(source.executionId === undefined
          ? {}
          : { foregroundExecutionId: source.executionId }),
        ...(acceptedHumanMessages.length === 0
          ? {}
          : { acceptedHumanMessageIds: acceptedHumanMessages.map((entry) => entry.messageId) }),
        execute: async (hits) => {
          const rebuilt = await buildProtectedRoomHybridContext({
            hits: imageAssistanceHistory(hits),
            journal: input.protectedTurn?.journal ?? { rollup: null, events: [] },
            currentHumanText,
            modelId: request.modelId,
            maximumContextCharacters: narrativeMaximumCharacters,
            ...(roomPolicy === undefined ? {} : { roomPolicy }),
            activeTurnAfterMessageId: trigger,
            foregroundAgentId: input.agentId,
            ...(acceptedHumanMessages.length === 0 ? {} : { acceptedHumanMessages }),
            ...(source.executionId === undefined ? {} : { foregroundExecutionId: source.executionId }),
            ...(input.recordContext === undefined ? {} : { recordContext: input.recordContext }),
            ...(signal === undefined ? {} : { signal }),
          });
          input.onAuthorizedHistory?.(hits);
          return rebuilt;
        },
      });
      if (result.status !== "executed") throw new Error("Authorized foreground history refresh is unavailable");
      history = result.value;
    } else {
      history = await deps.readHistory({
        roomId: input.roomId,
        transcriptOwnerId: input.ownerId,
        agentId: input.agentId,
        modelId: request.modelId,
        currentHumanText,
        currentMessageId: trigger,
        ...(excludeMessageIds === undefined ? {} : { excludeMessageIds }),
        throughMessageIdInclusive: through,
        ...(acceptedHumanMessages.length === 0 ? {} : { acceptedHumanMessages }),
        ...(source.executionId === undefined
          ? {}
          : { foregroundExecutionId: source.executionId }),
        maximumContextCharacters: narrativeMaximumCharacters,
        ...(input.onAuthorizedHistory === undefined
          ? {}
          : { onAuthorizedHistory: input.onAuthorizedHistory }),
        ...(source.subthreadParentRoomId ? { subthreadParentRoomId: source.subthreadParentRoomId } : {}),
        ...(source.subthreadAnchorMessageId === undefined ? {} : { subthreadAnchorMessageId: source.subthreadAnchorMessageId }),
        ...(input.recordContext === undefined ? {} : { recordContext: input.recordContext }),
        ...(signal === undefined ? {} : { signal }),
      });
    }
    signal?.throwIfAborted();
    const {
      retainedMessages: _previousRetained,
      acceptedMessageCoordinates: _previousCoordinates,
      ...sourceWithoutRetained
    } = source;
    const nextSource = {
      ...sourceWithoutRetained,
      acceptedMessages: accepted,
      ...(acceptedMessageCoordinates.length === 0
        ? {}
        : { acceptedMessageCoordinates }),
      triggerMessageId: trigger,
      throughMessageIdInclusive: through,
      ...(retainedLiveSegment.length === 0
        ? {}
        : {
            retainedMessages,
          }),
    };
    if (retainedLiveSegment.length > 0) {
      // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- this replaces one transient narrative inside the graph's already-validated exact live protocol sequence.
      const messages = [
        ...retainedLiveSegment.slice(0, retained.narrativeInsertionIndex),
        ...history,
        ...retainedLiveSegment.slice(retained.narrativeInsertionIndex),
      ];
      return {
        // Exact order is load-bearing for a parked question and its reply.
        messages,
        source: nextSource,
      };
    }
    return {
      // Durable progress must follow the accepted request. Appending the
      // request after its narrated results makes it look newly issued at each
      // segment boundary and can restart already-completed work.
      // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- accepted Human context and narrative contain no tool-call protocol messages.
      messages: acceptedPrefix.concat(history),
      source: nextSource,
    };
  };
}
