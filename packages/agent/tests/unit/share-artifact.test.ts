import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import * as db from "@nautilo/db";
import {
  computeShareArtifactApprovalPreview,
  createShareArtifactTool,
} from "../../src/tools/file/share-artifact";
import * as trustAgentDb from "../../src/store/trust-agent-db";
import * as shareApprovalPreview from "../../src/post-model/share-approval-preview";

const MOCK_CONN = {} as never;

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const REQ_ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const TGT_ACTOR_ID = "40000000-0000-4000-8000-000000000004";
const TGT_USER_ID = "50000000-0000-4000-8000-000000000005";
const ARTIFACT_EXT_ID = "art-external-1";

function envelope(): MemoryAccessEnvelope {
  return {
    ownerId: OWNER_ID,
    actorId: REQ_ACTOR_ID,
    agentId: AGENT_ID,
    roomId: "room-1",
    readableNamespaces: ["ns-read"],
    mutableNamespaces: ["ns-read"],
    writableNamespaces: ["ns-read"],
    toolPolicy: {},
  };
}

function artifactRow(over?: Record<string, unknown>) {
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
    ...over,
  };
}

function mockRequesterAndRoster(restores: Array<() => void>) {
  const spReq = spyOn(trust, "findActorByOwnerId").mockImplementation(async (uid: string) => {
    if (uid === OWNER_ID) return { id: REQ_ACTOR_ID } as never;
    if (uid === TGT_USER_ID) return { id: TGT_ACTOR_ID } as never;
    return null;
  });
  restores.push(() => spReq.mockRestore());

  const spRoster = spyOn(trust, "findAgentUserByNormalizedHandle").mockResolvedValue({
    userId: TGT_USER_ID,
    handle: "alice",
    displayName: "Alice",
    role: "household",
  } as never);
  restores.push(() => spRoster.mockRestore());

  const spHit = spyOn(trust, "findActorByHandle").mockResolvedValue({
    kind: "user",
    actorId: TGT_ACTOR_ID,
  } as never);
  restores.push(() => spHit.mockRestore());

  const spActorRow = spyOn(trust, "findActorById").mockResolvedValue({
    id: TGT_ACTOR_ID,
    ownerId: TGT_USER_ID,
  } as never);
  restores.push(() => spActorRow.mockRestore());
}

