import { describe, test, expect } from "bun:test";
import {
  isExplicitConductorSource,
  routeRoomMessage,
  type ConductorContext,
  type ConductorDecision,
  type RoomMemberView,
  type RouteRoomMessageDeps,
} from "@nautilo/runtime";
import type { ActiveFocus, SilenceKind } from "@nautilo/trust";

const ROOM_ID = "room-1";
const USER_ACTOR_ID = "user-1";

test("only inferred Conductor wakes are implicit", () => {
  expect(isExplicitConductorSource("mention")).toBe(true);
  expect(isExplicitConductorSource("reply")).toBe(true);
  expect(isExplicitConductorSource("ui")).toBe(true);
  expect(isExplicitConductorSource("inferred")).toBe(false);
});

function agent(
  actorId: string,
  handle: string,
  mode?: RoomMemberView["agentResponseMode"],
): RoomMemberView {
  return {
    kind: "agent",
    actorId,
    agentId: `agent-${actorId}`,
    handle,
    agentResponseMode: mode ?? "active",
  };
}

function user(actorId: string): RoomMemberView {
  return { kind: "user", actorId, handle: actorId };
}

function activeFocus(
  botActorId: string,
  openedSource: ActiveFocus["openedSource"] = "mention",
): ActiveFocus {
  return {
    focusId: `focus-${botActorId}`,
    botActorId,
    expiresAt: new Date(Date.now() + 60_000),
    openedSource,
  };
}

function baseCtx(
  overrides: Partial<ConductorContext> & {
    message?: Partial<ConductorContext["message"]>;
  } = {},
): ConductorContext {
  const { message: messageOverrides, ...rest } = overrides;
  return {
    roomId: ROOM_ID,
    userActorId: USER_ACTOR_ID,
    message: {
      content: "",
      ...messageOverrides,
    },
    members: [user(USER_ACTOR_ID)],
    now: new Date(),
    ...rest,
  };
}

function defaultDeps(
  overrides: Partial<RouteRoomMessageDeps> = {},
): RouteRoomMessageDeps {
  return {
    loadActiveFoci: async () => [],
    ...overrides,
  };
}

function expectWake(
  decision: ConductorDecision,
  expected: {
    botActorIds: string[];
    source: "mention" | "reply" | "ui" | "inferred";
    reason?: string;
  },
) {
  expect(decision.kind).toBe("wake");
  if (decision.kind !== "wake") return;
  expect(decision.botActorIds).toEqual(expected.botActorIds);
  expect(decision.source).toBe(expected.source);
  expect(decision.writeFocus).toBe(true);
  if (expected.reason !== undefined) {
    expect(decision.reason).toBe(expected.reason);
  }
}

function expectSilent(decision: ConductorDecision, reason?: string) {
  expect(decision.kind).toBe("silent");
  if (decision.kind !== "silent") return;
  expect("writeFocus" in decision).toBe(false);
  if (reason !== undefined) {
    expect(decision.reason).toBe(reason);
  }
}

function expectAskUser(
  decision: ConductorDecision,
  expected: { botActorIds: string[]; reason?: string },
) {
  expect(decision.kind).toBe("ask_user");
  if (decision.kind !== "ask_user") return;
  expect(decision.options.map((o) => o.botActorId).sort()).toEqual(
    [...expected.botActorIds].sort(),
  );
  if (expected.reason !== undefined) {
    expect(decision.reason).toBe(expected.reason);
  }
}

describe("routeRoomMessage (M134)", () => {
  const NOVA = "actor-nova";
  const ALEPO = "actor-alepo";

  test("1. explicit @handle mention wakes that agent (mention, writeFocus)", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "@nova hi" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      }),
    );
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "mention",
      reason: "mention",
    });
  });

  test("2. multi-mention wakes both agents", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "@nova @alepo go" },
        members: [
          user(USER_ACTOR_ID),
          agent(NOVA, "nova", "active"),
          agent(ALEPO, "alepo", "active"),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [NOVA, ALEPO],
      source: "mention",
    });
    if (decision.kind === "wake") {
      expect(decision.botActorIds).toHaveLength(2);
    }
  });

  test("3. reply-to-bot wakes resolved target (reply)", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        resolveReplyTargetActorId: async () => NOVA,
      }),
      baseCtx({
        message: { content: "thanks", replyToMessageId: 5 },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      }),
    );
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "reply",
      reason: "reply",
    });
  });

  test("4. UI selection wakes selected bot (ui)", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "help me", uiSelectedBotActorId: ALEPO },
        members: [user(USER_ACTOR_ID), agent(ALEPO, "alepo", "active")],
      }),
    );
    expectWake(decision, {
      botActorIds: [ALEPO],
      source: "ui",
      reason: "ui",
    });
  });

  test("5. single active focus infers wake when no explicit target", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(NOVA, "mention")],
      }),
      baseCtx({
        message: { content: "follow-up without @" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      }),
    );
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "single active focus",
    });
  });

  test("6. two active foci without explicit target stays silent", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [
          activeFocus(NOVA, "mention"),
          activeFocus(ALEPO, "ui"),
        ],
      }),
      baseCtx({
        message: { content: "ambiguous" },
        members: [
          user(USER_ACTOR_ID),
          agent(NOVA, "nova", "active"),
          agent(ALEPO, "alepo", "active"),
        ],
      }),
    );
    expectSilent(decision, "no deterministic route");
  });

  test("7. zero focus and no floorManager is silent", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "ambient chatter" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      }),
    );
    expectSilent(decision, "no deterministic route");
  });

  describe("8. transient mute/deaf windows drop bots from candidates", () => {
    test("muted bot is not woken by @mention; peer still wakes", async () => {
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveSilenceForRoom: async () => [{ botActorId: NOVA, kind: "mute" }],
        }),
        baseCtx({
          message: { content: "@nova hi" },
          members: [
            user(USER_ACTOR_ID),
            agent(NOVA, "nova", "active"),
            agent(ALEPO, "alepo", "active"),
          ],
        }),
      );
      expectSilent(decision, "no deterministic route");
    });

    test("deaf bot is not woken by @mention", async () => {
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveSilenceForRoom: async () => [{ botActorId: null, kind: "deaf" }],
        }),
        baseCtx({
          message: { content: "@nova hi" },
          members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
        }),
      );
      expectSilent(decision, "no deterministic route");
    });

    test("per-bot mute does not block unmuted peer on explicit @mention", async () => {
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveSilenceForRoom: async () => [{ botActorId: NOVA, kind: "mute" }],
        }),
        baseCtx({
          message: { content: "@alepo hi" },
          members: [
            user(USER_ACTOR_ID),
            agent(NOVA, "nova", "active"),
            agent(ALEPO, "alepo", "active"),
          ],
        }),
      );
      expectWake(decision, { botActorIds: [ALEPO], source: "mention" });
    });

    test("empty windows is a NO-OP — does not filter candidates", async () => {
      let queryCount = 0;
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveSilenceForRoom: async () => {
            queryCount += 1;
            return [];
          },
        }),
        baseCtx({
          message: { content: "@nova hi" },
          members: [
            user(USER_ACTOR_ID),
            agent(NOVA, "nova", "active"),
            agent(ALEPO, "alepo", "active"),
          ],
        }),
      );
      expect(queryCount).toBe(1);
      expectWake(decision, { botActorIds: [NOVA], source: "mention" });
    });

    test("room-wide mute drops every bot with one query", async () => {
      let queryCount = 0;
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveSilenceForRoom: async () => {
            queryCount += 1;
            return [{ botActorId: null, kind: "mute" }];
          },
        }),
        baseCtx({
          message: { content: "@alepo hi" },
          members: [
            user(USER_ACTOR_ID),
            agent(NOVA, "nova", "active"),
            agent(ALEPO, "alepo", "active"),
          ],
        }),
      );
      expect(queryCount).toBe(1);
      expectSilent(decision, "no deterministic route");
    });
  });

  describe("9. observe (mute) agents are never woken", () => {
    const OBSERVE = "actor-observe";
    const observeHandle = "muted";

    test("not by @mention when only observe agent in room", async () => {
      const decision = await routeRoomMessage(
        defaultDeps(),
        baseCtx({
          message: { content: `@${observeHandle} hi` },
          members: [user(USER_ACTOR_ID), agent(OBSERVE, observeHandle, "observe")],
        }),
      );
      expectSilent(decision, "no deterministic route");
    });

    test("not by reply", async () => {
      const decision = await routeRoomMessage(
        defaultDeps({
          resolveReplyTargetActorId: async () => OBSERVE,
        }),
        baseCtx({
          message: { content: "reply", replyToMessageId: 5 },
          members: [user(USER_ACTOR_ID), agent(OBSERVE, observeHandle, "observe")],
        }),
      );
      expectSilent(decision, "no deterministic route");
    });

    test("not by UI selection", async () => {
      const decision = await routeRoomMessage(
        defaultDeps(),
        baseCtx({
          message: { content: "pick", uiSelectedBotActorId: OBSERVE },
          members: [user(USER_ACTOR_ID), agent(OBSERVE, observeHandle, "observe")],
        }),
      );
      expectSilent(decision, "no deterministic route");
    });

    test("not by active focus (filtered from candidates)", async () => {
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveFoci: async () => [activeFocus(OBSERVE, "mention")],
        }),
        baseCtx({
          message: { content: "continuing thread" },
          members: [user(USER_ACTOR_ID), agent(OBSERVE, observeHandle, "observe")],
        }),
      );
      expectSilent(decision, "no deterministic route");
    });
  });

  describe("10. active mode bot", () => {
    test("woken by explicit mention", async () => {
      const decision = await routeRoomMessage(
        defaultDeps(),
        baseCtx({
          message: { content: "@nova ping" },
          members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
        }),
      );
      expectWake(decision, { botActorIds: [NOVA], source: "mention" });
    });

    test("woken by single active focus", async () => {
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveFoci: async () => [activeFocus(NOVA)],
        }),
        baseCtx({
          message: { content: "ambient" },
          members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
        }),
      );
      expectWake(decision, {
        botActorIds: [NOVA],
        source: "inferred",
        reason: "single active focus",
      });
    });
  });

  describe("11. mention_only mode bot", () => {
    test("woken by explicit mention", async () => {
      const decision = await routeRoomMessage(
        defaultDeps(),
        baseCtx({
          message: { content: "@nova question" },
          members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "mention_only")],
        }),
      );
      expectWake(decision, { botActorIds: [NOVA], source: "mention" });
    });

    test("woken by single active focus", async () => {
      const decision = await routeRoomMessage(
        defaultDeps({
          loadActiveFoci: async () => [activeFocus(NOVA, "mention")],
        }),
        baseCtx({
          message: { content: "no at-sign" },
          members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "mention_only")],
        }),
      );
      expectWake(decision, {
        botActorIds: [NOVA],
        source: "inferred",
        reason: "single active focus",
      });
    });

    test("bare ambient message without focus stays silent", async () => {
      const decision = await routeRoomMessage(
        defaultDeps(),
        baseCtx({
          message: { content: "hello room" },
          members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "mention_only")],
        }),
      );
      expectSilent(decision, "no deterministic route");
    });
  });

  describe("12. writeFocus flag", () => {
    test("every wake decision has writeFocus true", async () => {
      const cases: Promise<ConductorDecision>[] = [
        routeRoomMessage(
          defaultDeps(),
          baseCtx({
            message: { content: "@nova hi" },
            members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
          }),
        ),
        routeRoomMessage(
          defaultDeps({ loadActiveFoci: async () => [activeFocus(NOVA)] }),
          baseCtx({
            message: { content: "follow-up" },
            members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
          }),
        ),
      ];
      for (const p of cases) {
        const d = await p;
        expect(d.kind).toBe("wake");
        if (d.kind === "wake") expect(d.writeFocus).toBe(true);
      }
    });

    test("silent decisions have no writeFocus field", async () => {
      const d = await routeRoomMessage(
        defaultDeps(),
        baseCtx({
          message: { content: "ambient" },
          members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "mention_only")],
        }),
      );
      expectSilent(d);
    });
  });
});

