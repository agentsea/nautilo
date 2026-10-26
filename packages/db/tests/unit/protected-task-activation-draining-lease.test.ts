import { describe, expect, test } from "bun:test";

import { lockProtectedTaskActivationDrainingLease } from
  "../../src/queries/protected-task-activation-draining-lease";

const operationId = "10000000-0000-4000-8000-000000000001";
const now = new Date("2042-06-07T08:00:00.000Z");

function transaction(row: Record<string, unknown> | null) {
  const events: string[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async (strength: string) => {
              events.push(`for:${strength}`);
              return row === null ? [] : [row];
            },
          }),
        }),
      }),
    }),
  };
  return { tx, events };
}

function lease(overrides: Record<string, unknown> = {}) {
  return {
    singletonKey: "upgrade",
    state: "draining",
    operationId,
    leaseExpiresAt: new Date("2042-06-07T08:10:00.000Z"),
    hardExpiresAt: new Date("2042-06-07T08:20:00.000Z"),
    createdAt: new Date("2042-06-07T07:00:00.000Z"),
    updatedAt: new Date("2042-06-07T07:59:00.000Z"),
    ...overrides,
  };
}

describe("protected Task activation draining lease", () => {
  test("locks and returns only the exact future owning drain", async () => {
    const fixture = transaction(lease());
    const result = await lockProtectedTaskActivationDrainingLease(
      fixture.tx as never,
      { operationId, now },
    );
    expect(result).toMatchObject({ state: "draining", operationId });
    expect(result?.leaseExpiresAt).not.toBe(lease().leaseExpiresAt);
    expect(fixture.events).toEqual(["for:update"]);
  });

  test("rejects another owner, state, missing row, and either expired bound", async () => {
    for (const row of [
      null,
      lease({ operationId: "20000000-0000-4000-8000-000000000002" }),
      lease({ state: "applying" }),
      lease({ leaseExpiresAt: new Date(now) }),
      lease({ hardExpiresAt: new Date(now) }),
    ]) {
      expect(await lockProtectedTaskActivationDrainingLease(
        transaction(row).tx as never,
        { operationId, now },
      )).toBeNull();
    }
  });

  test("rejects malformed identity and time before reading", async () => {
    let selected = false;
    const tx = { select: () => { selected = true; throw new Error("unexpected"); } };
    await Promise.resolve(expect(lockProtectedTaskActivationDrainingLease(tx as never, {
      operationId: "not-an-operation", now,
    })).rejects.toThrow("identity is malformed"));
    await Promise.resolve(expect(lockProtectedTaskActivationDrainingLease(tx as never, {
      operationId, now: new Date(Number.NaN),
    })).rejects.toThrow("identity is malformed"));
    expect(selected).toBeFalse();
  });
});
