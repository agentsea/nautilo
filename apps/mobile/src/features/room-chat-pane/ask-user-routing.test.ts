import { describe, expect, test } from "bun:test";

import {
  buildAskUserResumeBody,
  filterAskUserCandidates,
  isResumeMessageId,
  isSearchableAskUserChoice,
  projectAskUserRoutingState,
  resolveAskUserCandidates,
} from "./ask-user-routing";

describe("ask_user candidate projection", () => {
  const options = [
    { botActorId: "actor-b", handle: "beta" },
    { botActorId: "actor-a", handle: "alpha" },
  ];

  test("uses only the server-issued option order while enriching from the roster", () => {
    const candidates = resolveAskUserCandidates(options, [
      { actorId: "actor-a", kind: "agent", displayName: "Alpha Genie", handle: "alpha", agentId: "a", roomRole: "member" },
      { actorId: "actor-extra", kind: "agent", displayName: "Must not appear", handle: "extra", agentId: "extra", roomRole: "member" },
    ]);

    expect(candidates.map((candidate) => candidate.botActorId)).toEqual(["actor-b", "actor-a"]);
    expect(candidates[0]).toMatchObject({ displayName: "@beta", displayHandle: "@beta" });
    expect(candidates[1]).toMatchObject({ displayName: "Alpha Genie", displayHandle: "@alpha" });
  });

  test("searches roster labels and safe handle fallbacks without reordering", () => {
    const candidates = resolveAskUserCandidates(options, []);
    expect(filterAskUserCandidates(candidates, "@alpha").map((candidate) => candidate.botActorId)).toEqual(["actor-a"]);
    expect(filterAskUserCandidates(candidates, "").map((candidate) => candidate.botActorId)).toEqual(["actor-b", "actor-a"]);
  });

  test("uses direct choices through five candidates and searchable choices at six or more", () => {
    expect(isSearchableAskUserChoice(2)).toBe(false);
    expect(isSearchableAskUserChoice(5)).toBe(false);
    expect(isSearchableAskUserChoice(6)).toBe(true);
    expect(isSearchableAskUserChoice(100)).toBe(true);
  });

  test("fails closed when a decision has no persisted original message id", () => {
    expect(isResumeMessageId("42")).toBe(true);
    expect(isResumeMessageId("0")).toBe(false);
    expect(isResumeMessageId(null)).toBe(false);
  });

  test("resumes only the exact persisted message with the selected issued actor", () => {
    expect(buildAskUserResumeBody({
      messageId: "42",
      resumeTurnId: "turn-42",
      originalContent: "Original message, not the current draft",
    }, "actor-b")).toEqual({
      content: "Original message, not the current draft",
      uiSelectedBotActorId: "actor-b",
      resumeTurnId: "turn-42",
      resumeMessageId: 42,
    });
  });

  test("canonical conductor.ask_user alone opens the chooser and its decision counterpart is idempotent", () => {
    const scope = {
      serverId: "server-1",
      viewerUserId: "user-1",
      viewerActorId: "actor-user-1",
      roomId: "room-1",
    };
    const askUser = {
      roomId: "room-1",
      userId: "user-1",
      userActorId: "actor-user-1",
      messageId: "42",
      humanTurnId: "turn-42",
      options,
    };
    const opened = projectAskUserRoutingState(askUser, scope, "Persisted original", null);

    expect(opened).toMatchObject({
      messageId: "42",
      resumeTurnId: "turn-42",
      options,
      selectingActorId: null,
    });

    const selecting = { ...opened!, selectingActorId: "actor-b" };
    const decisionCounterpart = projectAskUserRoutingState(askUser, scope, "Persisted original", selecting);
    expect(decisionCounterpart).toBe(selecting);
    expect(decisionCounterpart?.selectingActorId).toBe("actor-b");
  });

  test("rejects a chooser issued for another signed-in user", () => {
    const scope = {
      serverId: "server-1",
      viewerUserId: "user-1",
      viewerActorId: "actor-user-1",
      roomId: "room-1",
    };
    expect(projectAskUserRoutingState({
      roomId: "room-1",
      userId: "user-2",
      userActorId: "actor-user-2",
      messageId: "42",
      options,
    }, scope, "Persisted original", null)).toBeNull();
  });
});