describe("routeRoomMessage direct-address route (D299 P1)", () => {
  const JEANNIE = "actor-jeannie";
  const JEANNIE_B = "actor-jeannie-b";

  function jeannie() {
    return {
      ...agent(JEANNIE, "jeannie-bot", "mention_only"),
      displayName: "Jeannie",
    };
  }

  test("comma form wakes unique mention_only bot with vocative reason", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
  });

  test("space form wakes unique mention_only bot", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "Jeannie are you around?" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
  });

  test("hey comma form wakes unique mention_only bot", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "hey Jeannie, are you around?" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
  });

  test("mid-sentence name stays silent for mention_only bot", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "I was talking about Jeannie yesterday" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectSilent(decision, "no deterministic route");
  });

  test("two matching Jeannies return ask_user, not arbitrary wake", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [
          user(USER_ACTOR_ID),
          {
            kind: "agent",
            actorId: JEANNIE,
            agentId: "agent-a",
            handle: "jeannie-a",
            displayName: "Jeannie",
            agentResponseMode: "mention_only",
          },
          {
            kind: "agent",
            actorId: JEANNIE_B,
            agentId: "agent-b",
            handle: "jeannie-b",
            displayName: "Jeannie",
            agentResponseMode: "mention_only",
          },
        ],
      }),
    );
    expectAskUser(decision, {
      botActorIds: [JEANNIE, JEANNIE_B],
      reason: "vocative: ambiguous direct address",
    });
  });

  test("muted bot is not a direct-address candidate", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveSilenceForRoom: async () => [
          { botActorId: JEANNIE, kind: "mute" },
        ],
      }),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectSilent(decision, "no deterministic route");
  });

  test("observe bot is not a direct-address candidate", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [
          user(USER_ACTOR_ID),
          agent(JEANNIE, "jeannie-bot", "observe"),
        ],
      }),
    );
    expectSilent(decision, "no deterministic route");
  });

  test("explicit @mention still wins over direct address", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "@jeannie-bot quick question" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "mention",
      reason: "mention",
    });
  });

  test("direct address wins over single active focus (vocative overrides focus)", async () => {
    const NOVA = "actor-nova";
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(NOVA, "mention")],
      }),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [
          user(USER_ACTOR_ID),
          agent(NOVA, "nova", "active"),
          jeannie(),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
  });

  test("active Jeannie focus + unique Alepo vocative wakes Alepo (reason=vocative)", async () => {
    const ALEPO = "actor-alepo";
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(JEANNIE, "mention")],
      }),
      baseCtx({
        message: { content: "Alepo are you around?" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
          agent(ALEPO, "alepo", "active"),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [ALEPO],
      source: "inferred",
      reason: "vocative",
    });
  });

  test("direct address runs before history evidence", async () => {
    let searched = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => {
          searched = true;
          return [];
        },
      }),
      baseCtx({
        message: { content: "Jeannie, what did we decide?", searchHistoryFlag: true },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
    expect(searched).toBe(false);
  });

  test("Floor Manager is not called on unique direct-address wake", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: { content: "Jeannie, ping" },
        members: [
          user(USER_ACTOR_ID),
          jeannie(),
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
    expect(floorCalled).toBe(false);
  });
});

describe("routeRoomMessage history-evidence route (M135 P7 / D-B)", () => {
  const NOVA = "actor-nova";
  const ALEPO = "actor-alepo";

  function histHit(authorActorId: string, handle: string) {
    return {
      messageId: 1,
      ts: new Date(),
      authorDisplayName: handle,
      handle,
      authorActorId,
      snippet: "s",
    };
  }

  test("single active focus (step 5) wins over history route (step 6)", async () => {
    let searched = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(NOVA, "mention")],
        searchRoomHistory: async () => {
          searched = true;
          return [histHit(ALEPO, "alepo")];
        },
      }),
      baseCtx({
        message: { content: "follow-up", searchHistoryFlag: true },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expectWake(decision, { botActorIds: [NOVA], source: "inferred", reason: "single active focus" });
    expect(searched).toBe(false);
  });

  test("history single-owner routes deterministically without the Floor Manager", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => [histHit(NOVA, "nova")],
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: { content: "what did we decide?", searchHistoryFlag: true },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expectWake(decision, { botActorIds: [NOVA], source: "inferred", reason: "history single-owner" });
    expect(floorCalled).toBe(false);
  });

  test("history multi-owner defers to the Floor Manager", async () => {
    let floorCalled = false;
    let evidenceCandidateIds: string[] = [];
    let initialHitCount = 0;
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => [histHit(NOVA, "nova"), histHit(ALEPO, "alepo")],
        floorManager: async (_ctx, extra) => {
          floorCalled = true;
          evidenceCandidateIds = (extra.historyEvidenceCandidates ?? []).map(
            (m) => m.actorId,
          );
          initialHitCount = extra.initialSearchHits?.length ?? 0;
          return { kind: "silent", reason: "fm-deferred" };
        },
      }),
      baseCtx({
        message: { content: "ambiguous past q", searchHistoryFlag: true },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expect(floorCalled).toBe(true);
    expect(evidenceCandidateIds.sort()).toEqual([ALEPO, NOVA].sort());
    expect(initialHitCount).toBe(2);
    expectSilent(decision, "fm-deferred");
  });

  test("no history signal → search is never consulted", async () => {
    let searched = false;
    await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => {
          searched = true;
          return [];
        },
      }),
      baseCtx({
        message: { content: "plain ambient" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
      }),
    );
    expect(searched).toBe(false);
  });

  test("Floor Manager dep is NOT called on the explicit @mention path", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: { content: "@nova hi" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
      }),
    );
    expectWake(decision, { botActorIds: [NOVA], source: "mention" });
    expect(floorCalled).toBe(false);
  });
});

