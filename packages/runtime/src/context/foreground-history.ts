import type { BaseMessage } from "@langchain/core/messages";
import { buildTranscriptContext, type BuildTranscriptContextDeps } from "./build-transcript-context";
import { defaultBuildTranscriptContextDeps } from "./build-transcript-context-deps";
import { getCurrentLiveShadowTurnContext, protectLiveShadowForegroundHistory, protectLiveShadowForegroundJournal } from "../conversation/live-shadow-turn-context";
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
      const hits = await effectiveDeps.readRoomTranscript(scope);
      const executionScoped =
        scope.throughMessageIdInclusive === undefined
        || scope.excludeMessageId === undefined
        || scope.foregroundExecutionId === undefined
          ? hits
          : hits.filter((hit) =>
              hit.messageId < scope.excludeMessageId!
              || (
                hit.messageId > scope.excludeMessageId!
                && hit.foregroundExecutionId === scope.foregroundExecutionId
              ));
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
