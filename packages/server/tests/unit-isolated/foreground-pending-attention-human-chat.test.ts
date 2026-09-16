import { beforeEach, expect, mock, test } from "bun:test";
import * as database from "@nautilo/db";
import * as trust from "@nautilo/trust";
import { LiveShadowRecipientRegistry } from "@nautilo/lattice-bridge/server";

const ROOM = "00000000-0000-4000-8000-000000000001";
const HUMAN = "00000000-0000-4000-8000-000000000002";
const binding = {
  userId: "viewer",
  humanActorId: HUMAN,
  clientDeviceId: "device",
  clientActionSessionId: "session",
};
let detail: trust.RoomDetailPayload | null = null;
const getRoomDetail = mock(async () => detail);
const select = mock(() => { throw new Error("checkpoint query reached"); });

// Exercise the production service without opening database pools. Human-only
// and inaccessible Rooms must settle before any checkpoint or crypto lookup.
mock.module("@nautilo/trust", () => ({
  ...trust,
  getRoomDetailForMember: getRoomDetail,
}));
mock.module("@nautilo/db", () => ({
  ...database,
  getSharedDirectCryptoDb: () => ({}),
  createPostgresJsBridgeConnection: () => ({}),
}));
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: () => ({ select }),
}));

const { createProductionForegroundPendingAttention } = await import(
  "../../src/routes/foreground-pending-attention"
);

beforeEach(() => {
  getRoomDetail.mockClear();
  select.mockClear();
  detail = {
    id: ROOM,
    label: "Conversation",
    type: "chat",
    graphThreadId: `room:${ROOM}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "private",
    parentRoomId: null,
    threadRootMessageId: null,
    conductorMode: "standard",
    members: [
      { actorId: HUMAN, kind: "user", displayName: "Alice", roomRole: "admin" },
      { actorId: "human-two", kind: "user", displayName: "Bob", roomRole: "member" },
    ],
  };
});

for (const kind of ["private", "group"] as const) {
  test(`an accessible ${kind} Human-only chat has no pending approvals`, async () => {
    detail!.kind = kind;
    if (kind === "group") detail!.members.push({
      actorId: "human-three", kind: "user", displayName: "Carol", roomRole: "member",
    });
    const service = createProductionForegroundPendingAttention(new LiveShadowRecipientRegistry());
    try {
      expect(await service.page(binding, ROOM)).toEqual({
        status: "ready", events: [], nextCursor: null,
      });
      expect(getRoomDetail).toHaveBeenCalledWith(ROOM, HUMAN);
      expect(select).not.toHaveBeenCalled();
    } finally { service.close(); }
  });
}

test("an inaccessible Room remains unavailable rather than looking empty", async () => {
  detail = null;
  const service = createProductionForegroundPendingAttention(new LiveShadowRecipientRegistry());
  try {
    expect(await service.page(binding, ROOM)).toEqual({
      status: "unavailable", events: [], nextCursor: null,
    });
    expect(getRoomDetail).toHaveBeenCalledWith(ROOM, HUMAN);
    expect(select).not.toHaveBeenCalled();
  } finally { service.close(); }
});

test("a Room with a Genie still checks canonical pending checkpoints", async () => {
  detail!.members.push({
    actorId: "genie-actor", kind: "agent", agentId: "genie",
    displayName: "Genie", roomRole: "member",
  });
  const service = createProductionForegroundPendingAttention(new LiveShadowRecipientRegistry());
  try {
    const result: unknown = await service.page(binding, ROOM).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("checkpoint query reached");
    expect(select).toHaveBeenCalledTimes(1);
  } finally { service.close(); }
});
