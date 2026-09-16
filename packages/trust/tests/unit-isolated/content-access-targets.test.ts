import { describe, expect, test } from "bun:test";
import { actors, rooms, roomMembers, type InviteSeedTx, type RoomAuthoritySnapshot } from "@nautilo/db";
import { ContentAccessAuthorityError } from "../../src/content-access-authority";
import { lockContentAccessHumansInTx, discoverContentAccessPrivateTargetInTx,
  lockContentAccessRoomTargetInTx } from "../../src/content-access-targets";

const principal = { kind: "human" as const, userId: "user-a", actorId: "human-a", sourceRoomId: "source" };
const member = { actorId: "human-a" };
const room: RoomAuthoritySnapshot = { id: "source", namespaceId: "source-ns", kind: "group", parentRoomId: null,
  humanActorIds: ["human-a", "human-b"], namespaceAccessRevision: 2 };

function fixture(responses: Array<{ table: unknown; rows: readonly unknown[] }>) {
  const pending = [...responses];
  const locks: string[] = [];
  const tx = {
    select: () => {
      let table: unknown;
      let lock: string | undefined;
      const chain: Record<string, unknown> = {};
      chain["from"] = (value: unknown) => { table = value; return chain; };
      for (const method of ["where", "innerJoin", "orderBy"]) chain[method] = () => chain;
      chain["for"] = (value: string) => { lock = value; return chain; };
      chain["then"] = (resolve: (value: readonly unknown[]) => unknown,
        reject: (error: unknown) => unknown) => {
        const response = pending.shift();
        if (!response || response.table !== table) return Promise.reject(new Error("unexpected query")).then(resolve, reject);
        locks.push(lock ?? "none");
        return Promise.resolve(response.rows).then(resolve, reject);
      };
      return chain;
    },
  };
  return { tx: tx as unknown as InviteSeedTx, locks,
    assertConsumed: () => expect(pending).toHaveLength(0) };
}

async function expectDenied(promise: Promise<unknown>, reason: "denied" | "unavailable") {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContentAccessAuthorityError);
  expect((error as ContentAccessAuthorityError).reason).toBe(reason);
}

