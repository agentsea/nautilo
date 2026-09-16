import { describe, test, expect, spyOn, afterEach } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import * as shareMemory from "../../src/tools/memory/share-memory";
import * as shareApprovalPreview from "../../src/post-model/share-approval-preview";
import { computeShareMemoryApprovalPreview } from "../../src/tools/memory/share-memory";

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

describe("computeShareMemoryApprovalPreview (M078)", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  const tc = {
    name: "share_memory" as const,
    args: {
      memory_id: MEM_ID,
      target_handle: "alice",
      sensitivity: "normal" as const,
    },
  };

  test("does not leak foreign memory: uses loadMemoryRowIfShareable only", async () => {
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue(null);
    restores.push(() => spLoad.mockRestore());

    const spTarget = spyOn(shareApprovalPreview, "resolveLocalShareTargetByHandle").mockResolvedValue(null);
    restores.push(() => spTarget.mockRestore());

    const preview = await computeShareMemoryApprovalPreview(tc, {
      memoryAccessEnvelope: envelope(),
      userId: OWNER_ID,
    });
    expect(preview).not.toBeNull();
    expect(preview!.memoryContentSnippet).toBe("Memory not found or not shareable by you.");
    expect(preview!.memoryType).toBeNull();
    expect(spLoad).toHaveBeenCalledWith(MEM_ID, ["ns-read"], AGENT_ID, OWNER_ID);
  });

  test("includes snippet only when row is shareable", async () => {
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "SECRET_FACT",
      type: "note",
    });
    restores.push(() => spLoad.mockRestore());

    const spTarget = spyOn(shareApprovalPreview, "resolveLocalShareTargetByHandle").mockResolvedValue(null);
    restores.push(() => spTarget.mockRestore());

    const preview = await computeShareMemoryApprovalPreview(tc, {
      memoryAccessEnvelope: envelope(),
      userId: OWNER_ID,
    });
    expect(preview!.memoryContentSnippet).toContain("SECRET_FACT");
    expect(preview!.memoryType).toBe("note");
    expect(preview!.roomLabel).toBeNull();
  });

  test("opens the protected source for approval without reading ordinary content", async () => {
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable");
    restores.push(() => spLoad.mockRestore());
    const spTarget = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    restores.push(() => spTarget.mockRestore());
    const requests: unknown[] = [];
    const preview = await computeShareMemoryApprovalPreview({ ...tc, id: "tool-1" }, {
      memoryAccessEnvelope: envelope(),
      userId: OWNER_ID,
      protectedMemoryAccessPort: {
        async prepareApproval(request) {
          requests.push(request);
          return { status: "success", value: {
            reference: {
              referenceVersion: 1, referenceId: "ref-1", toolCallId: "tool-1",
              requesterUserId: OWNER_ID, agentId: AGENT_ID,
            },
            preview: { type: "protected-note", content: "protected secret" },
          } };
        },
        async change() {
          throw new Error("not executed during approval");
        },
      },
    });
    expect(preview).toMatchObject({
      memoryType: "protected-note",
      memoryContentSnippet: "protected secret",
    });
    expect(requests).toHaveLength(1);
    expect(spLoad).not.toHaveBeenCalled();
  });

  test("reports an unavailable ordinary representation without inventing a snippet", async () => {
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: null,
      type: "note",
    });
    restores.push(() => spLoad.mockRestore());
    const spTarget = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    restores.push(() => spTarget.mockRestore());

    const preview = await computeShareMemoryApprovalPreview(tc, {
      memoryAccessEnvelope: envelope(),
      userId: OWNER_ID,
    });
    expect(preview!.memoryContentSnippet).toBe(
      "Memory ordinary content is unavailable.",
    );
    expect(preview!.memoryType).toBe("note");
  });

  test("room preview uses roster-backed actors only", async () => {
    const spLoad = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "x",
      type: "general",
    });
    restores.push(() => spLoad.mockRestore());

    const spTarget = spyOn(shareApprovalPreview, "resolveLocalShareTargetByHandle").mockResolvedValue({
      userId: TGT_USER_ID,
      actorId: TGT_ACTOR_ID,
      displayName: "Alice",
    });
    restores.push(() => spTarget.mockRestore());

    const spOwnerActor = spyOn(trust, "findActorByOwnerId").mockImplementation(async (uid: string) => {
      if (uid === OWNER_ID) return { id: REQ_ACTOR_ID } as unknown as Awaited<ReturnType<typeof trust.findActorByOwnerId>>;
      if (uid === TGT_USER_ID) return { id: TGT_ACTOR_ID } as unknown as Awaited<ReturnType<typeof trust.findActorByOwnerId>>;
      return null;
    });
    restores.push(() => spOwnerActor.mockRestore());

    const spShareRoom = spyOn(trust, "findShareTargetRoom").mockResolvedValue({
      roomId: "r",
      namespaceId: "ns",
      label: "Existing",
      humanActorCount: 2,
    });
    restores.push(() => spShareRoom.mockRestore());

    const preview = await computeShareMemoryApprovalPreview(tc, {
      memoryAccessEnvelope: envelope(),
      userId: OWNER_ID,
    });
    expect(preview!.roomLabel).toBe("Existing");
    expect(preview!.wouldCreate).toBe(false);
  });
});
