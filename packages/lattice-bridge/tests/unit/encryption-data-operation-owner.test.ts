import { describe, expect, test } from "bun:test";

import {
  bindEncryptionDataOperationOwner,
  classifyDataOperationFailure,
  ClassifiedDataOperationError,
  type DataOperationPolicySnapshot,
} from "../../src/transition/encryption-data-operation-owner.ts";

function owner(snapshot: DataOperationPolicySnapshot, calls: string[]) {
  return bindEncryptionDataOperationOwner({
    policy: {
      async resolve() {
        calls.push("resolve");
        return snapshot;
      },
      async revalidate(revision) {
        calls.push(`revalidate:${revision}`);
      },
    },
  });
}

const unavailable = () =>
  Promise.reject(
    new ClassifiedDataOperationError(
      "recoverable_availability",
      "protected representation is pending",
    ),
  );

describe("encryption data operation owner", () => {
  test("diagnostic classification does not expose arbitrary error names or messages", () => {
    const error = new Error("private message body");
    error.name = "private body copied into an error name";
    expect(classifyDataOperationFailure(error)).toBe("unknown");
    expect(classifyDataOperationFailure(new ClassifiedDataOperationError(
      "key_waiting", "private diagnostic detail",
    ))).toBe("key_waiting");
  });

  test.each([
    [
      { mode: "plaintext_only", shadowBehavior: "fallback" } as const,
      "ordinary",
    ],
    [
      { mode: "shadow_encryption", shadowBehavior: "fallback" } as const,
      "protected",
    ],
    [
      { mode: "shadow_encryption", shadowBehavior: "strict" } as const,
      "protected",
    ],
    [
      { mode: "encrypted_only", shadowBehavior: "fallback" } as const,
      "protected",
    ],
  ])(
    "keeps the same product read signature across policy %j",
    async (policy, expected) => {
      const calls: string[] = [];
      const result = await owner({ policy, revalidationToken: 7 }, calls).read({
        ordinary: async () => {
          calls.push("ordinary");
          return "ordinary";
        },
        protected: async () => {
          calls.push("protected");
          return "protected";
        },
        consumeOrdinary: (value) => value,
        consumeProtected: (value) => value,
      });
      expect(result).toEqual({
        representation: expected as "ordinary" | "protected",
        value: expected,
        revalidationToken: 7,
      });
      expect(calls).toEqual([
        "resolve",
        "revalidate:7",
        expected,
        "revalidate:7",
        "revalidate:7",
      ]);
    },
  );

  test("Plain never instantiates protected custody and Full never loads ordinary", async () => {
    const plainCalls: string[] = [];
    await owner(
      {
        policy: { mode: "plaintext_only", shadowBehavior: "fallback" },
        revalidationToken: 1,
      },
      plainCalls,
    ).read({
      ordinary: async () => "ok",
      consumeOrdinary: (v) => v,
      consumeProtected: (v: string) => v,
    });
    expect(plainCalls).toEqual([
      "resolve",
      "revalidate:1",
      "revalidate:1",
      "revalidate:1",
    ]);

    const fullCalls: string[] = [];
    const fullError = await owner(
      {
        policy: { mode: "encrypted_only", shadowBehavior: "fallback" },
        revalidationToken: 2,
      },
      fullCalls,
    )
      .read({
        ordinary: async () => {
          fullCalls.push("ordinary");
          return "leak";
        },
        protected: unavailable,
        consumeOrdinary: (v) => v,
        consumeProtected: (v: string) => v,
      })
      .catch((error: unknown) => error);
    expect(fullError).toBeInstanceOf(ClassifiedDataOperationError);
    expect(fullCalls).toEqual(["resolve", "revalidate:2"]);
  });

  test("only Fallback Shadow consumes ordinary after a classified protected failure", async () => {
    for (const shadowBehavior of ["fallback", "strict"] as const) {
      const calls: string[] = [];
      const attempt = owner(
        {
          policy: { mode: "shadow_encryption", shadowBehavior },
          revalidationToken: 3,
        },
        calls,
      ).read({
        protected: unavailable,
        ordinary: async () => {
          calls.push("ordinary");
          return "usable";
        },
        consumeOrdinary: (v) => v,
        consumeProtected: (v: string) => v,
      });
      if (shadowBehavior === "fallback") {
        expect(await attempt).toMatchObject({
          representation: "ordinary",
          value: "usable",
        });
        expect(calls).toEqual([
          "resolve",
          "revalidate:3",
          "revalidate:3",
          "ordinary",
          "revalidate:3",
          "revalidate:3",
        ]);
      } else {
        expect(await attempt.catch((error: unknown) => error)).toBeInstanceOf(
          ClassifiedDataOperationError,
        );
        expect(calls).toEqual(["resolve", "revalidate:3"]);
      }
    }
  });

  test.each(["integrity", "authority", "cancelled", "unknown"] as const)(
    "%s failures never fall back",
    async (failureClass) => {
      const calls: string[] = [];
      const error = await owner(
        {
          policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
          revalidationToken: 4,
        },
        calls,
      )
        .read({
          protected: () =>
            Promise.reject(
              new ClassifiedDataOperationError(failureClass, failureClass),
            ),
          ordinary: async () => {
            calls.push("ordinary");
            return "leak";
          },
          consumeOrdinary: (v) => v,
          consumeProtected: (v: string) => v,
        })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ failureClass });
      expect(calls).toEqual(["resolve", "revalidate:4"]);
    },
  );

  test("missing selected adapters fail explicitly", async () => {
    const calls: string[] = [];
    const error = await owner(
      {
        policy: { mode: "encrypted_only", shadowBehavior: "fallback" },
        revalidationToken: 4,
      },
      calls,
    )
      .read({
        consumeOrdinary: (v: string) => v,
        consumeProtected: (v: string) => v,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failureClass: "unsupported" });
  });

  test("a generation change cancels before any confidential loader runs", async () => {
    const calls: string[] = [];
    const bound = bindEncryptionDataOperationOwner({
      policy: {
        resolve: async () => ({
          policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
          revalidationToken: 8,
        }),
        revalidate: async () => {
          throw new ClassifiedDataOperationError(
            "cancelled",
            "generation changed",
          );
        },
      },
    });
    const error = await bound
      .read({
        ordinary: async () => {
          calls.push("ordinary");
          return "ordinary";
        },
        protected: async () => {
          calls.push("protected");
          return "protected";
        },
        consumeOrdinary: (v) => v,
        consumeProtected: (v) => v,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failureClass: "cancelled" });
    expect(calls).toEqual([]);
  });

  test("owns forward and reverse repair directions", async () => {
    const forwardCalls: string[] = [];
    const repaired = await owner(
      {
        policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
        revalidationToken: 5,
      },
      forwardCalls,
    ).read({
      protected: unavailable,
      ordinary: async () => "unused",
      repair: {
        forward: async () => {
          forwardCalls.push("forward");
          return "repaired";
        },
      },
      consumeOrdinary: (v) => v,
      consumeProtected: (v) => v,
    });
    expect(repaired).toMatchObject({
      representation: "protected",
      value: "repaired",
    });
    expect(forwardCalls).toEqual([
      "resolve",
      "revalidate:5",
      "revalidate:5",
      "forward",
      "revalidate:5",
      "revalidate:5",
    ]);

    const reverseCalls: string[] = [];
    await owner(
      {
        policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
        revalidationToken: 6,
      },
      reverseCalls,
    ).read({
      protected: async () => "protected",
      repair: {
        reverse: async () => {
          reverseCalls.push("reverse");
        },
      },
      consumeOrdinary: (v: string) => v,
      consumeProtected: (v) => v,
    });
    expect(reverseCalls).toEqual([
      "resolve",
      "revalidate:6",
      "revalidate:6",
      "reverse",
      "revalidate:6",
      "revalidate:6",
    ]);
  });

  test("revalidates the resolved revision immediately before publication", async () => {
    const calls: string[] = [];
    const result = await owner(
      {
        policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
        revalidationToken: 11,
      },
      calls,
    ).mutate({
      dual: async () => {
        calls.push("dual");
        return "plan";
      },
      publish: async (plan, context) => {
        calls.push(`publish:${context.revalidationToken}`);
        return plan;
      },
    });
    expect(result).toBe("plan");
    expect(calls).toEqual([
      "resolve",
      "revalidate:11",
      "dual",
      "revalidate:11",
      "publish:11",
    ]);
  });

  test("stale policy after a protected await prevents fallback body loading", async () => {
    const calls: string[] = [];
    let validations = 0;
    const bound = bindEncryptionDataOperationOwner({
      policy: {
        resolve: async () => ({
          policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
          revalidationToken: 20,
        }),
        revalidate: async () => {
          validations += 1;
          if (validations > 1)
            throw new ClassifiedDataOperationError("cancelled", "stale policy");
        },
      },
    });
    const error = await bound
      .read({
        protected: unavailable,
        ordinary: async () => {
          calls.push("ordinary");
          return "leak";
        },
        consumeOrdinary: (value) => value,
        consumeProtected: (value: string) => value,
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failureClass: "cancelled" });
    expect(calls).toEqual([]);
  });

  test("completes the permitted reverse obligation after forward repair", async () => {
    const calls: string[] = [];
    const result = await owner(
      {
        policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
        revalidationToken: 21,
      },
      calls,
    ).read({
      protected: unavailable,
      repair: {
        forward: async () => {
          calls.push("forward");
          return "protected";
        },
        reverse: async (value) => {
          calls.push(`reverse:${value}`);
        },
      },
      consumeOrdinary: (value: string) => value,
      consumeProtected: (value) => {
        calls.push(`consume:${value}`);
        return value;
      },
    });
    expect(result).toMatchObject({
      representation: "protected",
      value: "protected",
    });
    expect(calls).toEqual([
      "resolve",
      "revalidate:21",
      "revalidate:21",
      "forward",
      "revalidate:21",
      "reverse:protected",
      "revalidate:21",
      "consume:protected",
      "revalidate:21",
    ]);
  });

  test("runs an existing atomic mutation only after revalidation", async () => {
    const calls: string[] = [];
    const result = await owner(
      {
        policy: { mode: "encrypted_only", shadowBehavior: "fallback" },
        revalidationToken: 12,
      },
      calls,
    ).runMutation({
      protected: async ({ revalidationToken }) => {
        calls.push(`protected:${revalidationToken}`);
        return "published";
      },
    });
    expect(result).toBe("published");
    expect(calls).toEqual(["resolve", "revalidate:12", "protected:12"]);
  });

  test("Fallback preserves verified content while reverse repair is waiting", async () => {
    const calls: string[] = [];
    const result = await owner({ policy: { mode: "shadow_encryption",
      shadowBehavior: "fallback" }, revalidationToken: 22 }, calls).read({
      protected: async () => "verified",
      repair: { reverse: async () => {
        throw new ClassifiedDataOperationError("recoverable_availability", "waiting");
      } },
      consumeOrdinary: (value: string) => value,
      consumeProtected: (value) => value,
    });
    expect(result.value).toBe("verified");
  });

  test("Strict surfaces reverse repair availability failure", async () => {
    const calls: string[] = [];
    const error = await owner({ policy: { mode: "shadow_encryption",
      shadowBehavior: "strict" }, revalidationToken: 23 }, calls).read({
      protected: async () => "verified",
      repair: { reverse: async () => {
        throw new ClassifiedDataOperationError("recoverable_availability", "waiting");
      } },
      consumeOrdinary: (value: string) => value,
      consumeProtected: (value) => value,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failureClass: "recoverable_availability" });
  });
});
