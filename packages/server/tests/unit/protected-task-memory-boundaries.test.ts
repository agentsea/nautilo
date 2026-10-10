import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type {
  MemoryPayloadV1,
  PreparedMemoryCryptoRevision,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";

import {
  createProtectedTaskMemoryBoundaries,
  type ProtectedTaskMemoryBoundariesInput,
} from "../../src/routes/protected-task-memory-boundaries";
import type {
  HeldProtectedTaskMemoryAuthority,
  ProtectedTaskMemoryAuthorityInput,
} from "../../src/routes/current-protected-task-memory-authority";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const NS_A = "33333333-3333-4333-8333-333333333333";
const NS_B = "44444444-4444-4444-8444-444444444444";

const authority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([NS_A]),
  mutableNamespaceIds: Object.freeze([NS_A]),
  writableNamespaceId: NS_A,
});

function current(
  representation: "dual" | "protected" = "protected",
): ProtectedTaskMemoryAuthorityInput {
  return {
    runner: Object.freeze({ role: "nautilo" }),
    restricted: Object.freeze({}),
    crypto: Object.freeze({}),
    serverScope: "https://nautilo.example",
    subject: Object.freeze({ userId: USER }),
    occurrence: Object.freeze({
      task: Object.freeze({
        agentId: AGENT,
        contentRepresentation: representation,
      }),
    }),
    record: Object.freeze({}),
    request: Object.freeze({}),
    evidence: Object.freeze({
      policyRevision: 7,
      result: Object.freeze({ signerAgentId: AGENT }),
      namespaceRequirements: Object.freeze([Object.freeze({
        namespaceId: NS_A,
        operations: Object.freeze(["decrypt", "encrypt"]),
      })]),
    }),
    jobId: "job",
    executionRoomId: "room",
    reference: Object.freeze({}),
    now: () => 1,
    signal: new AbortController().signal,
  } as unknown as ProtectedTaskMemoryAuthorityInput;
}

function input(
  overrides: Partial<ProtectedTaskMemoryBoundariesInput> = {},
): ProtectedTaskMemoryBoundariesInput {
  return {
    authority,
    policy: Object.freeze({
      mode: "encrypted_only",
      shadowBehavior: "strict",
      revision: 7,
    }),
    current: current(),
    ...overrides,
  };
}

function held(
  overrides: Partial<HeldProtectedTaskMemoryAuthority> = {},
): HeldProtectedTaskMemoryAuthority {
  return {
    policy: Object.freeze({
      mode: "encrypted_only",
      shadowBehavior: "strict",
      revision: 7,
    }),
    currentRuntime: Object.freeze({}),
    assertCurrent: () => Promise.resolve(),
    ...overrides,
  } as unknown as HeldProtectedTaskMemoryAuthority;
}

type CurrentOwner = typeof import(
  "../../src/routes/current-protected-task-memory-authority"
)["withCurrentProtectedTaskMemoryAuthority"];

function owner(
  execute: <Value>(
    use: (value: HeldProtectedTaskMemoryAuthority) => Promise<Value>,
  ) => Promise<Value | null>,
): CurrentOwner {
  return ((_, use) => execute(use)) as CurrentOwner;
}

