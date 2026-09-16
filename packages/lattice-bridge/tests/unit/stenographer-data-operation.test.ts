import { describe, expect, test } from "bun:test";

import {
  ClassifiedDataOperationError,
  bindEncryptionDataOperationOwner,
  type DataOperationFailureClass,
  type DataOperationPolicySnapshot,
} from "../../src/transition/encryption-data-operation-owner.ts";
import {
  createStenographerDataOperationPort,
  createStenographerCandidateDataOperationPort,
  StenographerAuthorizationWaitingError,
  type StenographerIntentAdapter,
  type StenographerPublicationContext,
} from "../../src/server/journal/stenographer-data-operation.ts";

const NOW = new Date("2026-09-10T10:00:00.000Z");

function dataOwner(snapshot: DataOperationPolicySnapshot, calls: string[]) {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: async () => {
        calls.push("resolve");
        return snapshot;
      },
      revalidate: async (token) => {
        calls.push(`revalidate:${token}`);
      },
    },
  });
}

function adapter(
  name: string,
  calls: string[],
  failure?: DataOperationFailureClass,
): StenographerIntentAdapter {
  const prepare = async () => {
    calls.push(`${name}:prepare`);
    if (failure !== undefined) {
      throw new ClassifiedDataOperationError(failure, failure);
    }
    return {
      publish: async () => {
        calls.push(`${name}:publish`);
        return { status: "completed" as const, processed: true as const };
      },
    };
  };
  return {
    prepareExtraction: prepare,
    prepareCompaction: prepare,
    prepareNextRebuild: prepare,
    prepareLegacyConversion: prepare,
  };
}

function attempt(calls: string[]) {
  return {
    signal: new AbortController().signal,
    assertCurrent: async () => {
      calls.push("attempt:current");
    },
    publish: async <Result>(operation: () => Promise<Result>) => {
      calls.push("attempt:publish");
      return operation();
    },
  };
}

async function run(
  policy: DataOperationPolicySnapshot["policy"],
  calls: string[],
  failures: Partial<Record<"ordinary" | "protected" | "dual", DataOperationFailureClass>> = {},
) {
  const port = createStenographerDataOperationPort({
    owner: dataOwner({ policy, revalidationToken: 9 }, calls),
    ordinary: adapter("ordinary", calls, failures.ordinary),
    protected: adapter("protected", calls, failures.protected),
    dual: adapter("dual", calls, failures.dual),
  });
  return port.runExtraction({
    roomId: "room-1",
    lane: "live",
    modelId: "model-1",
    now: NOW,
    attempt: attempt(calls),
  });
}

describe("Stenographer data operation", () => {
  test.each([
    [{ mode: "plaintext_only", shadowBehavior: "fallback" } as const, "ordinary"],
    [{ mode: "shadow_encryption", shadowBehavior: "fallback" } as const, "dual"],
    [{ mode: "shadow_encryption", shadowBehavior: "strict" } as const, "dual"],
    [{ mode: "encrypted_only", shadowBehavior: "fallback" } as const, "protected"],
  ])("selects one lazy representation for %j", async (policy, selected) => {
    const calls: string[] = [];
    expect(await run(policy, calls)).toEqual({
      status: "completed",
      processed: true,
    });
    expect(calls.filter((call) => call.endsWith(":prepare"))).toEqual([
      `${selected}:prepare`,
    ]);
    expect(calls.filter((call) => /^(ordinary|protected|dual):publish$/u.test(call))).toEqual([
      `${selected}:publish`,
    ]);
    expect(calls).toEqual([
      "resolve",
      "revalidate:9",
      "attempt:current",
      `${selected}:prepare`,
      "revalidate:9",
      "attempt:publish",
      `${selected}:publish`,
    ]);
  });

  test.each(["key_waiting", "recoverable_availability"] as const)(
    "Fallback retries ordinary after %s before publication",
    async (failure) => {
      const calls: string[] = [];
      await run(
        { mode: "shadow_encryption", shadowBehavior: "fallback" },
        calls,
        { dual: failure },
      );
      expect(calls.filter((call) => call.endsWith(":prepare"))).toEqual([
        "dual:prepare",
        "ordinary:prepare",
      ]);
      expect(calls.filter((call) => /^(ordinary|protected|dual):publish$/u.test(call))).toEqual([
        "ordinary:publish",
      ]);
    },
  );

  test.each(["unsupported", "integrity", "authority", "stale", "cancelled", "unknown"] as const)(
    "%s does not widen Fallback to ordinary",
    async (failure) => {
      const calls: string[] = [];
      const error = await run(
        { mode: "shadow_encryption", shadowBehavior: "fallback" },
        calls,
        { dual: failure },
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ failureClass: failure });
      expect(calls).not.toContain("ordinary:prepare");
    },
  );

  test("a missing Shadow adapter stays unsupported and never uses ordinary", async () => {
    const calls: string[] = [];
    const port = createStenographerDataOperationPort({
      owner: dataOwner({
        policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
        revalidationToken: 9,
      }, calls),
      ordinary: adapter("ordinary", calls),
    });
    const error = await port.runExtraction({
      roomId: "room-1",
      lane: "live",
      modelId: "model-1",
      now: NOW,
      attempt: attempt(calls),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ failureClass: "unsupported" });
    expect(calls).not.toContain("ordinary:prepare");
  });
});


