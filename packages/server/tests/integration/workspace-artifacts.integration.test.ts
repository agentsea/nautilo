import { resolve, join } from "node:path";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { USER_SAVE_TEXT_LIMIT_BYTES } from "@nautilo/agent";
import {
  attachArtifactToNamespace,
  insertArtifact,
  markArtifactDeleted,
  appendPendingArtifactEvent,
  drainPendingArtifactEventsForNamespaces,
  PENDING_ARTIFACT_EVENTS_CAP,
  pendingArtifactEvents,
  tasks,
  agents,
  actors,
  artifactNamespaces,
  artifactState,
  artifacts,
  groups,
  groupRoles,
  groupMembers,
  namespaces,
  rooms,
  roomMembers,
  sessions,
  sessionMessages,
  roles,
  users,
  credentials,
  channelIdentities,
  profiles,
  workspaceDocumentMutationEntries,
  workspaceDocumentMutations,
  eq,
  and,
  inArray,
  count,
  sql,
} from "@nautilo/db";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent, WorkspaceArtifactDeletedEvent } from "@nautilo/types";
import type { PolicyResolver, RuntimePolicyContext } from "@nautilo/trust";
import {
  PersonalPolicyResolver,
  getBootstrapOwnerId,
  hashPin,
  isScopeMemoryEnvelope,
} from "@nautilo/trust";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject, withListeningServer } from "./helpers/request-helpers";

const SCOPE_MSG =
  "Artifact scope mode is not implemented yet; use namespace context or wait for M088 Phase 4.";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForEventCount(
  events: readonly ServerEvent[],
  count: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    await sleep(10);
  }
}

function uniqueSuiteName(prefix: string): string {
  return `${prefix.slice(0, 4)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hotLaneFriendlyText(marker: string): string {
  return `${Array.from(
    { length: 80 },
    (_, i) =>
      `Line ${i + 1}: M180 checkpoint integration fixture ${marker} lorem ipsum dolor sit amet.`,
  ).join("\n")}\n`;
}

function dbForArtifactQueries(fx: AppFixture): NonNullable<Parameters<typeof insertArtifact>[1]> {
  return fx.db as unknown as NonNullable<Parameters<typeof insertArtifact>[1]>;
}

function scopeEnvelopePolicyResolver(inner: PersonalPolicyResolver): PolicyResolver {
  return {
    resolveContext: async (channel, externalId, agentId, requestedRoomId) => {
      const ctx = await inner.resolveContext(channel, externalId, agentId, requestedRoomId);
      const m = ctx.memoryAccess;
      if (isScopeMemoryEnvelope(m)) return ctx;
      return {
        ...ctx,
        memoryAccess: {
          memoryMode: "scope",
          ownerId: m.ownerId,
          actorId: m.actorId,
          agentId: m.agentId,
          roomId: m.roomId,
          scopeId: "test",
          toolPolicy: m.toolPolicy,
        },
      } as unknown as RuntimePolicyContext;
    },
    buildEnvelope: (...args) => inner.buildEnvelope(...args),
    checkToolAccess: (...args) => inner.checkToolAccess(...args),
    routeApproval: (...args) => inner.routeApproval(...args),
  };
}

function emptyWritablePolicyResolver(inner: PersonalPolicyResolver): PolicyResolver {
  return {
    resolveContext: async (channel, externalId, agentId, requestedRoomId) => {
      const ctx = await inner.resolveContext(channel, externalId, agentId, requestedRoomId);
      const m = ctx.memoryAccess;
      if (isScopeMemoryEnvelope(m)) return ctx;
      return {
        ...ctx,
        memoryAccess: {
          ...m,
          writableNamespaces: [],
        },
      } as unknown as RuntimePolicyContext;
    },
    buildEnvelope: (...args) => inner.buildEnvelope(...args),
    checkToolAccess: (...args) => inner.checkToolAccess(...args),
    routeApproval: (...args) => inner.routeApproval(...args),
  };
}

/** M193 — readable envelope but empty mutable surface (subagent/scope analogue). */
function readOnlyMutablePolicyResolver(inner: PersonalPolicyResolver): PolicyResolver {
  return {
    resolveContext: async (channel, externalId, agentId, requestedRoomId) => {
      const ctx = await inner.resolveContext(channel, externalId, agentId, requestedRoomId);
      const m = ctx.memoryAccess;
      if (isScopeMemoryEnvelope(m)) return ctx;
      return {
        ...ctx,
        memoryAccess: {
          ...m,
          mutableNamespaces: [],
        },
      } as unknown as RuntimePolicyContext;
    },
    buildEnvelope: (...args) => inner.buildEnvelope(...args),
    checkToolAccess: (...args) => inner.checkToolAccess(...args),
    routeApproval: (...args) => inner.routeApproval(...args),
  };
}

function documentPatchPayload(input: {
  artifactId: string;
  path: string;
  baseRevision: number | null;
  baseSha256: string;
  oldString: string;
  newString: string;
  requestId?: string;
}) {
  return {
    requestId: input.requestId ?? randomUUID(),
    target: {
      kind: "artifact" as const,
      artifactInternalId: input.artifactId,
      path: input.path,
    },
    baseRevision: input.baseRevision,
    baseSha256: input.baseSha256,
    patch: {
      kind: "anchored_text" as const,
      oldString: input.oldString,
      newString: input.newString,
    },
  };
}

async function namespaceIdForRoom(
  db: AppFixture["db"],
  roomId: string,
): Promise<string> {
  const [row] = await db
    .select({ namespaceId: rooms.namespaceId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!row?.namespaceId) throw new Error("namespace for room");
  return row.namespaceId;
}

// Snapshot of artifact row ids that existed BEFORE this suite created
// anything. Captured once via `ensureArtifactBaseline` so teardown can
// delete ONLY the rows this run created and never touch pre-existing
// data. This guards against the suite being pointed at a populated
// instance DB by mistake: a blanket `DELETE FROM artifacts` there is
// silent data loss (it wiped a real instance's artifacts once).
let baselineArtifactIds: Set<string> | null = null;

/**
 * Capture the pre-run artifact baseline. Idempotent (only the first
 * call records anything) and safe to call from any number of
 * `beforeAll` blocks / test bodies — must run AFTER the fixture exists
 * but BEFORE the caller creates any artifact.
 */
async function ensureArtifactBaseline(db: AppFixture["db"]): Promise<void> {
  if (baselineArtifactIds !== null) return;
  const rows = await db.select({ id: artifacts.id }).from(artifacts);
  baselineArtifactIds = new Set(rows.map((r) => r.id));
}

/**
 * Delete ONLY the artifacts (and their junction rows) that this run
 * created — i.e. rows absent from the baseline snapshot. If no baseline
 * was captured we refuse to delete anything (fail-safe) rather than
 * fall back to a destructive global wipe.
 */
async function deleteArtifactsCreatedDuringRun(db: AppFixture["db"]): Promise<void> {
  if (baselineArtifactIds === null) return;
  const baseline = baselineArtifactIds;
  const rows = await db.select({ id: artifacts.id }).from(artifacts);
  const ids = rows.map((r) => r.id).filter((id) => !baseline.has(id));
  if (ids.length === 0) return;
  const mutationRows = await db
    .select({ mutationId: workspaceDocumentMutationEntries.mutationId })
    .from(workspaceDocumentMutationEntries)
    .where(inArray(workspaceDocumentMutationEntries.artifactInternalId, ids));
  const mutationIds = [...new Set(mutationRows.map(({ mutationId }) => mutationId))];
  if (mutationIds.length > 0) {
    await db
      .delete(workspaceDocumentMutations)
      .where(inArray(workspaceDocumentMutations.id, mutationIds));
  }
  await db.delete(artifactNamespaces).where(inArray(artifactNamespaces.artifactId, ids));
  await db.delete(artifacts).where(inArray(artifacts.id, ids));
}

async function readCurrentArtifactBytes(
  db: AppFixture["db"],
  artifactId: string,
): Promise<string> {
  const [row] = await db
    .select({ storageUri: artifacts.storageUri })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  if (!row) throw new Error(`artifact ${artifactId} missing`);
  return readFile(new URL(row.storageUri!), "utf8");
}

async function* sseRecords(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const sep = buf.indexOf("\n\n");
        if (sep === -1) break;
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let eventName = "message";
        const dataParts: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
        }
        if (dataParts.length === 0) continue;
        const raw = dataParts.join("\n");
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          /* keep string */
        }
        yield { event: eventName, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function assertNoSseMatchingWithin(
  body: ReadableStream<Uint8Array> | null,
  isBad: (rec: { event: string; data: unknown }) => boolean,
  windowMs: number,
): Promise<void> {
  if (!body) throw new Error("no body");
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + windowMs;
  try {
    while (Date.now() < deadline) {
      const wait = Math.min(150, Math.max(1, deadline - Date.now()));
      const chunk = await Promise.race([
        reader.read().then((x) => ({ kind: "read" as const, x })),
        sleep(wait).then(() => ({ kind: "wait" as const })),
      ]);
      if (chunk.kind === "wait") {
        continue;
      }
      if (chunk.x.done) break;
      if (chunk.x.value) buf += dec.decode(chunk.x.value, { stream: true });
      for (;;) {
        const sep = buf.indexOf("\n\n");
        if (sep === -1) break;
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let eventName = "message";
        const dataParts: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
        }
        if (dataParts.length === 0) continue;
        const raw = dataParts.join("\n");
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          /* keep string */
        }
        if (isBad({ event: eventName, data })) {
          throw new Error("unexpected SSE payload");
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function firstSseWhere(
  body: ReadableStream<Uint8Array> | null,
  pred: (rec: { event: string; data: unknown }) => boolean,
  ms: number,
): Promise<{ event: string; data: unknown } | null> {
  return await Promise.race([
    (async () => {
      for await (const rec of sseRecords(body)) {
        if (pred(rec)) return rec;
      }
      return null;
    })(),
    sleep(ms).then(() => null),
  ]);
}

type IsoSeed = {
  bearerOwner: string;
  bearerPeer: string;
  nsOwner: string;
  nsPeerRoom: string;
  artOwner: { id: string; path: string };
  artPeer: { id: string; path: string };
  roomPeerId: string;
  peerActorId: string;
  peerUserId: string;
  peerAgentId: string;
};

async function seedTwoRoomTwoUserIsolation(
  fx: AppFixture,
  options: {
    grantOwnerCapabilities?: boolean;
    includePeerAgentInRoom?: boolean;
    includeOwnerHumanInRoom?: boolean;
  } = {},
): Promise<IsoSeed> {
  const ag = fx.defaultAgentId;
  const ridDefault = fx.defaultRoomId;
  const ogId = fx.defaultOwnershipGroupId;
  if (!ag || !ridDefault || !ogId) throw new Error("graph");
  const nsOwner = await namespaceIdForRoom(fx.db, ridDefault);

  const [nsPeer] = await fx.db
    .insert(namespaces)
    .values({ scope: "private", label: "m088c-peer-ns" })
    .returning({ id: namespaces.id });
  if (!nsPeer) throw new Error("nsPeer");
  const [roomPeer] = await fx.db
    .insert(rooms)
    .values({
      ownerId: fx.ownerId,
      type: "private",
      label: "Peer only",
      graphThreadId: "app:default",
      namespaceId: nsPeer.id,
      humanActorIds: [],
      createdBy: fx.ownerActorId,
    })
    .returning({ id: rooms.id });
  if (!roomPeer) throw new Error("roomPeer");
  await fx.db.update(rooms).set({ graphThreadId: `room:${roomPeer.id}` }).where(eq(rooms.id, roomPeer.id));

  const peerHandle = `m088cp${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const [uPeer] = await fx.db
    .insert(users)
    .values({
      name: "m088c-peer",
      email: `m088c-peer-${Date.now()}@test.local`,
      handle: peerHandle,
      externalId: randomUUID(),
    })
    .returning({ id: users.id });
  if (!uPeer) throw new Error("uPeer");
  // M132 — profiles are agent-keyed; mint the peer's agent first.
  const [peerAg] = await fx.db
    .insert(agents)
    .values({ handle: `ag-${peerHandle}` })
    .returning({ id: agents.id });
  if (!peerAg) throw new Error("peerAg");
  await fx.db.insert(profiles).values({ userId: uPeer.id, agentId: peerAg.id, name: "Peer" });
  const [peerActor] = await fx.db
    .insert(actors)
    .values({
      ownerId: uPeer.id,
      displayName: "Peer U",
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!peerActor) throw new Error("peerActor");
  // The peer needs an agent-kind MIRROR actor for its personal agent, not
  // just the user-kind actor above. `resolveBearer` →
  // `findPersonalAgentsForUser` resolves the caller's preferred agent via
  // `actors WHERE owner_id=<user> AND kind='agent'`; without this row the
  // peer bearer logs `bearer_no_personal_agent`, gets preferredAgentId="",
  // and every agent-scoped route (workspace artifacts) 403s. This mirrors
  // what the production redeem-invite flow + `seatPeerUser` already do.
  const [peerAgentActor] = await fx.db
    .insert(actors)
    .values({
      ownerId: uPeer.id,
      displayName: "Peer agent actor",
      trustState: "verified",
      kind: "agent",
      agentId: peerAg.id,
    })
    .returning({ id: actors.id });
  if (!peerAgentActor) throw new Error("peerAgentActor");
  await fx.db.insert(credentials).values({
    userId: uPeer.id,
    type: "pin",
    value: await hashPin("918273"),
  });
  await fx.db.insert(channelIdentities).values([
    {
      channel: "tui",
      externalId: composeFederatedId(peerHandle, getServerHostname()),
      userId: uPeer.id,
      verifiedAt: new Date(),
    },
    {
      channel: "workbench",
      externalId: composeFederatedId(peerHandle, getServerHostname()),
      userId: uPeer.id,
      verifiedAt: new Date(),
    },
  ]);
  if (options.grantOwnerCapabilities !== false) {
    await fx.db.insert(groupMembers).values({
      groupId: ogId,
      userId: uPeer.id,
      grantedBy: fx.ownerActorId,
    });
  }
  await fx.db.insert(roomMembers).values([
    { roomId: roomPeer.id, actorId: peerActor.id, roomRole: "member" },
    ...(options.includeOwnerHumanInRoom === true
      ? [{ roomId: roomPeer.id, actorId: fx.ownerActorId, roomRole: "admin" as const }]
      : []),
    ...(options.includePeerAgentInRoom === false
      ? []
      : [{ roomId: roomPeer.id, actorId: peerAgentActor.id, roomRole: "member" as const }]),
  ]);
  await fx.db
    .update(rooms)
    .set({
      humanActorIds: options.includeOwnerHumanInRoom === true
        ? [peerActor.id, fx.ownerActorId].sort()
        : [peerActor.id],
    })
    .where(eq(rooms.id, roomPeer.id));

  const t = Date.now();
  const pathA = `m088c-isoA-${t}.md`;
  const pathB = `m088c-isoB-${t}.md`;
  const rowA = await insertArtifact(
    {
      artifactId: `iso-${randomUUID()}`,
      path: pathA,
      storageUri: `file://${join(tmpdir(), "noop")}`,
      mimeType: "text/plain",
      size: 0,
    },
    dbForArtifactQueries(fx),
  );
  await attachArtifactToNamespace({ artifactId: rowA.id, namespaceId: nsOwner }, dbForArtifactQueries(fx));
  const rowB = await insertArtifact(
    {
      artifactId: `iso-${randomUUID()}`,
      path: pathB,
      storageUri: `file://${join(tmpdir(), "noop2")}`,
      mimeType: "text/plain",
      size: 0,
    },
    dbForArtifactQueries(fx),
  );
  await attachArtifactToNamespace({ artifactId: rowB.id, namespaceId: nsPeer.id }, dbForArtifactQueries(fx));

  const bearerOwner = await fx.mintOwnerBearer();
  const bearerPeer = await fx.mintSessionBearerForUser(peerActor.id, uPeer.id);

  return {
    bearerOwner,
    bearerPeer,
    nsOwner,
    nsPeerRoom: nsPeer.id,
    artOwner: { id: rowA.id, path: pathA },
    artPeer: { id: rowB.id, path: pathB },
    roomPeerId: roomPeer.id,
    peerActorId: peerActor.id,
    peerUserId: uPeer.id,
    peerAgentId: peerAg.id,
  };
}

async function teardownIsolationExtras(fx: AppFixture, ctx: IsoSeed): Promise<void> {
  const ogId = fx.defaultOwnershipGroupId;
  if (!ogId) throw new Error("og");
  await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, ctx.artOwner.id));
  await fx.db.delete(artifacts).where(eq(artifacts.id, ctx.artOwner.id));
  await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, ctx.artPeer.id));
  await fx.db.delete(artifacts).where(eq(artifacts.id, ctx.artPeer.id));
  const roomSessions = await fx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.roomId, ctx.roomPeerId));
  const roomSessionIds = roomSessions.map(({ id }) => id);
  if (roomSessionIds.length > 0) {
    await fx.db
      .delete(sessionMessages)
      .where(inArray(sessionMessages.sessionId, roomSessionIds));
    await fx.db.delete(sessions).where(inArray(sessions.id, roomSessionIds));
  }
  await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, ctx.roomPeerId));
  await fx.db.delete(rooms).where(eq(rooms.id, ctx.roomPeerId));
  await fx.db.delete(namespaces).where(eq(namespaces.id, ctx.nsPeerRoom));
  await fx.db.delete(groupMembers).where(
    and(eq(groupMembers.groupId, ogId), eq(groupMembers.userId, ctx.peerUserId)),
  );
  await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, ctx.peerUserId));
  await fx.db.delete(credentials).where(eq(credentials.userId, ctx.peerUserId));
  await fx.db.delete(profiles).where(eq(profiles.userId, ctx.peerUserId));
  // Delete BOTH the user-kind actor and the agent-kind mirror actor
  // (scoped by ownerId), then the peer's personal agent, before the user
  // row — otherwise the agent-mirror actor + agents row leak (and, with
  // RESTRICT FKs, could block the user delete).
  await fx.db.delete(actors).where(eq(actors.ownerId, ctx.peerUserId));
  await fx.db.delete(agents).where(eq(agents.id, ctx.peerAgentId));
  await fx.db.delete(users).where(eq(users.id, ctx.peerUserId));
}

