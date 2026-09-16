import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import {
  createComputerUseAgentOwnershipAuthorizer,
  hasExactComputerUseAgentOwnership,
} from "../../src/remote-control/computer-use-agent-ownership";

const input = { userId: "human-1", agentId: "agent-1" };
const row = { ownerId: "human-1", agentId: "agent-1", kind: "agent" };

function fakeDatabase(
  loadRows: () => Promise<readonly typeof row[]>,
): { readonly db: DirectDatabase; readonly queryCount: () => number } {
  let queries = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          queries += 1;
          return loadRows();
        },
      }),
    }),
  } as unknown as DirectDatabase;
  return { db, queryCount: () => queries };
}

describe("D516 current selected-Agent ownership", () => {
  test("accepts exactly one canonical Agent actor owned by the authenticated Human", () => {
    expect(hasExactComputerUseAgentOwnership(input, [row])).toBe(true);
  });

  test.each([
    ["no mirror", []],
    ["a foreign owner", [{ ...row, ownerId: "human-2" }]],
    ["a different Agent", [{ ...row, agentId: "agent-2" }]],
    ["a Human actor", [{ ...row, kind: "user" }]],
    ["a malformed owner", [{ ...row, ownerId: "" }]],
    ["a malformed Agent", [{ ...row, agentId: "agent 1" }]],
    ["duplicate mirrors", [row, row]],
  ] as const)("denies %s", (_label, rows) => {
    expect(hasExactComputerUseAgentOwnership(input, rows)).toBe(false);
  });

  test.each([
    [{ userId: "", agentId: "agent-1" }],
    [{ userId: "human 1", agentId: "agent-1" }],
    [{ userId: "human-1", agentId: "" }],
    [{ userId: "human-1", agentId: "agent 1" }],
  ])("denies malformed authority input %#", (malformedInput) => {
    expect(hasExactComputerUseAgentOwnership(malformedInput, [row])).toBe(false);
  });

  test("queries current canonical ownership and accepts one exact row", async () => {
    const fake = fakeDatabase(async () => [row]);
    expect(await createComputerUseAgentOwnershipAuthorizer(fake.db)(input)).toBe(true);
    expect(fake.queryCount()).toBe(1);
  });

  test("rejects malformed input before querying ownership", async () => {
    const fake = fakeDatabase(async () => [row]);
    expect(await createComputerUseAgentOwnershipAuthorizer(fake.db)({
      userId: "human 1",
      agentId: "agent-1",
    })).toBe(false);
    expect(fake.queryCount()).toBe(0);
  });

  test("fails closed when the canonical ownership query fails", async () => {
    const fake = fakeDatabase(async () => Promise.reject(new Error("database unavailable")));
    expect(await createComputerUseAgentOwnershipAuthorizer(fake.db)(input)).toBe(false);
    expect(fake.queryCount()).toBe(1);
  });
});
