/**
 * D421 Phase 1 — Stack 202 semantic continuation evaluation corpus.
 *
 * A compact, table-driven fixture set consumed by Floor Manager unit tests.
 * Each fixture varies ONE orthogonal routing-quality dimension at a time so a
 * future regression is attributable to a policy dimension rather than a single
 * hand-written phrase.
 *
 * Orthogonal fields (per the 1.2.1 contract):
 *   - counterpart count       (0, 1, 2)
 *   - interaction age         (1m .. 55m)
 *   - interaction kind        (message | reaction)
 *   - intervening message count (0 .. 20)
 *   - latest message shape
 *   - expected action          (wake | stay_silent | ask_user)
 *   - category / policy label
 *
 * Positive categories: continuation, feedback, creative invitation, iterative
 * testing. Negative controls: recency-only ambient, continuation wording
 * without a unique counterpart, human-directed, stale, high churn, multiple
 * plausible counterparts.
 *
 * Privacy contract: every raw id in this corpus is a `*-sentinel-*` string.
 * The guard test in floor-manager.test.ts asserts none of those sentinels, nor
 * the held-out live-evaluation phrase, ever reach a rendered FM prompt. The
 * held-out phrase is intentionally NOT committed here or in any prompt example;
 * the guard checks for its fragments only.
 */

import type { ActiveFocus } from "@nautilo/trust";
import type {
  ConductorContext,
  ConductorDecision,
  RoomMemberView,
  RoutingPacket,
} from "@nautilo/runtime";

/** Element type of `RoutingPacket.recentCounterparts` (not named-exported). */
type RecentCounterpart = RoutingPacket["recentCounterparts"][number];

export type ContinuationCategory =
  | "continuation"
  | "feedback"
  | "creative_invitation"
  | "iterative_testing"
  | "recency_only_ambient"
  | "continuation_no_counterpart"
  | "human_directed"
  | "stale"
  | "high_churn"
  | "multiple_counterparts"
  | "named_address"
  | "named_address_incidental";

export type ExpectedAction = "wake" | "stay_silent" | "ask_user";

export interface ContinuationFixture {
  id: string;
  category: ContinuationCategory;
  /** Policy label the FM rubric names for this evidence class. */
  policyLabel: string;
  /** The single dimension this fixture varies (orthogonality audit aid). */
  dimension: string;
  members: RoomMemberView[];
  userActorId: string;
  roomId: string;
  active: ActiveFocus[];
  routingPacket: RoutingPacket;
  latestMessage: string;
  /** Advanced-mode R13 human-aware prompt rendering. */
  humanAware?: boolean;
  /**
   * Recorded strict-JSON model response — the deterministic stand-in for a
   * provider call. The harness feeds this to `runFloorManager` via
   * `invokeModel`; it never evaluates semantics through keyword code.
   */
  recordedModelOutput: string;
  expectedAction: ExpectedAction;
}

/**
 * Raw-id sentinels. The guard test asserts these never appear in a rendered
 * FM prompt. They exist ONLY to make a leak observable; production code maps
 * them to `@handle` / display names before rendering.
 */
export const SENTINELS = {
  roomId: "room-sentinel-202",
  userActorId: "actor-sentinel-user",
  nova: "actor-sentinel-nova",
  alepo: "actor-sentinel-alepo",
  jeannie: "actor-sentinel-jeannie",
  genie: "actor-sentinel-genie",
  casey: "actor-sentinel-casey",
  focusNova: "focus-sentinel-nova",
  focusAlepo: "focus-sentinel-alepo",
  focusJeannie: "focus-sentinel-jeannie",
  msgFeedback: "msg-sentinel-feedback",
  msgContinuation: "msg-sentinel-continuation",
} as const;

/** All raw-id sentinel strings, for the no-leak guard. */
export const SENTINEL_VALUES: readonly string[] = Object.values(SENTINELS);

