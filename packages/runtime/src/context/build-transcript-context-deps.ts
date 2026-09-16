import {
  actors,
  and,
  asc,
  desc,
  eq,
  getServerContextConfig,
  getSharedDirectDb,
  isNotNull,
  notExists,
  RECENT_CONVERSATION_LIMIT_DEFAULT,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  roomEventRollups,
  roomEvents,
  roomJournalState,
  sql,
  type ResolvedServerContextConfig,
  type ServerContextConfigDb,
} from "@nautilo/db";
import {
  getRunAgentTranscript,
  getAgentDisplayNameById,
  getAgentHandleById,
} from "@nautilo/agent";
import { log } from "@nautilo/logger";
import {
  runAgentTranscriptToHits,
  type BuildTranscriptContextDeps,
  type TranscriptContextScope,
} from "./build-transcript-context";
import {
  parentMessagesUpToAnchor,
  recentBoundedRoomMessages,
  SUBTHREAD_PARENT_WINDOW,
  type RoomHistoryHit,
  type TypedRoomHistorySearchDb,
} from "../conductor/history-search";

/**
 * M169 (R1) — injectable lookups for {@link readSubagentRunTranscript} so it is
 * unit-testable without a live DB. Defaults bind the real `@nautilo/agent`
 * queries.
 */
export interface ReadSubagentRunTranscriptDeps {
  getRunAgentTranscript: typeof getRunAgentTranscript;
  getAgentDisplayNameById: (agentId: string) => Promise<string | null>;
  getAgentHandleById: (agentId: string) => Promise<string | null>;
}

const defaultReadSubagentRunTranscriptDeps: ReadSubagentRunTranscriptDeps = {
  getRunAgentTranscript,
  getAgentDisplayNameById,
  getAgentHandleById,
};

/**
 * M169 (R1) — the production subagent-run transcript reader for the builder's
 * `kind:"subagent"` scope. Reads the agent-authored run transcript
 * (`getRunAgentTranscript` — `assistant`/`tool` rows, M163), resolves the
 * Agent's label fields, and maps to `RoomHistoryHit[]` via the M166
 * `runAgentTranscriptToHits` helper.
 *
 * Labels (spec §4): display name is single-sourced on `profiles.name` (M156) →
 * COALESCE to **"Genie"** (the seed Agent has no Profile row), NOT "Agent".
 * `@handle` comes from `agents.handle`; a missing handle falls back to `""`
 * (the renderer emits `(@):` — never a raw agent id). Returns `[]` for a run
 * with no agent-authored rows.
 *
 * DORMANT in M169 (R2): wired into the deps-factory slot below but called by NO
 * production `buildTranscriptContext({ kind:"subagent" })` path in this issue —
 * Phase H (or a future fresh-continuation feature) is the first real caller.
 */
export async function readSubagentRunTranscript(
  scope: Extract<TranscriptContextScope, { kind: "subagent" }>,
  deps: ReadSubagentRunTranscriptDeps = defaultReadSubagentRunTranscriptDeps,
): Promise<RoomHistoryHit[]> {
  const rows = await deps.getRunAgentTranscript({
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    graphThreadId: scope.graphThreadId,
    // Both bounds are `Date | null` (null ⇒ unbounded); pass straight through.
    startedAt: scope.startedAt,
    completedAt: scope.completedAt,
  });
  if (rows.length === 0) return [];
  const displayName =
    (await deps.getAgentDisplayNameById(scope.agentId).catch(() => null)) ?? "Genie";
  const handle = (await deps.getAgentHandleById(scope.agentId).catch(() => null)) ?? "";
  return runAgentTranscriptToHits(rows, { displayName, handle });
}

/**
 * M168 — production `BuildTranscriptContextDeps` plus a `close()` hook for
 * lifecycle symmetry with the foreground executor's `finally`. Uses the
 * process-wide full-role `getSharedDirectDb()` pool when no db is injected;
 * `close()` is always a no-op (unit tests inject a fake db instead).
 */
export interface DefaultTranscriptContextDeps extends BuildTranscriptContextDeps {
  close(): Promise<void>;
}

