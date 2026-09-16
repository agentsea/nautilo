import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as db from "@nautilo/db";
import { ContentAccessAuthorityError } from "../../src/content-access-authority";
let rejected = false;
const queries: unknown[] = [];
const authority = mock(async () => {
  if (rejected) throw new ContentAccessAuthorityError("wrong_mode");
  return { attachments: [
    { namespaceId: "visible-access", roomId: "invisible-access-room", kind: "access", humanActorIds: ["a", "b"], mutable: true },
    { namespaceId: "dynamic-namespace", roomId: "team", kind: "dynamic", humanActorIds: ["a", "c"], mutable: true },
    { namespaceId: "hidden-namespace", roomId: "hidden-room", kind: "access", humanActorIds: ["hidden-person"], mutable: false },
  ] };
});
mock.module("../../src/content-access-authority", () => ({ ContentAccessAuthorityError, lockContentAccessAuthorityInTx: authority }));
mock.module("@nautilo/db", () => ({ ...db, inArray: (column: unknown, values: string[]) => ({ column, values }),
  getSharedDirectDb: () => ({ transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ select: () => {
    let table: unknown;
    const chain = { from(value: unknown) { table = value; return chain; }, innerJoin() { return chain; },
      where(query: unknown) { queries.push(query); return chain; },
      async orderBy() { return table === db.actors
        ? [{ actorId: "a", displayName: "Alice", userHandle: "alice" }, { actorId: "b", displayName: "Bob", userHandle: "bob" },
          { actorId: "c", displayName: "Carol", userHandle: "carol" }]
        : [{ roomId: "team", label: "Team", kind: "group" }]; } };
    return chain;
  } }) }),
}));
const { inspectContentAccess } = await import("../../src/content-access-summary");
afterAll(() => mock.restore());
beforeEach(() => { rejected = false; queries.length = 0; authority.mockClear(); });
const admission = { principal: { kind: "human" as const, userId: "user-a", actorId: "a", sourceRoomId: "source" },
  audienceContract: "invoking_room" as const, approvalContext: "human-management" };
const object = { kind: "artifact" as const, id: "object" };

test("projects authorized direct people and dynamic Rooms, keeping hidden facts opaque", async () => {
  const summary = await inspectContentAccess(admission, object);
  expect(summary).toEqual({ object, people: [
    { actorId: "a", displayName: "Alice", userHandle: "alice", canRemove: false,
      sources: [{ kind: "immutable", boundaryCount: 1 }, { kind: "room", roomId: "team", label: "Team", publicRoom: false }] },
    { actorId: "b", displayName: "Bob", userHandle: "bob", canRemove: true, sources: [{ kind: "immutable", boundaryCount: 1 }] },
    { actorId: "c", displayName: "Carol", userHandle: "carol", canRemove: false,
      sources: [{ kind: "room", roomId: "team", label: "Team", publicRoom: false }] },
  ], rooms: [{ roomId: "team", label: "Team", publicRoom: false, canDetach: true }], otherAccessCount: 1 });
  expect(queries.map((query) => (query as { values: string[] }).values)).toEqual([["a", "b", "c"], ["team"]]);
  expect(JSON.stringify(summary)).not.toContain("namespace");
  expect(JSON.stringify(summary)).not.toContain("hidden-person");
  expect(JSON.stringify(summary)).not.toContain("hidden-room");
});

test("encrypted policy or authority failure returns no source facts", async () => {
  rejected = true;
  expect(await inspectContentAccess(admission, object)).toEqual({ outcome: "stale", stateChanged: false,
    receiptPersisted: false, recovery: "prepare_again" });
  expect(queries).toHaveLength(0);
});

test("does not expose a Human management summary through Agent or legacy admission", async () => {
  expect((await inspectContentAccess({ ...admission, audienceContract: "legacy_personal_grant" }, object))).toHaveProperty("outcome", "denied");
  expect((await inspectContentAccess({ ...admission, principal: { ...admission.principal, kind: "agent", agentId: "agent" } }, object))).toHaveProperty("outcome", "denied");
  expect(authority).not.toHaveBeenCalled();
});