describe("routeRoomMessage history-intent route (D299 P2)", () => {
  const NOVA = "actor-nova";
  const ALEPO = "actor-alepo";

  function histHit(authorActorId: string, handle: string) {
    return {
      messageId: 1,
      ts: new Date(),
      authorDisplayName: handle,
      handle,
      authorActorId,
      snippet: "s",
    };
  }

  test("history-intent single-owner routes with history-intent reason", async () => {
    let searchedQuery = "";
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async (_roomId, query) => {
          searchedQuery = query;
          return [histHit(NOVA, "nova")];
        },
      }),
      baseCtx({
        message: {
          content: "who was I talking with about the deploy pipeline?",
        },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "history-intent",
    });
    expect(searchedQuery).toBe("deploy pipeline");
  });

  test("history-intent multi-owner returns ask_user, not arbitrary wake", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => [histHit(NOVA, "nova"), histHit(ALEPO, "alepo")],
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: { content: "what did we decide about the budget?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expectAskUser(decision, {
      botActorIds: [NOVA, ALEPO],
      reason: "history-intent: ambiguous owner",
    });
    expect(floorCalled).toBe(false);
  });

  test("D302 debug — history event includes hit summaries and owner candidates", async () => {
    const debugEvents: Array<{ phase: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        onDebug: (event) => debugEvents.push(event),
        searchRoomHistory: async () => [
          { ...histHit(NOVA, "nova"), messageId: 101, snippet: "stock crash answer" },
          { ...histHit(USER_ACTOR_ID, "alex"), messageId: 102, snippet: "stock crash question" },
        ],
      }),
      baseCtx({
        message: { content: "who was I talking to about the stock crash?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "history-intent",
    });
    const historyEvent = debugEvents.find((event) => event.phase === "history");
    expect(historyEvent?.detail).toMatchObject({
      query: "stock crash",
      hitCount: 2,
      ownerResolved: true,
      ownerHandle: "@nova",
      ownerCandidateHandles: ["@nova"],
    });
    expect(JSON.stringify(historyEvent?.detail)).toContain("stock crash answer");
  });

  test("history-intent searches a wider window and excludes current source message", async () => {
    let requestedLimit = 0;
    const currentId = 200;
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async (_roomId, _query, limit) => {
          requestedLimit = limit;
          return [
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: currentId, snippet: "Who was I talking to about the stock crash?" },
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: 199, snippet: "Who was I talking to about the stock crash?" },
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: 198, snippet: "Who was I talking to about the stock crash?" },
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: 197, snippet: "Who was I talking to about the stock crash?" },
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: 196, snippet: "What agent was I talking to about the stock crash?" },
            { ...histHit(NOVA, "nova"), messageId: 195, snippet: "SOXL recovered after the stock crash" },
          ];
        },
      }),
      baseCtx({
        message: {
          content: "who was I talking to about the stock crash?",
          sourceMessageId: currentId,
        },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expect(requestedLimit).toBe(20);
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "history-intent",
    });
  });

  test("history-intent tolerates emphasis and keeps stable topic terms", async () => {
    let searchedQuery = "";
    const currentId = 300;
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async (_roomId, query, _limit) => {
          searchedQuery = query;
          return [
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: currentId, snippet: "Who the fuck was I talking to about the stock crash earlier?" },
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: 299, snippet: "Who was I talking to about the damn stock crash?" },
            { ...histHit(NOVA, "nova"), messageId: 298, snippet: "SOXL recovered after the stock crash" },
          ];
        },
      }),
      baseCtx({
        message: {
          content: "Who the fuck was I talking to about the stock crash earlier?",
          sourceMessageId: currentId,
        },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    expect(searchedQuery).toBe("stock crash");
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "history-intent",
    });
  });

  test("history-intent no-owner / no-hit stays silent when Floor Manager absent", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => [],
      }),
      baseCtx({
        message: { content: "where were we discussing the auth callback?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
      }),
    );
    expectSilent(decision, "no deterministic route");
  });

  test("history-intent no-owner / no-hit falls through to Floor Manager when configured", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => [],
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: { content: "where were we discussing the auth callback?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
      }),
    );
    expect(floorCalled).toBe(true);
    expectSilent(decision, "fm");
  });

  test("advanced baseline history search can route without history-intent regex", async () => {
    let floorCalled = false;
    const currentId = 400;
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        searchRoomHistory: async (_roomId, query, limit) => {
          expect(query).toBe("Can someone tell me about the stock crash?");
          expect(limit).toBe(20);
          return [
            { ...histHit(USER_ACTOR_ID, "alex"), messageId: currentId, snippet: "Can someone tell me about the stock crash?" },
            { ...histHit(NOVA, "nova"), messageId: 399, snippet: "SOXL recovered after the stock crash" },
          ];
        },
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: {
          content: "Can someone tell me about the stock crash?",
          sourceMessageId: currentId,
        },
        members: [
          user(USER_ACTOR_ID),
          agent(NOVA, "nova", "mention_only"),
          agent(ALEPO, "alepo", "mention_only"),
        ],
      }),
    );
    expect(floorCalled).toBe(false);
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "history baseline single-owner",
    });
  });

  test("standard mode does not run baseline history search for non-intent messages", async () => {
    let searched = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "standard",
        searchRoomHistory: async () => {
          searched = true;
          return [];
        },
        floorManager: async () => ({ kind: "silent", reason: "fm" }),
      }),
      baseCtx({
        message: { content: "Can someone tell me about the stock crash?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      }),
    );
    expect(searched).toBe(false);
    expectSilent(decision, "fm");
  });

  test("direct-address still wins and skips history search", async () => {
    let searched = false;
    const JEANNIE = "actor-jeannie";
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => {
          searched = true;
          return [histHit(NOVA, "nova")];
        },
      }),
      baseCtx({
        message: { content: "Jeannie, what did we decide about the budget?" },
        members: [
          user(USER_ACTOR_ID),
          {
            kind: "agent",
            actorId: JEANNIE,
            agentId: "agent-jeannie",
            handle: "jeannie-bot",
            displayName: "Jeannie",
            agentResponseMode: "mention_only",
          },
        ],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
    expect(searched).toBe(false);
  });

  test("structural searchHistoryFlag still uses history single-owner reason", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => [histHit(NOVA, "nova")],
      }),
      baseCtx({
        message: { content: "what did we decide?", searchHistoryFlag: true },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
      }),
    );
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "history single-owner",
    });
  });

  test("non-intent ambient message does not trigger search", async () => {
    let searched = false;
    await routeRoomMessage(
      defaultDeps({
        searchRoomHistory: async () => {
          searched = true;
          return [];
        },
      }),
      baseCtx({
        message: { content: "hello room" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova")],
      }),
    );
    expect(searched).toBe(false);
  });
});