describe("workspace-artifacts isolation list and get-bytes", () => {
  let fx: AppFixture;
  let ctx: IsoSeed;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m088c-iso"), withDefaultAgentGraph: true });
    ctx = await seedTwoRoomTwoUserIsolation(fx);
  });

  afterAll(async () => {
    await teardownIsolationExtras(fx, ctx);
    await fx.cleanup();
  });

  test("1 envelope isolation — list", async () => {
    const lo = await authedInject(fx.app, {
      method: "GET",
      url: "/api/workspace/artifacts",
      bearer: ctx.bearerOwner,
    });
    const lp = await authedInject(fx.app, {
      method: "GET",
      url: "/api/workspace/artifacts",
      bearer: ctx.bearerPeer,
    });
    expect(lo.statusCode).toBe(200);
    expect(lp.statusCode).toBe(200);
    const jo = JSON.parse(lo.body) as { artifacts: { id: string }[] };
    const jp = JSON.parse(lp.body) as { artifacts: { id: string }[] };
    expect(jo.artifacts.some((x) => x.id === ctx.artOwner.id)).toBe(true);
    expect(jo.artifacts.some((x) => x.id === ctx.artPeer.id)).toBe(false);
    expect(jp.artifacts.some((x) => x.id === ctx.artPeer.id)).toBe(true);
    expect(jp.artifacts.some((x) => x.id === ctx.artOwner.id)).toBe(false);
  });

  test("2 envelope isolation — get-bytes 404 not 403", async () => {
    const res = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts/${ctx.artOwner.id}/bytes`,
      bearer: ctx.bearerPeer,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("M259 Guest Room and Artifact vertical slice", () => {
  let fx: AppFixture;
  let ctx: IsoSeed;
  let artifactFile: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({
      suiteName: uniqueSuiteName("m259-guest"),
      withDefaultAgentGraph: true,
    });
    ctx = await seedTwoRoomTwoUserIsolation(fx, {
      grantOwnerCapabilities: false,
      includePeerAgentInRoom: false,
      includeOwnerHumanInRoom: true,
    });
    artifactFile = join(tmpdir(), `m259-${randomUUID()}.txt`);
    await writeFile(artifactFile, "guest-readable\n", "utf8");
    await fx.db
      .update(artifacts)
      .set({
        storageUri: `file://${artifactFile}`,
        size: Buffer.byteLength("guest-readable\n"),
      })
      .where(eq(artifacts.id, ctx.artPeer.id));

    const [session] = await fx.db
      .insert(sessions)
      .values({
        ownerId: fx.ownerId,
        roomId: ctx.roomPeerId,
        threadId: `m259:${randomUUID()}`,
        channel: "workbench",
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("M259 session");
    await fx.db.insert(sessionMessages).values({
      sessionId: session.id,
      role: "user",
      content: "shared Guest history",
    });
  });

  afterAll(async () => {
    await rm(artifactFile, { force: true });
    await teardownIsolationExtras(fx, ctx);
    await fx.cleanup();
  });

  test("exact Human membership reads Room history and Room Artifact bytes without capabilities", async () => {
    const roomList = await authedInject(fx.app, {
      method: "GET",
      url: "/api/rooms",
      bearer: ctx.bearerPeer,
    });
    expect(roomList.statusCode).toBe(200);
    expect(
      (JSON.parse(roomList.body) as { rooms: Array<{ id: string }> }).rooms.some(
        ({ id }) => id === ctx.roomPeerId,
      ),
    ).toBe(true);

    const history = await authedInject(fx.app, {
      method: "GET",
      url: `/api/sessions/latest?roomId=${ctx.roomPeerId}`,
      bearer: ctx.bearerPeer,
    });
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain("shared Guest history");

    const list = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts?roomId=${ctx.roomPeerId}`,
      bearer: ctx.bearerPeer,
    });
    expect(list.statusCode).toBe(200);
    expect(
      (JSON.parse(list.body) as { artifacts: Array<{ id: string }> }).artifacts
        .some(({ id }) => id === ctx.artPeer.id),
    ).toBe(true);

    const bytes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts/${ctx.artPeer.id}/bytes?roomId=${ctx.roomPeerId}`,
      bearer: ctx.bearerPeer,
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe("guest-readable\n");
  });

  test("every representative Artifact mutation family denies before side effects", async () => {
    const before = await fx.db
      .select({
        path: artifacts.path,
        revision: artifacts.revision,
        deletedAt: artifacts.deletedAt,
        artifactId: artifacts.artifactId,
      })
      .from(artifacts)
      .where(eq(artifacts.id, ctx.artPeer.id))
      .limit(1);
    const beforeRooms = await fx.db
      .select({ count: count() })
      .from(rooms)
      .where(eq(rooms.ownerId, ctx.peerUserId));

    const cases = [
      {
        method: "PATCH",
        url: `/api/workspace/artifacts/${ctx.artPeer.id}?roomId=${ctx.roomPeerId}`,
        payload: { newPath: "guest-must-not-rename.txt" },
      },
      {
        method: "PUT",
        url: `/api/workspace/artifacts/${ctx.artPeer.id}/content?roomId=${ctx.roomPeerId}`,
        payload: "guest-must-not-save\n",
        headers: { "content-type": "text/plain" },
      },
      {
        method: "PUT",
        url: `/api/workspace/artifacts/${ctx.artPeer.id}/state/m259?roomId=${ctx.roomPeerId}`,
        payload: { value: { denied: false } },
      },
      {
        method: "POST",
        url: `/api/workspace/artifacts/${ctx.artPeer.id}/events?roomId=${ctx.roomPeerId}`,
        payload: { topic: "m259", payload: { denied: false } },
      },
      {
        method: "POST",
        url: `/api/workspace/artifacts/${ctx.artPeer.id}/events/ping?roomId=${ctx.roomPeerId}`,
        payload: { topic: "m259", payload: { denied: false } },
      },
      {
        method: "POST",
        url: `/api/workspace/artifacts/${ctx.artPeer.id}/discussion-rooms?roomId=${ctx.roomPeerId}`,
        payload: { label: "must not exist" },
      },
      {
        method: "DELETE",
        url: `/api/workspace/artifacts/${ctx.artPeer.id}?roomId=${ctx.roomPeerId}`,
      },
    ] as const;

    for (const request of cases) {
      const response = await authedInject(fx.app, {
        ...request,
        bearer: ctx.bearerPeer,
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(JSON.parse(response.body)).toEqual({
        error: "write_artifacts_required",
        code: "write_artifacts_required",
        capability: "write_artifacts",
      });
    }

    const after = await fx.db
      .select({
        path: artifacts.path,
        revision: artifacts.revision,
        deletedAt: artifacts.deletedAt,
        artifactId: artifacts.artifactId,
      })
      .from(artifacts)
      .where(eq(artifacts.id, ctx.artPeer.id))
      .limit(1);
    expect(after).toEqual(before);
    expect(await readFile(artifactFile, "utf8")).toBe("guest-readable\n");
    expect(
      await fx.db
        .select({ count: count() })
        .from(artifactState)
        .where(eq(artifactState.artifactId, before[0]!.artifactId)),
    ).toEqual([{ count: 0 }]);
    expect(
      await fx.db
        .select({ count: count() })
        .from(pendingArtifactEvents)
        .where(eq(pendingArtifactEvents.artifactId, before[0]!.artifactId)),
    ).toEqual([{ count: 0 }]);
    expect(
      await fx.db
        .select({ count: count() })
        .from(rooms)
        .where(eq(rooms.ownerId, ctx.peerUserId)),
    ).toEqual(beforeRooms);
  });
});

