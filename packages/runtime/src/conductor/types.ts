import type { ActiveFocus, SilenceKind } from "@nautilo/trust";

/**
 * D421 Phase 4.3 — canonical per-bot wakeability predicate. A bot is
 * wakeable for a group-room human turn iff it is an agent, not permanently
 * `observe`-muted, and not covered by an active transient silence window
 * (room-wide `botActorId === null` or per-bot). This is the single source of
 * truth reused by the conductor hard-filter, the Floor Manager wake set, and
 * the Phase 4.3 redirect-target revalidation (so a target that was muted
 * between the source wake and the redirect completion is rejected by the
 * server, never by the untrusted tool).
 *
 * `deaf` vs `mute` is intentionally NOT distinguished here: any active window
 * excludes the bot from waking. (`deaf` only matters for history ingestion,
 * not candidate filtering.)
 */
export function isAgentWakeable(
  member: RoomMemberView,
  windows: ReadonlyArray<{ botActorId: string | null; kind: SilenceKind }>,
): boolean {
  if (member.kind !== "agent") return false;
  if (member.agentResponseMode === "observe") return false;
  if (
    windows.some(
      (w) => w.botActorId === null || w.botActorId === member.actorId,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * D421 Phase 4.3 — convenience: filter a roster down to wakeable agent
 * members. Reused by the conductor hard-filter and the redirect-target
 * revalidation so the two paths cannot drift on the observe/mute/deaf rules.
 */
export function filterWakeableAgents(
  members: ReadonlyArray<RoomMemberView>,
  windows: ReadonlyArray<{ botActorId: string | null; kind: SilenceKind }>,
): RoomMemberView[] {
  return members.filter((m) => isAgentWakeable(m, windows));
}
import type { RoomHistoryHit } from "./history-search";
import type { RoutingPacket } from "./routing-packet";
import type { RoutingView } from "./routing-view";

/**
 * M134 Phase 2 — Room Conductor decision types.
 *
 * The Conductor is transient runtime code (non-matrix) that decides, for one
 * inbound user message in a GROUP room, which bots (0..N) to wake. DMs
 * (exactly 1 human + 1 agent) never reach the Conductor — they keep the
 * legacy "every message wakes the bot" path.
 */
export type ConductorSource = "mention" | "reply" | "ui" | "inferred";

/** A Human directly addressed the selected Agent; only inference is implicit. */
export function isExplicitConductorSource(source: ConductorSource): boolean {
  return source !== "inferred";
}

/**
 * D426 Phase 2 — first-natural-reply root Genie affinity for a Subthread.
 * This resolver only returns a value when the currently persisted child
 * message is the first visible child reply. `botActorId: null` then means the
 * anchor was human-authored (no root Genie affinity to apply).
 */
export interface SubthreadRootAffinity {
  botActorId: string | null;
  /** True when the root Genie is an eligible agent member of the parent Room. */
  available: boolean;
}

export type ConductorDecision =
  | {
      kind: "wake";
      botActorIds: string[];
      source: ConductorSource;
      writeFocus: boolean;
      reason: string;
    }
  | {
      kind: "ask_user";
      options: { botActorId: string; handle: string }[];
      reason: string;
    }
  | { kind: "silent"; reason: string };

export interface RoomMemberView {
  kind: "user" | "agent";
  actorId: string;
  /** `agents.id` for agent members; undefined for humans. */
  agentId?: string;
  handle: string;
  /** Agent or human display name when supplied by the caller. */
  displayName?: string;
  /**
   * D318/D302 — owner identity for an agent member, so the Floor Manager prompt
   * can disambiguate same-named agents by owner (e.g. "Casey's Genie" vs
   * "Alex's Jeannie"). Mirrors the D300 `RoomMemberDto` owner fields.
   */
  agentOwnerDisplayName?: string | null;
  agentOwnerHandle?: string | null;
  /**
   * active | mention_only | observe (observe surfaced as "mute"). Only set on
   * agent members; NULL/undefined for humans (and treated as `active` default
   * for agents with no stored row).
   */
  agentResponseMode?: "active" | "mention_only" | "observe" | null;
}

export interface ConductorMessage {
  content: string;
  /** Persisted source row id for this inbound human message; excluded from history evidence. */
  sourceMessageId?: number | null;
  /** D302 P7 — same-sender burst metadata for FM prompt and trace. */
  burstHint?: {
    count: number;
    coveredMessageIds?: Array<number | null>;
  };
  replyToMessageId?: number | null;
  uiSelectedBotActorId?: string | null;
  /**
   * M135 P7 — explicit UI "search room history" signal. When true the
   * Conductor consults `searchRoomHistory` regardless of reply structure.
   * Optional; defaults to false (conservative, language-agnostic gating).
   */
  searchHistoryFlag?: boolean | null;
  /** D302 R12 — compact routing-only view (head+tail + attachment descriptors). */
  routingView?: RoutingView;
}

export interface ConductorContext {
  roomId: string;
  userActorId: string;
  message: ConductorMessage;
  members: RoomMemberView[];
  now: Date;
  /** D426 Phase 2 — enables first-natural-reply root affinity for Subthreads. */
  roomKind?:
    | "private"
    | "group"
    | "multi_agent"
    | "subthread"
    | "open"
    | "task"
    | "access";
  /** D426 Phase 2 — parent Room id for a Subthread; null/absent otherwise. */
  parentRoomId?: string | null;
  /** D426 Phase 2 — anchor message id the Subthread hangs off of. */
  threadRootMessageId?: number | null;
}

/** D302 P1 — `standard` = today's conductor; `advanced` = call-buyer fall-through. */
export type ConductorMode = "standard" | "advanced";

export interface ConductorDebugEvent {
  phase: string;
  detail: Record<string, unknown>;
}

export interface RouteRoomMessageDeps {
  /**
   * D302 P1 — gates advanced call-buyer / arbitration-candidate behavior.
   * Code-default `standard` so callers omitting this field keep today's path.
   */
  mode?: ConductorMode;
  /** Active foci for (room, user) at `now` (already-swept). */
  loadActiveFoci: (
    roomId: string,
    userActorId: string,
    now: Date,
  ) => Promise<ActiveFocus[]>;
  /**
   * Resolves the agent ACTOR id a `replyToMessageId` points at, or null when
   * the parent is not an in-room assistant message. DB-backed in production;
   * stubbed in unit tests.
   */
  resolveReplyTargetActorId?: (
    replyToMessageId: number,
  ) => Promise<string | null>;
  /**
   * M135 P7 (D-B) — room-scoped history-evidence search. Optional so unit
   * tests can omit it (then the history route is skipped entirely). Returns
   * raw hits; the Conductor maps handles → actor ids itself.
   */
  searchRoomHistory?: (
    roomId: string,
    query: string,
    limit: number,
  ) => Promise<RoomHistoryHit[]>;
  /**
   * M135 P7 — id of the message immediately preceding this inbound turn in
   * the room (newest existing message). Used by `messageNeedsHistory` to
   * distinguish a reply to the last turn (ordinary reply) from a reply to an
   * OLDER message (past-context lookup). Optional; only consulted on the
   * history route.
   */
  getPrecedingMessageId?: (roomId: string) => Promise<number | null>;
  /**
   * D302 P6b — bounded routing metadata (presence/read, reply graph, tempo).
   * Optional; when absent the conductor skips packet assembly.
   */
  loadRoutingPacket?: (
    roomId: string,
    userActorId: string,
    now: Date,
    members: RoomMemberView[],
  ) => Promise<RoutingPacket>;
  /**
   * D279 Phase 3.6 — all active mute/deaf windows for a room at `now` (one
   * query). Conductor drops a member when a room-wide window exists
   * (`botActorId === null`) or a per-bot window matches that member.
   */
  loadActiveSilenceForRoom?: (
    roomId: string,
    now: Date,
  ) => Promise<Array<{ botActorId: string | null; kind: SilenceKind }>>;
  /**
   * D426 Phase 2 — resolve affinity only for the first visible child reply.
   * `currentMessageId` is the just-persisted human message. The server-side
   * resolver returns null once another visible child reply already exists.
   * `available: false` with a non-null `botActorId` remains a controlled
   * silence boundary for that initial natural reply.
   */
  resolveSubthreadRootAffinity?: (
    subthreadRoomId: string,
    now: Date,
    currentMessageId: number | null,
  ) => Promise<SubthreadRootAffinity | null>;
  /**
   * M135 P5 — pluggable Floor Manager LLM. UNDEFINED until wired; when absent
   * the Conductor returns `{ kind: "silent" }` for cold/ambiguous cases.
   */
  floorManager?: (
    ctx: ConductorContext,
    extra: {
      coldVolunteer: RoomMemberView[];
      active: ActiveFocus[];
      possibleAddressedBots?: RoomMemberView[];
      historyEvidenceCandidates?: RoomMemberView[];
      initialSearchHits?: RoomHistoryHit[];
      searchRoomHistory?: RouteRoomMessageDeps["searchRoomHistory"];
      /**
       * D302 P1 (advanced only) — FM-pickable candidates on detector miss:
       * roster-derived possible-addressed bots ∪ eligible `mention_only` agents.
       */
      arbitrationCandidates?: RoomMemberView[];
      /** D302 R13 (advanced only) — render People block + addressee×intent rubric. */
      humanAware?: boolean;
      /** D302 P6b — bounded presence/reply-graph/tempo metadata for the FM prompt. */
      routingPacket?: RoutingPacket;
    },
  ) => Promise<ConductorDecision>;
  /**
   * D299 follow-up — optional per-layer routing trace. The router calls this
   * once per routing layer it evaluates (filters / explicit / active-focus /
   * direct-address / history / floor-manager) with a compact structured
   * `detail`. The caller (dispatch) accumulates these and folds them into the
   * single per-turn `[conductor]` decision log line so a routing outcome is
   * self-explaining ("why didn't history fire?") without a separate debug
   * channel. No-op when omitted (unit tests omit it).
   */
  onTrace?: (step: string, detail: Record<string, unknown>) => void;
  /**
   * D302 dogfood — opt-in verbose routing telemetry. Intended for local debug
   * logs only; callers decide whether to enable and where to write.
   */
  onDebug?: (event: ConductorDebugEvent) => void;
}