describe("routeRoomMessage advanced mode (D302 P1)", () => {
  const JEANNIE = "actor-jeannie";

  function jeannie() {
    return {
      ...agent(JEANNIE, "jeannie-bot", "mention_only"),
      displayName: "Jeannie",
    };
  }

  test("0-match message in all-mention_only room passes arbitrationCandidates to Floor Manager", async () => {
    let arbitrationCandidateIds: string[] | undefined;
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        floorManager: async (_ctx, extra) => {
          arbitrationCandidateIds = (extra.arbitrationCandidates ?? []).map(
            (member) => member.actorId,
          );
          return { kind: "silent", reason: "fm-advanced" };
        },
      }),
      baseCtx({
        message: { content: "Can anyone help me with this?" },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expect(arbitrationCandidateIds).toEqual([JEANNIE]);
    expectSilent(decision, "fm-advanced");
  });

  test("unique vocative still fast-path wakes in advanced mode", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
    expect(floorCalled).toBe(false);
  });

  test("standard mode 0-match message does not pass arbitrationCandidates", async () => {
    let arbitrationCandidateIds: string[] | undefined = ["unset"];
    const decision = await routeRoomMessage(
      defaultDeps({
        floorManager: async (_ctx, extra) => {
          arbitrationCandidateIds = extra.arbitrationCandidates?.map(
            (member) => member.actorId,
          );
          return { kind: "silent", reason: "fm-standard" };
        },
      }),
      baseCtx({
        message: { content: "hello room" },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expect(arbitrationCandidateIds).toBeUndefined();
    expectSilent(decision, "fm-standard");
  });
});

describe("routeRoomMessage addressivity gate (D302 P3 / R4)", () => {
  const JEANNIE = "actor-jeannie";

  function jeannie() {
    return {
      ...agent(JEANNIE, "jeannie-bot", "mention_only"),
      displayName: "Jeannie",
    };
  }

  test("advanced mode: ambient low-addressivity message silences without Floor Manager", async () => {
    let floorCalled = false;
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => {
          traces.push({ step, detail });
        },
        floorManager: async () => {
          floorCalled = true;
          throw new Error("floorManager must not be called");
        },
      }),
      baseCtx({
        message: {
          content: "They were talking about the weather earlier today.",
        },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expectSilent(decision, "addressivity: below threshold");
    expect(floorCalled).toBe(false);
    const addressivityTrace = traces.find((t) => t.step === "addressivity");
    expect(addressivityTrace).toBeDefined();
    expect(addressivityTrace!.detail["bought"]).toBe(false);
    expect(addressivityTrace!.detail["signals"]).toBeDefined();
  });

  test("advanced mode: high-addressivity message reaches Floor Manager", async () => {
    let floorCalled = false;
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => {
          traces.push({ step, detail });
        },
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm-bought" };
        },
      }),
      baseCtx({
        message: { content: "Are you available to help with this?" },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expect(floorCalled).toBe(true);
    expectSilent(decision, "fm-bought");
    const addressivityTrace = traces.find((t) => t.step === "addressivity");
    expect(addressivityTrace).toBeDefined();
    expect(addressivityTrace!.detail["bought"]).toBe(true);
  });

  test("standard mode: addressivity gate does not run on ambient message", async () => {
    let floorCalled = false;
    const traces: string[] = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        onTrace: (step) => {
          traces.push(step);
        },
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm-standard-ambient" };
        },
      }),
      baseCtx({
        message: {
          content: "They were talking about the weather earlier today.",
        },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expect(floorCalled).toBe(true);
    expectSilent(decision, "fm-standard-ambient");
    expect(traces.includes("addressivity")).toBe(false);
  });
});

describe("routeRoomMessage routing packet (D302 P6b)", () => {
  const JEANNIE = "actor-jeannie";

  function jeannie() {
    return agent(JEANNIE, "jeannie-bot", "mention_only");
  }

  test("advanced: loadRoutingPacket dep is called and passed to Floor Manager", async () => {
    let packetCalled = false;
    let packetPassed = false;
    const samplePacket = {
      presence: [{ user: "Alex", lastSeenMs: 60_000, hasRead: true }],
      replyTargets: [{ fromUser: "Alex", toBot: "@jeannie-bot" }],
      tempo: { msgsLastWindow: 2, lastMessageAgoMs: 30_000 },
      recentCounterparts: [],
    };
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        loadRoutingPacket: async () => {
          packetCalled = true;
          return samplePacket;
        },
        floorManager: async (_ctx, extra) => {
          packetPassed = extra.routingPacket === samplePacket;
          return { kind: "silent", reason: "fm-packet" };
        },
      }),
      baseCtx({
        message: { content: "Jeannie, can you help with the report?" },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expect(packetCalled).toBe(true);
    expect(packetPassed).toBe(true);
    expectSilent(decision, "fm-packet");
  });

  test("advanced: routing packet failure traces but does not block Floor Manager", async () => {
    let floorCalled = false;
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => traces.push({ step, detail }),
        loadRoutingPacket: async () => {
          throw new Error("db unavailable");
        },
        floorManager: async (_ctx, extra) => {
          floorCalled = true;
          expect(extra.routingPacket).toBeUndefined();
          return { kind: "silent", reason: "fm-after-packet-fail" };
        },
      }),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expect(floorCalled).toBe(true);
    expectSilent(decision, "fm-after-packet-fail");
    const packetTrace = traces.find((t) => t.step === "routing-packet");
    expect(packetTrace).toBeDefined();
    expect(packetTrace!.detail["failed"]).toBe(true);
  });

  test("advanced: reply targets raise relational-recency for addressivity gate", async () => {
    let floorCalled = false;
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => traces.push({ step, detail }),
        loadRoutingPacket: async () => ({
          presence: [],
          replyTargets: [{ fromUser: "Alex", toBot: "@jeannie-bot" }],
          tempo: { msgsLastWindow: 1, lastMessageAgoMs: 10_000 },
          recentCounterparts: [],
        }),
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm-relational" };
        },
      }),
      baseCtx({
        message: { content: "They were talking about the weather earlier today." },
        members: [user(USER_ACTOR_ID), jeannie()],
      }),
    );
    expect(floorCalled).toBe(true);
    expectSilent(decision, "fm-relational");
    const addressivityTrace = traces.find((t) => t.step === "addressivity");
    expect(addressivityTrace).toBeDefined();
    expect(addressivityTrace!.detail["bought"]).toBe(true);
    const signals = addressivityTrace!.detail["signals"] as Record<string, number>;
    expect(signals["relationalRecency"]).toBe(1);
  });
});

describe("routeRoomMessage human-vocative suppression (D302 R13)", () => {
  const CASEY = "actor-casey";
  const JEANNIE_BOT = "actor-jeannie-bot";

  function casey(): RoomMemberView {
    return { kind: "user", actorId: CASEY, handle: "casey", displayName: "Casey" };
  }
  function botJeannie(): RoomMemberView {
    return {
      ...agent(JEANNIE_BOT, "jeannie", "mention_only"),
      displayName: "Jeannie",
    };
  }

  test("advanced: leading human vocative → silent, no FM call, traced", async () => {
    let floorCalled = false;
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => traces.push({ step, detail }),
        floorManager: async () => {
          floorCalled = true;
          throw new Error("FM must not be called for a human-addressed message");
        },
      }),
      baseCtx({
        message: { content: "Casey, are you around?" },
        members: [user(USER_ACTOR_ID), casey(), botJeannie()],
      }),
    );
    expectSilent(decision, "human-addressed");
    expect(floorCalled).toBe(false);
    const t = traces.find((x) => x.step === "human-vocative");
    expect(t).toBeDefined();
    expect(t!.detail["matched"]).toBe("Casey");
  });

  test("advanced: leading human vocative silences even with an active bot focus", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        loadActiveFoci: async () => [activeFocus(JEANNIE_BOT, "mention")],
        floorManager: async () => {
          floorCalled = true;
          throw new Error("FM must not be called for a human-addressed message");
        },
      }),
      baseCtx({
        message: { content: "Casey, are you around?" },
        members: [user(USER_ACTOR_ID), casey(), botJeannie()],
      }),
    );
    expectSilent(decision, "human-addressed");
    expect(floorCalled).toBe(false);
  });

  test("advanced: name collision (human Jeannie + @jeannie) does NOT human-silence", async () => {
    const human = (): RoomMemberView => ({
      kind: "user",
      actorId: "actor-human-jeannie",
      handle: "jeannie-h",
      displayName: "Jeannie",
    });
    const decision = await routeRoomMessage(
      defaultDeps({ mode: "advanced" }),
      baseCtx({
        message: { content: "Jeannie, are you around?" },
        members: [user(USER_ACTOR_ID), human(), botJeannie()],
      }),
    );
    // Collision → falls through to the bot-vocative fast-path → wakes the bot.
    expectWake(decision, { botActorIds: [JEANNIE_BOT], source: "inferred", reason: "vocative" });
  });

  test("advanced: sender self-vocative is not human-suppressed", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm-reached" };
        },
      }),
      // ctx sender IS Casey → her own "Casey …" must not suppress.
      baseCtx({
        userActorId: CASEY,
        message: { content: "Casey, note to self: ping the team?" },
        members: [casey(), botJeannie()],
      }),
    );
    expect(decision.kind).not.toBe("wake");
    if (decision.kind === "silent") {
      expect(decision.reason).not.toBe("human-addressed");
    }
    // It reached the gate/FM rather than the human-vocative short-circuit.
    expect(floorCalled).toBe(true);
  });

  test("standard: human vocative does NOT suppress (dumb-and-predictable)", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm-standard" };
        },
      }),
      baseCtx({
        message: { content: "Casey, are you around?" },
        // active-mode bot so standard's wake set is non-empty → FM is consulted.
        members: [user(USER_ACTOR_ID), casey(), agent("actor-active-bot", "nova", "active")],
      }),
    );
    expect(floorCalled).toBe(true);
    expectSilent(decision, "fm-standard");
  });
});

