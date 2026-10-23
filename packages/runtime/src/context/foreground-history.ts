import type { BaseMessage } from "@langchain/core/messages";
import { readCurrentOrdinaryTranscriptExposureRows } from "@nautilo/agent";
import { RECENT_CONVERSATION_LIMIT_DEFAULT } from "@nautilo/db";
import { buildTranscriptContext, type BuildTranscriptContextDeps } from "./build-transcript-context";
import { defaultBuildTranscriptContextDeps } from "./build-transcript-context-deps";
import { getCurrentLiveShadowTurnContext, protectLiveShadowForegroundHistory, protectLiveShadowForegroundJournal } from "../conversation/live-shadow-turn-context";
import { recentConversationWindow, type RoomHistoryHit } from "../conductor/history-search";
import { assembleCompositeContextBlock } from "../conductor/context-block";
import { imageAssistanceHistory } from "../executors/image-assistance";
import type { TurnKind } from "../executors/turn-kind";
import { ordinaryTranscriptModelExposure } from "./ordinary-source-model-exposure";

export interface ForegroundHistoryOptions {
  roomId: string;
  transcriptOwnerId: string;
  agentId: string;
  modelId?: string;
  currentHumanText?: string;
  recordContext?: import("@nautilo/reflection/foreground").ForegroundRecordContextPort;
  signal?: AbortSignal;
  subthreadParentRoomId?: string;
  subthreadAnchorMessageId?: number;
  currentMessageId?: number;
  excludeMessageIds?: readonly number[];
  throughMessageIdInclusive?: number;
  foregroundExecutionId?: string;
  maximumContextCharacters?: number;
  imageAssistanceTurnId?: string;
  onAuthorizedHistory?: (hits: readonly import("../conductor/history-search").RoomHistoryHit[]) => void;
  acceptedHumanMessages?: readonly { messageId: number; message: BaseMessage }[];
}

function committedTimelineHits(
  hits: readonly RoomHistoryHit[],
  scope: Extract<
    Parameters<BuildTranscriptContextDeps["readRoomTranscript"]>[0],
    { kind: "room" }
  >,
): RoomHistoryHit[] {
  if (
    scope.throughMessageIdInclusive === undefined
    || scope.excludeMessageId === undefined
  ) return [...hits];
  const excluded = new Set([scope.excludeMessageId, ...(scope.excludeMessageIds ?? [])]);
  return hits.filter((hit) =>
    hit.messageId <= scope.throughMessageIdInclusive!
    && !excluded.has(hit.messageId));
}

function conversationalAnchorCount(hits: readonly RoomHistoryHit[]): number {
  return hits.reduce((count, hit) => count + (
    hit.role === "user"
    || (
      hit.role === "assistant"
      && typeof hit.snippet === "string"
      && hit.snippet.trim().length > 0
    )
      ? 1
      : 0
  ), 0);
}

function assertStrictSourcePage(
  page: readonly RoomHistoryHit[],
  nextBefore: Readonly<{ orderTimestamp: string; messageId: number }> | undefined,
  before: Readonly<{ orderTimestamp: string; messageId: number }> | undefined,
  fixedPrefixLength: number,
): void {
  if (before !== undefined && fixedPrefixLength > 0) {
    throw new Error("Protected foreground transcript pager repeated its fixed prefix");
  }
  for (let index = 1; index < page.length; index += 1) {
    const previous = page[index - 1]!;
    const current = page[index]!;
    if (
      previous.sourceOrderTimestamp === undefined
      || current.sourceOrderTimestamp === undefined
    ) {
      throw new Error("Protected foreground transcript page lacks exact ordering");
    }
    if (
      current.sourceOrderTimestamp < previous.sourceOrderTimestamp
      || (
        current.sourceOrderTimestamp === previous.sourceOrderTimestamp
        && current.messageId <= previous.messageId
      )
    ) {
      throw new Error("Protected foreground transcript page is not oldest-first");
    }
  }
  const first = page[0];
  if (first === undefined) {
    if (nextBefore !== undefined) {
      throw new Error("Protected foreground transcript pager returned an empty cursor");
    }
    return;
  }
  if (first.sourceOrderTimestamp === undefined) {
    throw new Error("Protected foreground transcript page lacks exact ordering");
  }
  if (nextBefore === undefined) return;
  if (
    nextBefore.orderTimestamp !== first.sourceOrderTimestamp
    || nextBefore.messageId !== first.messageId
  ) {
    throw new Error("Protected foreground transcript pager returned the wrong cursor");
  }
  if (
    before !== undefined
    && !(
      nextBefore.orderTimestamp < before.orderTimestamp
      || (
        nextBefore.orderTimestamp === before.orderTimestamp
        && nextBefore.messageId < before.messageId
      )
    )
  ) {
    throw new Error("Protected foreground transcript pager did not move backward");
  }
  const last = page.at(-1)!;
  if (before !== undefined && !(
    last.sourceOrderTimestamp! < before.orderTimestamp
    || (last.sourceOrderTimestamp === before.orderTimestamp && last.messageId < before.messageId)
  )) {
    throw new Error("Foreground transcript page overlaps its previous cursor");
  }
}

