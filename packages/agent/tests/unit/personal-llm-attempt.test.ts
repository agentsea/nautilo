import { describe, expect, test } from "bun:test";
import {
  classifyPersonalAttemptFailure,
  runPersonalLlmAttempt,
  PersonalAttemptInvocationError,
  PersonalAttemptLedgerUnavailableError,
} from "../../src/usage/personal-llm-attempt";
import { getUsageContext, runWithUsageContext } from "../../src/usage/usage-context";
import type { BeginPersonalLlmAttemptInput, BeginServiceLlmAttemptInput, SettlePersonalLlmAttemptInput } from "@nautilo/db";
import {
  getPersonalLlmAttemptOwner,
  installPersonalLlmAttemptOwner,
} from "../../src/usage/personal-llm-attempt-owner";

const funding = { kind: "personal" as const, humanUserId: "10000000-0000-4000-8000-000000000001",
  payerHumanId: "10000000-0000-4000-8000-000000000001", providerRoute: "openai",
  credentialId: "20000000-0000-4000-8000-000000000002", credentialRevision: 4 };
const owner = { ownerToken: "99999999-9999-4999-8999-999999999999" };
function harness() {
  const begun: BeginPersonalLlmAttemptInput[] = [];
  const settled: SettlePersonalLlmAttemptInput[] = [];
  return { begun, settled, deps: { owner: () => owner,
    begin: async (row: BeginPersonalLlmAttemptInput) => { begun.push(row); },
    settle: async (row: SettlePersonalLlmAttemptInput) => { settled.push(row); } } };
}
const scope = <T>(fn: () => T) => runWithUsageContext({ callType: "chat", funding, metadata: { turnId: "synthetic-turn" } }, fn);
const modelId = "openai:gpt-5.6-luna";