describe("Stenographer grant wait boundary", () => {
  test.each([
    {mode: "encrypted_only", shadowBehavior: "fallback"},
    {mode: "shadow_encryption", shadowBehavior: "strict"},
  ] as const)("shows a resumable wait before model execution in %j", async policy => {
    const calls: string[] = [];
    const waiting = {...adapter("unused", calls), prepareExtraction: async () => {
      throw new StenographerAuthorizationWaitingError("device");
    }};
    const port = createStenographerDataOperationPort({owner: dataOwner({policy, revalidationToken: 9}, calls),
      ordinary: adapter("ordinary", calls), protected: waiting, dual: waiting});
    expect(await port.runExtraction({roomId: "room-1", lane: "live", modelId: "model-1", now: NOW, attempt: attempt(calls)}))
      .toEqual({status: "waiting", processed: true, reason: "device"});
    expect(calls).not.toContain("ordinary:prepare");
    expect(calls).not.toContain("attempt:publish");
  });
  test("permits ordinary preparation on a pre-model grant wait in Fallback", async () => {
    const calls: string[] = [];
    const dual = {...adapter("dual", calls), prepareExtraction: async () => {
      throw new StenographerAuthorizationWaitingError("authority");
    }};
    const port = createStenographerDataOperationPort({owner: dataOwner({
      policy: {mode: "shadow_encryption", shadowBehavior: "fallback"}, revalidationToken: 9}, calls),
      ordinary: adapter("ordinary", calls), dual});
    expect(await port.runExtraction({roomId: "room-1", lane: "live", modelId: "model-1", now: NOW, attempt: attempt(calls)}))
      .toMatchObject({status: "completed"});
    expect(calls).toContain("ordinary:prepare");
  });
  test("never substitutes ordinary execution after the model/publication closure started", async () => {
    const calls: string[] = [];
    const late = new StenographerAuthorizationWaitingError("authority");
    const dual = {...adapter("dual", calls), prepareExtraction: async () => ({publish: async () => {throw late;}})};
    const port = createStenographerDataOperationPort({owner: dataOwner({
      policy: {mode: "shadow_encryption", shadowBehavior: "fallback"}, revalidationToken: 9}, calls),
      ordinary: adapter("ordinary", calls), dual});
    expect(port.runExtraction({roomId: "room-1", lane: "live", modelId: "model-1", now: NOW, attempt: attempt(calls)}))
      .rejects.toBe(late);
    expect(calls).not.toContain("ordinary:prepare");
  });
});


describe("Stenographer candidate discovery", () => {
  test.each([
    ["plaintext_only", "ordinary"],
    ["shadow_encryption", "protected"],
    ["encrypted_only", "protected"],
  ] as const)("keeps %s discovery inside the selected owner", async (mode, expected) => {
    const calls: string[] = [];
    const candidates = (name: string) => ({
      extraction: () => {calls.push(`${name}:extraction`); return Promise.resolve([name]);},
      compaction: () => {calls.push(`${name}:compaction`); return Promise.resolve([name]);},
      initializeHistorical: () => {calls.push(`${name}:initialize`); return Promise.resolve();},
    });
    const port = createStenographerCandidateDataOperationPort({
      owner: dataOwner({policy: {mode, shadowBehavior: "strict"}, revalidationToken: 9}, calls),
      ordinary: candidates("ordinary"),
      protected: () => {calls.push("crypto:init"); return Promise.resolve(candidates("protected"));},
    });
    expect(await port.extraction({lane: "live", now: NOW})).toEqual([expected]);
    expect(await port.compaction({now: NOW})).toEqual([expected]);
    await port.initializeHistorical({now: NOW});
    expect(calls.filter((call) => call.endsWith(":initialize"))).toEqual(["ordinary:initialize"]);
    expect(calls.filter((call) => call === "crypto:init")).toHaveLength(mode === "plaintext_only" ? 0 : 2);
  });
});


