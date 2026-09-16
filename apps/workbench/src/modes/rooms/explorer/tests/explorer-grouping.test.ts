import { describe, expect, test } from "bun:test";
import {
  compareExplorerRows,
  filterSectionsByQuery,
  groupRoomsForExplorer,
  sortExplorerRows,
} from "../explorer-grouping";
import type { ExplorerRow, ExplorerRosterMember } from "../explorer-grouping.types";
import type { WorkbenchRoomSummary } from "../../../../rooms/room-navigation-types";

/**
 * D246 Wave 2 (task 2.2 / 2.5) — the explorer classifies rows from the roster
 * projection folded into `GET /api/rooms`. Default startup must issue ZERO
 * `GET /api/rooms/:id` requests solely to classify explorer rows, regardless
 * of how many rooms are visible.
 *
 * The sibling RelationshipExplorer suite mocks the hook module process-wide.
 * The projection helper below runs the real module in a child Bun isolate so
 * the combined acceptance command exercises production mapping rather than
 * inheriting that unrelated component-test mock.
 */
async function buildExplorerRostersInIsolate(
  rooms: WorkbenchRoomSummary[],
): Promise<Map<string, ExplorerRosterMember[]>> {
  const modulePath = new URL("../use-explorer-data.ts", import.meta.url).pathname;
  const script = `
    import { buildExplorerRosters } from ${JSON.stringify(modulePath)};
    const rooms = JSON.parse(process.env.D246_ROOMS);
    console.log(JSON.stringify([...buildExplorerRosters(rooms)]));
  `;
  const child = Bun.spawn(["bun", "-e", script], {
    env: { ...process.env, D246_ROOMS: JSON.stringify(rooms) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`isolated roster projection failed (${exitCode}): ${stderr}`);
  }
  return new Map(JSON.parse(stdout) as Array<[string, ExplorerRosterMember[]]>);
}

function mkRoom(
  partial: Partial<WorkbenchRoomSummary> & Pick<WorkbenchRoomSummary, "id" | "label">,
): WorkbenchRoomSummary {
  return {
    type: "private",
    graphThreadId: "g-test",
    createdAt: "2026-01-01T00:00:00.000Z",
    memberCount: 2,
    kind: "private",
    pinned: false,
    tabOpen: true,
    closedTab: false,
    lastOpenedAt: null,
    tabOrder: null,
    ...partial,
  };
}

function roster(map: Record<string, ExplorerRosterMember[]>): Map<string, ExplorerRosterMember[]> {
  return new Map(Object.entries(map));
}

const VIEWER = "actor-viewer";
const HUMAN_A = "actor-a";
const HUMAN_B = "actor-b";
const AGENT_G = "actor-genie";
const AGENT_G_ID = "agent-genie-id";

describe("groupRoomsForExplorer", () => {
  test("1:1 people DM with federated counterparty and nested direct room", () => {
    const rooms = [
      mkRoom({
        id: "dm-ab",
        label: "DM",
        kind: "private",
        memberCount: 2,
        lastMessageAt: "2026-05-01T10:00:00.000Z",
      }),
    ];
    const rosters = roster({
      "dm-ab": [
        { actorId: VIEWER, kind: "user", displayName: "Me" },
        {
          actorId: HUMAN_A,
          kind: "user",
          displayName: "Jordan",
          handle: { local: "jordan", server: "remote.example.com" },
        },
      ],
    });
    const sections = groupRoomsForExplorer({ rooms, rosters, viewerActorId: VIEWER });
    const people = sections.find((s) => s.kind === "people");
    expect(people?.rows).toHaveLength(1);
    const entity = people?.rows[0];
    expect(entity?.kind).toBe("entity-human");
    expect(entity?.label).toBe("Jordan");
    expect(entity?.handle).toEqual({
      local: "jordan",
      server: "remote.example.com",
    });
    expect(entity?.roomId).toBe("dm-ab");
    expect(entity?.children?.some((c) => c.kind === "direct-room")).toBe(true);
  });

  test("owned agent lands in My agents; non-owned in Other agents", () => {
    const rooms = [
      mkRoom({
        id: "dm-genie",
        label: "Owner · Genie",
        kind: "private",
        memberCount: 2,
      }),
      mkRoom({
        id: "dm-nova",
        label: "Owner · Nova",
        kind: "private",
        memberCount: 2,
      }),
    ];
    const rosters = roster({
      "dm-genie": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        {
          actorId: AGENT_G,
          kind: "agent",
          displayName: "Genie",
          agentId: AGENT_G_ID,
          agentAvatar: { kind: "uploaded", blobId: "genie-avatar-v1" },
        },
      ],
      "dm-nova": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        {
          actorId: "actor-nova",
          kind: "agent",
          displayName: "Nova",
          agentId: "agent-nova-id",
        },
      ],
    });
    const ownedAgentIds = new Set([AGENT_G_ID]);
    const sections = groupRoomsForExplorer({
      rooms,
      rosters,
      viewerActorId: VIEWER,
      ownedAgentIds,
    });
    const myAgents = sections.find((s) => s.kind === "my-agents");
    const otherAgents = sections.find((s) => s.kind === "other-agents");
    expect(myAgents?.rows.some((r) => r.label === "Genie")).toBe(true);
    expect(myAgents?.rows.find((r) => r.label === "Genie")?.agentAvatar).toEqual({
      kind: "uploaded",
      blobId: "genie-avatar-v1",
    });
    expect(otherAgents?.rows.some((r) => r.label === "Nova")).toBe(true);
    expect(sections.some((s) => s.kind === "agents")).toBe(false);
  });

  test("guest viewer with absent ownedAgents — all agents in Other agents", () => {
    const rooms = [
      mkRoom({ id: "dm-genie", label: "Owner · Genie", kind: "private", memberCount: 2 }),
    ];
    const rosters = roster({
      "dm-genie": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        {
          actorId: AGENT_G,
          kind: "agent",
          displayName: "Genie",
          agentId: AGENT_G_ID,
        },
      ],
    });
    const sections = groupRoomsForExplorer({
      rooms,
      rosters,
      viewerActorId: VIEWER,
      ownedAgentIds: new Set(),
    });
    expect(sections.find((s) => s.kind === "my-agents")).toBeUndefined();
    expect(sections.find((s) => s.kind === "other-agents")?.rows).toHaveLength(1);
  });

  test("multi-human room (no agents) is Groups", () => {
    const rooms = [
      mkRoom({
        id: "grp",
        label: "Household",
        kind: "group",
        memberCount: 3,
      }),
    ];
    const rosters = roster({
      grp: [
        { actorId: VIEWER, kind: "user", displayName: "Me" },
        { actorId: HUMAN_A, kind: "user", displayName: "A" },
        { actorId: HUMAN_B, kind: "user", displayName: "B" },
      ],
    });
    const sections = groupRoomsForExplorer({ rooms, rosters, viewerActorId: VIEWER });
    const groups = sections.find((s) => s.kind === "groups");
    expect(groups?.rows).toHaveLength(1);
    expect(groups?.rows[0]?.label).toContain("Household");
  });

  test("pure agent-to-agent room", () => {
    const rooms = [
      mkRoom({
        id: "a2a",
        label: "Bots",
        kind: "multi_agent",
        memberCount: 2,
      }),
    ];
    const rosters = roster({
      a2a: [
        { actorId: "ag1", kind: "agent", displayName: "Alpha" },
        { actorId: "ag2", kind: "agent", displayName: "Beta" },
      ],
    });
    const sections = groupRoomsForExplorer({ rooms, rosters, viewerActorId: VIEWER });
    const a2a = sections.find((s) => s.kind === "agent-to-agent");
    expect(a2a?.rows).toHaveLength(1);
    expect(a2a?.defaultCollapsed).toBe(true);
  });

  test("recent subthreads include ALL rows — no cap", () => {
    const subs: WorkbenchRoomSummary[] = [];
    for (let i = 0; i < 7; i++) {
      subs.push(
        mkRoom({
          id: `st-${i}`,
          label: `Thread ${i}`,
          kind: "subthread",
          parentRoomId: "dm-genie",
          memberCount: 2,
          lastMessageAt: `2026-05-${String(20 - i).padStart(2, "0")}T10:00:00.000Z`,
        }),
      );
    }
    const rooms = [
      mkRoom({
        id: "dm-genie",
        label: "Owner · Genie",
        kind: "private",
        memberCount: 2,
      }),
      ...subs,
    ];
    const rosters = roster({
      "dm-genie": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
      ],
    });
    const sections = groupRoomsForExplorer({ rooms, rosters, viewerActorId: VIEWER });
    const recent = sections.find((s) => s.kind === "recent");
    expect(recent?.rows.length).toBe(7);
    expect(recent?.defaultCollapsed).toBe(true);
  });

  test("agent threads subthreadCount is true total — no cap", () => {
    const subs: WorkbenchRoomSummary[] = [];
    for (let i = 0; i < 8; i++) {
      subs.push(
        mkRoom({
          id: `agent-st-${i}`,
          label: `Agent thread ${i}`,
          kind: "subthread",
          parentRoomId: "dm-genie",
          memberCount: 2,
          lastMessageAt: `2026-06-${String(10 - i).padStart(2, "0")}T10:00:00.000Z`,
        }),
      );
    }
    const rooms = [
      mkRoom({ id: "dm-genie", label: "Owner · Genie", kind: "private", memberCount: 2 }),
      ...subs,
    ];
    const rosters = roster({
      "dm-genie": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
      ],
    });
    const sections = groupRoomsForExplorer({
      rooms,
      rosters,
      viewerActorId: VIEWER,
      ownedAgentIds: new Set([AGENT_G_ID]),
    });
    const entity = sections.find((s) => s.kind === "my-agents")?.rows[0];
    // Threads now nest under the private room they belong to, not directly
    // under the agent entity.
    const privateRoom = entity?.children?.find((c) => c.kind === "private-room");
    const threadsContainer = privateRoom?.children?.find((c) => c.kind === "threads");
    expect(threadsContainer?.subthreadCount).toBe(8);
    expect(threadsContainer?.children).toHaveLength(8);
  });

  test("keeps 1:1 chats under people and agents while showing a group room only in Groups", () => {
    const rooms = [
      mkRoom({
        id: "dm-human",
        label: "Owner · User A",
        kind: "private",
        memberCount: 2,
        lastMessageAt: "2026-05-06T10:00:00.000Z",
      }),
      mkRoom({
        id: "p1",
        label: "New chat 2026-06-05",
        kind: "private",
        memberCount: 2,
        lastMessageAt: "2026-05-05T10:00:00.000Z",
      }),
      mkRoom({
        id: "p2",
        label: "Authorize me please",
        kind: "private",
        memberCount: 2,
        lastMessageAt: "2026-05-04T10:00:00.000Z",
      }),
      mkRoom({
        id: "g1",
        label: "User A, User B, Genie",
        kind: "group",
        memberCount: 3,
        lastMessageAt: "2026-05-03T10:00:00.000Z",
      }),
    ];
    const rosters = roster({
      "dm-human": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: HUMAN_A, kind: "user", displayName: "User A" },
      ],
      p1: [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
      ],
      p2: [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
      ],
      g1: [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
        { actorId: HUMAN_A, kind: "user", displayName: "User A" },
      ],
    });
    const sections = groupRoomsForExplorer({
      rooms,
      rosters,
      viewerActorId: VIEWER,
      ownedAgentIds: new Set([AGENT_G_ID]),
    });
    const person = sections.find((s) => s.kind === "people")?.rows[0];
    const agent = sections.find((s) => s.kind === "my-agents")?.rows[0];

    expect(person?.children?.map((child) => [child.kind, child.roomId])).toEqual([
      ["direct-room", "dm-human"],
    ]);

    const privateRooms = agent?.children?.filter((c) => c.kind === "private-room") ?? [];
    expect(privateRooms).toHaveLength(2);
    expect(privateRooms.map((r) => r.roomId).sort()).toEqual(["p1", "p2"]);
    expect(agent?.children?.every((child) => child.kind === "private-room")).toBe(true);

    const groupRows = sections.find((section) => section.kind === "groups")?.rows ?? [];
    expect(groupRows.map((row) => row.roomId)).toEqual(["g1"]);
  });

  test("stranger drive-by: subthread appears in Recent without full parent roster", () => {
    const rooms = [
      mkRoom({
        id: "st-x",
        label: "Drive-by thread",
        kind: "subthread",
        parentRoomId: "unknown-parent",
        memberCount: 1,
        lastMessageAt: "2026-05-10T12:00:00.000Z",
      }),
    ];
    const sections = groupRoomsForExplorer({ rooms, rosters: new Map(), viewerActorId: VIEWER });
    const recent = sections.find((s) => s.kind === "recent");
    expect(recent?.rows).toHaveLength(1);
    expect(recent?.rows[0]?.roomId).toBe("st-x");
  });

  test("group unread stays on the group row and out of an agent rollup", () => {
    const rooms = [
      mkRoom({
        id: "dm-genie",
        label: "Owner · Genie",
        kind: "private",
        memberCount: 2,
        unreadCount: 2,
      }),
      mkRoom({
        id: "grp-shared",
        label: "Household",
        kind: "group",
        memberCount: 3,
        unreadCount: 3,
      }),
      mkRoom({
        id: "st-1",
        label: "Thread one",
        kind: "subthread",
        parentRoomId: "dm-genie",
        memberCount: 2,
        unreadCount: 1,
      }),
    ];
    const rosters = roster({
      "dm-genie": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
      ],
      "grp-shared": [
        { actorId: VIEWER, kind: "user", displayName: "Owner" },
        { actorId: AGENT_G, kind: "agent", displayName: "Genie", agentId: AGENT_G_ID },
        { actorId: HUMAN_A, kind: "user", displayName: "A" },
      ],
    });
    const sections = groupRoomsForExplorer({
      rooms,
      rosters,
      viewerActorId: VIEWER,
      ownedAgentIds: new Set([AGENT_G_ID]),
      attentionByRoomId: new Map([
        ["dm-genie", { unreadCount: 2, importantUnreadCount: 1 }],
        ["grp-shared", { unreadCount: 3, importantUnreadCount: 2 }],
        ["st-1", { unreadCount: 1, importantUnreadCount: 1 }],
      ]),
    });
    const entity = sections.find((s) => s.kind === "my-agents")?.rows[0];
    const group = sections.find((s) => s.kind === "groups")?.rows[0];
    expect(entity?.unreadCount).toBe(2);
    expect(entity?.importantUnreadCount).toBe(1);
    expect(group?.unreadCount).toBe(3);
    expect(group?.importantUnreadCount).toBe(2);
  });

  test("projects authoritative Room and eligible Subthread attention", () => {
    const rooms = [
      mkRoom({
        id: "dm-genie",
        label: "Owner · Genie",
        kind: "private",
        memberCount: 2,
        unreadCount: 90,
      }),
      mkRoom({
        id: "st-1",
        label: "Thread one",
        kind: "subthread",
        parentRoomId: "dm-genie",
        memberCount: 2,
        unreadCount: 80,
      }),
    ];
    const sections = groupRoomsForExplorer({
      rooms,
      rosters: roster({
        "dm-genie": [
          { actorId: VIEWER, kind: "user", displayName: "Owner" },
          {
            actorId: AGENT_G,
            kind: "agent",
            displayName: "Genie",
            agentId: AGENT_G_ID,
          },
        ],
      }),
      viewerActorId: VIEWER,
      ownedAgentIds: new Set([AGENT_G_ID]),
      attentionByRoomId: new Map([
        [
          "dm-genie",
          { unreadCount: 4, importantUnreadCount: 2 },
        ],
        ["st-1", { unreadCount: 2, importantUnreadCount: 1 }],
      ]),
    });
    const entity = sections.find((s) => s.kind === "my-agents")?.rows[0];
    const room = entity?.children?.find((row) => row.roomId === "dm-genie");
    const thread = room?.children?.[0]?.children?.[0];
    expect(room?.unreadCount).toBe(4);
    expect(room?.importantUnreadCount).toBe(2);
    expect(thread?.unreadCount).toBe(2);
    expect(thread?.importantUnreadCount).toBe(1);
    expect(entity?.unreadCount).toBe(4);
    expect(entity?.importantUnreadCount).toBe(2);
  });

  test("filterSectionsByQuery matches handle local part in nested rows", () => {
    const sections = groupRoomsForExplorer({
      rooms: [mkRoom({ id: "dm", label: "x", kind: "private", memberCount: 2 })],
      rosters: roster({
        dm: [
          { actorId: VIEWER, kind: "user", displayName: "Me" },
          {
            actorId: HUMAN_A,
            kind: "user",
            displayName: "Casey",
            handle: { local: "casey", server: null },
          },
        ],
      }),
      viewerActorId: VIEWER,
    });
    const filtered = filterSectionsByQuery(sections, "case");
    expect(filtered.find((s) => s.kind === "people")?.rows).toHaveLength(1);
  });
});

