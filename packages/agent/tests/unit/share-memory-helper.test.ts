/**
 * M173 — direct unit coverage for the extracted `shareMemoryToUser` helper
 * (the `share_memory` tool wrapper is covered by share-memory-tool.test.ts).
 * Exercises the roster/self/already guards and the `mintKind: "access"` path.
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import * as trust from "@nautilo/trust";
import * as memoryStore from "../../src/store/memory-store";
import * as shareMemory from "../../src/tools/memory/share-memory";
import { shareMemoryToUser } from "../../src/tools/memory/share-memory";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const REQ_ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const TGT_ACTOR_ID = "40000000-0000-4000-8000-000000000004";
const TGT_USER_ID = "50000000-0000-4000-8000-000000000005";
const MEM_ID = "60000000-0000-4000-8000-000000000099";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function mockRequesterActor() {
  const sp = spyOn(trust, "findActorByOwnerId").mockResolvedValue({
    id: REQ_ACTOR_ID,
    displayName: "Owner",
    trustState: "verified",
  } as Awaited<ReturnType<typeof trust.findActorByOwnerId>>);
  restores.push(() => sp.mockRestore());
}

function mockRosterAndTarget() {
  const spRoster = spyOn(trust, "findAgentUserByNormalizedHandle").mockResolvedValue({
    userId: TGT_USER_ID,
    handle: "alice",
    displayName: "Alice",
    role: "member",
  } as Awaited<ReturnType<typeof trust.findAgentUserByNormalizedHandle>>);
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

  const spUser = spyOn(trust, "findUserDisplayInfo").mockImplementation(
    async (uid: string) =>
      (uid === OWNER_ID
        ? { id: OWNER_ID, name: "Owner O" }
        : { id: TGT_USER_ID, name: "Alice A" }) as Awaited<
        ReturnType<typeof trust.findUserDisplayInfo>
      >,
  );
  restores.push(() => spUser.mockRestore());
}

describe("shareMemoryToUser (M173)", () => {
  test("absent ordinary content stops before namespace mutation", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: null,
      type: "general",
    });
    restores.push(() => spLoad.mockRestore());
    const spAttach = spyOn(memoryStore, "attachMemoryToNamespace");
    restores.push(() => spAttach.mockRestore());

    const out = await shareMemoryToUser({
      memoryId: MEM_ID,
      requesterUserId: OWNER_ID,
      agentId: AGENT_ID,
      targetHandle: "alice",
      readableNamespaces: ["ns-read"],
      mintKind: "access",
    });
    expect(out).toEqual({
      ok: false,
      reason: "Memory ordinary content is unavailable.",
    });
    expect(spAttach).not.toHaveBeenCalled();
  });

  test("unknown handle (no local user) → ok:false, never loads memory", async () => {
    mockRequesterActor();
    // Existence-based resolution: unknown handle → no local user-actor.
    const spHit = spyOn(trust, "findActorByHandle").mockResolvedValue(null);
    restores.push(() => spHit.mockRestore());
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable");
    restores.push(() => spLoad.mockRestore());

    const out = await shareMemoryToUser({
      memoryId: MEM_ID,
      requesterUserId: OWNER_ID,
      agentId: AGENT_ID,
      targetHandle: "stranger",
      readableNamespaces: ["ns-read"],
      mintKind: "access",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("No local user @stranger");
    expect(spLoad).not.toHaveBeenCalled();
  });

  test("self-share → ok:false", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    // Make the target resolve to the requester's own user id.
    const spActorRow = spyOn(trust, "findActorById").mockResolvedValue({
      id: TGT_ACTOR_ID,
      kind: "user",
      ownerId: OWNER_ID,
    } as Awaited<ReturnType<typeof trust.findActorById>>);
    restores.push(() => spActorRow.mockRestore());
    const spRoster = spyOn(trust, "findAgentUserByNormalizedHandle").mockResolvedValue({
      userId: OWNER_ID,
      handle: "alice",
      displayName: "Alice",
      role: "member",
    } as Awaited<ReturnType<typeof trust.findAgentUserByNormalizedHandle>>);
    restores.push(() => spRoster.mockRestore());

    const out = await shareMemoryToUser({
      memoryId: MEM_ID,
      requesterUserId: OWNER_ID,
      agentId: AGENT_ID,
      targetHandle: "alice",
      readableNamespaces: ["ns-read"],
      mintKind: "access",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("yourself");
  });

  test("access mintKind: reuses existing exact-set room → minted:false", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "hello",
      type: "general",
    });
    restores.push(() => spLoad.mockRestore());

    const spAccess = spyOn(trust, "findOrCreateAccessNamespace").mockResolvedValue({
      namespaceId: "ns-access",
      roomId: "room-access",
      minted: false,
    });
    restores.push(() => spAccess.mockRestore());

    const spNs = spyOn(memoryStore, "getMemoryNamespaces").mockResolvedValue([]);
    restores.push(() => spNs.mockRestore());
    const spAttach = spyOn(memoryStore, "attachMemoryToNamespace").mockResolvedValue(
      undefined,
    );
    restores.push(() => spAttach.mockRestore());

    const out = await shareMemoryToUser({
      memoryId: MEM_ID,
      requesterUserId: OWNER_ID,
      agentId: AGENT_ID,
      targetHandle: "alice",
      readableNamespaces: ["ns-read"],
      mintKind: "access",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.minted).toBe(false);
      expect(out.already).toBe(false);
      expect(out.namespaceId).toBe("ns-access");
    }
    // Exact-set helper used, NOT the conversational superset finder.
    expect(spAccess).toHaveBeenCalledWith(
      [REQ_ACTOR_ID, TGT_ACTOR_ID],
      expect.objectContaining({ requesterUserId: OWNER_ID, requesterActorId: REQ_ACTOR_ID }),
    );
    expect(spAttach).toHaveBeenCalledWith(MEM_ID, "ns-access", {
      userId: OWNER_ID,
      agentId: AGENT_ID,
    });
  });

  test("access mintKind: already attached → already:true, no attach", async () => {
    mockRequesterActor();
    mockRosterAndTarget();
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "hello",
      type: "general",
    });
    restores.push(() => spLoad.mockRestore());
    const spAccess = spyOn(trust, "findOrCreateAccessNamespace").mockResolvedValue({
      namespaceId: "ns-access",
      roomId: "room-access",
      minted: true,
    });
    restores.push(() => spAccess.mockRestore());
    const spNs = spyOn(memoryStore, "getMemoryNamespaces").mockResolvedValue([
      "ns-access",
    ]);
    restores.push(() => spNs.mockRestore());
    const spAttach = spyOn(memoryStore, "attachMemoryToNamespace");
    restores.push(() => spAttach.mockRestore());

    const out = await shareMemoryToUser({
      memoryId: MEM_ID,
      requesterUserId: OWNER_ID,
      agentId: AGENT_ID,
      targetHandle: "alice",
      readableNamespaces: ["ns-read"],
      mintKind: "access",
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.already).toBe(true);
    expect(spAttach).not.toHaveBeenCalled();
  });
});