/**
 * Constructs both transcript readers over the full-role shared direct pool
 * (`getSharedDirectDb()` — BYPASSRLS, same handle pattern dispatch uses for
 * `roomMessagesSince` et al.):
 *  - **room** (C + D — DM / group): the bounded labelled Room transcript
 *    (server-configured conversational rows plus intervening tools), with the
 *    current turn excluded by message ID/fingerprint.
 *  - **subthread** (E): parent up-to-anchor window (`parentMessagesUpToAnchor`)
 *    plus the same bounded child-Room transcript, concatenated oldest→newest.
 *  - **subagent** (M169, F): `readSubagentRunTranscript` — DORMANT (no
 *    production `buildTranscriptContext({kind:"subagent"})` caller yet); the
 *    M168 throw-stub is replaced now that F lands second per the coordination
 *    note. Uses its own `@nautilo/agent` queries (NOT the shared direct handle
 *    this factory reads through), so `close()` does not affect it.
 */
export function defaultBuildTranscriptContextDeps(
  /** Test seam: inject a fake `TypedRoomHistorySearchDb`. When omitted, production
   * reads through `getSharedDirectDb()`. `close()` is always a no-op. */
  dbOverride?: TypedRoomHistorySearchDb,
  options: {
    /** Test seam for the live server-wide context policy. */
    getRecentConversationLimit?: () => Promise<number>;
    getServerContextPolicy?: () => Promise<ResolvedServerContextConfig>;
  } = {},
): DefaultTranscriptContextDeps {
  const db = dbOverride ?? getSharedDirectDb();
  let policyPromise: Promise<ResolvedServerContextConfig> | null = null;
  const serverContextPolicy = async (): Promise<ResolvedServerContextConfig> => {
    if (options.getServerContextPolicy) return options.getServerContextPolicy();
    policyPromise ??= (async () => {
      if (!("select" in db) || typeof db.select !== "function") {
        return {
          recentConversationLimit: RECENT_CONVERSATION_LIMIT_DEFAULT,
          minimumFullTurns: 1,
          maxRoomContextPercent: 50,
          stenographerPriorConversationLimit: 10,
          passiveRecallEnabled: true,
          reflectionSleepEnabled: false,
          memoryReviewEnabled: null,
        };
      }
      return getServerContextConfig(db as TypedRoomHistorySearchDb & ServerContextConfigDb);
    })();
    return policyPromise;
  };
  const recentConversationLimit =
    options.getRecentConversationLimit ??
    (async (): Promise<number> =>
      (await serverContextPolicy()).recentConversationLimit);
  const resolveBotActorId = async (agentId?: string): Promise<string | undefined> => {
    if (!agentId) return undefined;
    const [actor] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.agentId, agentId), eq(actors.kind, "agent")))
      .limit(1);
    return actor?.id;
  };
  return {
    emitForegroundContextDiagnostic(diagnostic) {
      log(`[reflection-foreground-context] ${JSON.stringify(diagnostic)}`);
    },
    readRoomContextPolicy: serverContextPolicy,
    async readRoomTranscript(scope) {
      const botActorId = await resolveBotActorId(scope.agentId);
      if (scope.subthread) {
        const parent =
          scope.subthread.anchorMessageId != null
            ? await parentMessagesUpToAnchor(db, {
                parentRoomId: scope.subthread.parentRoomId,
                anchorMessageId: scope.subthread.anchorMessageId,
                limit: SUBTHREAD_PARENT_WINDOW,
              })
            : [];
        const sub = await recentBoundedRoomMessages(db, {
          roomId: scope.roomId,
          conversationalLimit: await recentConversationLimit(),
          userId: scope.ownerId,
          ...(scope.agentId ? { agentId: scope.agentId } : {}),
          ...(botActorId ? { botActorId } : {}),
          ...(scope.excludeMessageId != null
            ? { excludeMessageId: scope.excludeMessageId }
            : {}),
        });
        return [...parent, ...sub];
      }
      return recentBoundedRoomMessages(db, {
        roomId: scope.roomId,
        conversationalLimit: await recentConversationLimit(),
        userId: scope.ownerId,
        ...(scope.agentId ? { agentId: scope.agentId } : {}),
        ...(botActorId ? { botActorId } : {}),
        ...(scope.excludeMessageId != null ? { excludeMessageId: scope.excludeMessageId } : {}),
      });
    },
    async readRoomJournal(scope) {
      const [state] = await db
        .select({ rebuildRequestedAt: roomJournalState.rebuildRequestedAt })
        .from(roomJournalState)
        .where(eq(roomJournalState.roomId, scope.roomId));
      // M230 — fail closed while an edit-triggered full rebuild is pending.
      if (state?.rebuildRequestedAt != null) {
        return { rollup: null, events: [] };
      }
      const rebuildNotPending = () =>
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(roomJournalState)
            .where(
              and(
                eq(roomJournalState.roomId, scope.roomId),
                isNotNull(roomJournalState.rebuildRequestedAt),
              ),
            ),
        );
      const [rollupRow] = await db
        .select({
          throughEventSequence: roomEventRollups.throughEventSequence,
          content: roomEventRollups.content,
        })
        .from(roomEventRollups)
        .where(
          and(eq(roomEventRollups.roomId, scope.roomId), rebuildNotPending()),
        )
        .orderBy(
          desc(roomEventRollups.throughEventSequence),
          desc(roomEventRollups.createdAt),
        )
        .limit(1);
      if (rollupRow?.content === null) {
        throw new Error("Room Journal ordinary rollup is unavailable");
      }
      const through = rollupRow?.throughEventSequence ?? 0;
      const eventRows = await db
        .select({
          id: roomEvents.id,
          roomId: roomEvents.roomId,
          sequence: roomEvents.sequence,
          kind: roomEvents.kind,
          statement: sql<string>`CASE
            WHEN ${roomEvents.projectionKind} = 'legacy'
              THEN ${roomEvents.statement}
            ELSE convert_from(
              ${reflectionRecordPayloadRepresentations.plaintextPayloadBytes},
              'UTF8'
            )::jsonb->>'statement'
          END`.as("statement"),
          status: roomEvents.status,
          supersedesEventId: roomEvents.supersedesEventId,
          resolvesEventId: roomEvents.resolvesEventId,
        })
        .from(roomEvents)
        .leftJoin(
          reflectionRecordPayloadRepresentationHeads,
          and(
            eq(roomEvents.projectionKind, "native"),
            eq(
              reflectionRecordPayloadRepresentationHeads.recordId,
              roomEvents.recordId,
            ),
            eq(
              reflectionRecordPayloadRepresentationHeads.representation,
              "ordinary",
            ),
          ),
        )
        .leftJoin(
          reflectionRecordPayloadRepresentations,
          and(
            eq(
              reflectionRecordPayloadRepresentations.recordId,
              reflectionRecordPayloadRepresentationHeads.recordId,
            ),
            eq(
              reflectionRecordPayloadRepresentations.representation,
              reflectionRecordPayloadRepresentationHeads.representation,
            ),
            eq(
              reflectionRecordPayloadRepresentations.representationGeneration,
              reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
            ),
          ),
        )
        .where(
          and(
            eq(roomEvents.roomId, scope.roomId),
            eq(roomEvents.status, "active"),
            sql`${roomEvents.sequence} > ${through}`,
            rebuildNotPending(),
          ),
        )
        .orderBy(asc(roomEvents.sequence));
      const events = eventRows.map((row) => ({
        id: row.id,
        roomId: row.roomId,
        sequence: row.sequence,
        kind: row.kind,
        statement: row.statement,
        status: row.status,
        supersedesEventId: row.supersedesEventId,
        resolvesEventId: row.resolvesEventId,
      }));
      return {
        rollup: rollupRow
          ? {
              throughEventSequence: through,
              content: rollupRow.content,
            }
          : null,
        events,
      };
    },
    readSubagentTranscript(scope) {
      return readSubagentRunTranscript(scope);
    },
    close: () => Promise.resolve(),
  };
}
