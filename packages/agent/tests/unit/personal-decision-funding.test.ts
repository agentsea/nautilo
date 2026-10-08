import { describe, expect, test } from "bun:test";
import type { TaskFundingBinding } from "@nautilo/types";
import { ChoiceRequestError } from "../../src/providers/choice";
import { invokeDecision } from "../../src/providers/decision-driver";
import { invokeProviderChoice } from "../../src/providers/provider-choice";
import {
  prepareDecisionFunding,
  runPreparedDecision,
} from "../../src/providers/decision-funding";
import {
  invokeSurplusDecisionAttempt,
  SurplusDecisionDirectFallbackError,
  SurplusDecisionHttpError,
} from "../../src/providers/surplus-decision-attempt";
import { SurplusOutcomeUnknownError } from "../../src/providers/surplus-transport";
import {
  resolveQualifiedSurplusDecisionRoute,
  resolveSurplusDecisionServingAvailability,
} from "../../src/providers/surplus-decision-route";
import {
  runWithCapabilityFundingSession,
  type CapabilityFundingSession,
} from "../../src/runtime/capability-funding";
import { createDiscoverModelsTool } from "../../src/tools/meta/discover-models";
import { getUsageContext, runWithUsageContext } from "../../src/usage/usage-context";

const MODEL_ID = "openrouter:typesafe/jev-1.13";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const question = {
  label: {
    type: "choice" as const,
    instructions: "Choose one",
    criteria: { yes: "Yes", no: "No" },
  },
};
const answer = {
  label: {
    type: "choice",
    choice: "yes",
    confidence: 0.9,
    probabilities: { yes: 0.9, no: 0.1 },
  },
} as const;

function capability(binding: TaskFundingBinding, options: {
  readonly omitDirectPersonalCredential?: boolean;
  readonly attemptedRoutes?: string[];
} = {}): CapabilityFundingSession {
  return {
    humanUserId: "human-1",
    decisionModelId: MODEL_ID,
    async resolveModel(_role, configuredId) {
      if (configuredId && configuredId !== MODEL_ID) throw new Error("unavailable");
      return { modelId: MODEL_ID, preferenceRevision: 7 };
    },
    async openModel(modelId) {
      expect(modelId).toBe(MODEL_ID);
      return {
        binding,
        fundingSession: {
          kind: binding.kind,
          async recheckAttempt() {},
          async runAttempt(_candidate, callback, transport = "direct") {
            options.attemptedRoutes?.push(transport);
            return callback({
              usageFunding: binding.kind === "personal"
                ? {
                    kind: "personal",
                    humanUserId: "human-1",
                    payerHumanId: "human-1",
                    providerRoute: transport === "surplus" ? "surplus" : "openrouter",
                    credentialId: CREDENTIAL_ID,
                    credentialRevision: 3,
                  }
                : {
                    kind: "server",
                    humanUserId: "human-1",
                    providerRoute: transport === "surplus" ? "surplus" : "openrouter",
                  },
              ...(binding.kind === "personal"
                && !(transport === "direct" && options.omitDirectPersonalCredential)
                ? { personalCredential: { apiKey: `key-${transport}` } }
                : {}),
            });
          },
        },
      };
    },
    async openService() { throw new Error("unused"); },
  };
}

