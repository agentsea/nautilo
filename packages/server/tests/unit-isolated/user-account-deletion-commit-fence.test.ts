import { afterAll, describe, expect, mock, test } from "bun:test";
import * as database from "@nautilo/db";
import * as trust from "@nautilo/trust";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
const originalDatabase = { ...database };
const originalTrust = { ...trust };
let active = true;
let transactions = 0;
let commit: Promise<unknown> = Promise.resolve();
let logtoCalls = 0;
let externalCleanup: Promise<void> = Promise.resolve();
let executeTransaction: ((callback: unknown) => Promise<unknown>) | undefined;
const fakeDb = { transaction: (callback: unknown) => ++transactions === 1
  ? executeTransaction?.(callback) ?? commit : Promise.resolve([]) };
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

  for (const sharedGenie of [false, true]) for (const failInbox of [false, true]) {
    test(`${sharedGenie ? "shared Genie" : "owned bridge"}: ${failInbox ? "cleanup failure leaves account deletion uncommitted"
      : "deletion removes exact bridge dependents before canonical parents"}`, async () => {
      transactions = 0; logtoCalls = 0;
      const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const dialect = new PgDialect();
      const deleted: string[] = [];
      const bridgeTables = ["bolter_outbox", "bolter_explicit_shares", "bolter_inbox_receipts", "bolter_room_bindings", "bolter_connections"];
      const sharedBinding = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      let fences = 0;
      const executionFences: string[] = [];
      const select = () => {
        let rows: { id: string }[] = [];
        let source: Table | undefined;
        const query = {
          from: (table: Table) => {
            source = table;
            if (table === database.sessions) {
              expect(executionFences).toEqual(["acceptance", "job"]);
              rows = [{ id: "session-fixture" }];
            }
            if (sharedGenie && table === database.bolterRoomBindings) rows = [{ id: sharedBinding }];
            return query;
          },
          where: (predicate: SQL) => {
            if (source === database.bolterRoomBindings) {
              const condition = dialect.sqlToQuery(predicate);
              expect(condition.sql).toBe('"bolter_room_bindings"."agent_id" in ($1)');
              expect(condition.params).toEqual(["agent-fixture"]);
            }
            return query;
          },
          for: () => query,
          then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return query;
      };
      const tx = {
        select,
        execute: async (statement: SQL) => {
          const compiled = dialect.sqlToQuery(statement);
          const text = compiled.sql.replace(/\s+/gu, " ");
          if (text.includes("UPDATE public.work_acceptances a SET status = 'maintenance_cancelled'")) {
            expect(compiled.params).toContain(owner);
            expect(compiled.params).toContain("agent-fixture");
            executionFences.push("acceptance");
          }
          if (text.includes("UPDATE public.jobs j SET status = 'cancelled'")) {
            expect(executionFences).toEqual(["acceptance"]);
            expect(text).toContain("j.input->>'receiptId' = i.id::text");
            expect(text).toContain("j.status IN ('queued','running')");
            executionFences.push("job");
          }
          if (text.includes("SELECT r.id, r.namespace_id")) {
            expect(executionFences).toEqual(["acceptance", "job"]);
          }
          if (text.includes("SELECT id, external_id, server FROM users")) return [{ id: owner, external_id: null, server: null }];
          if (text.includes("SELECT agent_id FROM actors")) return [{ agent_id: "agent-fixture" }];
          return [];
        },
        update: () => ({ set: () => ({ where: async () => [] }) }),
        delete: (table: Table) => ({ where: async (predicate: SQL) => {
          const name = getTableName(table);
          deleted.push(name);
          expect(executionFences).toEqual(["acceptance", "job"]);
          if (bridgeTables.includes(name)) {
            const condition = dialect.sqlToQuery(predicate);
            if (sharedGenie && name !== "bolter_connections") {
              const referenceColumn = name === "bolter_room_bindings" ? "id" : "binding_id";
              expect(condition.sql).toBe(`("${name}"."user_id" = $1 or "${name}"."${referenceColumn}" in ($2))`);
              expect(condition.params).toEqual([owner, sharedBinding]);
            } else {
              expect(condition.sql).toBe(`"${name}"."user_id" = $1`);
              expect(condition.params).toEqual([owner]);
            }
            if (failInbox && name === "bolter_inbox_receipts") throw new Error("bridge cleanup rejected");
          }
          if (["session_messages", "agents", "jobs", "users"].includes(name)) {
            expect(deleted.filter(entry => bridgeTables.includes(entry))).toEqual(bridgeTables);
          }
          return [];
        } }),
      };
      executeTransaction = callback => (callback as (transaction: typeof tx) => Promise<unknown>)(tx);
      try {
        const deleting = deleteLocalUserAccount(owner, { onCommitted: () => { fences++; } });
        if (failInbox) {
          const failure = await deleting.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({ message: "bridge cleanup rejected" });
          expect(fences).toBe(0);
          expect(deleted).not.toContain("session_messages");
          expect(deleted).not.toContain("users");
        } else {
          expect(await deleting).toMatchObject({ deletedAgents: 1, deletedSessions: 1 });
          expect(deleted.filter(entry => bridgeTables.includes(entry))).toEqual(bridgeTables);
          expect(deleted).toContain("users");
          expect(fences).toBe(1);
        }
        expect(logtoCalls).toBe(0);
      } finally { executeTransaction = undefined; }
    });
  }
});