describe("routeRoomMessage explicit human @mention suppression (D454)", () => {
  const CASEY = "actor-casey";
  const JEANNIE_BOT = "actor-jeannie-bot";

  function casey(): RoomMemberView {
    return { kind: "user", actorId: CASEY, handle: "casey", displayName: "Casey" };
  }
  function botJeannie(): RoomMemberView {
    return agent(JEANNIE_BOT, "jeannie", "mention_only");
  }

  for (const mode of ["standard", "advanced"] as const) {
    test(`${mode}: explicit non-sender human @mention silences before focus and FM`, async () => {
      let floorCalled = false;
      const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
      const decision = await routeRoomMessage(
        defaultDeps({
          mode,
          onTrace: (step, detail) => traces.push({ step, detail }),
          loadActiveFoci: async () => [activeFocus(JEANNIE_BOT, "mention")],
          floorManager: async () => {
            floorCalled = true;
            throw new Error("FM must not be called for an explicit human mention");
          },
        }),
        baseCtx({
          message: { content: "@casey I edited the document." },
          members: [user(USER_ACTOR_ID), casey(), botJeannie()],
        }),
      );
      expectSilent(decision, "human-addressed");
      expect(floorCalled).toBe(false);
      expect(traces.map((trace) => trace.step)).toEqual(["filters", "human-mention"]);
      expect(traces[1]!.detail).toEqual({ count: 1 });
    });
  }

  test("mixed explicit human and eligible agent mentions preserve agent precedence", async () => {
    const decision = await routeRoomMessage(
      defaultDeps(),
      baseCtx({
        message: { content: "@casey @jeannie can you both review this?" },
        members: [user(USER_ACTOR_ID), casey(), botJeannie()],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE_BOT],
      source: "mention",
      reason: "mention",
    });
  });

  test("human mention still suppresses when the co-mentioned agent is muted", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveSilenceForRoom: async () => [
          { botActorId: JEANNIE_BOT, kind: "mute" },
        ],
      }),
      baseCtx({
        message: { content: "@casey @jeannie can you review this?" },
        members: [user(USER_ACTOR_ID), casey(), botJeannie()],
      }),
    );
    expectSilent(decision, "human-addressed");
  });

  test("human mention inside a fenced code example does not suppress an active focus", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(JEANNIE_BOT, "mention")],
      }),
      baseCtx({
        message: { content: "Example syntax:\n```\n@casey hello\n```" },
        members: [user(USER_ACTOR_ID), casey(), botJeannie()],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE_BOT],
      source: "inferred",
      reason: "single active focus",
    });
  });

  test("sender self-mention does not suppress an active focus", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(JEANNIE_BOT, "mention")],
      }),
      baseCtx({
        userActorId: CASEY,
        message: { content: "@casey note to self" },
        members: [casey(), botJeannie()],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE_BOT],
      source: "inferred",
      reason: "single active focus",
    });
  });
});

// Stack 202 / D421 Phase 0 — ordered-trace characterization. These tests
// pin the Conductor's evaluation ORDER (direct-address before active
// focus; single active focus before Floor Manager) by recording the
// `onTrace` step sequence, not just the final decision. They are
// characterization tests: no production behavior is changed.
describe("routeRoomMessage ordered trace (D421 Phase 0)", () => {
  const NOVA = "actor-nova";
  const JEANNIE = "actor-jeannie";

  function jeannie(): RoomMemberView {
    return {
      ...agent(JEANNIE, "jeannie-bot", "mention_only"),
      displayName: "Jeannie",
    };
  }

  test("direct-address is evaluated before active focus (trace order + early return)", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(NOVA, "mention")],
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
        onTrace: (step, detail) => traces.push({ step, detail }),
      }),
      baseCtx({
        // "Alepo, are you around?" — a unique vocative that names Alepo,
        // NOT the focused Nova. Direct-address (step 4) must win.
        message: { content: "Alepo, are you around?" },
        members: [
          user(USER_ACTOR_ID),
          agent(NOVA, "nova", "active"),
          agent("actor-alepo", "alepo", "active"),
          jeannie(),
        ],
      }),
    );

    // Final decision is the vocative wake of Alepo, not the focused Nova.
    expectWake(decision, {
      botActorIds: ["actor-alepo"],
      source: "inferred",
      reason: "vocative",
    });
    expect(floorCalled).toBe(false);

    // Ordered trace: filters → direct-address. The direct-address step
    // is emitted with exactly one match and the conductor returns BEFORE
    // emitting the active-focus or floor-manager steps.
    const stepNames = traces.map((t) => t.step);
    expect(stepNames[0]).toBe("filters");
    const directAddressIdx = stepNames.indexOf("direct-address");
    expect(directAddressIdx).toBeGreaterThan(-1);
    expect(traces[directAddressIdx]!.detail["matches"]).toBe(1);
    // Because direct-address resolved, active-focus + floor-manager never run.
    expect(stepNames.includes("active-focus")).toBe(false);
    expect(stepNames.includes("floor-manager")).toBe(false);
  });

  test("no-address bare follow-up with exactly one active focus returns before the Floor Manager", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(NOVA, "mention")],
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
        onTrace: (step, detail) => traces.push({ step, detail }),
      }),
      baseCtx({
        // Bare follow-up: no @handle, no leading vocative — just continuation.
        message: { content: "follow-up without any address" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      }),
    );

    // Single active focus short-circuits to a deterministic wake.
    expectWake(decision, {
      botActorIds: [NOVA],
      source: "inferred",
      reason: "single active focus",
    });
    expect(floorCalled).toBe(false);

    // Ordered trace: filters → direct-address(0) → active-focus(1), then
    // return. The floor-manager step is never emitted.
    const stepNames = traces.map((t) => t.step);
    expect(stepNames[0]).toBe("filters");
    const directAddressIdx = stepNames.indexOf("direct-address");
    const activeFocusIdx = stepNames.indexOf("active-focus");
    expect(directAddressIdx).toBeGreaterThan(-1);
    expect(activeFocusIdx).toBeGreaterThan(-1);
    // direct-address is evaluated BEFORE active-focus.
    expect(directAddressIdx).toBeLessThan(activeFocusIdx);
    expect(traces[directAddressIdx]!.detail["matches"]).toBe(0);
    expect(traces[activeFocusIdx]!.detail["active"]).toBe(1);
    // Floor Manager step is not emitted (the wake returned before it).
    expect(stepNames.includes("floor-manager")).toBe(false);
  });
});

