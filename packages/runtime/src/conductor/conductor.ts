import { DEFAULT_ADDRESSIVITY_THRESHOLD, scoreAddressivity } from "./addressivity";
import {
  classifyRosterNameEvidence,
  findDirectAddressMatches,
  findHumanVocativeMatches,
} from "./direct-address";
import {
  resolveExplicitHumanMentionTargets,
  resolveExplicitTargets,
} from "./explicit-targets";
import { extractHistoryIntent } from "./history-intent";
import {
  deterministicHistoryOwner,
  historyBotOwners,
  messageNeedsHistory,
} from "./history-owner";
import type { RoomHistoryHit } from "./history-search";
import type {
  ConductorContext,
  ConductorDecision,
  ConductorSource,
  RoomMemberView,
  RouteRoomMessageDeps,
} from "./types";
import { filterWakeableAgents } from "./types";

function dedupeAgentMembers(members: RoomMemberView[]): RoomMemberView[] {
  const seen = new Set<string>();
  const out: RoomMemberView[] = [];
  for (const member of members) {
    if (member.kind !== "agent" || seen.has(member.actorId)) continue;
    seen.add(member.actorId);
    out.push(member);
  }
  return out;
}

function summarizeHistoryHit(hit: RoomHistoryHit): Record<string, unknown> {
  return {
    messageId: hit.messageId,
    ts: hit.ts.toISOString(),
    authorDisplayName: hit.authorDisplayName,
    handle: hit.handle,
    snippet: hit.snippet,
  };
}

function handlesForActorIds(actorIds: readonly string[], members: readonly RoomMemberView[]): string[] {
  return actorIds
    .map((actorId) => {
      const member = members.find((m) => m.kind === "agent" && m.actorId === actorId);
      return member?.handle ? `@${member.handle}` : null;
    })
    .filter((handle): handle is string => handle !== null);
}

function directAddressMatchesToMembers(
  matches: ReturnType<typeof findDirectAddressMatches>,
  candidates: RoomMemberView[],
): RoomMemberView[] {
  return dedupeAgentMembers(
    matches
      .map((match) =>
        candidates.find(
          (candidate) =>
            candidate.kind === "agent" && candidate.actorId === match.actorId,
        ),
      )
      .filter((member): member is RoomMemberView => member != null),
  );
}

/**
 * M134 Phase 2 — Room Conductor deterministic router.
 *
 * Invariant: one user message wakes ZERO or ONE bot by default; multiple bots
 * wake only on explicit multi-mention/selection.
 *
 * Routing order (explicit precedence — a focused agent must NOT win when the
 * user clearly addresses someone else):
 *   1. Hard filters — `observe` (permanent mute) and transient mute/deaf
 *      windows drop bots from candidates, even on explicit @mention/reply/UI
 *      selection (R6 / D-B / D279).
 *   2. Explicit targets over `candidates` (mention(s) / reply / ui).
 *   3. Explicit human @mention suppression (D454, every mode) — when no
 *      eligible agent is explicitly targeted, a strict @handle that names a
 *      different human means the message is addressed to that person; the
 *      Conductor stays silent before focus/history/FM inference.
 *   4. Human-vocative suppression (D302 R13, advanced only) — a leading
 *      vocative that uniquely names a human (not the sender) means the message
 *      is addressed to a person; the Conductor stays silent without an FM
 *      call. A focused agent does NOT wake here. Collision (the same leading
 *      name also matches a bot) falls through to step 5.
 *   5. Direct-address evidence (D299 P1) — roster-derived leading vocative;
 *      exactly one wakeable candidate routes with `reason: "vocative"`; two or
 *      more matches → `ask_user` when ≥2 valid handles, else silence. This
 *      OVERRIDES an active focus: "Alepo, are you around?" wakes Alepo even
 *      when Jeannie holds the active focus.
 *   6. Single active focus over `candidates` (the "don't re-@" behavior) —
 *      the fallback for ordinary unaddressed continuation in every Room,
 *      including Subthreads.
 *   6.5 First-natural-reply root affinity (D426, Subthreads only) — only
 *      when there is no active child-room focus and the persisted message is
 *      the first visible child reply. An eligible Genie author of the anchor
 *      gets one inferred wake; an unavailable root stays controlled-silent.
 *   7. History evidence (M135 P7 / D-B) — when a structural signal asks for
 *      past context AND the search returns a single clear bot owner, wake it
 *      deterministically (no LLM). A single active focus (step 6) ALWAYS wins
 *      over this route. The Floor Manager LLM (M135 P5) handles the remaining
 *      ambiguous cases; when absent the Conductor stays silent.
 */