describe("workspace-artifacts room-scoped LIST", () => {
  let fx: AppFixture;
  let bearer: string;
  let roomAId: string;
  let roomBId: string;
  let nsA: string;
  let nsB: string;
  let artAId: string;
  let artBId: string;
  let foreignRoomId: string;
  let foreignUserId: string;
  let foreignActorId: string;
  let foreignNsId: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m088c-rs"), withDefaultAgentGraph: true });
    bearer = await fx.mintOwnerBearer();
    const ag = fx.defaultAgentId;
    const ridA = fx.defaultRoomId;
    if (!ag || !ridA) throw new Error("graph");
    roomAId = ridA;
    nsA = await namespaceIdForRoom(fx.db, roomAId);

    const [nsBrow] = await fx.db
      .insert(namespaces)
      .values({ scope: "private", label: "m088c-rb-ns" })
      .returning({ id: namespaces.id });
    if (!nsBrow) throw new Error("nsB");
    nsB = nsBrow.id;
    const [roomB] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: "Room B",
        graphThreadId: "app:default",
        namespaceId: nsB,
        humanActorIds: [fx.ownerActorId],
        createdBy: fx.ownerActorId,
      })
      .returning({ id: rooms.id });
    if (!roomB) throw new Error("roomB");
    roomBId = roomB.id;
    await fx.db.update(rooms).set({ graphThreadId: `room:${roomBId}` }).where(eq(rooms.id, roomBId));
    // M227: room-scoped Human content reads must not depend on the preferred
    // Agent mirror being a member of the Room.
    await fx.db.insert(roomMembers).values({
      roomId: roomBId,
      actorId: fx.ownerActorId,
      roomRole: "admin",
    });

    const t = Date.now();
    const pathA = `m088c-rsa-${t}.md`;
    const pathB = `m088c-rsb-${t}.md`;
    const rowA = await insertArtifact(
      {
        artifactId: `rsa-${randomUUID()}`,
        path: pathA,
        storageUri: "file:///tmp/x",
        size: 1,
      },
      dbForArtifactQueries(fx),
    );
    const rowB = await insertArtifact(
      {
        artifactId: `rsb-${randomUUID()}`,
        path: pathB,
        storageUri: "file:///tmp/x",
        size: 1,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: rowA.id, namespaceId: nsA }, dbForArtifactQueries(fx));
    await attachArtifactToNamespace({ artifactId: rowB.id, namespaceId: nsB }, dbForArtifactQueries(fx));
    artAId = rowA.id;
    artBId = rowB.id;

    const foreignHandle = `m088c-fr${Date.now().toString(36).slice(-6)}`;
    const [uF] = await fx.db
      .insert(users)
      .values({
        name: "m088c-fr",
        email: `m088c-fr-${Date.now()}@test.local`,
        handle: foreignHandle,
        externalId: randomUUID(),
      })
      .returning({ id: users.id });
    if (!uF) throw new Error("uF");
    foreignUserId = uF.id;
    // M132 — profiles are agent-keyed; mint the foreign user's agent first.
    const [frAg] = await fx.db
      .insert(agents)
      .values({ handle: `ag-${foreignHandle}` })
      .returning({ id: agents.id });
    if (!frAg) throw new Error("frAg");
    await fx.db.insert(profiles).values({ userId: foreignUserId, agentId: frAg.id, name: "Fr" });
    const [actF] = await fx.db
      .insert(actors)
      .values({
        ownerId: foreignUserId,
        displayName: "Fr act",
        trustState: "verified",
        kind: "user",
      })
      .returning({ id: actors.id });
    if (!actF) throw new Error("actF");
    foreignActorId = actF.id;
    await fx.db.insert(credentials).values({
      userId: foreignUserId,
      type: "pin",
      value: await hashPin("918273"),
    });
    await fx.db.insert(channelIdentities).values({
      channel: "tui",
      externalId: composeFederatedId(foreignHandle, getServerHostname()),
      userId: foreignUserId,
      verifiedAt: new Date(),
    });

    const [nsF] = await fx.db
      .insert(namespaces)
      .values({ scope: "private", label: "m088c-fr-ns" })
      .returning({ id: namespaces.id });
    if (!nsF) throw new Error("nsF");
    foreignNsId = nsF.id;
    const [roomF] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: "Foreign-only",
        graphThreadId: "app:default",
        namespaceId: foreignNsId,
        humanActorIds: [foreignActorId],
        createdBy: fx.ownerActorId,
      })
      .returning({ id: rooms.id });
    if (!roomF) throw new Error("roomF");
    foreignRoomId = roomF.id;
    await fx.db.update(rooms).set({ graphThreadId: `room:${foreignRoomId}` }).where(eq(rooms.id, foreignRoomId));
    await fx.db.insert(roomMembers).values({
      roomId: foreignRoomId,
      actorId: foreignActorId,
      roomRole: "admin",
    });
  });

  afterAll(async () => {
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, artAId));
    await fx.db.delete(artifacts).where(eq(artifacts.id, artAId));
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, artBId));
    await fx.db.delete(artifacts).where(eq(artifacts.id, artBId));
    await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, roomBId));
    await fx.db.delete(rooms).where(eq(rooms.id, roomBId));
    await fx.db.delete(namespaces).where(eq(namespaces.id, nsB));

    await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, foreignRoomId));
    await fx.db.delete(rooms).where(eq(rooms.id, foreignRoomId));
    await fx.db.delete(namespaces).where(eq(namespaces.id, foreignNsId));
    await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, foreignUserId));
    await fx.db.delete(credentials).where(eq(credentials.userId, foreignUserId));
    await fx.db.delete(profiles).where(eq(profiles.userId, foreignUserId));
    await fx.db.delete(actors).where(eq(actors.id, foreignActorId));
    await fx.db.delete(users).where(eq(users.id, foreignUserId));

    await fx.cleanup();
  });

  test("R1 GET ?roomId returns subset-aware envelope (same shape as memory)", async () => {
    // Subset-aware semantics (matches `GET /api/memory/brief`): scoping to
    // room A returns every artifact visible from A's perspective in the H
    // graph, including sibling rooms the user belongs to — not strictly
    // room A's own namespace.
    const ra = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts?roomId=${encodeURIComponent(roomAId)}`,
      bearer,
    });
    const rb = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts?roomId=${encodeURIComponent(roomBId)}`,
      bearer,
    });
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    const ja = JSON.parse(ra.body) as { artifacts: { id: string }[] };
    const jb = JSON.parse(rb.body) as { artifacts: { id: string }[] };
    const idsA = new Set(ja.artifacts.map((x) => x.id));
    const idsB = new Set(jb.artifacts.map((x) => x.id));
    expect(idsA.has(artAId)).toBe(true);
    // Room B deliberately has no Agent member; its Human member still gets
    // the same Namespace-subset Artifact projection.
    expect(idsB.has(artBId)).toBe(true);

    const rm = await authedInject(fx.app, { method: "GET", url: "/api/workspace/artifacts", bearer });
    expect(rm.statusCode).toBe(200);
    const jm = JSON.parse(rm.body) as { artifacts: unknown[] };
    expect(Array.isArray(jm.artifacts)).toBe(true);
    expect("provenance" in jm).toBe(false);
  });

  test("R2 invalid roomId query is ignored", async () => {
    const r = await authedInject(fx.app, {
      method: "GET",
      url: "/api/workspace/artifacts?roomId=not-a-uuid",
      bearer,
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { artifacts: unknown[] };
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect("provenance" in body).toBe(false);
  });

  test("R3 roomId for a room the owner is not in still returns a valid list", async () => {
    const r = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts?roomId=${encodeURIComponent(foreignRoomId)}`,
      bearer,
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { artifacts: { id: string }[] };
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(body.artifacts.some((artifact) => artifact.id === artAId)).toBe(false);
    expect(body.artifacts.some((artifact) => artifact.id === artBId)).toBe(false);
    expect("provenance" in body).toBe(false);
  });

});

describe("workspace-artifacts isolation SSE 16", () => {
  let fx: AppFixture;
  let ctx: IsoSeed;
  let baseUrl: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m088c-s16"), withDefaultAgentGraph: true });
    ctx = await seedTwoRoomTwoUserIsolation(fx);
    baseUrl = (await fx.app.listen({ port: 0, host: "127.0.0.1" })).replace(/\/$/, "");
  });

  afterAll(async () => {
    await teardownIsolationExtras(fx, ctx);
    fx.app.server.closeAllConnections?.();
    await fx.cleanup();
  });

  test("16 SSE envelope filter on direct bus emit", async () => {
      const res = await fetch(
        `${baseUrl}/api/workspace/artifacts/events?token=${encodeURIComponent(ctx.bearerPeer)}`,
        { headers: { accept: "text/event-stream" } },
      );
      expect(res.ok).toBe(true);
      eventBus.emit({
        type: "workspace.artifact.changed",
        id: ctx.artOwner.id,
        artifactId: "x",
        path: ctx.artOwner.path,
      } satisfies ServerEvent);
    await assertNoSseMatchingWithin(
      res.body,
      (r) => r.event === "changed" && (r.data as { id?: string }).id === ctx.artOwner.id,
      1_100,
    );
  });

  test("16b direct-live patch SSE is filtered when the artifact is not visible", async () => {
      const res = await fetch(
        `${baseUrl}/api/workspace/artifacts/events?token=${encodeURIComponent(ctx.bearerPeer)}`,
        { headers: { accept: "text/event-stream" } },
      );
      expect(res.ok).toBe(true);
      eventBus.emit({
        type: "document.patch.applied",
        target: {
          kind: "artifact",
          artifactInternalId: ctx.artOwner.id,
          path: ctx.artOwner.path,
          mimeType: "text/plain",
        },
        patchId: "hidden-design-patch",
        requestId: "hidden-design-request",
        revision: 2,
        sha256: "b".repeat(64),
        previousRevision: 1,
        previousSha256: "a".repeat(64),
        patch: { kind: "anchored_text", oldString: "before", newString: "after" },
        author: { kind: "app_tool", displayName: "nautilo-design" },
        rebased: false,
      } satisfies ServerEvent);
    await assertNoSseMatchingWithin(
      res.body,
        (record) =>
          record.event === "document.patch.applied" &&
          typeof record.data === "object" &&
          record.data !== null &&
          (record.data as { patchId?: string }).patchId === "hidden-design-patch",
      1_100,
    );
  });
});

describe("workspace-artifacts isolation SSE 18", () => {
  let fx: AppFixture;
  let ctx: IsoSeed;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m088c-s18"), withDefaultAgentGraph: true });
    ctx = await seedTwoRoomTwoUserIsolation(fx);
  });

  afterAll(async () => {
    await teardownIsolationExtras(fx, ctx);
    await fx.cleanup();
  });

  test("18 SSE delete filtered cross-envelope", async () => {
    await withListeningServer(fx.app, async (base) => {
      const res = await fetch(
        `${base}/api/workspace/artifacts/events?token=${encodeURIComponent(ctx.bearerPeer)}`,
        { headers: { accept: "text/event-stream" } },
      );
      expect(res.ok).toBe(true);
      const del = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/workspace/artifacts/${ctx.artOwner.id}`,
        bearer: ctx.bearerOwner,
      });
      expect(del.statusCode).toBe(200);
      await assertNoSseMatchingWithin(
        res.body,
        (r) => r.event === "deleted" && (r.data as { id?: string }).id === ctx.artOwner.id,
        1_600,
      );
    });
  });
});