// Stack 202 / D421 Phase 1 — fixture-backed routing matrix. A compact
// table-driven runner around the real `routeRoomMessage` with stubbed deps
// and ordered trace capture. Each fixture declares roster/modes, sender,
// active foci, silence windows, message shape, the expected terminal
// decision/reason, and the expected evaluated trace prefix/absence — so a
// regression is attributable to a policy dimension (precedence or
// wakeability) rather than a single hand-written phrase. These tests do
// NOT duplicate the Phase 0 ordered-trace characterization above; they
// extend coverage to the full deterministic matrix. No production changes.
describe("routeRoomMessage fixture matrix (D421 Phase 1)", () => {
  type FixtureRosterEntry = RoomMemberView;
  interface FixtureSilenceWindow {
    botActorId: string | null;
    kind: SilenceKind;
  }
  interface FixtureActiveFocus {
    botActorId: string;
    openedSource?: ActiveFocus["openedSource"];
  }
  interface RoutingFixture {
    name: string;
    mode?: RouteRoomMessageDeps["mode"];
    sender?: string;
    roster: FixtureRosterEntry[];
    message: {
      content: string;
      replyToMessageId?: number | null;
      uiSelectedBotActorId?: string | null;
      searchHistoryFlag?: boolean | null;
      sourceMessageId?: number | null;
    };
    activeFoci?: FixtureActiveFocus[];
    silence?: FixtureSilenceWindow[];
    replyTargetActorId?: string | null;
    expected: {
      kind: ConductorDecision["kind"];
      botActorIds?: string[];
      source?: "mention" | "reply" | "ui" | "inferred";
      reason: string;
    };
    tracePrefix?: string[];
    traceAbsent?: string[];
    traceDetail?: Record<string, Record<string, unknown>>;
  }

  const NOVA = "actor-nova";
  const ALEPO = "actor-alepo";
  const JEANNIE = "actor-jeannie";
  const JEANNIE_B = "actor-jeannie-b";
  const CASEY = "actor-casey";
  const OBSERVE = "actor-observe";

  function caseyHuman(): RoomMemberView {
    return {
      kind: "user",
      actorId: CASEY,
      handle: "casey",
      displayName: "Casey",
    };
  }

  async function runRoutingFixture(f: RoutingFixture) {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const deps = defaultDeps({
      ...(f.mode ? { mode: f.mode } : {}),
      loadActiveFoci: async () =>
        (f.activeFoci ?? []).map((a) =>
          activeFocus(a.botActorId, a.openedSource ?? "mention"),
        ),
      ...(f.silence
        ? { loadActiveSilenceForRoom: async () => f.silence! }
        : {}),
      ...(f.replyTargetActorId !== undefined
        ? { resolveReplyTargetActorId: async () => f.replyTargetActorId! }
        : {}),
      onTrace: (step, detail) => traces.push({ step, detail }),
    });

    const decision = await routeRoomMessage(
      deps,
      baseCtx({
        ...(f.sender ? { userActorId: f.sender } : {}),
        message: f.message,
        members: f.roster,
      }),
    );

    // 1.1.4 — terminal result (kind + reason; source/botActorIds for wake).
    expect(decision.kind).toBe(f.expected.kind);
    if (f.expected.kind === "wake") {
      if (decision.kind !== "wake") return;
      expect(decision.botActorIds).toEqual(f.expected.botActorIds ?? []);
      if (f.expected.source !== undefined) {
        expect(decision.source).toBe(f.expected.source);
      }
      expect(decision.writeFocus).toBe(true);
      expect(decision.reason).toBe(f.expected.reason);
    } else if (f.expected.kind === "ask_user") {
      if (decision.kind !== "ask_user") return;
      expect(decision.options.map((o) => o.botActorId).sort()).toEqual(
        [...(f.expected.botActorIds ?? [])].sort(),
      );
      expect(decision.reason).toBe(f.expected.reason);
    } else {
      if (decision.kind !== "silent") return;
      expect("writeFocus" in decision).toBe(false);
      expect(decision.reason).toBe(f.expected.reason);
    }

    // 1.1.4 — evaluated-layer ORDER. A final agent ID alone would not catch
    // another focus-before-vocative regression, so pin the trace prefix and
    // the steps that must NOT have been evaluated.
    const stepNames = traces.map((t) => t.step);
    if (f.tracePrefix) {
      expect(stepNames.slice(0, f.tracePrefix.length)).toEqual(f.tracePrefix);
    }
    if (f.traceAbsent) {
      for (const absent of f.traceAbsent) {
        expect(stepNames).not.toContain(absent);
      }
    }
    if (f.traceDetail) {
      for (const [step, partial] of Object.entries(f.traceDetail)) {
        const t = traces.find((x) => x.step === step);
        expect(t).toBeDefined();
        if (t) expect(t.detail).toMatchObject(partial);
      }
    }
  }

  // 1.1.2 — precedence cases. Explicit mention/reply/UI and a unique spoken
  // agent vocative beat an active focus; a leading human vocative suppresses;
  // one vs two active foci resolve differently.
  const precedenceFixtures: RoutingFixture[] = [
    {
      name: "explicit @mention wakes that agent (mention source)",
      roster: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      message: { content: "@nova hi" },
      expected: {
        kind: "wake",
        botActorIds: [NOVA],
        source: "mention",
        reason: "mention",
      },
      tracePrefix: ["filters", "explicit"],
      traceAbsent: ["direct-address", "active-focus", "floor-manager"],
      traceDetail: { explicit: { source: "mention", count: 1 } },
    },
    {
      name: "reply-to-bot wakes resolved target (reply source)",
      roster: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      message: { content: "thanks", replyToMessageId: 5 },
      replyTargetActorId: NOVA,
      expected: {
        kind: "wake",
        botActorIds: [NOVA],
        source: "reply",
        reason: "reply",
      },
      tracePrefix: ["filters", "explicit"],
      traceAbsent: ["direct-address", "active-focus", "floor-manager"],
      traceDetail: { explicit: { source: "reply" } },
    },
    {
      name: "UI selection wakes the picked bot (ui source)",
      roster: [user(USER_ACTOR_ID), agent(ALEPO, "alepo", "active")],
      message: { content: "help me", uiSelectedBotActorId: ALEPO },
      expected: {
        kind: "wake",
        botActorIds: [ALEPO],
        source: "ui",
        reason: "ui",
      },
      tracePrefix: ["filters", "explicit"],
      traceAbsent: ["direct-address", "active-focus", "floor-manager"],
      traceDetail: { explicit: { source: "ui" } },
    },
    {
      name: "unique spoken agent vocative overrides a different active focus",
      roster: [
        user(USER_ACTOR_ID),
        agent(NOVA, "nova", "active"),
        agent(ALEPO, "alepo", "active"),
      ],
      message: { content: "Alepo, are you around?" },
      activeFoci: [{ botActorId: NOVA, openedSource: "mention" }],
      expected: {
        kind: "wake",
        botActorIds: [ALEPO],
        source: "inferred",
        reason: "vocative",
      },
      tracePrefix: ["filters", "direct-address"],
      traceAbsent: ["active-focus", "floor-manager"],
      traceDetail: { "direct-address": { matches: 1 } },
    },
    {
      name: "leading human vocative suppresses (advanced mode, no FM call)",
      mode: "advanced",
      roster: [
        user(USER_ACTOR_ID),
        caseyHuman(),
        { ...agent("actor-bot-jeannie", "jeannie", "mention_only"), displayName: "Jeannie" },
      ],
      message: { content: "Casey, are you around?" },
      expected: { kind: "silent", reason: "human-addressed" },
      tracePrefix: ["filters", "human-vocative"],
      traceAbsent: ["direct-address", "active-focus", "floor-manager"],
      traceDetail: { "human-vocative": { matched: "Casey", count: 1 } },
    },
    {
      name: "one active focus wakes via the don't-re-@ fallback",
      roster: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      message: { content: "follow-up without any address" },
      activeFoci: [{ botActorId: NOVA, openedSource: "mention" }],
      expected: {
        kind: "wake",
        botActorIds: [NOVA],
        source: "inferred",
        reason: "single active focus",
      },
      tracePrefix: ["filters", "direct-address", "active-focus"],
      traceAbsent: ["floor-manager"],
      traceDetail: { "direct-address": { matches: 0 }, "active-focus": { active: 1 } },
    },
    {
      name: "two active foci stay silent (no deterministic route)",
      roster: [
        user(USER_ACTOR_ID),
        agent(NOVA, "nova", "active"),
        agent(ALEPO, "alepo", "active"),
      ],
      message: { content: "ambiguous" },
      activeFoci: [
        { botActorId: NOVA, openedSource: "mention" },
        { botActorId: ALEPO, openedSource: "ui" },
      ],
      expected: { kind: "silent", reason: "no deterministic route" },
      tracePrefix: ["filters", "direct-address", "active-focus", "history", "floor-manager"],
      traceDetail: { "active-focus": { active: 2 }, "floor-manager": { configured: false, called: false } },
    },
  ];

  // 1.1.3 — wakeability cases. Response modes, per-agent and room-wide
  // silence, a missing handle, and same-name ambiguity all fail closed or
  // route deterministically per policy.
  const wakeabilityFixtures: RoutingFixture[] = [
    {
      name: "active-mode bot is woken by explicit @mention",
      roster: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      message: { content: "@nova ping" },
      expected: {
        kind: "wake",
        botActorIds: [NOVA],
        source: "mention",
        reason: "mention",
      },
      tracePrefix: ["filters", "explicit"],
      traceAbsent: ["active-focus", "floor-manager"],
    },
    {
      name: "mention_only-mode bot is woken by explicit @mention",
      roster: [user(USER_ACTOR_ID), agent(NOVA, "nova", "mention_only")],
      message: { content: "@nova question" },
      expected: {
        kind: "wake",
        botActorIds: [NOVA],
        source: "mention",
        reason: "mention",
      },
      tracePrefix: ["filters", "explicit"],
      traceAbsent: ["active-focus", "floor-manager"],
    },
    {
      name: "observe-mode bot is never woken by @mention (fail closed)",
      roster: [user(USER_ACTOR_ID), agent(OBSERVE, "muted", "observe")],
      message: { content: "@muted hi" },
      expected: { kind: "silent", reason: "no deterministic route" },
      tracePrefix: ["filters", "direct-address", "active-focus", "history", "floor-manager"],
      traceDetail: { "floor-manager": { configured: false, called: false } },
    },
    {
      name: "per-agent mute drops the muted bot but a peer still wakes",
      roster: [
        user(USER_ACTOR_ID),
        agent(NOVA, "nova", "active"),
        agent(ALEPO, "alepo", "active"),
      ],
      message: { content: "@nova @alepo hi" },
      silence: [{ botActorId: NOVA, kind: "mute" }],
      expected: {
        kind: "wake",
        botActorIds: [ALEPO],
        source: "mention",
        reason: "mention",
      },
      tracePrefix: ["filters", "explicit"],
      traceAbsent: ["active-focus", "floor-manager"],
      traceDetail: {
        filters: { candidates: 1, coldVolunteer: 1 },
        explicit: { source: "mention", count: 1 },
      },
    },
    {
      name: "per-agent deaf drops the deaf bot (fail closed)",
      roster: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      message: { content: "@nova hi" },
      silence: [{ botActorId: NOVA, kind: "deaf" }],
      expected: { kind: "silent", reason: "no deterministic route" },
      tracePrefix: ["filters", "direct-address", "active-focus", "history", "floor-manager"],
      traceDetail: { "floor-manager": { configured: false, called: false } },
    },
    {
      name: "room-wide silence drops every bot (fail closed)",
      roster: [
        user(USER_ACTOR_ID),
        agent(NOVA, "nova", "active"),
        agent(ALEPO, "alepo", "active"),
      ],
      message: { content: "@alepo hi" },
      silence: [{ botActorId: null, kind: "mute" }],
      expected: { kind: "silent", reason: "no deterministic route" },
      tracePrefix: ["filters", "direct-address", "active-focus", "history", "floor-manager"],
      traceDetail: { "floor-manager": { configured: false, called: false } },
    },
    {
      name: "missing handle does not route (fail closed)",
      roster: [
        user(USER_ACTOR_ID),
        {
          ...agent(NOVA, "", "active"),
          displayName: "Nova",
        },
      ],
      message: { content: "Nova, are you around?" },
      expected: { kind: "silent", reason: "no deterministic route" },
      tracePrefix: ["filters", "direct-address", "active-focus", "history", "floor-manager"],
      traceDetail: {
        filters: { candidates: 1, coldVolunteer: 1 },
        "direct-address": { matches: 0 },
        "floor-manager": { configured: false, called: false },
      },
    },
    {
      name: "same-name agents on a vocative return ask_user, not an arbitrary wake",
      roster: [
        user(USER_ACTOR_ID),
        {
          kind: "agent",
          actorId: JEANNIE,
          agentId: "agent-a",
          handle: "jeannie-a",
          displayName: "Jeannie",
          agentResponseMode: "mention_only",
        },
        {
          kind: "agent",
          actorId: JEANNIE_B,
          agentId: "agent-b",
          handle: "jeannie-b",
          displayName: "Jeannie",
          agentResponseMode: "mention_only",
        },
      ],
      message: { content: "Jeannie, are you around?" },
      expected: {
        kind: "ask_user",
        botActorIds: [JEANNIE, JEANNIE_B],
        reason: "vocative: ambiguous direct address",
      },
      tracePrefix: ["filters", "direct-address"],
      traceAbsent: ["active-focus", "floor-manager"],
      traceDetail: { "direct-address": { matches: 2 } },
    },
    {
      name: "ambient no-route message stays silent (zero-or-one default)",
      roster: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      message: { content: "ambient chatter" },
      expected: { kind: "silent", reason: "no deterministic route" },
      tracePrefix: ["filters", "direct-address", "active-focus", "history", "floor-manager"],
      traceDetail: { "active-focus": { active: 0 }, "floor-manager": { configured: false, called: false } },
    },
  ];

  test.each(precedenceFixtures)("precedence: $name", async (f) => {
    await runRoutingFixture(f);
  });

  test.each(wakeabilityFixtures)("wakeability: $name", async (f) => {
    await runRoutingFixture(f);
  });
});