export async function routeRoomMessage(
  deps: RouteRoomMessageDeps,
  ctx: ConductorContext,
): Promise<ConductorDecision> {
  const mode = deps.mode ?? "standard";

  // 1. HARD FILTERS — drop `observe` (permanent mute) and transient
  // mute/deaf-window bots from ALL waking. D421 Phase 4.3: the canonical
  // `filterWakeableAgents` helper is the single source of truth reused by
  // the redirect-target revalidation, so the two paths cannot drift.
  const windows = deps.loadActiveSilenceForRoom
    ? await deps.loadActiveSilenceForRoom(ctx.roomId, ctx.now)
    : [];
  const candidates = filterWakeableAgents(ctx.members, windows);
  const coldVolunteer = candidates.filter(
    (m) => m.agentResponseMode === "active",
  );
  deps.onTrace?.("filters", {
    candidates: candidates.length,
    coldVolunteer: coldVolunteer.length,
  });

  // 2. EXPLICIT TARGETS (a muted bot is not in `candidates`, so unreachable).
  let replyTargetActorId: string | null = null;
  const replyId = ctx.message.replyToMessageId;
  if (
    replyId != null &&
    Number.isInteger(replyId) &&
    replyId > 0 &&
    deps.resolveReplyTargetActorId
  ) {
    replyTargetActorId = await deps.resolveReplyTargetActorId(replyId);
  }

  const explicit = resolveExplicitTargets(
    {
      content: ctx.message.content,
      uiSelectedBotActorId: ctx.message.uiSelectedBotActorId ?? null,
      ...(ctx.message.mentionEveryone === true
        ? { mentionEveryone: true }
        : {}),
    },
    candidates,
    replyTargetActorId,
  );
  if (explicit.length > 0) {
    // Decision-level source precedence: mention > reply > ui.
    const order: ConductorSource[] = ["mention", "reply", "ui", "inferred"];
    const source =
      order.find((s) => explicit.some((e) => e.source === s)) ?? "mention";
    deps.onTrace?.("explicit", { source, count: explicit.length });
    return {
      kind: "wake",
      botActorIds: explicit.map((e) => e.actorId),
      source,
      writeFocus: true,
      reason: source,
    };
  }

  // Structured @everyone targets the current Human roster. Explicit Genie
  // addressing above still wins, but the Human-wide intent must never wake a
  // focused, active, or floor-manager-inferred Genie.
  if (ctx.message.mentionEveryone === true) {
    deps.onTrace?.("everyone-mention", {});
    return { kind: "silent", reason: "human-addressed" };
  }

  // 3. EXPLICIT HUMAN @MENTION SUPPRESSION (D454, every mode). This runs after
  //    eligible explicit agent targets, so mixed @human + @agent messages wake
  //    the agent. It runs before all inferred routes, so human-to-human traffic
  //    cannot wake an active focus or reach the Floor Manager. The strict parser
  //    excludes fenced-code examples and the sender is excluded from the target
  //    set, preserving the existing self-address behavior.
  const explicitHumanTargets = resolveExplicitHumanMentionTargets(
    ctx.message.content,
    ctx.members.filter(
      (member) => member.kind === "user" && member.actorId !== ctx.userActorId,
    ),
  );
  if (explicitHumanTargets.length > 0) {
    deps.onTrace?.("human-mention", { count: explicitHumanTargets.length });
    return { kind: "silent", reason: "human-addressed" };
  }

  // 4. HUMAN-VOCATIVE SUPPRESSION (D302 R13, advanced only). A leading vocative
  //    that UNIQUELY names a human member (and not the sender) means the message
  //    is addressed to a person — humans answer humans, so the conductor stays
  //    silent without an FM call. This runs BEFORE direct-address and active
  //    focus so a focused agent does NOT wake when the user clearly addresses a
  //    human. Collision (the same leading name also matches a bot, e.g. human
  //    "Jeannie" + @jeannie) → fall through; the bot-vocative step / FM decides.
  //    Standard mode never runs this (advanced-only).
  if (mode === "advanced") {
    const humanMembers = ctx.members.filter(
      (m) => m.kind === "user" && m.actorId !== ctx.userActorId,
    );
    const humanMatches = findHumanVocativeMatches(ctx.message.content, humanMembers);
    if (humanMatches.length >= 1) {
      const botCollision =
        findDirectAddressMatches(ctx.message.content, candidates).length > 0;
      if (!botCollision) {
        const matchedHuman = humanMembers.find(
          (m) => m.actorId === humanMatches[0]!.actorId,
        );
        deps.onTrace?.("human-vocative", {
          matched: matchedHuman?.displayName ?? humanMatches[0]!.matchedName,
          count: humanMatches.length,
        });
        return { kind: "silent", reason: "human-addressed" };
      }
    }
  }

  // 5. DIRECT-ADDRESS EVIDENCE (D299 P1). Leading roster vocative only; never
  //    arbitrary-picks among multiple matches. Runs BEFORE active focus so a
  //    clear name address overrides the focused bot ("Alepo, are you around?"
  //    wakes Alepo even when Jeannie holds the active focus).
  const directAddress = findDirectAddressMatches(ctx.message.content, candidates);
  deps.onTrace?.("direct-address", { matches: directAddress.length });
  if (directAddress.length === 1) {
    return {
      kind: "wake",
      botActorIds: [directAddress[0]!.actorId],
      source: "inferred",
      writeFocus: true,
      reason: "vocative",
    };
  }
  if (directAddress.length >= 2) {
    const options = directAddress
      .filter((m) => m.handle)
      .map((m) => ({ botActorId: m.actorId, handle: m.handle }));
    if (options.length >= 2) {
      return {
        kind: "ask_user",
        options,
        reason: "vocative: ambiguous direct address",
      };
    }
  }

  let initialSearchHitsForFloorManager: Awaited<
    ReturnType<NonNullable<RouteRoomMessageDeps["searchRoomHistory"]>>
  > | undefined;
  let historyEvidenceCandidatesForFloorManager: typeof candidates | undefined;
  let possibleAddressedBotsForArbitration: RoomMemberView[] | undefined;
  if (mode === "advanced" && directAddress.length === 0) {
    possibleAddressedBotsForArbitration = [];
  } else if (mode === "advanced" && directAddress.length >= 2) {
    const options = directAddress
      .filter((m) => m.handle)
      .map((m) => ({ botActorId: m.actorId, handle: m.handle }));
    if (options.length < 2) {
      possibleAddressedBotsForArbitration = directAddressMatchesToMembers(
        directAddress,
        candidates,
      );
    }
  }

  // 6. ACTIVE FOCUS over `candidates` (focus CAN continue a `mention_only`
  //    bot — that is the "don't re-@" behavior; it derives from prior
  //    explicit naming). The fallback for ordinary unaddressed continuation;
  //    a clear direct address (step 5) already won.
  const active = (
    await deps.loadActiveFoci(ctx.roomId, ctx.userActorId, ctx.now)
  ).filter((f) => candidates.some((c) => c.actorId === f.botActorId));
  deps.onTrace?.("active-focus", { active: active.length });
  if (active.length === 1) {
    return {
      kind: "wake",
      botActorIds: [active[0]!.botActorId],
      source: "inferred",
      writeFocus: true,
      reason: "single active focus",
    };
  }
  // active.length > 1 => ambiguous: do NOT fan out; defer (history / Floor
  // Manager). active.length === 0 => no focus. Either way fall through.

  // 6.5 FIRST-NATURAL-REPLY ROOT AFFINITY (D426). A Subthread remains a
  // normal Room: active requester-private focus always wins. Only the first
  // visible, otherwise-unaddressed child reply may inherit the agent author
  // of its root as a one-shot inferred route. The resolver uses the persisted
  // message id to reject later child turns; it returns null for human roots.
  if (
    ctx.roomKind === "subthread" &&
    active.length === 0 &&
    deps.resolveSubthreadRootAffinity
  ) {
    const affinity = await deps.resolveSubthreadRootAffinity(
      ctx.roomId,
      ctx.now,
      ctx.message.sourceMessageId ?? null,
    );
    if (affinity?.botActorId) {
      if (
        affinity.available &&
        candidates.some((candidate) => candidate.actorId === affinity.botActorId)
      ) {
        deps.onTrace?.("thread-affinity", { affinity: true });
        return {
          kind: "wake",
          botActorIds: [affinity.botActorId],
          source: "inferred",
          writeFocus: true,
          reason: "thread affinity",
        };
      }
      // The only eligible first-natural-reply affinity target is unavailable.
      // Do not silently substitute a different Genie for the root author.
      deps.onTrace?.("thread-affinity", { unavailable: true });
      return { kind: "silent", reason: "thread affinity unavailable" };
    }
    deps.onTrace?.("thread-affinity", { fallthrough: true });
  }

  // 7. HISTORY EVIDENCE (M135 P7 / D-B / D299 P2). Consulted when a structural
  //    signal or bounded history-intent asks for past context; a clear single
  //    owner routes without any LLM. Reached only when step 6 did NOT resolve
  //    (0 or >1 active foci), so a single active focus always wins over this
  //    route.
  let historyIntent: ReturnType<typeof extractHistoryIntent> = null;
  let structuralNeedsHistory = false;
  if (deps.searchRoomHistory) {
    historyIntent = extractHistoryIntent(ctx.message.content);
    let precedingMessageId: number | null = null;
    if (
      deps.getPrecedingMessageId &&
      ctx.message.replyToMessageId != null
    ) {
      precedingMessageId = await deps.getPrecedingMessageId(ctx.roomId);
    }
    structuralNeedsHistory = messageNeedsHistory(ctx.message, {
      precedingMessageId,
      searchHistoryFlag: ctx.message.searchHistoryFlag ?? false,
    });
    if (structuralNeedsHistory || historyIntent) {
      const query = historyIntent?.searchQuery ?? ctx.message.content;
      const historyLimit = historyIntent ? 20 : 5;
      const rawHits = await deps.searchRoomHistory(ctx.roomId, query, historyLimit);
      const hits =
        ctx.message.sourceMessageId != null
          ? rawHits.filter((hit) => hit.messageId !== ctx.message.sourceMessageId)
          : rawHits;
      const owner = deterministicHistoryOwner(hits, active, candidates);
      const owners = historyBotOwners(hits, active, candidates);
      // D421 Phase 3 (3.1.1/3.1.3) — the always-on trace carries counts +
      // controlled enums only. The raw search query (which may be the user's
      // message content) stays in opt-in `onDebug` below; never in `onTrace`.
      deps.onTrace?.("history", {
        structural: structuralNeedsHistory,
        intent: historyIntent?.shape ?? null,
        hits: hits.length,
        rawHits: rawHits.length,
        owner: owner != null,
      });
      deps.onDebug?.({
        phase: "history",
        detail: {
          structural: structuralNeedsHistory,
          intent: historyIntent?.shape ?? null,
          query,
          requestedLimit: historyLimit,
          rawHitCount: rawHits.length,
          hitCount: hits.length,
          excludedSourceMessageId: ctx.message.sourceMessageId ?? null,
          hits: hits.map(summarizeHistoryHit),
          ownerResolved: owner != null,
          ownerHandle: owner ? handlesForActorIds([owner], candidates)[0] ?? null : null,
          ownerCandidateHandles: handlesForActorIds(owners, candidates),
        },
      });
      if (owner) {
        // D421 Phase 6.2.2 — a referenced roster name that conflicts with the
        // history owner suppresses the deterministic owner shortcut so the
        // Floor Manager can arbitrate with name+owner context. The unique
        // addressee case already returned at step 5; this guards the
        // reference-only case (name present but not as an addressee). Trace
        // carries counts/enum only — no handles or names (D421 6.2.4).
        const nameEvidence = classifyRosterNameEvidence(ctx.message.content, candidates);
        const ownerConflictsWithNamedAgent =
          nameEvidence.referencedActorIds.length > 0 &&
          !nameEvidence.referencedActorIds.includes(owner);
        if (ownerConflictsWithNamedAgent) {
          deps.onTrace?.("history-owner", {
            suppressed: "named-agent-conflict",
            referenced: nameEvidence.referencedActorIds.length,
          });
        } else {
          return {
            kind: "wake",
            botActorIds: [owner],
            source: "inferred",
            writeFocus: true,
            reason: historyIntent ? "history-intent" : "history single-owner",
          };
        }
      }
      if (historyIntent) {
        if (owners.length >= 2) {
          const options = owners
            .map((actorId) => {
              const member = candidates.find(
                (c) => c.kind === "agent" && c.actorId === actorId,
              );
              return member
                ? { botActorId: actorId, handle: member.handle }
                : null;
            })
            .filter(
              (o): o is { botActorId: string; handle: string } => o !== null,
            );
          if (options.length >= 2) {
            return {
              kind: "ask_user",
              options,
              reason: "history-intent: ambiguous owner",
            };
          }
        }
      }
      if (hits.length > 0) {
        initialSearchHitsForFloorManager = hits;
      }
      if (owners.length > 0) {
        historyEvidenceCandidatesForFloorManager = candidates.filter(
          (candidate) =>
            candidate.kind === "agent" && owners.includes(candidate.actorId),
        );
      }
    } else {
      deps.onTrace?.("history", { gated: "no structural signal or intent" });
    }
  } else {
    deps.onTrace?.("history", { gated: "no searchRoomHistory dep" });
  }

  // FLOOR MANAGER LLM (M135 P5) — final leg of step 7. When absent → silent.
  // D421 Phase 6.2.4 — the `floor-manager` trace is emitted ONLY when we
  // actually reach the Floor Manager stage (after the advanced baseline
  // history block), so a history early-return cannot claim the model ran.
  // `configured` = a Floor Manager dep is supplied; `called` = it is actually
  // invoked. Counts/booleans only — no handles, names, or message text.
  if (!deps.floorManager) {
    deps.onTrace?.("floor-manager", {
      configured: false,
      called: false,
      coldVolunteer: coldVolunteer.length,
    });
    return { kind: "silent", reason: "no deterministic route" };
  }

  let routingPacket:
    | Awaited<ReturnType<NonNullable<RouteRoomMessageDeps["loadRoutingPacket"]>>>
    | undefined;
  if (deps.loadRoutingPacket) {
    try {
      routingPacket = await deps.loadRoutingPacket(
        ctx.roomId,
        ctx.userActorId,
        ctx.now,
        ctx.members,
      );
      // D421 Phase 3 (3.1.1) — surface the recent-counterpart count so a
      // continuation/redirect outcome is diagnosable from the trace alone.
      // Counts/booleans only; no raw ids, no message content.
      deps.onTrace?.("routing-packet", {
        presence: routingPacket.presence.length,
        replyTargets: routingPacket.replyTargets.length,
        tempo: routingPacket.tempo.msgsLastWindow,
        recentCounterparts: routingPacket.recentCounterparts.length,
      });
    } catch (err) {
      // D421 Phase 3 (3.1.3) — the always-on trace records only the boolean
      // `failed` flag (no raw provider/db error text). The controlled detail
      // stays in opt-in `onDebug` so an operator can still diagnose it.
      deps.onTrace?.("routing-packet", { failed: true });
      deps.onDebug?.({
        phase: "routing-packet",
        detail: {
          failed: true,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  const floorExtra: Parameters<NonNullable<RouteRoomMessageDeps["floorManager"]>>[1] =
    {
      coldVolunteer,
      active,
      ...(initialSearchHitsForFloorManager
        ? { initialSearchHits: initialSearchHitsForFloorManager }
        : {}),
      ...(historyEvidenceCandidatesForFloorManager
        ? { historyEvidenceCandidates: historyEvidenceCandidatesForFloorManager }
        : {}),
      searchRoomHistory: deps.searchRoomHistory,
      ...(routingPacket ? { routingPacket } : {}),
    };

  if (mode === "advanced") {
    // D302 R13 — let the FM reason about humans vs assistants (addressee×intent).
    floorExtra.humanAware = true;

    const mentionOnlyRoster = candidates.filter(
      (member) =>
        member.kind === "agent" && member.agentResponseMode === "mention_only",
    );
    const arbitrationCandidates = dedupeAgentMembers([
      ...(possibleAddressedBotsForArbitration ?? []),
      ...mentionOnlyRoster,
    ]);
    if (arbitrationCandidates.length > 0) {
      floorExtra.arbitrationCandidates = arbitrationCandidates;
    }

    const threshold = DEFAULT_ADDRESSIVITY_THRESHOLD;
    const hasRecentRelationship =
      active.length > 0 || (routingPacket?.replyTargets.length ?? 0) > 0;
    try {
      const { score, signals, bought } = scoreAddressivity(ctx, {
        hasRecentRelationship,
        threshold,
      });
      deps.onTrace?.("addressivity", { score, threshold, signals, bought });
      if (!bought) {
        return { kind: "silent", reason: "addressivity: below threshold" };
      }
    } catch {
      deps.onTrace?.("addressivity", {
        threshold,
        failOpen: true,
        bought: true,
      });
    }

    if (
      deps.searchRoomHistory &&
      !structuralNeedsHistory &&
      !historyIntent &&
      !initialSearchHitsForFloorManager
    ) {
      const rawHits = await deps.searchRoomHistory(ctx.roomId, ctx.message.content, 20);
      const hits =
        ctx.message.sourceMessageId != null
          ? rawHits.filter((hit) => hit.messageId !== ctx.message.sourceMessageId)
          : rawHits;
      const owner = deterministicHistoryOwner(hits, active, candidates);
      const owners = historyBotOwners(hits, active, candidates);
      // D421 Phase 3 (3.1.1/3.1.3) — counts/booleans only in the always-on
      // trace; the raw baseline query (= the user's message content) lives
      // only in opt-in `onDebug` below.
      deps.onTrace?.("history-baseline", {
        hits: hits.length,
        rawHits: rawHits.length,
        owner: owner != null,
      });
      deps.onDebug?.({
        phase: "history-baseline",
        detail: {
          query: ctx.message.content,
          requestedLimit: 20,
          rawHitCount: rawHits.length,
          hitCount: hits.length,
          excludedSourceMessageId: ctx.message.sourceMessageId ?? null,
          hits: hits.map(summarizeHistoryHit),
          ownerResolved: owner != null,
          ownerHandle: owner ? handlesForActorIds([owner], candidates)[0] ?? null : null,
          ownerCandidateHandles: handlesForActorIds(owners, candidates),
        },
      });
      if (owner) {
        // D421 Phase 6.2.2 — same named-agent conflict guard as the structural
        // history route. The unique addressee case already returned at step 5;
        // this guards the advanced baseline owner shortcut against a referenced
        // roster name. Trace carries counts/enum only (D421 6.2.4).
        const nameEvidence = classifyRosterNameEvidence(ctx.message.content, candidates);
        const ownerConflictsWithNamedAgent =
          nameEvidence.referencedActorIds.length > 0 &&
          !nameEvidence.referencedActorIds.includes(owner);
        if (ownerConflictsWithNamedAgent) {
          deps.onTrace?.("history-baseline-owner", {
            suppressed: "named-agent-conflict",
            referenced: nameEvidence.referencedActorIds.length,
          });
        } else {
          return {
            kind: "wake",
            botActorIds: [owner],
            source: "inferred",
            writeFocus: true,
            reason: "history baseline single-owner",
          };
        }
      }
      if (hits.length > 0) {
        floorExtra.initialSearchHits = hits;
      }
      if (owners.length > 0) {
        floorExtra.historyEvidenceCandidates = candidates.filter(
          (candidate) =>
            candidate.kind === "agent" && owners.includes(candidate.actorId),
        );
      }
    }
  }

  // D421 Phase 6.2.4 — `called: true` is emitted only at the actual invocation
  // site, so a baseline-history early-return cannot leave a misleading
  // `invoked: true` on the trace.
  deps.onTrace?.("floor-manager", {
    configured: true,
    called: true,
    coldVolunteer: coldVolunteer.length,
  });
  return deps.floorManager(ctx, floorExtra);
}