describe("durable personal direct attempts", () => {
  test("an old uninstall cannot clear a later process owner", () => {
    const uninstallFirst = installPersonalLlmAttemptOwner(owner);
    expect(getPersonalLlmAttemptOwner()).toEqual(owner);
    uninstallFirst();
    const replacement = { ownerToken: "88888888-8888-4888-8888-888888888888" };
    const uninstallReplacement = installPersonalLlmAttemptOwner(replacement);
    uninstallFirst();
    expect(getPersonalLlmAttemptOwner()).toEqual(replacement);
    uninstallReplacement();
    expect(getPersonalLlmAttemptOwner()).toBeNull();
  });
  test("begins before the wire and settles one frozen estimate from callback evidence", async () => {
    const h = harness();
    const answer = await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => {
      expect(h.begun).toHaveLength(1);
      expect(h.begun[0]).toMatchObject({ userId: funding.humanUserId, credentialRevision: 4, providerRoute: "openai" });
      expect(h.begun[0]).toMatchObject({ ownerToken: owner.ownerToken });
      const context = getUsageContext()!;
      expect(context.trackedAttemptId).toBe(h.begun[0]!.id);
      context.onAttemptUsage!({ inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cachedInputTokens: 0,
        cacheCreationTokens: 0, actualCostUsd: null });
      return "answer";
    } }, h.deps));
    expect(answer).toBe("answer");
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({ attemptId: h.begun[0]!.id, outcome: "succeeded", costState: "estimated", inputTokens: 100 });
    expect(h.settled[0]!.estimatedCostUsd).toBeGreaterThan(0);
    expect(h.settled[0]!.pricingVersion).toBeTruthy();
  });
  test("a successful answer without usage remains unknown instead of zero", async () => {
    const h = harness();
    await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => "answer" }, h.deps));
    expect(h.settled[0]).toMatchObject({ outcome: "succeeded", costState: "unknown" });
    expect(h.settled[0]!.actualCostUsd).toBeUndefined();
    expect(h.settled[0]!.estimatedCostUsd).toBeUndefined();
  });
  test("observed provider zero cost is actual evidence", async () => {
    const h = harness();
    await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => {
      getUsageContext()!.onAttemptUsage!({ inputTokens: 1, outputTokens: 1, reasoningTokens: 0,
        cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: 0 }); return "answer";
    } }, h.deps));
    expect(h.settled[0]).toMatchObject({ costState: "actual", actualCostUsd: 0 });
  });
  test("persists an explicit provider response reference without treating it as free", async () => {
    const h = harness();
    await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => {
      getUsageContext()!.onAttemptUsage!({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
        cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: null,
        providerRequestId: "chatcmpl-provider-receipt" });
      return "answer";
    } }, h.deps));
    expect(h.settled[0]).toMatchObject({
      outcome: "succeeded",
      costState: "unknown",
      providerRequestId: "chatcmpl-provider-receipt",
    });
    expect(h.settled[0]!.actualCostUsd).toBeUndefined();
    expect(h.settled[0]!.estimatedCostUsd).toBeUndefined();
  });
  test("late usage settles financial evidence without changing the cancelled outcome", async () => {
    const h = harness();
    const cancellation = new AbortController();
    let callback: NonNullable<ReturnType<typeof getUsageContext>>["onAttemptUsage"];
    try {
      await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", signal: cancellation.signal,
        invoke: async () => {
          callback = getUsageContext()!.onAttemptUsage;
          cancellation.abort();
          throw new Error("cancelled");
        } }, h.deps));
    } catch { /* The cancelled inference must stay cancelled. */ }
    expect(h.settled[0]).toMatchObject({ outcome: "cancelled", costState: "unknown" });
    callback!({ inputTokens: 10, outputTokens: 3, reasoningTokens: 0,
      cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: 0.001 });
    expect(h.settled[1]).toMatchObject({ attemptId: h.begun[0]!.id,
      outcome: "cancelled", costState: "actual", actualCostUsd: 0.001, preserveOutcome: true });
    await Promise.resolve();
    callback!({ inputTokens: 10, outputTokens: 3, reasoningTokens: 0,
      cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: 0.001 });
    expect(h.settled).toHaveLength(2);
  });
  test("a cancelled or failed wire still has the original payer record", async () => {
    const h = harness(); const cancellation = new AbortController();
    const providerError = new Error("cancelled");
    const thrown = await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", signal: cancellation.signal,
      invoke: async () => { cancellation.abort(); throw providerError; } }, h.deps)).then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(PersonalAttemptInvocationError);
    expect(thrown).toMatchObject({ disposition: "terminal_cancelled", cause: providerError });
    expect(h.begun[0]).toMatchObject({ userId: funding.humanUserId, credentialId: funding.credentialId });
    expect(h.settled[0]).toMatchObject({ outcome: "cancelled", costState: "unknown" });
  });
  test("records explicit provider refusals as failed but leaves uncertain errors unknown", async () => {
    const rejected = harness();
    const rejectedError = Object.assign(new Error("rejected"), {
      status: 401,
      headers: new Headers({ "x-request-id": "request-rejected" }),
    });
    const rejectedThrown = await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions",
      invoke: async () => { throw rejectedError; } }, rejected.deps)).then(() => null, (error: unknown) => error);
    expect(rejectedThrown).toBeInstanceOf(PersonalAttemptInvocationError);
    expect(rejectedThrown).toMatchObject({ disposition: "safe_refusal", cause: rejectedError });
    expect(rejected.settled[0]).toMatchObject({
      outcome: "failed",
      costState: "unknown",
      failureCode: "provider_refused",
      providerRequestId: "request-rejected",
    });
    expect(rejected.settled[0]!.actualCostUsd).toBeUndefined();

    for (const error of [
      Object.assign(new Error("provider timeout"), { status: 408 }),
      Object.assign(new Error("upstream unavailable"), { status: 503 }),
      Object.assign(new Error("socket lost"), { code: "ECONNRESET" }),
    ]) {
      const uncertain = harness();
      const thrown = await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions",
        invoke: async () => { throw error; } }, uncertain.deps)).then(() => null, (caught: unknown) => caught);
      expect(thrown).toBeInstanceOf(PersonalAttemptInvocationError);
      expect(thrown).toMatchObject({ disposition: "terminal_unknown", cause: error });
      expect(uncertain.settled[0]).toMatchObject({
        outcome: "unknown",
        costState: "unknown",
        failureCode: "outcome_unknown",
      });
    }
  });
  test("ledger admission failure prevents paid work; post-answer settlement failure never repeats it", async () => {
    let calls = 0;
    expect(scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => { calls++; } },
      { owner: () => owner, begin: async () => { throw new Error("database unavailable"); }, settle: async () => {} }))).rejects.toBeInstanceOf(PersonalAttemptLedgerUnavailableError);
    expect(calls).toBe(0);
    const h = harness();
    const answer = await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => { calls++; return "answer"; } },
      { ...h.deps, settle: async () => { throw new Error("settlement unavailable"); } }));
    expect(answer).toBe("answer"); expect(calls).toBe(1); expect(h.begun).toHaveLength(1);
  });
  test("missing durable process ownership prevents the wire", async () => {
    let calls = 0;
    const h = harness();
    expect(scope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      invoke: async () => { calls += 1; },
    }, { ...h.deps, owner: () => null }))).rejects.toBeInstanceOf(PersonalAttemptLedgerUnavailableError);
    expect(calls).toBe(0);
    expect(h.begun).toHaveLength(0);
  });
  test("retries one exact immutable settlement after acknowledgement loss without replaying inference", async () => {
    const h = harness();
    const settlements: SettlePersonalLlmAttemptInput[] = [];
    let invokes = 0;
    const answer = await scope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      invoke: async () => { invokes += 1; return "answer"; },
    }, {
      owner: () => owner,
      begin: h.deps.begin,
      settle: async (input) => {
        settlements.push(input);
        if (settlements.length === 1) throw new Error("acknowledgement lost");
      },
    }));
    expect(answer).toBe("answer");
    expect(invokes).toBe(1);
    expect(settlements).toHaveLength(2);
    expect(settlements[1]).toBe(settlements[0]);
    expect(Object.isFrozen(settlements[0])).toBe(true);
    expect(settlements[0]?.settledAt).toBeInstanceOf(Date);
  });
});

