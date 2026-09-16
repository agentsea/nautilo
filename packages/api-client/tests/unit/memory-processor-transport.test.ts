import { describe, expect, test } from "bun:test";

import { memoryProcessorRecipientV1Schema } from "../../src/schemas/memory-processor-transport";

function recipient<const Provider extends string>(provider: Provider) {
  return {
    formatVersion: 1,
    purpose: "memory.foreground_embedding",
    recipientId: "A".repeat(43),
    publicKeyBase64url: "B".repeat(87),
    embedding: {
      provider,
      model: "text-embedding-3-small",
      dimensions: 1_536,
    },
  } as const;
}

describe("Memory processor transport schema", () => {
  test("accepts a Venice recipient while preserving the signed disclosure coordinates", () => {
    expect(memoryProcessorRecipientV1Schema.parse(recipient("venice"))).toEqual(
      recipient("venice"),
    );
  });

  test("rejects an unknown embedding provider", () => {
    expect(memoryProcessorRecipientV1Schema.safeParse(
      recipient("unknown-provider"),
    ).success).toBe(false);
  });
});