describe("workspace-artifacts shared graph (inject)", () => {
  let fx: AppFixture;
  let bearer: string;
  let prevArtifactsRoot: string | undefined;

  beforeAll(async () => {
    prevArtifactsRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
    process.env["NAUTILO_ARTIFACTS_ROOT"] = await mkdtemp(join(tmpdir(), "m088c-artroot-"));
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m088c-main"), withDefaultAgentGraph: true });
    bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
  });

  afterAll(async () => {
    await deleteArtifactsCreatedDuringRun(fx.db);
    await fx.cleanup();
    if (prevArtifactsRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
    else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevArtifactsRoot;
  });

  async function seedTextArtifactForSave(opts?: {
    path?: string;
    content?: string;
    mimeType?: string;
  }): Promise<{
    id: string;
    path: string;
    absPath: string;
    revision: number;
    sha256: string;
  }> {
    const rid = fx.defaultRoomId;
    if (!rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const root = process.env["NAUTILO_ARTIFACTS_ROOT"]!;
    const externalId = `m180-save-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const absPath = join(root, externalId);
    const content = opts?.content ?? "m180 original\n";
    await writeFile(absPath, content);
    const path = opts?.path ?? `m180-save-${Date.now()}-${randomUUID().slice(0, 8)}.md`;
    const row = await insertArtifact(
      {
        artifactId: externalId,
        path,
        storageUri: `file://${absPath}`,
        mimeType: opts?.mimeType ?? "text/markdown",
        size: Buffer.byteLength(content, "utf8"),
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    return {
      id: row.id,
      path,
      absPath,
      revision: row.revision,
      sha256: sha256Hex(content),
    };
  }

  test("3 merged list visibility across two readable rooms", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const nsPrivate = await namespaceIdForRoom(fx.db, rid);
    const [ownerRole] = await fx.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.slug, "owner"))
      .limit(1);
    if (!ownerRole) throw new Error("role");
    const [ag2] = await fx.db
      .insert(agents)
      .values({ handle: `m088c-fam-ag-${Date.now().toString(36).slice(-6)}` })
      .returning({ id: agents.id });
    if (!ag2) throw new Error("agent2");
    const [og2] = await fx.db
      .insert(groups)
      .values({
        ownerId: fx.ownerId,
        type: "agent_ownership",
        label: "m088c fam og",
        trustPreset: "personal",
      })
      .returning({ id: groups.id });
    if (!og2) throw new Error("og2");
    // M131: Group→Role via the group_roles junction.
    await fx.db
      .insert(groupRoles)
      .values({ groupId: og2.id, roleId: ownerRole.id })
      .onConflictDoNothing();
    await fx.db.insert(groupMembers).values({
      groupId: og2.id,
      userId: fx.ownerId,
      grantedBy: fx.ownerActorId,
    });
    const [agentActor2] = await fx.db
      .insert(actors)
      .values({
        ownerId: fx.ownerId,
        displayName: "Fam agent actor",
        trustState: "verified",
        kind: "agent",
      })
      .returning({ id: actors.id });
    if (!agentActor2) throw new Error("aa2");
    const [nsFam] = await fx.db
      .insert(namespaces)
      .values({ scope: "private", label: "m088c-family-ns" })
      .returning({ id: namespaces.id });
    if (!nsFam) throw new Error("nsFam");
    const [roomFam] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: "Family",
        graphThreadId: "app:default",
        namespaceId: nsFam.id,
        humanActorIds: [fx.ownerActorId],
        createdBy: fx.ownerActorId,
      })
      .returning({ id: rooms.id });
    if (!roomFam) throw new Error("roomFam");
    await fx.db.update(rooms).set({ graphThreadId: `room:${roomFam.id}` }).where(eq(rooms.id, roomFam.id));
    await fx.db.insert(roomMembers).values([
      { roomId: roomFam.id, actorId: fx.ownerActorId, roomRole: "admin" },
      { roomId: roomFam.id, actorId: agentActor2.id, roomRole: "member" },
    ]);

    const t = Date.now();
    const onlyP1 = await insertArtifact(
      { artifactId: `e1-${t}`, path: `m088c-pr3-p1-${t}.md`, storageUri: "file:///tmp/x", size: 1 },
      dbForArtifactQueries(fx),
    );
    const onlyP2 = await insertArtifact(
      { artifactId: `e2-${t}`, path: `m088c-pr3-p2-${t}.md`, storageUri: "file:///tmp/x", size: 1 },
      dbForArtifactQueries(fx),
    );
    const onlyF = await insertArtifact(
      { artifactId: `e3-${t}`, path: `m088c-pr3-f-${t}.md`, storageUri: "file:///tmp/x", size: 1 },
      dbForArtifactQueries(fx),
    );
    const shared = await insertArtifact(
      { artifactId: `e4-${t}`, path: `m088c-pr3-sh-${t}.md`, storageUri: "file:///tmp/x", size: 1 },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: onlyP1.id, namespaceId: nsPrivate }, dbForArtifactQueries(fx));
    await attachArtifactToNamespace({ artifactId: onlyP2.id, namespaceId: nsPrivate }, dbForArtifactQueries(fx));
    await attachArtifactToNamespace({ artifactId: onlyF.id, namespaceId: nsFam.id }, dbForArtifactQueries(fx));
    await attachArtifactToNamespace({ artifactId: shared.id, namespaceId: nsPrivate }, dbForArtifactQueries(fx));
    await attachArtifactToNamespace({ artifactId: shared.id, namespaceId: nsFam.id }, dbForArtifactQueries(fx));

    const res = await authedInject(fx.app, { method: "GET", url: "/api/workspace/artifacts", bearer });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      artifacts: { id: string }[];
    };
    expect(body.artifacts.length).toBe(4);
    expect("provenance" in body).toBe(false);
    const ids = new Set(body.artifacts.map((a) => a.id));
    expect(ids.has(onlyP1.id)).toBe(true);
    expect(ids.has(onlyP2.id)).toBe(true);
    expect(ids.has(onlyF.id)).toBe(true);
    expect(ids.has(shared.id)).toBe(true);

    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, onlyP1.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, onlyP1.id));
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, onlyP2.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, onlyP2.id));
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, onlyF.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, onlyF.id));
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, shared.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, shared.id));
    await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, roomFam.id));
    await fx.db.delete(rooms).where(eq(rooms.id, roomFam.id));
    await fx.db.delete(namespaces).where(eq(namespaces.id, nsFam.id));
    await fx.db.delete(actors).where(eq(actors.id, agentActor2.id));
    await fx.db.delete(groupMembers).where(eq(groupMembers.groupId, og2.id));
    await fx.db.delete(groups).where(eq(groups.id, og2.id));
    await fx.db.delete(agents).where(eq(agents.id, ag2.id));
  });

  test("4 soft-deleted hidden from list get bytes", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const row = await insertArtifact(
      {
        artifactId: `soft-${Date.now()}`,
        path: `m088c-soft-${Date.now()}.md`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    await markArtifactDeleted({ id: row.id }, dbForArtifactQueries(fx));
    const list = await authedInject(fx.app, { method: "GET", url: "/api/workspace/artifacts", bearer });
    const j = JSON.parse(list.body) as { artifacts: { id: string }[] };
    expect(j.artifacts.some((a) => a.id === row.id)).toBe(false);
    const g = await authedInject(fx.app, { method: "GET", url: `/api/workspace/artifacts/${row.id}`, bearer });
    expect(g.statusCode).toBe(404);
    const b = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts/${row.id}/bytes`,
      bearer,
    });
    expect(b.statusCode).toBe(404);
  });

  test("5 M127 — artifact in a readable namespace is visible regardless of authoring agent", async () => {
    const agDefault = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!agDefault || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const [ownerRole] = await fx.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.slug, "owner"))
      .limit(1);
    if (!ownerRole) throw new Error("role");
    const [agOther] = await fx.db
      .insert(agents)
      .values({ handle: `m088c-other-${Date.now().toString(36).slice(-6)}` })
      .returning({ id: agents.id });
    if (!agOther) throw new Error("ago");
    const [og] = await fx.db
      .insert(groups)
      .values({
        ownerId: fx.ownerId,
        type: "agent_ownership",
        label: "m088c other og",
        trustPreset: "personal",
      })
      .returning({ id: groups.id });
    if (!og) throw new Error("og");
    // M131: Group→Role via the group_roles junction.
    await fx.db
      .insert(groupRoles)
      .values({ groupId: og.id, roleId: ownerRole.id })
      .onConflictDoNothing();
    await fx.db.insert(groupMembers).values({
      groupId: og.id,
      userId: fx.ownerId,
      grantedBy: fx.ownerActorId,
    });
    const [agentActor] = await fx.db
      .insert(actors)
      .values({
        ownerId: fx.ownerId,
        displayName: "Other agent actor",
        trustState: "verified",
        kind: "agent",
      })
      .returning({ id: actors.id });
    if (!agentActor) throw new Error("aa");
    await fx.db.insert(roomMembers).values({
      roomId: rid,
      actorId: agentActor.id,
      roomRole: "member",
    });
    const row = await insertArtifact(
      {
        artifactId: `other-${Date.now()}`,
        path: `m088c-agent-other-${Date.now()}.md`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    // M127 — Namespace is the only content-scope axis; artifacts no
    // longer carry agent_id and the Path C policy no longer narrows by
    // agent. The artifact above was authored under a DIFFERENT agent but
    // attached to the owner's own room Namespace (`ns`), so the owner now
    // sees it. (Pre-M127 this asserted cross-agent isolation — `false` /
    // 404 — which the agent-narrowing trailer enforced before it was
    // removed.)
    const list = await authedInject(fx.app, { method: "GET", url: "/api/workspace/artifacts", bearer });
    const j = JSON.parse(list.body) as { artifacts: { id: string }[] };
    expect(j.artifacts.some((a) => a.id === row.id)).toBe(true);
    const one = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts/${row.id}`,
      bearer,
    });
    expect(one.statusCode).toBe(200);
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, row.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, row.id));
    await fx.db.delete(roomMembers).where(
      and(eq(roomMembers.roomId, rid), eq(roomMembers.actorId, agentActor.id)),
    );
    await fx.db.delete(actors).where(eq(actors.id, agentActor.id));
    await fx.db.delete(groupMembers).where(eq(groupMembers.groupId, og.id));
    await fx.db.delete(groups).where(eq(groups.id, og.id));
    await fx.db.delete(agents).where(eq(agents.id, agOther.id));
  });

  test("M180 PUT content persists bytes, bumps row, and emits one changed event", async () => {
    const seeded = await seedTextArtifactForSave();
    const captured: ServerEvent[] = [];
    const h = (e: ServerEvent) => {
      if (
        e.type === "document.mutation.committed" &&
        e.mutation === "update" &&
        e.after.identity.kind === "workspace_artifact" &&
        e.after.identity.artifactId === seeded.id
      ) {
        captured.push(e);
      }
    };
    eventBus.on(h);
    try {
      const next = "m180 saved content\n";
      const res = await authedInject(fx.app, {
        method: "PUT",
        url: `/api/workspace/artifacts/${seeded.id}/content`,
        bearer,
        payload: next,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "if-match": String(seeded.revision),
          "x-base-sha256": seeded.sha256,
          "x-client-mutation-id": "mutation-123",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        id: string;
        revision: number;
        size: number;
        sha256: string;
      };
      expect(body).toEqual({
        id: seeded.id,
        revision: seeded.revision + 1,
        size: Buffer.byteLength(next, "utf8"),
        sha256: sha256Hex(next),
      });
      expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(next);
      const [row] = await fx.db
        .select({ revision: artifacts.revision, size: artifacts.size, mimeType: artifacts.mimeType })
        .from(artifacts)
        .where(eq(artifacts.id, seeded.id))
        .limit(1);
      expect(row?.revision).toBe(body.revision);
      expect(row?.size).toBe(body.size);
      expect(row?.mimeType).toBe("text/plain");
      await waitForEventCount(captured, 1);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        type: "document.mutation.committed",
        mutation: "update",
        outcome: "applied",
        actor: { kind: "human" },
        after: {
          identity: {
            kind: "workspace_artifact",
            artifactId: seeded.id,
            logicalPath: seeded.path,
          },
          backendVersion: { kind: "artifact_revision", revision: body.revision },
          sha256: body.sha256,
        },
        editorSave: {
          clientMutationId: "mutation-123",
          checkpoint: false,
        },
      });
    } finally {
      eventBus.off(h);
    }
  });

  test("M180 PUT content saves immediately after room-scoped create", async () => {
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("graph");
    const path = `m180-fresh-save-${Date.now()}-${randomUUID().slice(0, 8)}.md`;
    const initial = "draft created by editor\n";
    const fd = new FormData();
    fd.set("file", new Blob([initial], { type: "text/markdown" }), "draft.md");
    fd.set("path", path);
    fd.set("mimeType", "text/markdown");

    const createdRes = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts?roomId=${encodeURIComponent(roomId)}`,
      bearer,
      payload: fd,
    });
    expect(createdRes.statusCode, createdRes.body).toBe(200);
    const created = JSON.parse(createdRes.body) as {
      id: string;
      artifactId: string;
      path: string;
      revision: number;
      size: number;
    };
    expect(created.path).toBe(path);
    expect(created.revision).toBe(1);
    expect(created.size).toBe(Buffer.byteLength(initial, "utf8"));

    const getRes = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts/${created.id}?roomId=${encodeURIComponent(roomId)}`,
      bearer,
    });
    expect(getRes.statusCode).toBe(200);

    const next = "first real editor save\n";
    const saveRes = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${created.id}/content?roomId=${encodeURIComponent(roomId)}`,
      bearer,
      payload: next,
      headers: {
        "content-type": "text/markdown",
        "if-match": String(created.revision),
        "x-base-sha256": sha256Hex(initial),
        "x-checkpoint": "1",
      },
    });
    expect(saveRes.statusCode).toBe(200);
    const saved = JSON.parse(saveRes.body) as {
      id: string;
      revision: number;
      size: number;
      sha256: string;
    };
    expect(saved).toEqual({
      id: created.id,
      revision: 2,
      size: Buffer.byteLength(next, "utf8"),
      sha256: sha256Hex(next),
    });

    expect(await readCurrentArtifactBytes(fx.db, created.id)).toBe(next);
    const [row] = await fx.db
      .select({ revision: artifacts.revision, size: artifacts.size, mimeType: artifacts.mimeType })
      .from(artifacts)
      .where(eq(artifacts.id, created.id))
      .limit(1);
    expect(row).toEqual({
      revision: 2,
      size: Buffer.byteLength(next, "utf8"),
      mimeType: "text/markdown",
    });
  });

  test("PUT content saves invalid JSON text without HTTP JSON parsing", async () => {
    const seeded = await seedTextArtifactForSave({
      path: `m180-json-${Date.now()}.json`,
      content: "{\"valid\":true}\n",
      mimeType: "application/json",
    });
    const next = "{\"draft\":\n";

    const res = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${seeded.id}/content`,
      bearer,
      payload: next,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-artifact-mime-type": "application/json",
        "if-match": String(seeded.revision),
        "x-base-sha256": seeded.sha256,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(next);
    const [row] = await fx.db
      .select({ mimeType: artifacts.mimeType, size: artifacts.size })
      .from(artifacts)
      .where(eq(artifacts.id, seeded.id))
      .limit(1);
    expect(row?.mimeType).toBe("application/json");
    expect(row?.size).toBe(Buffer.byteLength(next, "utf8"));
  });

  test("M180 checkpoints record canonical user history for each requested checkpoint", async () => {
    const pre = hotLaneFriendlyText("before");
    const post1 = pre.replace("Line 40: M180", "Line 40: changed-once M180");
    const post2 = post1.replace("Line 41: M180", "Line 41: changed-twice M180");
    const seeded = await seedTextArtifactForSave({ content: pre });

    const first = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${seeded.id}/content`,
      bearer,
      payload: post1,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "if-match": String(seeded.revision),
        "x-base-sha256": seeded.sha256,
        "x-checkpoint": "1",
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body) as { revision: number; sha256: string };

    const mutationsAfterFirst = await fx.db
      .select({
        ownerId: workspaceDocumentMutations.ownerId,
        userId: workspaceDocumentMutations.userId,
        lane: workspaceDocumentMutations.lane,
        mutationKind: workspaceDocumentMutationEntries.mutationKind,
        historyEligible: workspaceDocumentMutationEntries.historyEligible,
        checkpoint: workspaceDocumentMutationEntries.checkpoint,
      })
      .from(workspaceDocumentMutationEntries)
      .innerJoin(
        workspaceDocumentMutations,
        eq(workspaceDocumentMutations.id, workspaceDocumentMutationEntries.mutationId),
      )
      .where(eq(workspaceDocumentMutationEntries.artifactInternalId, seeded.id));
    expect(mutationsAfterFirst).toEqual([{
      ownerId: fx.ownerId,
      userId: fx.ownerId,
      lane: "editor_save",
      mutationKind: "update",
      historyEligible: true,
      checkpoint: true,
    }]);

    const second = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${seeded.id}/content`,
      bearer,
      payload: post2,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "if-match": String(firstBody.revision),
        "x-base-sha256": firstBody.sha256,
        "x-checkpoint": "1",
      },
    });
    expect(second.statusCode).toBe(200);
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(post2);

    const mutationsAfterSecond = await fx.db
      .select({
        historyEligible: workspaceDocumentMutationEntries.historyEligible,
        checkpoint: workspaceDocumentMutationEntries.checkpoint,
      })
      .from(workspaceDocumentMutationEntries)
      .where(eq(workspaceDocumentMutationEntries.artifactInternalId, seeded.id));
    expect(mutationsAfterSecond).toHaveLength(2);
    expect(mutationsAfterSecond.every(({ historyEligible }) => historyEligible)).toBe(true);
    expect(mutationsAfterSecond.every(({ checkpoint }) => checkpoint)).toBe(true);
  });

  test("M180 stale revision or sha returns 409 and does not clobber bytes", async () => {
    const seeded = await seedTextArtifactForSave({ content: "m180 conflict base\n" });

    const staleRevision = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${seeded.id}/content`,
      bearer,
      payload: "should not write\n",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "if-match": String(seeded.revision + 1),
        "x-base-sha256": seeded.sha256,
      },
    });
    expect(staleRevision.statusCode).toBe(409);
    expect(JSON.parse(staleRevision.body)).toEqual({
      error: "external_change",
      currentSha256: seeded.sha256,
    });
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe("m180 conflict base\n");

    const staleSha = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${seeded.id}/content`,
      bearer,
      payload: "should not write either\n",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "if-match": String(seeded.revision),
        "x-base-sha256": "0".repeat(64),
      },
    });
    expect(staleSha.statusCode).toBe(409);
    expect(JSON.parse(staleSha.body)).toEqual({
      error: "external_change",
      currentSha256: seeded.sha256,
    });
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe("m180 conflict base\n");
  });

  test("M180 PUT content rejects text over the save cap", async () => {
    const seeded = await seedTextArtifactForSave();
    const res = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${seeded.id}/content`,
      bearer,
      payload: "x".repeat(USER_SAVE_TEXT_LIMIT_BYTES + 1),
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "if-match": String(seeded.revision),
        "x-base-sha256": seeded.sha256,
      },
    });
    expect(res.statusCode).toBe(413);
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe("m180 original\n");
  });

  test("8 create rejects bad path", async () => {
    const badPaths = ["/leading", "a/../b", "", "x".repeat(4097)];
    for (const path of badPaths) {
      const fd = new FormData();
      fd.set("file", new Blob([Uint8Array.from([1])]), "f.bin");
      fd.set("path", path);
      const res = await fx.app.inject({
        method: "POST",
        url: "/api/workspace/artifacts",
        headers: { authorization: `Bearer ${bearer}` },
        payload: fd,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  test("8b create with bad path leaves no orphan file under artifactsRoot (M088C item 6)", async () => {
    const root = process.env["NAUTILO_ARTIFACTS_ROOT"]!;
    const before = await readdir(root).catch(() => []);
    const fd = new FormData();
    fd.set("file", new Blob([Uint8Array.from([1, 2, 3, 4])]), "leak.bin");
    fd.set("path", "/leading-slash-rejected");
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/workspace/artifacts",
      headers: { authorization: `Bearer ${bearer}` },
      payload: fd,
    });
    expect(res.statusCode).toBe(400);
    const after = await readdir(root).catch(() => []);
    // Same set of entries before and after — the rejected upload must
    // not have left a UUID-named blob behind.
    expect(after.length).toBe(before.length);
  });

  test("9b create with collision leaves no orphan file under artifactsRoot (M088C item 6)", async () => {
    const prevRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
    const isolatedRoot = await mkdtemp(join(tmpdir(), "m088c-collision-root-"));
    process.env["NAUTILO_ARTIFACTS_ROOT"] = isolatedRoot;
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const seededPath = `m088c-collision-${Date.now()}.md`;
    const row = await insertArtifact(
      {
        artifactId: `coll-${Date.now()}`,
        path: seededPath,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace(
      { artifactId: row.id, namespaceId: ns },
      dbForArtifactQueries(fx),
    );
    const before = new Set(await readdir(isolatedRoot).catch(() => []));
    try {
      const fd = new FormData();
      fd.set("file", new Blob([Uint8Array.from([9, 9, 9])]), "dup.bin");
      fd.set("path", seededPath);
      const res = await fx.app.inject({
        method: "POST",
        url: "/api/workspace/artifacts",
        headers: { authorization: `Bearer ${bearer}` },
        payload: fd,
      });
      expect(res.statusCode).toBe(409);
      const after = new Set(await readdir(isolatedRoot).catch(() => []));
      expect(after).toEqual(before);
    } finally {
      await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, row.id));
      await fx.db.delete(artifacts).where(eq(artifacts.id, row.id));
      if (prevRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
      else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevRoot;
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("10 create rejects over-cap upload", async () => {
    const prev = process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"];
    process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"] = "1";
    try {
      const fd = new FormData();
      fd.set("file", new Blob([Buffer.alloc(2 * 1024 * 1024)]), "big.bin");
      fd.set("path", `m088c-big-${Date.now()}.bin`);
      const res = await fx.app.inject({
        method: "POST",
        url: "/api/workspace/artifacts",
        headers: { authorization: `Bearer ${bearer}` },
        payload: fd,
      });
      expect(res.statusCode).toBe(413);
    } finally {
      if (prev === undefined) delete process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"];
      else process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"] = prev;
    }
  });

  test("11 rename happy path + bus event", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const row = await insertArtifact(
      {
        artifactId: `rn-${Date.now()}`,
        path: `m088c-rn-old-${Date.now()}.md`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    const captured: ServerEvent[] = [];
    const h = (e: ServerEvent) => {
      if (e.type === "workspace.artifact.renamed") captured.push(e);
    };
    eventBus.on(h);
    try {
      const newPath = `m088c-rn-new-${Date.now()}.md`;
      const patch = await authedInject(fx.app, {
        method: "PATCH",
        url: `/api/workspace/artifacts/${row.id}`,
        bearer,
        payload: { newPath },
      });
      expect(patch.statusCode).toBe(200);
      const dto = JSON.parse(patch.body) as { path: string };
      expect(dto.path).toBe(newPath);
      const g = await authedInject(fx.app, {
        method: "GET",
        url: `/api/workspace/artifacts/${row.id}`,
        bearer,
      });
      const gb = JSON.parse(g.body) as { path: string; canWrite: boolean };
      expect(gb.path).toBe(newPath);
      expect(gb.canWrite).toBe(true);
      expect(captured.some((e) => e.type === "workspace.artifact.renamed" && e.oldPath !== e.newPath)).toBe(
        true,
      );
    } finally {
      eventBus.off(h);
    }
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, row.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, row.id));
  });

  test("12 rename collision 409", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const r1 = await insertArtifact(
      { artifactId: `c1-${Date.now()}`, path: "m088c-col-a.md", storageUri: "file:///tmp/x", size: 0 },
      dbForArtifactQueries(fx),
    );
    const r2 = await insertArtifact(
      { artifactId: `c2-${Date.now()}`, path: "m088c-col-b.md", storageUri: "file:///tmp/x", size: 0 },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: r1.id, namespaceId: ns }, dbForArtifactQueries(fx));
    await attachArtifactToNamespace({ artifactId: r2.id, namespaceId: ns }, dbForArtifactQueries(fx));
    const res = await authedInject(fx.app, {
      method: "PATCH",
      url: `/api/workspace/artifacts/${r1.id}`,
      bearer,
      payload: { newPath: "m088c-col-b.md" },
    });
    expect(res.statusCode).toBe(409);
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, r1.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, r1.id));
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, r2.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, r2.id));
  });

  test("13 rename across namespaces forbidden 404", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const [nsOther] = await fx.db
      .insert(namespaces)
      .values({ scope: "private", label: "m088c-no-member" })
      .returning({ id: namespaces.id });
    if (!nsOther) throw new Error("ns");
    const [roomOther] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: "Lonely",
        graphThreadId: "app:default",
        namespaceId: nsOther.id,
        humanActorIds: [],
        createdBy: fx.ownerActorId,
      })
      .returning({ id: rooms.id });
    if (!roomOther) throw new Error("room");
    await fx.db.update(rooms).set({ graphThreadId: `room:${roomOther.id}` }).where(eq(rooms.id, roomOther.id));
    const row = await insertArtifact(
      {
        artifactId: `nm-${Date.now()}`,
        path: `m088c-nomem-${Date.now()}.md`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: nsOther.id }, dbForArtifactQueries(fx));
    const res = await authedInject(fx.app, {
      method: "PATCH",
      url: `/api/workspace/artifacts/${row.id}`,
      bearer,
      payload: { newPath: "m088c-nomem-renamed.md" },
    });
    expect(res.statusCode).toBe(404);
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, row.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, row.id));
    await fx.db.delete(rooms).where(eq(rooms.id, roomOther.id));
    await fx.db.delete(namespaces).where(eq(namespaces.id, nsOther.id));
  });

  test("14 delete happy path + namespaceIds on bus", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const row = await insertArtifact(
      {
        artifactId: `del-${Date.now()}`,
        path: `m088c-del-${Date.now()}.md`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    const captured: WorkspaceArtifactDeletedEvent[] = [];
    const h = (e: ServerEvent) => {
      if (e.type === "workspace.artifact.deleted") captured.push(e);
    };
    eventBus.on(h);
    try {
      const del = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/workspace/artifacts/${row.id}`,
        bearer,
      });
      expect(del.statusCode).toBe(200);
      const g = await authedInject(fx.app, {
        method: "GET",
        url: `/api/workspace/artifacts/${row.id}`,
        bearer,
      });
      expect(g.statusCode).toBe(404);
      const ev = captured.find((e) => e.type === "workspace.artifact.deleted" && e.id === row.id);
      expect(ev?.namespaceIds).toEqual([ns]);
    } finally {
      eventBus.off(h);
    }
  });

  test("20 range unsatisfiable 416", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const root = process.env["NAUTILO_ARTIFACTS_ROOT"]!;
    const abs = join(root, `range416-${Date.now()}.bin`);
    await writeFile(abs, Buffer.alloc(2000, 0xaa));
    const row = await insertArtifact(
      {
        artifactId: `r416-${Date.now()}`,
        path: `m088c-416-${Date.now()}.bin`,
        storageUri: `file://${abs}`,
        size: 2000,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    const res = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts/${row.id}/bytes`,
      bearer,
      headers: { range: "bytes=99999999-" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */2000");
    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, row.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, row.id));
  });

  test("19+21 range 206 and bytes Content-Type (TCP; inject hangs on hijacked streams)", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const root = process.env["NAUTILO_ARTIFACTS_ROOT"]!;
    const absR = join(root, `range-${Date.now()}.bin`);
    await writeFile(absR, Buffer.alloc(2000, 0xaa));
    const rowR = await insertArtifact(
      {
        artifactId: `rng-${Date.now()}`,
        path: `m088c-range-${Date.now()}.bin`,
        storageUri: `file://${absR}`,
        mimeType: "application/octet-stream",
        size: 2000,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: rowR.id, namespaceId: ns }, dbForArtifactQueries(fx));
    const absP = join(root, `png-${Date.now()}.bin`);
    await writeFile(absP, Buffer.from([137, 80, 78, 71]));
    const rowP = await insertArtifact(
      {
        artifactId: `png-${Date.now()}`,
        path: `m088c-mime-${Date.now()}.png`,
        storageUri: `file://${absP}`,
        mimeType: "image/png",
        size: 4,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: rowP.id, namespaceId: ns }, dbForArtifactQueries(fx));
    try {
      await withListeningServer(fx.app, async (base) => {
        const rPng = await fetch(`${base}/api/workspace/artifacts/${rowP.id}/bytes`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
        expect(rPng.status).toBe(200);
        expect(rPng.headers.get("content-type")).toContain("image/png");
        const rRng = await fetch(`${base}/api/workspace/artifacts/${rowR.id}/bytes`, {
          headers: {
            authorization: `Bearer ${bearer}`,
            range: "bytes=100-199",
          },
        });
        expect(rRng.status).toBe(206);
        expect(rRng.headers.get("content-range")).toBe("bytes 100-199/2000");
        expect(rRng.headers.get("content-length")).toBe("100");
        const buf = Buffer.from(await rRng.arrayBuffer());
        expect(buf.equals(Buffer.alloc(100, 0xaa))).toBe(true);
      });
    } finally {
      await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, rowR.id));
      await fx.db.delete(artifacts).where(eq(artifacts.id, rowR.id));
      await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, rowP.id));
      await fx.db.delete(artifacts).where(eq(artifacts.id, rowP.id));
    }
  });
});