function agent(
  actorId: string,
  handle: string,
  opts: { name?: string; mode?: RoomMemberView["agentResponseMode"]; owner?: string } = {},
): RoomMemberView {
  return {
    kind: "agent",
    actorId,
    agentId: `agent-${handle}`,
    handle,
    ...(opts.name ? { displayName: opts.name } : {}),
    ...(opts.mode ? { agentResponseMode: opts.mode } : {}),
    ...(opts.owner ? { agentOwnerDisplayName: opts.owner } : {}),
  };
}

function human(actorId: string, handle: string, name: string): RoomMemberView {
  return { kind: "user", actorId, handle, displayName: name };
}

function counterpart(
  bot: string,
  ageMin: number,
  interaction: RecentCounterpart["interaction"],
  intervening: number,
): RecentCounterpart {
  return {
    bot,
    lastInteractionAgoMs: ageMin * 60_000,
    interaction,
    interveningMessages: intervening,
  };
}

function emptyPacket(): RoutingPacket {
  return {
    presence: [],
    replyTargets: [],
    tempo: { msgsLastWindow: 0, lastMessageAgoMs: null },
    recentCounterparts: [],
  };
}

/** Build the ConductorContext for a fixture from its shared fields. */
export function fixtureContext(f: ContinuationFixture, content?: string): ConductorContext {
  return {
    roomId: f.roomId,
    userActorId: f.userActorId,
    message: { content: content ?? f.latestMessage },
    members: f.members,
    now: new Date(),
  };
}

/** Recorded-JSON `invokeModel` — deterministic, no provider call. */
export function recordedInvoker(f: ContinuationFixture) {
  return () => Promise.resolve(f.recordedModelOutput);
}

/**
 * Map a corpus `expectedAction` (FloorDecision action vocabulary: wake /
 * stay_silent / ask_user) to the `ConductorDecision.kind` produced by
 * `runFloorManager`. `stay_silent` degrades to `silent` per the Floor Manager
 * hardening contract.
 */
export function expectedDecisionKind(
  action: ExpectedAction,
): ConductorDecision["kind"] {
  return action === "stay_silent" ? "silent" : action;
}

/**
 * The corpus. Each row is a self-contained scenario; the harness renders the
 * real prompt and runs `runFloorManager` with the recorded model output, then
 * asserts `expectedAction`.
 */