// Stack 202 / D421 Phase 3 — safe observability. The always-on `onTrace`
// channel must carry counts/booleans/enums only: the raw search query (which
// may be the user's message content) and raw provider/db error text move to
// the opt-in `onDebug` channel, and the routing-packet trace gains a
// recent-counterpart count so a continuation/redirect outcome is diagnosable.
// No production behavior change beyond the trace payload shape.
describe("routeRoomMessage safe trace (D421 Phase 3)", () => {
  const NOVA = "actor-nova";
  const ALEPO = "actor-alepo";

  function histHit(authorActorId: string, handle: string) {
    return {
      messageId: 1,
      ts: new Date(),
      authorDisplayName: handle,
      handle,
      authorActorId,
      snippet: "s",
    };
  }

  test("3.1.1 — routing-packet trace carries a recentCounterparts count", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => traces.push({ step, detail }),
        loadRoutingPacket: async () => ({
          presence: [{ user: "Alex", lastSeenMs: 60_000, hasRead: true }],
          replyTargets: [{ fromUser: "Alex", toBot: "@nova" }],
          tempo: { msgsLastWindow: 2, lastMessageAgoMs: 30_000 },
          recentCounterparts: [
            {
              bot: "@nova",
              lastInteractionAgoMs: 5_000,
              interaction: "message",
              interveningMessages: 0,
            },
            {
              bot: "@alepo",
              lastInteractionAgoMs: 50_000,
              interaction: "reaction",
              interveningMessages: 3,
            },
          ],
        }),
        floorManager: async () => ({ kind: "silent", reason: "fm" }),
      }),
      baseCtx({
        message: { content: "Are you available to help with this?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "mention_only")],
      }),
    );
    const packetTrace = traces.find((t) => t.step === "routing-packet");
    expect(packetTrace).toBeDefined();
    expect(packetTrace!.detail["recentCounterparts"]).toBe(2);
    expect(packetTrace!.detail["presence"]).toBe(1);
    expect(packetTrace!.detail["replyTargets"]).toBe(1);
    expect(packetTrace!.detail["tempo"]).toBe(2);
  });

  test("3.1.3 — history trace drops the raw query; onDebug retains it", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const debugEvents: Array<{ phase: string; detail: Record<string, unknown> }> = [];
    await routeRoomMessage(
      defaultDeps({
        onTrace: (step, detail) => traces.push({ step, detail }),
        onDebug: (event) => debugEvents.push(event),
        searchRoomHistory: async () => [histHit(NOVA, "nova")],
      }),
      baseCtx({
        message: { content: "who was I talking with about the deploy pipeline?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova"), agent(ALEPO, "alepo")],
      }),
    );
    const historyTrace = traces.find((t) => t.step === "history");
    expect(historyTrace).toBeDefined();
    // The raw query (= the user's message content) must NOT appear in the
    // always-on trace, neither as a field value nor anywhere in the payload.
    expect("query" in historyTrace!.detail).toBe(false);
    expect(JSON.stringify(historyTrace!.detail)).not.toContain("deploy pipeline");
    // Counts/booleans/enums are still diagnosable.
    expect(historyTrace!.detail["hits"]).toBe(1);
    expect(historyTrace!.detail["owner"]).toBe(true);
    expect(historyTrace!.detail["intent"]).toBe("who-talking-about");

    // The opt-in debug channel still carries the query for operator diagnosis.
    const historyDebug = debugEvents.find((e) => e.phase === "history");
    expect(historyDebug).toBeDefined();
    expect(historyDebug!.detail["query"]).toBe("deploy pipeline");
  });

  test("3.1.3 — history-baseline trace drops the raw query; onDebug retains it", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const debugEvents: Array<{ phase: string; detail: Record<string, unknown> }> = [];
    const currentId = 400;
    await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => traces.push({ step, detail }),
        onDebug: (event) => debugEvents.push(event),
        searchRoomHistory: async () => [
          { ...histHit(USER_ACTOR_ID, "alex"), messageId: currentId, snippet: "stock crash" },
          { ...histHit(NOVA, "nova"), messageId: 399, snippet: "SOXL recovered" },
        ],
        floorManager: async () => ({ kind: "silent", reason: "fm" }),
      }),
      baseCtx({
        message: {
          content: "Can someone tell me about the stock crash?",
          sourceMessageId: currentId,
        },
        members: [
          user(USER_ACTOR_ID),
          agent(NOVA, "nova", "mention_only"),
          agent(ALEPO, "alepo", "mention_only"),
        ],
      }),
    );
    const baselineTrace = traces.find((t) => t.step === "history-baseline");
    expect(baselineTrace).toBeDefined();
    expect("query" in baselineTrace!.detail).toBe(false);
    expect(JSON.stringify(baselineTrace!.detail)).not.toContain("stock crash");
    // The source message (messageId === currentId) is excluded from the
    // baseline hits, so only the non-source row survives.
    expect(baselineTrace!.detail["hits"]).toBe(1);
    expect(baselineTrace!.detail["rawHits"]).toBe(2);
    expect(baselineTrace!.detail["owner"]).toBe(true);

    const baselineDebug = debugEvents.find((e) => e.phase === "history-baseline");
    expect(baselineDebug).toBeDefined();
    expect(baselineDebug!.detail["query"]).toBe("Can someone tell me about the stock crash?");
  });

  test("3.1.3 — routing-packet failure trace carries only `failed: true`, no raw error; onDebug retains the message", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const debugEvents: Array<{ phase: string; detail: Record<string, unknown> }> = [];
    await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => traces.push({ step, detail }),
        onDebug: (event) => debugEvents.push(event),
        loadRoutingPacket: async () => {
          throw new Error("db unavailable: connection reset by peer");
        },
        floorManager: async () => ({ kind: "silent", reason: "fm" }),
      }),
      baseCtx({
        message: { content: "ambient chatter" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "active")],
      }),
    );
    const packetTrace = traces.find((t) => t.step === "routing-packet");
    expect(packetTrace).toBeDefined();
    expect(packetTrace!.detail["failed"]).toBe(true);
    // No raw error text in the always-on trace.
    expect("error" in packetTrace!.detail).toBe(false);
    expect(JSON.stringify(packetTrace!.detail)).not.toContain("db unavailable");
    expect(JSON.stringify(packetTrace!.detail)).not.toContain("connection reset");

    // The opt-in debug channel retains the controlled detail for diagnosis.
    const packetDebug = debugEvents.find((e) => e.phase === "routing-packet");
    expect(packetDebug).toBeDefined();
    expect(packetDebug!.detail["failed"]).toBe(true);
    expect(packetDebug!.detail["error"]).toBe("db unavailable: connection reset by peer");
  });

  test("3.1.1 — one turn-correlated trace path exposes candidate / active / direct / counterpart / addressivity / terminal", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        onTrace: (step, detail) => traces.push({ step, detail }),
        loadRoutingPacket: async () => ({
          presence: [],
          replyTargets: [{ fromUser: "Alex", toBot: "@nova" }],
          tempo: { msgsLastWindow: 1, lastMessageAgoMs: 10_000 },
          recentCounterparts: [
            {
              bot: "@nova",
              lastInteractionAgoMs: 5_000,
              interaction: "message",
              interveningMessages: 0,
            },
          ],
        }),
        floorManager: async () => ({ kind: "silent", reason: "fm-terminal" }),
      }),
      baseCtx({
        message: { content: "Are you available to help with this?" },
        members: [user(USER_ACTOR_ID), agent(NOVA, "nova", "mention_only")],
      }),
    );

    const filters = traces.find((t) => t.step === "filters");
    const direct = traces.find((t) => t.step === "direct-address");
    const active = traces.find((t) => t.step === "active-focus");
    const packet = traces.find((t) => t.step === "routing-packet");
    const addressivity = traces.find((t) => t.step === "addressivity");
    expect(filters?.detail["candidates"]).toBe(1);
    expect(direct?.detail["matches"]).toBe(0);
    expect(active?.detail["active"]).toBe(0);
    expect(packet?.detail["recentCounterparts"]).toBe(1);
    expect(addressivity?.detail["bought"]).toBe(true);
    // Terminal decision is diagnosable from the trace path + the decision.
    expect(decision.kind).toBe("silent");
  });
});