describe("workspace-artifacts pending events (D261 P6b)", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("d261-p6b-events"), withDefaultAgentGraph: true });
    bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
  });

  afterAll(async () => {
    if (fx.defaultAgentId) {
      await fx.db.delete(pendingArtifactEvents).where(eq(pendingArtifactEvents.agentId, fx.defaultAgentId));
    }
    await deleteArtifactsCreatedDuringRun(fx.db);
    await fx.cleanup();
  });

  async function seedArtifactForEvents(): Promise<{ internalId: string; externalId: string }> {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const externalId = `evt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const row = await insertArtifact(
      {
        artifactId: externalId,
        path: `d261-evt-${Date.now()}.html`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    return { internalId: row.id, externalId };
  }

  async function pingTasksForArtifact(externalId: string) {
    return fx.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.ownerId, fx.ownerId),
          eq(tasks.preset, "ping"),
          sql`${tasks.metadata}->>'artifactId' = ${externalId}`,
        ),
      );
  }

  async function pendingEventCountForArtifact(externalId: string): Promise<number> {
    const [row] = await fx.db
      .select({ n: count() })
      .from(pendingArtifactEvents)
      .where(eq(pendingArtifactEvents.artifactId, externalId));
    return Number(row?.n ?? 0);
  }

  test("append event under writable namespace returns ok", async () => {
    const { internalId, externalId } = await seedArtifactForEvents();
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events`,
      bearer,
      payload: { topic: "quiz_submitted", payload: { score: 7, total: 10 } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      artifactId?: string;
      topic?: string;
      id?: string;
      createdAt?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.artifactId).toBe(externalId);
    expect(body.topic).toBe("quiz_submitted");
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
    expect("woke" in body).toBe(false);
    expect(await pingTasksForArtifact(externalId)).toHaveLength(0);
  });

  test("ping event enqueues and creates a preset ping task", async () => {
    const { internalId, externalId } = await seedArtifactForEvents();
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events/ping?roomId=${fx.defaultRoomId}`,
      bearer,
      payload: { topic: "submitted", payload: { ok: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      artifactId?: string;
      topic?: string;
      id?: string;
      createdAt?: string;
      woke?: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.artifactId).toBe(externalId);
    expect(body.topic).toBe("submitted");
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
    expect(body.woke).toBe(true);

    const taskRows = await pingTasksForArtifact(externalId);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.agentId).toBe(fx.defaultAgentId);
    expect(taskRows[0]?.targetChat).toBe("last_in_namespace");
    expect(taskRows[0]?.targetRoomId).toBe(fx.defaultRoomId);
    expect(taskRows[0]?.targetUserIds).toEqual([fx.ownerId]);
    expect(taskRows[0]?.toolsMode).toBe("whitelist");
    expect(taskRows[0]?.toolsWhitelist).toEqual(["read_artifact_events"]);
    expect(taskRows[0]?.awaitResponse).toBe(false);
    expect(taskRows[0]?.resultDelivery).toBe("wake");
    expect(taskRows[0]?.metadata).toEqual({
      artifactId: externalId,
      topic: "submitted",
      source: "artifact_ping",
    });
  });

  test("ping event coalesces when an open ping task already exists", async () => {
    const { internalId, externalId } = await seedArtifactForEvents();
    const agentId = fx.defaultAgentId;
    if (!agentId) throw new Error("agent");
    await fx.db.insert(tasks).values({
      ownerId: fx.ownerId,
      requestorId: fx.ownerId,
      agentId,
      prompt: "seeded open ping",
      preset: "ping",
      status: "pending",
      metadata: { artifactId: externalId, topic: "already_open", source: "artifact_ping" },
    });
    const beforeEvents = await pendingEventCountForArtifact(externalId);

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events/ping`,
      bearer,
      payload: { topic: "second_ping", payload: { n: 2 } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { woke?: boolean; artifactId?: string; topic?: string };
    expect(body.artifactId).toBe(externalId);
    expect(body.topic).toBe("second_ping");
    expect(body.woke).toBe(false);

    expect(await pendingEventCountForArtifact(externalId)).toBe(beforeEvents + 1);
    expect(await pingTasksForArtifact(externalId)).toHaveLength(1);
  });

  test("topic and payload validation rejects invalid input", async () => {
    const { internalId } = await seedArtifactForEvents();
    const emptyTopic = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events`,
      bearer,
      payload: { topic: "", payload: {} },
    });
    expect(emptyTopic.statusCode).toBe(400);

    const missingPayload = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events`,
      bearer,
      payload: { topic: "ok" },
    });
    expect(missingPayload.statusCode).toBe(400);

    const hugePayload = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events`,
      bearer,
      payload: { topic: "big", payload: { data: "x".repeat(33 * 1024) } },
    });
    expect(hugePayload.statusCode).toBe(400);
  });

  test("ring buffer keeps only latest N events for scope", async () => {
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const externalId = `cap-${Date.now()}`;
    const row = await insertArtifact(
      {
        artifactId: externalId,
        path: `d261-cap-${Date.now()}.html`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));

    const total = PENDING_ARTIFACT_EVENTS_CAP + 2;
    for (let i = 0; i < total; i++) {
      await appendPendingArtifactEvent(
        {
          namespaceId: ns,
          agentId: ag,
          artifactId: externalId,
          topic: `evt-${i}`,
          payload: { i },
        },
        dbForArtifactQueries(fx),
      );
    }

    const [cntRow] = await fx.db
      .select({ n: count() })
      .from(pendingArtifactEvents)
      .where(
        and(
          eq(pendingArtifactEvents.namespaceId, ns),
          eq(pendingArtifactEvents.agentId, ag),
          eq(pendingArtifactEvents.artifactId, externalId),
        ),
      );
    expect(cntRow?.n).toBe(PENDING_ARTIFACT_EVENTS_CAP);

    const drained = await drainPendingArtifactEventsForNamespaces(
      { readableNamespaceIds: [ns], agentId: ag, artifactId: externalId },
      dbForArtifactQueries(fx),
    );
    expect(drained.length).toBe(PENDING_ARTIFACT_EVENTS_CAP);
    expect(drained[0]?.topic).toBe("evt-2");
    expect(drained.at(-1)?.topic).toBe(`evt-${total - 1}`);

    await fx.db.delete(artifactNamespaces).where(eq(artifactNamespaces.artifactId, row.id));
    await fx.db.delete(artifacts).where(eq(artifacts.id, row.id));
  });

  test("events do not leak across namespaces", async () => {
    const ctx = await seedTwoRoomTwoUserIsolation(fx);
    const ag = fx.defaultAgentId;
    if (!ag) throw new Error("agent");

    const postOwner = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${ctx.artOwner.id}/events`,
      bearer: ctx.bearerOwner,
      payload: { topic: "owner_only", payload: { ns: "owner" } },
    });
    expect(postOwner.statusCode).toBe(200);

    const postPeerOnOwner = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${ctx.artOwner.id}/events`,
      bearer: ctx.bearerPeer,
      payload: { topic: "peer_try", payload: {} },
    });
    // Current auth may reject the peer before artifact visibility is
    // resolved (403), or the artifact route may hide the row (404).
    // Both are non-leaking outcomes.
    expect([403, 404]).toContain(postPeerOnOwner.statusCode);

    const ownerArt = await fx.db
      .select({ artifactId: artifacts.artifactId })
      .from(artifacts)
      .where(eq(artifacts.id, ctx.artOwner.id))
      .limit(1);
    const externalId = ownerArt[0]?.artifactId;
    if (!externalId) throw new Error("externalId");

    const peerDrain = await drainPendingArtifactEventsForNamespaces(
      { readableNamespaceIds: [ctx.nsPeerRoom], agentId: ag, artifactId: externalId },
      dbForArtifactQueries(fx),
    );
    expect(peerDrain.length).toBe(0);

    const ownerDrain = await drainPendingArtifactEventsForNamespaces(
      { readableNamespaceIds: [ctx.nsOwner], agentId: ag, artifactId: externalId },
      dbForArtifactQueries(fx),
    );
    expect(ownerDrain.length).toBe(1);
    expect(ownerDrain[0]?.topic).toBe("owner_only");

    await teardownIsolationExtras(fx, ctx);
  });

  test("plain emit enqueues and creates no task (M153 S1)", async () => {
    const { internalId } = await seedArtifactForEvents();
    const ownerId = getBootstrapOwnerId();
    const [beforeRow] = await fx.db
      .select({ n: count() })
      .from(tasks)
      .where(eq(tasks.ownerId, ownerId));
    const before = beforeRow?.n ?? 0;

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events`,
      bearer,
      payload: { topic: "no_wake", payload: { x: 1 } },
    });
    expect(res.statusCode).toBe(200);

    const [afterRow] = await fx.db
      .select({ n: count() })
      .from(tasks)
      .where(eq(tasks.ownerId, ownerId));
    expect(afterRow?.n).toBe(before);
  });

  test("ping enqueues and creates one preset=ping task (M153 S2)", async () => {
    const { internalId, externalId } = await seedArtifactForEvents();

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events/ping`,
      bearer,
      payload: { topic: "submitted", payload: { ok: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok?: boolean; woke?: boolean; artifactId?: string };
    expect(body.ok).toBe(true);
    expect(body.woke).toBe(true);
    expect(body.artifactId).toBe(externalId);

    const pingRows = await pingTasksForArtifact(externalId);
    expect(pingRows.length).toBe(1);
    expect(pingRows[0]?.metadata).toMatchObject({
      artifactId: externalId,
      topic: "submitted",
      source: "artifact_ping",
    });

    await fx.db.delete(tasks).where(eq(tasks.id, pingRows[0]!.id));
  });

  test("second ping coalesces to woke:false while still enqueuing (M153 S3)", async () => {
    const { internalId, externalId } = await seedArtifactForEvents();
    const ownerId = getBootstrapOwnerId();
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);

    const farFuture = new Date(Date.now() + 3600_000);
    const [seeded] = await fx.db
      .insert(tasks)
      .values({
        ownerId,
        requestorId: ownerId,
        agentId: ag,
        preset: "ping",
        prompt: "seed open ping",
        status: "pending",
        nextFireAt: farFuture,
        metadata: { artifactId: externalId, topic: "seed", source: "artifact_ping" },
      })
      .returning({ id: tasks.id });

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${internalId}/events/ping`,
      bearer,
      payload: { topic: "burst", payload: { n: 2 } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { woke?: boolean };
    expect(body.woke).toBe(false);

    const pingRows = await pingTasksForArtifact(externalId);
    expect(pingRows.length).toBe(1);

    const [evtRow] = await fx.db
      .select({ n: count() })
      .from(pendingArtifactEvents)
      .where(
        and(
          eq(pendingArtifactEvents.namespaceId, ns),
          eq(pendingArtifactEvents.agentId, ag),
          eq(pendingArtifactEvents.artifactId, externalId),
        ),
      );
    expect(evtRow?.n).toBe(1);

    await fx.db.delete(tasks).where(eq(tasks.id, seeded!.id));
  });

  test("unauthorized ping rejects with no event and no task (M153 S5)", async () => {
    const ctx = await seedTwoRoomTwoUserIsolation(fx);
    const ag = fx.defaultAgentId;
    const ownerId = getBootstrapOwnerId();
    if (!ag) throw new Error("agent");

    const ownerArt = await fx.db
      .select({ artifactId: artifacts.artifactId })
      .from(artifacts)
      .where(eq(artifacts.id, ctx.artOwner.id))
      .limit(1);
    const externalId = ownerArt[0]?.artifactId;
    if (!externalId) throw new Error("externalId");

    const [evtBeforeRow] = await fx.db
      .select({ n: count() })
      .from(pendingArtifactEvents)
      .where(
        and(
          eq(pendingArtifactEvents.namespaceId, ctx.nsOwner),
          eq(pendingArtifactEvents.agentId, ag),
          eq(pendingArtifactEvents.artifactId, externalId),
        ),
      );
    const [taskBeforeRow] = await fx.db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.ownerId, ownerId), eq(tasks.preset, "ping")));

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${ctx.artOwner.id}/events/ping`,
      bearer: ctx.bearerPeer,
      payload: { topic: "peer_try", payload: {} },
    });
    expect([403, 404]).toContain(res.statusCode);

    const [evtAfterRow] = await fx.db
      .select({ n: count() })
      .from(pendingArtifactEvents)
      .where(
        and(
          eq(pendingArtifactEvents.namespaceId, ctx.nsOwner),
          eq(pendingArtifactEvents.agentId, ag),
          eq(pendingArtifactEvents.artifactId, externalId),
        ),
      );
    const [taskAfterRow] = await fx.db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.ownerId, ownerId), eq(tasks.preset, "ping")));
    expect(evtAfterRow?.n).toBe(evtBeforeRow?.n);
    expect(taskAfterRow?.n).toBe(taskBeforeRow?.n);

    await teardownIsolationExtras(fx, ctx);
  });
});

describe("workspace-artifacts scope 501", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({
      suiteName: uniqueSuiteName("m088c-scope"),
      withDefaultAgentGraph: true,
      createAppExtras: {
        policyResolver: scopeEnvelopePolicyResolver(
          new PersonalPolicyResolver(() => getBootstrapOwnerId()),
        ),
      },
    });
    bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
  });

  afterAll(async () => {
    await deleteArtifactsCreatedDuringRun(fx.db);
    await fx.cleanup();
  });

  test("6 scope envelope rejection 501 on all routes", async () => {
    const id = randomUUID();
    const routes: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; payload?: unknown; headers?: Record<string, string> }[] = [
      { method: "GET", url: "/api/workspace/artifacts" },
      { method: "GET", url: `/api/workspace/artifacts/${id}` },
      { method: "GET", url: `/api/workspace/artifacts/${id}/bytes` },
      {
        method: "PUT",
        url: `/api/workspace/artifacts/${id}/content`,
        payload: "scope rejected",
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
      { method: "POST", url: "/api/workspace/artifacts", payload: {} },
      { method: "PATCH", url: `/api/workspace/artifacts/${id}`, payload: { newPath: "x.md" } },
      { method: "DELETE", url: `/api/workspace/artifacts/${id}` },
      { method: "POST", url: `/api/workspace/artifacts/${id}/events`, payload: { topic: "x", payload: {} } },
      { method: "POST", url: `/api/workspace/artifacts/${id}/events/ping`, payload: { topic: "x", payload: {} } },
    ];
    for (const r of routes) {
      const res = await authedInject(fx.app, { ...r, bearer });
      expect(res.statusCode).toBe(501);
      const errBody = JSON.parse(res.body) as { error?: string };
      expect(errBody.error).toBe(SCOPE_MSG);
    }
    await withListeningServer(fx.app, async (base) => {
      const res = await fetch(
        `${base}/api/workspace/artifacts/events?token=${encodeURIComponent(bearer)}`,
      );
      expect(res.status).toBe(501);
    });
  });
});

describe("workspace-artifacts no writable namespace", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({
      suiteName: uniqueSuiteName("m088c-now"),
      withDefaultAgentGraph: true,
      createAppExtras: {
        policyResolver: emptyWritablePolicyResolver(
          new PersonalPolicyResolver(() => getBootstrapOwnerId()),
        ),
      },
    });
    bearer = await fx.mintOwnerBearer();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("9 POST 403 when writableNamespaces empty", async () => {
    const fd = new FormData();
    fd.set("file", new Blob([Uint8Array.from([1, 2, 3])]), "a.bin");
    fd.set("path", `m088c-now-${Date.now()}.md`);
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/workspace/artifacts",
      headers: { authorization: `Bearer ${bearer}` },
      payload: fd,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("workspace-artifacts TCP multipart and SSE", () => {
  test("7 create happy path + disk + bus", async () => {
    const prevRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
    const tmp = await mkdtemp(join(tmpdir(), "m088c-create-"));
    process.env["NAUTILO_ARTIFACTS_ROOT"] = tmp;
    const fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m088c-tcp7"), withDefaultAgentGraph: true });
    const bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
    const ag = fx.defaultAgentId;
    if (!ag) throw new Error("agent");
    const bus: ServerEvent[] = [];
    const h = (e: ServerEvent) => {
      if (e.type === "workspace.artifact.changed") bus.push(e);
    };
    eventBus.on(h);
    try {
      await withListeningServer(fx.app, async (base) => {
        const path = `m088c-up-${Date.now()}.md`;
        const fd = new FormData();
        fd.set("file", new Blob([new TextEncoder().encode("hello m088c")]), "doc.md");
        fd.set("path", path);
        const res = await fetch(`${base}/api/workspace/artifacts`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: fd,
        });
        expect(res.status).toBe(200);
        const dto = (await res.json()) as {
          id: string;
          artifactId: string;
          path: string;
          namespaceIds: string[];
        };
        expect(dto.path).toBe(path);
        const [row] = await fx.db.select().from(artifacts).where(eq(artifacts.id, dto.id)).limit(1);
        expect(row?.path).toBe(path);
        const jn = await fx.db
          .select()
          .from(artifactNamespaces)
          .where(eq(artifactNamespaces.artifactId, dto.id));
        expect(jn.length).toBe(1);
        const diskPath = join(tmp, dto.artifactId);
        const bytes = await readFile(diskPath);
        expect(new TextDecoder().decode(bytes)).toBe("hello m088c");
        expect(bus.some((e) => e.type === "workspace.artifact.changed" && e.id === dto.id)).toBe(true);
      });
    } finally {
      eventBus.off(h);
      await deleteArtifactsCreatedDuringRun(fx.db);
      await fx.cleanup();
      if (prevRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
      else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevRoot;
    }
  });

  test("M180 blank TCP create can save first editor content", async () => {
    const prevRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
    const tmp = await mkdtemp(join(tmpdir(), "m180-blank-create-save-"));
    process.env["NAUTILO_ARTIFACTS_ROOT"] = tmp;
    const fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m180-tcp-blank-save"), withDefaultAgentGraph: true });
    const bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
    const roomId = fx.defaultRoomId;
    if (!roomId) throw new Error("graph");
    try {
      await withListeningServer(fx.app, async (base) => {
        const path = `m180-blank-${Date.now()}-${randomUUID().slice(0, 8)}.md`;
        const fd = new FormData();
        fd.set("file", new Blob([""], { type: "text/markdown" }), "blank.md");
        fd.set("path", path);
        fd.set("mimeType", "text/markdown");
        const createdRes = await fetch(
          `${base}/api/workspace/artifacts?roomId=${encodeURIComponent(roomId)}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}` },
            body: fd,
          },
        );
        expect(createdRes.status).toBe(200);
        const created = (await createdRes.json()) as {
          id: string;
          artifactId: string;
          revision: number;
          size: number;
        };
        expect(created.revision).toBe(1);
        expect(created.size).toBe(0);

        const bytesRes = await fetch(
          `${base}/api/workspace/artifacts/${created.id}/bytes?roomId=${encodeURIComponent(roomId)}`,
          { headers: { authorization: `Bearer ${bearer}` } },
        );
        expect(bytesRes.status).toBe(200);
        expect(await bytesRes.text()).toBe("");

        const next = "first blank editor save\n";
        const saveRes = await fetch(
          `${base}/api/workspace/artifacts/${created.id}/content?roomId=${encodeURIComponent(roomId)}`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "text/markdown",
              "if-match": String(created.revision),
              "x-base-sha256": sha256Hex(""),
              "x-checkpoint": "1",
            },
            body: next,
          },
        );
        expect(saveRes.status).toBe(200);
        const saved = (await saveRes.json()) as { revision: number; size: number; sha256: string };
        expect(saved).toMatchObject({
          revision: 2,
          size: Buffer.byteLength(next, "utf8"),
          sha256: sha256Hex(next),
        });
        expect(await readCurrentArtifactBytes(fx.db, created.id)).toBe(next);
      });
    } finally {
      await deleteArtifactsCreatedDuringRun(fx.db);
      await fx.cleanup();
      if (prevRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
      else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevRoot;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("15 SSE fan-out on create", async () => {
    const prevRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
    const tmp = await mkdtemp(join(tmpdir(), "m088c-sse15-"));
    process.env["NAUTILO_ARTIFACTS_ROOT"] = tmp;
    const fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m088c-tcp15"), withDefaultAgentGraph: true });
    const bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
    try {
      await withListeningServer(fx.app, async (base) => {
        const sse = await fetch(
          `${base}/api/workspace/artifacts/events?token=${encodeURIComponent(bearer)}`,
          { headers: { accept: "text/event-stream" } },
        );
        expect(sse.ok).toBe(true);
        const path = `m088c-sse15-${Date.now()}.md`;
        await sleep(50);
        const post = (async () => {
          const fd = new FormData();
          fd.set("file", new Blob([Uint8Array.from([7, 7, 7])]), "x.bin");
          fd.set("path", path);
          return fetch(`${base}/api/workspace/artifacts`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}` },
            body: fd,
          });
        })();
        const hit = await firstSseWhere(
          sse.body,
          (r) => r.event === "changed" && typeof r.data === "object" && r.data !== null,
          5_000,
        );
        const pr = await post;
        expect(pr.ok).toBe(true);
        expect(hit).not.toBeNull();
        expect((hit!.data as { path?: string }).path).toBe(path);
      });
    } finally {
      await deleteArtifactsCreatedDuringRun(fx.db);
      await fx.cleanup();
      if (prevRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
      else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevRoot;
    }
  });

  test("17 SSE delete event reaches subscriber", async () => {
    const fx = await setupOwnerAppFixture({
      suiteName: uniqueSuiteName("m088c-tcp17"),
      withDefaultAgentGraph: true,
    });
    const bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
    const ag = fx.defaultAgentId;
    const rid = fx.defaultRoomId;
    if (!ag || !rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const row = await insertArtifact(
      {
        artifactId: `sse17-${Date.now()}`,
        path: `m088c-sse17-${Date.now()}.md`,
        storageUri: "file:///tmp/x",
        size: 0,
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    try {
      await withListeningServer(fx.app, async (base) => {
        const sse = await fetch(
          `${base}/api/workspace/artifacts/events?token=${encodeURIComponent(bearer)}`,
          { headers: { accept: "text/event-stream" } },
        );
        expect(sse.ok).toBe(true);
        const delPromise = fetch(`${base}/api/workspace/artifacts/${row.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${bearer}` },
        });
        const hit = await firstSseWhere(
          sse.body,
          (r) =>
            r.event === "deleted" &&
            typeof r.data === "object" &&
            r.data !== null &&
            (r.data as { id?: string }).id === row.id,
          5_000,
        );
        const del = await delPromise;
        expect(del.ok).toBe(true);
        expect(hit).not.toBeNull();
      });
    } finally {
      await deleteArtifactsCreatedDuringRun(fx.db);
      await fx.cleanup();
    }
  });
});

