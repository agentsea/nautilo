import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { ShareArtifactApprovalPreview, ShareMemoryApprovalPreview } from "@nautilo/types";
import * as trust from "@nautilo/trust";
import * as db from "@nautilo/db";
import * as shareMemory from "../../src/tools/memory/share-memory";
import { computeShareMemoryApprovalPreview } from "../../src/tools/memory/share-memory";
import { computeShareArtifactApprovalPreview } from "../../src/tools/file/share-artifact";
import * as trustAgentDb from "../../src/store/trust-agent-db";
import * as shareApprovalPreview from "../../src/post-model/share-approval-preview";

// M033 Phase 6 — `computeShareArtifactApprovalPreview` + `loadMemoryRowIfShareable`
// wrap their RLS-gated DB reads in `withAgentTrustContext`, which would otherwise
// open a real postgres-js connection in this unit test. Mock so the wrap fans out
// to the inner fn with a stub conn (the test mocks the inner queries explicitly).
const MOCK_CONN = {} as never;

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const REQ_ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const TGT_ACTOR_ID = "40000000-0000-4000-8000-000000000004";
const TGT_USER_ID = "50000000-0000-4000-8000-000000000005";
const MEM_ID = "60000000-0000-4000-8000-000000000099";
const ARTIFACT_EXT_ID = "art-external-1";

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

function artifactRow() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    namespaceId: "ns-read",
    scopeId: null,
    agentId: AGENT_ID,
    artifactId: ARTIFACT_EXT_ID,
    path: "notes.md",
    mimeType: "text/markdown",
    size: 10,
    storageUri: "file:///tmp/x",
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

/** Shared approval card slice — must not skew between share_memory and share_artifact (D136-P3). */
function approvalTargetSlice(
  p: ShareMemoryApprovalPreview | ShareArtifactApprovalPreview,
): Pick<
  ShareMemoryApprovalPreview,
  "targetHandle" | "targetDisplayName" | "roomLabel" | "wouldCreate" | "sensitivity"
> {
  return {
    targetHandle: p.targetHandle,
    targetDisplayName: p.targetDisplayName,
    roomLabel: p.roomLabel,
    wouldCreate: p.wouldCreate,
    sensitivity: p.sensitivity,
  };
}

describe("share approval preview parity (D136-P3)", () => {
  const restores: Array<() => void> = [];

  beforeEach(() => {
    const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
      async (_ctx, fn) => fn(MOCK_CONN),
    );
    restores.push(() => spTrust.mockRestore());
  });

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("roster miss: Artifact preview states exact access while Memory keeps Room semantics", async () => {
    const spMem = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "notes.md",
      type: "note",
    });
    restores.push(() => spMem.mockRestore());

    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(artifactRow() as never);
    restores.push(() => spArt.mockRestore());

    // M173 — preview target resolution is now existence-based (hive-mind);
    // mock the resolver so it never reaches the live `findActorByHandle` query.
    const spTarget = spyOn(shareApprovalPreview, "resolveLocalShareTargetByHandle").mockResolvedValue(null);
    restores.push(() => spTarget.mockRestore());

    const ctx = { userId: OWNER_ID, memoryAccessEnvelope: envelope() };

    const mem = await computeShareMemoryApprovalPreview(
      {
        name: "share_memory",
        args: { memory_id: MEM_ID, target_handle: "alice", sensitivity: "normal" },
      },
      ctx,
    );
    const art = await computeShareArtifactApprovalPreview(
      {
        name: "share_artifact",
        args: { artifact_id: ARTIFACT_EXT_ID, target_handle: "alice", sensitivity: "normal" },
      },
      ctx,
    );
    expect(mem).not.toBeNull();
    expect(art).not.toBeNull();
    expect(approvalTargetSlice(mem!)).toMatchObject({
      targetHandle: "alice",
      roomLabel: null,
      wouldCreate: false,
      sensitivity: "normal",
    });
    expect(approvalTargetSlice(art!)).toEqual({
      targetHandle: "alice",
      targetDisplayName: "@alice",
      roomLabel: "Exact access for @alice",
      wouldCreate: false,
      sensitivity: "normal",
    });

    expect(mem).toMatchObject({
      memoryContentSnippet: "notes.md",
      memoryType: "note",
    });
    expect("memoryContentSnippet" in mem!).toBe(true);
    expect("artifactPathSnippet" in art!).toBe(true);
    expect(art).toMatchObject({
      artifactPathSnippet: "notes.md",
      mimeType: "text/markdown",
      size: 10,
    });
  });

  test("roster hit: Artifact exact-access preview ignores broader common Rooms", async () => {
    const spMem = spyOn(shareMemory, "loadMemoryRowIfShareable").mockResolvedValue({
      content: "x",
      type: "general",
    });
    restores.push(() => spMem.mockRestore());

    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(artifactRow() as never);
    restores.push(() => spArt.mockRestore());

    const spTarget = spyOn(shareApprovalPreview, "resolveLocalShareTargetByHandle").mockResolvedValue({
      userId: TGT_USER_ID,
      actorId: TGT_ACTOR_ID,
      displayName: "Alice",
    });
    restores.push(() => spTarget.mockRestore());

    const spOwnerActor = spyOn(trust, "findActorByOwnerId").mockImplementation(async (uid: string) => {
      if (uid === OWNER_ID) return { id: REQ_ACTOR_ID } as never;
      if (uid === TGT_USER_ID) return { id: TGT_ACTOR_ID } as never;
      return null;
    });
    restores.push(() => spOwnerActor.mockRestore());

    const spShareRoom = spyOn(trust, "findShareTargetRoom").mockResolvedValue({
      roomId: "r",
      namespaceId: "ns",
      label: "Existing",
      humanActorCount: 2,
    } as never);
    restores.push(() => spShareRoom.mockRestore());

    const ctx = { userId: OWNER_ID, memoryAccessEnvelope: envelope() };

    const mem = await computeShareMemoryApprovalPreview(
      {
        name: "share_memory",
        args: { memory_id: MEM_ID, target_handle: "alice", sensitivity: "normal" },
      },
      ctx,
    );
    const art = await computeShareArtifactApprovalPreview(
      {
        name: "share_artifact",
        args: { artifact_id: ARTIFACT_EXT_ID, target_handle: "alice", sensitivity: "normal" },
      },
      ctx,
    );
    expect(approvalTargetSlice(mem!)).toMatchObject({ roomLabel: "Existing" });
    expect(approvalTargetSlice(art!)).toEqual({
      targetHandle: "alice",
      targetDisplayName: "Alice",
      roomLabel: "Exact access for Alice",
      wouldCreate: false,
      sensitivity: "normal",
    });
  });
});
