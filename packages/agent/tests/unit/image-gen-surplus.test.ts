import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  generateImagesSurplus,
  resolveSurplusImageRoute,
  SurplusImageAttemptError,
  type GenerateImagesArgs,
} from "../../src/image-gen";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function generationArgs(): GenerateImagesArgs {
  return {
    model: "gpt-image-2",
    prompt: "a small lighthouse",
    count: 1,
    size: "auto",
    quality: "low",
    background: "auto",
    format: "png",
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("qualified Surplus image transport", () => {
  test("uses closed canonical model mappings with explicit marketplace privacy", () => {
    expect(resolveSurplusImageRoute("venice:gpt-image-2")).toEqual({
      modelId: "venice:gpt-image-2",
      surplusModelId: "venice-gpt-image-2",
      operations: ["generate"],
      maxReferenceImages: 0,
      supportsMasks: false,
      exactSize: false,
      privacy: "marketplace-unpinned",
    });
    expect(resolveSurplusImageRoute("openai:gpt-image-2")).toBeNull();
    expect(resolveSurplusImageRoute("venice:seedream-v5-pro")).toBeNull();
    expect(resolveSurplusImageRoute("alibaba:qwen-image-2-edit")).toBeNull();
  });

  test("sends one unpinned generation request and retains the exact cost receipt", async () => {
    let calls = 0;
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
      calls += 1;
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: PNG.toString("base64") }],
      }), {
        status: 200,
        headers: {
          "x-request-id": "image-request-1",
          "x-si-buyer-cost-micro": "8800",
          "x-si-marketplace-attempts": "1",
          "x-si-adapted-params": "safe_mode",
        },
      }));
    }) as unknown as typeof fetch;

    const result = await generateImagesSurplus(
      "venice:gpt-image-2",
      generationArgs(),
      "personal-surplus-key",
    );

    expect(calls).toBe(1);
    expect(requestBody).toEqual({
      model: "venice-gpt-image-2",
      prompt: "a small lighthouse",
      response_format: "b64_json",
      quality: "low",
      n: 1,
    });
    expect(requestBody).not.toHaveProperty("provider");
    expect(requestBody).not.toHaveProperty("providers_blocked");
    expect(requestBody).not.toHaveProperty("size");
    expect(result.bytes).toEqual([PNG]);
    expect(result.providerReceipt).toEqual({
      requestId: "image-request-1",
      buyerCostMicroUsd: 8800,
      marketplaceAttempts: 1,
      adaptedParameters: "safe_mode",
    });
  });

  test("rejects exact dimensions before any paid request", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("must not run");
    }) as unknown as typeof fetch;
    const args = { ...generationArgs(), size: "1024x1024" as const };

    const error = await generateImagesSurplus(
      "venice:gpt-image-2",
      args,
      "key",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("cannot guarantee exact image dimensions");
    expect(calls).toBe(0);
  });

  test("does not replay a network-uncertain paid request", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new TypeError("connection reset"));
    }) as unknown as typeof fetch;

    const error = await generateImagesSurplus(
      "venice:gpt-image-2",
      generationArgs(),
      "key",
    ).catch((caught: unknown) => caught);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(SurplusImageAttemptError);
    expect(error).toMatchObject({
      attemptOutcome: "unknown",
      failureCode: "outcome_unknown",
    });
  });

  test("rejects adapted required parameters without replaying the charged result", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: PNG.toString("base64") }],
      }), {
        status: 200,
        headers: {
          "x-request-id": "adapted-1",
          "x-si-buyer-cost-micro": "8800",
          "x-si-adapted-params": "quality",
        },
      }));
    }) as unknown as typeof fetch;

    const error = await generateImagesSurplus(
      "venice:gpt-image-2",
      generationArgs(),
      "key",
    ).catch((caught: unknown) => caught);

    expect(calls).toBe(1);
    expect(error).toMatchObject({
      attemptOutcome: "failed",
      failureCode: "provider_adapted_parameters",
      receipt: { requestId: "adapted-1", buyerCostMicroUsd: 8800 },
    });
  });

  test("rejects a provider-truncated paid result without replay", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ b64_json: PNG.toString("base64") }],
      }), {
        status: 200,
        headers: {
          "x-request-id": "truncated-1",
          "x-si-buyer-cost-micro": "8800",
          "x-si-truncated": "1",
        },
      }));
    }) as unknown as typeof fetch;

    const error = await generateImagesSurplus(
      "venice:gpt-image-2",
      generationArgs(),
      "key",
    ).catch((caught: unknown) => caught);

    expect(calls).toBe(1);
    expect(error).toMatchObject({
      attemptOutcome: "failed",
      failureCode: "truncated_response",
      receipt: {
        requestId: "truncated-1",
        buyerCostMicroUsd: 8800,
        truncated: true,
      },
    });
  });

  test("binds response headers before reading paid image bytes", async () => {
    const sequence: string[] = [];
    const requestId = "image-request-owned";
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({
        "x-request-id": requestId,
        "x-si-buyer-cost-micro": "8800",
      }),
      body: { cancel: () => Promise.resolve() },
      text: () => {
        sequence.push("read-body");
        return Promise.resolve(JSON.stringify({
          data: [{ b64_json: PNG.toString("base64") }],
        }));
      },
    } as unknown as Response;
    const fetchImpl = (() => Promise.resolve(response)) as unknown as typeof fetch;

    await generateImagesSurplus(
      "venice:gpt-image-2",
      generationArgs(),
      "key",
      fetchImpl,
      {
        requestId,
        onResponse: (receipt) => {
          expect(receipt.requestId).toBe(requestId);
          sequence.push("bind-receipt");
        },
      },
    );

    expect(sequence).toEqual(["bind-receipt", "read-body"]);
  });

  test("retains a server-assigned request id when it differs from the proposed id", async () => {
    const response = new Response(JSON.stringify({
      data: [{ b64_json: PNG.toString("base64") }],
    }), {
      headers: {
        "x-request-id": "server-request-id",
        "x-si-buyer-cost-micro": "8800",
      },
    });
    let observedRequestId: string | undefined;
    const result = await generateImagesSurplus(
      "venice:gpt-image-2",
      generationArgs(),
      "key",
      (() => Promise.resolve(response)) as unknown as typeof fetch,
      {
        requestId: "caller-correlation-id",
        onResponse: (receipt) => { observedRequestId = receipt.requestId; },
      },
    );

    expect(observedRequestId).toBe("server-request-id");
    expect(result.providerReceipt?.requestId).toBe("server-request-id");
    expect(result.bytes).toEqual([PNG]);
  });
});