/** Ordinary ingress gate. Parked resumes do not reconstruct their checkpoint. */
export async function resolveForegroundHistoryMessages(
  args: ForegroundHistoryOptions & { turnKind: TurnKind },
  depsOverride?: BuildTranscriptContextDeps,
): Promise<BaseMessage[]> {
  if (args.turnKind !== "fresh" || !args.roomId) return [];
  return buildForegroundHistoryMessages(args, depsOverride);
}

/** Shared authorized projection for fresh ingress and a settled internal refresh. */
export async function buildForegroundHistoryMessages(
  args: ForegroundHistoryOptions,
  depsOverride?: BuildTranscriptContextDeps,
): Promise<BaseMessage[]> {
  if (!args.roomId) return [];
  if (args.throughMessageIdInclusive !== undefined && (
    args.maximumContextCharacters === undefined
    || !Number.isFinite(args.maximumContextCharacters)
    || args.maximumContextCharacters < 0
  )) throw new RangeError("Foreground refresh requires a finite nonnegative invocation allowance");
  const owned = depsOverride ? null : defaultBuildTranscriptContextDeps();
  const deps = depsOverride ?? owned;
  if (!deps) return [];
  const liveShadowContext = getCurrentLiveShadowTurnContext();
  const effectiveDeps: BuildTranscriptContextDeps =
    liveShadowContext?.session == null
      ? deps
      : {
        ...deps,
        readOrdinaryModelExposure: () => Promise.resolve(Object.freeze({ status: "incomplete" as const })),
        readRoomTranscript: async (scope) =>
          protectLiveShadowForegroundHistory(
            await deps.readRoomTranscript(scope),
            args.signal,
          ),
        ...(deps.readRoomJournal === undefined
          ? {}
          : {
              readRoomJournal: (scope) =>
                protectLiveShadowForegroundJournal(
                  () => deps.readRoomJournal!(scope),
                  args.signal,
                ),
            }),
      };
  const authorizedDeps: BuildTranscriptContextDeps = {
    ...effectiveDeps,
    ordinaryResultReferences: liveShadowContext?.session == null && depsOverride === undefined,
    ...(effectiveDeps.readOrdinaryModelExposure !== undefined
      ? {}
      : depsOverride === undefined && liveShadowContext?.session == null
        ? {
            readOrdinaryModelExposure: async (scope, hits) => scope.agentId === undefined
              ? Object.freeze({ status: "incomplete" as const })
              : ordinaryTranscriptModelExposure(await readCurrentOrdinaryTranscriptExposureRows({
                  ownerId: scope.ownerId,
                  agentId: scope.agentId,
                  roomIds: [scope.roomId, ...(scope.subthread ? [scope.subthread.parentRoomId] : [])],
                  messageIds: hits.map((hit) => hit.messageId),
                })),
          }
        : {}),
    readRoomTranscript: async (scope) => {
      let timeline: RoomHistoryHit[];
      if (
        scope.throughMessageIdInclusive !== undefined
        && scope.excludeMessageId !== undefined
        && (deps.readRoomTranscriptSourcePage !== undefined || liveShadowContext?.session != null)
      ) {
        const readPage = deps.readRoomTranscriptSourcePage?.bind(deps);
        if (readPage === undefined) {
          throw new Error(
            "Protected foreground refresh requires its authorized transcript pager",
          );
        }
        const limit = (await deps.readRoomContextPolicy?.())
          ?.recentConversationLimit ?? RECENT_CONVERSATION_LIMIT_DEFAULT;
        const pages: RoomHistoryHit[] = [];
        const currentEnvelope = args.maximumContextCharacters!;
        let currentCharacters = 0;
        const pendingAcceptedHumanMessageIds = new Set(
          (args.acceptedHumanMessages ?? [])
            .map((entry) => entry.messageId)
            .filter((messageId) =>
              messageId > scope.excludeMessageId!
              && messageId <= scope.throughMessageIdInclusive!),
        );
        let fixedPrefix: RoomHistoryHit[] = [];
        let before:
          | Readonly<{ orderTimestamp: string; messageId: number }>
          | undefined;
        while (true) {
          args.signal?.throwIfAborted();
          const source = await readPage(scope, before);
          args.signal?.throwIfAborted();
          assertStrictSourcePage(
            source.page,
            source.nextBefore,
            before,
            source.fixedPrefix.length,
          );
          if (before === undefined && source.fixedPrefix.length > 0) {
            fixedPrefix = liveShadowContext?.session != null
              ? await protectLiveShadowForegroundHistory(source.fixedPrefix, args.signal)
              : source.fixedPrefix;
            args.signal?.throwIfAborted();
          }
          const authorizedPage = liveShadowContext?.session != null
            ? await protectLiveShadowForegroundHistory(source.page, args.signal)
            : source.page;
          args.signal?.throwIfAborted();
          const admittedPage = committedTimelineHits(authorizedPage, scope);
          pages.unshift(...admittedPage);
          for (const hit of admittedPage) {
            if (hit.role === "user") pendingAcceptedHumanMessageIds.delete(hit.messageId);
            const countsTowardCurrentEnvelope =
              scope.foregroundExecutionId === undefined
                ? hit.messageId > scope.excludeMessageId
                : hit.messageId > scope.excludeMessageId
                  && hit.role !== "user"
                  && hit.foregroundExecutionId === scope.foregroundExecutionId
                  && (
                    scope.agentId === undefined
                    || hit.authorAgentId === undefined
                    || hit.authorAgentId === scope.agentId
                  );
            if (countsTowardCurrentEnvelope) {
              currentCharacters += (assembleCompositeContextBlock({ messages: [hit], maxLines: 1 })?.length ?? 0) + 1;
            }
          }
          const prior = pages.filter((hit) => hit.messageId < scope.excludeMessageId!);
          if (
            (
              currentCharacters >= currentEnvelope
              && pendingAcceptedHumanMessageIds.size === 0
            )
            || conversationalAnchorCount(prior) >= limit
            || source.page.length === 0
            || source.nextBefore === undefined
          ) break;
          before = source.nextBefore;
        }
        timeline = [
          ...fixedPrefix,
          ...recentConversationWindow(pages, limit, scope.excludeMessageId),
        ];
      } else {
        timeline = committedTimelineHits(
          await effectiveDeps.readRoomTranscript(scope),
          scope,
        );
      }
      args.onAuthorizedHistory?.(timeline);
      return imageAssistanceHistory(timeline);
    },
  };
  try {
    return await buildTranscriptContext(
      {
        ...(args.modelId ? { modelId: args.modelId } : {}),
        ...(args.maximumContextCharacters === undefined ? {} : { maximumContextCharacters: args.maximumContextCharacters }),
        ...(args.currentHumanText === undefined
          ? {}
          : { currentHumanText: args.currentHumanText }),
        ...(args.recordContext === undefined
          ? {}
          : { recordContext: args.recordContext }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
        ...(args.acceptedHumanMessages === undefined ? {} : { acceptedHumanMessages: args.acceptedHumanMessages }),
        scope: {
          kind: "room",
          roomId: args.roomId,
          ownerId: args.transcriptOwnerId,
          ...(args.imageAssistanceTurnId ? { imageAssistanceTurnId: args.imageAssistanceTurnId } : {}),
          ...(args.agentId ? { agentId: args.agentId } : {}),
          ...(args.currentMessageId != null ? { excludeMessageId: args.currentMessageId } : {}),
          ...(args.excludeMessageIds === undefined ? {} : { excludeMessageIds: args.excludeMessageIds }),
          ...(args.throughMessageIdInclusive === undefined ? {} : { throughMessageIdInclusive: args.throughMessageIdInclusive }),
          ...(args.foregroundExecutionId === undefined ? {} : { foregroundExecutionId: args.foregroundExecutionId }),
          ...(args.subthreadParentRoomId && args.subthreadAnchorMessageId != null
            ? {
                subthread: {
                  parentRoomId: args.subthreadParentRoomId,
                  anchorMessageId: args.subthreadAnchorMessageId,
                },
              }
            : {}),
        },
        // Verbatim first cut with no recency window or summarization.
        maxLines: Number.MAX_SAFE_INTEGER,
      },
      authorizedDeps,
    );
  } finally {
    if (owned) await owned.close();
  }
}