describe("createShareArtifactTool (M088A)", () => {
  const restores: Array<() => void> = [];

  function mockArtifactTrustContext() {
    const spTrust = spyOn(trustAgentDb, "withAgentTrustContext").mockImplementation(
      async (_ctx, fn) => fn(MOCK_CONN),
    );
    restores.push(() => spTrust.mockRestore());
  }

  beforeEach(() => {
    mockArtifactTrustContext();
    const spWrite = spyOn(trust, "assertCanWriteArtifacts").mockResolvedValue();
    restores.push(() => spWrite.mockRestore());
  });

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  test("missing user/agent/readable → guard string", async () => {
    const tool = createShareArtifactTool({
      userId: "",
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toBe("Cannot share artifact: missing user, agent, or readable namespace context.");
  });

  test("unknown handle → no local user on this server", async () => {
    const spReq = spyOn(trust, "findActorByOwnerId").mockResolvedValue({ id: REQ_ACTOR_ID } as never);
    restores.push(() => spReq.mockRestore());

    // M173 (hive-mind): existence-based resolution — unknown handle has no
    // local user-actor.
    const spHit = spyOn(trust, "findActorByHandle").mockResolvedValue(null);
    restores.push(() => spHit.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "stranger",
      sensitivity: "normal",
    });
    expect(out).toContain("No local user @stranger");
  });

  test("handle resolves to agent → no local user (agents are not share targets)", async () => {
    const spReq = spyOn(trust, "findActorByOwnerId").mockResolvedValue({
      id: REQ_ACTOR_ID,
    } as never);
    restores.push(() => spReq.mockRestore());

    const spHit = spyOn(trust, "findActorByHandle").mockResolvedValue({
      kind: "agent",
      actorId: TGT_ACTOR_ID,
      displayName: "OtherAgent",
    } as never);
    restores.push(() => spHit.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "bot",
      sensitivity: "normal",
    });
    expect(out).toContain("No local user @bot");
  });

  test("target is self → cannot share with yourself", async () => {
    const spReq = spyOn(trust, "findActorByOwnerId").mockImplementation(async (uid: string) => {
      if (uid === OWNER_ID) return { id: REQ_ACTOR_ID } as never;
      return null;
    });
    restores.push(() => spReq.mockRestore());

    const spRoster = spyOn(trust, "findAgentUserByNormalizedHandle").mockResolvedValue({
      userId: OWNER_ID,
      handle: "me",
      displayName: "Me",
      role: "owner",
    } as never);
    restores.push(() => spRoster.mockRestore());

    const spHit = spyOn(trust, "findActorByHandle").mockResolvedValue({
      kind: "user",
      actorId: REQ_ACTOR_ID,
    } as never);
    restores.push(() => spHit.mockRestore());

    const spActorRow = spyOn(trust, "findActorById").mockResolvedValue({
      id: REQ_ACTOR_ID,
      ownerId: OWNER_ID,
    } as never);
    restores.push(() => spActorRow.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "me",
      sensitivity: "normal",
    });
    expect(out).toBe("Cannot share an artifact with yourself.");
  });

  test("artifact not found → not yours to share", async () => {
    mockRequesterAndRoster(restores);
    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(null);
    restores.push(() => spArt.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: "missing-art",
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toContain("No artifact found with id missing-art");
  });

  test("write denial occurs before exact access creation or Artifact attachment", async () => {
    mockRequesterAndRoster(restores);
    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(
      artifactRow() as never,
    );
    restores.push(() => spArt.mockRestore());
    const spWrite = spyOn(trust, "assertCanWriteArtifacts").mockRejectedValue(
      new trust.ArtifactWriteDeniedError({
        humanUserId: OWNER_ID,
        artifactId: artifactRow().id,
      }),
    );
    restores.push(() => spWrite.mockRestore());
    const spAccess = spyOn(trust, "findOrCreateAccessNamespace").mockResolvedValue({
      roomId: "access-room",
      namespaceId: "ns-exact",
      minted: true,
    } as never);
    restores.push(() => spAccess.mockRestore());
    const spAttach = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(
      undefined as never,
    );
    restores.push(() => spAttach.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });

    expect(out).toBe("Share artifact failed: write_artifacts_required");
    expect(spAccess).not.toHaveBeenCalled();
    expect(spAttach).not.toHaveBeenCalled();
  });

  test("artifact already grants the target exact access → idempotent short-circuit", async () => {
    mockRequesterAndRoster(restores);
    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(
      artifactRow() as never,
    );
    restores.push(() => spArt.mockRestore());

    const spAccess = spyOn(trust, "findOrCreateAccessNamespace").mockResolvedValue({
      roomId: "access-room",
      namespaceId: "ns-target",
      minted: false,
    } as never);
    restores.push(() => spAccess.mockRestore());

    const spAttached = spyOn(db, "getArtifactNamespaces").mockResolvedValue(["ns-target"]);
    restores.push(() => spAttached.mockRestore());
    const spAttach = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
    restores.push(() => spAttach.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toBe("Artifact already grants @alice exact access.");
    expect(spAttach).not.toHaveBeenCalled();
  });

  test("happy path → exact access namespace attachment once + additive success string", async () => {
    mockRequesterAndRoster(restores);
    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(
      artifactRow() as never,
    );
    restores.push(() => spArt.mockRestore());

    const spAccess = spyOn(trust, "findOrCreateAccessNamespace").mockResolvedValue({
      roomId: "access-room",
      namespaceId: "ns-target",
      minted: false,
    } as never);
    restores.push(() => spAccess.mockRestore());
    const spBroadRoom = spyOn(trust, "findShareTargetRoom").mockResolvedValue({
      roomId: "broader-room",
      namespaceId: "ns-broader",
      label: "Unrelated broader room",
      humanActorCount: 8,
    } as never);
    restores.push(() => spBroadRoom.mockRestore());

    const spAttached = spyOn(db, "getArtifactNamespaces").mockResolvedValue(["ns-other"]);
    restores.push(() => spAttached.mockRestore());
    const spAttach = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
    restores.push(() => spAttach.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toContain("Granted @alice exact access to artifact art-external-1");
    expect(out).toContain("No shared Room was created");
    expect(spBroadRoom).not.toHaveBeenCalled();
    expect(spAttach).toHaveBeenCalledTimes(1);
    expect(spAttach).toHaveBeenCalledWith(
      {
        artifactId: "11111111-1111-4111-8111-111111111111",
        namespaceId: "ns-target",
      },
      MOCK_CONN,
    );
  });

  test("new exact-access namespace stays hidden behind the access primitive", async () => {
    mockRequesterAndRoster(restores);
    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(
      artifactRow() as never,
    );
    restores.push(() => spArt.mockRestore());

    const spAccess = spyOn(trust, "findOrCreateAccessNamespace").mockResolvedValue({
      roomId: "access-room",
      namespaceId: "ns-new",
      minted: true,
    } as never);
    restores.push(() => spAccess.mockRestore());
    const spVisibleRoom = spyOn(trust, "createSharedRoomForPair").mockResolvedValue({
      roomId: "visible-room",
      namespaceId: "visible-ns",
    } as never);
    restores.push(() => spVisibleRoom.mockRestore());

    const spAttached = spyOn(db, "getArtifactNamespaces").mockResolvedValue(["ns-other"]);
    restores.push(() => spAttached.mockRestore());
    const spAttach = spyOn(db, "attachArtifactToNamespace").mockResolvedValue(undefined as never);
    restores.push(() => spAttach.mockRestore());

    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "alice",
      sensitivity: "normal",
    });
    expect(out).toContain("Granted @alice exact access");
    expect(spAccess).toHaveBeenCalledTimes(1);
    expect(spVisibleRoom).not.toHaveBeenCalled();
    expect(spAttach).toHaveBeenCalledTimes(1);
  });

  test("required ordinary sharing consumes only the bound no-argument execution", async () => {
    const commit = mock(async () => ({
      status: "success" as const,
      receipts: [],
      artifacts: [{ artifactId: ARTIFACT_EXT_ID, path: "notes.md",
        mimeType: "text/markdown", size: 10 }],
      message: "Shared the Artifact with Project room.",
    }));
    const actorLookup = spyOn(trust, "findActorByOwnerId");
    restores.push(() => actorLookup.mockRestore());
    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
      ordinaryContentAccessRequired: true,
      ordinaryContentAccess: { commit },
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target: { kind: "room", name: "Project room", choiceToken: "opaque-choice" },
      sensitivity: "normal",
    });
    expect(out).toBe("Shared the Artifact with Project room.");
    expect(commit).toHaveBeenCalledWith();
    expect(actorLookup).not.toHaveBeenCalled();
  });

  test("exposes person-or-Room targets only for required ordinary access", () => {
    const legacy = createShareArtifactTool();
    const explicitlyLegacy = createShareArtifactTool({ ordinaryContentAccessRequired: false });
    const ordinary = createShareArtifactTool({ ordinaryContentAccessRequired: true });
    const roomShare = {
      artifact_id: ARTIFACT_EXT_ID,
      target: { kind: "room", name: "Project room" },
      sensitivity: "normal",
    };
    const legacyShare = {
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "alice",
      sensitivity: "normal",
    };

    expect(legacy.schema.safeParse(roomShare).success).toBe(false);
    expect(explicitlyLegacy.schema.safeParse(roomShare).success).toBe(false);
    expect(legacy.schema.safeParse(legacyShare).success).toBe(true);
    expect(legacy.description).toContain("never guess a target_handle");
    expect(legacy.description).not.toContain("explicit Room name");
    expect(explicitlyLegacy.description).toBe(legacy.description);
    expect(ordinary.schema.safeParse(roomShare).success).toBe(true);
    expect(ordinary.description).toContain("explicit Room name");
  });

  test("required ordinary sharing fails closed without its bound execution", async () => {
    const actorLookup = spyOn(trust, "findActorByOwnerId");
    restores.push(() => actorLookup.mockRestore());
    const tool = createShareArtifactTool({
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
      ordinaryContentAccessRequired: true,
    });
    const out = await tool.invoke({
      artifact_id: ARTIFACT_EXT_ID,
      target: { kind: "room", name: "Project room" },
      sensitivity: "normal",
    });
    expect(out).toContain("approved ordinary content-access execution is unavailable");
    expect(actorLookup).not.toHaveBeenCalled();
  });
});

