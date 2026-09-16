import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup } from "@testing-library/react";
import { Window } from "happy-dom";
import type { ConductorAskUserEvent, RoomMemberDto } from "@nautilo/types";
import {
  applyConductorAskUserEvent,
  clearAskUserPicker,
  findMessageContentById,
  getAskUserPickerState,
  isAskUserCandidate,
} from "../../src/components/composer/ask-user-state";
import { consumeConductorAskUserWsEvent } from "../../src/adapters/ws-event-ask-user";
import {
  AskUserPicker,
  resolveAskUserOptionLabel,
} from "../../src/components/composer/AskUserPicker";

const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};

mock.module("../../src/components/avatar/UserAvatar", () => ({
  UserAvatar: ({ userId }: { userId: string }) =>
    createElement("span", {
      "data-testid": "user-avatar",
      "data-user-id": userId,
    }),
}));

const human = (
  actorId: string,
  name: string,
  userId = actorId,
  handle?: string,
): RoomMemberDto => ({
  actorId,
  kind: "user",
  displayName: name,
  userId,
  roomRole: "member",
  ...(handle ? { handle } : {}),
});

const agent = (actorId: string, name: string, handle?: string): RoomMemberDto => ({
  actorId,
  kind: "agent",
  displayName: name,
  agentId: actorId,
  roomRole: "member",
  ...(handle ? { handle } : {}),
});

const ROOM = "809996bd-5db4-44a1-875d-82eb9ff84c82";
const BOT_A = "d900b3a1-423d-498f-87ae-292553a6744a";
const BOT_B = "ee834034-1988-4e71-81e8-182354098ac2";

function askUserEvent(
  overrides: Partial<ConductorAskUserEvent> = {},
): ConductorAskUserEvent {
  return {
    type: "conductor.ask_user",
    laneKey: `room:${ROOM}`,
    roomId: ROOM,
    userId: "user-1",
    userActorId: "user-1",
    messageId: "42",
    options: [
      { botActorId: BOT_A, handle: "daria" },
      { botActorId: BOT_B, handle: "nova" },
    ],
    reason: "floor: ambiguous",
    ...overrides,
  };
}

afterEach(() => {
  clearAskUserPicker();
});

describe("ask-user-state — D279 Phase 4", () => {
  test("event with ≥2 options activates picker state", () => {
    applyConductorAskUserEvent(askUserEvent(), "ok and the auth gateway?");
    const snap = getAskUserPickerState();
    expect(snap.active).toBe(true);
    expect(snap.roomId).toBe(ROOM);
    expect(snap.messageId).toBe("42");
    expect(snap.options).toHaveLength(2);
    expect(snap.pendingContent).toBe("ok and the auth gateway?");
    expect(isAskUserCandidate(BOT_A)).toBe(true);
    expect(isAskUserCandidate("ghost")).toBe(false);
  });

  test("empty or single option → no picker (NO-OP guard)", () => {
    applyConductorAskUserEvent(askUserEvent({ options: [] }));
    expect(getAskUserPickerState().active).toBe(false);

    applyConductorAskUserEvent(
      askUserEvent({ options: [{ botActorId: BOT_A, handle: "daria" }] }),
    );
    expect(getAskUserPickerState().active).toBe(false);
  });

  test("findMessageContentById resolves user bubble text", () => {
    const text = findMessageContentById(
      [
        {
          id: "42",
          role: "user",
          content: [{ type: "text", text: "  hello there  " }],
        },
      ],
      "42",
    );
    expect(text).toBe("hello there");
  });
});

describe("consumeConductorAskUserWsEvent — D279 Phase 4", () => {
  test("scoped event applies picker for active room", () => {
    const applied = consumeConductorAskUserWsEvent({
      event: askUserEvent(),
      viewerUserId: "user-1",
      viewerActorId: "user-1",
      activeRoomId: ROOM,
      laneKeyToRoomId: new Map(),
      jobIdToRoomId: new Map(),
      lastStreamLaneKey: null,
      pendingContent: "pick me",
      useWindowBridge: false,
    });
    expect(applied).toBe(true);
    expect(getAskUserPickerState().active).toBe(true);
    expect(getAskUserPickerState().pendingContent).toBe("pick me");
  });

  test("event for another room is ignored", () => {
    consumeConductorAskUserWsEvent({
      event: askUserEvent(),
      viewerUserId: "user-1",
      viewerActorId: "user-1",
      activeRoomId: "other-room",
      laneKeyToRoomId: new Map(),
      jobIdToRoomId: new Map(),
      lastStreamLaneKey: null,
      useWindowBridge: false,
    });
    expect(getAskUserPickerState().active).toBe(false);
  });

  test("event for another signed-in user is ignored even if it reaches this client", () => {
    const applied = consumeConductorAskUserWsEvent({
      event: askUserEvent({ userId: "other-user", userActorId: "other-actor" }),
      viewerUserId: "user-1",
      viewerActorId: "user-1",
      activeRoomId: ROOM,
      laneKeyToRoomId: new Map(),
      jobIdToRoomId: new Map(),
      lastStreamLaneKey: null,
      useWindowBridge: false,
    });
    expect(applied).toBe(false);
    expect(getAskUserPickerState().active).toBe(false);
  });
});

