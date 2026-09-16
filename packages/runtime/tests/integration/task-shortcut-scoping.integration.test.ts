/**
 * M144 — dispatch-seam scoping parity against live Postgres.
 *
 * Ports the M084 (scope) + M137 (wide) scoping assertions to the Phase 3 Task
 * path by calling `dispatchTaskRun` DIRECTLY with a capturing `jobManager`, so
 * we can inspect the exact `memoryAccessEnvelope` + `toolWhitelist` the seam
 * builds for a stored task row — without running the full subagent graph.
 *
 * The envelope BUILDERS themselves (`buildWideEnvelopeForSpeaker`,
 * `createScope`) are covered verbatim by their own M084/M137 suites; this file
 * proves the SEAM wiring (R2/R3/R4):
 *
 *  - S1: `in_scope` (use_scope) → `ScopeMemoryEnvelope` (scope minted+persisted)
 *        and the whitelist is validated at dispatch (R3).
 *  - S2: `in_private_namespace` → wide namespace envelope; `bring_back:true`
 *        threads the calling room's namespace as the primary write target,
 *        `bring_back:false` omits it (R4).
 *  - S3: `in_background` (requester-only) → basic namespace envelope, NOT wide
 *        (the discriminator keys on preset/use_scope, not target_user_ids).
 *  - S4: a bad whitelist is rejected at dispatch (single source of truth).
 *
 * Seeds its own topology (user + user-actor + agent + agent-actor + the
 * speaker's 1:1 private room + a calling room), mirroring
 * `trust/tests/integration/wide-envelope-db.integration.test.ts`.
 */

import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDirectDb,
  ensureDatabase,
  createTask as dbCreateTask,
  getTaskById,
  users,
  actors,
  agents,
  rooms,
  roomMembers,
  groups,
  groupMembers,
  namespaces,
  artifacts,
  artifactNamespaces,
  tasks,
  taskRuns,
  inArray,
  eq,
  type DirectDatabase,
  type NewTask,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { registerAllTools, ToolCatalog, initToolCatalog } from "@nautilo/agent";
import {
  findOrCreateAccessNamespace,
  isScopeMemoryEnvelope,
  PersonalPolicyResolver,
  type MemoryAccessEnvelope,
  type PolicyResolver,
} from "@nautilo/trust";
import { dispatchTaskRun, type TaskJobManager } from "../../src/tasks/dispatch-task-run";
import { createIntegrationStubPolicyResolver } from "./integration-stub-policy";

type TestDb = DirectDatabase & { end: () => Promise<void> };

let db: TestDb;
let userId: string;
let userActorId: string;
let agentId: string;
let agentActorId: string;
let foreignAgentId: string;
let foreignAgentActorId: string;
let privRoomId: string;
let nsPriv: string;
let callingRoomId: string;
let nsCall: string;
// M165 — a second human (peer) for multi-user target-set derivation.
let peerUserId: string;
let peerActorId: string;
let peerHandle: string;
// M165 — a third human, used only to give the calling room a genuine 2-human
// group shape (so it does NOT match the single-user 1:1 private-room lookup
// and is NOT the {user, peer} set S5 mints).
let otherUserId: string;
let otherActorId: string;

const createdTaskIds: string[] = [];
const orphanRoomIds: string[] = [];
const orphanNsIds: string[] = [];
// M165 — rooms minted by `buildEnvelopeForTargetUsers` (shared-namespace
// mint) that aren't otherwise tracked; cleaned up like orphan rooms.
const mintedRoomIds: string[] = [];
const createdArtifactInternalIds: string[] = [];

let catalogReady = false;
let previousAnthropicApiKey: string | undefined;
function ensureCatalog(): void {
  if (catalogReady) return;
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
  catalogReady = true;
}

/**
 * Capturing job manager — records the dispatched job input (envelope +
 * whitelist) and returns a fake job id WITHOUT executing the subagent graph.
 */