describe("content access target resolution", () => {
  test("requires every selected local active Human and retains identity locks", async () => {
    const valid = fixture([{ table: actors, rows: [
      { actorId: "human-a", userId: "user-a" }, { actorId: "human-b", userId: "user-b" },
    ] }]);
    expect(await lockContentAccessHumansInTx(valid.tx, ["human-b", "human-a", "human-a"])).toHaveLength(2);
    expect(valid.locks).toEqual(["share"]);
    const disabled = fixture([{ table: actors, rows: [{ actorId: "human-a", userId: "user-a" }] }]);
    await expectDenied(lockContentAccessHumansInTx(disabled.tx, ["human-a", "human-disabled"]), "denied");
  });

  test("subthread entry resolves its owning Namespace and full Human audience", async () => {
    const f = fixture([
      { table: roomMembers, rows: [member] },
      { table: roomMembers, rows: [{ actorId: "human-a" }, { actorId: "human-b" }] },
    ]);
    const target = await lockContentAccessRoomTargetInTx(f.tx, principal, "source", [
      { ...room, kind: "subthread", parentRoomId: "parent", humanActorIds: ["human-a"] },
      { ...room, id: "parent", kind: "open" },
    ]);
    expect(target.destination).toEqual({ roomId: "parent", namespaceId: "source-ns", humanActorIds: ["human-a", "human-b"] });
    expect(target.authority).toMatchObject({ requestedRoomId: "source", requestedKind: "subthread", ownerKind: "open", ownerRevision: 2 });
    expect(f.locks).toEqual(["share", "share"]);
    f.assertConsumed();
  });

  test("requires target entry membership and rejects access Rooms or ambiguous Namespace ownership", async () => {
    const missingMember = fixture([{ table: roomMembers, rows: [] }]);
    await expectDenied(lockContentAccessRoomTargetInTx(missingMember.tx, principal, "source", [room]), "denied");
    const access = fixture([]);
    await expectDenied(lockContentAccessRoomTargetInTx(access.tx, principal, "source", [{ ...room, kind: "access" }]), "denied");
    const ambiguous = fixture([{ table: roomMembers, rows: [member] }]);
    await expectDenied(lockContentAccessRoomTargetInTx(ambiguous.tx, principal, "source", [
      { ...room, kind: "subthread" }, { ...room, id: "parent" }, { ...room, id: "other" },
    ]), "denied");
  });

  test("reuses the invoking canonical private Room without an invented Agent", async () => {
    const f = fixture([
      { table: rooms, rows: [{ ...room, kind: "private", humanActorIds: ["human-a"] }] },
      { table: rooms, rows: [{ ...room, kind: "private", humanActorIds: ["human-a"] }] },
    ]);
    const result = await discoverContentAccessPrivateTargetInTx(f.tx, principal);
    expect(result.roomId).toBe("source");
    expect(f.locks).toEqual(["none", "none"]);
    f.assertConsumed();
  });

  test("rejects a target audience inconsistent with actual Human membership", async () => {
    const f = fixture([
      { table: roomMembers, rows: [member] },
      { table: roomMembers, rows: [member] },
    ]);
    await expectDenied(lockContentAccessRoomTargetInTx(f.tx, principal, "source", [room]), "unavailable");
    f.assertConsumed();
  });

  test("a private Room backed by a public Namespace is not a private destination", async () => {
    const f = fixture([
      { table: rooms, rows: [{ ...room, kind: "private", humanActorIds: ["human-a"] }] },
      { table: rooms, rows: [{ ...room, kind: "private" }, { ...room, id: "public", kind: "open" }] },
    ]);
    await expectDenied(discoverContentAccessPrivateTargetInTx(f.tx, principal), "unavailable");
    f.assertConsumed();
  });

  test("a shared source without a bound Agent cannot guess a default private destination", async () => {
    const f = fixture([{ table: rooms, rows: [room] }, { table: rooms, rows: [room] }]);
    await expectDenied(discoverContentAccessPrivateTargetInTx(f.tx, principal), "unavailable");
    f.assertConsumed();
  });

  test("bound Agent resolution uses the existing canonical private selector and locks both member edges", async () => {
    const privateRoom: RoomAuthoritySnapshot = { ...room, id: "personal", namespaceId: "personal-ns", kind: "private", humanActorIds: ["human-a"] };
    const f = fixture([
      { table: rooms, rows: [room] },
      { table: rooms, rows: [room] },
      { table: actors, rows: [{ actorId: "agent-actor" }] },
      { table: rooms, rows: [
        { id: "not-personal", type: "private", graphThreadId: "app:default", createdAt: new Date(0), humanActorIds: ["human-a", "human-b"] },
        { id: "personal", type: "private", graphThreadId: "room:personal", createdAt: new Date(1), humanActorIds: ["human-a"] },
      ] },
    ]);
    const selected = await discoverContentAccessPrivateTargetInTx(f.tx, { ...principal, agentId: "bound-agent" });
    expect(selected).toEqual({ roomId: "personal", boundAgentActorId: "agent-actor" });
    expect(f.locks).toEqual(["none", "none", "none", "none"]);
    f.assertConsumed();
    const proof = fixture([
      { table: roomMembers, rows: [member] },
      { table: roomMembers, rows: [member] },
      { table: roomMembers, rows: [{ actorId: "agent-actor" }] },
    ]);
    const target = await lockContentAccessRoomTargetInTx(proof.tx, { ...principal, agentId: "bound-agent" },
      selected.roomId, [privateRoom], selected.boundAgentActorId);
    expect(target.destination).toMatchObject({ roomId: "personal", namespaceId: "personal-ns", humanActorIds: ["human-a"] });
    expect(proof.locks).toEqual(["share", "share", "share"]);
    proof.assertConsumed();
  });
});