describe("personal direct attempt terminal classification", () => {
  test("allows only shared documented pre-service refusal statuses", () => {
    for (const status of [400, 401, 403, 404, 429]) {
      expect(classifyPersonalAttemptFailure({ cause: { response: { status } } }, false))
        .toEqual({ outcome: "failed", failureCode: "provider_refused", disposition: "safe_refusal" });
    }

    for (const status of [402, 405, 409, 413, 415, 418, 422, 499]) {
      expect(classifyPersonalAttemptFailure(Object.assign(new Error("request timeout"), { status }), false))
        .toEqual({ outcome: "unknown", failureCode: "outcome_unknown", disposition: "terminal_unknown" });
    }
    expect(classifyPersonalAttemptFailure(Object.assign(new Error("rate limit exceeded"), { status: 418 }), false))
      .toEqual({ outcome: "unknown", failureCode: "outcome_unknown", disposition: "terminal_unknown" });
    expect(classifyPersonalAttemptFailure(new Error("401 unauthorized"), false))
      .toEqual({ outcome: "unknown", failureCode: "outcome_unknown", disposition: "terminal_unknown" });
    expect(classifyPersonalAttemptFailure({ status: 401 }, true))
      .toEqual({ outcome: "cancelled", failureCode: "cancelled", disposition: "terminal_cancelled" });
    expect(classifyPersonalAttemptFailure({ status: 429 }, false, true))
      .toEqual({ outcome: "unknown", failureCode: "outcome_unknown", disposition: "terminal_unknown" });
  });
});