describe("protected Task Memory boundaries", () => {
  test("pins the policy, authority, and grant capabilities", () => {
    expect(() => createProtectedTaskMemoryBoundaries(input({
      policy: {
        mode: "plaintext_only",
        shadowBehavior: "fallback",
        revision: 7,
      },
    }))).toThrow("authority is unavailable");
    expect(() => createProtectedTaskMemoryBoundaries(input({
      authority: {...authority, agentId: USER},
    }))).toThrow("authority is unavailable");
    expect(() => createProtectedTaskMemoryBoundaries(input({
      current: {
        ...current(),
        evidence: {
          ...current().evidence,
          namespaceRequirements: [{
            ...current().evidence.namespaceRequirements[0]!,
            operations: ["decrypt"],
          }],
        },
      } as ProtectedTaskMemoryAuthorityInput,
    }))).toThrow("authority is unavailable");
    expect(() => createProtectedTaskMemoryBoundaries(input({
      current: current("dual"),
    }))).toThrow("authority is unavailable");

    const shadowPayload = Object.freeze({
      formatVersion: 1 as const,
      content: "ordinary sibling",
      type: "fact",
    }) satisfies MemoryPayloadV1;
    const shadow = createProtectedTaskMemoryBoundaries(input({
      current: current("dual"),
      policy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 7,
      },
      readPreparedPayload: () => shadowPayload,
    }));
    expect(shadow.publication.representation).toBe("ordinary_and_protected");
    if (shadow.publication.representation !== "ordinary_and_protected") {
      throw new Error("expected Shadow publication");
    }
    expect(shadow.publication.readPreparedPayload(
      Object.freeze({}) as PreparedMemoryCryptoRevision,
    )).toBe(shadowPayload);
    expect(Object.isFrozen(shadow.authority)).toBeTrue();
    if (shadow.authority.mode !== "namespace") throw new Error("expected Namespace");
    expect(Object.isFrozen(shadow.authority.readableNamespaceIds)).toBeTrue();
    expect(Object.isFrozen(shadow.policy)).toBeTrue();
  });

  test("Scope binds historical reads and current-origin writes to the fixed grant", async () => {
    const scopeId = "55555555-5555-4555-8555-555555555555";
    const roomId = "66666666-6666-4666-8666-666666666666";
    const scopeAuthority = {
      mode: "scope" as const, subjectUserId: USER, agentId: AGENT,
      scopeId, originWritableNamespaceId: NS_A,
    };
    const readable = [NS_A, NS_B];
    const base = current();
    const scopeCurrent = {
      ...base,
      scopeMemory: { targetRoomId: roomId, workIdentity: "bound work", binding: {
        scopeId, memoryRoomId: roomId, originWritableNamespaceId: NS_A,
        readableNamespaceIds: readable,
      } },
      evidence: { ...base.evidence, namespaceRequirements: [
        base.evidence.namespaceRequirements[0]!,
        { ...base.evidence.namespaceRequirements[0]!, namespaceId: NS_B,
          operations: ["decrypt" as const] },
      ] },
    };
    let used = 0;
    const boundaries = createProtectedTaskMemoryBoundaries(input({
      authority: scopeAuthority, current: scopeCurrent,
    }), { withCurrentAuthority: (async (captured, use) => {
      expect(captured.scopeMemory?.binding.readableNamespaceIds).toEqual([NS_A, NS_B]);
      used++;
      return use(held());
    }) as CurrentOwner });
    readable.pop();
    const publish = boundaries.publication.withCurrentPublication!;
    const receipt = Object.freeze({ value: "published" });
    expect(await publish({ authority: scopeAuthority, mutation: true,
      use: async () => receipt as never })).toBe(receipt as never);
    expect(used).toBe(1);
    let substituted = false;
    try {
      await publish({ authority: { ...scopeAuthority, originWritableNamespaceId: NS_B },
        mutation: true, use: async () => receipt as never });
    } catch { substituted = true; }
    expect(substituted).toBeTrue();
    expect(used).toBe(1);
    expect(() => createProtectedTaskMemoryBoundaries(input({
      authority: scopeAuthority, current: base,
    }))).toThrow("authority is unavailable");
    expect(() => createProtectedTaskMemoryBoundaries(input({
      authority: scopeAuthority, current: { ...scopeCurrent,
        scopeMemory: { ...scopeCurrent.scopeMemory, binding: {
          ...scopeCurrent.scopeMemory.binding, readableNamespaceIds: [NS_A, NS_B],
        } }, evidence: base.evidence,
      },
    }))).toThrow("authority is unavailable");
    expect(() => createProtectedTaskMemoryBoundaries(input({
      current: scopeCurrent,
    }))).toThrow("authority is unavailable");
  });

  test("recovers only an observed mutation receipt after the outer owner fails", async () => {
    const late = new Error("late authority failure");
    const value = held();
    const boundaries = createProtectedTaskMemoryBoundaries(input(), {
      withCurrentAuthority: owner(async use => {
        await use(value);
        throw late;
      }),
    });
    if (boundaries.publication.withCurrentPublication === undefined) {
      throw new Error("expected held publication");
    }
    const receipt = Object.freeze({ value: "committed" });
    const mutationResult = await boundaries.publication.withCurrentPublication({
      authority,
      mutation: true,
      use: async () => receipt as never,
    });
    expect(mutationResult as unknown).toBe(receipt);

    await Promise.resolve(expect(
      boundaries.publication.withCurrentPublication({
        authority,
        mutation: false,
        use: async () => receipt as never,
      }),
    ).rejects.toBe(late));

    const beforeUse = createProtectedTaskMemoryBoundaries(input(), {
      withCurrentAuthority: owner(() => Promise.reject(late)),
    });
    if (beforeUse.publication.withCurrentPublication === undefined) {
      throw new Error("expected held publication");
    }
    await Promise.resolve(expect(
      beforeUse.publication.withCurrentPublication({
        authority,
        mutation: true,
        use: async () => receipt as never,
      }),
    ).rejects.toBe(late));
  });

  test("rejects requested authority mutation before entering the Agent transaction", async () => {
    const requested = {
      ...authority,
      readableNamespaceIds: [NS_A],
      mutableNamespaceIds: [NS_A],
    } satisfies ProtectedMemoryAuthority;
    let uses = 0;
    const boundaries = createProtectedTaskMemoryBoundaries(input(), {
      withCurrentAuthority: owner(async use => {
        requested.readableNamespaceIds[0] = NS_B;
        return use(held());
      }),
    });
    if (boundaries.publication.withCurrentPublication === undefined) {
      throw new Error("expected held publication");
    }
    await Promise.resolve(expect(
      boundaries.publication.withCurrentPublication({
        authority: requested,
        mutation: true,
        use: async () => {
          uses += 1;
          return Object.freeze({ value: "must not commit" }) as never;
        },
      }),
    ).rejects.toThrow("authority is unavailable"));
    expect(uses).toBe(0);
  });

  test("pins the outer current-authority input before later operations", async () => {
    const original = current();
    const supplied = {
      ...input(),
      current: original,
    } as {
      authority: ProtectedMemoryAuthority;
      policy: ProtectedTaskMemoryBoundariesInput["policy"];
      current: ProtectedTaskMemoryAuthorityInput;
    };
    const observed: ProtectedTaskMemoryAuthorityInput[] = [];
    const boundaries = createProtectedTaskMemoryBoundaries(supplied, {
      withCurrentAuthority: (async (currentInput, use) => {
        observed.push(currentInput);
        return use(held());
      }) as CurrentOwner,
    });
    supplied.current = {
      ...original,
      subject: Object.freeze({ ...original.subject, userId: NS_B }),
    };
    if (boundaries.publication.withCurrentPublication === undefined) {
      throw new Error("expected held publication");
    }
    await boundaries.publication.withCurrentPublication({
      authority,
      mutation: false,
      use: async () => Object.freeze({ value: "read" }) as never,
    });
    expect(observed[0]).not.toBe(original);
    expect(observed[0]?.subject).toBe(original.subject);
  });

  test("rejects a wrong held policy and callback-time authority mutation before receipt", async () => {
    for (const wrongPolicy of [
      { mode: "shadow_encryption" as const, shadowBehavior: "strict" as const, revision: 7 },
      { mode: "encrypted_only" as const, shadowBehavior: "strict" as const, revision: 8 },
    ]) {
      let uses = 0;
      const boundaries = createProtectedTaskMemoryBoundaries(input(), {
        withCurrentAuthority: owner(use => use(held({ policy: wrongPolicy }))),
      });
      if (boundaries.publication.withCurrentPublication === undefined) {
        throw new Error("expected held publication");
      }
      await Promise.resolve(expect(
        boundaries.publication.withCurrentPublication({
          authority,
          mutation: true,
          use: async () => {
            uses += 1;
            return Object.freeze({ value: "must not commit" }) as never;
          },
        }),
      ).rejects.toThrow("authority is unavailable"));
      expect(uses).toBe(0);
    }

    const requested = {
      ...authority,
      readableNamespaceIds: [NS_A],
      mutableNamespaceIds: [NS_A],
    } satisfies ProtectedMemoryAuthority;
    const boundaries = createProtectedTaskMemoryBoundaries(input(), {
      withCurrentAuthority: owner(use => use(held())),
    });
    if (boundaries.publication.withCurrentPublication === undefined) {
      throw new Error("expected held publication");
    }
    let callbackFinished = false;
    await Promise.resolve(expect(
      boundaries.publication.withCurrentPublication({
        authority: requested,
        mutation: true,
        use: async assertCurrent => {
          requested.mutableNamespaceIds[0] = NS_B;
          await assertCurrent();
          callbackFinished = true;
          return Object.freeze({ value: "must not be observed" }) as never;
        },
      }),
    ).rejects.toThrow("authority is unavailable"));
    expect(callbackFinished).toBeFalse();
  });

  test("binds Task reads to the supplied transaction and never recovers late plaintext", async () => {
    const transaction = Object.freeze({});
    const rows = Object.freeze([{ ok: true }]);
    const executor = {
      query: async () => rows,
    } as unknown as PostgresJsBridgeConnection;
    const handle = Object.freeze({ role: "nautilo" }) as ConversationProductPostgresHandle;
    let verified = false;
    let runnerUsed = false;
    let ownerSawRunner = false;
    let boundRunner: ConversationProductCanonicalTransactionRunner | null = null;
    const runner = {
      role: "nautilo",
      transaction: async <Value>(
        use: (canonical: unknown, currentExecutor: unknown) => Promise<Value>,
      ) => {
        runnerUsed = true;
        return use(transaction, executor);
      },
    } as unknown as ConversationProductCanonicalTransactionRunner;
    const receipt = Object.freeze({ value: "read" });
    const boundaries = createProtectedTaskMemoryBoundaries(input(), {
      verifyProductHandle: async connection => {
        verified = await connection.query("select 1") === rows;
        return handle;
      },
      bindProductRunner: (_handle, bound) => {
        expect(_handle).toBe(handle);
        boundRunner = {
          ...runner,
          transaction: bound.transaction,
        } as ConversationProductCanonicalTransactionRunner;
        return boundRunner;
      },
      withCurrentAuthority: (async (currentInput, use) => {
        ownerSawRunner = currentInput.runner === boundRunner;
        await currentInput.runner.transaction(
          async (currentTransaction, currentExecutor) => {
            runnerUsed = true;
            expect(currentTransaction as unknown).toBe(transaction);
            expect(currentExecutor as unknown).toBe(executor);
          },
          { isolationLevel: "read committed" },
        );
        return use(held());
      }) as CurrentOwner,
    });
    const result = await boundaries.read.withCurrentRead({
      transaction: transaction as never,
      executor: executor as never,
      authority,
      use: async () => receipt as never,
    });
    expect(result as unknown).toBe(receipt);
    expect(verified).toBeTrue();
    expect(runnerUsed).toBeTrue();
    expect(ownerSawRunner).toBeTrue();

    const late = new Error("late read authority failure");
    const lateRead = createProtectedTaskMemoryBoundaries(input(), {
      verifyProductHandle: async () => handle,
      bindProductRunner: () => runner,
      withCurrentAuthority: owner(async use => {
        await use(held());
        throw late;
      }),
    });
    await Promise.resolve(expect(lateRead.read.withCurrentRead({
      transaction: transaction as never,
      executor: executor as never,
      authority,
      use: async () => receipt as never,
    })).rejects.toBe(late));
  });
});
