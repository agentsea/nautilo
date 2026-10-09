import { describe, expect, test } from "bun:test";
import {
  invokeSurplusImageAttempt,
  resolveSurplusImageRoute,
  SurplusImageAttemptError,
  type GenerateImagesArgs,
  type GenerateImagesResult,
} from "../../src/image-gen";
import { surplusCredentialFingerprint } from "../../src/providers/surplus-reconciliation";

const HUMAN_ID = "40000000-0000-4000-8000-000000000004";
const CREDENTIAL_ID = "50000000-0000-4000-8000-000000000005";
const ATTEMPT_ID = "60000000-0000-4000-8000-000000000006";
const SERVER_REQUEST_ID = "server-image-request-id";
const route = resolveSurplusImageRoute("venice:gpt-image-2")!;
const args: GenerateImagesArgs = {
  model: "gpt-image-2",
  prompt: "a lighthouse",
  count: 1,
  size: "auto",
  quality: "low",
  background: "auto",
  format: "png",
};
const funding = {
  kind: "personal" as const,
  humanUserId: HUMAN_ID,
  payerHumanId: HUMAN_ID,
  providerRoute: "surplus",
  credentialId: CREDENTIAL_ID,
  credentialRevision: 7,
};

describe("durable Surplus image attempts", () => {
  test("binds the response request id before result parsing and settles its actual cost", async () => {
    const sequence: string[] = [];
    const begins: unknown[] = [];
    const attachments: unknown[] = [];
    const settlements: unknown[] = [];
    let invokes = 0;
    const result = await invokeSurplusImageAttempt({
      route,
      canonicalModelId: route.modelId,
      args,
      apiKey: "personal-surplus-key",
      funding,
    }, {
      mintAttemptId: () => ATTEMPT_ID,
      begin: async (input) => { sequence.push("begin"); begins.push(input); },
      attach: async (input) => { sequence.push("attach"); attachments.push(input); },
      settle: async (input) => { sequence.push("settle"); settlements.push(input); },
      invoke: async (_modelId, _args, _key, _fetch, observation) => {
        invokes += 1;
        sequence.push("dispatch");
        expect(observation?.requestId).toBe(ATTEMPT_ID);
        await observation?.onResponse?.({
          requestId: SERVER_REQUEST_ID,
          buyerCostMicroUsd: 8_800,
          marketplaceAttempts: 1,
        }, 200);
        return {
          bytes: [Buffer.from("image")],
          model: args.model,
          mime: "image/png",
          providerReceipt: {
            requestId: SERVER_REQUEST_ID,
            buyerCostMicroUsd: 8_800,
            marketplaceAttempts: 1,
          },
        } satisfies GenerateImagesResult;
      },
    });

    expect(result.bytes).toEqual([Buffer.from("image")]);
    expect(invokes).toBe(1);
    expect(sequence).toEqual(["begin", "dispatch", "attach", "settle"]);
    expect(begins).toEqual([expect.objectContaining({
      id: ATTEMPT_ID,
      callType: "image_gen",
      provider: "venice",
      model: route.modelId,
      endpoint: "/v1/images/generations",
      fundingKind: "personal",
      metadata: {
        surplusUnpinnedMedia: true,
        surplusModelId: route.surplusModelId,
        catalogModelId: route.modelId,
        surplusCredentialFingerprint: surplusCredentialFingerprint("personal-surplus-key"),
      },
    })]);
    expect((begins[0] as { metadata: Record<string, unknown> }).metadata)
      .not.toHaveProperty("surplusProviderPin");
    expect(attachments).toHaveLength(1);
    expect(attachments).toEqual([expect.objectContaining({
      attemptId: ATTEMPT_ID,
      providerRequestId: SERVER_REQUEST_ID,
    })]);
    expect(settlements).toEqual([{
      attemptId: ATTEMPT_ID,
      providerRequestId: SERVER_REQUEST_ID,
      metadata: {
        surplusMarketplaceAttempts: 1,
        surplusTruncated: false,
      },
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0.0088,
    }]);
  });

  test("keeps a header-without-cost attempt pending for exact receipt recovery", async () => {
    const settlements: unknown[] = [];
    await invokeSurplusImageAttempt({
      route,
      canonicalModelId: route.modelId,
      args,
      apiKey: "personal-surplus-key",
      funding,
    }, {
      mintAttemptId: () => ATTEMPT_ID,
      begin: async () => undefined,
      attach: async () => undefined,
      settle: async (input) => { settlements.push(input); },
      invoke: async (_modelId, _args, _key, _fetch, observation) => {
        await observation?.onResponse?.({ requestId: ATTEMPT_ID }, 200);
        return {
          bytes: [Buffer.from("image")], model: args.model, mime: "image/png",
          providerReceipt: { requestId: ATTEMPT_ID },
        };
      },
    });

    expect(settlements).toEqual([{
      attemptId: ATTEMPT_ID,
      providerRequestId: ATTEMPT_ID,
      metadata: { surplusTruncated: false },
      outcome: "succeeded",
      costState: "pending",
    }]);
  });

  test("does not replay an uncertain request with no response receipt", async () => {
    const settlements: unknown[] = [];
    let invokes = 0;
    const error = await invokeSurplusImageAttempt({
      route,
      canonicalModelId: route.modelId,
      args,
      apiKey: "personal-surplus-key",
      funding,
    }, {
      mintAttemptId: () => ATTEMPT_ID,
      begin: async () => undefined,
      attach: async () => undefined,
      settle: async (input) => { settlements.push(input); },
      invoke: () => {
        invokes += 1;
        return Promise.reject(new SurplusImageAttemptError(
          "uncertain",
          "unknown",
          "outcome_unknown",
        ));
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurplusImageAttemptError);
    expect(invokes).toBe(1);
    expect(settlements).toEqual([{
      attemptId: ATTEMPT_ID,
      outcome: "unknown",
      costState: "unknown",
      failureCode: "outcome_unknown",
    }]);
  });
});
