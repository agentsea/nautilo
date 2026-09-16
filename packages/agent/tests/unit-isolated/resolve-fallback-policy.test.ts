/**
 * D141 P2.0 — unit tests for `resolveFallbackPolicy` (DB mocked via `@nautilo/db`).
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedFallbackPolicy } from "../../src/utils/resolve-fallback-policy";

const A = "anthropic:claude-sonnet-4-6";
const B = "openai:gpt-5.5-2026-04-23";
const C = "google:gemini-2.5-pro";
const D = "openai:gpt-5.4-2026-03-05";

const HARD_DEFAULT = { enabled: false, chain: [] as string[] };

type LimitOp =
  | { op: "rows"; rows: unknown[] }
  | { op: "throw"; error: Error };

let limitOps: LimitOp[] = [];

beforeAll(() => {
  mock.module("@nautilo/db", () => ({
    profiles: {},
    agents: {},
    eq: () => ({}),
    // D281 — resolver consults the server model config cache for a server-wide
    // fallback tier; mock returns no server config so these tests exercise the
    // per-user / per-agent precedence in isolation.
    getCachedServerModelConfigRow: () => null,
    kickServerModelConfigRefresh: () => {},
    agentDb: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const next = limitOps.shift();
              if (!next) throw new Error("resolve-fallback-policy.test: unexpected extra db.select().limit()");
              if (next.op === "throw") throw next.error;
              return next.rows;
            },
          }),
        }),
      }),
    },
  }));
});

let resolveFallbackPolicy: (userId: string, agentId?: string | null) => Promise<ResolvedFallbackPolicy>;

beforeAll(async () => {
  const mod = await import("../../src/utils/resolve-fallback-policy");
  resolveFallbackPolicy = mod.resolveFallbackPolicy;
});

beforeEach(() => {
  limitOps = [];
});

describe("resolveFallbackPolicy", () => {
  test("1. per-agent override present + enabled true → agent policy wins", async () => {
    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: false, fallbackChain: [C, D] }],
      },
      {
        op: "rows",
        rows: [{ customization: { fallback: { enabled: true, chain: [A, B] } } }],
      },
    ];
    expect(await resolveFallbackPolicy("user-1", "agent-1")).toEqual({
      enabled: true,
      chain: [A, B],
    });
    expect(limitOps).toHaveLength(0);
  });

  test("2. per-agent enabled false → chain from agent if set else user", async () => {
    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: true, fallbackChain: [C, D] }],
      },
      {
        op: "rows",
        rows: [{ customization: { fallback: { enabled: false } } }],
      },
    ];
    expect(await resolveFallbackPolicy("user-1", "agent-1")).toEqual({
      enabled: false,
      chain: [C, D],
    });
    expect(limitOps).toHaveLength(0);

    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: true, fallbackChain: [C, D] }],
      },
      {
        op: "rows",
        rows: [{ customization: { fallback: { enabled: false, chain: [A, B] } } }],
      },
    ];
    expect(await resolveFallbackPolicy("user-1", "agent-2")).toEqual({
      enabled: false,
      chain: [A, B],
    });
    expect(limitOps).toHaveLength(0);
  });

  test("3. no agent override, per-user enabled true → user chain", async () => {
    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: true, fallbackChain: [A, B, C] }],
      },
    ];
    expect(await resolveFallbackPolicy("user-1", null)).toEqual({
      enabled: true,
      chain: [A, B, C],
    });
    expect(limitOps).toHaveLength(0);
  });

  test("4. no agent override, per-user enabled false → user policy", async () => {
    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: false, fallbackChain: [A, B] }],
      },
    ];
    expect(await resolveFallbackPolicy("user-1", undefined)).toEqual({
      enabled: false,
      chain: [A, B],
    });
    expect(limitOps).toHaveLength(0);
  });

  test("5. no profile row → HARD_DEFAULT", async () => {
    limitOps = [{ op: "rows", rows: [] }];
    expect(await resolveFallbackPolicy("user-missing", null)).toEqual(HARD_DEFAULT);
    expect(limitOps).toHaveLength(0);

    limitOps = [
      { op: "rows", rows: [] },
      { op: "rows", rows: [{ customization: undefined }] },
    ];
    expect(await resolveFallbackPolicy("user-missing", "agent-1")).toEqual(HARD_DEFAULT);
    expect(limitOps).toHaveLength(0);
  });

  test("6. agent sets chain only → enabled inherits user; chain is agent's", async () => {
    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: true, fallbackChain: [C] }],
      },
      {
        op: "rows",
        rows: [{ customization: { fallback: { chain: [A, B] } } }],
      },
    ];
    expect(await resolveFallbackPolicy("user-1", "agent-1")).toEqual({
      enabled: true,
      chain: [A, B],
    });
    expect(limitOps).toHaveLength(0);

    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: false, fallbackChain: [C, D] }],
      },
      {
        op: "rows",
        rows: [{ customization: { fallback: { chain: [A, B] } } }],
      },
    ];
    expect(await resolveFallbackPolicy("user-1", "agent-2")).toEqual({
      enabled: false,
      chain: [A, B],
    });
    expect(limitOps).toHaveLength(0);
  });

  test("7. empty userId (whitespace-only) → HARD_DEFAULT without DB reads", async () => {
    expect(await resolveFallbackPolicy("   ", "agent-1")).toEqual(HARD_DEFAULT);
    expect(await resolveFallbackPolicy("\t\n", null)).toEqual(HARD_DEFAULT);
    expect(limitOps).toHaveLength(0);
  });

  test("8. DB throws on profiles read → HARD_DEFAULT", async () => {
    limitOps = [{ op: "throw", error: new Error("profiles connection lost") }];
    expect(await resolveFallbackPolicy("user-1", "agent-1")).toEqual(HARD_DEFAULT);
    expect(limitOps).toHaveLength(0);
  });

  test("9. DB throws on agents read but profiles ok → user policy", async () => {
    limitOps = [
      {
        op: "rows",
        rows: [{ fallbackEnabled: true, fallbackChain: [A, B, C] }],
      },
      { op: "throw", error: new Error("agents read failed") },
    ];
    expect(await resolveFallbackPolicy("user-1", "agent-1")).toEqual({
      enabled: true,
      chain: [A, B, C],
    });
    expect(limitOps).toHaveLength(0);
  });
});