describe("explicit nonpersonal Memory model attempts", () => {
  for (const kind of ["server", "service"] as const) {
    test(`${kind} review has one durable unknown-cost row even when successful usage is absent`, async () => {
      const begun: BeginServiceLlmAttemptInput[] = [];
      const settled: SettlePersonalLlmAttemptInput[] = [];
      const ordinary = harness();
      const begin = async (row: BeginServiceLlmAttemptInput) => { begun.push(row); };
      const settle = async (row: SettlePersonalLlmAttemptInput) => { settled.push(row); };
      await runWithUsageContext({ callType: "memory_review", funding: {kind, providerRoute:"openai"} },
        () => runPersonalLlmAttempt({modelId,endpoint:"/v1/chat/completions",invoke:async()=> {
          expect(begun).toHaveLength(1);
          expect(getUsageContext()?.trackedAttemptId).toBe(begun[0]!.id);
          return "complete";
        }}, {...ordinary.deps, beginService:begin,settleService:settle,beginServer:begin,settleServer:settle}));
      expect(ordinary.begun).toHaveLength(0);
      expect(begun[0]!.userId).toBeNull();
      expect(begun[0]).not.toHaveProperty("credentialId");
      expect(settled[0]).toMatchObject({outcome:"succeeded",costState:"unknown"});
    });
  }
  test("a service review cannot dispatch without the durable accounting owner", async () => {
    let calls = 0;
    const ordinary = harness();
    const outcome = await runWithUsageContext({callType:"memory_review",funding:{kind:"service",providerRoute:"openai"}},
      () => runPersonalLlmAttempt({modelId,endpoint:"/v1/chat/completions",invoke:async()=>{calls++;}},
        {...ordinary.deps,owner:()=>null,beginService:async()=>{},settleService:async()=>{}}))
      .then(() => null, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(PersonalAttemptLedgerUnavailableError);
    expect(calls).toBe(0);
  });
});

describe("Soul service direct attempts", () => {
  const soulScope = <T>(fn: () => T, providerRoute = "openai") => runWithUsageContext({
    callType: "soul", userId: funding.humanUserId,
    funding: { kind: "service", humanUserId: funding.humanUserId, providerRoute },
    metadata: { agentId: "synthetic-agent", service: "soul_generation" },
  }, fn);

  test("opens a service row before dispatch and retains actual zero without personal provenance", async () => {
    const ordinary = harness();
    const begun: BeginServiceLlmAttemptInput[] = [];
    const settled: SettlePersonalLlmAttemptInput[] = [];
    await soulScope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => {
      expect(begun).toHaveLength(1);
      expect(getUsageContext()?.trackedAttemptId).toBe(begun[0]!.id);
      getUsageContext()?.onAttemptUsage?.({ inputTokens: 10, outputTokens: 4,
        reasoningTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: 0 });
      return "generated Soul";
    } }, { ...ordinary.deps,
      beginService: async (row) => { begun.push(row); },
      settleService: async (row) => { settled.push(row); },
    }));
    expect(ordinary.begun).toHaveLength(0);
    expect(begun[0]).toMatchObject({ callType: "soul", userId: funding.humanUserId,
      model: modelId, providerRoute: "openai", metadata: { agentId: "synthetic-agent" } });
    expect(begun[0]).not.toHaveProperty("credentialId");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: "succeeded", costState: "actual", actualCostUsd: 0 });
  });

  test("settles a post-admission authorization denial as known-unsent and preserves the original 403", async () => {
    const ordinary = harness();
    const begun: BeginServiceLlmAttemptInput[] = [];
    const settled: SettlePersonalLlmAttemptInput[] = [];
    const denial = Object.assign(new Error("Soul funding authorization changed"), { status: 403 });
    let authorized = true;
    let invokes = 0;

    const thrown = await soulScope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      assertStillAuthorized: () => { if (!authorized) throw denial; },
      invoke: async () => { invokes++; return "must not dispatch"; },
    }, {
      ...ordinary.deps,
      beginService: async (row) => { begun.push(row); authorized = false; },
      settleService: async (row) => { settled.push(row); },
    })).then(() => null, (error: unknown) => error);

    expect(thrown).toBe(denial);
    expect(thrown).toMatchObject({ status: 403 });
    expect(invokes).toBe(0);
    expect(begun).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      outcome: "failed",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "authorization_changed",
    });
  });

  test.each(["policy", "key"] as const)(
    "settles a %s mutation during durable admission without invoking direct Soul",
    async (mutation) => {
      const ordinary = harness();
      const settled: SettlePersonalLlmAttemptInput[] = [];
      let policyEnabled = true;
      let credential = "original-key";
      let invokes = 0;
      const changed = new Error(`Soul ${mutation} changed during admission`);
      const thrown = await soulScope(() => runPersonalLlmAttempt({
        modelId,
        endpoint: "/v1/chat/completions",
        assertStillAuthorized: () => {
          if (!policyEnabled || credential !== "original-key") throw changed;
        },
        invoke: async () => { invokes++; return "must not dispatch"; },
      }, {
        ...ordinary.deps,
        beginService: async () => {
          if (mutation === "policy") policyEnabled = false;
          else credential = "replacement-key";
        },
        settleService: async (row) => { settled.push(row); },
      })).then(() => null, (error: unknown) => error);

      expect(thrown).toBe(changed);
      expect(invokes).toBe(0);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        outcome: "failed",
        costState: "actual",
        actualCostUsd: 0,
        failureCode: "authorization_changed",
      });
    },
  );

  test("settles an abort that arrives during durable admission without invoking direct Soul", async () => {
    const ordinary = harness();
    const settled: SettlePersonalLlmAttemptInput[] = [];
    const abort = new AbortController();
    const cancellation = new Error("Soul request cancelled during admission");
    let invokes = 0;

    const thrown = await soulScope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      signal: abort.signal,
      assertStillAuthorized: () => abort.signal.throwIfAborted(),
      invoke: async () => { invokes++; return "must not dispatch"; },
    }, {
      ...ordinary.deps,
      beginService: async () => { abort.abort(cancellation); },
      settleService: async (row) => { settled.push(row); },
    })).then(() => null, (error: unknown) => error);

    expect(thrown).toBe(cancellation);
    expect(invokes).toBe(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      outcome: "cancelled",
      costState: "actual",
      actualCostUsd: 0,
      failureCode: "cancelled",
    });
  });

  test("cannot dispatch without its durable service owner", async () => {
    const h = harness();
    let calls = 0;
    await Promise.resolve(expect(soulScope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions",
      invoke: async () => { calls++; },
    }, { ...h.deps, owner: () => null, beginService: async () => {}, settleService: async () => {} })))
      .rejects.toBeInstanceOf(PersonalAttemptLedgerUnavailableError));
    expect(calls).toBe(0);
  });

  test("retains cancellation with unknown cost without replaying a streamed direct call", async () => {
    const h = harness();
    const settled: SettlePersonalLlmAttemptInput[] = [];
    const abort = new AbortController();
    let calls = 0;
    await Promise.resolve(expect(soulScope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions",
      signal: abort.signal, hasObservedProviderWork: () => true, invoke: async () => {
        calls++;
        abort.abort();
        throw new Error("synthetic stream closed");
      },
    }, { ...h.deps, beginService: async () => {}, settleService: async (row) => { settled.push(row); } })))
      .rejects.toBeInstanceOf(PersonalAttemptInvocationError));
    expect(calls).toBe(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: "cancelled", costState: "unknown" });
    expect(settled[0]).not.toHaveProperty("actualCostUsd");
  });

  test("leaves Surplus Soul attempts to the existing marketplace ledger", async () => {
    const h = harness();
    let calls = 0;
    await soulScope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions",
      invoke: async () => { calls++; return "marketplace Soul"; },
    }, { ...h.deps, owner: () => null }), "surplus");
    expect(calls).toBe(1);
    expect(h.begun).toHaveLength(0);
  });
});