function captureJobManager(): {
  jm: TaskJobManager;
  last: () => Record<string, unknown>;
} {
  let captured: Record<string, unknown> | null = null;
  const jm: TaskJobManager = {
    createForegroundJob: (_ownerId, _requestorId, _laneKey, input) => {
      captured = input;
      return Promise.resolve({
        id: `fake-job-${randomUUID()}`,
        virtualJobId: `fake-virtual-${randomUUID()}`,
      } as Awaited<ReturnType<TaskJobManager["createForegroundJob"]>>);
    },
  };
  return {
    jm,
    last: () => {
      if (!captured) throw new Error("no job captured");
      return captured;
    },
  };
}

async function insertTask(overrides: Partial<NewTask>): Promise<string> {
  const row = await dbCreateTask(db, {
    ownerId: userId,
    requestorId: userId,
    agentId,
    prompt: "scoping-parity probe",
    scheduleKind: "now",
    targetChat: "orphan",
    toolsMode: "auto",
    targetUserIds: [userId],
    callingRoomId,
    nextFireAt: new Date(),
    status: "pending",
    ...overrides,
  });
  createdTaskIds.push(row.id);
  return row.id;
}

/** Run the seam directly and return the dispatched envelope + whitelist. */
async function dispatchAndCapture(
  taskId: string,
  resolver: PolicyResolver = createIntegrationStubPolicyResolver(userId),
): Promise<{
  envelope: MemoryAccessEnvelope;
  toolWhitelist: string[] | undefined;
  input: Record<string, unknown>;
}> {
  const task = await getTaskById(db, taskId);
  if (!task) throw new Error(`task ${taskId} missing`);
  const cap = captureJobManager();
  const result = await dispatchTaskRun(task, {
    db,
    jobManager: cap.jm,
    resolver,
    assertInvocation: async () => {},
  });
  // Track the orphan room/namespace the seam created so we can clean up.
  if (result.roomId) orphanRoomIds.push(result.roomId);
  const input = cap.last();
  return {
    envelope: input["memoryAccessEnvelope"] as MemoryAccessEnvelope,
    toolWhitelist: input["toolWhitelist"] as string[] | undefined,
    input,
  };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  process.env["NAUTILO_TEST_MODE"] = "stub";
  previousAnthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "integration-test";
  await ensureDatabase();
  db = createDirectDb(2);
  ensureCatalog();
  const ts = Date.now().toString(36);

  const [u] = await db
    .insert(users)
    .values({
      name: `m144-user`,
      email: `m144-user-${ts}@test.local`,
      handle: `m144u${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("user");
  userId = u.id;

  const [ua] = await db
    .insert(actors)
    .values({ ownerId: userId, displayName: "M144 User", trustState: "verified", kind: "user" })
    .returning({ id: actors.id });
  if (!ua) throw new Error("user actor");
  userActorId = ua.id;

  const [contributorsGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "contributors"))
    .limit(1);
  if (contributorsGroup) {
    await db.insert(groupMembers).values({
      groupId: contributorsGroup.id,
      userId,
      grantedBy: userActorId,
    });
  }

  const [ag] = await db
    .insert(agents)
    .values({ handle: `m144-ag-${ts}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("agent");
  agentId = ag.id;
  const [aga] = await db
    .insert(actors)
    .values({ ownerId: userId, displayName: "M144 Agent mirror", kind: "agent", agentId })
    .returning({ id: actors.id });
  if (!aga) throw new Error("agent actor");
  agentActorId = aga.id;

  // Speaker's 1:1 private room {user, agent} → nsPriv (wide-envelope target).
  const [nsP] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m144-priv-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsP) throw new Error("ns priv");
  nsPriv = nsP.id;
  privRoomId = randomUUID();
  await db.insert(rooms).values({
    id: privRoomId,
    ownerId: userId,
    type: "private",
    label: "Private DM",
    graphThreadId: `room:${privRoomId}`,
    namespaceId: nsPriv,
    humanActorIds: [userActorId],
    kind: "private",
  });
  await db.insert(roomMembers).values([
    { roomId: privRoomId, actorId: userActorId, roomRole: "admin" },
    { roomId: privRoomId, actorId: agentActorId, roomRole: "member" },
  ]);

  // M165 — a third human (`other`) so the calling room is a genuine 2-human
  // group (distinct from the requester's 1:1 private room AND from S5's
  // {user, peer} mint target).
  const [ou] = await db
    .insert(users)
    .values({
      name: `m165-other`,
      email: `m165-other-${ts}@test.local`,
      handle: `m165o${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!ou) throw new Error("other user");
  otherUserId = ou.id;
  const [oa] = await db
    .insert(actors)
    .values({ ownerId: otherUserId, displayName: "M165 Other", trustState: "verified", kind: "user" })
    .returning({ id: actors.id });
  if (!oa) throw new Error("other actor");
  otherActorId = oa.id;

  // D574 — an Agent owned by the other Human. Mara-style requesters may
  // invoke it in the shared calling Room, but they deliberately have no
  // requester↔foreign-Agent private Room.
  const [foreignAgent] = await db
    .insert(agents)
    .values({ handle: `d574-foreign-${ts}` })
    .returning({ id: agents.id });
  if (!foreignAgent) throw new Error("foreign agent");
  foreignAgentId = foreignAgent.id;
  const [foreignAgentActor] = await db
    .insert(actors)
    .values({
      ownerId: otherUserId,
      displayName: "D574 Foreign Agent",
      kind: "agent",
      agentId: foreignAgentId,
    })
    .returning({ id: actors.id });
  if (!foreignAgentActor) throw new Error("foreign agent actor");
  foreignAgentActorId = foreignAgentActor.id;

  // Calling room (where the shortcut was invoked) → nsCall (bring-back target).
  // A genuine 2-human group {user, other} + the agent.
  const [nsC] = await db
    .insert(namespaces)
    .values({ scope: "shared", label: `m144-call-${ts}` })
    .returning({ id: namespaces.id });
  if (!nsC) throw new Error("ns call");
  nsCall = nsC.id;
  callingRoomId = randomUUID();
  await db.insert(rooms).values({
    id: callingRoomId,
    ownerId: userId,
    type: "shared",
    label: "Calling Room",
    graphThreadId: `room:${callingRoomId}`,
    namespaceId: nsCall,
    humanActorIds: [userActorId, otherActorId].sort(),
    kind: "group",
  });
  await db.insert(roomMembers).values([
    { roomId: callingRoomId, actorId: userActorId, roomRole: "admin" },
    { roomId: callingRoomId, actorId: otherActorId, roomRole: "member" },
    { roomId: callingRoomId, actorId: agentActorId, roomRole: "member" },
    { roomId: callingRoomId, actorId: foreignAgentActorId, roomRole: "member" },
  ]);

  // M165 — a peer human (+ user-kind actor) so multi-user target sets resolve.
  peerHandle = `m165p${ts.slice(-6)}`;
  const [pu] = await db
    .insert(users)
    .values({
      name: `m165-peer`,
      email: `m165-peer-${ts}@test.local`,
      handle: peerHandle,
    })
    .returning({ id: users.id });
  if (!pu) throw new Error("peer user");
  peerUserId = pu.id;
  const [pa] = await db
    .insert(actors)
    .values({ ownerId: peerUserId, displayName: "M165 Peer", trustState: "verified", kind: "user" })
    .returning({ id: actors.id });
  if (!pa) throw new Error("peer actor");
  peerActorId = pa.id;
});

afterAll(async () => {
  if (!db) return;
  delete process.env["NAUTILO_TEST_MODE"];
  if (previousAnthropicApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = previousAnthropicApiKey;
  try {
    if (createdTaskIds.length > 0) {
      await db.delete(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
    if (createdArtifactInternalIds.length > 0) {
      await db.delete(artifacts).where(inArray(artifacts.id, createdArtifactInternalIds));
    }
    const allRooms = [
      privRoomId,
      callingRoomId,
      ...orphanRoomIds,
      ...mintedRoomIds,
    ].filter(Boolean);
    // Collect the namespaces of rooms created during dispatch (orphan
    // transcript rooms + M165 minted shared-namespace rooms) before we delete
    // the rooms, so they can be removed too.
    const dispatchCreatedRoomIds = [...orphanRoomIds, ...mintedRoomIds];
    if (dispatchCreatedRoomIds.length > 0) {
      const nsRows = await db
        .select({ namespaceId: rooms.namespaceId })
        .from(rooms)
        .where(inArray(rooms.id, dispatchCreatedRoomIds));
      for (const r of nsRows) orphanNsIds.push(r.namespaceId);
    }
    if (allRooms.length > 0) {
      await db.delete(roomMembers).where(inArray(roomMembers.roomId, allRooms));
      await db.delete(rooms).where(inArray(rooms.id, allRooms));
    }
    // Orphan namespaces created by resolveTargetRoom (label `task:<id>`).
    if (orphanNsIds.length > 0) {
      await db.delete(namespaces).where(inArray(namespaces.id, orphanNsIds));
    }
    for (const ns of [nsPriv, nsCall].filter(Boolean)) {
      await db.delete(namespaces).where(eq(namespaces.id, ns));
    }
    // Ephemeral scopes minted by the scope branch cascade off the agent delete
    // (agent_scopes.parent_agent_id → agents ON DELETE CASCADE).
    if (agentActorId) await db.delete(actors).where(eq(actors.id, agentActorId));
    if (foreignAgentActorId) await db.delete(actors).where(eq(actors.id, foreignAgentActorId));
    if (userId) await db.delete(groupMembers).where(eq(groupMembers.userId, userId));
    if (userActorId) await db.delete(actors).where(eq(actors.id, userActorId));
    if (peerActorId) await db.delete(actors).where(eq(actors.id, peerActorId));
    if (otherActorId) await db.delete(actors).where(eq(actors.id, otherActorId));
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
    if (foreignAgentId) await db.delete(agents).where(eq(agents.id, foreignAgentId));
    if (userId) await db.delete(users).where(eq(users.id, userId));
    if (peerUserId) await db.delete(users).where(eq(users.id, peerUserId));
    if (otherUserId) await db.delete(users).where(eq(users.id, otherUserId));
  } finally {
    await db.end();
  }
});

describe("M144 — dispatch seam scoping parity (live Postgres)", () => {
  test("S1: in_scope → ScopeMemoryEnvelope; ephemeral scope minted + persisted", async () => {
    const taskId = await insertTask({
      preset: "in_scope",
      useScope: true,
      toolsMode: "whitelist",
      toolsWhitelist: ["search_memory"],
    });
    const { envelope, toolWhitelist } = await dispatchAndCapture(taskId);

    expect(isScopeMemoryEnvelope(envelope)).toBe(true);
    if (!isScopeMemoryEnvelope(envelope)) return;
    expect(envelope.scopeId).toBeTruthy();
    expect(envelope.agentId).toBe(agentId);
    // R3: whitelist validated + passed through at dispatch.
    expect(toolWhitelist).toEqual(["search_memory"]);

    // The minted scope is persisted back onto the task row (reuse on re-fire).
    const task = await getTaskById(db, taskId);
    expect(task?.scopeId).toBe(envelope.scopeId);
  });

  test("S1b: scope dispatch inherits the parent's one exact write Namespace", async () => {
    const taskId = await insertTask({
      preset: "in_scope",
      useScope: true,
      toolsMode: "whitelist",
      toolsWhitelist: ["manage_memory"],
    });
    const base = createIntegrationStubPolicyResolver(userId);
    const resolver: PolicyResolver = {
      ...base,
      async buildEnvelope(...args) {
        const envelope = await base.buildEnvelope(...args);
        if (envelope.memoryMode !== "namespace") return envelope;
        return {
          ...envelope,
          readableNamespaces: [nsCall],
          mutableNamespaces: [nsCall],
          writableNamespaces: [nsCall],
        };
      },
    };

    const { envelope } = await dispatchAndCapture(taskId, resolver);

    expect(isScopeMemoryEnvelope(envelope)).toBe(true);
    expect("originWritableNamespaceId" in envelope).toBe(true);
    expect(
      "originWritableNamespaceId" in envelope
        ? envelope.originWritableNamespaceId
        : null,
    ).toBe(nsCall);
  });

  test("S4: in_scope with an out-of-catalog tool → rejected at dispatch", async () => {
    const taskId = await insertTask({
      preset: "in_scope",
      useScope: true,
      toolsMode: "whitelist",
      toolsWhitelist: ["definitely_not_a_tool"],
    });
    const task = await getTaskById(db, taskId);
    const cap = captureJobManager();
    let thrown: Error | null = null;
    try {
      await dispatchTaskRun(task!, {
        db,
        jobManager: cap.jm,
        resolver: createIntegrationStubPolicyResolver(userId),
        assertInvocation: async () => {},
      });
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/whitelist rejected/i);
  });

  test("S2: in_private_namespace + bring_back:true → wide envelope, calling room NS is primary write target", async () => {
    const taskId = await insertTask({
      preset: "in_private_namespace",
      useScope: false,
      toolsMode: "auto",
      metadata: { bringBack: true },
    });
    const { envelope } = await dispatchAndCapture(taskId);

    expect(isScopeMemoryEnvelope(envelope)).toBe(false);
    if (isScopeMemoryEnvelope(envelope)) return;
    // Wide envelope reaches the speaker's private NS…
    expect(envelope.readableNamespaces).toContain(nsPriv);
    // …and bring_back makes the calling room's NS the primary write target.
    expect(envelope.writableNamespaces[0]).toBe(nsCall);
    expect(envelope.writableNamespaces).toContain(nsPriv);
  });

  test("S2: in_private_namespace + bring_back:false → wide envelope, NO return namespace", async () => {
    const taskId = await insertTask({
      preset: "in_private_namespace",
      useScope: false,
      toolsMode: "auto",
      metadata: { bringBack: false },
    });
    const { envelope } = await dispatchAndCapture(taskId);

    expect(isScopeMemoryEnvelope(envelope)).toBe(false);
    if (isScopeMemoryEnvelope(envelope)) return;
    expect(envelope.readableNamespaces).toContain(nsPriv);
    // Pure private excursion: only the private NS is writable; calling room NS
    // is NOT threaded as a write target.
    expect(envelope.writableNamespaces).toEqual([nsPriv]);
    expect(envelope.writableNamespaces).not.toContain(nsCall);
  });

  test("S3 (M165): in_background (requester-only) → requester's OWN namespace (the bug fix)", async () => {
    const taskId = await insertTask({
      preset: "in_background",
      useScope: false,
      toolsMode: "auto",
    });
    const { envelope } = await dispatchAndCapture(taskId);

    expect(isScopeMemoryEnvelope(envelope)).toBe(false);
    if (isScopeMemoryEnvelope(envelope)) return;
    // M165 — the run derives its namespace from the target-users set
    // (`[requester]`) instead of the (empty) orphan transcript room. The
    // requester's own 1:1 private namespace is now the write target, so
    // `file.write zone:"workspace"` succeeds (was previously empty → broken).
    expect(envelope.writableNamespaces).toEqual([nsPriv]);
    expect(envelope.readableNamespaces).toContain(nsPriv);
    // Namespace branch, not scope: no ephemeral scope minted.
    const task = await getTaskById(db, taskId);
    expect(task?.scopeId).toBeNull();
  });

  test("D574: requester-only background task through a foreign Agent uses the authorized calling Room", async () => {
    const taskId = await insertTask({
      agentId: foreignAgentId,
      preset: "in_background",
      useScope: false,
      toolsMode: "auto",
    });
    // Exercise the production resolver shape. Ordinary namespace envelopes
    // intentionally omit `memoryMode` for checkpoint compatibility; the old
    // D574 guard compared it directly to "namespace", so only the explicit
    // mock shape passed while this real shape fell back to an empty envelope.
    const resolver = new PersonalPolicyResolver(userId, foreignAgentId);

    const { envelope } = await dispatchAndCapture(taskId, resolver);
    expect(isScopeMemoryEnvelope(envelope)).toBe(false);
    if (isScopeMemoryEnvelope(envelope)) return;
    expect(envelope.memoryMode).toBeUndefined();
    expect(envelope.agentId).toBe(foreignAgentId);
    expect(envelope.roomId).toBe(callingRoomId);
    expect(envelope.writableNamespaces).toEqual([nsCall]);
    expect(envelope.readableNamespaces).toContain(nsCall);
  });

  test("S5 (M165): two-user target with no shared room → mints a shared namespace, then reuses it", async () => {
    const t1 = await insertTask({
      preset: "task",
      useScope: false,
      toolsMode: "auto",
      targetUserIds: [userId, peerUserId],
    });
    const { envelope: e1 } = await dispatchAndCapture(t1);
    expect(isScopeMemoryEnvelope(e1)).toBe(false);
    if (isScopeMemoryEnvelope(e1)) return;

    // A brand-new shared namespace (distinct from the requester's private +
    // the calling-room namespaces) is the single write target.
    expect(e1.writableNamespaces).toHaveLength(1);
    const shared = e1.writableNamespaces[0]!;
    expect(shared).not.toBe(nsPriv);
    expect(shared).not.toBe(nsCall);
    expect(e1.readableNamespaces).toContain(shared);
    expect(e1.roomId).toBeTruthy();
    mintedRoomIds.push(e1.roomId);

    // The minted room carries exactly {requester, peer} as its human set and
    // owns the shared namespace.
    const [mintedRoom] = await db
      .select({ humanActorIds: rooms.humanActorIds, namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, e1.roomId));
    expect(mintedRoom?.namespaceId).toBe(shared);
    expect([...(mintedRoom?.humanActorIds ?? [])].sort()).toEqual(
      [userActorId, peerActorId].sort(),
    );

    // A SECOND dispatch with the same target set (order-independent) REUSES the
    // shared namespace rather than minting a second one.
    const t2 = await insertTask({
      preset: "task",
      useScope: false,
      toolsMode: "auto",
      targetUserIds: [peerUserId, userId],
    });
    const { envelope: e2 } = await dispatchAndCapture(t2);
    expect(isScopeMemoryEnvelope(e2)).toBe(false);
    if (isScopeMemoryEnvelope(e2)) return;
    expect(e2.writableNamespaces).toEqual([shared]);
    expect(e2.roomId).toBe(e1.roomId);
  });

  test("S6 (M165): ask_peer namespace = requester+peer shared NS, NOT the agent↔peer DM NS", async () => {
    const taskId = await insertTask({
      preset: "ask_peer",
      useScope: false,
      toolsMode: "none",
      targetChat: "last_dm",
      targetChatHandle: `@${peerHandle}`,
      awaitResponse: true,
      // The requester is element 0; `resolveDm` appends the peer at dispatch.
      targetUserIds: [userId],
    });
    const { envelope } = await dispatchAndCapture(taskId);
    expect(isScopeMemoryEnvelope(envelope)).toBe(false);
    if (isScopeMemoryEnvelope(envelope)) return;

    // The transcript lands in the agent↔peer DM room (memoized on the task).
    const task = await getTaskById(db, taskId);
    const dmRoomId = task?.targetRoomId;
    expect(dmRoomId).toBeTruthy();
    const [dmRoom] = await db
      .select({ namespaceId: rooms.namespaceId, humanActorIds: rooms.humanActorIds })
      .from(rooms)
      .where(eq(rooms.id, dmRoomId!));
    // The DM room has exactly the PEER as its human (the requester is not a member).
    expect([...(dmRoom?.humanActorIds ?? [])]).toEqual([peerActorId]);

    // …but the run's NAMESPACE is the {requester, peer} shared namespace — NOT
    // the DM room's namespace. (Reuses the {user, peer} room minted in S5.)
    expect(envelope.writableNamespaces).toHaveLength(1);
    expect(envelope.writableNamespaces[0]).not.toBe(dmRoom?.namespaceId);
    // The namespace source room carries exactly {requester, peer} as humans.
    const [nsRoom] = await db
      .select({ humanActorIds: rooms.humanActorIds })
      .from(rooms)
      .where(eq(rooms.id, envelope.roomId));
    expect([...(nsRoom?.humanActorIds ?? [])].sort()).toEqual(
      [userActorId, peerActorId].sort(),
    );
  });

  test("S7 (D570): ask_peer attaches the exact-granted Artifact to the peer DM and stamps card context", async () => {
    // Model the shortcut's hidden exact requester↔peer access grant. It is
    // infrastructure, not a Human-created conversation Room.
    const exactAccess = await findOrCreateAccessNamespace(
      [userActorId, peerActorId],
      {
        requesterUserId: userId,
        requesterActorId: userActorId,
        label: "D570 exact Artifact access",
      },
    );
    if (exactAccess.minted) mintedRoomIds.push(exactAccess.roomId);

    const externalArtifactId = `d570-${randomUUID()}`;
    const [artifact] = await db.insert(artifacts).values({
      artifactId: externalArtifactId,
      path: "drafts/rook-malik-plan.md",
      mimeType: "text/markdown",
      size: 57,
      storageUri: `file:///tmp/${externalArtifactId}.md`,
    }).returning({ id: artifacts.id });
    if (!artifact) throw new Error("artifact");
    createdArtifactInternalIds.push(artifact.id);
    await db.insert(artifactNamespaces).values({
      artifactId: artifact.id,
      namespaceId: exactAccess.namespaceId,
    });

    const taskId = await insertTask({
      preset: "ask_peer",
      useScope: false,
      toolsMode: "none",
      targetChat: "last_dm",
      targetChatHandle: `@${peerHandle}`,
      awaitResponse: true,
      targetUserIds: [userId],
      metadata: {
        artifactAwareAskPeer: true,
        artifactOperationId: `test:${externalArtifactId}`,
        artifactRefs: [{
          artifactId: externalArtifactId,
          path: "untrusted-stale.md",
          mimeType: "text/plain",
          size: 1,
        }],
      },
    });
    const { input } = await dispatchAndCapture(taskId);
    const task = await getTaskById(db, taskId);
    const [dmRoom] = await db.select({ namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.id, task!.targetRoomId!));
    expect(dmRoom?.namespaceId).toBeTruthy();
    const dmAttachments = await db.select({ namespaceId: artifactNamespaces.namespaceId })
      .from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, artifact.id));
    expect(dmAttachments.map((row) => row.namespaceId)).toContain(dmRoom!.namespaceId);
    expect(input["artifactRefs"]).toEqual([{
      artifactId: externalArtifactId,
      path: "drafts/rook-malik-plan.md",
      mimeType: "text/markdown",
      size: 57,
    }]);
    expect(input["assistantArtifactExternalIds"]).toEqual([externalArtifactId]);
    expect(input["focusedResources"]).toMatchObject([{
      kind: "workspace-artifact",
      displayName: "rook-malik-plan.md",
      locator: { artifactId: externalArtifactId },
    }]);
  });
});
