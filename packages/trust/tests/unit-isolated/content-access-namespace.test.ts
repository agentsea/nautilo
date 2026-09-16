import { afterAll, describe, expect, mock, test } from "bun:test";
import type { InviteSeedTx } from "@nautilo/db";

const mint = mock(async () => ({ namespaceId: "new-namespace" }));
mock.module("../../src/queries", () => ({ insertPrivateRoomBundleTx: mint }));
const { resolveContentAccessNamespaceInTx } = await import("../../src/content-access-namespace");
afterAll(() => mock.restore());

const input = { requesterUserId: "user-a", requesterActorId: "a", humanActorIds: ["b", "a", "b"] };

function transaction(results: unknown[][]) {
  const calls: string[] = [];
  const tx = {
    execute: mock(async () => { calls.push("lock"); }),
    select: mock(() => {
      calls.push("select");
      const rows = results.shift();
      if (!rows) throw new Error("Unexpected query");
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy", "limit", "for"]) {
        chain[method] = () => chain;
      }
      chain["then"] = (resolve: (value: unknown[]) => unknown) => resolve(rows);
      return chain;
    }),
  };
  return { tx: tx as unknown as InviteSeedTx, calls };
}

const humans = [{ actorId: "a", userId: "user-a" }, { actorId: "b", userId: "user-b" }];

async function expectFailure(operation: Promise<unknown>, message: string) {
  const error: unknown = await operation.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe("immutable content access persistence", () => {
  test("rejects a requester outside the audience before any persistence", async () => {
    const { tx, calls } = transaction([]);
    await expectFailure(resolveContentAccessNamespaceInTx(tx, { ...input, humanActorIds: ["b"] }), "requester");
    expect(calls).toEqual([]);
  });

  test("locks before validating identities and rejects an unavailable target", async () => {
    mint.mockClear();
    const { tx, calls } = transaction([[humans[0]!]]);
    await expectFailure(resolveContentAccessNamespaceInTx(tx, input), "no longer available");
    expect(calls).toEqual(["lock", "select"]);
    expect(mint).not.toHaveBeenCalled();
  });

  test("binds the requester actor to the authenticated user", async () => {
    const { tx } = transaction([humans]);
    await expectFailure(resolveContentAccessNamespaceInTx(tx, { ...input, requesterUserId: "other" }), "no longer available");
  });

  test("reuses canonical exact membership without minting", async () => {
    mint.mockClear();
    const { tx } = transaction([humans,
      [{ roomId: "existing", namespaceId: "existing-ns" }],
      [{ actorId: "a" }, { actorId: "b" }],
    ]);
    expect(await resolveContentAccessNamespaceInTx(tx, input)).toEqual({
      roomId: "existing", namespaceId: "existing-ns", minted: false,
    });
    expect(mint).not.toHaveBeenCalled();
  });

  test("fails closed on a corrupt membership projection without minting", async () => {
    mint.mockClear();
    const { tx } = transaction([humans,
      [{ roomId: "bad", namespaceId: "bad-ns" }],
      [{ actorId: "a" }, { actorId: "b" }, { actorId: "agent" }],
    ]);
    await expectFailure(resolveContentAccessNamespaceInTx(tx, input), "membership is inconsistent");
    expect(mint).not.toHaveBeenCalled();
  });

  test("creates through the existing Room bundle on the caller's transaction", async () => {
    mint.mockClear();
    const { tx } = transaction([humans, []]);
    const result = await resolveContentAccessNamespaceInTx(tx, input);
    expect(result).toMatchObject({ namespaceId: "new-namespace", minted: true });
    expect(mint).toHaveBeenCalledWith(tx, {
      roomId: result.roomId, ownerUserId: "user-a", createdByActorId: "a",
      graphThreadId: `access:${result.roomId}`, label: "Shared access",
      humanActorIds: ["a", "b"], roomKind: "access", roomType: "shared",
      memberRows: [{ actorId: "a", roomRole: "admin" }, { actorId: "b", roomRole: "member" }],
    });
  });
});