describe("workspace-artifacts M193 patch", () => {
  let fx: AppFixture;
  let bearer: string;
  let baseUrl: string;
  let prevArtifactsRoot: string | undefined;

  beforeAll(async () => {
    prevArtifactsRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
    process.env["NAUTILO_ARTIFACTS_ROOT"] = await mkdtemp(join(tmpdir(), "m193-patch-root-"));
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m193-patch"), withDefaultAgentGraph: true });
    bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);
    baseUrl = (await fx.app.listen({ port: 0, host: "127.0.0.1" })).replace(/\/$/, "");
  });

  afterAll(async () => {
    await deleteArtifactsCreatedDuringRun(fx.db);
    fx.app.server.closeAllConnections?.();
    await fx.cleanup();
    if (prevArtifactsRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
    else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevArtifactsRoot;
  });

  async function seedPatchableTextArtifact(content: string, opts?: { mimeType?: string; pathSuffix?: string }): Promise<{
    id: string;
    path: string;
    absPath: string;
    revision: number;
    sha256: string;
  }> {
    const rid = fx.defaultRoomId;
    if (!rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const root = process.env["NAUTILO_ARTIFACTS_ROOT"]!;
    const externalId = `m193-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const absPath = join(root, externalId);
    await writeFile(absPath, content);
    const path = `m193-${Date.now()}-${randomUUID().slice(0, 8)}${opts?.pathSuffix ?? ".md"}`;
    const row = await insertArtifact(
      {
        artifactId: externalId,
        path,
        storageUri: `file://${absPath}`,
        mimeType: opts?.mimeType ?? "text/plain",
        size: Buffer.byteLength(content, "utf8"),
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    return {
      id: row.id,
      path,
      absPath,
      revision: row.revision,
      sha256: sha256Hex(content),
    };
  }

  test("direct-live artifact patch SSE preserves trusted author and revision chain", async () => {
    const seeded = await seedPatchableTextArtifact("before\n", { pathSuffix: ".design.html" });
      const sse = await fetch(
        `${baseUrl}/api/workspace/artifacts/events?token=${encodeURIComponent(bearer)}`,
        { headers: { accept: "text/event-stream" } },
      );
      expect(sse.ok).toBe(true);
      const nextSha = sha256Hex("after\n");
      await sleep(50);
      eventBus.emit({
        type: "document.patch.applied",
        target: {
          kind: "artifact",
          artifactInternalId: seeded.id,
          path: seeded.path,
          ...(fx.defaultRoomId ? { roomId: fx.defaultRoomId } : {}),
          mimeType: "text/plain",
        },
        patchId: "design-app-tool-patch",
        requestId: "design-app-tool-request",
        revision: seeded.revision + 1,
        sha256: nextSha,
        previousRevision: seeded.revision,
        previousSha256: seeded.sha256,
        patch: { kind: "anchored_text", oldString: "before", newString: "after" },
        author: { kind: "app_tool", displayName: "nautilo-design" },
        rebased: false,
      } satisfies ServerEvent);
      const hit = await firstSseWhere(
        sse.body,
        (record) =>
          record.event === "document.patch.applied" &&
          typeof record.data === "object" &&
          record.data !== null &&
          (record.data as { patchId?: string }).patchId === "design-app-tool-patch",
        5_000,
      );
      expect(hit?.data).toMatchObject({
        patchId: "design-app-tool-patch",
        requestId: "design-app-tool-request",
        revision: seeded.revision + 1,
        previousRevision: seeded.revision,
        sha256: nextSha,
        previousSha256: seeded.sha256,
        author: { kind: "app_tool", displayName: "nautilo-design" },
        rebased: false,
      });
      await sse.body?.cancel();
  });

  test("M193 exact-base patch success", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const seeded = await seedPatchableTextArtifact(original);

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${seeded.id}/patch`,
      bearer,
      payload: documentPatchPayload({
        artifactId: seeded.id,
        path: seeded.path,
        baseRevision: seeded.revision,
        baseSha256: seeded.sha256,
        oldString: "beta",
        newString: "beta2",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      kind: string;
      revision: number;
      sha256: string;
      rebased: boolean;
      patch: { kind: string; oldString: string; newString: string };
    };
    expect(body.kind).toBe("applied");
    expect(body.rebased).toBe(false);
    expect(body.revision).toBe(seeded.revision + 1);
    expect(body.patch).toEqual({ kind: "anchored_text", oldString: "beta", newString: "beta2" });
    const expected = "alpha\nbeta2\ngamma\n";
    expect(body.sha256).toBe(sha256Hex(expected));
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(expected);
  });

  test("M193 stale non-overlap rebase success", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const seeded = await seedPatchableTextArtifact(original);
    const external = "alpha\nXXX\ngamma\n";

    const save = await authedInject(fx.app, {
      method: "PUT",
      url: `/api/workspace/artifacts/${seeded.id}/content`,
      bearer,
      payload: external,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "if-match": String(seeded.revision),
        "x-base-sha256": seeded.sha256,
      },
    });
    expect(save.statusCode).toBe(200);
    const saved = JSON.parse(save.body) as { revision: number; sha256: string };

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${seeded.id}/patch`,
      bearer,
      payload: documentPatchPayload({
        artifactId: seeded.id,
        path: seeded.path,
        baseRevision: seeded.revision,
        baseSha256: seeded.sha256,
        oldString: "gamma",
        newString: "gamma patched",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { kind: string; rebased: boolean; revision: number };
    expect(body.kind).toBe("applied");
    expect(body.rebased).toBe(true);
    expect(body.revision).toBe(saved.revision + 1);
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe("alpha\nXXX\ngamma patched\n");
  });

  test("M193 anchor_not_found conflict 409 shape", async () => {
    const original = "hello world\n";
    const seeded = await seedPatchableTextArtifact(original);

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${seeded.id}/patch`,
      bearer,
      payload: documentPatchPayload({
        artifactId: seeded.id,
        path: seeded.path,
        baseRevision: seeded.revision,
        baseSha256: seeded.sha256,
        oldString: "goodbye",
        newString: "farewell",
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      kind: "anchor_not_found",
      latestRevision: seeded.revision,
      latestSha256: seeded.sha256,
    });
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(original);
  });

  test("M193 anchor_ambiguous conflict 409 shape", async () => {
    const original = "foo bar foo\n";
    const seeded = await seedPatchableTextArtifact(original);

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${seeded.id}/patch`,
      bearer,
      payload: documentPatchPayload({
        artifactId: seeded.id,
        path: seeded.path,
        baseRevision: seeded.revision,
        baseSha256: seeded.sha256,
        oldString: "foo",
        newString: "baz",
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      kind: "anchor_ambiguous",
      latestRevision: seeded.revision,
      latestSha256: seeded.sha256,
    });
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(original);
  });

  test("M193 binary artifact patch returns typed unsupported rejection", async () => {
    const original = "not actually png bytes\n";
    const seeded = await seedPatchableTextArtifact(original, {
      mimeType: "image/png",
      pathSuffix: ".png",
    });

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${seeded.id}/patch`,
      bearer,
      payload: documentPatchPayload({
        artifactId: seeded.id,
        path: seeded.path,
        baseRevision: seeded.revision,
        baseSha256: seeded.sha256,
        oldString: "png",
        newString: "text",
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      kind: "unsupported",
      reason: "Document patch protocol only supports text-like workspace artifacts.",
    });
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(original);
  });

  test("M193 oversized patch payload returns too_large", async () => {
    const base = "m193 base\n";
    const seeded = await seedPatchableTextArtifact(base);

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${seeded.id}/patch`,
      bearer,
      payload: documentPatchPayload({
        artifactId: seeded.id,
        path: seeded.path,
        baseRevision: seeded.revision,
        baseSha256: seeded.sha256,
        oldString: "a".repeat(USER_SAVE_TEXT_LIMIT_BYTES + 1),
        newString: "small",
      }),
    });

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({
      kind: "too_large",
      reason: `patch payload exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit`,
    });
    expect(await readCurrentArtifactBytes(fx.db, seeded.id)).toBe(base);
  });

});