export const CONTINUATION_FIXTURES: readonly ContinuationFixture[] = [
  // --- Positive: DIRECTED CONTINUATION wakes the single counterpart. ---
  {
    id: "pos-continuation-single",
    category: "continuation",
    policyLabel: "DIRECTED CONTINUATION",
    dimension: "counterpart count=1, age=3m, kind=message, intervening=0",
    members: [agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 2, lastMessageAgoMs: 30_000 },
      recentCounterparts: [counterpart("Nova", 3, "message", 0)],
    },
    latestMessage: "continue from where we left off, please",
    recordedModelOutput:
      '{"action":"wake","bot_handle":"@nova","reason":"directed continuation: single recent counterpart, low intervening"}',
    expectedAction: "wake",
  },
  {
    id: "pos-feedback-single",
    category: "feedback",
    policyLabel: "DIRECTED CONTINUATION",
    dimension: "feedback cue, counterpart count=1, age=5m, intervening=1",
    members: [agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 3, lastMessageAgoMs: 40_000 },
      recentCounterparts: [counterpart("Nova", 5, "message", 1)],
    },
    latestMessage: "that helped — one more small tweak on the same idea",
    recordedModelOutput:
      '{"action":"wake","bot_handle":"@nova","reason":"directed continuation: feedback follow-up"}',
    expectedAction: "wake",
  },
  {
    id: "pos-creative-invitation",
    category: "creative_invitation",
    policyLabel: "DIRECTED CONTINUATION",
    dimension: "creative-invitation cue, counterpart count=1, age=8m, intervening=0",
    members: [agent(SENTINELS.jeannie, "jeannie", { name: "Jeannie", mode: "active", owner: "Alex" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 1, lastMessageAgoMs: 20_000 },
      recentCounterparts: [counterpart("Jeannie", 8, "message", 0)],
    },
    latestMessage: "let's try a more creative pass on this together",
    recordedModelOutput:
      '{"action":"wake","bot_handle":"@jeannie","reason":"directed continuation: creative invitation"}',
    expectedAction: "wake",
  },
  {
    id: "pos-iterative-testing",
    category: "iterative_testing",
    policyLabel: "DIRECTED CONTINUATION",
    dimension: "iterative-testing cue, kind=reaction, age=2m, intervening=0",
    members: [agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 2, lastMessageAgoMs: 15_000 },
      recentCounterparts: [counterpart("Nova", 2, "reaction", 0)],
    },
    latestMessage: "let's test that one more time and iterate",
    recordedModelOutput:
      '{"action":"wake","bot_handle":"@nova","reason":"directed continuation: iterative testing"}',
    expectedAction: "wake",
  },

  // --- Negative controls. ---
  {
    id: "neg-recency-only-ambient",
    category: "recency_only_ambient",
    policyLabel: "RECENCY IS NOT A WAKE TRIGGER",
    dimension: "ambient message, counterpart count=1, age=1m (recency only)",
    members: [agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 1, lastMessageAgoMs: 10_000 },
      recentCounterparts: [counterpart("Nova", 1, "message", 0)],
    },
    latestMessage: "nice weather today, honestly",
    recordedModelOutput:
      '{"action":"stay_silent","reason":"ambient statement; recency alone is not a wake trigger"}',
    expectedAction: "stay_silent",
  },
  {
    id: "neg-continuation-no-counterpart",
    category: "continuation_no_counterpart",
    policyLabel: "NO CLEAR COUNTERPART",
    dimension: "continuation wording, counterpart count=0",
    members: [agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 1, lastMessageAgoMs: 12_000 },
      recentCounterparts: [],
    },
    latestMessage: "continue, please",
    recordedModelOutput:
      '{"action":"stay_silent","reason":"continuation wording without a clear counterpart; do not arbitrarily choose"}',
    expectedAction: "stay_silent",
  },
  {
    id: "neg-human-directed",
    category: "human_directed",
    policyLabel: "HUMAN-ADDRESSEE SUPPRESSION",
    dimension: "human-addressed message with one counterpart present",
    members: [
      agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" }),
      human(SENTINELS.casey, "casey", "Casey"),
    ],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    humanAware: true,
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 2, lastMessageAgoMs: 25_000 },
      recentCounterparts: [counterpart("Nova", 3, "message", 0)],
    },
    latestMessage: "Casey, can you double-check this for me?",
    recordedModelOutput:
      '{"action":"stay_silent","reason":"addressed to a human","addressee":"human:Casey"}',
    expectedAction: "stay_silent",
  },
  {
    id: "neg-stale",
    category: "stale",
    policyLabel: "STALE EVIDENCE",
    dimension: "continuation cue, counterpart count=1, age=55m (stale), intervening=0",
    members: [agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 6, lastMessageAgoMs: 30_000 },
      recentCounterparts: [counterpart("Nova", 55, "message", 0)],
    },
    latestMessage: "continue from where we left off",
    recordedModelOutput:
      '{"action":"stay_silent","reason":"stale counterpart evidence; relationship has gone cold"}',
    expectedAction: "stay_silent",
  },
  {
    id: "neg-high-churn",
    category: "high_churn",
    policyLabel: "HIGH CHURN WEAKENS CONTINUITY",
    dimension: "continuation cue, counterpart count=1, age=5m, intervening=20",
    members: [agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" })],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 25, lastMessageAgoMs: 5_000 },
      recentCounterparts: [counterpart("Nova", 5, "message", 20)],
    },
    latestMessage: "continue, please",
    recordedModelOutput:
      '{"action":"stay_silent","reason":"high intervening count weakens continuity; room has moved on"}',
    expectedAction: "stay_silent",
  },
  {
    id: "neg-multiple-counterparts",
    category: "multiple_counterparts",
    policyLabel: "MULTIPLE PLAUSIBLE COUNTERPARTS",
    dimension: "continuation cue, counterpart count=2, both low intervening",
    members: [
      agent(SENTINELS.nova, "nova", { name: "Nova", mode: "active" }),
      agent(SENTINELS.alepo, "alepo", { name: "Alepo", mode: "active" }),
    ],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: {
      ...emptyPacket(),
      tempo: { msgsLastWindow: 4, lastMessageAgoMs: 20_000 },
      recentCounterparts: [
        counterpart("Nova", 3, "message", 0),
        counterpart("Alepo", 4, "message", 0),
      ],
    },
    latestMessage: "continue, please",
    recordedModelOutput:
      '{"action":"ask_user","options":["@nova","@alepo"],"reason":"two equally plausible counterparts; do not arbitrarily choose"}',
    expectedAction: "ask_user",
  },

  // --- D421 Phase 6.3.2 — named_address category. Natural named-agent hails
  // (positive) and incidental-name negatives. Named-agent address is a SEPARATE
  // branch from unnamed two-signal continuation: a named presence hail does NOT
  // require a recent counterpart + continuation intent. These fixtures render
  // the real FM prompt with recorded JSON; provider-backed scoring lives in
  // the eval harness, not here.
  {
    id: "pos-named-address-discourse",
    category: "named_address",
    policyLabel: "NAMED ADDRESSEE",
    dimension: "discourse-prefixed named address, unique roster match",
    members: [
      agent(SENTINELS.jeannie, "jeannie", { name: "Jeannie", mode: "active", owner: "Alex" }),
      agent(SENTINELS.alepo, "alepo", { name: "Alepo", mode: "active" }),
    ],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: emptyPacket(),
    latestMessage: "And Jeannie are you around?",
    recordedModelOutput:
      '{"action":"wake","bot_handle":"@jeannie","reason":"named addressee: unique roster match"}',
    expectedAction: "wake",
  },
  {
    id: "pos-named-address-presence",
    category: "named_address",
    policyLabel: "NAMED ADDRESSEE",
    dimension: "presence-question named address, unique roster match",
    members: [
      agent(SENTINELS.jeannie, "jeannie", { name: "Jeannie", mode: "active", owner: "Alex" }),
      agent(SENTINELS.alepo, "alepo", { name: "Alepo", mode: "active" }),
    ],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: emptyPacket(),
    latestMessage: "is Jeannie here?",
    recordedModelOutput:
      '{"action":"wake","bot_handle":"@jeannie","reason":"named addressee: presence question"}',
    expectedAction: "wake",
  },
  {
    id: "neg-named-address-incidental",
    category: "named_address_incidental",
    policyLabel: "REFERENCE IS NOT AN ADDRESSEE",
    dimension: "incidental past-tense name reference, no address form",
    members: [
      agent(SENTINELS.jeannie, "jeannie", { name: "Jeannie", mode: "active", owner: "Alex" }),
      agent(SENTINELS.alepo, "alepo", { name: "Alepo", mode: "active" }),
    ],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: emptyPacket(),
    latestMessage: "I was talking about Jeannie yesterday",
    recordedModelOutput:
      '{"action":"stay_silent","reason":"incidental name reference; not an addressee"}',
    expectedAction: "stay_silent",
  },
  {
    id: "neg-named-address-quoted",
    category: "named_address_incidental",
    policyLabel: "REFERENCE IS NOT AN ADDRESSEE",
    dimension: "quoted/hypothetical name mention, not a live address",
    members: [
      agent(SENTINELS.genie, "genie", { name: "Genie", mode: "active", owner: "Casey" }),
    ],
    userActorId: SENTINELS.userActorId,
    roomId: SENTINELS.roomId,
    active: [],
    routingPacket: emptyPacket(),
    latestMessage: 'if I say, "Hey Genie, let\'s see" does that wake you?',
    recordedModelOutput:
      '{"action":"stay_silent","reason":"quoted/hypothetical name; not a live addressee"}',
    expectedAction: "stay_silent",
  },
];
