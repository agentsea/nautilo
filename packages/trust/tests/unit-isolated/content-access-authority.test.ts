import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as db from "@nautilo/db";
import type { InviteSeedTx, RoomAuthoritySnapshot } from "@nautilo/db";

type Response = { table: unknown; rows: readonly unknown[] };
let policy = { mode: "plaintext_only", revision: 7 };
const predicates: Array<{ humans: string[]; isPublic: boolean }> = [];
mock.module("@nautilo/db", () => ({ ...db,
  acquireEncryptionConsumptionFence: async () => policy,
  namespaceSubsetPredicate: (humans: string[], isPublic: boolean) => {
    predicates.push({ humans, isPublic }); return { humans, isPublic };
  },
}));
const { lockContentAccessAuthorityInTx, ContentAccessAuthorityError } = await import("../../src/content-access-authority");
afterAll(() => mock.restore());
beforeEach(() => { policy = { mode: "plaintext_only", revision: 7 }; predicates.length = 0; });

const principal = { kind: "human" as const, actorId: "human-a", userId: "user-a", sourceRoomId: "source" };
const source: RoomAuthoritySnapshot = { id: "source", namespaceId: "source-ns", kind: "group",
  humanActorIds: ["human-a", "human-b"], parentRoomId: null, namespaceAccessRevision: 2 };
const object = { kind: "artifact" as const, id: "artifact-a" };
const objectRow = { id: object.id, revision: 3, updatedAt: new Date("2026-01-02") };
const body = { path: "notes/a.txt", mimeType: "text/plain", size: 12, storageUri: "ordinary://artifact-a" };
const r = (table: unknown, rows: readonly unknown[]): Response => ({ table, rows });

function fixture(responses: readonly Response[]) {
  const pending = [...responses];
  const events: Array<{ table: unknown; lock: string; rows: readonly unknown[] }> = [];
  const tx = {
    select: () => {
      let table: unknown, lock = "none";
      const chain: Record<string, unknown> = {};
      chain["from"] = (value: unknown) => { table = value; return chain; };
      for (const method of ["innerJoin", "where", "orderBy"]) chain[method] = () => chain;
      chain["for"] = (value: string) => { lock = value; return chain; };
      chain["then"] = (resolve: (value: readonly unknown[]) => unknown, reject: (error: unknown) => unknown) => {
        const next = pending.shift();
        if (!next || next.table !== table) return Promise.reject(new Error("unexpected query")).then(resolve, reject);
        events.push({ table, lock, rows: next.rows });
        return Promise.resolve(next.rows).then(resolve, reject);
      };
      return chain;
    },
  };
  return { tx: tx as unknown as InviteSeedTx, events, assertConsumed: () => expect(pending).toHaveLength(0) };
}

function discovery(boundaries: RoomAuthoritySnapshot[] = [source], entry = source,
  namespaces = ["source-ns"]) {
  return [r(db.rooms, [entry]), r(db.artifactNamespaces, namespaces.map((id) => ({ id }))),
    r(db.rooms, [entry]), r(db.rooms, boundaries),
    ...[...boundaries].sort((a, b) => Number(a.kind === "subthread") - Number(b.kind === "subthread")
      || a.id.localeCompare(b.id)).map((room) => r(db.rooms, [room]))];
}

function identity(agent = false) {
  return [r(db.actors, [{ actorId: "human-a" }]), r(db.groupMembers, [{ capability: "write_artifacts" }]),
    ...(agent ? [r(db.groupMembers, [{ capability: "use_share_artifact" }])] : []),
    r(db.roomMembers, [{ actorId: "human-a" }]),
    ...(agent ? [r(db.actors, [{ actorId: "agent-actor" }])] : [])];
}

function content(namespaces = ["source-ns"], readable = ["source-ns"]) {
  return [r(db.artifacts, [objectRow]), r(db.artifactNamespaces, namespaces.map((id) => ({ id }))),
    r(db.rooms, readable.map((namespaceId) => ({ namespaceId }))), r(db.artifacts, [body])];
}

async function denied(operation: Promise<unknown>, reason: "denied" | "stale" | "unavailable" | "wrong_mode") {
  const error = await operation.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContentAccessAuthorityError);
  expect((error as InstanceType<typeof ContentAccessAuthorityError>).reason).toBe(reason);
}

