import { afterAll, describe, expect, mock, test } from "bun:test";
import * as database from "@nautilo/db";
import * as trust from "@nautilo/trust";
const originalDatabase = { ...database };
const originalTrust = { ...trust };
let active = true;
let transactions = 0;
let commit: Promise<unknown> = Promise.resolve();
let logtoCalls = 0;
let externalCleanup: Promise<void> = Promise.resolve();
const fakeDb = { transaction: () => ++transactions === 1 ? commit : Promise.resolve([]) };
mock.module("@nautilo/db", () => ({ ...database,
  getSharedDirectDb: (...args: Parameters<typeof database.getSharedDirectDb>) => active
    ? fakeDb as unknown as ReturnType<typeof database.getSharedDirectDb> : originalDatabase.getSharedDirectDb(...args),
}));
mock.module("@nautilo/trust", () => ({ ...trust,
  getLogtoAdminClient: (...args: Parameters<typeof trust.getLogtoAdminClient>) => active ? {
    deleteUser: () => { logtoCalls++; return externalCleanup; },
  } as unknown as ReturnType<typeof trust.getLogtoAdminClient> : originalTrust.getLogtoAdminClient(...args),
}));
const { deleteLocalUserAccount } = await import("../../src/lib/user-account-deletion");
afterAll(() => { active = false; });
const receipt = { logtoSub: "synthetic-identity", deletedAgents: 0, deletedRooms: 0, deletedSessions: 0 };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("account deletion transaction fence", () => {
  test("committed authority is fenced before local and external best-effort cleanup", async () => {
    transactions = 0; logtoCalls = 0; let commitTransaction!: (value: unknown) => void;
    let finishExternal!: () => void;
    commit = new Promise(resolve => { commitTransaction = resolve; });
    externalCleanup = new Promise(resolve => { finishExternal = resolve; });
    const fences: string[] = [];
    const deleting = deleteLocalUserAccount("human-fixture", { onCommitted: userId => {
      expect(transactions).toBe(1); expect(logtoCalls).toBe(0); fences.push(userId);
    } });
    expect(fences).toEqual([]); expect(logtoCalls).toBe(0);
    commitTransaction(receipt); await tick();
    expect(fences).toEqual(["human-fixture"]); expect(logtoCalls).toBe(1);
    finishExternal(); expect(await deleting).toMatchObject({ logtoRevoked: true });
  });
  test("failed transactions never fence an account or start external cleanup", async () => {
    transactions = 0; logtoCalls = 0; let fences = 0; commit = Promise.reject(new Error("transaction rejected"));
    const failure = await deleteLocalUserAccount("human-fixture", { onCommitted: () => { fences++; } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: "transaction rejected" });
    expect(fences).toBe(0); expect(logtoCalls).toBe(0);
  });
  test("callback failure cannot turn an already committed deletion into a retryable mutation", async () => {
    transactions = 0; logtoCalls = 0; commit = Promise.resolve(receipt); externalCleanup = Promise.resolve();
    const result = await deleteLocalUserAccount("human-fixture", { onCommitted: () => { throw new Error("fixture fence failure"); } });
    expect(result.logtoRevoked).toBe(true); expect(logtoCalls).toBe(1);
  });
});
