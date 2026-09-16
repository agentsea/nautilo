/**
 * M088B — integration coverage for the workspace-artifact path of the
 * unified file tool.
 *
 * Currently the only integration test that exercises `zone: "workspace"`
 * end-to-end through `dispatchFileCommand`, validating that:
 *   - writes materialize `artifacts` + `artifact_namespaces` DB rows
 *   - reads/lists/grep are scoped to envelope.readableNamespaces
 *   - str_replace/delete bump revision / soft-delete the artifact row
 *   - missing envelope → clear error from envelopeFactsForArtifacts
 *   - cross-namespace visibility: artifact in NS1 is invisible to NS2 envelope
 *
 * This test is intentionally a **post-M033 canary**. The artifact path today
 * uses the wide `db` singleton (RLS-bypass via the `nautilo` table-owner role).
 * M033 Phase 2 will migrate this surface to `agentDb` + `withTrustContext`.
 * When that happens, this test will start failing if any handler forgets the
 * wrap — by design. See ISSUE-M033 Revised Scope.
 */

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  users,
  agents,
  actors,
  namespaces,
  rooms,
  roomMembers,
  groups,
  groupMembers,
  artifacts,
  artifactNamespaces,
  workspaceDocumentMutationEntries,
  workspaceDocumentMutationEntryIdentities,
  workspaceDocumentMutationOutbox,
  workspaceDocumentMutations,
  fileRevisions,
  and,
  eq,
  inArray,
  findArtifactByPathForNamespaces,
  getArtifactNamespaces,
  seedTrustPersonal,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { HumanEditLeaseRegistry } from "@nautilo/document-mutations";
import { dispatchFileCommand, type DispatchContext } from "../../src/tools/file/dispatch";
import type { FileToolRawArgs } from "../../src/tools/file/schema";
import { setWorkspaceArtifactEventSink } from "../../src/tools/file/artifact-store";
import { setLiveReviewWriteGuard } from "../../src/tools/file/live-review-write-guard";
import { prepareWorkspaceArtifactTarget } from "../../src/tools/file/workspace-commands";
import {
  createFileMutationRequestId,
  setWorkspaceCanonicalHistoryRestoreExecution,
  setWorkspaceCanonicalUndoTurnExecution,
  setWorkspaceFileContentCommitExecution,
  setWorkspaceFileContentRecoveryExecution,
  setWorkspaceFileStructuralMutationExecution,
} from "../../src/tools/file/workspace-runtime-adapter";
import { createConvertTool } from "../../src/tools/convert/convert-tool";
import {
  createWorkspaceFileContentCommitExecution,
  createWorkspaceFileContentRecoveryExecution,
} from "../../../server/src/document-mutations/workspace-file-content-coordinator-adapter";
import { createWorkspaceCanonicalHistoryRestoreExecution } from "../../../server/src/document-mutations/workspace-canonical-history-restore-adapter";
import { createWorkspaceCanonicalUndoTurnExecution } from "../../../server/src/document-mutations/workspace-canonical-undo-turn-adapter";
import { createWorkspaceFileStructuralMutationExecution } from "../../../server/src/document-mutations/workspace-file-structural-coordinator-adapter";
import { executeWorkspaceAgentMutation } from "../../../server/src/document-mutations/workspace-agent-mutation-coordinator";
import { readWorkspaceDocumentMutationContent } from "../../../server/src/document-mutations/workspace-artifact-mutation-backend";
import { expectDispatchString } from "../helpers/dispatch-string";
import { createAppToolHost } from "../../../server/src/apps/app-tool-host";
import { parseMiniAppManifestJson } from "../../../server/src/apps/app-manifest";


let db: ReturnType<typeof createDirectDb>;
let userId: string;
let actorId: string;
let agent1Id: string;
let agent1ActorId: string;
// M127: peer agent co-hosting the same Namespace as agent1Id. Used by
// the multi-agent shared-namespace visibility tests at the end of the
// describe block.
let agent2Id: string;
let agent2ActorId: string;
let ghostAgentId: string;
let nsPrivate: string;
let nsShared: string;
// M033 Phase 6 — rooms + room_members are required to satisfy
// `app_can_read_namespace` under nautilo_agent + Path C RLS. Pre-M033 the
// wide handle bypassed RLS so these were unnecessary; now the
// `artifact_namespaces` INSERT (which is policy-gated on namespace
// membership) fails closed without them.
let roomPrivateId: string;
let roomSharedId: string;
let legacyAppliedEvents = 0;

function envFor(opts: {
  agentId: string;
  readable: string[];
  mutable?: string[];
  writable?: string[];
}): MemoryAccessEnvelope {
  return {
    ownerId: userId,
    actorId,
    agentId: opts.agentId,
    roomId:
      (opts.writable?.[0] ?? opts.mutable?.[0] ?? opts.readable[0]) === nsShared
        ? roomSharedId
        : roomPrivateId,
    readableNamespaces: opts.readable,
    mutableNamespaces: opts.mutable ?? opts.readable,
    writableNamespaces: opts.writable ?? opts.readable,
    toolPolicy: {},
  };
}

function ctxWith(envelope: MemoryAccessEnvelope | null, turnId?: string): DispatchContext {
  const ctx: DispatchContext = {
    zoneCtx: { workspaceRoot: "/tmp/m088b-ignored", currentFolder: "/tmp/m088b-ignored" },
    ownerId: userId,
    turnId: turnId ?? randomUUID(),
    memoryAccessEnvelope: envelope,
  };
  if (envelope?.agentId) ctx.agentId = envelope.agentId;
  if (envelope?.roomId) ctx.roomId = envelope.roomId;
  return ctx;
}

async function dispatchStageAndApply(
  args: FileToolRawArgs,
  ctx: DispatchContext,
): Promise<string> {
  return expectDispatchString(await dispatchFileCommand(args, {
    ...ctx,
    mutationRequestId: randomUUID(),
  }));
}

async function commitCanonicalArtifactPlan(input: {
  ctx: DispatchContext;
  operation: string;
  plan: Parameters<typeof executeWorkspaceAgentMutation>[0]["plan"];
}) {
  return executeWorkspaceAgentMutation(
    {
      authority: {
        humanActorId: input.ctx.memoryAccessEnvelope!.actorId,
        ownerId: input.ctx.ownerId,
        agentId: input.ctx.agentId!,
        roomId: input.ctx.roomId!,
      },
      operationId: input.plan.operationId,
      revisionGroupId: `integration:${randomUUID()}`,
      lane: "file_tool",
      historyOperation: input.operation,
      plan: input.plan,
    },
    {
      humanEditLeases: new HumanEditLeaseRegistry({
        ttlMs: 60_000,
        newLeaseId: randomUUID,
      }),
      db,
    },
  );
}