describe("resolveAskUserOptionLabel — D311", () => {
  test("member with distinct displayName → primary + @handle", () => {
    const member = agent(BOT_A, "Daria Assistant", "daria");
    const label = resolveAskUserOptionLabel(
      { botActorId: BOT_A, handle: "daria" },
      member,
    );
    expect(label.primary).toBe("Daria Assistant");
    expect(label.handle).toBe("daria");
    expect(label.suffix).toBe("G");
    expect(label.avatar).toBe("agent");
  });

  test("roster miss → @handle only, no empty primary", () => {
    const label = resolveAskUserOptionLabel(
      { botActorId: BOT_A, handle: "daria" },
      undefined,
    );
    expect(label.primary).toBeNull();
    expect(label.handle).toBe("daria");
    expect(label.suffix).toBe("G");
    expect(label.avatar).toBe("agent");
  });

  test("human member selects user avatar", () => {
    const member = human(BOT_A, "Sender", "user-sender", "sender");
    const label = resolveAskUserOptionLabel(
      { botActorId: BOT_A, handle: "sender" },
      member,
    );
    expect(label.avatar).toBe("user");
    expect(label.suffix).toBe("H");
  });

  test("agent member selects agent avatar", () => {
    const member = agent(BOT_A, "Nova", "nova");
    const label = resolveAskUserOptionLabel(
      { botActorId: BOT_A, handle: "nova" },
      member,
    );
    expect(label.avatar).toBe("agent");
    expect(label.suffix).toBe("G");
  });
});

describe("AskUserPicker — D311 roster labels", () => {
  beforeAll(() => {
    for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
      priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
    }
    Object.assign(globalThis, {
      window: happyWindow,
      document: happyWindow.document,
      navigator: happyWindow.navigator,
      HTMLElement: happyWindow.HTMLElement,
    });
  });

  afterAll(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) {
        delete (globalThis as Record<string, unknown>)[key];
      } else {
        (globalThis as Record<string, unknown>)[key] = value;
      }
    }
  });

  test("renders displayName + @handle when roster member is found", () => {
    const member = agent(BOT_A, "Daria Assistant", "daria");
    const roster = new Map<string, RoomMemberDto>([[BOT_A, member]]);
    const html = renderToStaticMarkup(
      createElement(AskUserPicker, {
        options: [
          { botActorId: BOT_A, handle: "daria" },
          { botActorId: BOT_B, handle: "nova" },
        ],
        pendingContent: null,
        memberByActorId: roster,
        onPick: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("Daria Assistant");
    expect(html).toContain("@daria");
    expect(html).toContain("data-testid=\"mention-agent-avatar\"");
    expect(html).toContain("(G)");
  });

  test("roster miss renders @handle only", () => {
    const html = renderToStaticMarkup(
      createElement(AskUserPicker, {
        options: [
          { botActorId: BOT_A, handle: "daria" },
          { botActorId: BOT_B, handle: "nova" },
        ],
        pendingContent: null,
        memberByActorId: new Map(),
        onPick: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("@daria");
    expect(html).not.toContain("Daria Assistant");
    expect(html).toContain("(G)");
  });

  test("human roster member renders UserAvatar and (H) suffix", () => {
    const member = human(BOT_A, "Sender", "user-sender", "sender");
    const roster = new Map<string, RoomMemberDto>([[BOT_A, member]]);
    const html = renderToStaticMarkup(
      createElement(AskUserPicker, {
        options: [
          { botActorId: BOT_A, handle: "sender" },
          { botActorId: BOT_B, handle: "nova" },
        ],
        pendingContent: null,
        memberByActorId: roster,
        onPick: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("data-testid=\"user-avatar\"");
    expect(html).toContain("data-user-id=\"user-sender\"");
    expect(html).toContain("Sender");
    expect(html).toContain("@sender");
    expect(html).toContain("(H)");
  });
});
