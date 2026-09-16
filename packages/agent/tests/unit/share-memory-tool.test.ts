import { describe, test, expect, spyOn, afterEach, mock } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import * as memoryStore from "../../src/store/memory-store";
import * as shareMemory from "../../src/tools/memory/share-memory";
import { createShareMemoryTool } from "../../src/tools/memory/share-memory";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const REQ_ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const TGT_ACTOR_ID = "40000000-0000-4000-8000-000000000004";
const TGT_USER_ID = "50000000-0000-4000-8000-000000000005";
const MEM_ID = "60000000-0000-4000-8000-000000000099";

function envelope(): MemoryAccessEnvelope {
  return {
    ownerId: OWNER_ID,
    actorId: REQ_ACTOR_ID,
    agentId: AGENT_ID,
    roomId: "",
    readableNamespaces: ["ns-read"],
    mutableNamespaces: ["ns-read"],
    writableNamespaces: [],
    toolPolicy: {},
  };
}

describe("share_memory tool (M078 roster + guards)", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  function mockRequesterActor() {
    const sp = spyOn(trust, "findActorByOwnerId").mockImplementation(async (uid: string) => {
      if (uid === OWNER_ID) {
        return {
          id: REQ_ACTOR_ID,
          kind: "user" as const,
          ownerId: OWNER_ID,
          displayName: "Owner",
          trustState: "verified",
        } as unknown as Awaited<ReturnType<typeof trust.findActorByOwnerId>>;
      }
      return null;
    });
    restores.push(() => sp.mockRestore());
  }

  function mockRosterAndTarget() {
    const spRoster = spyOn(trust, "findAgentUserByNormalizedHandle").mockResolvedValue({
      userId: TGT_USER_ID,
      handle: "alice",
      displayName: "Alice",
      role: "member",
    });
    restores.push(() => spRoster.mockRestore());

    const spHit = spyOn(trust, "findActorByHandle").mockResolvedValue({
      kind: "user",
      actorId: TGT_ACTOR_ID,
      displayName: "Alice",
    } as Awaited<ReturnType<typeof trust.findActorByHandle>>);
    restores.push(() => spHit.mockRestore());

    const spActorRow = spyOn(trust, "findActorById").mockResolvedValue({
      id: TGT_ACTOR_ID,
      kind: "user",
      ownerId: TGT_USER_ID,
    } as Awaited<ReturnType<typeof trust.findActorById>>);
    restores.push(() => spActorRow.mockRestore());
  }

  test("rejects unknown handle (no local user) and does not load memory or create room", async () => {
    mockRequesterActor();
    // M173 (hive-mind): resolution is existence-based — an unknown handle has
    // no local user-actor.
    const spHit = spyOn(trust, "findActorByHandle").mockResolvedValue(null);
    restores.push(() => spHit.mockRestore());

    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable");
    restores.push(() => spLoad.mockRestore());

    const spCreate = spyOn(trust, "createSharedRoomForPair").mockResolvedValue({
      roomId: "r",
      namespaceId: "n",
    });
    restores.push(() => spCreate.mockRestore());

    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target_handle: "stranger",
      sensitivity: "normal",
    });
    expect(out).toContain("No local user @stranger");
    expect(spLoad).not.toHaveBeenCalled();
    expect(spCreate).not.toHaveBeenCalled();
  });

  test("rejects when memory not shareable (wrong owner/agent)", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue(null);
    restores.push(() => spLoad.mockRestore());

    const spRoom = spyOn(trust, "findShareTargetRoom");
    restores.push(() => spRoom.mockRestore());

    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toContain("not yours to share");
    expect(spRoom).not.toHaveBeenCalled();
  });

  test("happy path: existing room → attach", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "hello",
      type: "general",
    });
    restores.push(() => spLoad.mockRestore());

    const spRoom = spyOn(trust, "findShareTargetRoom").mockResolvedValue({
      roomId: "room-1",
      namespaceId: "ns-1",
      label: "Pair room",
      humanActorCount: 3,
    });
    restores.push(() => spRoom.mockRestore());

    const spCreate = spyOn(trust, "createSharedRoomForPair");
    restores.push(() => spCreate.mockRestore());

    const spNs = spyOn(memoryStore, "getMemoryNamespaces").mockResolvedValue([]);
    restores.push(() => spNs.mockRestore());

    const spAttach = spyOn(memoryStore, "attachMemoryToNamespace").mockResolvedValue(undefined);
    restores.push(() => spAttach.mockRestore());

    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toContain("Shared memory");
    expect(out).toContain("Pair room");
    expect(spAttach).toHaveBeenCalledWith(MEM_ID, "ns-1", {
      userId: OWNER_ID,
      agentId: AGENT_ID,
    });
    expect(spCreate).not.toHaveBeenCalled();
  });

  test("idempotent when namespace already attached", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "hello",
      type: "general",
    });
    restores.push(() => spLoad.mockRestore());

    const spRoom = spyOn(trust, "findShareTargetRoom").mockResolvedValue({
      roomId: "room-1",
      namespaceId: "ns-1",
      label: "Pair room",
      humanActorCount: 3,
    });
    restores.push(() => spRoom.mockRestore());

    const spNs = spyOn(memoryStore, "getMemoryNamespaces").mockResolvedValue(["ns-1"]);
    restores.push(() => spNs.mockRestore());

    const spAttach = spyOn(memoryStore, "attachMemoryToNamespace");
    restores.push(() => spAttach.mockRestore());

    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toContain("already attached");
    expect(spAttach).not.toHaveBeenCalled();
  });

  test("creates room when none exists", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "hello",
      type: "general",
    });
    restores.push(() => spLoad.mockRestore());

    const spFindRoom = spyOn(trust, "findShareTargetRoom").mockResolvedValue(null);
    restores.push(() => spFindRoom.mockRestore());

    const spUser = spyOn(trust, "findUserDisplayInfo").mockImplementation(async (uid: string) =>
      uid === OWNER_ID
        ? ({ id: OWNER_ID, name: "Owner O" } as Awaited<ReturnType<typeof trust.findUserDisplayInfo>>)
        : ({ id: TGT_USER_ID, name: "Alice A" } as Awaited<ReturnType<typeof trust.findUserDisplayInfo>>),
    );
    restores.push(() => spUser.mockRestore());

    const spCreateRoom = spyOn(trust, "createSharedRoomForPair").mockResolvedValue({
      roomId: "new-room",
      namespaceId: "ns-new",
    });
    restores.push(() => spCreateRoom.mockRestore());

    const spNs = spyOn(memoryStore, "getMemoryNamespaces").mockResolvedValue([]);
    restores.push(() => spNs.mockRestore());

    const spAttach = spyOn(memoryStore, "attachMemoryToNamespace").mockResolvedValue(undefined);
    restores.push(() => spAttach.mockRestore());

    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toContain("newly created");
    expect(spCreateRoom).toHaveBeenCalled();
  });

  test("required ordinary sharing consumes only the bound no-argument execution", async () => {
    const commit = mock(async () => ({
      status: "success" as const,
      receipts: [],
      artifacts: [],
      message: "Shared the Memory with Project room.",
    }));
    const actorLookup = spyOn(trust, "findActorByOwnerId");
    restores.push(() => actorLookup.mockRestore());
    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
      ordinaryContentAccessRequired: true,
      ordinaryContentAccess: { commit },
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target: { kind: "room", name: "Project room" },
      sensitivity: "normal",
    });
    expect(out).toBe("Shared the Memory with Project room.");
    expect(commit).toHaveBeenCalledWith();
    expect(actorLookup).not.toHaveBeenCalled();
  });

  test("exposes Room targets only for required ordinary access and leaves projection unchanged", () => {
    const legacy = createShareMemoryTool();
    const ordinary = createShareMemoryTool({ ordinaryContentAccessRequired: true });
    const roomAttach = {
      memory_id: MEM_ID,
      target: { kind: "room", name: "Project room" },
      sensitivity: "normal",
    };
    const projection = {
      mode: "project",
      source_memory_ids: [MEM_ID],
      proposed_content: "Public-safe summary",
      target_room_name: "Project room",
    };

    expect(legacy.schema.safeParse(roomAttach).success).toBe(false);
    expect(legacy.description).toContain("never guess a target_handle");
    expect(legacy.description).not.toContain("explicit Room name");
    expect(ordinary.schema.safeParse(roomAttach).success).toBe(true);
    expect(ordinary.description).toContain("explicit Room name");
    expect(legacy.schema.safeParse(projection).success).toBe(true);
    expect(ordinary.schema.safeParse(projection).success).toBe(true);
  });

  test("required ordinary sharing fails closed when its bound execution is absent", async () => {
    const actorLookup = spyOn(trust, "findActorByOwnerId");
    restores.push(() => actorLookup.mockRestore());
    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
      ordinaryContentAccessRequired: true,
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target: { kind: "room", name: "Project room" },
      sensitivity: "normal",
    });
    expect(out).toContain("approved ordinary content-access execution is unavailable");
    expect(actorLookup).not.toHaveBeenCalled();
  });

  test("ordinary sharing preserves same-call recovery without retrying in the leaf", async () => {
    const commit = mock(async () => ({
      status: "error" as const,
      receipts: [],
      artifacts: [],
      recovery: "retry_same_call" as const,
      message: "Receipt recovery is required.",
    }));
    const tool = createShareMemoryTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
      ordinaryContentAccessRequired: true,
      ordinaryContentAccess: { commit },
    });
    const out = await tool.invoke({
      memory_id: MEM_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(JSON.parse(String(out))).toEqual({
      status: "error",
      message: "Receipt recovery is required.",
      recovery: "retry_same_call",
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
