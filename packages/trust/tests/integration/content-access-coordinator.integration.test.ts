import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetSharedDirectDbForTests,
  and,
  artifacts,
  artifactNamespaces,
  capabilities,
  contentAccessOperations,
  createDirectDb,
  encryptionTransitionPolicy,
  ensureDatabase,
  eq,
  groupMembers,
  groupRoles,
  groups,
  inArray,
  memories,
  memoryNamespaces,
  namespaces,
  roleCapabilities,
  roles,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  sql,
  users,
  actors,
  agents,
  type Database,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createContentAccessCoordinator,
  type CommittedArtifactShareEffect,
  type ContentAccessAdmission,
  type ContentAccessCommand,
  type ContentAccessPreparation,
} from "../../src/content-access-coordinator";
import { createContentAccessPreviewCodec } from "../../src/content-access-preview";
import { insertPrivateRoomBundleTx, removeRoomMember } from "../../src/queries";

const REQUIRED_INSTANCE = "m323-artifacts-3243cdfa";
const requestedInstance = process.env["NAUTILO_INSTANCE_ID"]?.trim();
if (requestedInstance !== REQUIRED_INSTANCE) {
  throw new Error(
    `M323 coordinator integration requires NAUTILO_INSTANCE_ID=${REQUIRED_INSTANCE}; received ${requestedInstance || "unset"}`,
  );
}
const routedInstance = bootstrapTestDbInstance();
if (routedInstance !== REQUIRED_INSTANCE) {
  throw new Error(`M323 coordinator integration was routed to ${routedInstance}`);
}

type PersonKey = "a" | "b" | "c" | "d";
type Person = Readonly<{ userId: string; actorId: string }>;
type Fixture = Readonly<{
  people: Readonly<Record<PersonKey, Person>>;
  sourceRoomId: string;
  sourceNamespaceId: string;
  targetRoomId: string;
  targetNamespaceId: string;
  memoryId: string;
  artifactId: string;
  roleId: string;
  groupId: string;
  agentId: string;
  agentActorId: string;
}>;

let db: Database;
let fixture: Fixture | undefined;
let rejectObserver = false;
const shareObservations: Array<Readonly<{
  effect: CommittedArtifactShareEffect;
  attachmentNamespaceIds: readonly string[];
}>> = [];

const coordinator = createContentAccessCoordinator(
  createContentAccessPreviewCodec(new Uint8Array(32).fill(42)),
  {
    observeCommittedArtifactShares: async (effect) => {
      // This is deliberately the fixture's separate direct handle, not the
      // coordinator transaction. Seeing the new junction here proves the
      // observer runs only after that business transaction commits.
      const attachmentNamespaceIds = await db.select({ id: artifactNamespaces.namespaceId })
        .from(artifactNamespaces)
        .where(eq(artifactNamespaces.artifactId, effect.artifactId));
      shareObservations.push(Object.freeze({
        effect,
        attachmentNamespaceIds: Object.freeze(attachmentNamespaceIds.map((row) => row.id).sort()),
      }));
      if (rejectObserver) throw new Error("injected post-commit observer failure");
    },
  },
);

function sorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const expected = sorted(right);
  return left.length === expected.length && sorted(left).every((id, index) => id === expected[index]);
}

function admissionFor(current: Fixture): ContentAccessAdmission {
  return {
    principal: {
      kind: "human",
      userId: current.people.a.userId,
      actorId: current.people.a.actorId,
      sourceRoomId: current.sourceRoomId,
    },
    audienceContract: "invoking_room",
    approvalContext: "m322-integration-approved-human-action",
  };
}

function command(
  current: Fixture,
  objectKind: "memory" | "artifact",
  operationId: string,
  change: ContentAccessCommand["change"],
): ContentAccessCommand {
  return {
    operationId,
    object: {
      kind: objectKind,
      id: objectKind === "memory" ? current.memoryId : current.artifactId,
    },
    change,
  };
}

function prepared(
  result: Awaited<ReturnType<typeof coordinator.prepare>>,
): ContentAccessPreparation {
  if (result.outcome !== "prepared") {
    throw new Error(`Expected prepared access change; received ${result.outcome}`);
  }
  return result;
}

