import { describe, expect, test } from "bun:test";

import {
  INVITE_COMPLETION_NOTICE,
  decideInviteLanding,
  resolveInviteLanding,
} from "./invite-landing";

const exactServer = { id: "srv_invites", serverUrl: "https://invites.example.test" };
const input = { ceremonyServerId: exactServer.id, landingRoomId: "room-invite" };

describe("invite landing", () => {
  test("opens only the exact landing Room from the canonical readable directory", () => {
    expect(decideInviteLanding({ ...input, activeServerId: exactServer.id, readableRoomIds: ["room-other", "room-invite"] }))
      .toEqual({ kind: "room", roomId: "room-invite" });
  });

  test("falls back when the returned Room is absent or no destination was returned", () => {
    expect(decideInviteLanding({ ...input, activeServerId: exactServer.id, readableRoomIds: ["room-other"] }))
      .toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
    expect(decideInviteLanding({ ...input, landingRoomId: null, activeServerId: exactServer.id, readableRoomIds: ["room-invite"] }))
      .toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
  });

  test("refreshes identity and the Room directory even when completion has no destination", async () => {
    const calls: string[] = [];
    const result = await resolveInviteLanding({ ...input, landingRoomId: null }, {
      getActiveServer: () => exactServer,
      refreshViewer: async () => {
        calls.push("viewer");
        return true;
      },
      listRooms: async (serverUrl) => {
        calls.push(`rooms:${serverUrl}`);
        return { rooms: [{ id: "room-other" }] };
      },
    });
    expect(result).toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
    expect(calls).toEqual(["viewer", "rooms:https://invites.example.test"]);
  });

  test("treats a delayed membership projection as a Chats fallback without polling", async () => {
    const calls: string[] = [];
    const result = await resolveInviteLanding(input, {
      getActiveServer: () => exactServer,
      refreshViewer: async () => {
        calls.push("viewer");
        return true;
      },
      listRooms: async (serverUrl) => {
        calls.push(`rooms:${serverUrl}`);
        return { rooms: [] };
      },
    });
    expect(result).toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
    expect(calls).toEqual(["viewer", "rooms:https://invites.example.test"]);
  });

  test("never refreshes or queries a mismatched active server", async () => {
    let refreshes = 0;
    let lists = 0;
    const result = await resolveInviteLanding(input, {
      getActiveServer: () => ({ id: "srv_other", serverUrl: "https://other.example.test" }),
      refreshViewer: async () => {
        refreshes += 1;
        return true;
      },
      listRooms: async () => {
        lists += 1;
        return { rooms: [{ id: "room-invite" }] };
      },
    });
    expect(result).toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
    expect({ refreshes, lists }).toEqual({ refreshes: 0, lists: 0 });
  });

  test("does not query after the active server changes during viewer refresh", async () => {
    let active = exactServer;
    let lists = 0;
    const result = await resolveInviteLanding(input, {
      getActiveServer: () => active,
      refreshViewer: async () => {
        active = { id: "srv_other", serverUrl: "https://other.example.test" };
        return true;
      },
      listRooms: async () => {
        lists += 1;
        return { rooms: [{ id: "room-invite" }] };
      },
    });
    expect(result).toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
    expect(lists).toBe(0);
  });

  test("falls back when viewer refresh or Room refresh fails", async () => {
    const viewerFailure = await resolveInviteLanding(input, {
      getActiveServer: () => exactServer,
      refreshViewer: async () => false,
      listRooms: async () => ({ rooms: [{ id: "room-invite" }] }),
    });
    const roomFailure = await resolveInviteLanding(input, {
      getActiveServer: () => exactServer,
      refreshViewer: async () => true,
      listRooms: async () => {
        throw new Error("network detail must not surface");
      },
    });
    expect(viewerFailure).toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
    expect(roomFailure).toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
  });

  test("does not use a room response after the active server changes", async () => {
    let active = exactServer;
    const result = await resolveInviteLanding(input, {
      getActiveServer: () => active,
      refreshViewer: async () => true,
      listRooms: async () => {
        active = { id: "srv_other", serverUrl: "https://other.example.test" };
        return { rooms: [{ id: "room-invite" }] };
      },
    });
    expect(result).toEqual({ kind: "chats", notice: INVITE_COMPLETION_NOTICE });
  });
});