async function deleteArtifactAtPath(
  logicalPath: string,
  _agentId: string,
  readableNamespaceIds: string[],
): Promise<void> {
  const row = await findArtifactByPathForNamespaces({
    path: logicalPath,
    readableNamespaceIds,
  });
  if (!row) return;
  try {
    const receipts = await db
      .select({ mutationId: workspaceDocumentMutationEntries.mutationId })
      .from(workspaceDocumentMutationEntries)
      .where(eq(workspaceDocumentMutationEntries.artifactInternalId, row.id));
    const mutationIds = [...new Set(receipts.map((item) => item.mutationId))];
    if (mutationIds.length > 0) {
      await db
        .delete(workspaceDocumentMutations)
        .where(inArray(workspaceDocumentMutations.id, mutationIds));
    }
    await db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, row.id));
    await db.delete(artifacts).where(eq(artifacts.id, row.id));
  } catch (err) {
    console.warn("[m088b cleanup]", err);
  }
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
  const ts = Date.now().toString(36);

  const [user] = await db
    .insert(users)
    .values({
      name: "m088b-owner",
      email: `m088b-${ts}@test.local`,
      handle: `m088b${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  userId = user.id;

  const [ag1] = await db
    .insert(agents)
    .values({ handle: `m088b-agent-1-${ts}` })
    .returning({ id: agents.id });
  const [ag2] = await db
    .insert(agents)
    .values({ handle: `m088b-agent-2-${ts}` })
    .returning({ id: agents.id });
  const [ghost] = await db
    .insert(agents)
    .values({ handle: `m088b-ghost-${ts}` })
    .returning({ id: agents.id });
  if (!ag1 || !ag2 || !ghost) throw new Error("agent insert failed");
  agent1Id = ag1.id;
  agent2Id = ag2.id;
  ghostAgentId = ghost.id;

  const [nsP] = await db
    .insert(namespaces)
    .values({ scope: "private", label: "m088b-ns-private" })
    .returning({ id: namespaces.id });
  const [nsS] = await db
    .insert(namespaces)
    .values({ scope: "private", label: "m088b-ns-shared" })
    .returning({ id: namespaces.id });
  if (!nsP || !nsS) throw new Error("namespace insert failed");
  nsPrivate = nsP.id;
  nsShared = nsS.id;

  // M033 Phase 6 — actor + rooms + room_members so the agent role can
  // satisfy `app_can_read_namespace` for both namespaces.
  // A migration-only scratch DB intentionally has no production seed rows.
  // Seed the canonical trust ladder against this fixture owner before using
  // the contributors group as the write_artifacts authority.
  const trustSeed = await seedTrustPersonal(userId, "m088b-owner");
  actorId = trustSeed.actorId;

  // Workspace artifact writes are capability-gated. Seat this fixture user in
  // the canonical contributors group so the test exercises the artifact path
  // with the same write_artifacts authority as a real contributor.
  const [contributorsGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "contributors"))
    .limit(1);
  if (!contributorsGroup) throw new Error("canonical contributors group missing");
  await db.insert(groupMembers).values({
    groupId: contributorsGroup.id,
    userId,
    grantedBy: actorId,
  });
  const [agent1Actor] = await db
    .insert(actors)
    .values({
      ownerId: userId,
      displayName: "m088b-agent-1",
      kind: "agent",
      agentId: agent1Id,
    })
    .returning({ id: actors.id });
  const [agent2Actor] = await db
    .insert(actors)
    .values({
      ownerId: userId,
      displayName: "m088b-agent-2",
      kind: "agent",
      agentId: agent2Id,
    })
    .returning({ id: actors.id });
  if (!agent1Actor || !agent2Actor) throw new Error("agent actor insert failed");
  agent1ActorId = agent1Actor.id;
  agent2ActorId = agent2Actor.id;

  const [rPriv] = await db
    .insert(rooms)
    .values({
      namespaceId: nsPrivate,
      ownerId: userId,
      type: "private",
      label: `m088b private ${ts}`,
      graphThreadId: `m088b-priv-${ts}`,
      humanActorIds: [actorId],
    })
    .returning({ id: rooms.id });
  const [rShare] = await db
    .insert(rooms)
    .values({
      namespaceId: nsShared,
      ownerId: userId,
      type: "private",
      label: `m088b shared ${ts}`,
      graphThreadId: `m088b-shared-${ts}`,
      humanActorIds: [actorId],
    })
    .returning({ id: rooms.id });
  if (!rPriv || !rShare) throw new Error("room insert failed");
  roomPrivateId = rPriv.id;
  roomSharedId = rShare.id;

  await db.insert(roomMembers).values([
    { roomId: roomPrivateId, actorId },
    { roomId: roomSharedId, actorId },
    { roomId: roomPrivateId, actorId: agent1ActorId },
    { roomId: roomSharedId, actorId: agent1ActorId },
    { roomId: roomPrivateId, actorId: agent2ActorId },
    { roomId: roomSharedId, actorId: agent2ActorId },
  ]);

  setWorkspaceArtifactEventSink((event) => {
    if (event.type === "document.patch.applied") legacyAppliedEvents += 1;
  });
  setWorkspaceFileContentCommitExecution(
    createWorkspaceFileContentCommitExecution({
      humanEditLeases: new HumanEditLeaseRegistry({
        ttlMs: 60_000,
        newLeaseId: randomUUID,
      }),
      db,
    }),
  );
  setWorkspaceFileContentRecoveryExecution(
    createWorkspaceFileContentRecoveryExecution({
      humanEditLeases: new HumanEditLeaseRegistry({
        ttlMs: 60_000,
        newLeaseId: randomUUID,
      }),
      db,
    }),
  );
  setWorkspaceCanonicalHistoryRestoreExecution(
    createWorkspaceCanonicalHistoryRestoreExecution({
      humanEditLeases: new HumanEditLeaseRegistry({
        ttlMs: 60_000,
        newLeaseId: randomUUID,
      }),
      db,
    }),
  );
  setWorkspaceFileStructuralMutationExecution(
    createWorkspaceFileStructuralMutationExecution({
      humanEditLeases: new HumanEditLeaseRegistry({
        ttlMs: 60_000,
        newLeaseId: randomUUID,
      }),
      db,
    }),
  );
  setWorkspaceCanonicalUndoTurnExecution(
    createWorkspaceCanonicalUndoTurnExecution({
      humanEditLeases: new HumanEditLeaseRegistry({
        ttlMs: 60_000,
        newLeaseId: randomUUID,
      }),
      db,
    }),
  );
});

afterAll(async () => {
  setLiveReviewWriteGuard(null);
  setWorkspaceFileContentCommitExecution(undefined);
  setWorkspaceFileContentRecoveryExecution(undefined);
  setWorkspaceCanonicalHistoryRestoreExecution(undefined);
  setWorkspaceFileStructuralMutationExecution(undefined);
  setWorkspaceCanonicalUndoTurnExecution(undefined);
  if (!db) return;
  try {
    await db
      .delete(workspaceDocumentMutations)
      .where(eq(workspaceDocumentMutations.ownerId, userId));
  } catch (err) {
    console.warn("[m088b teardown] workspaceDocumentMutations", err);
  }
  try {
    await db
      .delete(artifactNamespaces)
      .where(inArray(artifactNamespaces.namespaceId, [nsPrivate, nsShared]));
  } catch (err) {
    console.warn("[m088b teardown] artifactNamespaces", err);
  }
  try {
    // M127: artifacts.agent_id is gone — teardown filters by the
    // namespace junction instead.
    void agent1Id;
    void ghostAgentId;
  } catch (err) {
    console.warn("[m088b teardown] artifacts", err);
  }
  try {
    await db.delete(roomMembers).where(inArray(roomMembers.roomId, [roomPrivateId, roomSharedId]));
  } catch (err) {
    console.warn("[m088b teardown] roomMembers", err);
  }
  try {
    await db.delete(rooms).where(inArray(rooms.id, [roomPrivateId, roomSharedId]));
  } catch (err) {
    console.warn("[m088b teardown] rooms", err);
  }
  try {
    await db.delete(namespaces).where(inArray(namespaces.id, [nsPrivate, nsShared]));
  } catch (err) {
    console.warn("[m088b teardown] namespaces", err);
  }
  try {
    await db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  } catch (err) {
    console.warn("[m088b teardown] groupMembers", err);
  }
  try {
    await db
      .delete(actors)
      .where(inArray(actors.id, [actorId, agent1ActorId, agent2ActorId]));
  } catch (err) {
    console.warn("[m088b teardown] actors", err);
  }
  try {
    await db.delete(agents).where(inArray(agents.id, [agent1Id, agent2Id, ghostAgentId]));
  } catch (err) {
    console.warn("[m088b teardown] agents", err);
  }
  try {
    await db.delete(users).where(eq(users.id, userId));
  } catch (err) {
    console.warn("[m088b teardown] users", err);
  }
  await db.end();
  setWorkspaceArtifactEventSink(null);
});

test("open Writer artifact keeps structural preparation gated while content uses the coordinator", async () => {
  const logicalPath = "m216/open.docx";
  const env = envFor({ agentId: agent1Id, readable: [nsPrivate] });
  const ctx = ctxWith(env);
  await dispatchStageAndApply(
    {
      command: "write",
      zone: "workspace",
      path: logicalPath,
      content: "<html>open</html>",
      mode: "overwrite",
    },
    ctx,
  );
  setLiveReviewWriteGuard(async (target) => {
    if (target.surface !== "workspace" || target.ownerId !== userId) return false;
    return true;
  });
  try {
    const read = await dispatchStageAndApply(
      { command: "read", zone: "workspace", path: logicalPath },
      ctx,
    );
    expect(read).toContain("<html>open</html>");

    const prepared = await prepareWorkspaceArtifactTarget(logicalPath, {
      userId,
      agentId: agent1Id,
      readableNamespaces: [nsPrivate],
      mutableNamespaces: [nsPrivate],
      writableNamespaces: [nsPrivate],
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error("expected open Writer preparation rejection");
    expect(JSON.parse(prepared.reason)).toEqual({
      ok: false,
      status: "use_edit_open_writer",
      code: "use_edit_open_writer",
      message: "This document is open in Writer review. Use edit-open-writer.",
    });
    expect(prepared.reason).not.toContain(logicalPath);

    const convert = createConvertTool(
      {
        ownerId: userId,
        agentId: agent1Id,
        roomId: roomPrivateId,
        workspacePath: "/ignored",
        memoryAccessEnvelope: env,
      },
      {
        isCloudConvertConfigured: () => false,
        markdownToDocxBuffer: async () => Buffer.from("converted bytes"),
      },
    );
    const convertOutput: unknown = await convert.invoke({
      markdown: "# changed",
      format: "docx",
      destinationPath: logicalPath,
      destinationZone: "workspace",
      backend: "local",
    });
    expect(typeof convertOutput).toBe("string");
    if (typeof convertOutput !== "string") {
      throw new Error("expected string convert output");
    }
    expect(JSON.parse(convertOutput)).toEqual({
      ok: false,
      status: "use_edit_open_writer",
      code: "use_edit_open_writer",
      message: "This document is open in Writer review. Use edit-open-writer.",
    });
    expect(convertOutput).not.toContain(logicalPath);
    const afterBlockedConvert = await dispatchStageAndApply(
      { command: "read", zone: "workspace", path: logicalPath },
      ctx,
    );
    expect(afterBlockedConvert).toContain("<html>open</html>");

    const createPrepared = await prepareWorkspaceArtifactTarget(
      "m216/new-output.pdf",
      {
        userId,
        agentId: agent1Id,
        readableNamespaces: [nsPrivate],
        mutableNamespaces: [nsPrivate],
        writableNamespaces: [nsPrivate],
      },
    );
    expect(createPrepared.ok).toBe(true);
    if (createPrepared.ok) expect(createPrepared.meta.mode).toBe("create");

    setLiveReviewWriteGuard(async () => false);
    const nonOpenPrepared = await prepareWorkspaceArtifactTarget(logicalPath, {
      userId,
      agentId: agent1Id,
      readableNamespaces: [nsPrivate],
      mutableNamespaces: [nsPrivate],
      writableNamespaces: [nsPrivate],
    });
    expect(nonOpenPrepared.ok).toBe(true);
    if (nonOpenPrepared.ok) expect(nonOpenPrepared.meta.mode).toBe("update");
    setLiveReviewWriteGuard(async (target) => {
      if (target.surface !== "workspace" || target.ownerId !== userId) return false;
      return true;
    });

    const coordinated = await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: logicalPath,
        oldString: "open",
        newString: "changed",
      },
      ctx,
    );
    expect(coordinated).toMatch(/Applied str_replace/i);
    const afterCoordinatedEdit = await dispatchStageAndApply(
      { command: "read", zone: "workspace", path: logicalPath },
      ctx,
    );
    expect(afterCoordinatedEdit).toContain("<html>changed</html>");
  } finally {
    setLiveReviewWriteGuard(null);
    await deleteArtifactAtPath(logicalPath, agent1Id, [nsPrivate]);
  }
});

test("Design create action supplies trusted coordinator context and retries idempotently", async () => {
  const env = envFor({
    agentId: agent1Id,
    readable: [nsPrivate],
    mutable: [nsPrivate],
    writable: [nsPrivate],
  });
  const turnId = `design-create-${randomUUID()}`;
  const filename = `Moxie-${randomUUID().slice(0, 8)}.design.html`;
  const appsRoot = resolve(import.meta.dirname, "../../../first-party-apps");
  const rawManifest = JSON.parse(
    await readFile(resolve(appsRoot, "design/app.json"), "utf8"),
  ) as unknown;
  const parsedManifest = parseMiniAppManifestJson(rawManifest);
  if (!parsedManifest.ok) throw new Error(parsedManifest.error);
  const host = createAppToolHost({
    appId: "nautilo-design",
    appsRoot,
    manifest: parsedManifest.manifest,
    context: {
      ownerId: userId,
      userId,
      agentId: agent1Id,
      roomId: roomPrivateId,
      turnId,
      memoryAccessEnvelope: env,
    },
  });

  try {
    const first = await host.document.createFromAction("new-design", {
      targetSurface: "workspace",
      filename,
    });
    const replay = await host.document.createFromAction("new-design", {
      targetSurface: "workspace",
      filename,
    });
    expect(first).toEqual({
      target: { surface: "workspace", path: filename },
      displayPath: filename,
      opened: false,
    });
    expect(replay).toEqual(first);
    const row = await findArtifactByPathForNamespaces({
      path: filename,
      readableNamespaceIds: [nsPrivate],
    });
    expect(row).not.toBeNull();
    expect(await getArtifactNamespaces(row!.id)).toEqual([nsPrivate]);
    const mutations = await db
      .select({ id: workspaceDocumentMutations.id, turnId: workspaceDocumentMutations.turnId })
      .from(workspaceDocumentMutations)
      .where(eq(workspaceDocumentMutations.turnId, turnId));
    expect(mutations).toHaveLength(1);
  } finally {
    await deleteArtifactAtPath(filename, agent1Id, [nsPrivate]);
  }
});

describe("M088B workspace-artifact path (integration)", () => {
  test("Workspace glob and grep fail closed with artifact-aware alternatives", async () => {
    const noEnvelopeCtx = ctxWith(null);
    const glob = JSON.parse(expectDispatchString(await dispatchFileCommand(
      { command: "glob", zone: "workspace", path: ".", pattern: "**/*.ts" },
      noEnvelopeCtx,
    ))) as { code: string; message: string };
    expect(glob).toMatchObject({
      code: "unsupported_zone",
    });
    expect(glob.message).toContain("file.list");

    const grep = JSON.parse(expectDispatchString(await dispatchFileCommand(
      { command: "grep", zone: "workspace", path: ".", query: "needle" },
      noEnvelopeCtx,
    ))) as { code: string; message: string };
    expect(grep).toMatchObject({
      code: "unsupported_zone",
    });
    expect(grep.message).toContain("file.read");
  });

  test("write → list → read → str_replace → delete round-trip", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      writable: [nsPrivate],
    });
    const ctx = ctxWith(env);

    const writeOut = await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "canary/notes.md",
        content: "hello canary",
      },
      ctx,
    );
    expect(writeOut).toMatch(/Applied write/i);
    const writeEnvelope = JSON.parse(writeOut) as {
      revisionId: string;
      artifactInternalId: string;
    };

    const row = await findArtifactByPathForNamespaces({
      path: "canary/notes.md",
      readableNamespaceIds: [nsPrivate],
    });
    expect(row).not.toBeNull();
    expect(row!.path).toBe("canary/notes.md");
    expect(writeEnvelope.artifactInternalId).toBe(row!.id);

    const [canonicalEntry] = await db
      .select({
        id: workspaceDocumentMutationEntries.id,
        mutationId: workspaceDocumentMutationEntries.mutationId,
        mutationKind: workspaceDocumentMutationEntries.mutationKind,
        afterRevision: workspaceDocumentMutationEntries.afterRevision,
        afterSha256: workspaceDocumentMutationEntries.afterSha256,
      })
      .from(workspaceDocumentMutationEntries)
      .where(eq(workspaceDocumentMutationEntries.artifactInternalId, row!.id));
    expect(canonicalEntry).toMatchObject({
      mutationKind: "create",
      afterRevision: row!.revision,
      afterSha256: createHash("sha256")
        .update("hello canary")
        .digest("hex"),
    });
    const [canonicalMutation] = await db
      .select({
        lane: workspaceDocumentMutations.lane,
        turnId: workspaceDocumentMutations.turnId,
      })
      .from(workspaceDocumentMutations)
      .where(eq(workspaceDocumentMutations.id, canonicalEntry!.mutationId));
    expect(canonicalMutation?.lane).toBe("file_tool");
    expect(canonicalMutation?.turnId).toBe(ctx.turnId);
    const revisionIdentities = await db
      .select({ value: workspaceDocumentMutationEntryIdentities.value })
      .from(workspaceDocumentMutationEntryIdentities)
      .where(eq(
        workspaceDocumentMutationEntryIdentities.mutationEntryId,
        canonicalEntry!.id,
      ));
    expect(revisionIdentities.map((item) => item.value)).toContain(
      writeEnvelope.revisionId,
    );
    const [canonicalEvent] = await db
      .select({
        eventType: workspaceDocumentMutationOutbox.eventType,
        payload: workspaceDocumentMutationOutbox.payload,
      })
      .from(workspaceDocumentMutationOutbox)
      .where(eq(
        workspaceDocumentMutationOutbox.mutationId,
        canonicalEntry!.mutationId,
      ));
    expect(canonicalEvent?.eventType).toBe("document.mutation.committed");
    expect(canonicalEvent?.payload).toMatchObject({
      type: "document.mutation.committed",
    });
    expect(legacyAppliedEvents).toBe(0);

    const junctionRows = await db
      .select()
      .from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, row!.id));
    expect(junctionRows).toHaveLength(1);
    expect(junctionRows[0]!.namespaceId).toBe(nsPrivate);

    const listOut = expectDispatchString(
      await dispatchFileCommand({ command: "list", zone: "workspace", path: "" }, ctx),
    );
    const listed = JSON.parse(listOut) as { entries: Array<{ path: string }> };
    expect(listed.entries.some((e) => e.path === "canary/notes.md")).toBe(true);

    const readOut = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "canary/notes.md" },
        ctx,
      ),
    );
    expect(readOut).toContain("hello canary");

    const revisionBefore = row!.revision;
    const replaceOut = await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: "canary/notes.md",
        oldString: "hello",
        newString: "bonjour",
      },
      ctx,
    );
    expect(replaceOut).toMatch(/Applied str_replace/i);

    const rowAfterReplace = await findArtifactByPathForNamespaces({
      path: "canary/notes.md",
      readableNamespaceIds: [nsPrivate],
    });
    expect(rowAfterReplace!.revision).toBe(revisionBefore + 1);

    const readAgain = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "canary/notes.md" },
        ctx,
      ),
    );
    expect(readAgain).toContain("bonjour canary");

    const deleteOut = await dispatchStageAndApply(
      { command: "delete", zone: "workspace", path: "canary/notes.md" },
      ctx,
    );
    expect(deleteOut).toMatch(/Applied delete/i);

    const [deletedRow] = await db
      .select({ deletedAt: artifacts.deletedAt })
      .from(artifacts)
      .where(eq(artifacts.id, row!.id));
    expect(deletedRow?.deletedAt).not.toBeNull();

    const listAfterDelete = expectDispatchString(
      await dispatchFileCommand({ command: "list", zone: "workspace", path: "" }, ctx),
    );
    const listedAfter = JSON.parse(listAfterDelete) as { entries: Array<{ path: string }> };
    expect(listedAfter.entries.some((e) => e.path === "canary/notes.md")).toBe(false);
  });

  test("canonical Workspace copy and move are zero-clobber and durably retryable", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const ctx = ctxWith(env);
    const suffix = randomUUID();
    const sourcePath = `structural/source-${suffix}.md`;
    const copiedPath = `structural/copied-${suffix}.md`;
    const movedPath = `structural/moved-${suffix}.md`;
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: sourcePath,
        content: "canonical structural bytes\n",
      },
      ctx,
    );
    const source = await findArtifactByPathForNamespaces({
      path: sourcePath,
      readableNamespaceIds: [nsPrivate],
    });
    expect(source).not.toBeNull();
    const sourcePublicId = `public-source-${suffix}`;
    await db
      .update(artifacts)
      .set({ artifactId: sourcePublicId })
      .where(eq(artifacts.id, source!.id));

    const copyArgs = {
      command: "copy" as const,
      zone: "workspace" as const,
      path: sourcePath,
      destinationPath: copiedPath,
    };
    const copyRequestId = createFileMutationRequestId(
      randomUUID(),
      copyArgs,
    );
    const copied = JSON.parse(expectDispatchString(await dispatchFileCommand(
      copyArgs,
      { ...ctx, mutationRequestId: copyRequestId },
    ))) as {
      applied: boolean;
      command: string;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    };
    expect(copied).toMatchObject({ applied: true, command: "copy" });
    const copiedArtifact = await findArtifactByPathForNamespaces({
      path: copiedPath,
      readableNamespaceIds: [nsPrivate],
    });
    expect(copiedArtifact).not.toBeNull();
    expect(copied).toMatchObject({
      artifactId: copiedArtifact!.artifactId,
      artifactInternalId: copiedArtifact!.id,
    });
    expect(copied.artifactId).not.toBe(copied.artifactInternalId);
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: sourcePath },
      ctx,
    ))).toContain("canonical structural bytes");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: copiedPath },
      ctx,
    ))).toContain("canonical structural bytes");

    const retriedCopy = JSON.parse(expectDispatchString(
      await dispatchFileCommand(
        { ...copyArgs, retryRequestId: copyRequestId },
        { ...ctx, mutationRequestId: copyRequestId },
      ),
    )) as {
      applied: boolean;
      recovered: boolean;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    };
    expect(retriedCopy).toMatchObject({
      applied: true,
      recovered: true,
      revisionId: copied.revisionId,
      artifactId: copied.artifactId,
      artifactInternalId: copied.artifactInternalId,
    });
    const copyReceipts = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(
        workspaceDocumentMutationEntries.artifactInternalId,
        copied.artifactInternalId,
      ));
    expect(copyReceipts).toHaveLength(1);
    expect(copyReceipts[0]?.historyOperation).toBe("copy");

    const moveArgs = {
      command: "move" as const,
      zone: "workspace" as const,
      path: copiedPath,
      destinationPath: movedPath,
    };
    const moveRequestId = createFileMutationRequestId(randomUUID(), moveArgs);
    const moved = JSON.parse(expectDispatchString(await dispatchFileCommand(
      moveArgs,
      { ...ctx, mutationRequestId: moveRequestId },
    ))) as {
      applied: boolean;
      command: string;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    };
    expect(moved).toMatchObject({
      applied: true,
      command: "move",
      artifactId: copied.artifactId,
      artifactInternalId: copied.artifactInternalId,
    });
    const retriedMove = JSON.parse(expectDispatchString(
      await dispatchFileCommand(
        { ...moveArgs, retryRequestId: moveRequestId },
        { ...ctx, mutationRequestId: moveRequestId },
      ),
    )) as {
      applied: boolean;
      recovered: boolean;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    };
    expect(retriedMove).toMatchObject({
      applied: true,
      recovered: true,
      revisionId: moved.revisionId,
      artifactId: moved.artifactId,
      artifactInternalId: moved.artifactInternalId,
    });
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: copiedPath },
      ctx,
    ))).toContain("No workspace artifact");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: movedPath },
      ctx,
    ))).toContain("canonical structural bytes");

    const occupied = JSON.parse(await dispatchStageAndApply(
      {
        command: "move",
        zone: "workspace",
        path: sourcePath,
        destinationPath: movedPath,
      },
      ctx,
    )) as { code: string };
    expect(occupied.code).toBe("destination_exists");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: sourcePath },
      ctx,
    ))).toContain("canonical structural bytes");

    const recursiveDelete = JSON.parse(await dispatchStageAndApply(
      {
        command: "delete",
        zone: "workspace",
        path: sourcePath,
        recursive: true,
      },
      ctx,
    )) as { code: string };
    expect(recursiveDelete.code).toBe("recursive_not_supported");

    const deleteArgs = {
      command: "delete" as const,
      zone: "workspace" as const,
      path: sourcePath,
    };
    const deleteRequestId = createFileMutationRequestId(
      randomUUID(),
      deleteArgs,
    );
    const deleted = JSON.parse(expectDispatchString(await dispatchFileCommand(
      deleteArgs,
      { ...ctx, mutationRequestId: deleteRequestId },
    ))) as {
      applied: boolean;
      command: string;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    };
    expect(deleted).toMatchObject({
      applied: true,
      command: "delete",
      artifactId: sourcePublicId,
      artifactInternalId: source!.id,
    });
    expect(deleted.artifactId).not.toBe(deleted.artifactInternalId);
    const retriedDelete = JSON.parse(expectDispatchString(
      await dispatchFileCommand(
        { ...deleteArgs, retryRequestId: deleteRequestId },
        { ...ctx, mutationRequestId: deleteRequestId },
      ),
    )) as {
      applied: boolean;
      recovered: boolean;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    };
    expect(retriedDelete).toMatchObject({
      applied: true,
      recovered: true,
      revisionId: deleted.revisionId,
      artifactId: deleted.artifactId,
      artifactInternalId: deleted.artifactInternalId,
    });
  });

  test("canonical Workspace undo/redo is receipt-only, rebases revision drift, and rejects legacy history", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const ctx = ctxWith(env);
    const logicalPath = `history/update-${randomUUID()}.md`;
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: logicalPath,
        content: "alpha\n",
      },
      ctx,
    );
    const replace = JSON.parse(await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: logicalPath,
        oldString: "alpha",
        newString: "beta",
      },
      ctx,
    )) as { revisionId: string };

    const undoArgs = {
      command: "undo" as const,
      zone: "workspace" as const,
      path: logicalPath,
      revisionId: replace.revisionId,
    };
    const undoRequestId = createFileMutationRequestId(
      randomUUID(),
      undoArgs,
    );
    const undone = JSON.parse(expectDispatchString(await dispatchFileCommand(
      undoArgs,
      { ...ctx, mutationRequestId: undoRequestId },
    ))) as { applied: boolean; command: string; revisionId: string };
    expect(undone).toMatchObject({ applied: true, command: "undo" });
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: logicalPath },
      ctx,
    ))).toContain("alpha");

    const row = await findArtifactByPathForNamespaces({
      path: logicalPath,
      readableNamespaceIds: [nsPrivate],
    });
    expect(row).not.toBeNull();
    const restoreEntries = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(
        workspaceDocumentMutationEntries.artifactInternalId,
        row!.id,
      ));
    const undoEntry = restoreEntries.find(
      (entry) => entry.historyOperation === "undo",
    );
    expect(undoEntry?.restoreFromEntryId).not.toBeNull();
    const [undoEvent] = await db
      .select()
      .from(workspaceDocumentMutationOutbox)
      .where(eq(
        workspaceDocumentMutationOutbox.mutationId,
        undoEntry!.mutationId,
      ));
    expect(undoEvent?.eventType).toBe("document.mutation.committed");
    const receiptCountBeforeRetry = restoreEntries.filter(
      (entry) => entry.historyOperation === "undo",
    ).length;
    const retried = JSON.parse(expectDispatchString(await dispatchFileCommand(
      { ...undoArgs, retryRequestId: undoRequestId },
      { ...ctx, mutationRequestId: undoRequestId },
    ))) as { applied: boolean; recovered: boolean; revisionId: string };
    expect(retried).toMatchObject({
      applied: true,
      recovered: true,
      revisionId: undone.revisionId,
    });
    const receiptsAfterRetry = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(
        workspaceDocumentMutationEntries.artifactInternalId,
        row!.id,
      ));
    expect(receiptsAfterRetry.filter(
      (entry) => entry.historyOperation === "undo",
    )).toHaveLength(receiptCountBeforeRetry);

    const redone = JSON.parse(await dispatchStageAndApply(
      { command: "redo", zone: "workspace", path: logicalPath },
      ctx,
    )) as { applied: boolean; command: string };
    expect(redone).toMatchObject({ applied: true, command: "redo" });
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: logicalPath },
      ctx,
    ))).toContain("beta");

    await db
      .update(artifacts)
      .set({ revision: row!.revision + 3 })
      .where(eq(artifacts.id, row!.id));
    const drift = JSON.parse(await dispatchStageAndApply(
      { command: "undo", zone: "workspace", path: logicalPath },
      ctx,
    )) as { applied: boolean; command: string; revisionId: string };
    expect(drift).toMatchObject({ applied: true, command: "undo" });
    expect(typeof drift.revisionId).toBe("string");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: logicalPath },
      ctx,
    ))).toContain("alpha");

    const legacyId = randomUUID();
    await db.insert(fileRevisions).values({
      id: legacyId,
      ownerId: userId,
      agentId: agent1Id,
      roomId: roomPrivateId,
      turnId: randomUUID(),
      absolutePath: `/legacy/${legacyId}`,
      workspacePath: logicalPath,
      preSha256: createHash("sha256").update("legacy").digest("hex"),
      preSize: 6,
      kind: "diff",
      diffText: "",
      operation: "write",
    });
    const legacy = JSON.parse(await dispatchStageAndApply(
      {
        command: "undo",
        zone: "workspace",
        path: logicalPath,
        revisionId: legacyId,
      },
      ctx,
    )) as { code: string };
    expect(legacy.code).toBe("legacy_history_unverifiable");

    const revoked = JSON.parse(await dispatchStageAndApply(
      { command: "undo", zone: "workspace", path: logicalPath },
      ctxWith(envFor({
        agentId: ghostAgentId,
        readable: [nsPrivate],
        mutable: [nsPrivate],
      })),
    )) as { code: string };
    expect(revoked.code).toBe("reapply_required");
  });

  test("canonical Workspace history follows durable multi-step undo and redo stacks", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const ctx = ctxWith(env);
    const logicalPath = `history/lineage-${randomUUID()}.md`;
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: logicalPath,
        content: "alpha\n",
      },
      ctx,
    );
    const forwardA = JSON.parse(await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: logicalPath,
        oldString: "alpha",
        newString: "beta",
      },
      ctx,
    )) as { revisionId: string };
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: logicalPath,
        oldString: "beta",
        newString: "gamma",
      },
      ctx,
    );

    const ineligible = JSON.parse(await dispatchStageAndApply(
      {
        command: "undo",
        zone: "workspace",
        path: logicalPath,
        revisionId: forwardA.revisionId,
      },
      ctx,
    )) as { code: string };
    expect(ineligible.code).toBe("revision_not_found");

    const readContent = async (): Promise<string> =>
      expectDispatchString(await dispatchFileCommand(
        { command: "read", zone: "workspace", path: logicalPath },
        ctx,
      ));

    expect(JSON.parse(await dispatchStageAndApply(
      { command: "undo", zone: "workspace", path: logicalPath },
      ctx,
    ))).toMatchObject({ applied: true, command: "undo" });
    expect(await readContent()).toContain("beta");

    expect(JSON.parse(await dispatchStageAndApply(
      { command: "undo", zone: "workspace", path: logicalPath },
      ctx,
    ))).toMatchObject({ applied: true, command: "undo" });
    expect(await readContent()).toContain("alpha");

    expect(JSON.parse(await dispatchStageAndApply(
      { command: "redo", zone: "workspace", path: logicalPath },
      ctx,
    ))).toMatchObject({ applied: true, command: "redo" });
    expect(await readContent()).toContain("beta");

    expect(JSON.parse(await dispatchStageAndApply(
      { command: "redo", zone: "workspace", path: logicalPath },
      ctx,
    ))).toMatchObject({ applied: true, command: "redo" });
    expect(await readContent()).toContain("gamma");

    const redoBoundary = JSON.parse(await dispatchStageAndApply(
      { command: "redo", zone: "workspace", path: logicalPath },
      ctx,
    )) as { code: string };
    expect(redoBoundary.code).toBe("nothing_to_redo");

    expect(JSON.parse(await dispatchStageAndApply(
      { command: "undo", zone: "workspace", path: logicalPath },
      ctx,
    ))).toMatchObject({ applied: true, command: "undo" });
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: logicalPath,
        oldString: "beta",
        newString: "delta",
      },
      ctx,
    );
    expect(await readContent()).toContain("delta");

    const invalidatedRedo = JSON.parse(await dispatchStageAndApply(
      { command: "redo", zone: "workspace", path: logicalPath },
      ctx,
    )) as { code: string };
    expect(invalidatedRedo.code).toBe("nothing_to_redo");
  });

  test("canonical Workspace undo_turn atomically collapses multi-file and same-file chains", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const suffix = randomUUID();
    const firstPath = `history/turn-first-${suffix}.md`;
    const secondPath = `history/turn-second-${suffix}.md`;
    const baseCtx = ctxWith(env);
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: firstPath,
        content: "alpha\n",
      },
      baseCtx,
    );
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: secondPath,
        content: "one\n",
      },
      baseCtx,
    );

    const targetTurnId = `target-${randomUUID()}`;
    const targetCtx = ctxWith(env, targetTurnId);
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: firstPath,
        oldString: "alpha",
        newString: "beta",
      },
      targetCtx,
    );
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: firstPath,
        oldString: "beta",
        newString: "gamma",
      },
      targetCtx,
    );
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: secondPath,
        oldString: "one",
        newString: "two",
      },
      targetCtx,
    );

    const undoArgs = {
      command: "undo_turn" as const,
      zone: "workspace" as const,
      targetTurnId,
    };
    const undoRequestId = createFileMutationRequestId(randomUUID(), undoArgs);
    const undoCtx = ctxWith(env);
    const undone = JSON.parse(expectDispatchString(await dispatchFileCommand(
      undoArgs,
      { ...undoCtx, mutationRequestId: undoRequestId },
    ))) as {
      appliedCount: number;
      outcomes: Array<{
        revisionId: string;
        artifactInternalId: string;
        path: string;
      }>;
    };
    expect(undone.appliedCount).toBe(2);
    expect(undone.outcomes.map((outcome) => outcome.artifactInternalId))
      .toEqual(
        undone.outcomes
          .map((outcome) => outcome.artifactInternalId)
          .sort(),
      );
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: firstPath },
      undoCtx,
    ))).toContain("alpha");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: secondPath },
      undoCtx,
    ))).toContain("one");

    const undoReceipts = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(
        workspaceDocumentMutationEntries.historyOperation,
        "undo_turn",
      ));
    const matchingReceipts = undoReceipts.filter((entry) =>
      undone.outcomes.some(
        (outcome) => outcome.artifactInternalId === entry.artifactInternalId,
      )
    );
    expect(matchingReceipts).toHaveLength(2);
    expect(matchingReceipts.every(
      (entry) => entry.restoreFromEntryId !== null,
    )).toBe(true);

    setWorkspaceCanonicalUndoTurnExecution(
      createWorkspaceCanonicalUndoTurnExecution({
        humanEditLeases: new HumanEditLeaseRegistry({
          ttlMs: 60_000,
          newLeaseId: randomUUID,
        }),
        db,
      }),
    );
    const recovered = JSON.parse(expectDispatchString(
      await dispatchFileCommand(
        { ...undoArgs, retryRequestId: undoRequestId },
        { ...undoCtx, mutationRequestId: undoRequestId },
      ),
    )) as typeof undone;
    expect(recovered).toEqual(undone);
    const receiptsAfterRetry = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(
        workspaceDocumentMutationEntries.historyOperation,
        "undo_turn",
      ));
    expect(receiptsAfterRetry).toHaveLength(undoReceipts.length);
  });

  test("canonical Workspace undo_turn rejects a later active edit without partial restore", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const suffix = randomUUID();
    const firstPath = `history/drift-first-${suffix}.md`;
    const secondPath = `history/drift-second-${suffix}.md`;
    const baseCtx = ctxWith(env);
    for (const path of [firstPath, secondPath]) {
      await dispatchStageAndApply(
        {
          command: "write",
          zone: "workspace",
          path,
          content: "base\n",
        },
        baseCtx,
      );
    }
    const targetTurnId = `target-${randomUUID()}`;
    const targetCtx = ctxWith(env, targetTurnId);
    for (const path of [firstPath, secondPath]) {
      await dispatchStageAndApply(
        {
          command: "str_replace",
          zone: "workspace",
          path,
          oldString: "base",
          newString: "target",
        },
        targetCtx,
      );
    }
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: firstPath,
        oldString: "target",
        newString: "later",
      },
      baseCtx,
    );
    const rejected = JSON.parse(await dispatchStageAndApply(
      {
        command: "undo_turn",
        zone: "workspace",
        targetTurnId,
      },
      baseCtx,
    )) as { code: string };
    expect(rejected.code).toBe("ineligible_history");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: firstPath },
      baseCtx,
    ))).toContain("later");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: secondPath },
      baseCtx,
    ))).toContain("target");
  });

  test("concurrent identical Workspace undo_turn calls converge on one durable receipt", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const path = `history/race-${randomUUID()}.md`;
    const baseCtx = ctxWith(env);
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path,
        content: "before\n",
      },
      baseCtx,
    );
    const targetTurnId = `target-${randomUUID()}`;
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path,
        oldString: "before",
        newString: "after",
      },
      ctxWith(env, targetTurnId),
    );
    const args = {
      command: "undo_turn" as const,
      zone: "workspace" as const,
      targetTurnId,
    };
    const mutationRequestId = createFileMutationRequestId(randomUUID(), args);
    const invocationCtx = {
      ...ctxWith(env),
      mutationRequestId,
    };
    const [left, right] = await Promise.all([
      dispatchFileCommand(args, invocationCtx),
      dispatchFileCommand(args, invocationCtx),
    ]);
    expect(JSON.parse(expectDispatchString(left))).toEqual(
      JSON.parse(expectDispatchString(right)),
    );
    const artifact = await findArtifactByPathForNamespaces({
      path,
      readableNamespaceIds: [nsPrivate],
    });
    expect(artifact).not.toBeNull();
    const receipts = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(
        workspaceDocumentMutationEntries.artifactInternalId,
        artifact!.id,
      ));
    expect(receipts.filter(
      (entry) => entry.historyOperation === "undo_turn",
    )).toHaveLength(1);
  });

  test("canonical Workspace undo_turn restores a delete and simple move atomically", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const suffix = randomUUID();
    const deletedPath = `history/turn-delete-${suffix}.md`;
    const moveBeforePath = `history/turn-move-before-${suffix}.md`;
    const moveAfterPath = `history/turn-move-after-${suffix}.md`;
    const baseCtx = ctxWith(env);
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: deletedPath,
        content: "restore deleted\n",
      },
      baseCtx,
    );
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: moveBeforePath,
        content: "restore moved\n",
      },
      baseCtx,
    );
    const targetTurnId = `target-${randomUUID()}`;
    const targetCtx = ctxWith(env, targetTurnId);
    await dispatchStageAndApply(
      {
        command: "delete",
        zone: "workspace",
        path: deletedPath,
      },
      targetCtx,
    );
    await dispatchStageAndApply(
      {
        command: "move",
        zone: "workspace",
        path: moveBeforePath,
        destinationPath: moveAfterPath,
      },
      targetCtx,
    );
    const result = JSON.parse(await dispatchStageAndApply(
      {
        command: "undo_turn",
        zone: "workspace",
        targetTurnId,
      },
      baseCtx,
    )) as { appliedCount: number };
    expect(result.appliedCount).toBe(2);
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: deletedPath },
      baseCtx,
    ))).toContain("restore deleted");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: moveBeforePath },
      baseCtx,
    ))).toContain("restore moved");
    expect(expectDispatchString(await dispatchFileCommand(
      { command: "read", zone: "workspace", path: moveAfterPath },
      baseCtx,
    ))).toContain("No workspace artifact");
  });

  test("canonical Workspace undo_turn revalidates Room authority before mutation", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const path = `history/revoked-${randomUUID()}.md`;
    const baseCtx = ctxWith(env);
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path,
        content: "before\n",
      },
      baseCtx,
    );
    const targetTurnId = `target-${randomUUID()}`;
    await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path,
        oldString: "before",
        newString: "after",
      },
      ctxWith(env, targetTurnId),
    );
    await db
      .delete(roomMembers)
      .where(and(
        eq(roomMembers.roomId, roomPrivateId),
        eq(roomMembers.actorId, agent1ActorId),
      ));
    try {
      const rejected = JSON.parse(await dispatchStageAndApply(
        {
          command: "undo_turn",
          zone: "workspace",
          targetTurnId,
        },
        baseCtx,
      )) as { code: string };
      expect(rejected.code).toBe("reapply_required");
      expect(expectDispatchString(await dispatchFileCommand(
        { command: "read", zone: "workspace", path },
        baseCtx,
      ))).toContain("after");
    } finally {
      await db.insert(roomMembers).values({
        roomId: roomPrivateId,
        actorId: agent1ActorId,
      });
    }
  });

  test("one human lease rejects the complete Workspace undo_turn batch", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const suffix = randomUUID();
    const firstPath = `history/lease-first-${suffix}.md`;
    const secondPath = `history/lease-second-${suffix}.md`;
    const baseCtx = ctxWith(env);
    for (const path of [firstPath, secondPath]) {
      await dispatchStageAndApply(
        {
          command: "write",
          zone: "workspace",
          path,
          content: "before\n",
        },
        baseCtx,
      );
    }
    const targetTurnId = `target-${randomUUID()}`;
    const targetCtx = ctxWith(env, targetTurnId);
    for (const path of [firstPath, secondPath]) {
      await dispatchStageAndApply(
        {
          command: "str_replace",
          zone: "workspace",
          path,
          oldString: "before",
          newString: "after",
        },
        targetCtx,
      );
    }
    const leasedArtifact = await findArtifactByPathForNamespaces({
      path: secondPath,
      readableNamespaceIds: [nsPrivate],
    });
    expect(leasedArtifact).not.toBeNull();
    const leasedBytes = await readWorkspaceDocumentMutationContent(
      leasedArtifact!.storageUri,
    );
    const leasedSha = createHash("sha256").update(leasedBytes).digest("hex");
    const leases = new HumanEditLeaseRegistry({
      ttlMs: 60_000,
      newLeaseId: () => `lease-${suffix}`,
    });
    expect(leases.register({
      sessionId: `session-${suffix}`,
      humanId: userId,
      identity: {
        kind: "workspace_artifact",
        artifactId: leasedArtifact!.id,
        logicalPath: secondPath,
      },
      baseVersion: {
        identity: {
          kind: "workspace_artifact",
          artifactId: leasedArtifact!.id,
          logicalPath: secondPath,
        },
        backendVersion: {
          kind: "artifact_revision",
          revision: leasedArtifact!.revision,
        },
        sha256: leasedSha,
      },
      state: "dirty",
      draftPatch: {
        kind: "anchored_text",
        oldString: "after",
        newString: "human",
      },
    }).status).toBe("ok");
    setWorkspaceCanonicalUndoTurnExecution(
      createWorkspaceCanonicalUndoTurnExecution({
        humanEditLeases: leases,
        db,
      }),
    );
    try {
      const rejected = JSON.parse(await dispatchStageAndApply(
        {
          command: "undo_turn",
          zone: "workspace",
          targetTurnId,
        },
        baseCtx,
      )) as { code: string };
      expect(rejected.code).toBe("human_edit_conflict");
      for (const path of [firstPath, secondPath]) {
        expect(expectDispatchString(await dispatchFileCommand(
          { command: "read", zone: "workspace", path },
          baseCtx,
        ))).toContain("after");
      }
    } finally {
      setWorkspaceCanonicalUndoTurnExecution(
        createWorkspaceCanonicalUndoTurnExecution({
          humanEditLeases: new HumanEditLeaseRegistry({
            ttlMs: 60_000,
            newLeaseId: randomUUID,
          }),
          db,
        }),
      );
    }
  });

  test("canonical Workspace undo_turn fails closed for a legacy-only turn", async () => {
    const targetTurnId = `legacy-turn-${randomUUID()}`;
    const revisionId = randomUUID();
    await db.insert(fileRevisions).values({
      id: revisionId,
      ownerId: userId,
      agentId: agent1Id,
      roomId: roomPrivateId,
      turnId: targetTurnId,
      absolutePath: `/legacy/${revisionId}`,
      workspacePath: `legacy/${revisionId}.md`,
      preSha256: createHash("sha256").update("legacy").digest("hex"),
      preSize: 6,
      kind: "diff",
      diffText: "",
      operation: "write",
    });
    const result = JSON.parse(await dispatchStageAndApply(
      {
        command: "undo_turn",
        zone: "workspace",
        targetTurnId,
      },
      ctxWith(envFor({
        agentId: agent1Id,
        readable: [nsPrivate],
        mutable: [nsPrivate],
        writable: [nsPrivate],
      })),
    )) as { code: string };
    expect(result.code).toBe("legacy_history_unverifiable");
  });

  test("canonical restore revives soft deletes and inverses a simple move", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      mutable: [nsPrivate],
      writable: [nsPrivate],
    });
    const ctx = ctxWith(env);
    const deletedPath = `history/deleted-${randomUUID()}.md`;
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: deletedPath,
        content: "restore me\n",
      },
      ctx,
    );
    const deletedArtifact = await findArtifactByPathForNamespaces({
      path: deletedPath,
      readableNamespaceIds: [nsPrivate],
    });
    const deletedBytes = await readWorkspaceDocumentMutationContent(
      deletedArtifact!.storageUri,
    );
    const deletedSha = createHash("sha256").update(deletedBytes).digest("hex");
    const deleteOperationId = `integration-delete:${randomUUID()}`;
    const deleted = await commitCanonicalArtifactPlan({
      ctx,
      operation: "delete",
      plan: {
        operationId: deleteOperationId,
        actor: { kind: "agent", agentId: agent1Id },
        turnId: ctx.turnId,
        entries: [{
          kind: "delete",
          before: {
            identity: {
              kind: "workspace_artifact",
              artifactId: deletedArtifact!.id,
              logicalPath: deletedPath,
            },
            expectedVersion: {
              identity: {
                kind: "workspace_artifact",
                artifactId: deletedArtifact!.id,
                logicalPath: deletedPath,
              },
              backendVersion: {
                kind: "artifact_revision",
                revision: deletedArtifact!.revision,
              },
              sha256: deletedSha,
            },
            bytes: new Uint8Array([...deletedBytes]),
          },
        }],
      },
    });
    expect(deleted.kind).toBe("committed");
    const [deleteEntry] = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .innerJoin(
        workspaceDocumentMutations,
        eq(
          workspaceDocumentMutations.id,
          workspaceDocumentMutationEntries.mutationId,
        ),
      )
      .where(eq(
        workspaceDocumentMutations.operationId,
        deleteOperationId,
      ));
    const deleteRevision = await db
      .select()
      .from(workspaceDocumentMutationEntryIdentities)
      .where(eq(
        workspaceDocumentMutationEntryIdentities.mutationEntryId,
        deleteEntry!.workspace_document_mutation_entries.id,
      ));
    const restored = JSON.parse(await dispatchStageAndApply(
      {
        command: "undo",
        zone: "workspace",
        path: deletedPath,
        revisionId: deleteRevision.find(
          (item) => item.kind === "revision",
        )!.value,
      },
      ctx,
    )) as { applied: boolean };
    expect(restored.applied).toBe(true);
    const [revivedRow] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, deletedArtifact!.id));
    expect(revivedRow?.deletedAt).toBeNull();
    const restoreReceipt = await db
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(
        workspaceDocumentMutationEntries.restoreFromEntryId,
        deleteEntry!.workspace_document_mutation_entries.id,
      ));
    expect(restoreReceipt).toHaveLength(1);
    const [restoreEvent] = await db
      .select()
      .from(workspaceDocumentMutationOutbox)
      .where(eq(
        workspaceDocumentMutationOutbox.mutationId,
        restoreReceipt[0]!.mutationId,
      ));
    expect(restoreEvent?.eventType).toBe("document.mutation.committed");
    await dispatchStageAndApply(
      { command: "redo", zone: "workspace", path: deletedPath },
      ctx,
    );
    const [redeletedRow] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, deletedArtifact!.id));
    expect(redeletedRow?.deletedAt).not.toBeNull();

    const beforeMovePath = `history/move-before-${randomUUID()}.md`;
    const afterMovePath = beforeMovePath.replace("move-before", "move-after");
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: beforeMovePath,
        content: "move me\n",
      },
      ctx,
    );
    const moveArtifact = await findArtifactByPathForNamespaces({
      path: beforeMovePath,
      readableNamespaceIds: [nsPrivate],
    });
    const moveBytes = await readWorkspaceDocumentMutationContent(
      moveArtifact!.storageUri,
    );
    const moveSha = createHash("sha256").update(moveBytes).digest("hex");
    const moveOperationId = `integration-move:${randomUUID()}`;
    expect((await commitCanonicalArtifactPlan({
      ctx,
      operation: "move",
      plan: {
        operationId: moveOperationId,
        actor: { kind: "agent", agentId: agent1Id },
        turnId: ctx.turnId,
        entries: [{
          kind: "move",
          source: {
            identity: {
              kind: "workspace_artifact",
              artifactId: moveArtifact!.id,
              logicalPath: beforeMovePath,
            },
            expectedVersion: {
              identity: {
                kind: "workspace_artifact",
                artifactId: moveArtifact!.id,
                logicalPath: beforeMovePath,
              },
              backendVersion: {
                kind: "artifact_revision",
                revision: moveArtifact!.revision,
              },
              sha256: moveSha,
            },
            bytes: new Uint8Array([...moveBytes]),
          },
          after: {
            identity: {
              kind: "workspace_artifact",
              artifactId: moveArtifact!.id,
              logicalPath: afterMovePath,
            },
            bytes: new Uint8Array([...moveBytes]),
            sha256: moveSha,
          },
        }],
      },
    })).kind).toBe("committed");
    await dispatchStageAndApply(
      { command: "undo", zone: "workspace", path: afterMovePath },
      ctx,
    );
    expect(await findArtifactByPathForNamespaces({
      path: beforeMovePath,
      readableNamespaceIds: [nsPrivate],
    })).not.toBeNull();
    expect(await findArtifactByPathForNamespaces({
      path: afterMovePath,
      readableNamespaceIds: [nsPrivate],
    })).toBeNull();
  });

  test("cross-namespace visibility: artifact in ns-private is invisible to ns-shared envelope", async () => {
    const writeEnv = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      writable: [nsPrivate],
    });
    const writeCtx = ctxWith(writeEnv);
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "private/secret.md",
        content: "invisible",
      },
      writeCtx,
    );

    const sharedEnv = envFor({
      agentId: agent1Id,
      readable: [nsShared],
      writable: [nsShared],
    });
    const sharedCtx = ctxWith(sharedEnv);

    const listOut = expectDispatchString(
      await dispatchFileCommand({ command: "list", zone: "workspace", path: "" }, sharedCtx),
    );
    const listed = JSON.parse(listOut) as { entries: Array<{ path: string }> };
    expect(listed.entries.some((e) => e.path === "private/secret.md")).toBe(false);

    const readOut = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "private/secret.md" },
        sharedCtx,
      ),
    );
    expect(readOut).toMatch(/No workspace artifact.*"private\/secret\.md"/);

    await deleteArtifactAtPath("private/secret.md", agent1Id, [nsPrivate, nsShared]);
  });

  test("missing envelope returns clear error", async () => {
    const out = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "anything.md" },
        ctxWith(null),
      ),
    );
    expect(out).toContain(
      "Workspace artifact access requires an authenticated room/namespace context",
    );
  });

  test("missing agentId in envelope returns clear error", async () => {
    const badEnv = envFor({ agentId: "", readable: [nsPrivate] });
    const out = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "anything.md" },
        ctxWith(badEnv),
      ),
    );
    expect(out).toContain(
      "workspace artifact access requires an authenticated agent context",
    );
  });

  test("logical path validation: rejects path traversal", async () => {
    const env = envFor({ agentId: agent1Id, readable: [nsPrivate] });
    const out = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "../escape.md" },
        ctxWith(env),
      ),
    );
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("..");
  });

  test("writableNamespaces gates create: new path lands in writable[0]", async () => {
    const env = envFor({
      agentId: agent1Id,
      readable: [nsPrivate, nsShared],
      mutable: [nsPrivate, nsShared],
      writable: [nsShared],
    });
    const ctx = ctxWith(env);
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "canary-write/new.md",
        content: "from writable[0]",
      },
      ctx,
    );

    const row = await findArtifactByPathForNamespaces({
      path: "canary-write/new.md",
      readableNamespaceIds: [nsPrivate, nsShared],
    });
    expect(row).not.toBeNull();
    const nsIds = await getArtifactNamespaces(row!.id);
    expect(nsIds).toEqual([nsShared]);

    await deleteArtifactAtPath("canary-write/new.md", agent1Id, [nsPrivate, nsShared]);
  });

  test("re-write to existing path goes through mutableNamespaces, not writableNamespaces", async () => {
    const createEnv = envFor({
      agentId: agent1Id,
      readable: [nsShared],
      mutable: [nsShared],
      writable: [nsShared],
    });
    const createCtx = ctxWith(createEnv);
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "canary-rewrite/existing.md",
        content: "v1",
      },
      createCtx,
    );

    const rowBefore = await findArtifactByPathForNamespaces({
      path: "canary-rewrite/existing.md",
      readableNamespaceIds: [nsShared],
    });
    expect(rowBefore).not.toBeNull();
    const revisionBefore = rowBefore!.revision;
    const internalId = rowBefore!.id;

    const rewriteEnv = envFor({
      agentId: agent1Id,
      readable: [nsPrivate, nsShared],
      mutable: [nsShared],
      writable: [nsPrivate],
    });
    const rewriteCtx = ctxWith(rewriteEnv);
    const rewriteOut = await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "canary-rewrite/existing.md",
        content: "v2",
      },
      rewriteCtx,
    );
    expect(rewriteOut).toMatch(/Applied write/i);

    const nsIds = await getArtifactNamespaces(internalId);
    expect(nsIds).toEqual([nsShared]);

    const rowAfter = await findArtifactByPathForNamespaces({
      path: "canary-rewrite/existing.md",
      readableNamespaceIds: [nsShared],
    });
    expect(rowAfter!.revision).toBe(revisionBefore + 1);

    await deleteArtifactAtPath("canary-rewrite/existing.md", agent1Id, [nsPrivate, nsShared]);
  });

  // -----------------------------------------------------------------
  // M127: Namespace-only content scope for Artifacts
  // -----------------------------------------------------------------
  // Two agents co-hosting one Namespace share its Artifact rows. Pre-M127
  // these tests would have failed (`artifacts.agent_id` partitioned
  // visibility). Post-M127, Namespace membership IS the boundary.

  test("M127: AgentB reads workspace artifact written by AgentA in shared Namespace", async () => {
    const envA = envFor({
      agentId: agent1Id,
      readable: [nsShared],
      writable: [nsShared],
    });
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "m127-shared/notes.md",
        content: "shared by agentA",
      },
      ctxWith(envA),
    );

    // AgentB queries the same Namespace — must see the artifact row.
    const rowForB = await findArtifactByPathForNamespaces({
      path: "m127-shared/notes.md",
      readableNamespaceIds: [nsShared],
    });
    expect(rowForB).not.toBeNull();

    // AgentB also reads bytes via the file tool — must succeed.
    const envB = envFor({
      agentId: agent2Id,
      readable: [nsShared],
      writable: [nsShared],
    });
    const readOut = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "m127-shared/notes.md" },
        ctxWith(envB),
      ),
    );
    expect(readOut).toContain("shared by agentA");

    await deleteArtifactAtPath("m127-shared/notes.md", agent1Id, [nsShared]);
  });

  test("M127: AgentB's workspace list includes AgentA's artifact in shared Namespace", async () => {
    const envA = envFor({
      agentId: agent1Id,
      readable: [nsShared],
      writable: [nsShared],
    });
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "m127-shared-list/peer-visible.md",
        content: "should appear in peer list",
      },
      ctxWith(envA),
    );

    const envB = envFor({
      agentId: agent2Id,
      readable: [nsShared],
      writable: [nsShared],
    });
    const listOut = expectDispatchString(
      await dispatchFileCommand(
        { command: "list", zone: "workspace", path: "" },
        ctxWith(envB),
      ),
    );
    const listed = JSON.parse(listOut) as { entries: Array<{ path: string }> };
    expect(
      listed.entries.some((e) => e.path === "m127-shared-list/peer-visible.md"),
    ).toBe(true);

    await deleteArtifactAtPath("m127-shared-list/peer-visible.md", agent1Id, [nsShared]);
  });

  test("M127: AgentB updates artifact authored by AgentA (str_replace) in shared Namespace", async () => {
    // Concrete collaboration test: AgentA writes, AgentB edits in place,
    // AgentA reads the edit. Pre-M127 the str_replace would have failed
    // because `findArtifactByPathForNamespaces` filtered by agentId.
    const envA = envFor({
      agentId: agent1Id,
      readable: [nsShared],
      mutable: [nsShared],
      writable: [nsShared],
    });
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "m127-collab/doc.md",
        content: "initial draft",
      },
      ctxWith(envA),
    );

    const envB = envFor({
      agentId: agent2Id,
      readable: [nsShared],
      mutable: [nsShared],
      writable: [nsShared],
    });
    const replaceOut = await dispatchStageAndApply(
      {
        command: "str_replace",
        zone: "workspace",
        path: "m127-collab/doc.md",
        oldString: "initial",
        newString: "revised",
      },
      ctxWith(envB),
    );
    expect(replaceOut).toMatch(/Applied str_replace/i);

    // AgentA reads AgentB's edit.
    const readOutForA = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "m127-collab/doc.md" },
        ctxWith(envA),
      ),
    );
    expect(readOutForA).toContain("revised draft");

    await deleteArtifactAtPath("m127-collab/doc.md", agent1Id, [nsShared]);
  });

  test("M127: Namespace boundary still holds — AgentB without shared NS cannot see AgentA's artifact", async () => {
    // Negative case: even with the per-row agent partition gone,
    // Namespace remains THE boundary. An agent without the relevant
    // namespace in their envelope still gets nothing.
    const envA = envFor({
      agentId: agent1Id,
      readable: [nsPrivate],
      writable: [nsPrivate],
    });
    await dispatchStageAndApply(
      {
        command: "write",
        zone: "workspace",
        path: "m127-boundary/private.md",
        content: "still namespace-gated",
      },
      ctxWith(envA),
    );

    const envB = envFor({
      agentId: agent2Id,
      readable: [nsShared],
      writable: [nsShared],
    });
    const readOut = expectDispatchString(
      await dispatchFileCommand(
        { command: "read", zone: "workspace", path: "m127-boundary/private.md" },
        ctxWith(envB),
      ),
    );
    expect(readOut).toMatch(/No workspace artifact.*"m127-boundary\/private\.md"/);

    await deleteArtifactAtPath("m127-boundary/private.md", agent1Id, [nsPrivate]);
  });
});