async function createFixture(): Promise<Fixture> {
  return db.transaction(async (tx) => {
    const suffix = randomUUID();
    const peopleEntries: Array<readonly [PersonKey, Person]> = [];
    for (const key of ["a", "b", "c", "d"] as const) {
      const [user] = await tx.insert(users).values({
        name: `M322 coordinator ${key.toUpperCase()} ${suffix}`,
        handle: `m322-${key}-${suffix}`,
      }).returning({ id: users.id });
      if (!user) throw new Error(`M322 ${key} user fixture was not created`);
      const [actor] = await tx.insert(actors).values({
        ownerId: user.id,
        displayName: `M322 ${key.toUpperCase()}`,
        kind: "user",
      }).returning({ id: actors.id });
      if (!actor) throw new Error(`M322 ${key} actor fixture was not created`);
      peopleEntries.push([key, { userId: user.id, actorId: actor.id }]);
    }
    const people = Object.fromEntries(peopleEntries) as Record<PersonKey, Person>;
    const [agent] = await tx.insert(agents).values({
      handle: `m323-coordinator-agent-${suffix}`,
    }).returning({ id: agents.id });
    if (!agent) throw new Error("M323 Agent fixture was not created");
    const [agentActor] = await tx.insert(actors).values({
      ownerId: people.a.userId,
      displayName: "M323 coordinator Agent",
      kind: "agent",
      agentId: agent.id,
    }).returning({ id: actors.id });
    if (!agentActor) throw new Error("M323 Agent Actor fixture was not created");

    const capabilityRows = await tx.select({ id: capabilities.id, slug: capabilities.slug })
      .from(capabilities)
      .where(inArray(capabilities.slug, ["manage_memories", "write_artifacts", "use_share_artifact"]));
    const capabilityBySlug = new Map(capabilityRows.map((row) => [row.slug, row.id]));
    const manageMemories = capabilityBySlug.get("manage_memories");
    const writeArtifacts = capabilityBySlug.get("write_artifacts");
    const useShareArtifact = capabilityBySlug.get("use_share_artifact");
    if (!manageMemories || !writeArtifacts || !useShareArtifact) {
      throw new Error("M323 clone is missing ordinary content-access capability seeds");
    }
    const [role] = await tx.insert(roles).values({
      slug: `m322-coordinator-${suffix}`,
      label: `M322 coordinator ${suffix}`,
      isSystem: false,
    }).returning({ id: roles.id });
    if (!role) throw new Error("M322 role fixture was not created");
    const [group] = await tx.insert(groups).values({
      ownerId: people.a.userId,
      isSystem: false,
      type: `m322-coordinator-${suffix}`,
      label: `M322 coordinator ${suffix}`,
      trustPreset: "personal",
    }).returning({ id: groups.id });
    if (!group) throw new Error("M322 group fixture was not created");
    await tx.insert(roleCapabilities).values([
      { roleId: role.id, capabilityId: manageMemories },
      { roleId: role.id, capabilityId: writeArtifacts },
      { roleId: role.id, capabilityId: useShareArtifact },
    ]);
    await tx.insert(groupRoles).values({ groupId: group.id, roleId: role.id });
    await tx.insert(groupMembers).values({
      groupId: group.id,
      userId: people.a.userId,
      grantedBy: people.a.actorId,
    });

    const sourceRoomId = randomUUID();
    const { namespaceId: sourceNamespaceId } = await insertPrivateRoomBundleTx(tx, {
      roomId: sourceRoomId,
      ownerUserId: people.a.userId,
      createdByActorId: people.a.actorId,
      label: `M322 source ${suffix}`,
      graphThreadId: `m322-source:${suffix}`,
      humanActorIds: sorted([people.a.actorId, people.b.actorId]),
      roomKind: "group",
      roomType: "shared",
      memberRows: [
        { actorId: people.a.actorId, roomRole: "admin" },
        { actorId: people.b.actorId, roomRole: "member" },
        { actorId: agentActor.id, roomRole: "member", agentResponseMode: "active" },
      ],
    });
    const targetRoomId = randomUUID();
    const { namespaceId: targetNamespaceId } = await insertPrivateRoomBundleTx(tx, {
      roomId: targetRoomId,
      ownerUserId: people.a.userId,
      createdByActorId: people.a.actorId,
      label: `M323 target ${suffix}`,
      graphThreadId: `m323-target:${suffix}`,
      humanActorIds: sorted([people.a.actorId, people.c.actorId, people.d.actorId]),
      roomKind: "group",
      roomType: "shared",
      memberRows: [
        { actorId: people.a.actorId, roomRole: "admin" },
        { actorId: people.c.actorId, roomRole: "member" },
        { actorId: people.d.actorId, roomRole: "member" },
      ],
    });

    const [memory] = await tx.insert(memories).values({
      content: `M322 memory ${suffix}`,
      type: "general",
    }).returning({ id: memories.id });
    if (!memory) throw new Error("M322 Memory fixture was not created");
    await tx.insert(memoryNamespaces).values({
      memoryId: memory.id,
      namespaceId: sourceNamespaceId,
    });

    const [artifact] = await tx.insert(artifacts).values({
      artifactId: randomUUID(),
      path: `m322/${suffix}.txt`,
      mimeType: "text/plain",
      size: 17,
      storageUri: `file:///m322-coordinator/${suffix}.txt`,
    }).returning({ id: artifacts.id });
    if (!artifact) throw new Error("M322 Artifact fixture was not created");
    await tx.insert(artifactNamespaces).values({
      artifactId: artifact.id,
      namespaceId: sourceNamespaceId,
    });

    return {
      people,
      sourceRoomId,
      sourceNamespaceId,
      targetRoomId,
      targetNamespaceId,
      memoryId: memory.id,
      artifactId: artifact.id,
      roleId: role.id,
      groupId: group.id,
      agentId: agent.id,
      agentActorId: agentActor.id,
    };
  });
}

