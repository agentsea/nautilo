import { describe, expect, test } from "bun:test";
import type {
  BeginServiceLlmAttemptInput,
  SettlePersonalLlmAttemptInput,
} from "@nautilo/db";
import {
  runServiceEmbeddingAttempt,
  ServiceEmbeddingAttemptLedgerUnavailableError,
  type ServiceEmbeddingAttemptDependencies,
  type ServiceEmbeddingAttemptInput,
} from "../../src/usage/service-embedding-attempt";
import { runWithUsageContext } from "../../src/usage/usage-context";

const OWNER = { ownerToken: "service-embedding-owner" };

function harness(options: {
  owner?: ServiceEmbeddingAttemptDependencies["owner"];
  begin?: ServiceEmbeddingAttemptDependencies["begin"];
  settle?: ServiceEmbeddingAttemptDependencies["settle"];
} = {}) {
  const begins: BeginServiceLlmAttemptInput[] = [];
  const settlements: SettlePersonalLlmAttemptInput[] = [];
  const deps: ServiceEmbeddingAttemptDependencies = {
    owner: options.owner ?? (() => OWNER),
    begin: options.begin ?? (async (input) => { begins.push(input); }),
    settle: options.settle ?? (async (input) => { settlements.push(input); }),
  };
  return { begins, settlements, deps };
}

function attempt<T>(invoke: ServiceEmbeddingAttemptInput<T>["invoke"], signal?: AbortSignal) {
  return {
    provider: "openai" as const,
    model: "text-embedding-3-small",
    endpoint: "https://api.openai.com/v1/embeddings",
    dimensions: 3,
    ...(signal === undefined ? {} : { signal }),
    invoke,
  };
}