describe("workspace-artifacts M193 patch namespace auth", () => {
  let fx: AppFixture;
  let ctx: IsoSeed;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: uniqueSuiteName("m193-patch-auth"), withDefaultAgentGraph: true });
    ctx = await seedTwoRoomTwoUserIsolation(fx);
  });

  afterAll(async () => {
    await teardownIsolationExtras(fx, ctx);
    await fx.cleanup();
  });

  test("M193 invisible artifact patch returns 404", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${ctx.artOwner.id}/patch`,
      bearer: ctx.bearerPeer,
      payload: documentPatchPayload({
        artifactId: ctx.artOwner.id,
        path: ctx.artOwner.path,
        baseRevision: 1,
        baseSha256: sha256Hex(""),
        oldString: "x",
        newString: "y",
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

});

describe("workspace-artifacts M193 readable-not-mutable patch", () => {
  let fx: AppFixture;
  let bearer: string;
  let prevArtifactsRoot: string | undefined;
  let artifactId: string;
  let artifactPath: string;

  beforeAll(async () => {
    prevArtifactsRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
    process.env["NAUTILO_ARTIFACTS_ROOT"] = await mkdtemp(join(tmpdir(), "m193-readonly-patch-"));
    fx = await setupOwnerAppFixture({
      suiteName: uniqueSuiteName("m193-readonly-patch"),
      withDefaultAgentGraph: true,
      createAppExtras: {
        policyResolver: readOnlyMutablePolicyResolver(
          new PersonalPolicyResolver(() => getBootstrapOwnerId()),
        ),
      },
    });
    bearer = await fx.mintOwnerBearer();
    await ensureArtifactBaseline(fx.db);

    const rid = fx.defaultRoomId;
    if (!rid) throw new Error("graph");
    const ns = await namespaceIdForRoom(fx.db, rid);
    const root = process.env["NAUTILO_ARTIFACTS_ROOT"];
    if (!root) throw new Error("NAUTILO_ARTIFACTS_ROOT missing");
    const externalId = `m193-ro-${randomUUID().slice(0, 8)}`;
    const absPath = join(root, externalId);
    const content = "readable only\n";
    await writeFile(absPath, content);
    artifactPath = `m193-ro-${Date.now()}.md`;
    const row = await insertArtifact(
      {
        artifactId: externalId,
        path: artifactPath,
        storageUri: `file://${absPath}`,
        mimeType: "text/plain",
        size: Buffer.byteLength(content, "utf8"),
      },
      dbForArtifactQueries(fx),
    );
    await attachArtifactToNamespace({ artifactId: row.id, namespaceId: ns }, dbForArtifactQueries(fx));
    artifactId = row.id;
  });

  afterAll(async () => {
    await deleteArtifactsCreatedDuringRun(fx.db);
    await fx.cleanup();
    if (prevArtifactsRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
    else process.env["NAUTILO_ARTIFACTS_ROOT"] = prevArtifactsRoot;
  });

  test("M193 readable-not-mutable patch returns 403", async () => {
    const list = await authedInject(fx.app, {
      method: "GET",
      url: `/api/workspace/artifacts/${artifactId}`,
      bearer,
    });
    expect(list.statusCode).toBe(200);
    expect((JSON.parse(list.body) as { canWrite: boolean }).canWrite).toBe(false);

    const res = await authedInject(fx.app, {
      method: "POST",
      url: `/api/workspace/artifacts/${artifactId}/patch`,
      bearer,
      payload: documentPatchPayload({
        artifactId,
        path: artifactPath,
        baseRevision: 1,
        baseSha256: sha256Hex("readable only\n"),
        oldString: "readable only",
        newString: "mutated",
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Artifact is not writable in this context" });
  });
});
