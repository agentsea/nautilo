/**
 * M065 — `/api/rooms*` routes (hermetic; inject `RoomsRouteService`).
 * Process env: several tests set `NAUTILO_DEFAULT_AGENT_ID`; `afterEach` restores it so later suites are not polluted.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as trustModule from "@nautilo/trust";
import * as publisherModule from "../../src/realtime/ws-publisher";
import { EncryptionPublicationPolicyError } from "@nautilo/db";
import Fastify from "fastify";
import * as auditLogModule from "../../src/lib/security-audit-log";
import { ManageForbiddenError } from "../../src/lib/agent-room-authz";
import {
  pickLargestLandingOpenRoom,
  roomsRoutes,
  type ProtectedHumanMessageEditRouteService,
  type RoomsRouteService,
} from "../../src/routes/rooms";
import type { HumanMembershipEventProducer } from "../../src/event-feed/membership-producer";
import type {
  CreateRoomForOwnerParams,
  RoomDetailPayload,
  RoomSummaryRow,
} from "@nautilo/trust";
import {
  setBootstrapDefaultAgentId,
  getBootstrapDefaultAgentId,
  CreateRoomReachabilityError,
} from "@nautilo/trust";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
type AddRoomMemberResult = Awaited<
  ReturnType<typeof trustModule.addRoomMember>
>;
type RemoveRoomMemberResult = Awaited<
  ReturnType<typeof trustModule.removeRoomMember>
>;
type FindActorByIdResult = Awaited<
  ReturnType<typeof trustModule.findActorById>
>;

const ORIGINAL_DEFAULT_AGENT_ID = getBootstrapDefaultAgentId();

describe("rooms routes (M065)", () => {
  const listSpy = mock((_actor: string) =>
    Promise.resolve<RoomSummaryRow[]>([]),
  );
  const listManageSpy = mock((_userId: string, _opts: { isAdmin: boolean }) =>
    Promise.resolve<RoomSummaryRow[]>([]),
  );
  const getSpy = mock((_roomId: string, _requester: string) =>
    Promise.resolve<RoomDetailPayload | null>(null),
  );
  const getManageSpy = mock(
    (_roomId: string, _managerUserId: string, _opts: { isAdmin: boolean }) =>
      Promise.resolve<RoomDetailPayload | null>(null),
  );
  const createSpy = mock((_p: CreateRoomForOwnerParams) =>
    Promise.resolve({} as RoomDetailPayload),
  );
  const renameSpy = mock(
    (_p: import("@nautilo/trust").RenamePrivateRoomForOwnerParams) =>
      Promise.resolve(null as RoomDetailPayload | null),
  );

  beforeEach(() => {
    listSpy.mockClear();
    listManageSpy.mockClear();
    getSpy.mockClear();
    getManageSpy.mockClear();
    createSpy.mockClear();
    renameSpy.mockClear();
  });

  afterEach(() => {
    setBootstrapDefaultAgentId(ORIGINAL_DEFAULT_AGENT_ID);
  });

  function makeApp(
    role: string,
    actorId: string | null,
    userId: string | null,
    overrides: Partial<RoomsRouteService> = {},
    protectedEdit?: ProtectedHumanMessageEditRouteService,
  ) {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    const service: RoomsRouteService = {
      listRoomsForActor: listSpy,
      getRoomDetailForMember: getSpy,
      createRoomForOwner: createSpy,
      renamePrivateRoomForOwner: renameSpy,
      listManageableRoomsForUser: listManageSpy,
      getRoomDetailForManager: getManageSpy,
      userHasCapability: async () => false,
      assertCanInvokeAgent: async () => {},
      humanPairIsBlocked: async () => false,
      ...overrides,
    };
    app.addHook("preHandler", async (request) => {
      (request as { policyContext?: { actorRole: string } }).policyContext = {
        actorRole: role,
      };
      (request as { sessionActorId?: string | null }).sessionActorId = actorId;
      (request as { sessionUserId?: string | null }).sessionUserId = userId;
    });
    roomsRoutes(app, service, protectedEdit);
    return app;
  }

  test("Full Human edit routes forward only authenticated protected contracts", async () => {
    const calls: unknown[] = [];
    const protectedEdit: ProtectedHumanMessageEditRouteService = {
      plan: async (input) => {
        calls.push(input);
        return {
          responseVersion: 1,
          status: "planned",
          representationMode: "full_encryption",
          planBytesBase64url: "AQ",
        };
      },
      publish: async (input) => {
        calls.push(input);
        return {
          responseVersion: 1,
          status: "published",
          representationMode: "full_encryption",
          editRevision: 2,
          targets: [
            { sessionId: UUID_A, messageId: 41, cryptoObjectId: "object:next" },
          ],
        };
      },
    };
    const app = makeApp("member", UUID_B, UUID_A, {}, protectedEdit);
    const plan = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/messages/41/edit-plan`,
      headers: { authorization: "Bearer test-session" },
      payload: {
        requestVersion: 1,
        clientDeviceId: "device:one",
        expectedRevision: 1,
        clientIdempotencyKey: "edit:one",
      },
    });
    expect(plan.statusCode).toBe(200);
    const publish = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${UUID_A}/messages/41/protected`,
      headers: { authorization: "Bearer test-session" },
      payload: {
        requestVersion: 1,
        representationMode: "full_encryption",
        planBytesBase64url: "AQ",
        signedRequestBytesBase64url: "Ag",
        preparedTargets: [
          {
            sessionId: UUID_A,
            messageId: 41,
            encryptedPayloadBytesBase64url: "Aw",
            accessManifestBytesBase64url: "BA",
            namespaceEnvelopeBytesBase64url: "BQ",
          },
        ],
      },
    });
    expect(publish.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toContain("content");
  });

  test("Full Human edit routes reject ordinary bytes before composition", async () => {
    const publish = mock(() => Promise.reject(new Error("must not run")));
    const app = makeApp(
      "member",
      UUID_B,
      UUID_A,
      {},
      {
        plan: async () => ({
          responseVersion: 1,
          status: "unavailable",
          reason: "policy_unavailable",
        }),
        publish,
      },
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${UUID_A}/messages/41/protected`,
      headers: { authorization: "Bearer test-session" },
      payload: {
        requestVersion: 1,
        representationMode: "full_encryption",
        planBytesBase64url: "AQ",
        signedRequestBytesBase64url: "Ag",
        content: "forbidden",
        preparedTargets: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  test("legacy ordinary edit reports policy conflict without publishing a realtime update", async () => {
    const edit = spyOn(trustModule, "editHumanRoomMessage").mockRejectedValue(
      new EncryptionPublicationPolicyError("ordinary_forbidden"),
    );
    const publish = spyOn(
      publisherModule,
      "publishMessageUpdated",
    ).mockImplementation(() => {});
    const app = makeApp("member", UUID_B, UUID_A);
    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/rooms/${UUID_A}/messages/41`,
        payload: { content: "forbidden ordinary edit", expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string; code: string }>()).toEqual({
        error: "encryption_policy_conflict",
        code: "ordinary_forbidden",
      });
      expect(edit).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await app.close();
      edit.mockRestore();
      publish.mockRestore();
    }
  });

  test("GET /api/rooms as guest → 200 []", async () => {
    const app = makeApp("guest", null, null);
    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ rooms: [] });
    expect(listSpy.mock.calls.length).toBe(0);
  });

  test("GET /api/rooms as authenticated Guest lists exact Actor memberships", async () => {
    const app = makeApp("guest", "act-guest", "usr-guest");
    listSpy.mockResolvedValueOnce([
      {
        id: UUID_A,
        label: "Community",
        type: "group",
        graphThreadId: `room:${UUID_A}`,
        createdAt: "2026-08-12T00:00:00.000Z",
        memberCount: 3,
        messageCount: 4,
        lastMessageAt: "2026-08-12T01:00:00.000Z",
        unreadCount: 1,
        kind: "open",
        parentRoomId: null,
        threadRootMessageId: null,
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/rooms" });

    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { rooms: unknown[] }).rooms).toHaveLength(
      1,
    );
    expect(listSpy).toHaveBeenCalledWith("act-guest");
  });

  test("landing open-Room ranking is largest, then oldest, then lexical id", () => {
    const row = (
      id: string,
      memberCount: number,
      createdAt: string,
    ): RoomSummaryRow => ({
      id,
      label: id,
      type: "shared",
      graphThreadId: `room:${id}`,
      createdAt,
      memberCount,
      messageCount: 0,
      lastMessageAt: null,
      unreadCount: 0,
      kind: "open",
      parentRoomId: null,
      threadRootMessageId: null,
    });
    expect(
      pickLargestLandingOpenRoom([
        row(UUID_B, 5, "2026-01-01T00:00:00.000Z"),
        row(UUID_A, 5, "2026-01-01T00:00:00.000Z"),
        row(
          "33333333-3333-4333-8333-333333333333",
          4,
          "2025-01-01T00:00:00.000Z",
        ),
      ])?.id,
    ).toBe(UUID_A);
  });

  test("POST resolve-landing skips a strict personal Agent Room and joins server-ranked open Room", async () => {
    const personal: RoomSummaryRow = {
      id: UUID_A,
      label: "Genie",
      type: "private",
      graphThreadId: `room:${UUID_A}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      memberCount: 2,
      messageCount: 0,
      lastMessageAt: null,
      unreadCount: 0,
      kind: "private",
      parentRoomId: null,
      threadRootMessageId: null,
      roster: [
        {
          actorId: "act-guest",
          kind: "user",
          displayName: "Guest",
          userId: "usr-guest",
        },
        {
          actorId: "act-agent",
          kind: "agent",
          displayName: "Genie",
          agentId: "agent-1",
        },
      ],
    };
    const publicRoom: RoomSummaryRow = {
      ...personal,
      id: UUID_B,
      label: "Community",
      graphThreadId: `room:${UUID_B}`,
      memberCount: 8,
      kind: "open",
    };
    delete publicRoom.roster;
    const detail: RoomDetailPayload = {
      id: UUID_B,
      label: "Community",
      type: "shared",
      graphThreadId: `room:${UUID_B}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "open",
      parentRoomId: null,
      threadRootMessageId: null,
      conductorMode: "standard",
      members: [
        {
          actorId: "act-guest",
          kind: "user",
          displayName: "Guest",
          roomRole: "member",
        },
      ],
    };
    listSpy.mockResolvedValueOnce([personal]);
    getSpy.mockResolvedValueOnce(detail);
    const join = mock(async () => ({
      membershipEvent: null,
      repairedSubthreadIds: [],
      repairedSubthreadEvent: null,
    }));
    const app = makeApp("guest", "act-guest", "usr-guest", {
      listDiscoverableRoomsForUser: async () => [publicRoom],
      joinOpenRoom: join,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/rooms/resolve-landing",
    });

    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { id: string }).id).toBe(UUID_B);
    expect(join).toHaveBeenCalledWith({
      userId: "usr-guest",
      actorId: "act-guest",
      roomId: UUID_B,
    });
  });

  test("POST resolve-landing falls back to a server-selected human-only owner DM", async () => {
    const detail: RoomDetailPayload = {
      id: UUID_B,
      label: "Owner",
      type: "shared",
      graphThreadId: `room:${UUID_B}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      kind: "group",
      parentRoomId: null,
      threadRootMessageId: null,
      conductorMode: "standard",
      members: [
        {
          actorId: "act-owner",
          kind: "user",
          displayName: "Owner",
          roomRole: "admin",
        },
        {
          actorId: "act-guest",
          kind: "user",
          displayName: "Guest",
          roomRole: "member",
        },
      ],
    };
    const resolveDm = mock(async () => detail);
    const app = makeApp("guest", "act-guest", "usr-guest", {
      listDiscoverableRoomsForUser: async () => [],
      findCanonicalActiveServerOwner: async () => ({
        userId: "usr-owner",
        actorId: "act-owner",
        displayName: "Owner",
      }),
      findOrCreateHumanOnlyDirectRoom: resolveDm,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/resolve-landing",
    });

    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { id: string }).id).toBe(UUID_B);
    expect(resolveDm).toHaveBeenCalledWith({
      ownerUserId: "usr-owner",
      ownerActorId: "act-owner",
      guestActorId: "act-guest",
      label: "Owner",
    });
  });

  test("GET /api/rooms as owner with two rooms → sorted payload", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    listSpy.mockResolvedValueOnce([
      {
        id: UUID_A,
        label: "Older",
        type: "private",
        graphThreadId: "app:default",
        createdAt: "2020-01-01T00:00:00.000Z",
        memberCount: 2,
        messageCount: 12,
        lastMessageAt: "2020-01-03T00:00:00.000Z",
        unreadCount: 0,
        kind: "private",
        parentRoomId: null,
        threadRootMessageId: null,
      },
      {
        id: UUID_B,
        label: "Newer",
        type: "private",
        graphThreadId: `room:${UUID_B}`,
        createdAt: "2020-01-02T00:00:00.000Z",
        memberCount: 2,
        messageCount: 0,
        lastMessageAt: null,
        unreadCount: 0,
        kind: "private",
        parentRoomId: null,
        threadRootMessageId: null,
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rooms: RoomSummaryRow[] };
    expect(body.rooms).toHaveLength(2);
    expect(listSpy.mock.calls[0]?.[0]).toBe("act-owner");
  });

  test("GET /api/rooms folds the compact roster projection through verbatim", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    const rosterA = [
      {
        actorId: "act-owner",
        kind: "user" as const,
        displayName: "Owner",
        userId: "usr-owner",
        handle: "user",
        federatedId: "@user@example.test",
      },
      {
        actorId: "act-genie",
        kind: "agent" as const,
        displayName: "Genie",
        agentId: "agent-1",
        handle: "genie",
      },
    ];
    const rosterB: never[] = [];
    listSpy.mockResolvedValueOnce([
      {
        id: UUID_A,
        label: "With roster",
        type: "private",
        graphThreadId: "app:default",
        createdAt: "2020-01-01T00:00:00.000Z",
        memberCount: 2,
        messageCount: 0,
        lastMessageAt: null,
        unreadCount: 0,
        kind: "private",
        parentRoomId: null,
        threadRootMessageId: null,
        roster: rosterA,
      },
      {
        id: UUID_B,
        label: "Empty roster",
        type: "private",
        graphThreadId: `room:${UUID_B}`,
        createdAt: "2020-01-02T00:00:00.000Z",
        memberCount: 1,
        messageCount: 0,
        lastMessageAt: null,
        unreadCount: 0,
        kind: "private",
        parentRoomId: null,
        threadRootMessageId: null,
        roster: rosterB,
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rooms: Array<{ id: string; roster?: Array<Record<string, unknown>> }>;
    };
    const withRoster = body.rooms.find((r) => r.id === UUID_A);
    const emptyRoster = body.rooms.find((r) => r.id === UUID_B);
    expect(withRoster?.roster).toEqual(rosterA);
    // An explicitly-empty roster is preserved (not dropped) so the explorer
    // can distinguish "loaded, zero members" from "not loaded".
    expect(emptyRoster?.roster).toEqual([]);
  });

  test("GET /api/rooms omits roster when the producer leaves it undefined", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    listSpy.mockResolvedValueOnce([
      {
        id: UUID_A,
        label: "No roster",
        type: "private",
        graphThreadId: "app:default",
        createdAt: "2020-01-01T00:00:00.000Z",
        memberCount: 2,
        messageCount: 0,
        lastMessageAt: null,
        unreadCount: 0,
        kind: "private",
        parentRoomId: null,
        threadRootMessageId: null,
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rooms: Array<{ id: string; roster?: unknown }>;
    };
    expect(body.rooms[0]?.roster).toBeUndefined();
    // Existing fields are preserved (additive projection).
    expect(body.rooms[0]?.id).toBe(UUID_A);
    expect(body.rooms[0]).not.toHaveProperty("roster");
  });

  test("GET /api/rooms/:id member → 200", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    const detail: RoomDetailPayload = {
      id: UUID_A,
      label: "R",
      type: "private",
      graphThreadId: "app:default",
      createdAt: "2020-01-01T00:00:00.000Z",
      kind: "private",
      parentRoomId: null,
      threadRootMessageId: null,
      conductorMode: "standard",
      members: [
        {
          actorId: "act-owner",
          kind: "user",
          displayName: "Owner",
          roomRole: "admin",
        },
      ],
    };
    getSpy.mockResolvedValueOnce(detail);
    const res = await app.inject({
      method: "GET",
      url: `/api/rooms/${UUID_A}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(detail);
  });

  test("GET /api/rooms/:id non-member → 404", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    getSpy.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: `/api/rooms/${UUID_A}`,
    });
    expect(res.statusCode).toBe(404);
  });

  test("POST /api/rooms empty label → 400", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    setBootstrapDefaultAgentId("agent-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/rooms >80-char label → 400", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    setBootstrapDefaultAgentId("agent-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "x".repeat(81) },
    });
    expect(res.statusCode).toBe(400);
  });

  test("POST /api/rooms as guest → 401", async () => {
    const app = makeApp("guest", null, null);
    setBootstrapDefaultAgentId("agent-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "Hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("PATCH /api/rooms/:id happy path → 200", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    const detail: RoomDetailPayload = {
      id: UUID_A,
      label: "Renamed",
      type: "private",
      graphThreadId: "app:default",
      createdAt: "2020-01-01T00:00:00.000Z",
      kind: "private",
      parentRoomId: null,
      threadRootMessageId: null,
      conductorMode: "standard",
      members: [],
    };
    renameSpy.mockResolvedValueOnce(detail);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${UUID_A}`,
      headers: { "content-type": "application/json" },
      payload: { label: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(detail);
    expect(renameSpy.mock.calls[0]?.[0]).toMatchObject({
      roomId: UUID_A,
      ownerUserId: "usr-owner",
      requesterActorId: "act-owner",
      label: "Renamed",
      allowNonOwner: false,
    });
  });

  test("PATCH /api/rooms/:id passes explicit non-owner authority for manage_rooms", async () => {
    assertCallerCanManageRoomMock.mockResolvedValueOnce({
      role: "server_room_admin",
    });
    renameSpy.mockResolvedValueOnce({
      id: UUID_A,
      label: "Manager rename",
      type: "private",
      graphThreadId: "app:default",
      createdAt: "2020-01-01T00:00:00.000Z",
      kind: "private",
      parentRoomId: null,
      threadRootMessageId: null,
      conductorMode: "standard",
      members: [],
    });
    const app = makeApp("admin", "act-manager", "usr-manager");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${UUID_A}`,
      headers: { "content-type": "application/json" },
      payload: { label: "Manager rename" },
    });

    expect(res.statusCode).toBe(200);
    expect(renameSpy.mock.calls[0]?.[0]).toMatchObject({
      roomId: UUID_A,
      ownerUserId: "usr-manager",
      requesterActorId: "act-manager",
      label: "Manager rename",
      allowNonOwner: true,
    });
  });

  test("PATCH /api/rooms/:id not found → 404", async () => {
    const app = makeApp("owner", "act-owner", "usr-owner");
    renameSpy.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${UUID_A}`,
      headers: { "content-type": "application/json" },
      payload: { label: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  test("GET /api/rooms/manageable without session → 200 []", async () => {
    const app = makeApp("owner", "act-owner", null);
    const res = await app.inject({
      method: "GET",
      url: "/api/rooms/manageable",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ rooms: [] });
    expect(listManageSpy.mock.calls.length).toBe(0);
  });
});

const assertCanCreateRoomMembersMock = mock(
  async (_args: {
    callerUserId: string;
    members: Array<{ kind: "user" | "agent"; id: string }>;
    isAdmin: boolean;
  }) => {},
);
// D219 — rooms.ts manageable / manage-detail routes gate on
// `userHasCapability(uid, "manage_rooms")` (the retired `isUserAdmin` read
// is gone). First call arg stays the userId, so assertions are unchanged.
const userHasCapabilityMock = mock(
  async (_userId: string, _slug: string) => false,
);
const refreshRoomSubscriptionsMock = mock(
  async (_userId: string, _actorId: string) => {},
);
const publishRoomCatalogChangedMock = mock((_userId: string) => {});
const publishRoomMembersChangedMock = mock(
  (_roomId: string, _event: unknown, _recipientSyncNamespaceId?: string) => {},
);
const addRoomMemberMock = mock(
  async (
    _roomId: string,
    _member: { userId: string },
    _roomRole: "admin" | "member",
  ): Promise<AddRoomMemberResult> => ({
    actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind: "user" as const,
    membershipEvent: {
      kind: "member_added" as const,
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actorKind: "user" as const,
      displayName: "Target",
    },
    humanMembershipTransitions: [],
  }),
);
const removeRoomMemberMock = mock(
  async (
    _roomId: string,
    _actorId: string,
    _options: { allowOrphanBypass?: boolean },
  ): Promise<RemoveRoomMemberResult> => ({
    kind: "user" as const,
    membershipEvent: {
      kind: "member_removed" as const,
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actorKind: "user" as const,
      displayName: "Target",
    },
    humanMembershipTransitions: [],
  }),
);
const findActorByIdMock = mock(
  async (_actorId: string): Promise<FindActorByIdResult> => ({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ownerId: UUID_B,
    displayName: "Target",
    kind: "user" as const,
    agentId: null,
  }),
);
// M125 Phase 1.2 — the no-explicit-members POST /api/rooms path now
// derives the agent member from `findPersonalAgentsForUser(callerUserId)`
// instead of `getBootstrapDefaultAgentId()`. This mock lets us drive
// the per-user / empty / throw branches independently.
const findPersonalAgentsForUserMock = mock(
  async (
    _userId: string,
  ): Promise<
    Array<{ agentId: string; handle: string; displayName: string }>
  > => [],
);
// M128 unify (2026-05-29) — POST /api/rooms (multi-member) and
// PATCH /api/rooms/:id route through `manage_rooms` cap / room-
// ownership; mocks default to "caller has manage_rooms" so the
// existing happy-path test cases continue to assert the route's
// post-cap-check behavior.
const getUserCapabilitiesMock = mock(
  // M133 — `read_memories` is the "verified non-guest member" gate on the
  // room-read routes; `manage_rooms` keeps the create/PATCH cap checks happy.
  async (_userId: string): Promise<string[]> => [
    "read_memories",
    "create_rooms",
    "manage_rooms",
  ],
);
const assertCallerCanManageRoomMock = mock(
  async (_callerUserId: string, _roomId: string) =>
    ({ role: "room_owner" }) as {
      role: "room_owner" | "room_admin" | "server_room_admin";
    },
);
const updateRoomMemberRoleMock = mock(
  async (_roomId: string, _actorId: string, _role: "admin" | "member") => {},
);
const updateRoomVisibilityMock = mock(
  async (_roomId: string, _kind: "open" | "group") => true,
);

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    assertCanCreateRoomMembers: assertCanCreateRoomMembersMock,
    addRoomMember: addRoomMemberMock,
    removeRoomMember: removeRoomMemberMock,
    findActorById: findActorByIdMock,
    userHasCapability: userHasCapabilityMock,
    findPersonalAgentsForUser: findPersonalAgentsForUserMock,
    getUserCapabilities: getUserCapabilitiesMock,
    updateRoomMemberRole: updateRoomMemberRoleMock,
    updateRoomVisibility: updateRoomVisibilityMock,
  };
});

mock.module("../../../trust/src/queries", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queries = require("../../../trust/src/queries") as Record<
    string,
    unknown
  >;
  return {
    ...queries,
    updateRoomMemberRole: updateRoomMemberRoleMock,
    updateRoomVisibility: updateRoomVisibilityMock,
  };
});

mock.module("../../src/lib/agent-room-authz", () => ({
  assertCallerCanManageRoom: assertCallerCanManageRoomMock,
  ManageForbiddenError: class ManageForbiddenError extends Error {
    constructor() {
      super("forbidden");
      this.name = "ManageForbiddenError";
    }
  },
}));

mock.module("../../src/realtime/ws-publisher", () => ({
  refreshRoomSubscriptionsForUser: refreshRoomSubscriptionsMock,
  publishRoomCatalogChanged: publishRoomCatalogChangedMock,
  publishRoomMembersChanged: publishRoomMembersChangedMock,
}));

const writeSecurityAuditEventMock = mock(
  (_path: string, _event: { kind: string; roomId?: string }) => {},
);

mock.module("../../src/lib/security-audit-log", () => ({
  ...auditLogModule,
  writeSecurityAuditEvent: writeSecurityAuditEventMock,
}));

let archiveRoomExists = true;
let archiveRoomArchivedAt: Date | null = null;
const archiveDbUpdateSpy = mock(
  async (_values: { archivedAt?: Date | null; updatedAt?: Date }) => {},
);

function makeArchiveDbMock() {
  const updateSetSpy = mock(
    (values: { archivedAt?: Date | null; updatedAt?: Date }) => ({
      where: mock(async (_condition: unknown) => {
        await archiveDbUpdateSpy(values);
        if (values.archivedAt !== undefined) {
          archiveRoomArchivedAt = values.archivedAt;
        }
      }),
    }),
  );
  return {
    select: mock((_selection: unknown) => ({
      from: mock((_table: unknown) => ({
        where: mock((_condition: unknown) => ({
          limit: mock(async (_limit: number) => {
            if (!archiveRoomExists) return [];
            return [{ archivedAt: archiveRoomArchivedAt }];
          }),
        })),
      })),
    })),
    update: mock((_table: unknown) => ({
      set: updateSetSpy,
    })),
    end: mock(async () => {}),
  };
}

const getSharedDirectDbMock = mock(() => makeArchiveDbMock());

mock.module("@nautilo/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realDb = require("@nautilo/db") as Record<string, unknown>;
  return {
    ...realDb,
    getSharedDirectDb: getSharedDirectDbMock,
  };
});

describe("POST /api/rooms — Blocker 2 reachability gate", () => {
  const CALLER_USER = "33333333-3333-4333-8333-333333333333";
  const CALLER_ACTOR = "act-household";
  const TARGET_USER = UUID_B;
  const TARGET_ACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const MISSING_USER = "44444444-4444-4444-8444-444444444444";
  const MISSING_AGENT = "55555555-5555-4555-8555-555555555555";

  const createFromMembersSpy = mock(
    async (_p: {
      ownerUserId: string;
      ownerActorId: string;
      label: string;
      members: Array<{ kind: "user" | "agent"; id: string }>;
      roomType?: "private" | "room";
    }) =>
      ({
        id: UUID_A,
        label: "Test Room",
        type: "private",
        graphThreadId: `room:${UUID_A}`,
        createdAt: "2020-01-01T00:00:00.000Z",
        kind: "private",
        parentRoomId: null,
        threadRootMessageId: null,
        conductorMode: "standard",
        members: [
          {
            actorId: CALLER_ACTOR,
            kind: "user",
            displayName: "Caller",
            userId: CALLER_USER,
            roomRole: "admin",
          },
          {
            actorId: TARGET_ACTOR,
            kind: "user",
            displayName: "Target",
            userId: TARGET_USER,
            roomRole: "member",
          },
        ],
      }) as RoomDetailPayload,
  );

  beforeEach(() => {
    assertCanCreateRoomMembersMock.mockClear();
    assertCanCreateRoomMembersMock.mockImplementation(async () => {});
    userHasCapabilityMock.mockClear();
    userHasCapabilityMock.mockImplementation(async () => false);
    refreshRoomSubscriptionsMock.mockClear();
    publishRoomCatalogChangedMock.mockClear();
    publishRoomMembersChangedMock.mockClear();
    addRoomMemberMock.mockClear();
    addRoomMemberMock.mockImplementation(async () => ({
      actorId: TARGET_ACTOR,
      kind: "user" as const,
      membershipEvent: {
        kind: "member_added" as const,
        actorId: TARGET_ACTOR,
        actorKind: "user" as const,
        displayName: "Target",
      },
      humanMembershipTransitions: [],
    }));
    removeRoomMemberMock.mockClear();
    removeRoomMemberMock.mockImplementation(async () => ({
      kind: "user" as const,
      membershipEvent: {
        kind: "member_removed" as const,
        actorId: TARGET_ACTOR,
        actorKind: "user" as const,
        displayName: "Target",
      },
      humanMembershipTransitions: [],
    }));
    findActorByIdMock.mockClear();
    findActorByIdMock.mockImplementation(async () => ({
      id: TARGET_ACTOR,
      ownerId: TARGET_USER,
      displayName: "Target",
      kind: "user" as const,
      agentId: null,
    }));
    createFromMembersSpy.mockClear();
    getUserCapabilitiesMock.mockClear();
    getUserCapabilitiesMock.mockImplementation(async () => [
      "read_memories",
      "create_rooms",
      "manage_rooms",
    ]);
    assertCallerCanManageRoomMock.mockClear();
    assertCallerCanManageRoomMock.mockImplementation(
      async () =>
        ({ role: "room_owner" }) as {
          role: "room_owner" | "room_admin" | "server_room_admin";
        },
    );
  });

  function makeApp(
    role: string,
    actorId: string,
    userId: string,
    overrides: Partial<RoomsRouteService> = {},
    produceHumanMembershipEvent?: HumanMembershipEventProducer,
  ) {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    const service: RoomsRouteService = {
      listRoomsForActor: mock(async () => []),
      getRoomDetailForMember: mock(async () => null),
      createRoomForOwner: mock(async () => ({}) as RoomDetailPayload),
      createRoomFromMembers: createFromMembersSpy,
      renamePrivateRoomForOwner: mock(async () => null),
      listManageableRoomsForUser: mock(async () => []),
      getRoomDetailForManager: mock(async () => null),
      ...overrides,
      assertCanInvokeAgent: async () => {},
    };
    roomsRoutes(app, service, undefined, produceHumanMembershipEvent);
    app.addHook("preHandler", async (request) => {
      (request as { policyContext?: { actorRole: string } }).policyContext = {
        actorRole: role,
      };
      (request as { sessionActorId?: string }).sessionActorId = actorId;
      (request as { sessionUserId?: string }).sessionUserId = userId;
    });
    return app;
  }

  test("Member with create_rooms but no manage_rooms creates a shared Room", async () => {
    getUserCapabilitiesMock.mockImplementationOnce(async () => [
      "create_rooms",
    ]);
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Local DM",
        members: [
          { kind: "user", id: CALLER_USER },
          { kind: "user", id: TARGET_USER },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(assertCanCreateRoomMembersMock.mock.calls.length).toBe(1);
    expect(createFromMembersSpy.mock.calls.length).toBe(1);
    expect(getUserCapabilitiesMock.mock.calls[0]?.[0]).toBe(CALLER_USER);
    expect(refreshRoomSubscriptionsMock.mock.calls).toEqual([
      [CALLER_USER, CALLER_ACTOR],
      [TARGET_USER, TARGET_ACTOR],
    ]);
    expect(publishRoomCatalogChangedMock.mock.calls).toEqual([
      [CALLER_USER],
      [TARGET_USER],
    ]);
  });

  test("an active ban prevents direct Human addition without publishing a membership change", async () => {
    addRoomMemberMock.mockRejectedValueOnce(new trustModule.ModerationError("active_ban"));
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({ method: "POST", url: `/api/rooms/${UUID_A}/members`,
      payload: { kind: "user", userId: TARGET_USER, roomRole: "member" } });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>()).toEqual({ code: "active_ban" });
    expect(publishRoomMembersChangedMock).not.toHaveBeenCalled();
    expect(refreshRoomSubscriptionsMock).not.toHaveBeenCalled();
    expect(writeSecurityAuditEventMock).not.toHaveBeenCalled();
  });

  test("adding a Human invalidates that Human's Room catalogue", async () => {
    addRoomMemberMock.mockResolvedValueOnce({
      actorId: TARGET_ACTOR,
      kind: "user",
      membershipEvent: {
        kind: "member_added",
        actorId: TARGET_ACTOR,
        actorKind: "user",
        displayName: "Target",
      },
      membershipMessageId: 81,
      humanMembershipTransitions: [
        {
          kind: "human_add",
          targetHumanActorId: TARGET_ACTOR,
          previous: {
            roomId: UUID_A,
            namespaceId: UUID_B,
            namespaceAccessRevision: 1,
            participantHumanActorIds: [CALLER_ACTOR],
          },
          current: {
            roomId: UUID_A,
            namespaceId: UUID_B,
            namespaceAccessRevision: 2,
            participantHumanActorIds: [CALLER_ACTOR, TARGET_ACTOR].sort(),
          },
        },
      ],
    });
    const produce = mock(async () => {});
    const resolve = mock(async () => UUID_B);
    const app = makeApp(
      "household",
      CALLER_ACTOR,
      CALLER_USER,
      {
        resolveProtectedRecipientSyncNamespace: resolve,
      },
      produce,
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/members`,
      headers: { "content-type": "application/json" },
      payload: {
        kind: "user",
        userId: TARGET_USER,
        roomRole: "member",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(addRoomMemberMock).toHaveBeenCalledWith(
      UUID_A,
      { userId: TARGET_USER },
      "member",
    );
    expect(refreshRoomSubscriptionsMock).toHaveBeenCalledWith(
      TARGET_USER,
      TARGET_ACTOR,
    );
    expect(publishRoomCatalogChangedMock).toHaveBeenCalledWith(TARGET_USER);
    expect(produce).toHaveBeenCalledWith({
      type: "room.member_joined",
      roomId: UUID_A,
      subjectUserId: TARGET_USER,
      initiatorActorId: CALLER_ACTOR,
      initiatorUserId: CALLER_USER,
      membershipMessageId: 81,
    });
    expect(resolve).toHaveBeenCalledWith(UUID_A);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_A,
      expect.objectContaining({ kind: "member_added", actorId: TARGET_ACTOR }),
      UUID_B,
    );
    expect(JSON.parse(res.body)).toMatchObject({
      protectedEncryption: {
        status: "pending",
        namespaceId: UUID_B,
        accessRevision: 2,
      },
    });
  });

  test("a no-event Human add retains its Room catalogue convergence", async () => {
    addRoomMemberMock.mockResolvedValueOnce({
      actorId: TARGET_ACTOR,
      kind: "user",
    });
    const resolve = mock(async () => UUID_B);
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER, {
      resolveProtectedRecipientSyncNamespace: resolve,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/members`,
      headers: { "content-type": "application/json" },
      payload: {
        kind: "user",
        userId: TARGET_USER,
        roomRole: "member",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(refreshRoomSubscriptionsMock).toHaveBeenCalledWith(
      TARGET_USER,
      TARGET_ACTOR,
    );
    expect(publishRoomCatalogChangedMock).toHaveBeenCalledWith(TARGET_USER);
    expect(resolve).not.toHaveBeenCalled();
    expect(publishRoomMembersChangedMock).not.toHaveBeenCalled();
  });

  test("removing a Human invalidates that Human's Room catalogue", async () => {
    removeRoomMemberMock.mockResolvedValueOnce({
      kind: "user",
      membershipEvent: {
        kind: "member_removed",
        actorId: TARGET_ACTOR,
        actorKind: "user",
        displayName: "Target",
      },
      membershipMessageId: 82,
      humanMembershipTransitions: [
        {
          kind: "human_remove",
          targetHumanActorId: TARGET_ACTOR,
          previous: {
            roomId: UUID_A,
            namespaceId: UUID_B,
            namespaceAccessRevision: 2,
            participantHumanActorIds: [CALLER_ACTOR, TARGET_ACTOR].sort(),
          },
          current: {
            roomId: UUID_A,
            namespaceId: UUID_B,
            namespaceAccessRevision: 3,
            participantHumanActorIds: [CALLER_ACTOR],
          },
        },
      ],
    });
    const produce = mock(async () => {});
    const resolve = mock(async () => UUID_B);
    const app = makeApp(
      "household",
      CALLER_ACTOR,
      CALLER_USER,
      {
        resolveProtectedRecipientSyncNamespace: resolve,
      },
      produce,
    );
    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_A}/members/${TARGET_ACTOR}`,
    });

    expect(res.statusCode).toBe(200);
    expect(removeRoomMemberMock).toHaveBeenCalledWith(UUID_A, TARGET_ACTOR, {
      allowOrphanBypass: false,
    });
    expect(refreshRoomSubscriptionsMock).toHaveBeenCalledWith(
      TARGET_USER,
      TARGET_ACTOR,
    );
    expect(publishRoomCatalogChangedMock).toHaveBeenCalledWith(TARGET_USER);
    expect(produce).toHaveBeenCalledWith({
      type: "room.member_left",
      roomId: UUID_A,
      subjectUserId: TARGET_USER,
      initiatorActorId: CALLER_ACTOR,
      initiatorUserId: CALLER_USER,
      membershipMessageId: 82,
    });
    expect(resolve).toHaveBeenCalledWith(UUID_A);
    expect(publishRoomMembersChangedMock).toHaveBeenCalledWith(
      UUID_A,
      expect.objectContaining({
        kind: "member_removed",
        actorId: TARGET_ACTOR,
      }),
      UUID_B,
    );
    expect(JSON.parse(res.body)).toMatchObject({
      protectedEncryption: {
        status: "pending",
        namespaceId: UUID_B,
        accessRevision: 3,
      },
    });
  });

  test("removing an Agent never invokes the Human membership producer", async () => {
    findActorByIdMock.mockResolvedValueOnce({
      id: TARGET_ACTOR,
      ownerId: TARGET_USER,
      displayName: "Genie",
      kind: "agent",
      agentId: TARGET_ACTOR,
    });
    removeRoomMemberMock.mockResolvedValueOnce({
      kind: "agent",
      membershipEvent: {
        kind: "member_removed",
        actorId: TARGET_ACTOR,
        actorKind: "agent",
        displayName: "Genie",
      },
      membershipMessageId: 83,
      humanMembershipTransitions: [],
    });
    const produce = mock(async () => {});
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER, {}, produce);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${UUID_A}/members/${TARGET_ACTOR}`,
    });

    expect(res.statusCode).toBe(200);
    expect(produce).not.toHaveBeenCalled();
  });

  test("explicit named Room persists its human-facing catalogue marker", async () => {
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Launch planning",
        catalogueKind: "room",
        members: [
          { kind: "user", id: CALLER_USER },
          { kind: "user", id: TARGET_USER },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(createFromMembersSpy.mock.calls[0]?.[0]).toMatchObject({
      roomType: "room",
    });
  });

  test("rejects unknown human-facing catalogue kinds", async () => {
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Mystery",
        catalogueKind: "direct",
        members: [{ kind: "user", id: CALLER_USER }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "catalogueKind must be chat or room",
    });
    expect(createFromMembersSpy.mock.calls.length).toBe(0);
  });

  test("non-admin creates room with federated user (denied)", async () => {
    assertCanCreateRoomMembersMock.mockImplementationOnce(async () => {
      throw new CreateRoomReachabilityError(
        "User not reachable",
        "user_not_reachable",
        "user",
        TARGET_USER,
      );
    });
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Fed DM",
        members: [
          { kind: "user", id: CALLER_USER },
          { kind: "user", id: TARGET_USER },
        ],
      },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as {
      error: string;
      memberKind: string;
      memberId: string;
    };
    expect(body.error).toBe("user_not_reachable");
    expect(body.memberKind).toBe("user");
    expect(body.memberId).toBe(TARGET_USER);
    expect(createFromMembersSpy.mock.calls.length).toBe(0);
  });

  test("non-admin creates room with non-existent user (404)", async () => {
    assertCanCreateRoomMembersMock.mockImplementationOnce(async () => {
      throw new CreateRoomReachabilityError(
        "User not found",
        "user_not_found",
        "user",
        MISSING_USER,
      );
    });
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Missing user",
        members: [
          { kind: "user", id: CALLER_USER },
          { kind: "user", id: MISSING_USER },
        ],
      },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("user_not_found");
    expect(createFromMembersSpy.mock.calls.length).toBe(0);
  });

  test("non-admin creates room with non-existent agent (404)", async () => {
    assertCanCreateRoomMembersMock.mockImplementationOnce(async () => {
      throw new CreateRoomReachabilityError(
        "Agent not found",
        "agent_not_found",
        "agent",
        MISSING_AGENT,
      );
    });
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Missing agent",
        members: [
          { kind: "user", id: CALLER_USER },
          { kind: "agent", id: MISSING_AGENT },
        ],
      },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("agent_not_found");
    expect(createFromMembersSpy.mock.calls.length).toBe(0);
  });

  test("server admin cannot add a federated identity to a local Room", async () => {
    assertCanCreateRoomMembersMock.mockImplementationOnce(async () => {
      throw new CreateRoomReachabilityError(
        "User not reachable",
        "user_not_reachable",
        "user",
        TARGET_USER,
      );
    });
    getUserCapabilitiesMock.mockImplementationOnce(async () => [
      "read_memories",
      "create_rooms",
      "manage_rooms",
      "manage_members",
    ]);
    const app = makeApp("owner", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Admin fed DM",
        members: [
          { kind: "user", id: CALLER_USER },
          { kind: "user", id: TARGET_USER },
        ],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(getUserCapabilitiesMock.mock.calls[0]?.[0]).toBe(CALLER_USER);
    expect(assertCanCreateRoomMembersMock.mock.calls.length).toBe(1);
    expect(assertCanCreateRoomMembersMock.mock.calls[0]?.[0]).toMatchObject({
      callerUserId: CALLER_USER,
      isAdmin: true,
    });
    expect(createFromMembersSpy.mock.calls.length).toBe(0);
  });

  test("creator-only shared Room still requires create_rooms", async () => {
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Solo room",
        members: [{ kind: "user", id: CALLER_USER }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(assertCanCreateRoomMembersMock.mock.calls.length).toBe(1);
    expect(assertCanCreateRoomMembersMock.mock.calls[0]?.[0]).toMatchObject({
      callerUserId: CALLER_USER,
      members: [{ kind: "user", id: CALLER_USER }],
    });
    expect(createFromMembersSpy.mock.calls.length).toBe(1);
  });

  test("Guest without create_rooms cannot create a shared Room", async () => {
    getUserCapabilitiesMock.mockImplementationOnce(async () => []);
    const app = makeApp("guest", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Not allowed",
        members: [
          { kind: "user", id: CALLER_USER },
          { kind: "user", id: TARGET_USER },
        ],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "create_rooms_required",
    });
    expect(createFromMembersSpy).not.toHaveBeenCalled();
  });
});

/**
 * M125 Phase 1.2 — `POST /api/rooms` without `members[]` ("New chat")
 * must use the CALLER'S own primary agent (deterministic owned[0]
 * after Phase 0), not borrow `getBootstrapDefaultAgentId()`. Without
 * this, every non-operator user's new room landed the operator's
 * agent as the sole agent member.
 *
 * Covers QA scenario #3.
 */
