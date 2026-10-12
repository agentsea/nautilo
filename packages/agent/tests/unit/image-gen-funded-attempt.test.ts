import { describe, expect, test } from "bun:test";
import {
  runFundedDirectImageAttempt,
  DirectImageAttemptError,
  type GenerateImagesArgs,
  type GenerateImagesResult,
} from "../../src/image-gen";
import type {
  ProviderCostReceipt,
  ProviderCostRecorder,
} from "../../src/usage/provider-cost-recorder";

const args: GenerateImagesArgs = {
  model: "gpt-image-2",
  prompt: "a lighthouse",
  count: 1,
  size: "auto",
  quality: "low",
  background: "auto",
  format: "png",
};
const result: GenerateImagesResult = {
  bytes: [Buffer.from("image")],
  model: args.model,
  mime: "image/png",
};
const funding = {
  kind: "personal" as const,
  humanUserId: "10000000-0000-4000-8000-000000000001",
  payerHumanId: "10000000-0000-4000-8000-000000000001",
  providerRoute: "openai",
  credentialId: "20000000-0000-4000-8000-000000000002",
  credentialRevision: 1,
};

function throwingSettlement(receipts: ProviderCostReceipt[]): ProviderCostRecorder {
  return Object.assign(async (receipt: ProviderCostReceipt) => {
    receipts.push(receipt);
    throw new Error("synthetic settlement outage");
  }, { attemptStarted: true as const });
}

describe("funded direct image attempts", () => {
  test("returns a valid paid result when late settlement fails", async () => {
    const receipts: ProviderCostReceipt[] = [];
    let invokes = 0;
    const actual = await runFundedDirectImageAttempt({
      canonicalModelId: "openai:gpt-image-2",
      provider: "openai",
      usageFunding: funding,
      args,
      invoke: async () => { invokes += 1; return result; },
      beginProviderCostAttempt: async () => throwingSettlement(receipts),
    });

    expect(actual).toBe(result);
    expect(invokes).toBe(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      provider: "openai",
      operation: "image_generation",
      attemptOutcome: "succeeded",
      evidenceState: "estimated",
    });
  });

  test("preserves the provider error when failure settlement also fails", async () => {
    const receipts: ProviderCostReceipt[] = [];
    const providerError = new Error("provider response failed");
    const error = await runFundedDirectImageAttempt({
      canonicalModelId: "openai:gpt-image-2",
      provider: "openai",
      usageFunding: funding,
      args,
      invoke: () => Promise.reject(providerError),
      beginProviderCostAttempt: async () => throwingSettlement(receipts),
    }).catch((caught: unknown) => caught);

    expect(error).toBe(providerError);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      attemptOutcome: "unknown",
      evidenceState: "unknown",
      failureCode: "outcome_unknown",
    });
  });

  test("requires durable attempt persistence before provider dispatch", async () => {
    let invokes = 0;
    const error = await runFundedDirectImageAttempt({
      canonicalModelId: "openai:gpt-image-2",
      provider: "openai",
      usageFunding: funding,
      args,
      invoke: async () => { invokes += 1; return result; },
      beginProviderCostAttempt: () => Promise.reject(new Error("ledger unavailable")),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("ledger unavailable");
    expect(invokes).toBe(0);
  });

  test.each([
    {
      name: "deterministic provider refusal",
      error: new DirectImageAttemptError("refused", "failed", "provider_refused"),
      attemptOutcome: "failed",
      failureCode: "provider_refused",
    },
    {
      name: "transport uncertainty",
      error: new DirectImageAttemptError("transport lost", "unknown", "provider_transport_unknown"),
      attemptOutcome: "unknown",
      failureCode: "provider_transport_unknown",
    },
  ])("records $name without inventing monetary evidence", async ({
    error, attemptOutcome, failureCode,
  }) => {
    const receipts: ProviderCostReceipt[] = [];
    await runFundedDirectImageAttempt({
      canonicalModelId: "openai:gpt-image-2",
      provider: "openai",
      usageFunding: funding,
      args,
      invoke: () => Promise.reject(error),
      beginProviderCostAttempt: async () => Object.assign(
        async (receipt: ProviderCostReceipt) => { receipts.push(receipt); },
        { attemptStarted: true as const },
      ),
    }).catch(() => undefined);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      attemptOutcome,
      failureCode,
      evidenceState: "unknown",
      actualCostUsd: null,
    });
    expect(receipts[0]).not.toHaveProperty("estimatedCostUsd");
  });
});