async function accessRoomsFor(current: Fixture) {
  return db.select({
    id: rooms.id,
    namespaceId: rooms.namespaceId,
    humanActorIds: rooms.humanActorIds,
  }).from(rooms).where(and(
    eq(rooms.ownerId, current.people.a.userId),
    eq(rooms.kind, "access"),
  ));
}

async function attachmentIds(kind: "memory" | "artifact", current: Fixture): Promise<string[]> {
  const rows = kind === "memory"
    ? await db.select({ id: memoryNamespaces.namespaceId }).from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, current.memoryId))
    : await db.select({ id: artifactNamespaces.namespaceId }).from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, current.artifactId));
  return rows.map((row) => row.id).sort();
}

async function cleanupFixture(current: Fixture): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(memories).where(eq(memories.id, current.memoryId));
    await tx.delete(artifacts).where(eq(artifacts.id, current.artifactId));

    const ownedRooms = await tx.select({ id: rooms.id, namespaceId: rooms.namespaceId })
      .from(rooms)
      .where(eq(rooms.ownerId, current.people.a.userId));
    if (ownedRooms.length) {
      const roomIds = ownedRooms.map((room) => room.id);
      const fixtureSessions = tx.select({ id: sessions.id }).from(sessions).where(inArray(sessions.roomId, roomIds));
      await tx.delete(sessionMessages).where(inArray(sessionMessages.sessionId, fixtureSessions));
      await tx.delete(sessions).where(inArray(sessions.roomId, roomIds));
      await tx.delete(roomMembers).where(inArray(roomMembers.roomId, roomIds));
      await tx.delete(rooms).where(inArray(rooms.id, roomIds));
      await tx.delete(namespaces).where(inArray(namespaces.id,
        [...new Set(ownedRooms.map((room) => room.namespaceId))]));
    }

    await tx.delete(groups).where(eq(groups.id, current.groupId));
    await tx.delete(roles).where(eq(roles.id, current.roleId));
    await tx.delete(agents).where(eq(agents.id, current.agentId));
    await tx.delete(users).where(inArray(users.id,
      Object.values(current.people).map((person) => person.userId)));
  });
}

beforeAll(async () => {
  await ensureDatabase();
  db = createDirectDb(1);
  const [policy] = await db.select({ mode: encryptionTransitionPolicy.mode })
    .from(encryptionTransitionPolicy)
    .limit(1);
  if (policy?.mode !== "plaintext_only") {
    throw new Error(`M323 coordinator integration requires plaintext_only; received ${policy?.mode ?? "missing"}`);
  }
}, 120_000);