describe("server-funded image assistance attempts", () => {
  function imageHarness() {
    const begun: BeginServiceLlmAttemptInput[] = [];
    const settled: SettlePersonalLlmAttemptInput[] = [];
    const ordinary = harness();
    return {
      begun,
      settled,
      deps: {
        ...ordinary.deps,
        beginServer: async (input: BeginServiceLlmAttemptInput) => { begun.push(input); },
        settleServer: async (input: SettlePersonalLlmAttemptInput) => { settled.push(input); },
      },
    };
  }

  const imageScope = <T>(fn: () => T) => runWithUsageContext({
    callType: "image_assistance",
    userId: "10000000-0000-4000-8000-000000000001",
    roomId: "30000000-0000-4000-8000-000000000003",
    funding: {
      kind: "server" as const,
      humanUserId: "10000000-0000-4000-8000-000000000001",
      providerRoute: "openai",
    },
    metadata: { operationId: "image-assistance:turn-a:digest-a", turnId: "turn-a" },
  }, fn);

  test("begins before dispatch and settles callback evidence on the same attempt", async () => {
    const h = imageHarness();
    const result = await imageScope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      invoke: async () => {
        expect(h.begun).toHaveLength(1);
        expect(h.begun[0]).toMatchObject({
          callType: "image_assistance",
          userId: "10000000-0000-4000-8000-000000000001",
          roomId: "30000000-0000-4000-8000-000000000003",
          providerRoute: "openai",
          metadata: {
            operationId: "image-assistance:turn-a:digest-a",
            turnId: "turn-a",
          },
        });
        expect(getUsageContext()?.trackedAttemptId).toBe(h.begun[0]!.id);
        getUsageContext()?.onAttemptUsage?.({
          inputTokens: 120,
          outputTokens: 24,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          actualCostUsd: null,
        });
        return "observations";
      },
    }, h.deps));

    expect(result).toBe("observations");
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({
      attemptId: h.begun[0]!.id,
      outcome: "succeeded",
      costState: "estimated",
      inputTokens: 120,
      outputTokens: 24,
    });
  });

  test("keeps missing usage unknown and records a proven refusal without replay", async () => {
    const missing = imageHarness();
    await imageScope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      invoke: async () => "observations",
    }, missing.deps));
    expect(missing.settled).toHaveLength(1);
    expect(missing.settled[0]).toMatchObject({ outcome: "succeeded", costState: "unknown" });

    const refused = imageHarness();
    let invokes = 0;
    const providerError = Object.assign(new Error("rejected"), { status: 429 });
    const error = await imageScope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      invoke: async () => { invokes += 1; throw providerError; },
    }, refused.deps)).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ disposition: "safe_refusal", cause: providerError });
    expect(invokes).toBe(1);
    expect(refused.begun).toHaveLength(1);
    expect(refused.settled).toHaveLength(1);
    expect(refused.settled[0]).toMatchObject({
      outcome: "failed",
      costState: "unknown",
      failureCode: "provider_refused",
    });
  });

  test("preserves cancellation when late actual cost arrives", async () => {
    const h = imageHarness();
    const abort = new AbortController();
    let callback: NonNullable<ReturnType<typeof getUsageContext>>["onAttemptUsage"];
    const error = await imageScope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      signal: abort.signal,
      invoke: async () => {
        callback = getUsageContext()!.onAttemptUsage;
        abort.abort();
        throw new Error("cancelled");
      },
    }, h.deps)).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ disposition: "terminal_cancelled" });
    expect(h.settled[0]).toMatchObject({ outcome: "cancelled", costState: "unknown" });

    callback!({
      inputTokens: 12,
      outputTokens: 3,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      actualCostUsd: 0.002,
    });
    expect(h.settled[1]).toMatchObject({
      outcome: "cancelled",
      costState: "actual",
      actualCostUsd: 0.002,
      preserveOutcome: true,
    });
  });

  test("settlement failure returns completed output without another invocation", async () => {
    const h = imageHarness();
    let invokes = 0;
    let settlements = 0;
    const result = await imageScope(() => runPersonalLlmAttempt({
      modelId,
      endpoint: "/v1/chat/completions",
      invoke: async () => { invokes += 1; return "retained observations"; },
    }, {
      ...h.deps,
      settleServer: async () => { settlements += 1; throw new Error("database unavailable"); },
    }));
    expect(result).toBe("retained observations");
    expect(invokes).toBe(1);
    expect(settlements).toBe(2);
    expect(h.begun).toHaveLength(1);
  });
});