describe("compareExplorerRows / sortExplorerRows", () => {
  const mkSortRow = (partial: Partial<ExplorerRow> & Pick<ExplorerRow, "id" | "label">): ExplorerRow => ({
    id: partial.id,
    kind: "room",
    depth: 0,
    label: partial.label,
    roomId: partial.roomId ?? partial.id,
    preview: null,
    isSubthread: false,
    ...partial,
  });

  test("unread visual gated off (D286): sort is pure, no unread-first floating", () => {
    const rows = sortExplorerRows(
      [
        mkSortRow({ id: "a", label: "Alpha", unreadCount: 0, lastActivityAt: 100 }),
        mkSortRow({ id: "b", label: "Zulu", unreadCount: 5, lastActivityAt: 1 }),
        mkSortRow({ id: "c", label: "Bravo", unreadCount: 0, lastActivityAt: 200 }),
      ],
      { mode: "alpha", dir: "asc" },
    );
    // Pure A–Z asc — the unread "Zulu" does NOT jump to the top while gated off.
    expect(rows.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  test("compareExplorerRows unread-first logic (opt-in) floats unread above read", () => {
    const read = mkSortRow({ id: "a", label: "Alpha", unreadCount: 0, lastActivityAt: 100 });
    const unread = mkSortRow({ id: "b", label: "Zulu", unreadCount: 5, lastActivityAt: 1 });
    expect(
      compareExplorerRows(read, unread, { mode: "alpha", dir: "asc" }, { unreadFirst: true }),
    ).toBeGreaterThan(0);
    expect(
      compareExplorerRows(unread, read, { mode: "alpha", dir: "asc" }, { unreadFirst: true }),
    ).toBeLessThan(0);
  });

  test("within unread bucket, recent desc orders by lastActivityAt", () => {
    const unreadA = mkSortRow({ id: "u1", label: "U1", unreadCount: 1, lastActivityAt: 50 });
    const unreadB = mkSortRow({ id: "u2", label: "U2", unreadCount: 2, lastActivityAt: 500 });
    expect(
      compareExplorerRows(unreadA, unreadB, { mode: "recent", dir: "desc" }),
    ).toBeGreaterThan(0);
  });
});

/**
 * D246 Wave 2 (task 2.2 / 2.5) — projection proof that embedded summary
 * rosters classify synchronously without per-room detail fetches. Runtime
 * fallback behavior for old servers lives in `use-explorer-data.test.tsx`.
 */
describe("useExplorerData — embedded summary rosters (D246 Wave 2)", () => {
  function mkRoom(id: string, roster: Array<Record<string, unknown>>): WorkbenchRoomSummary {
    return {
      id,
      label: `Room ${id}`,
      type: "private",
      graphThreadId: `room:${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      memberCount: roster.length,
      kind: "private",
      parentRoomId: null,
      threadRootMessageId: null,
      unreadCount: 0,
      pinned: false,
      tabOpen: false,
      closedTab: false,
      lastOpenedAt: null,
      tabOrder: null,
      roster: roster as unknown as WorkbenchRoomSummary["roster"],
    };
  }

  test("50 visible rooms map synchronously from one list payload with no detail-fetch path", async () => {
    // Same owned agent across every room so the 50 rooms collapse into ONE
    // My-agents entity — proving rosters are consumed from the list payload,
    // not per-room detail.
    const rooms = Array.from({ length: 50 }, (_, i) => {
      const id = `r-${i}`;
      return mkRoom(id, [
        { actorId: "actor-viewer", kind: "user", displayName: "Me", userId: "u-me" },
        {
          actorId: "actor-genie",
          kind: "agent",
          displayName: "Genie",
          agentId: "agent-genie-id",
          handle: "genie",
        },
      ]);
    });

    const rosters = await buildExplorerRostersInIsolate(rooms);
    const sections = groupRoomsForExplorer({
      rooms,
      rosters,
      viewerActorId: VIEWER,
      ownedAgentIds: new Set(["agent-genie-id"]),
    });

    // Rosters from the list payload are consumed: 50 rooms with the same
    // owned agent collapse into one My-agents entity.
    const myAgents = sections.find((s) => s.kind === "my-agents");
    expect(myAgents).toBeTruthy();
    expect(myAgents?.rows).toHaveLength(1);
    expect(myAgents?.rows[0]?.label).toBe("Genie");

    // Embedded rosters are consumed synchronously from the list payload — no
    // detail fetch is required to collapse these rows.
  });

  test("summary roster preserves a federated user's server for display and search", async () => {
    const rooms = [
      mkRoom("federated-dm", [
        { actorId: "actor-viewer", kind: "user", displayName: "Me", userId: "u-me" },
        {
          actorId: "actor-casey",
          kind: "user",
          displayName: "Casey",
          userId: "u-casey",
          handle: "casey",
          federatedId: "@casey@remote.example.com",
        },
      ]),
    ];
    const sections = groupRoomsForExplorer({
      rooms,
      rosters: await buildExplorerRostersInIsolate(rooms),
      viewerActorId: VIEWER,
    });
    const person = sections.find((s) => s.kind === "people")?.rows[0];

    expect(person?.handle).toEqual({
      local: "casey",
      server: "remote.example.com",
    });
    const filtered = filterSectionsByQuery(sections, "remote.example.com");
    expect(filtered.find((s) => s.kind === "people")?.rows).toHaveLength(1);
  });
});