beforeEach(async () => {
  rejectObserver = false;
  shareObservations.length = 0;
  fixture = await createFixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current) await cleanupFixture(current);
});

afterAll(async () => {
  await db?.end({ timeout: 1 });
  await __resetSharedDirectDbForTests();
});

describe("M322/M323 ordinary content access coordinator", () => {
  test("fresh person sharing is observed after commit with selected Actors, while no-op and replay stay silent", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const operationId = randomUUID();
    const request = command(current, "artifact", operationId, {
      kind: "grant_people",
      selectedActorIds: [current.people.d.actorId, current.people.c.actorId, current.people.d.actorId],
    });
    const preview = prepared(await coordinator.prepare(admission, request));

    expect(await coordinator.commit(admission, request, preview.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(shareObservations).toHaveLength(1);
    expect(shareObservations[0]!.effect).toEqual({
      operationId,
      requester: {
        kind: "human",
        userId: current.people.a.userId,
        actorId: current.people.a.actorId,
      },
      artifactId: current.artifactId,
      target: {
        kind: "people",
        personActorIds: sorted([current.people.c.actorId, current.people.d.actorId]),
      },
    });
    const freshAccess = (await accessRoomsFor(current)).find((room) => sameIds(room.humanActorIds, [
      current.people.a.actorId,
      current.people.b.actorId,
      current.people.c.actorId,
      current.people.d.actorId,
    ]));
    expect(freshAccess).toBeDefined();
    expect(shareObservations[0]!.attachmentNamespaceIds).toContain(freshAccess!.namespaceId);

    expect(await coordinator.commit(admission, request, preview.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: false, replayed: true });
    const noOpRequest = { ...request, operationId: randomUUID() };
    const noOpPreview = prepared(await coordinator.prepare(admission, noOpRequest));
    expect(await coordinator.commit(admission, noOpRequest, noOpPreview.previewToken))
      .toMatchObject({ outcome: "already_applied", stateChanged: false, replayed: false });
    expect(shareObservations).toHaveLength(1);
  });

  test("fresh Room sharing is observed only after its exact selected Namespace attachment commits", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const operationId = randomUUID();
    const request = command(current, "artifact", operationId, {
      kind: "grant_room",
      targetRoomId: current.targetRoomId,
    });
    const preview = prepared(await coordinator.prepare(admission, request));

    expect(await coordinator.commit(admission, request, preview.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(shareObservations).toEqual([{
      effect: {
        operationId,
        requester: {
          kind: "human",
          userId: current.people.a.userId,
          actorId: current.people.a.actorId,
        },
        artifactId: current.artifactId,
        target: { kind: "room", roomId: current.targetRoomId },
      },
      attachmentNamespaceIds: sorted([current.sourceNamespaceId, current.targetNamespaceId]),
    }]);
  });

  test("Agent sharing retains its distinct Agent and Human authority identities", async () => {
    const current = fixture!;
    const admission: ContentAccessAdmission = {
      ...admissionFor(current),
      principal: {
        kind: "agent",
        userId: current.people.a.userId,
        actorId: current.people.a.actorId,
        agentId: current.agentId,
        sourceRoomId: current.sourceRoomId,
      },
    };
    const operationId = randomUUID();
    const request = command(current, "artifact", operationId, {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    });
    const preview = prepared(await coordinator.prepare(admission, request));

    expect(await coordinator.commit(admission, request, preview.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(shareObservations).toHaveLength(1);
    expect(shareObservations[0]!.effect).toEqual({
      operationId,
      requester: {
        kind: "agent",
        userId: current.people.a.userId,
        actorId: current.people.a.actorId,
        agentId: current.agentId,
      },
      artifactId: current.artifactId,
      target: { kind: "people", personActorIds: [current.people.c.actorId] },
    });
    expect(current.people.a.actorId).not.toBe(current.agentActorId);
    expect(current.people.a.actorId).not.toBe(current.agentId);
  });

  test("a failing post-commit observer leaves the applied Artifact grant and receipt intact", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const operationId = randomUUID();
    const request = command(current, "artifact", operationId, {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    });
    const preview = prepared(await coordinator.prepare(admission, request));
    rejectObserver = true;

    expect(await coordinator.commit(admission, request, preview.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(shareObservations).toHaveLength(1);
    expect(await attachmentIds("artifact", current)).toHaveLength(2);
    expect(await db.select({ outcome: contentAccessOperations.outcome })
      .from(contentAccessOperations)
      .where(eq(contentAccessOperations.operationId, operationId)))
      .toEqual([{ outcome: "applied" }]);
  });

  test("frozen Human Artifact sharing observes the same fresh committed effect without changing its DTO", async () => {
    const current = fixture!;
    const admission: ContentAccessAdmission = {
      ...admissionFor(current), audienceContract: "legacy_personal_grant",
    };
    const input = {
      object: { kind: "artifact" as const, id: current.artifactId },
      change: { kind: "grant_people" as const, selectedActorIds: [current.people.c.actorId] },
    };

    const result = await coordinator.executeLegacyHuman(admission, input);

    expect(result).toMatchObject({ kind: "completed", receipt: { outcome: "applied" } });
    if (!("kind" in result) || result.kind !== "completed") throw new Error("Missing legacy details");
    expect(Object.keys(result.details).sort()).toEqual(["accounting", "destinations"]);
    expect(shareObservations).toHaveLength(1);
    expect(shareObservations[0]!.effect).toMatchObject({
      operationId: result.receipt.operationId,
      requester: { kind: "human", userId: current.people.a.userId, actorId: current.people.a.actorId },
      artifactId: current.artifactId,
      target: { kind: "people", personActorIds: [current.people.c.actorId] },
    });
  });

  for (const competingMutation of ["source authority", "Artifact revision"] as const) {
    test(`commit waits for ${competingMutation} lock and rejects the stale preview after release`, async () => {
      const current = fixture!;
      const admission = admissionFor(current);
      const request = command(current, "artifact", randomUUID(), {
        kind: "grant_people", selectedActorIds: [current.people.c.actorId],
      });
      const preview = prepared(await coordinator.prepare(admission, request));
      let publication: ReturnType<typeof coordinator.commit> | undefined;
      try {
        await db.transaction(async (tx) => {
          const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::integer AS pid`);
          if (!backend) throw new Error("Missing fixture backend");
          if (competingMutation === "source authority") {
            await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, current.sourceRoomId)).for("update");
          } else {
            await tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, current.artifactId)).for("update");
          }
          publication = coordinator.commit(admission, request, preview.previewToken);
          // Observe a real PostgreSQL wait on this exact fixture connection;
          // a timer alone would not prove that the contending path reached it.
          const deadline = Date.now() + 5_000;
          let blocked = false;
          while (Date.now() < deadline) {
            const [activity] = await tx.execute<{ blocked: boolean }>(sql`
              SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                WHERE ${backend.pid} = ANY(pg_blocking_pids(pid))) AS blocked
            `);
            if (activity?.blocked) { blocked = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          if (!blocked) throw new Error("Sharing did not reach the expected PostgreSQL lock");
          if (competingMutation === "source authority") {
            await tx.update(rooms).set({ namespaceAccessRevision: sql`${rooms.namespaceAccessRevision} + 1` })
              .where(eq(rooms.id, current.sourceRoomId));
          } else {
            await tx.update(artifacts).set({ revision: sql`${artifacts.revision} + 1`, path: "changed-during-lock.txt" })
              .where(eq(artifacts.id, current.artifactId));
          }
        });
        expect(await publication).toMatchObject({ outcome: "stale", stateChanged: false });
        expect(await accessRoomsFor(current)).toHaveLength(0);
        expect(await attachmentIds("artifact", current)).toEqual([current.sourceNamespaceId]);
      } finally {
        // Let any pending coordinator transaction settle after the blocker
        // releases before the fixture's exact cleanup can delete its rows.
        await publication;
      }
    }, 15_000);
  }

  test("canonical membership removal invalidates both old audiences and fresh preparation uses the new roster", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const requests = (["memory", "artifact"] as const).map((kind) => command(current, kind, randomUUID(), {
      kind: "grant_people", selectedActorIds: [current.people.c.actorId],
    }));
    const previews = await Promise.all(requests.map(async (request) => prepared(await coordinator.prepare(admission, request))));
    await removeRoomMember(current.sourceRoomId, current.people.b.actorId, {});
    for (const [index, request] of requests.entries()) {
      expect(await coordinator.commit(admission, request, previews[index]!.previewToken))
        .toMatchObject({ outcome: "stale", stateChanged: false });
    }
    expect(await accessRoomsFor(current)).toHaveLength(0);
    expect(await attachmentIds("memory", current)).toEqual([current.sourceNamespaceId]);
    expect(await attachmentIds("artifact", current)).toEqual([current.sourceNamespaceId]);
    const fresh = prepared(await coordinator.prepare(admission, {
      ...requests[0]!, operationId: randomUUID(),
    }));
    expect(sorted(fresh.preview.humanActorIds)).toEqual(sorted([current.people.a.actorId, current.people.c.actorId]));
    expect(await coordinator.commit(admission, fresh.command, fresh.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true });
    const accessRooms = await accessRoomsFor(current);
    expect(accessRooms).toHaveLength(1);
    expect(sorted(accessRooms[0]!.humanActorIds)).toEqual(sorted([current.people.a.actorId, current.people.c.actorId]));
  });

  test("frozen Human execution retains A+C and returns real destination facts without a preview", async () => {
    const current = fixture!;
    const admission: ContentAccessAdmission = {
      ...admissionFor(current), audienceContract: "legacy_personal_grant",
    };
    const input = {
      object: { kind: "memory" as const, id: current.memoryId },
      change: { kind: "grant_people" as const, selectedActorIds: [current.people.c.actorId] },
    };
    const result = await coordinator.executeLegacyHuman(admission, input);
    expect(result).toMatchObject({ kind: "completed", receipt: { outcome: "applied" } });
    if (!("kind" in result) || result.kind !== "completed") throw new Error("Missing legacy details");
    expect(result.details.destinations).toHaveLength(1);
    expect(result.details.destinations[0]).toMatchObject({ minted: true, label: "Shared access" });
    const accessRooms = await accessRoomsFor(current);
    expect(accessRooms).toHaveLength(1);
    expect(sorted(accessRooms[0]!.humanActorIds))
      .toEqual(sorted([current.people.a.actorId, current.people.c.actorId]));
    expect(await attachmentIds("memory", current))
      .toEqual(sorted([current.sourceNamespaceId, accessRooms[0]!.namespaceId]));
    const retry = await coordinator.executeLegacyHuman(admission, input);
    expect(retry).toMatchObject({ kind: "completed", receipt: { outcome: "already_applied" } });
    if (!("kind" in retry) || retry.kind !== "completed") throw new Error("Missing legacy retry details");
    expect(retry.details.destinations[0]).toMatchObject({ minted: false, namespaceId: accessRooms[0]!.namespaceId });
    expect(await accessRoomsFor(current)).toHaveLength(1);
    expect(shareObservations).toEqual([]);
  });

  test("prepare writes no access Room or terminal receipt", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const memoryOperationId = randomUUID();
    const artifactOperationId = randomUUID();
    expect(await accessRoomsFor(current)).toEqual([]);

    prepared(await coordinator.prepare(admission, command(current, "memory", memoryOperationId, {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    })));
    prepared(await coordinator.prepare(admission, command(current, "artifact", artifactOperationId, {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    })));

    expect(await accessRoomsFor(current)).toEqual([]);
    expect(await db.select({ id: contentAccessOperations.operationId })
      .from(contentAccessOperations)
      .where(inArray(contentAccessOperations.operationId, [memoryOperationId, artifactOperationId])))
      .toEqual([]);
  });

  test("A+B to C preserves ordinary Memory and Artifact identity", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const [memoryBefore] = await db.select().from(memories).where(eq(memories.id, current.memoryId));
    const [artifactBefore] = await db.select().from(artifacts).where(eq(artifacts.id, current.artifactId));
    const memoryCommand = command(current, "memory", randomUUID(), {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    });
    const artifactCommand = command(current, "artifact", randomUUID(), {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    });
    const memoryPreparation = prepared(await coordinator.prepare(admission, memoryCommand));
    const artifactPreparation = prepared(await coordinator.prepare(admission, artifactCommand));

    expect(await coordinator.commit(admission, memoryCommand, memoryPreparation.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(await coordinator.commit(admission, artifactCommand, artifactPreparation.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });

    expect((await db.select().from(memories).where(eq(memories.id, current.memoryId)))[0])
      .toEqual(memoryBefore);
    expect((await db.select().from(artifacts).where(eq(artifacts.id, current.artifactId)))[0])
      .toEqual(artifactBefore);
    const expectedAudience = sorted([
      current.people.a.actorId,
      current.people.b.actorId,
      current.people.c.actorId,
    ]);
    const accessRooms = (await accessRoomsFor(current))
      .filter((room) => sameIds(room.humanActorIds, expectedAudience));
    expect(accessRooms).toHaveLength(1);
    const destinationNamespaceId = accessRooms[0]!.namespaceId;
    expect(await attachmentIds("memory", current))
      .toEqual(sorted([current.sourceNamespaceId, destinationNamespaceId]));
    expect(await attachmentIds("artifact", current))
      .toEqual(sorted([current.sourceNamespaceId, destinationNamespaceId]));
    expect(shareObservations.map((observation) => observation.effect.artifactId))
      .toEqual([current.artifactId]);
  });

  test("separately prepared C and D grants remain ABC and ABD, never ABCD", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const cCommand = command(current, "artifact", randomUUID(), {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    });
    const dCommand = command(current, "artifact", randomUUID(), {
      kind: "grant_people",
      selectedActorIds: [current.people.d.actorId],
    });
    const [cPreparation, dPreparation] = await Promise.all([
      coordinator.prepare(admission, cCommand).then(prepared),
      coordinator.prepare(admission, dCommand).then(prepared),
    ]);
    const results = await Promise.all([
      coordinator.commit(admission, cCommand, cPreparation.previewToken),
      coordinator.commit(admission, dCommand, dPreparation.previewToken),
    ]);
    expect(results.map((result) => result.outcome)).toEqual(["applied", "applied"]);

    const audiences = (await accessRoomsFor(current)).map((room) => sorted(room.humanActorIds));
    const abc = sorted([current.people.a.actorId, current.people.b.actorId, current.people.c.actorId]);
    const abd = sorted([current.people.a.actorId, current.people.b.actorId, current.people.d.actorId]);
    const abcd = sorted([
      current.people.a.actorId,
      current.people.b.actorId,
      current.people.c.actorId,
      current.people.d.actorId,
    ]);
    expect(audiences.filter((audience) => sameIds(audience, abc))).toHaveLength(1);
    expect(audiences.filter((audience) => sameIds(audience, abd))).toHaveLength(1);
    expect(audiences.some((audience) => sameIds(audience, abcd))).toBe(false);
    expect(await attachmentIds("artifact", current)).toHaveLength(3);
  });

  test("retrying the original operation after revoke returns history without regrant", async () => {
    const current = fixture!;
    const admission = admissionFor(current);
    const grantCommand = command(current, "artifact", randomUUID(), {
      kind: "grant_people",
      selectedActorIds: [current.people.c.actorId],
    });
    const grantPreparation = prepared(await coordinator.prepare(admission, grantCommand));
    expect(await coordinator.commit(admission, grantCommand, grantPreparation.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(shareObservations).toHaveLength(1);
    const abcRoom = (await accessRoomsFor(current)).find((room) => sameIds(room.humanActorIds, [
      current.people.a.actorId,
      current.people.b.actorId,
      current.people.c.actorId,
    ]));
    expect(abcRoom).toBeDefined();

    const revokeCommand = command(current, "artifact", randomUUID(), {
      kind: "remove_person",
      actorId: current.people.c.actorId,
    });
    const revokePreparation = prepared(await coordinator.prepare(admission, revokeCommand));
    expect(await coordinator.commit(admission, revokeCommand, revokePreparation.previewToken))
      .toMatchObject({ outcome: "applied", stateChanged: true, replayed: false });
    expect(await attachmentIds("artifact", current)).not.toContain(abcRoom!.namespaceId);
    expect(shareObservations).toHaveLength(1);

    const replay = await coordinator.commit(admission, grantCommand, grantPreparation.previewToken);
    expect(replay).toMatchObject({
      outcome: "applied",
      stateChanged: false,
      originalStateChanged: true,
      replayed: true,
    });
    expect(await attachmentIds("artifact", current)).not.toContain(abcRoom!.namespaceId);
    expect(shareObservations).toHaveLength(1);
  });
});
