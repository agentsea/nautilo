/**
 * M124 — `/api/rooms` public-room routes (hermetic; inject `RoomsRouteService`
 * + mock `@nautilo/trust`, the WS publisher, room-authz, and the audit-log
 * writer). No DB / server / network — runs in the `test:unit` gate.
 *
 * Covers the runnable half of the M124 Blast-Radius MVP subset:
 *   - discoverable browse (auth gate)            → scenarios 6, 7
 *   - self-join happy path (WS + audit fire)     → scenarios 8, 18, 19
 *   - idempotent re-join (no WS, no audit)       → scenario 9 (D196 watchpoint)
 *   - /join 403 not_open + 404 not_found         → scenarios 10, 11
 *   - create-open admin gate (201 / 403 / 401)   → scenarios 1, 2
 *   - self-leave member / owner-with-admin / 409 → scenarios 12, 13, 14
 *
 * The trust-layer query bodies + namespace-subset / reachability pins are
 * exercised by the DB-backed integration suites (see the *.integration.test.ts
 * siblings) which the operator runs against Postgres.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import Fastify from "fastify";
import * as auditLogModule from "../../src/lib/security-audit-log";
import * as trustModule from "@nautilo/trust";
import { roomsRoutes, type RoomsRouteService } from "../../src/routes/rooms";

// Snapshot the REAL module exports before we mock them below. `mock.module`
// leaks across files in bun's shared test process, so we restore the real
// implementations in `afterAll` — otherwise sibling test files (e.g. the
// dedicated `writeSecurityAuditEvent` suite, or any test using the real
// `removeRoomMember` / `findActorById`) would see our spies. `{ ...ns }`
// captures the real references by value at snapshot time.
const REAL_AUDIT_LOG_MODULE = { ...auditLogModule };
const REAL_TRUST_MODULE = { ...trustModule };
import type { RoomDetailPayload, RoomSummaryRow } from "@nautilo/trust";
import { MembershipOpError, ModerationError } from "@nautilo/trust";
import type { RoomMembershipSystemEventPayload } from "@nautilo/types";
import type { HumanMembershipEventProducer } from "../../src/event-feed/membership-producer";

const UUID_ROOM = "11111111-1111-4111-8111-111111111111";
const UUID_CHILD = "22222222-2222-4222-8222-222222222222";
const UUID_NAMESPACE = "33333333-3333-4333-8333-333333333333";
const SELF_ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MEMBER_ADDED_EVENT: RoomMembershipSystemEventPayload = {
  kind: "member_added",
  actorId: SELF_ACTOR,
  actorKind: "user",
  displayName: "Joiner",
};
const MEMBER_REMOVED_EVENT: RoomMembershipSystemEventPayload = {
  kind: "member_removed",
  actorId: SELF_ACTOR,
  actorKind: "user",
  displayName: "Joiner",
};
type JoinOpenRoomResult = Awaited<ReturnType<typeof trustModule.joinOpenRoom>>;
type RemoveRoomMemberResult = Awaited<
  ReturnType<typeof trustModule.removeRoomMember>
>;
const HUMAN_ADD_TRANSITIONS: NonNullable<
  JoinOpenRoomResult["humanMembershipTransitions"]
> = [
  {
    kind: "human_add",
    targetHumanActorId: SELF_ACTOR,
    previous: {
      roomId: UUID_ROOM,
      namespaceId: UUID_NAMESPACE,
      namespaceAccessRevision: 1,
      participantHumanActorIds: [OTHER_ACTOR],
    },
    current: {
      roomId: UUID_ROOM,
      namespaceId: UUID_NAMESPACE,
      namespaceAccessRevision: 2,
      participantHumanActorIds: [OTHER_ACTOR, SELF_ACTOR].sort(),
    },
  },
];
const HUMAN_REMOVE_TRANSITIONS = [
  {
    kind: "human_remove" as const,
    targetHumanActorId: SELF_ACTOR,
    previous: {
      roomId: UUID_ROOM,
      namespaceId: UUID_NAMESPACE,
      namespaceAccessRevision: 2,
      participantHumanActorIds: [OTHER_ACTOR, SELF_ACTOR].sort(),
    },
    current: {
      roomId: UUID_ROOM,
      namespaceId: UUID_NAMESPACE,
      namespaceAccessRevision: 3,
      participantHumanActorIds: [OTHER_ACTOR],
    },
  },
];

// ---------------------------------------------------------------------------
// Module mocks. The route module imports these bindings directly (not via the
// injected service), so they must be patched at the module boundary.
// ---------------------------------------------------------------------------
// D219 — rooms.ts now gates open-room creation on `userHasCapability(uid,
// "manage_rooms")` (the retired `isUserAdmin` enum read is gone).
const userHasCapabilityMock = mock(
  async (_userId: string, _slug: string) => false,
);
const getUserCapabilitiesMock = mock(async (_userId: string) => [
  "manage_rooms",
]);
const assertCanCreateRoomMembersMock = mock(
  async (_args: {
    callerUserId: string;
    members: Array<{ kind: "user" | "agent"; id: string }>;
    isAdmin: boolean;
  }) => {},
);
const removeRoomMemberMock = mock(
  async (
    _roomId: string,
    _actorId: string,
    _opts: { allowOrphanBypass?: boolean },
  ): Promise<RemoveRoomMemberResult> => ({
    kind: "user" as const,
    membershipEvent: MEMBER_REMOVED_EVENT,
    humanMembershipTransitions: HUMAN_REMOVE_TRANSITIONS,
  }),
);
const findActorByIdMock = mock(
  async (_actorId: string) =>
    ({ id: SELF_ACTOR, ownerId: USER_ID, kind: "user" }) as {
      id: string;
      ownerId: string;
      kind: "user" | "agent";
    } | null,
);

const refreshRoomSubscriptionsMock = mock(
  async (_userId: string, _actorId: string) => {},
);
const publishRoomCatalogChangedMock = mock((_userId: string) => {});
const publishRoomMembersChangedMock = mock(
  (_roomId: string, _event: unknown) => {},
);
const writeSecurityAuditEventMock = mock(
  (_path: string, _event: { kind: string }) => {},
);

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    userHasCapability: userHasCapabilityMock,
    getUserCapabilities: getUserCapabilitiesMock,
    assertCanCreateRoomMembers: assertCanCreateRoomMembersMock,
    removeRoomMember: removeRoomMemberMock,
    findActorById: findActorByIdMock,
  };
});

mock.module("../../src/realtime/ws-publisher", () => ({
  refreshRoomSubscriptionsForUser: refreshRoomSubscriptionsMock,
  publishRoomCatalogChanged: publishRoomCatalogChangedMock,
  publishRoomMembersChanged: publishRoomMembersChangedMock,
}));

mock.module("../../src/lib/security-audit-log", () => ({
  ...REAL_AUDIT_LOG_MODULE,
  writeSecurityAuditEvent: writeSecurityAuditEventMock,
}));

// ---------------------------------------------------------------------------
// Service-stub spies (injected via `roomsRoutes(app, service)`).
// ---------------------------------------------------------------------------
const listDiscoverableSpy = mock((_userId: string) =>
  Promise.resolve<RoomSummaryRow[]>([]),
);
const joinOpenRoomSpy = mock(
  (_p: {
    userId: string;
    actorId: string;
    roomId: string;
  }): Promise<JoinOpenRoomResult> =>
    Promise.resolve({
      membershipEvent: MEMBER_ADDED_EVENT,
      humanMembershipTransitions: HUMAN_ADD_TRANSITIONS,
      repairedSubthreadIds: [] as string[],
      repairedSubthreadEvent: null as RoomMembershipSystemEventPayload | null,
    }),
);
const createOpenRoomSpy = mock(
  (_p: { creatorUserId: string; creatorActorId: string; label: string }) =>
    Promise.resolve({} as RoomDetailPayload),
);
const findOtherAdminMembersSpy = mock(
  (_roomId: string, _excludingActorId: string) => Promise.resolve<string[]>([]),
);
const findRoomOwnerUserIdSpy = mock((_roomId: string) =>
  Promise.resolve<string | null>(null),
);
const getRoomDetailSpy = mock((_roomId: string, _requester: string) =>
  Promise.resolve<RoomDetailPayload | null>(null),
);

function roomDetail(): RoomDetailPayload {
  return {
    id: UUID_ROOM,
    label: "#announcements",
    type: "shared",
    graphThreadId: `room:${UUID_ROOM}`,
    createdAt: "2020-01-01T00:00:00.000Z",
    kind: "open",
    parentRoomId: null,
    threadRootMessageId: null,
    conductorMode: "standard",
    members: [],
  };
}

function summaryRow(id: string): RoomSummaryRow {
  return {
    id,
    label: "#open",
    type: "shared",
    graphThreadId: `room:${id}`,
    createdAt: "2020-01-01T00:00:00.000Z",
    memberCount: 1,
    messageCount: 0,
    lastMessageAt: null,
    unreadCount: 0,
    kind: "open",
    parentRoomId: null,
    threadRootMessageId: null,
  };
}

function makeApp(
  actorId: string | null,
  userId: string | null,
  memberRooms: RoomSummaryRow[] = [],
  resolveProtectedRecipientSyncNamespace?: (
    roomId: string,
  ) => Promise<string | null>,
  produceHumanMembershipEvent?: HumanMembershipEventProducer,
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("policyContext", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("sessionUserId", null);
  const service: RoomsRouteService = {
    listRoomsForActor: mock(async () => memberRooms),
    getRoomDetailForMember: getRoomDetailSpy,
    createRoomForOwner: mock(async () => ({}) as RoomDetailPayload),
    renamePrivateRoomForOwner: mock(async () => null),
    listManageableRoomsForUser: mock(async () => []),
    getRoomDetailForManager: mock(async () => null),
    listDiscoverableRoomsForUser: listDiscoverableSpy,
    joinOpenRoom: joinOpenRoomSpy,
    createOpenRoom: createOpenRoomSpy,
    findOtherAdminMembers: findOtherAdminMembersSpy,
    findRoomOwnerUserId: findRoomOwnerUserIdSpy,
    ...(resolveProtectedRecipientSyncNamespace === undefined
      ? {}
      : { resolveProtectedRecipientSyncNamespace }),
  };
  roomsRoutes(app, service, undefined, produceHumanMembershipEvent);
  app.addHook("preHandler", async (request) => {
    (request as { policyContext?: { actorRole: string } }).policyContext = {
      actorRole: "guest",
    };
    (request as { sessionActorId?: string | null }).sessionActorId = actorId;
    (request as { sessionUserId?: string | null }).sessionUserId = userId;
  });
  return app;
}

beforeEach(() => {
  userHasCapabilityMock.mockClear();
  userHasCapabilityMock.mockImplementation(async () => false);
  getUserCapabilitiesMock.mockClear();
  getUserCapabilitiesMock.mockImplementation(async () => ["manage_rooms"]);
  assertCanCreateRoomMembersMock.mockClear();
  assertCanCreateRoomMembersMock.mockImplementation(async () => {});
  removeRoomMemberMock.mockClear();
  removeRoomMemberMock.mockImplementation(async () => ({
    kind: "user" as const,
    membershipEvent: MEMBER_REMOVED_EVENT,
    humanMembershipTransitions: HUMAN_REMOVE_TRANSITIONS,
  }));
  findActorByIdMock.mockClear();
  findActorByIdMock.mockImplementation(async () => ({
    id: SELF_ACTOR,
    ownerId: USER_ID,
    kind: "user" as const,
  }));
  refreshRoomSubscriptionsMock.mockClear();
  publishRoomCatalogChangedMock.mockClear();
  publishRoomMembersChangedMock.mockClear();
  writeSecurityAuditEventMock.mockClear();
  listDiscoverableSpy.mockClear();
  listDiscoverableSpy.mockImplementation(async () => []);
  joinOpenRoomSpy.mockClear();
  joinOpenRoomSpy.mockImplementation(async () => ({
    membershipEvent: MEMBER_ADDED_EVENT,
    humanMembershipTransitions: HUMAN_ADD_TRANSITIONS,
    repairedSubthreadIds: [],
    repairedSubthreadEvent: null,
  }));
  createOpenRoomSpy.mockClear();
  createOpenRoomSpy.mockImplementation(async () => roomDetail());
  findOtherAdminMembersSpy.mockClear();
  findOtherAdminMembersSpy.mockImplementation(async () => []);
  findRoomOwnerUserIdSpy.mockClear();
  findRoomOwnerUserIdSpy.mockImplementation(async () => null);
  getRoomDetailSpy.mockClear();
  getRoomDetailSpy.mockImplementation(async () => roomDetail());
});

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  // Undo the leaking module mocks so sibling test files in this process get
  // the real implementations back.
  mock.module("../../src/lib/security-audit-log", () => REAL_AUDIT_LOG_MODULE);
  mock.module("@nautilo/trust", () => REAL_TRUST_MODULE);
});

describe("GET /api/rooms/discoverable (M124 MR5)", () => {
  test("unauthenticated → 401", async () => {
    const app = makeApp(null, null);
    const res = await app.inject({
      method: "GET",
      url: "/api/rooms/discoverable",
    });
    expect(res.statusCode).toBe(401);
    expect(listDiscoverableSpy.mock.calls.length).toBe(0);
  });

  test("authenticated → 200 list (does not consult actorRole)", async () => {
    listDiscoverableSpy.mockResolvedValueOnce([summaryRow(UUID_ROOM)]);
    // actorRole is 'guest' in makeApp; discoverable must still return the list.
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "GET",
      url: "/api/rooms/discoverable",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rooms: RoomSummaryRow[] };
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0]?.kind).toBe("open");
    expect(listDiscoverableSpy.mock.calls[0]?.[0]).toBe(USER_ID);
  });
});

describe("POST /api/rooms/:id/join (M124 MR6)", () => {
  test("unauthenticated → 401", async () => {
    const app = makeApp(null, null);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });
    expect(res.statusCode).toBe(401);
    expect(joinOpenRoomSpy.mock.calls.length).toBe(0);
  });

  test("invalid room id → 400", async () => {
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms/not-a-uuid/join",
    });
    expect(res.statusCode).toBe(400);
  });

  test("real join → 200 + WS publish + audit row", async () => {
    const produce = mock(async () => {});
    const resolve = mock(async () => UUID_NAMESPACE);
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: MEMBER_ADDED_EVENT,
      membershipMessageId: 71,
      humanMembershipTransitions: HUMAN_ADD_TRANSITIONS,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve, produce);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: UUID_ROOM, kind: "open" });
    expect(refreshRoomSubscriptionsMock.mock.calls.length).toBe(1);
    expect(publishRoomCatalogChangedMock).toHaveBeenCalledWith(USER_ID);
    expect(resolve).toHaveBeenCalledWith(UUID_ROOM);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_ROOM,
      MEMBER_ADDED_EVENT,
      UUID_NAMESPACE,
    );
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(1);
    expect(writeSecurityAuditEventMock.mock.calls[0]?.[1]?.kind).toBe(
      "room_member_self_joined",
    );
    expect(produce).toHaveBeenCalledWith({
      type: "room.member_joined",
      roomId: UUID_ROOM,
      subjectUserId: USER_ID,
      initiatorActorId: SELF_ACTOR,
      initiatorUserId: USER_ID,
      membershipMessageId: 71,
    });
  });

  test("idempotent re-join → 200, NO WS publish, NO audit row (D196)", async () => {
    const produce = mock(async () => {});
    const resolve = mock(async () => UUID_NAMESPACE);
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: null,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve, produce);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });
    expect(res.statusCode).toBe(200);
    expect(publishRoomMembersChangedMock.mock.calls.length).toBe(0);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(0);
    expect(refreshRoomSubscriptionsMock.mock.calls.length).toBe(0);
    expect(publishRoomCatalogChangedMock).not.toHaveBeenCalled();
    expect(produce).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a legacy join result without a durable receipt does not invoke the producer", async () => {
    const produce = mock(async () => {});
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: MEMBER_ADDED_EVENT,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], undefined, produce);

    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });

    expect(res.statusCode).toBe(200);
    expect(produce).not.toHaveBeenCalled();
    expect(publishRoomMembersChangedMock).toHaveBeenCalledTimes(1);
  });

  test("a producer failure is caught before post-commit convergence", async () => {
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: MEMBER_ADDED_EVENT,
      membershipMessageId: 72,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
    const produce = mock(async () => {
      expect(refreshRoomSubscriptionsMock).not.toHaveBeenCalled();
      throw new Error("feed unavailable");
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], undefined, produce);

    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });

    expect(res.statusCode).toBe(200);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(refreshRoomSubscriptionsMock).toHaveBeenCalledTimes(1);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledTimes(1);
  });

  test("idempotent parent join publishes and subscribes a repaired child only", async () => {
    const resolve = mock(async () => UUID_NAMESPACE);
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: null,
      repairedSubthreadIds: [UUID_CHILD],
      repairedSubthreadEvent: MEMBER_ADDED_EVENT,
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });

    expect(res.statusCode).toBe(200);
    expect(refreshRoomSubscriptionsMock).toHaveBeenCalledTimes(1);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_CHILD,
      MEMBER_ADDED_EVENT,
    );
    expect(publishRoomCatalogChangedMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditEventMock).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a failed protected wake-up cannot roll back an explicit join", async () => {
    const resolve = mock(async (): Promise<string | null> => {
      throw new Error("protected wake-up unavailable");
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve);

    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });

    expect(res.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(UUID_ROOM);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_ROOM,
      MEMBER_ADDED_EVENT,
    );
  });

  test("a failed subscription refresh cannot suppress an explicit-join protected wake-up", async () => {
    const order: string[] = [];
    const resolve = mock(async () => {
      order.push("resolve");
      return UUID_NAMESPACE;
    });
    refreshRoomSubscriptionsMock.mockImplementationOnce(async () => {
      order.push("refresh");
      throw new Error("subscription refresh unavailable");
    });
    publishRoomMembersChangedMock.mockImplementationOnce(() => {
      order.push("publish");
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve);

    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });

    expect(res.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(UUID_ROOM);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_ROOM,
      MEMBER_ADDED_EVENT,
      UUID_NAMESPACE,
    );
    expect(order).toEqual(["resolve", "refresh", "publish"]);
  });

  test("an active ban returns 403 without membership publication or audit", async () => {
    joinOpenRoomSpy.mockRejectedValueOnce(new ModerationError("active_ban"));
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({ method: "POST", url: `/api/rooms/${UUID_ROOM}/join` });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>()).toEqual({ code: "active_ban" });
    expect(publishRoomMembersChangedMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditEventMock).not.toHaveBeenCalled();
  });

  test("non-open room → 403 not_open", async () => {
    joinOpenRoomSpy.mockImplementationOnce(() => {
      throw new MembershipOpError("not_open");
    });
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: "not_open" });
  });

  test("missing room → 404 not_found", async () => {
    joinOpenRoomSpy.mockImplementationOnce(() => {
      throw new MembershipOpError("not_found");
    });
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_ROOM}/join`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/rooms/resolve-landing open-Room repair", () => {
  test.each(["existing", "discoverable"])("a ban racing the %s landing selection returns 403 without publication", async (source) => {
    joinOpenRoomSpy.mockRejectedValueOnce(new ModerationError("active_ban"));
    if (source === "discoverable") listDiscoverableSpy.mockResolvedValueOnce([summaryRow(UUID_ROOM)]);
    const app = makeApp(SELF_ACTOR, USER_ID, source === "existing" ? [summaryRow(UUID_ROOM)] : []);
    const res = await app.inject({ method: "POST", url: "/api/rooms/resolve-landing" });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>()).toEqual({ code: "active_ban" });
    expect(publishRoomMembersChangedMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditEventMock).not.toHaveBeenCalled();
  });

  test("an actual join through the existing-room branch emits its receipt", async () => {
    const produce = mock(async () => {});
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: MEMBER_ADDED_EVENT,
      membershipMessageId: 73,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
    const app = makeApp(
      SELF_ACTOR,
      USER_ID,
      [summaryRow(UUID_ROOM)],
      undefined,
      produce,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/rooms/resolve-landing",
    });

    expect(res.statusCode).toBe(200);
    expect(produce).toHaveBeenCalledWith({
      type: "room.member_joined",
      roomId: UUID_ROOM,
      subjectUserId: USER_ID,
      initiatorActorId: SELF_ACTOR,
      initiatorUserId: USER_ID,
      membershipMessageId: 73,
    });
  });

  test("an actual join through the discoverable-room branch emits its receipt", async () => {
    const produce = mock(async () => {});
    listDiscoverableSpy.mockResolvedValueOnce([summaryRow(UUID_ROOM)]);
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: MEMBER_ADDED_EVENT,
      membershipMessageId: 74,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], undefined, produce);

    const res = await app.inject({
      method: "POST",
      url: "/api/rooms/resolve-landing",
    });

    expect(res.statusCode).toBe(200);
    expect(produce).toHaveBeenCalledWith({
      type: "room.member_joined",
      roomId: UUID_ROOM,
      subjectUserId: USER_ID,
      initiatorActorId: SELF_ACTOR,
      initiatorUserId: USER_ID,
      membershipMessageId: 74,
    });
  });

  test("an existing parent member refreshes and publishes repaired children without a parent audit", async () => {
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: null,
      repairedSubthreadIds: [UUID_CHILD],
      repairedSubthreadEvent: MEMBER_ADDED_EVENT,
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [summaryRow(UUID_ROOM)]);

    const res = await app.inject({
      method: "POST",
      url: "/api/rooms/resolve-landing",
    });

    expect(res.statusCode).toBe(200);
    expect(joinOpenRoomSpy).toHaveBeenCalledWith({
      userId: USER_ID,
      actorId: SELF_ACTOR,
      roomId: UUID_ROOM,
    });
    expect(refreshRoomSubscriptionsMock).toHaveBeenCalledTimes(1);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_CHILD,
      MEMBER_ADDED_EVENT,
    );
    expect(writeSecurityAuditEventMock).not.toHaveBeenCalled();
  });

  test("a fresh automatic landing join requests protected convergence", async () => {
    const resolve = mock(async () => UUID_NAMESPACE);
    joinOpenRoomSpy.mockResolvedValueOnce({
      membershipEvent: MEMBER_ADDED_EVENT,
      humanMembershipTransitions: HUMAN_ADD_TRANSITIONS,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [summaryRow(UUID_ROOM)], resolve);

    const res = await app.inject({
      method: "POST",
      url: "/api/rooms/resolve-landing",
    });

    expect(res.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(UUID_ROOM);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_ROOM,
      MEMBER_ADDED_EVENT,
      UUID_NAMESPACE,
    );
  });
});

describe("POST /api/rooms { kind: 'open' } (M124 MR7)", () => {
  test("unauthenticated → 401", async () => {
    const app = makeApp(null, null);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "#announce", kind: "open" },
    });
    expect(res.statusCode).toBe(401);
    expect(createOpenRoomSpy.mock.calls.length).toBe(0);
  });

  test("authenticated non-admin → 403 admin_required", async () => {
    userHasCapabilityMock.mockImplementationOnce(async () => false);
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "#announce", kind: "open" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: "admin_required" });
    expect(createOpenRoomSpy.mock.calls.length).toBe(0);
  });

  test("server admin → 201 + createOpenRoom receives validated exact roster", async () => {
    userHasCapabilityMock.mockImplementationOnce(async () => true);
    createOpenRoomSpy.mockResolvedValueOnce(roomDetail());
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "#announce",
        kind: "open",
        members: [
          { kind: "user", id: USER_ID },
          { kind: "user", id: OTHER_ACTOR },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ kind: "open" });
    expect(createOpenRoomSpy.mock.calls.length).toBe(1);
    expect(createOpenRoomSpy.mock.calls[0]?.[0]).toMatchObject({
      creatorUserId: USER_ID,
      creatorActorId: SELF_ACTOR,
      label: "#announce",
      members: [
        { kind: "user", id: USER_ID },
        { kind: "user", id: OTHER_ACTOR },
      ],
    });
    expect(assertCanCreateRoomMembersMock.mock.calls[0]?.[0]).toMatchObject({
      callerUserId: USER_ID,
      members: [
        { kind: "user", id: USER_ID },
        { kind: "user", id: OTHER_ACTOR },
      ],
      isAdmin: false,
    });
    expect(refreshRoomSubscriptionsMock.mock.calls.length).toBe(1);
  });

  test("empty open members[] preserves the creator-only legacy path", async () => {
    userHasCapabilityMock.mockImplementationOnce(async () => true);
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "#creator-only", kind: "open", members: [] },
    });
    expect(res.statusCode).toBe(201);
    expect(createOpenRoomSpy.mock.calls[0]?.[0]).toMatchObject({
      creatorUserId: USER_ID,
      creatorActorId: SELF_ACTOR,
      label: "#creator-only",
    });
    expect(createOpenRoomSpy.mock.calls[0]?.[0]).not.toHaveProperty("members");
    expect(assertCanCreateRoomMembersMock.mock.calls.length).toBe(0);
  });

  test("supplied open roster without creator is rejected before minting", async () => {
    userHasCapabilityMock.mockImplementationOnce(async () => true);
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "#announce",
        kind: "open",
        members: [{ kind: "user", id: OTHER_ACTOR }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "members[] must include the creator exactly once",
    });
    expect(assertCanCreateRoomMembersMock.mock.calls.length).toBe(0);
    expect(createOpenRoomSpy.mock.calls.length).toBe(0);
  });

  test("duplicate supplied open roster is rejected before minting", async () => {
    userHasCapabilityMock.mockImplementationOnce(async () => true);
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "#announce",
        kind: "open",
        members: [
          { kind: "user", id: USER_ID },
          { kind: "user", id: USER_ID },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "members[] must not contain duplicates",
    });
    expect(createOpenRoomSpy.mock.calls.length).toBe(0);
  });
});

describe("DELETE /api/rooms/:id/members/:actorId — self-leave (M124 MR8)", () => {
  test("recipient-sync wake-up is additive and cannot fail ordinary membership", async () => {
    findRoomOwnerUserIdSpy.mockResolvedValueOnce("some-other-owner");
    const resolve = mock(async (_roomId: string): Promise<string | null> => {
      throw new Error("protected wake-up unavailable");
    });
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_ROOM}/members/${SELF_ACTOR}`,
    });

    expect(res.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(UUID_ROOM);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledTimes(1);
  });

  test("ordinary member self-leaves → 200 + room_member_self_left audit, no manage check", async () => {
    findRoomOwnerUserIdSpy.mockResolvedValueOnce("some-other-owner");
    removeRoomMemberMock.mockResolvedValueOnce({
      kind: "user",
      membershipEvent: MEMBER_REMOVED_EVENT,
      membershipMessageId: 75,
    });
    const produce = mock(async () => {});
    const app = makeApp(SELF_ACTOR, USER_ID, [], undefined, produce);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_ROOM}/members/${SELF_ACTOR}`,
    });
    expect(res.statusCode).toBe(200);
    expect(removeRoomMemberMock.mock.calls.length).toBe(1);
    // non-owner self-leave does not need the orphan bypass
    expect(removeRoomMemberMock.mock.calls[0]?.[2]).toMatchObject({
      allowOrphanBypass: false,
    });
    expect(findOtherAdminMembersSpy.mock.calls.length).toBe(0);
    expect(publishRoomCatalogChangedMock).toHaveBeenCalledWith(USER_ID);
    expect(writeSecurityAuditEventMock.mock.calls[0]?.[1]?.kind).toBe(
      "room_member_self_left",
    );
    expect(produce).toHaveBeenCalledWith({
      type: "room.member_left",
      roomId: UUID_ROOM,
      subjectUserId: USER_ID,
      initiatorActorId: SELF_ACTOR,
      initiatorUserId: USER_ID,
      membershipMessageId: 75,
    });
  });

  test("a failed catalogue refresh cannot suppress a self-leave protected wake-up", async () => {
    findRoomOwnerUserIdSpy.mockResolvedValueOnce("some-other-owner");
    refreshRoomSubscriptionsMock.mockRejectedValueOnce(
      new Error("catalogue refresh unavailable"),
    );
    const resolve = mock(async () => UUID_NAMESPACE);
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_ROOM}/members/${SELF_ACTOR}`,
    });

    expect(res.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(UUID_ROOM);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_ROOM,
      expect.objectContaining({ kind: "member_removed" }),
      UUID_NAMESPACE,
    );
  });

  test("a no-event Human removal retains its catalog convergence", async () => {
    findRoomOwnerUserIdSpy.mockResolvedValueOnce("some-other-owner");
    removeRoomMemberMock.mockResolvedValueOnce({ kind: "user" });
    const resolve = mock(async () => UUID_NAMESPACE);
    const app = makeApp(SELF_ACTOR, USER_ID, [], resolve);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_ROOM}/members/${SELF_ACTOR}`,
    });

    expect(res.statusCode).toBe(200);
    expect(refreshRoomSubscriptionsMock).toHaveBeenCalledWith(
      USER_ID,
      SELF_ACTOR,
    );
    expect(publishRoomCatalogChangedMock).toHaveBeenCalledWith(USER_ID);
    expect(resolve).not.toHaveBeenCalled();
    expect(publishRoomMembersChangedMock).not.toHaveBeenCalled();
  });

  test("owner self-leaves with another admin present → 200 (allowOrphanBypass=true)", async () => {
    findRoomOwnerUserIdSpy.mockResolvedValueOnce(USER_ID);
    findOtherAdminMembersSpy.mockResolvedValueOnce([OTHER_ACTOR]);
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_ROOM}/members/${SELF_ACTOR}`,
    });
    expect(res.statusCode).toBe(200);
    expect(removeRoomMemberMock.mock.calls[0]?.[2]).toMatchObject({
      allowOrphanBypass: true,
    });
  });

  test("owner self-leaves as sole admin → 409 room_owner_last_admin", async () => {
    findRoomOwnerUserIdSpy.mockResolvedValueOnce(USER_ID);
    findOtherAdminMembersSpy.mockResolvedValueOnce([]);
    const app = makeApp(SELF_ACTOR, USER_ID);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_ROOM}/members/${SELF_ACTOR}`,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "room_owner_last_admin",
    });
    expect(removeRoomMemberMock.mock.calls.length).toBe(0);
  });
});
