import { describe, expect, test } from "bun:test";
import { prepareProtectedTaskScope } from "../../src/routes/protected-task-scope-creation";

type Transaction = Parameters<typeof prepareProtectedTaskScope>[0];
const input = {
  taskId: "10000000-0000-4000-8000-000000000001",
  requesterUserId: "10000000-0000-4000-8000-000000000002",
  agentId: "10000000-0000-4000-8000-000000000003",
  scopeId: null,
};

describe("protected Task Scope creation", () => {
  test("creates only structural metadata in the caller's product transaction", async () => {
    const writes: unknown[] = [];
    const transaction = {
      insert: () => ({ values: (value: unknown) => {
        writes.push(value);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: "scope" }] }) };
      } }),
    } as unknown as Transaction;
    expect(await prepareProtectedTaskScope(transaction, input)).toBe("scope");
    expect(writes).toEqual([{
      parentAgentId: input.agentId,
      speakerUserId: input.requesterUserId,
      name: `task:${input.taskId}`,
      purpose: null,
    }]);
  });

  test("reuses only an exact open structural Scope after a creation race", async () => {
    const locks: string[] = [];
    const transaction = {
      insert: () => ({ values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [] }),
      }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({
        for: async (lock: string) => {
          locks.push(lock);
          return [{ id: "existing-scope" }];
        },
      }) }) }) }),
    } as unknown as Transaction;
    expect(await prepareProtectedTaskScope(transaction, input))
      .toBe("existing-scope");
    expect(locks).toEqual(["share"]);
  });

  test("rejects a conflicting Scope that is not the exact open owner", async () => {
    const transaction = {
      insert: () => ({ values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [] }),
      }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({
        for: async () => [],
      }) }) }) }),
    } as unknown as Transaction;
    expect(await prepareProtectedTaskScope(transaction, input)
      .catch((error: unknown) => error))
      .toEqual(new TypeError("Protected Task Scope identity conflicts"));
  });

  test.each([true, false])("existing Scope must remain owned and open: %s", async (available) => {
    const locks: string[] = [];
    const transaction = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({
        for: async (lock: string) => {
          locks.push(lock);
          return available ? [{ id: "scope" }] : [];
        },
      }) }) }) }),
    } as unknown as Transaction;
    const result = prepareProtectedTaskScope(transaction, { ...input, scopeId: "scope" });
    if (available) expect(await result).toBe("scope");
    else expect(await result.catch((error: unknown) => error))
      .toEqual(new TypeError("Protected Task Scope is unavailable"));
    expect(locks).toEqual(["share"]);
  });
});