describe("POST /api/rooms — M125 Phase 1.2 (no-members uses caller's own agent)", () => {
  const CALLER_USER = "33333333-3333-4333-8333-333333333333";
  const CALLER_ACTOR = "act-household";
  const CALLER_AGENT = "66666666-6666-4666-8666-666666666666";

  const createForOwnerSpy = mock(
    async (_p: CreateRoomForOwnerParams) =>
      ({
        id: UUID_A,
        label: "Test Room",
        type: "private",
        graphThreadId: `room:${UUID_A}`,
        createdAt: "2020-01-01T00:00:00.000Z",
        kind: "private",
        parentRoomId: null,
        threadRootMessageId: null,
        conductorMode: "standard",
        members: [],
      }) as RoomDetailPayload,
  );

  beforeEach(() => {
    findPersonalAgentsForUserMock.mockClear();
    findPersonalAgentsForUserMock.mockImplementation(async () => []);
    createForOwnerSpy.mockClear();
    refreshRoomSubscriptionsMock.mockClear();
    publishRoomCatalogChangedMock.mockClear();
  });

  function makeApp(
    role: string,
    actorId: string,
    userId: string,
    overrides: Partial<RoomsRouteService> = {},
  ) {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    const service: RoomsRouteService = {
      listRoomsForActor: mock(async () => []),
      getRoomDetailForMember: mock(async () => null),
      createRoomForOwner: createForOwnerSpy,
      assertCanInvokeAgent: async () => {},
      renamePrivateRoomForOwner: mock(async () => null),
      listManageableRoomsForUser: mock(async () => []),
      getRoomDetailForManager: mock(async () => null),
      ...overrides,
    };
    roomsRoutes(app, service);
    app.addHook("preHandler", async (request) => {
      (request as { policyContext?: { actorRole: string } }).policyContext = {
        actorRole: role,
      };
      (request as { sessionActorId?: string }).sessionActorId = actorId;
      (request as { sessionUserId?: string }).sessionUserId = userId;
    });
    return app;
  }

  test("no-members POST uses caller's owned[0].agentId (not bootstrap default)", async () => {
    findPersonalAgentsForUserMock.mockImplementationOnce(async (uid) => {
      expect(uid).toBe(CALLER_USER);
      return [
        {
          agentId: CALLER_AGENT,
          handle: "genie_caller",
          displayName: "Caller's Genie",
        },
      ];
    });
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "New chat" },
    });
    expect(res.statusCode).toBe(201);
    expect(findPersonalAgentsForUserMock.mock.calls.length).toBe(1);
    expect(createForOwnerSpy.mock.calls.length).toBe(1);
    expect(createForOwnerSpy.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId: CALLER_USER,
      ownerActorId: CALLER_ACTOR,
      defaultAgentId: CALLER_AGENT,
      label: "New chat",
    });
    expect(publishRoomCatalogChangedMock).toHaveBeenCalledWith(CALLER_USER);
  });

  test("personalAgentId mints a fresh chat with that exact owned Genie", async () => {
    const SECOND_AGENT = "77777777-7777-4777-8777-777777777777";
    findPersonalAgentsForUserMock.mockImplementationOnce(async () => [
      {
        agentId: CALLER_AGENT,
        handle: "genie_primary",
        displayName: "Primary Genie",
      },
      {
        agentId: SECOND_AGENT,
        handle: "genie_second",
        displayName: "Second Genie",
      },
    ]);
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "Fresh Genie chat", personalAgentId: SECOND_AGENT },
    });

    expect(res.statusCode).toBe(201);
    expect(createForOwnerSpy.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId: CALLER_USER,
      defaultAgentId: SECOND_AGENT,
      label: "Fresh Genie chat",
    });
  });

  test("personalAgentId rejects an Agent the caller does not own", async () => {
    const NOT_OWNED = "88888888-8888-4888-8888-888888888888";
    findPersonalAgentsForUserMock.mockImplementationOnce(async () => [
      {
        agentId: CALLER_AGENT,
        handle: "genie_primary",
        displayName: "Primary Genie",
      },
    ]);
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "Forbidden Genie chat", personalAgentId: NOT_OWNED },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "personal_agent_required",
      code: "personal_agent_required",
    });
    expect(createForOwnerSpy.mock.calls.length).toBe(0);
  });

  test("personalAgentId cannot be combined with an explicit roster", async () => {
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Ambiguous chat",
        personalAgentId: CALLER_AGENT,
        members: [{ kind: "user", id: CALLER_USER }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "personalAgentId cannot be combined with members",
    });
    expect(createForOwnerSpy.mock.calls.length).toBe(0);
  });

  test("personalAgentId requires an unambiguous private chat contract", async () => {
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    for (const payload of [
      { label: "Not open", personalAgentId: CALLER_AGENT, kind: "open" },
      { label: "Not group", personalAgentId: CALLER_AGENT, kind: "group" },
      {
        label: "Not a Room",
        personalAgentId: CALLER_AGENT,
        catalogueKind: "room",
      },
      { label: "No empty roster", personalAgentId: CALLER_AGENT, members: [] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(createForOwnerSpy.mock.calls.length).toBe(0);
  });

  test("Guest directHumanUserId delegates reuse to the atomic Human-DM resolver", async () => {
    const TARGET_USER = "99999999-9999-4999-8999-999999999999";
    const TARGET_ACTOR = "act-target";
    const detail = {
      id: UUID_B,
      label: "Casey",
      type: "shared",
      graphThreadId: `room:${UUID_B}`,
      createdAt: "2026-08-13T00:00:00.000Z",
      kind: "group",
      parentRoomId: null,
      threadRootMessageId: null,
      conductorMode: "standard",
      members: [],
    } as RoomDetailPayload;
    const resolveDirect = mock(async () => detail);
    getUserCapabilitiesMock.mockImplementationOnce(async () => []);
    const app = makeApp("guest", CALLER_ACTOR, CALLER_USER, {
      findActorByOwnerId: mock(async (userId: string) =>
        userId === TARGET_USER
          ? ({ id: TARGET_ACTOR } as Awaited<
              ReturnType<NonNullable<RoomsRouteService["findActorByOwnerId"]>>
            >)
          : null,
      ),
      findOrCreateHumanOnlyDirectRoom: resolveDirect,
      humanPairIsBlocked: mock(async () => false),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Casey",
        kind: "private",
        directHumanUserId: TARGET_USER,
      },
    });
    expect(response.statusCode).toBe(201);
    expect((JSON.parse(response.body) as { id: string }).id).toBe(UUID_B);
    expect(resolveDirect).toHaveBeenCalledWith({
      ownerUserId: CALLER_USER,
      ownerActorId: CALLER_ACTOR,
      guestActorId: TARGET_ACTOR,
      label: "Casey",
    });
    expect(createForOwnerSpy.mock.calls.length).toBe(0);
  });

  test("directHumanUserId rejects either direction of a Human block before room resolution", async () => {
    const TARGET_USER = "99999999-9999-4999-8999-999999999999";
    const resolveDirect = mock(async () => ({}) as RoomDetailPayload);
    const app = makeApp("guest", CALLER_ACTOR, CALLER_USER, {
      humanPairIsBlocked: mock(async () => true),
      findOrCreateHumanOnlyDirectRoom: resolveDirect,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: {
        label: "Casey",
        kind: "private",
        directHumanUserId: TARGET_USER,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "direct_human_interaction_blocked",
      code: "direct_human_interaction_blocked",
    });
    expect(resolveDirect).not.toHaveBeenCalled();
  });

  test("no-members POST when caller owns no agent → 400 no_default_agent", async () => {
    findPersonalAgentsForUserMock.mockImplementationOnce(async () => []);
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "Orphan attempt" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { code?: string; error?: string };
    expect(body.code).toBe("no_default_agent");
    expect(createForOwnerSpy.mock.calls.length).toBe(0);
  });

  test("no-members POST when agent lookup throws → 500 agent_resolution_failed", async () => {
    findPersonalAgentsForUserMock.mockImplementationOnce(async () => {
      throw new Error("simulated DB blip");
    });
    const app = makeApp("household", CALLER_ACTOR, CALLER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: { label: "Storm" },
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { code?: string };
    expect(body.code).toBe("agent_resolution_failed");
    expect(createForOwnerSpy.mock.calls.length).toBe(0);
  });
});

/**
 * D287 — `POST /api/rooms/:id/archive` and `unarchive` (manager gate, idempotent
 * audit, DB side effects). Hermetic via mocked `@nautilo/db` + audit writer.
 */
describe("D287 — archive / unarchive routes", () => {
  const MANAGER_USER = "77777777-7777-4777-8777-777777777777";
  const MANAGER_ACTOR = "act-manager";

  beforeEach(() => {
    archiveRoomExists = true;
    archiveRoomArchivedAt = null;
    archiveDbUpdateSpy.mockClear();
    getSharedDirectDbMock.mockClear();
    writeSecurityAuditEventMock.mockClear();
    assertCallerCanManageRoomMock.mockClear();
    assertCallerCanManageRoomMock.mockImplementation(
      async () =>
        ({ role: "room_owner" }) as {
          role: "room_owner" | "room_admin" | "server_room_admin";
        },
    );
  });

  function makeApp(
    role: string,
    actorId: string | null,
    userId: string | null,
  ) {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    const service: RoomsRouteService = {
      listRoomsForActor: mock(async () => []),
      getRoomDetailForMember: mock(async () => null),
      createRoomForOwner: mock(async () => ({}) as RoomDetailPayload),
      renamePrivateRoomForOwner: mock(async () => null),
      listManageableRoomsForUser: mock(async () => []),
      getRoomDetailForManager: mock(async () => null),
    };
    roomsRoutes(app, service);
    app.addHook("preHandler", async (request) => {
      (request as { policyContext?: { actorRole: string } }).policyContext = {
        actorRole: role,
      };
      (request as { sessionActorId?: string | null }).sessionActorId = actorId;
      (request as { sessionUserId?: string | null }).sessionUserId = userId;
    });
    return app;
  }

  test("POST /api/rooms/:id/archive by manager → 200, sets archivedAt, one audit", async () => {
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/archive`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(assertCallerCanManageRoomMock.mock.calls[0]?.[0]).toBe(MANAGER_USER);
    expect(assertCallerCanManageRoomMock.mock.calls[0]?.[1]).toBe(UUID_A);
    expect(archiveDbUpdateSpy.mock.calls.length).toBe(1);
    expect(archiveDbUpdateSpy.mock.calls[0]?.[0]?.archivedAt).toBeInstanceOf(
      Date,
    );
    expect(archiveRoomArchivedAt).toBeInstanceOf(Date);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(1);
    expect(writeSecurityAuditEventMock.mock.calls[0]?.[1]).toMatchObject({
      kind: "room_archived",
      roomId: UUID_A,
      actorId: MANAGER_ACTOR,
    });
  });

  test("POST /api/rooms/:id/archive by non-manager → 403", async () => {
    assertCallerCanManageRoomMock.mockImplementationOnce(async () => {
      throw new ManageForbiddenError();
    });
    const app = makeApp("household", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/archive`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    expect(archiveDbUpdateSpy.mock.calls.length).toBe(0);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(0);
  });

  test("re-archive already-archived room → 200 idempotent, no second audit", async () => {
    archiveRoomArchivedAt = new Date("2020-01-01T00:00:00.000Z");
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/archive`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(archiveDbUpdateSpy.mock.calls.length).toBe(0);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(0);
  });

  test("POST /api/rooms/:id/unarchive → 200, clears archivedAt", async () => {
    archiveRoomArchivedAt = new Date("2020-01-01T00:00:00.000Z");
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/unarchive`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(archiveDbUpdateSpy.mock.calls.length).toBe(1);
    expect(archiveDbUpdateSpy.mock.calls[0]?.[0]?.archivedAt).toBeNull();
    expect(archiveRoomArchivedAt).toBeNull();
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(1);
    expect(writeSecurityAuditEventMock.mock.calls[0]?.[1]).toMatchObject({
      kind: "room_unarchived",
      roomId: UUID_A,
    });
  });

  test("POST /api/rooms/:id/archive unsigned → 401", async () => {
    const app = makeApp("guest", null, null);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/archive`,
    });
    expect(res.statusCode).toBe(401);
    expect(assertCallerCanManageRoomMock.mock.calls.length).toBe(0);
    expect(archiveDbUpdateSpy.mock.calls.length).toBe(0);
  });

  test("POST /api/rooms/:id/archive bad uuid → 400", async () => {
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms/not-a-uuid/archive",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid room id" });
    expect(assertCallerCanManageRoomMock.mock.calls.length).toBe(0);
  });

  test("POST /api/rooms/:id/archive missing room → 404", async () => {
    archiveRoomExists = false;
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/archive`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
    expect(archiveDbUpdateSpy.mock.calls.length).toBe(0);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(0);
  });
});

/**
 * D194 — `POST /api/rooms/:id/visibility` (manage_rooms gate, open ↔ group).
 */
describe("D194 — room visibility flip", () => {
  const MANAGER_USER = "99999999-9999-4999-8999-999999999999";
  const MANAGER_ACTOR = "act-visibility-manager";

  beforeEach(() => {
    updateRoomVisibilityMock.mockClear();
    updateRoomVisibilityMock.mockImplementation(async () => true);
    userHasCapabilityMock.mockClear();
    userHasCapabilityMock.mockImplementation(
      async (_userId, slug) => slug === "manage_rooms",
    );
    writeSecurityAuditEventMock.mockClear();
  });

  function makeApp(
    role: string,
    actorId: string | null,
    userId: string | null,
  ) {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    const service: RoomsRouteService = {
      listRoomsForActor: mock(async () => []),
      getRoomDetailForMember: mock(async () => null),
      createRoomForOwner: mock(async () => ({}) as RoomDetailPayload),
      renamePrivateRoomForOwner: mock(async () => null),
      listManageableRoomsForUser: mock(async () => []),
      getRoomDetailForManager: mock(async () => null),
    };
    roomsRoutes(app, service);
    app.addHook("preHandler", async (request) => {
      (request as { policyContext?: { actorRole: string } }).policyContext = {
        actorRole: role,
      };
      (request as { sessionActorId?: string | null }).sessionActorId = actorId;
      (request as { sessionUserId?: string | null }).sessionUserId = userId;
    });
    return app;
  }

  test("POST visibility public:true by manage_rooms holder → 200, kind open, one audit", async () => {
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/visibility`,
      headers: { "content-type": "application/json" },
      payload: { public: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(
      userHasCapabilityMock.mock.calls.some((c) => c[1] === "manage_rooms"),
    ).toBe(true);
    expect(updateRoomVisibilityMock.mock.calls.length).toBe(1);
    expect(updateRoomVisibilityMock.mock.calls[0]).toEqual([UUID_A, "open"]);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(1);
    expect(writeSecurityAuditEventMock.mock.calls[0]?.[1]).toMatchObject({
      kind: "room_visibility_changed",
      roomId: UUID_A,
      actorId: MANAGER_ACTOR,
      newKind: "open",
    });
  });

  test("POST visibility by caller WITHOUT manage_rooms → 403, no mutation, no audit", async () => {
    userHasCapabilityMock.mockImplementation(async () => false);
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/visibility`,
      headers: { "content-type": "application/json" },
      payload: { public: true },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "forbidden",
      code: "admin_required",
    });
    expect(updateRoomVisibilityMock.mock.calls.length).toBe(0);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(0);
  });

  test("POST visibility when kind not open/group → 409, no mutation", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MembershipOpError } = require("@nautilo/trust") as {
      MembershipOpError: new (code: string) => Error;
    };
    updateRoomVisibilityMock.mockImplementationOnce(async () => {
      throw new MembershipOpError("invalid_kind_for_visibility");
    });
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "POST",
      url: `/api/rooms/${UUID_A}/visibility`,
      headers: { "content-type": "application/json" },
      payload: { public: false },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "invalid kind for visibility",
      code: "invalid_kind_for_visibility",
    });
    expect(updateRoomVisibilityMock.mock.calls.length).toBe(1);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(0);
  });
});