// D421 Phase 6.1.3 — end-to-end routing characterization for the exact live
// failure sequence. The 2026-07-21 live run showed a natural Jeannie hail
// ("And Jeannie are you around?" / "is Jeannie here?") NOT producing a
// deterministic Jeannie route when Alepo held the active focus or owned the
// recent history baseline. These tests pin the corrected behavior: a unique
// natural named-agent address wakes that agent even when a different agent
// holds the active focus or owns the history baseline. They are the
// regression gate; the live sequence is represented without baking one
// literal phrase into production code.
describe("routeRoomMessage natural named-address regression (D421 6.1.3)", () => {
  const JEANNIE = "actor-jeannie";
  const ALEPO = "actor-alepo";

  function jeannie(): RoomMemberView {
    return {
      ...agent(JEANNIE, "jeannie-bot", "mention_only"),
      displayName: "Jeannie",
    };
  }
  function alepo(): RoomMemberView {
    return agent(ALEPO, "alepo", "active");
  }

  test("natural Jeannie hail wakes Jeannie even when Alepo holds the active focus", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(ALEPO, "mention")],
      }),
      baseCtx({
        message: { content: "And Jeannie are you around?" },
        members: [user(USER_ACTOR_ID), jeannie(), alepo()],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
  });

  test("presence hail 'is Jeannie here?' wakes Jeannie over Alepo active focus", async () => {
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(ALEPO, "mention")],
      }),
      baseCtx({
        message: { content: "is Jeannie here?" },
        members: [user(USER_ACTOR_ID), jeannie(), alepo()],
      }),
    );
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
  });

  test("advanced: natural Jeannie hail wakes Jeannie even when Alepo owns the history baseline", async () => {
    let floorCalled = false;
    const decision = await routeRoomMessage(
      defaultDeps({
        mode: "advanced",
        searchRoomHistory: async () => [
          {
            messageId: 1,
            ts: new Date(),
            authorDisplayName: "alepo",
            handle: "alepo",
            authorActorId: ALEPO,
            snippet: "alepo owned the recent baseline",
          },
        ],
        floorManager: async () => {
          floorCalled = true;
          return { kind: "silent", reason: "fm" };
        },
      }),
      baseCtx({
        message: { content: "Good and now is Jeannie here?" },
        members: [user(USER_ACTOR_ID), jeannie(), alepo()],
      }),
    );
    // The unique named addressee (Jeannie) must win; the Alepo-owned history
    // baseline must NOT deterministically wake Alepo, and the Floor Manager
    // must NOT be reached because the named address resolved first.
    expectWake(decision, {
      botActorIds: [JEANNIE],
      source: "inferred",
      reason: "vocative",
    });
    expect(floorCalled).toBe(false);
  });

  test("live sequence: Jeannie focus → Alepo address → Alepo focus → natural Jeannie hail wakes Jeannie", async () => {
    // Step A: Jeannie holds focus; user addresses Alepo by name → Alepo wakes.
    const stepA = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(JEANNIE, "mention")],
      }),
      baseCtx({
        message: { content: "Alepo are you around?" },
        members: [user(USER_ACTOR_ID), jeannie(), alepo()],
      }),
    );
    expectWake(stepA, { botActorIds: [ALEPO], source: "inferred", reason: "vocative" });

    // Step B: after Alepo was addressed and took focus, a natural Jeannie hail
    // (discourse-prefixed) must still wake Jeannie — Alepo's now-active focus
    // cannot absorb the unique named address.
    const stepB = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(ALEPO, "mention")],
      }),
      baseCtx({
        message: { content: "And Jeannie are you around?" },
        members: [user(USER_ACTOR_ID), jeannie(), alepo()],
      }),
    );
    expectWake(stepB, { botActorIds: [JEANNIE], source: "inferred", reason: "vocative" });
  });

  test("natural named address with conflicting active focus traces direct-address before active-focus", async () => {
    const traces: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const decision = await routeRoomMessage(
      defaultDeps({
        loadActiveFoci: async () => [activeFocus(ALEPO, "mention")],
        onTrace: (step, detail) => traces.push({ step, detail }),
      }),
      baseCtx({
        message: { content: "And Jeannie, what about you?" },
        members: [user(USER_ACTOR_ID), jeannie(), alepo()],
      }),
    );
    expectWake(decision, { botActorIds: [JEANNIE], source: "inferred", reason: "vocative" });
    const stepNames = traces.map((t) => t.step);
    const directIdx = stepNames.indexOf("direct-address");
    const activeIdx = stepNames.indexOf("active-focus");
    expect(directIdx).toBeGreaterThan(-1);
    // direct-address resolved the unique addressee; active-focus never ran.
    expect(activeIdx).toBe(-1);
    expect(traces[directIdx]!.detail["matches"]).toBe(1);
  });
});
