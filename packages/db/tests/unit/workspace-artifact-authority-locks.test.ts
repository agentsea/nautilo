import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { actors } from "../../src/schema/trust";
import { rooms, roomMembers } from "../../src/schema/rooms";
import { lockWorkspaceRoomMutationAuthority } from "../../src/queries/artifacts";
import type { WorkspaceDocumentMutationTx } from "../../src/queries/workspace-document-mutations";
import type { RoomAuthoritySnapshot } from "../../src/queries/room-authority-locks";

const source: RoomAuthoritySnapshot = { id: "z-source", namespaceId: "ns-source", kind: "group",
  parentRoomId: null, humanActorIds: ["human-a"], namespaceAccessRevision: 3 };
const peer: RoomAuthoritySnapshot = { ...source, id: "a-peer", namespaceId: "ns-peer" };
const params = { humanActorId: "human-a", agentId: "agent-a", roomId: source.id };

function fixture(responses: readonly (readonly unknown[])[]) {
  const pending = [...responses];
  const queries: Array<{ table: unknown; lock: string; params: unknown[] }> = [];
  const tx = { select: () => {
    let table: unknown, query: SQL, lock = "none";
    const chain = {
      from(value: unknown) { table = value; return chain; },
      leftJoin() { return chain; },
      where(value: SQL) { query = value; return chain; },
      limit() { return chain; },
      for(value: string) { lock = value; return chain; },
      then(resolve: (rows: readonly unknown[]) => unknown, reject: (error: unknown) => unknown) {
        const next = pending.shift();
        if (!next) return Promise.reject(new Error("unexpected query")).then(resolve, reject);
        queries.push({ table, lock, params: new PgDialect().sqlToQuery(query).params });
        return Promise.resolve(next).then(resolve, reject);
      },
    };
    return chain;
  } };
  return { tx: tx as unknown as WorkspaceDocumentMutationTx, queries,
    assertConsumed: () => expect(pending).toHaveLength(0) };
}

function discovery(current = source) {
  return [[{ ...current, publicBoundaryRoomId: null }], [source, peer],
    [source, peer], [source, peer], [peer], [source]];
}

describe("Workspace Artifact current-Room writer lock order", () => {
  test("all sorted Rooms precede Human/Agent member locks, including the source Room", async () => {
    const f = fixture([...discovery(), [source, peer],
      [{ actorId: "human-a" }], [{ id: "agent-actor" }], [{ actorId: "agent-actor" }]]);
    const result = await lockWorkspaceRoomMutationAuthority(params, f.tx);
    expect(result).toEqual({ createNamespaceId: "ns-source", readableNamespaceIds: ["ns-source", "ns-peer"] });
    const locks = f.queries.filter((query) => query.lock !== "none");
    expect(locks.map((query) => query.table)).toEqual([rooms, rooms, roomMembers, actors, roomMembers]);
    expect(locks.slice(0, 2).map((query) => query.params)).toEqual([[peer.id], [source.id]]);
    expect(locks.every((query) => query.lock === "update")).toBe(true);
    f.assertConsumed();
  });

  test("a new readable Room after discovery returns unavailable without taking a late Room lock", async () => {
    const f = fixture([...discovery(), [source, peer, { ...peer, id: "new-room" }]]);
    expect(await lockWorkspaceRoomMutationAuthority(params, f.tx)).toBeNull();
    expect(f.queries.filter((query) => query.lock !== "none").map((query) => query.params)).toEqual([[peer.id], [source.id]]);
    expect(f.queries.some((query) => query.table === actors || query.table === roomMembers)).toBe(false);
    f.assertConsumed();
  });

  test("the originally selected source audience cannot drift between discovery reads", async () => {
    const f = fixture(discovery({ ...source, humanActorIds: ["human-a", "human-b"] }));
    expect(await lockWorkspaceRoomMutationAuthority(params, f.tx)).toBeNull();
    f.assertConsumed();
  });

  test("known lock-discovery drift retains the existing null authority result", async () => {
    const responses = discovery();
    responses[responses.length - 1] = [{ ...source, namespaceAccessRevision: 4 }];
    const f = fixture(responses);
    expect(await lockWorkspaceRoomMutationAuthority(params, f.tx)).toBeNull();
    expect(f.queries.some((query) => query.table === actors || query.table === roomMembers)).toBe(false);
    f.assertConsumed();
  });
});