/**
 * D194 C2 — `PATCH /api/rooms/:id/members/:actorId` with `{ roomRole }`
 * for human members (manager gate, trust mutation side effect).
 */
describe("D194 C2 — PATCH room member role", () => {
  const MANAGER_USER = "88888888-8888-4888-8888-888888888888";
  const MANAGER_ACTOR = "act-role-manager";
  const TARGET_ACTOR = UUID_B;

  beforeEach(() => {
    updateRoomMemberRoleMock.mockClear();
    assertCallerCanManageRoomMock.mockClear();
    assertCallerCanManageRoomMock.mockImplementation(
      async () =>
        ({ role: "room_owner" }) as {
          role: "room_owner" | "room_admin" | "server_room_admin";
        },
    );
    writeSecurityAuditEventMock.mockClear();
  });

  function makeApp(
    role: string,
    actorId: string | null,
    userId: string | null,
    produceHumanMembershipEvent?: HumanMembershipEventProducer,
  ) {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    const service: RoomsRouteService = {
      listRoomsForActor: mock(async () => []),
      getRoomDetailForMember: mock(async () => null),
      createRoomForOwner: mock(async () => ({}) as RoomDetailPayload),
      renamePrivateRoomForOwner: mock(async () => null),
      listManageableRoomsForUser: mock(async () => []),
      getRoomDetailForManager: mock(async () => null),
    };
    roomsRoutes(app, service, undefined, produceHumanMembershipEvent);
    app.addHook("preHandler", async (request) => {
      (request as { policyContext?: { actorRole: string } }).policyContext = {
        actorRole: role,
      };
      (request as { sessionActorId?: string | null }).sessionActorId = actorId;
      (request as { sessionUserId?: string | null }).sessionUserId = userId;
    });
    return app;
  }

  test("PATCH roomRole by manager → 200, role persisted, one audit", async () => {
    const produce = mock(async () => {});
    const app = makeApp("owner", MANAGER_ACTOR, MANAGER_USER, produce);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${UUID_A}/members/${TARGET_ACTOR}`,
      headers: { "content-type": "application/json" },
      payload: { roomRole: "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      actorId: TARGET_ACTOR,
      roomRole: "admin",
    });
    expect(assertCallerCanManageRoomMock.mock.calls[0]?.[0]).toBe(MANAGER_USER);
    expect(assertCallerCanManageRoomMock.mock.calls[0]?.[1]).toBe(UUID_A);
    expect(updateRoomMemberRoleMock.mock.calls.length).toBe(1);
    expect(updateRoomMemberRoleMock.mock.calls[0]).toEqual([
      UUID_A,
      TARGET_ACTOR,
      "admin",
    ]);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(1);
    expect(writeSecurityAuditEventMock.mock.calls[0]?.[1]).toMatchObject({
      kind: "room_member_role_updated",
      roomId: UUID_A,
      targetActorId: TARGET_ACTOR,
      roomRole: "admin",
    });
    expect(produce).not.toHaveBeenCalled();
  });

  test("PATCH roomRole by non-manager → 403, no trust mutation", async () => {
    assertCallerCanManageRoomMock.mockImplementationOnce(async () => {
      throw new ManageForbiddenError();
    });
    const app = makeApp("household", MANAGER_ACTOR, MANAGER_USER);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/rooms/${UUID_A}/members/${TARGET_ACTOR}`,
      headers: { "content-type": "application/json" },
      payload: { roomRole: "member" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    expect(updateRoomMemberRoleMock.mock.calls.length).toBe(0);
    expect(writeSecurityAuditEventMock.mock.calls.length).toBe(0);
  });
});