describe("service embedding durable attempts", () => {
  test("overrides ambient personal funding while retaining only causal attribution", async () => {
    const h = harness();
    const value = await runWithUsageContext({
      callType: "memory_review",
      userId: "ambient-user",
      roomId: "room-1",
      funding: {
        kind: "personal",
        humanUserId: "causal-human",
        payerHumanId: "personal-payer",
        providerRoute: "personal-openai",
        credentialId: "personal-credential",
        credentialRevision: 9,
      },
      metadata: { taskId: "task-1", operation: "memory-save",
        fundingKind: "personal", payerHumanId: "personal-payer",
        credentialId: "personal-credential", credentialRevision: 9,
        providerRoute: "personal-openai" },
    }, () => runServiceEmbeddingAttempt(attempt(async (observe) => {
      observe({ inputTokens: 10, totalTokens: 10 });
      return "embedding";
    }), h.deps));

    expect(value).toBe("embedding");
    expect(h.begins).toHaveLength(1);
    expect(h.begins[0]).toMatchObject({
      ownerToken: OWNER.ownerToken,
      userId: "causal-human",
      roomId: "room-1",
      taskId: "task-1",
      callType: "embedding",
      provider: "openai",
      model: "openai:text-embedding-3-small",
      providerRoute: "openai",
      endpoint: "https://api.openai.com/v1/embeddings",
      metadata: {
        operation: "memory-save",
        embeddingDimensions: 3,
        usagePricingSource: "explicit",
      },
    });
    expect(h.begins[0]).not.toHaveProperty("credentialId");
    expect(h.begins[0]).not.toHaveProperty("credentialRevision");
    expect(h.begins[0]?.metadata).not.toHaveProperty("fundingKind");
    expect(h.begins[0]?.metadata).not.toHaveProperty("payerHumanId");
    expect(h.begins[0]?.metadata).not.toHaveProperty("credentialId");
    expect(h.begins[0]?.metadata).not.toHaveProperty("credentialRevision");
    expect(h.begins[0]?.metadata).not.toHaveProperty("providerRoute");
    expect(h.settlements).toHaveLength(1);
    expect(h.settlements[0]).toMatchObject({
      ownerToken: OWNER.ownerToken,
      outcome: "succeeded",
      costState: "estimated",
      inputTokens: 10,
      totalTokens: 10,
    });
    expect(h.settlements[0]?.estimatedCostUsd).toBeCloseTo(0.0000002);
    expect(h.settlements[0]?.pricingVersion).toBeTruthy();
  });

  test("preserves explicit zero usage and provider-reported zero cost as actual", async () => {
    const h = harness();
    await runServiceEmbeddingAttempt(attempt(async (observe) => {
      observe({ inputTokens: 0, totalTokens: 0, actualCostUsd: 0,
        providerRequestId: "request-1" });
      return [1, 2, 3];
    }), h.deps);

    expect(h.settlements[0]).toMatchObject({
      outcome: "succeeded",
      costState: "actual",
      inputTokens: 0,
      totalTokens: 0,
      actualCostUsd: 0,
      estimatedCostUsd: 0,
      providerRequestId: "request-1",
    });
  });

  test("settles successful responses without usage as unknown instead of free", async () => {
    const h = harness();
    await runServiceEmbeddingAttempt(attempt(async () => [1, 2, 3]), h.deps);

    expect(h.settlements[0]).toMatchObject({
      outcome: "succeeded",
      costState: "unknown",
    });
    expect(h.settlements[0]).not.toHaveProperty("actualCostUsd");
    expect(h.settlements[0]).not.toHaveProperty("estimatedCostUsd");
  });

  test("settles provider failures as unknown and aborted work as cancelled", async () => {
    const failure = harness();
    const providerError = new Error("provider failed");
    expect(runServiceEmbeddingAttempt(attempt(async (observe) => {
      observe({ inputTokens: 4, totalTokens: 4 });
      throw providerError;
    }), failure.deps)).rejects.toBe(providerError);
    expect(failure.settlements[0]).toMatchObject({
      outcome: "unknown",
      failureCode: "outcome_unknown",
      costState: "estimated",
      inputTokens: 4,
    });

    const cancellation = new AbortController();
    cancellation.abort();
    const aborted = harness();
    expect(runServiceEmbeddingAttempt(attempt(async () => {
      throw new Error("aborted");
    }, cancellation.signal), aborted.deps)).rejects.toThrow("aborted");
    expect(aborted.settlements[0]).toMatchObject({
      outcome: "cancelled",
      failureCode: "cancelled",
      costState: "actual",
      actualCostUsd: 0,
    });
  });

  test("requires the durable owner and successful begin before provider dispatch", async () => {
    let calls = 0;
    const noOwner = harness({ owner: () => null });
    expect(runServiceEmbeddingAttempt(attempt(async () => { calls++; }), noOwner.deps))
      .rejects.toBeInstanceOf(ServiceEmbeddingAttemptLedgerUnavailableError);

    const unavailable = harness({ begin: async () => { throw new Error("database unavailable"); } });
    expect(runServiceEmbeddingAttempt(attempt(async () => { calls++; }), unavailable.deps))
      .rejects.toBeInstanceOf(ServiceEmbeddingAttemptLedgerUnavailableError);
    expect(calls).toBe(0);
  });

  test("settles a rejected post-begin authorization and pre-dispatch cancellation as zero cost", async () => {
    for (const cancelled of [false, true]) {
      const h = harness();
      const controller = new AbortController();
      if (cancelled) controller.abort(new Error("cancelled before dispatch"));
      let wires = 0;
      const authorizationError = new Error("embedding binding changed");
      const input = {
        ...attempt(async () => { wires++; }, controller.signal),
        assertStillAuthorized: () => {
          if (!cancelled) throw authorizationError;
        },
      };
      const error = await runServiceEmbeddingAttempt(input, h.deps)
        .catch((caught: unknown) => caught);
      expect(error).toBe(cancelled ? controller.signal.reason : authorizationError);
      expect(wires).toBe(0);
      expect(h.settlements).toHaveLength(1);
      expect(h.settlements[0]).toMatchObject(cancelled
        ? {
            outcome: "cancelled",
            costState: "actual",
            actualCostUsd: 0,
            failureCode: "cancelled",
          }
        : {
            outcome: "failed",
            costState: "actual",
            actualCostUsd: 0,
            failureCode: "pre_wire_authorization_changed",
          });
      expect(h.settlements[0]).not.toHaveProperty("providerRequestId");
    }
  });

  test("retries only the exact settlement and never repeats embedding work", async () => {
    let wireCalls = 0;
    let settlementCalls = 0;
    const settlements: SettlePersonalLlmAttemptInput[] = [];
    const h = harness({
      settle: async (input) => {
        settlements.push(input);
        settlementCalls++;
        if (settlementCalls === 1) throw new Error("lost acknowledgement");
      },
    });
    const result = await runServiceEmbeddingAttempt(attempt(async (observe) => {
      wireCalls++;
      observe({ inputTokens: 2, totalTokens: 2 });
      return "ok";
    }), h.deps);

    expect(result).toBe("ok");
    expect(wireCalls).toBe(1);
    expect(settlementCalls).toBe(2);
    expect(settlements[1]).toEqual(settlements[0]);
  });
});