describe("computeShareArtifactApprovalPreview (M088A)", () => {
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

  const tc = {
    name: "share_artifact" as const,
    args: {
      artifact_id: ARTIFACT_EXT_ID,
      target_handle: "alice",
      sensitivity: "normal" as const,
    },
  };

  test("wrong tool name → null", async () => {
    const p = await computeShareArtifactApprovalPreview(
      { name: "share_memory", args: tc.args },
      { userId: OWNER_ID, memoryAccessEnvelope: envelope() },
    );
    expect(p).toBeNull();
  });

  test("missing required fields → null", async () => {
    const p = await computeShareArtifactApprovalPreview(
      { name: "share_artifact", args: { artifact_id: "", target_handle: "alice" } },
      { userId: OWNER_ID, memoryAccessEnvelope: envelope() },
    );
    expect(p).toBeNull();
  });

  test("roster miss → exact-access preview without Room creation", async () => {
    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(artifactRow() as never);
    restores.push(() => spArt.mockRestore());

    const spTarget = spyOn(shareApprovalPreview, "resolveLocalShareTargetByHandle").mockResolvedValue(null);
    restores.push(() => spTarget.mockRestore());

    const p = await computeShareArtifactApprovalPreview(tc, {
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    expect(p).not.toBeNull();
    expect(p!.targetHandle).toBe("alice");
    expect(p!.roomLabel).toBe("Exact access for @alice");
    expect(p!.wouldCreate).toBe(false);
    expect(p!.artifactPathSnippet).toContain("notes");
  });

  test("happy path → populated preview", async () => {
    const spArt = spyOn(db, "findArtifactByIdForNamespaces").mockResolvedValue(artifactRow() as never);
    restores.push(() => spArt.mockRestore());

    const spTarget = spyOn(shareApprovalPreview, "resolveLocalShareTargetByHandle").mockResolvedValue({
      userId: TGT_USER_ID,
      actorId: TGT_ACTOR_ID,
      displayName: "Alice",
    });
    restores.push(() => spTarget.mockRestore());

    const p = await computeShareArtifactApprovalPreview(tc, {
      userId: OWNER_ID,
      memoryAccessEnvelope: envelope(),
    });
    expect(p!.roomLabel).toBe("Exact access for Alice");
    expect(p!.wouldCreate).toBe(false);
    expect(p!.targetDisplayName).toBe("Alice");
  });
});
