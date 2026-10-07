import { describe, expect, test } from "bun:test";
import { assistantModelSummarySchema } from "./client";

const textModel = {
  id: "provider:text", displayName: "Text model", priority: 1, enabled: true,
  costCoefficient: 1,
  capabilities: { tools: true, vision: false, reasoning: false, e2ee: false, webSearch: false },
};

describe("caller image admission projection", () => {
  test("preserves native capabilities while admitting automatic assistance", () => {
    const model = assistantModelSummarySchema.parse({ ...textModel, imageInput: "assisted", fundingSource: "personal" });
    expect(model.imageInput).toBe("assisted");
    expect(model.capabilities?.vision).toBe(false);
    expect(model.fundingSource).toBe("personal");
  });

  test("retains compatibility with older native-only model responses", () => {
    expect(assistantModelSummarySchema.parse(textModel).imageInput).toBeUndefined();
    expect(assistantModelSummarySchema.parse({ ...textModel, imageInput: "unavailable" }).imageInput).toBe("unavailable");
  });

  test("rejects unknown admission states and provider authority fields", () => {
    expect(assistantModelSummarySchema.safeParse({ ...textModel, imageInput: "fallback" }).success).toBe(false);
    expect(assistantModelSummarySchema.safeParse({ ...textModel, imageInput: "assisted", credentialId: "credential" }).success).toBe(false);
  });
});
