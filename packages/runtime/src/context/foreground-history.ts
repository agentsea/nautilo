import type { BaseMessage } from "@langchain/core/messages";
import { RECENT_CONVERSATION_LIMIT_DEFAULT } from "@nautilo/db";
import { buildTranscriptContext, type BuildTranscriptContextDeps } from "./build-transcript-context";
import { defaultBuildTranscriptContextDeps } from "./build-transcript-context-deps";
import { getCurrentLiveShadowTurnContext, protectLiveShadowForegroundHistory, protectLiveShadowForegroundJournal } from "../conversation/live-shadow-turn-context";
import { recentConversationWindow, type RoomHistoryHit } from "../conductor/history-search";
import { imageAssistanceHistory } from "../executors/image-assistance";
import type { TurnKind } from "../executors/turn-kind";

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
}

function executionScopedHits(
  hits: readonly RoomHistoryHit[],
  scope: Extract<
    Parameters<BuildTranscriptContextDeps["readRoomTranscript"]>[0],
    { kind: "room" }
  >,
): RoomHistoryHit[] {
  if (
    scope.throughMessageIdInclusive === undefined
    || scope.excludeMessageId === undefined
    || scope.foregroundExecutionId === undefined
  ) return [...hits];
  return hits.filter((hit) =>
    hit.messageId < scope.excludeMessageId!
    || (
      hit.messageId > scope.excludeMessageId!
      && hit.foregroundExecutionId === scope.foregroundExecutionId
    ));
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
  const owned = depsOverride ? null : defaultBuildTranscriptContextDeps();
  const deps = depsOverride ?? owned;
  if (!deps) return [];
  const liveShadowContext = getCurrentLiveShadowTurnContext();
  const effectiveDeps: BuildTranscriptContextDeps =
    liveShadowContext?.session == null
      ? deps
      : {
        ...deps,
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
    readRoomTranscript: async (scope) => {
      let executionScoped: RoomHistoryHit[];
      if (
        liveShadowContext?.session != null
        && scope.throughMessageIdInclusive !== undefined
        && scope.excludeMessageId !== undefined
        && scope.foregroundExecutionId !== undefined
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
            fixedPrefix = await protectLiveShadowForegroundHistory(
              source.fixedPrefix,
              args.signal,
            );
            args.signal?.throwIfAborted();
          }
          const authorizedPage = await protectLiveShadowForegroundHistory(
            source.page,
            args.signal,
          );
          args.signal?.throwIfAborted();
          pages.unshift(...executionScopedHits(authorizedPage, scope));
          if (
            conversationalAnchorCount(pages) >= limit
            || source.page.length === 0
            || source.nextBefore === undefined
          ) break;
          before = source.nextBefore;
        }
        executionScoped = [
          ...fixedPrefix,
          ...recentConversationWindow(pages, limit),
        ];
      } else {
        executionScoped = executionScopedHits(
          await effectiveDeps.readRoomTranscript(scope),
          scope,
        );
      }
      args.onAuthorizedHistory?.(executionScoped);
      return imageAssistanceHistory(executionScoped);
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