describe("ordinary content access authority lock phases", () => {
  test("rejects mode/policy drift before any discovery or authored data read", async () => {
    const f = fixture([]);
    policy = { mode: "shadow_encryption", revision: 8 };
    await denied(lockContentAccessAuthorityInTx(f.tx, { principal, object }), "wrong_mode");
    policy = { mode: "plaintext_only", revision: 8 };
    await denied(lockContentAccessAuthorityInTx(f.tx, { principal, object, expectedPolicyRevision: 7 }), "stale");
    expect(f.events).toEqual([]);
  });

  test("locks every Room before identities/members and object, with no late Room lock", async () => {
    const f = fixture([...discovery(), ...identity(), ...content()]);
    const result = await lockContentAccessAuthorityInTx(f.tx, { principal, object });
    expect(result.sourceContext.humanActorIds).toEqual(["human-a", "human-b"]);
    expect(result.display).toEqual({ kind: "artifact", path: body.path, mimeType: body.mimeType, size: body.size });
    expect(result.display).not.toHaveProperty("storageUri");
    const firstIdentity = f.events.findIndex((e) => e.table === db.actors);
    const firstObject = f.events.findIndex((e) => e.table === db.artifacts);
    const roomLocks = f.events.map((e, i) => e.table === db.rooms && e.lock !== "none" ? i : -1).filter((i) => i >= 0);
    expect(roomLocks.every((i) => i < firstIdentity && i < firstObject)).toBe(true);
    expect(f.events.filter((e) => e.table === db.artifactNamespaces).map((e) => e.lock)).toEqual(["none", "update"]);
    f.assertConsumed();
  });

  test("locks a subthread's parent before its child and uses inherited public Human audience", async () => {
    const child: RoomAuthoritySnapshot = { ...source, id: "a-child", kind: "subthread", parentRoomId: "z-parent", humanActorIds: ["human-a"] };
    const parent: RoomAuthoritySnapshot = { ...source, id: "z-parent", kind: "open" };
    const f = fixture([...discovery([child, parent], child), ...identity(), ...content()]);
    const result = await lockContentAccessAuthorityInTx(f.tx, { principal: { ...principal, sourceRoomId: child.id }, object });
    expect(result.sourceContext.humanActorIds).toEqual(["human-a", "human-b"]);
    expect(predicates).toEqual([{ humans: ["human-a", "human-b"], isPublic: true }]);
    const locked = f.events.filter((e) => e.table === db.rooms && e.lock === "share");
    expect(locked.map((e) => (e.rows[0] as RoomAuthoritySnapshot).id)).toEqual(["z-parent", "a-child"]);
    f.assertConsumed();
  });

  test("denies disabled identity and missing capability before object read", async () => {
    const disabled = fixture([...discovery(), r(db.actors, [])]);
    await denied(lockContentAccessAuthorityInTx(disabled.tx, { principal, object }), "denied");
    const capability = fixture([...discovery(), r(db.actors, [{ actorId: "human-a" }]), r(db.groupMembers, [])]);
    await denied(lockContentAccessAuthorityInTx(capability.tx, { principal, object }), "denied");
    expect([...disabled.events, ...capability.events].some((e) => e.table === db.artifacts)).toBe(false);
  });

  test("requires current Agent capabilities and membership before object lock", async () => {
    const f = fixture([...discovery(), ...identity(true), ...content()]);
    await lockContentAccessAuthorityInTx(f.tx, { principal: { ...principal, kind: "agent", agentId: "agent-a" }, object });
    expect(f.events.filter((e) => e.table === db.groupMembers)).toHaveLength(2);
    expect(f.events.filter((e) => e.table === db.actors)).toHaveLength(2);
    f.assertConsumed();
  });

  test("actual immutable roster is proved before reuse and before object lock", async () => {
    const access: RoomAuthoritySnapshot = { ...source, id: "access", namespaceId: "access-ns", kind: "access" };
    const f = fixture([...discovery([source, access], source, ["access-ns"]), ...identity(),
      r(db.roomMembers, [{ actorId: "human-a", kind: "user" }, { actorId: "unexpected-agent", kind: "agent" }])]);
    await denied(lockContentAccessAuthorityInTx(f.tx, { principal, object }), "stale");
    expect(f.events.some((e) => e.table === db.artifacts)).toBe(false);
    f.assertConsumed();
  });

  test("unrelated attachment added during object wait does not stale or widen an additive grant", async () => {
    const f = fixture([...discovery(), ...identity(), ...content(["source-ns", "new-access-ns"])]);
    const result = await lockContentAccessAuthorityInTx(f.tx, { principal, object, intent: { additive: true } });
    expect(result.attachments.map((a) => a.namespaceId)).toEqual(["source-ns"]);
    expect(result.sourceContext.humanActorIds).toEqual(["human-a", "human-b"]);
    expect(f.events.filter((e) => e.table === db.rooms && e.lock !== "none")).toHaveLength(1);
    f.assertConsumed();
  });

  test("destructive operations reject new attachment Rooms instead of acquiring late locks", async () => {
    const f = fixture([...discovery(), ...identity(), r(db.artifacts, [objectRow]),
      r(db.artifactNamespaces, [{ id: "source-ns" }, { id: "new-ns" }])]);
    await denied(lockContentAccessAuthorityInTx(f.tx, { principal, object, intent: { additive: false } }), "stale");
    f.assertConsumed();
  });

  test("source proof removed while waiting denies authored body access", async () => {
    const f = fixture([...discovery(), ...identity(), r(db.artifacts, [objectRow]),
      r(db.artifactNamespaces, [{ id: "new-ns" }]), r(db.rooms, [])]);
    await denied(lockContentAccessAuthorityInTx(f.tx, { principal, object, intent: { additive: true } }), "denied");
    expect(f.events.filter((e) => e.table === db.artifacts)).toHaveLength(1);
    f.assertConsumed();
  });
});
