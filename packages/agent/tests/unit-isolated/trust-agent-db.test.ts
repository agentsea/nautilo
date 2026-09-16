/**
 * M033 Phase 2A / M210 Phase 3 — unit tests for shared agent trust-context helper.
 * No real Postgres connection; `@nautilo/db` is mocked.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";

const fakeDb = { tag: "shared-direct-agent-db-mock" };
let getSharedDirectAgentDbCallCount = 0;

beforeAll(() => {
  mock.module("@nautilo/db", () => ({
    getSharedDirectAgentDb: () => {
      getSharedDirectAgentDbCallCount++;
      return fakeDb;
    },
    withTrustContext: async <T>(
      ctx: { userId: string; agentId?: string },
      fn: (tx: unknown) => Promise<T>,
      handle?: unknown,
    ): Promise<T> => {
      if (!ctx.userId || ctx.userId.length === 0) {
        throw new Error(
          "withTrustContext: ctx.userId is required (non-empty string). " +
            "Pass the authenticated speaker's users.id.",
        );
      }
      void handle;
      return fn({});
    },
  }));
});

let withAgentTrustContext: <T>(
  ctx: { userId: string; agentId?: string },
  fn: (tx: unknown) => Promise<T>,
) => Promise<T>;

beforeAll(async () => {
  const mod = await import("../../src/store/trust-agent-db");
  withAgentTrustContext = mod.withAgentTrustContext;
});

describe("withAgentTrustContext", () => {
  test("throws when userId is empty string", () => {
    return expect(
      withAgentTrustContext({ userId: "", agentId: "agent-1" }, async () => "x"),
    ).rejects.toThrow(/userId is required/);
  });

  test("trustAgentDb compatibility wrapper — getSharedDirectAgentDb invoked at most once", async () => {
    await withAgentTrustContext({ userId: "u-1" }, async () => "ok-1");
    await withAgentTrustContext({ userId: "u-2" }, async () => "ok-2");
    expect(getSharedDirectAgentDbCallCount).toBe(1);
  });
});