describe("Stenographer fallback handoff", () => {
  test.each([
    ["plaintext_only", "device", undefined],
    ["shadow_encryption", "device", "device"],
    ["shadow_encryption", "authority", "authority"],
  ] as const)("records publication provenance only after selected fallback (%s, %s)", async (mode, reason, expected) => {
    const calls: string[] = [];
    const contexts: StenographerPublicationContext[] = [];
    const ordinary: StenographerIntentAdapter = {...adapter("ordinary", calls), prepareExtraction: async () => ({
      publish: async context => {contexts.push(context); return {status: "completed", processed: true};},
    })};
    const dual = {...adapter("dual", calls), prepareExtraction: () => Promise.reject(
      new StenographerAuthorizationWaitingError(reason, async () => {calls.push("handoff"); return true;}),
    )};
    const port = createStenographerDataOperationPort({owner: dataOwner({policy: {mode, shadowBehavior: "fallback"}, revalidationToken: 9}, calls),
      ordinary, dual});
    expect(await port.runExtraction({roomId: "room-1", lane: "live", modelId: "model-1", now: NOW, attempt: attempt(calls)}))
      .toEqual({status: "completed", processed: true});
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.ordinaryFallbackReason).toBe(expected);
    expect(calls.filter(call => call === "handoff")).toHaveLength(mode === "plaintext_only" ? 0 : 1);
    expect(calls.indexOf("revalidate:9")).toBeLessThan(calls.indexOf("attempt:publish"));
  });

  test.each([true, false])("ordinary preparation follows only a successful exact handoff (%s)", async (won) => {
    const calls: string[] = [];
    const dual = {...adapter("dual", calls), prepareExtraction: () => Promise.reject(
      new StenographerAuthorizationWaitingError("device", () => {calls.push("handoff"); return Promise.resolve(won);}),
    )};
    const port = createStenographerDataOperationPort({owner: dataOwner({policy: {mode: "shadow_encryption", shadowBehavior: "fallback"}, revalidationToken: 9}, calls),
      ordinary: adapter("ordinary", calls), dual});
    const result = await port.runExtraction({roomId: "room-1", lane: "live", modelId: "model-1", now: NOW, attempt: attempt(calls)});
    expect(result.status).toBe(won ? "completed" : "waiting");
    expect(calls.filter((call) => call === "handoff")).toHaveLength(1);
    expect(calls.includes("ordinary:prepare")).toBe(won);
    if (won) expect(calls.indexOf("handoff")).toBeLessThan(calls.indexOf("ordinary:prepare"));
  });
});


test("completed ordinary publication clears old authority wait without losing a committed outcome to status failure", async () => {
  const calls: string[] = [];
  const cleared: unknown[] = [];
  const port = createStenographerDataOperationPort({
    owner: dataOwner({policy: {mode: "plaintext_only", shadowBehavior: "fallback"}, revalidationToken: 9}, calls),
    ordinary: adapter("ordinary", calls),
    authorizationWait: {clear: async input => {cleared.push(input); throw new Error("status connection lost");}},
  });
  expect(await port.runExtraction({roomId: "room", lane: "historical", modelId: "model", now: NOW, attempt: attempt(calls)}))
    .toEqual({status: "completed", processed: true});
  expect(cleared).toEqual([{roomId: "room", lane: "historical"}]);
});

test("authority waiting remains durable until a real completed or unavailable outcome", async () => {
  const calls: string[] = [];
  let cleared = 0;
  const waitingAdapter = {...adapter("dual", calls), prepareExtraction: async () => {throw new StenographerAuthorizationWaitingError("authority");}};
  const port = createStenographerDataOperationPort({
    owner: dataOwner({policy: {mode: "shadow_encryption", shadowBehavior: "strict"}, revalidationToken: 9}, calls),
    dual: waitingAdapter,
    authorizationWait: {clear: async () => {cleared++;}},
  });
  expect(await port.runExtraction({roomId: "room", lane: "live", modelId: "model", now: NOW, attempt: attempt(calls)}))
    .toMatchObject({status: "waiting", reason: "authority"});
  expect(cleared).toBe(0);
});