describe("personal decision funding", () => {
  test("catalogue-derived Surplus decision eligibility uses supported pins without a row allowlist", () => {
    const route = resolveQualifiedSurplusDecisionRoute(MODEL_ID);
    expect(route).toMatchObject({
      catalogModelId: MODEL_ID,
      surplusModelId: "typesafe/jev-1.13",
      providerPin: "openrouter",
      supportsMultipleQuestions: true,
    });
    expect(resolveSurplusDecisionServingAvailability({
      catalogModelId: MODEL_ID,
      policyEnabled: true,
      keyConfigured: true,
    })).toMatchObject({ status: "available", route: { catalogModelId: MODEL_ID } });
    expect(resolveSurplusDecisionServingAvailability({
      catalogModelId: "typesafe:jev-1.13.0",
      policyEnabled: true,
      keyConfigured: true,
    })).toEqual({ status: "not-qualified", route: null });
  });

  test("same admitted payer can move from a proven Surplus refusal to direct", async () => {
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    await runWithCapabilityFundingSession(capability(binding), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      const routes: string[] = [];
      const result = await runPreparedDecision(prepared, async (deps) => {
        routes.push(`${deps.providerRoute}:${deps.apiKey}`);
        if (deps.providerRoute === "surplus") throw new SurplusDecisionDirectFallbackError();
        return "served";
      });
      expect(result).toBe("served");
      expect(routes).toEqual(["surplus:key-surplus", "direct:key-direct"]);
      expect(prepared).toMatchObject({ modelId: MODEL_ID, preferenceRevision: 7, binding });
    });
  });

  test("personal-only decision rows become runnable in discover_models", async () => {
    const binding = { kind: "personal", providerRoute: "openrouter", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    await runWithCapabilityFundingSession(capability(binding), async () => {
      const value = JSON.parse(String(await createDiscoverModelsTool({ env: {} }).invoke({
        command: "list",
        workload: "decision",
        decision_operation: "choice",
        runnable_only: true,
      }))) as { items: Array<{ id: string; availability: string }> };
      const discovered = value.items.find((row) => row.id === MODEL_ID);
      expect(discovered?.id).toBe(MODEL_ID);
      expect(discovered?.availability).toBe("selectable");
    });
  });

  test("personal direct transport injects its request-local key and reports usage to the pre-wire attempt", async () => {
    const observed: unknown[] = [];
    let requestBody: unknown;
    const binding = { kind: "personal", providerRoute: "openrouter", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const result = await runWithCapabilityFundingSession(capability(binding), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      return runPreparedDecision(prepared, (funding) => invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: new AbortController().signal,
      }, {
        ...funding,
        fetch: (async (_url, init) => {
          if (typeof init?.body !== "string") throw new Error("expected JSON request body");
          requestBody = JSON.parse(init.body);
          return Response.json({
            id: "request-1",
            model: "typesafe/jev-1.13",
            answers: answer,
            usage: { input_tokens: 12, output_tokens: 3, cost: 0.0002 },
          });
        }) as typeof fetch,
        runPersonalAttempt: async (attempt) => {
          const current = getUsageContext();
          if (!current) throw new Error("missing usage context");
          return runWithUsageContext({
            ...current,
            trackedAttemptId: "attempt-1",
            onAttemptUsage: (usage) => observed.push(usage),
          }, attempt.invoke);
        },
      }));
    });
    expect(requestBody).toEqual({
      model: "typesafe/jev-1.13",
      state: "evidence",
      questions: question,
    });
    expect(result.answers).toEqual(answer);
    expect(observed).toEqual([expect.objectContaining({
      inputTokens: 12,
      outputTokens: 3,
      actualCostUsd: 0.0002,
      providerRequestId: "request-1",
    })]);
  });

  test("ambient personal provenance cannot authorize a decision or fall through to a server key", async () => {
    const previous = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "server-openrouter-key";
    let fetched = false;
    try {
      const error = await runWithUsageContext({
        callType: "other",
        userId: "human-1",
        funding: {
          kind: "personal",
          humanUserId: "human-1",
          payerHumanId: "human-1",
          providerRoute: "openrouter",
          credentialId: CREDENTIAL_ID,
          credentialRevision: 3,
        },
      }, () => invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: new AbortController().signal,
      }, {
        providerRoute: "direct",
        fetch: (async () => {
          fetched = true;
          throw new Error("must not reach provider");
        }) as unknown as typeof fetch,
      })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe("missing_credentials");
      expect(fetched).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = previous;
    }
  });

  test("Surplus uses its native decisions body and marketplace cost receipt", async () => {
    let requestBody: unknown;
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const result = await runWithCapabilityFundingSession(capability(binding), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      return runPreparedDecision(prepared, (funding) => invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: new AbortController().signal,
      }, {
        ...funding,
        runSurplusAttempt: (async (attempt) => {
          requestBody = JSON.parse(attempt.body);
          const parsed = await attempt.parse(Response.json({
            id: "surplus-request-1",
            model: "jev-1.13",
            provider: "openrouter",
            answers: answer,
            usage: { input_tokens: 20, output_tokens: 4 },
          }, { headers: { "x-si-buyer-cost-micro": "123" } }));
          return parsed.finalize();
        }) as typeof import("../../src/providers/surplus-decision-attempt").invokeSurplusDecisionAttempt,
      }));
    });
    expect(requestBody).toEqual({
      model: "typesafe/jev-1.13",
      state: "evidence",
      questions: question,
      provider: "openrouter",
    });
    expect(result).toMatchObject({
      answers: answer,
      usage: { inputTokens: 20, outputTokens: 4, actualCostUsd: 0.000123 },
    });
  });

  test("native Surplus attempts persist pre-wire identity and exact terminal cost", async () => {
    const route = resolveQualifiedSurplusDecisionRoute(MODEL_ID);
    if (!route) throw new Error("expected route");
    const begins: unknown[] = [];
    const attachments: unknown[] = [];
    const settlements: unknown[] = [];
    const result = await runWithUsageContext({ callType: "other", roomId: null }, () =>
      invokeSurplusDecisionAttempt({
        route,
        apiKey: "surplus-key",
        body: "{}",
        signal: new AbortController().signal,
        funding: { kind: "server", humanUserId: "human-1", providerRoute: "surplus" },
        fetchImpl: (async () => Response.json({ ok: true }, { headers: {
          "x-request-id": "request-123",
          "x-si-buyer-cost-micro": "321",
          "x-si-provider-family": "openrouter",
        } })) as unknown as typeof fetch,
        parse: async () => ({ finalize: () => "served", inputTokens: 8, outputTokens: 2 }),
      }, {
        begin: async (value) => { begins.push(value); },
        attach: async (value) => { attachments.push(value); },
        settle: async (value) => { settlements.push(value); },
      }));
    expect(result).toBe("served");
    expect(begins).toEqual([expect.objectContaining({
      model: MODEL_ID,
      provider: "openrouter",
      endpoint: "/v1/decisions",
      fundingKind: "server",
    })]);
    expect(attachments).toEqual([expect.objectContaining({
      providerRequestId: "request-123",
      servingProvider: "openrouter",
    })]);
    expect(settlements).toEqual([expect.objectContaining({
      providerRequestId: "request-123",
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0.000321,
      inputTokens: 8,
      outputTokens: 2,
    })]);
  });

  test("classifies the pilot entitlement refusal as a pre-service failure", async () => {
    const route = resolveQualifiedSurplusDecisionRoute(MODEL_ID);
    if (!route) throw new Error("expected route");
    const settlements: unknown[] = [];
    const error = await invokeSurplusDecisionAttempt({
      route,
      apiKey: "surplus-key",
      body: "{}",
      signal: new AbortController().signal,
      funding: { kind: "server", humanUserId: "human-1", providerRoute: "surplus" },
      fetchImpl: (async () => Response.json({ error: { code: "buyer_not_in_allowlist" } }, {
        status: 403,
      })) as unknown as typeof fetch,
      parse: async (response) => {
        const payload: unknown = await response.json();
        throw new SurplusDecisionHttpError(response.status, payload);
      },
    }, {
      begin: async () => {},
      settle: async (value) => { settlements.push(value); },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SurplusDecisionDirectFallbackError);
    expect(settlements).toEqual([expect.objectContaining({
      outcome: "failed",
      costState: "unknown",
      failureCode: "pre_service_refusal",
    })]);
  });

  test("legacy server decisions retry direct after the classified safe refusal", async () => {
    const previous = process.env["SURPLUS_API_KEY"];
    process.env["SURPLUS_API_KEY"] = "server-surplus-key";
    const authorizations: string[] = [];
    let directCalls = 0;
    try {
      const result = await invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: new AbortController().signal,
      }, {
        preferSurplus: true,
        apiKey: "server-direct-key",
        fundingHumanUserId: "human-1",
        assertCanUseServerProviderCredentials: async () => {},
        runSurplusAttempt: (async (attempt) => {
          authorizations.push(attempt.apiKey);
          throw new SurplusDecisionDirectFallbackError();
        }) as typeof invokeSurplusDecisionAttempt,
        fetch: (async (_url, init) => {
          directCalls += 1;
          authorizations.push(String((init?.headers as Record<string, string> | undefined)?.["Authorization"]));
          return Response.json({
            id: "direct-request-1",
            model: "typesafe/jev-1.13",
            answers: answer,
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        }) as typeof fetch,
      });
      expect(result.answers).toEqual(answer);
      expect(directCalls).toBe(1);
      expect(authorizations).toEqual(["server-surplus-key", "Bearer server-direct-key"]);
    } finally {
      if (previous === undefined) delete process.env["SURPLUS_API_KEY"];
      else process.env["SURPLUS_API_KEY"] = previous;
    }
  });

  test("malformed Surplus answers fall back through the same payer's direct decision rail", async () => {
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const attemptedRoutes: string[] = [];
    let directCalls = 0;
    const result = await runWithCapabilityFundingSession(capability(binding, { attemptedRoutes }), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      return runPreparedDecision(prepared, (funding) => invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: new AbortController().signal,
      }, {
        ...funding,
        runSurplusAttempt: (async (attempt) => {
          const parsed = await attempt.parse(Response.json({
            id: "surplus-invalid-1",
            model: "jev-1.13",
            provider: "openrouter",
            answers: { label: { ...answer.label, choice: "not-a-candidate" } },
            usage: { input_tokens: 9, output_tokens: 2 },
          }));
          return parsed.finalize();
        }) as typeof invokeSurplusDecisionAttempt,
        runPersonalAttempt: async (attempt) => {
          const current = getUsageContext();
          if (!current) throw new Error("missing usage context");
          return runWithUsageContext({
            ...current,
            trackedAttemptId: "direct-after-invalid-attempt",
            onAttemptUsage: () => {},
          }, attempt.invoke);
        },
        fetch: (async () => {
          directCalls += 1;
          return Response.json({
            id: "direct-after-invalid",
            model: "typesafe/jev-1.13",
            answers: answer,
            usage: { input_tokens: 10, output_tokens: 2, cost: 0.0002 },
          });
        }) as unknown as typeof fetch,
      }));
    });
    expect(result.answers).toEqual(answer);
    expect(result.responseId).toBe("direct-after-invalid");
    expect(attemptedRoutes).toEqual(["surplus", "direct"]);
    expect(directCalls).toBe(1);
  });

  test("an outcome-unknown Surplus decision still falls back once to direct", async () => {
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const attemptedRoutes: string[] = [];
    let directCalls = 0;
    const result = await runWithCapabilityFundingSession(capability(binding, { attemptedRoutes }), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      return runPreparedDecision(prepared, (funding) => invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: new AbortController().signal,
      }, {
        ...funding,
        runSurplusAttempt: (async () => { throw new SurplusOutcomeUnknownError(); }) as typeof invokeSurplusDecisionAttempt,
        runPersonalAttempt: async (attempt) => {
          const current = getUsageContext();
          if (!current) throw new Error("missing usage context");
          return runWithUsageContext({
            ...current,
            trackedAttemptId: "direct-after-unknown-attempt",
            onAttemptUsage: () => {},
          }, attempt.invoke);
        },
        fetch: (async () => {
          directCalls += 1;
          return Response.json({
            id: "direct-after-unknown",
            model: "typesafe/jev-1.13",
            answers: answer,
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        }) as unknown as typeof fetch,
      }));
    });
    expect(result.responseId).toBe("direct-after-unknown");
    expect(attemptedRoutes).toEqual(["surplus", "direct"]);
    expect(directCalls).toBe(1);
  });

  test("Surplus fallback rejects a direct OpenRouter response for another model", async () => {
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const attemptedRoutes: string[] = [];
    let directCalls = 0;
    const error = await runWithCapabilityFundingSession(capability(binding, { attemptedRoutes }), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      return runPreparedDecision(prepared, (funding) => invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: new AbortController().signal,
      }, {
        ...funding,
        runSurplusAttempt: (async () => { throw new SurplusOutcomeUnknownError(); }) as typeof invokeSurplusDecisionAttempt,
        runPersonalAttempt: async (attempt) => {
          const current = getUsageContext();
          if (!current) throw new Error("missing usage context");
          return runWithUsageContext({
            ...current,
            trackedAttemptId: "direct-wrong-model-attempt",
            onAttemptUsage: () => {},
          }, attempt.invoke);
        },
        fetch: (async () => {
          directCalls += 1;
          return Response.json({
            id: "direct-wrong-model",
            model: "typesafe/a-different-model",
            answers: answer,
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        }) as unknown as typeof fetch,
      }));
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(attemptedRoutes).toEqual(["surplus", "direct"]);
    expect(directCalls).toBe(1);
  });

  test("malformed Surplus compatibility Choice falls back before returning a candidate", async () => {
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const attemptedRoutes: string[] = [];
    const result = await runWithCapabilityFundingSession(capability(binding, { attemptedRoutes }), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      return runPreparedDecision(prepared, (funding) => invokeProviderChoice("openrouter", {
        modelId: MODEL_ID,
        state: "evidence",
        instructions: "Choose one",
        choices: [{ id: "yes", description: "Yes" }, { id: "no", description: "No" }],
        signal: new AbortController().signal,
      }, {
        ...funding,
        runSurplusAttempt: (async (attempt) => {
          const parsed = await attempt.parse(Response.json({
            id: "surplus-invalid-choice",
            model: "jev-1.13",
            provider: "openrouter",
            answers: { candidate: { type: "choice", choice: "not-a-candidate" } },
            usage: { input_tokens: 5, output_tokens: 1 },
          }));
          return parsed.finalize();
        }) as typeof invokeSurplusDecisionAttempt,
        runPersonalAttempt: async (attempt) => {
          const current = getUsageContext();
          if (!current) throw new Error("missing usage context");
          return runWithUsageContext({
            ...current,
            trackedAttemptId: "direct-choice-after-invalid-attempt",
            onAttemptUsage: () => {},
          }, attempt.invoke);
        },
        fetch: (async () => Response.json({
          id: "direct-choice-after-invalid",
          model: "typesafe/jev-1.13",
          answers: { candidate: { type: "choice", choice: "yes", confidence: 0.8 } },
          usage: { input_tokens: 6, output_tokens: 1 },
        })) as unknown as typeof fetch,
      }));
    });
    expect(result).toMatchObject({
      selectedId: "yes",
      confidence: 0.8,
      responseId: "direct-choice-after-invalid",
    });
    expect(attemptedRoutes).toEqual(["surplus", "direct"]);
  });

  test("malformed Surplus output preserves a reported nonzero marketplace charge", async () => {
    const route = resolveQualifiedSurplusDecisionRoute(MODEL_ID);
    if (!route) throw new Error("expected route");
    const settlements: unknown[] = [];
    const error = await invokeSurplusDecisionAttempt({
      route,
      apiKey: "surplus-key",
      body: "{}",
      signal: new AbortController().signal,
      funding: { kind: "server", humanUserId: "human-1", providerRoute: "surplus" },
      fetchImpl: (async () => Response.json({ answers: "malformed" }, {
        headers: { "x-request-id": "charged-invalid", "x-si-buyer-cost-micro": "425" },
      })) as unknown as typeof fetch,
      parse: async () => ({
        inputTokens: 8,
        outputTokens: 2,
        finalize: () => { throw new ChoiceRequestError("invalid_response"); },
      }),
    }, {
      begin: async () => {},
      attach: async () => {},
      settle: async (value) => { settlements.push(value); },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SurplusOutcomeUnknownError);
    expect(settlements).toEqual([expect.objectContaining({
      providerRequestId: "charged-invalid",
      outcome: "unknown",
      costState: "actual",
      actualCostUsd: 0.000425,
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      failureCode: "outcome_unknown",
    })]);
  });

  test("a valid Surplus decision is returned when cost settlement fails", async () => {
    const route = resolveQualifiedSurplusDecisionRoute(MODEL_ID);
    if (!route) throw new Error("expected route");
    let fetchCalls = 0;
    let settleCalls = 0;
    const result = await invokeSurplusDecisionAttempt({
      route,
      apiKey: "surplus-key",
      body: "{}",
      signal: new AbortController().signal,
      funding: { kind: "server", humanUserId: "human-1", providerRoute: "surplus" },
      fetchImpl: (async () => {
        fetchCalls += 1;
        return Response.json({ answers: answer }, {
          headers: { "x-request-id": "settlement-failure", "x-si-buyer-cost-micro": "125" },
        });
      }) as unknown as typeof fetch,
      parse: async () => ({ finalize: () => "validated-decision", inputTokens: 7, outputTokens: 2 }),
    }, {
      begin: async () => {},
      attach: async () => {},
      settle: async () => {
        settleCalls += 1;
        throw new Error("settlement unavailable");
      },
    });
    expect(result).toBe("validated-decision");
    expect(fetchCalls).toBe(1);
    expect(settleCalls).toBe(1);
  });

  test("cancellation stops before direct fallback", async () => {
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const attemptedRoutes: string[] = [];
    const controller = new AbortController();
    let directCalls = 0;
    const error = await runWithCapabilityFundingSession(capability(binding, { attemptedRoutes }), async () => {
      const prepared = await prepareDecisionFunding(MODEL_ID);
      if (!prepared) throw new Error("expected funding");
      return runPreparedDecision(prepared, (funding) => invokeDecision({
        modelId: MODEL_ID,
        state: "evidence",
        questions: question,
        signal: controller.signal,
      }, {
        ...funding,
        runSurplusAttempt: (async () => {
          controller.abort();
          throw new SurplusOutcomeUnknownError();
        }) as typeof invokeSurplusDecisionAttempt,
        fetch: (async () => {
          directCalls += 1;
          throw new Error("must not call direct");
        }) as unknown as typeof fetch,
      }));
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SurplusOutcomeUnknownError);
    expect(attemptedRoutes).toEqual(["surplus"]);
    expect(directCalls).toBe(0);
  });

  test("missing same-payer direct credentials cannot flip fallback to server funding", async () => {
    const previous = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "server-key-that-must-not-be-used";
    const binding = { kind: "personal", providerRoute: "surplus", credentialId: CREDENTIAL_ID,
      credentialRevision: 3 } as const;
    const attemptedRoutes: string[] = [];
    let directCalls = 0;
    try {
      const error = await runWithCapabilityFundingSession(capability(binding, {
        omitDirectPersonalCredential: true,
        attemptedRoutes,
      }), async () => {
        const prepared = await prepareDecisionFunding(MODEL_ID);
        if (!prepared) throw new Error("expected funding");
        return runPreparedDecision(prepared, (funding) => invokeDecision({
          modelId: MODEL_ID,
          state: "evidence",
          questions: question,
          signal: new AbortController().signal,
        }, {
          ...funding,
          runSurplusAttempt: (async () => { throw new SurplusOutcomeUnknownError(); }) as typeof invokeSurplusDecisionAttempt,
          fetch: (async () => {
            directCalls += 1;
            throw new Error("must not call direct");
          }) as unknown as typeof fetch,
        }));
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "missing_credentials" });
      expect(attemptedRoutes).toEqual(["surplus", "direct"]);
      expect(directCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = previous;
    }
  });
});
