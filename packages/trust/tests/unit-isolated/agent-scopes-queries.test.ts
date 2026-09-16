/**
 * M080 / M212 — `packages/trust/src/queries.ts` scope helpers with mocked
 * `getSharedDirectDb` / `getSharedDirectAgentDb`. Runs in its own `bun test`
 * process via `scripts/run-unit.sh` so `mock.module("@nautilo/db", …)` does not
 * poison other unit tests that load the real driver.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as RealDb from "@nautilo/db";

beforeEach(() => {
  mock.restore();
});

afterEach(() => {
  mock.restore();
});

async function loadQueriesFresh(): Promise<typeof import("../../src/queries")> {
  const href = new URL("../../src/queries.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<typeof import("../../src/queries")>;
}

describe("M080 — resolveSpeakerUserId (mocked getSharedDirectDb)", () => {
  test("returns actors.owner_id for kind=user", async () => {
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([{ ownerId: "11111111-1111-4111-8111-111111111111", kind: "user" }]),
            }),
          }),
        }),
      }),
    }));
    const { resolveSpeakerUserId } = await loadQueriesFresh();
    const got = await resolveSpeakerUserId({
      actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(got).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("returns null for kind=agent", async () => {
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  { ownerId: "11111111-1111-4111-8111-111111111111", kind: "agent" },
                ]),
            }),
          }),
        }),
      }),
    }));
    const { resolveSpeakerUserId } = await loadQueriesFresh();
    expect(await resolveSpeakerUserId({ actorId: "any" })).toBeNull();
  });

  test("returns null when actor row is missing", async () => {
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }));
    const { resolveSpeakerUserId } = await loadQueriesFresh();
    expect(await resolveSpeakerUserId({ actorId: "missing" })).toBeNull();
  });
});

describe("M080 — createScope (mocked getSharedDirectDb)", () => {
  test("returns scope id on insert success", async () => {
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => ({
        insert: () => ({
          values: () => ({
            returning: () =>
              Promise.resolve([
                {
                  scopeId: "22222222-2222-4222-8222-222222222222",
                  name: "my-scope",
                },
              ]),
          }),
        }),
      }),
    }));
    const { createScope } = await loadQueriesFresh();
    const r = await createScope({
      parentAgentId: "33333333-3333-4333-8333-333333333333",
      speakerUserId: "11111111-1111-4111-8111-111111111111",
      name: "my-scope",
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.scopeId).toBe("22222222-2222-4222-8222-222222222222");
    expect(r.name).toBe("my-scope");
  });

  test("maps unique violation 23505 (including Drizzle cause chain) to name_exists", async () => {
    const dup = new Error("duplicate");
    (dup as { cause?: unknown }).cause = { code: "23505" };
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => ({
        insert: () => ({
          values: () => ({
            returning: () => {
              throw dup;
            },
          }),
        }),
      }),
    }));
    const { createScope } = await loadQueriesFresh();
    const r = await createScope({
      parentAgentId: "33333333-3333-4333-8333-333333333333",
      speakerUserId: "11111111-1111-4111-8111-111111111111",
      name: "dup",
    });
    expect(r).toEqual({ error: "name_exists" });
  });
});

describe("M080 — findScopes (mocked getSharedDirectDb)", () => {
  test("returns empty list when no scopes match", async () => {
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      }),
    }));
    const { findScopes } = await loadQueriesFresh();
    const rows = await findScopes({
      parentAgentId: "a",
      speakerUserId: "b",
    });
    expect(rows).toEqual([]);
  });

  test("merges memory counts from second query", async () => {
    let selectCalls = 0;
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectDb: () => ({
        select: () => {
          selectCalls += 1;
          if (selectCalls === 1) {
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: () =>
                      Promise.resolve([
                        {
                          scopeId: "s1",
                          name: "alpha",
                          purpose: null,
                          createdAt: new Date("2026-05-01T12:00:00Z"),
                        },
                      ]),
                  }),
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: () => ({
                groupBy: () =>
                  Promise.resolve([{ scopeId: "s1", n: BigInt(3) }]),
              }),
            }),
          };
        },
      }),
    }));
    const { findScopes } = await loadQueriesFresh();
    const rows = await findScopes({
      parentAgentId: "a",
      speakerUserId: "b",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memoryCount).toBe(3);
  });
});

describe("M080 — getScopeForSpeaker (mocked getSharedDirectAgentDb + withTrustContext)", () => {
  const withTrustContextCalls: Array<{ userId: string; agentId?: string }> = [];

  test("getScopeForSpeaker returns null when scope row missing", async () => {
    const scopeDbHandle = { __kind: "shared-agent-db" as const };
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectAgentDb: () => scopeDbHandle,
      withTrustContext: async <T>(
        ctx: { userId: string; agentId?: string },
        fn: (tx: unknown) => Promise<T>,
        db?: unknown,
      ): Promise<T> => {
        withTrustContextCalls.push(ctx);
        expect(db).toBe(scopeDbHandle);
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
        };
        return fn(tx);
      },
    }));
    withTrustContextCalls.length = 0;
    const { getScopeForSpeaker } = await loadQueriesFresh();
    const got = await getScopeForSpeaker({
      scopeId: "s",
      parentAgentId: "agent-a",
      speakerUserId: "user-b",
    });
    expect(got).toBeNull();
    expect(withTrustContextCalls).toEqual([
      { userId: "user-b", agentId: "agent-a" },
    ]);
  });

  test("getScopeForSpeaker returns row with memory count", async () => {
    let selectCalls = 0;
    const scopeDbHandle = { __kind: "shared-agent-db" as const };
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectAgentDb: () => scopeDbHandle,
      withTrustContext: async <T>(
        ctx: { userId: string; agentId?: string },
        fn: (tx: unknown) => Promise<T>,
        db?: unknown,
      ): Promise<T> => {
        withTrustContextCalls.push(ctx);
        expect(db).toBe(scopeDbHandle);
        const tx = {
          select: () => {
            selectCalls += 1;
            if (selectCalls === 1) {
              return {
                from: () => ({
                  where: () => ({
                    limit: () =>
                      Promise.resolve([
                        {
                          scopeId: "s1",
                          name: "n",
                          purpose: "p",
                          createdAt: new Date("2026-05-02T00:00:00Z"),
                        },
                      ]),
                  }),
                }),
              };
            }
            return {
              from: () => ({
                where: () => Promise.resolve([{ n: BigInt(2) }]),
              }),
            };
          },
        };
        return fn(tx);
      },
    }));
    withTrustContextCalls.length = 0;
    const { getScopeForSpeaker } = await loadQueriesFresh();
    const got = await getScopeForSpeaker({
      scopeId: "s1",
      parentAgentId: "agent-a",
      speakerUserId: "user-b",
    });
    expect(got).not.toBeNull();
    expect(got!.memoryCount).toBe(2);
    expect(got!.name).toBe("n");
    expect(withTrustContextCalls).toEqual([
      { userId: "user-b", agentId: "agent-a" },
    ]);
  });

  test("getScopeForSpeaker rejects empty speakerUserId", async () => {
    const contextErr = new Error(
      "withTrustContext: ctx.userId is required (non-empty string). " +
        "Pass the authenticated speaker's users.id.",
    );
    const scopeDbHandle = { __kind: "shared-agent-db" as const };
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectAgentDb: () => scopeDbHandle,
      withTrustContext: async <T>(
        ctx: { userId: string; agentId?: string },
        _fn: (tx: unknown) => Promise<T>,
        db?: unknown,
      ): Promise<T> => {
        expect(db).toBe(scopeDbHandle);
        if (!ctx.userId || ctx.userId.length === 0) {
          throw contextErr;
        }
        return _fn({});
      },
    }));
    const { getScopeForSpeaker } = await loadQueriesFresh();
    const rejection = getScopeForSpeaker({
      scopeId: "s",
      parentAgentId: "a",
      speakerUserId: "",
    }).then(
      () => {
        throw new Error("expected getScopeForSpeaker to reject");
      },
      (error: unknown) => error,
    );
    expect(await rejection).toBe(contextErr);
  });

  test("getScopeForSpeaker propagates query errors", async () => {
    const queryErr = new Error("scope select failed");
    const scopeDbHandle = { __kind: "shared-agent-db" as const };
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectAgentDb: () => scopeDbHandle,
      withTrustContext: async <T>(
        ctx: { userId: string; agentId?: string },
        fn: (tx: unknown) => Promise<T>,
        db?: unknown,
      ): Promise<T> => {
        withTrustContextCalls.push(ctx);
        expect(db).toBe(scopeDbHandle);
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.reject(queryErr),
              }),
            }),
          }),
        };
        return fn(tx);
      },
    }));
    withTrustContextCalls.length = 0;
    const { getScopeForSpeaker } = await loadQueriesFresh();
    const rejection = getScopeForSpeaker({
      scopeId: "s",
      parentAgentId: "agent-a",
      speakerUserId: "user-b",
    }).then(
      () => {
        throw new Error("expected getScopeForSpeaker to reject");
      },
      (error: unknown) => error,
    );
    expect(await rejection).toBe(queryErr);
  });

  test("getScopeForSpeaker propagates trust-context rejections", async () => {
    const trustErr = new Error("trust context setup failed");
    const scopeDbHandle = { __kind: "shared-agent-db" as const };
    mock.module("@nautilo/db", () => ({
      ...RealDb,
      getSharedDirectAgentDb: () => scopeDbHandle,
      withTrustContext: async <T>(
        _ctx: { userId: string; agentId?: string },
        _fn: (tx: unknown) => Promise<T>,
        db?: unknown,
      ): Promise<T> => {
        expect(db).toBe(scopeDbHandle);
        throw trustErr;
      },
    }));
    const { getScopeForSpeaker } = await loadQueriesFresh();
    const rejection = getScopeForSpeaker({
      scopeId: "s",
      parentAgentId: "agent-a",
      speakerUserId: "user-b",
    }).then(
      () => {
        throw new Error("expected getScopeForSpeaker to reject");
      },
      (error: unknown) => error,
    );
    expect(await rejection).toBe(trustErr);
  });
});
