import { describe, expect, test } from "bun:test";
import { PUSH_TOKEN_ENCRYPTION_KEY } from "@nautilo/operator-secrets";
import { resolveCurrentReflectionCommitmentKey } from "../../src/reflection/record-repository-selection";
import { imageAssistanceInputCommitment } from "../../src/lib/image-assistance-input-commitment";
import { createHmac } from "node:crypto";

describe("image assistance input commitment", () => {
  test("is stable only for the same instance, Job and complete input", () => {
    const source = { [PUSH_TOKEN_ENCRYPTION_KEY]: "a".repeat(64) };
    const digest = "b".repeat(64);
    const value = imageAssistanceInputCommitment("job-a", digest, source);
    expect(value).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(value).toBe(imageAssistanceInputCommitment("job-a", digest, source));
    expect(value).not.toContain(digest);
    expect(value).not.toBe(imageAssistanceInputCommitment("job-b", digest, source));
    expect(value).not.toBe(imageAssistanceInputCommitment("job-a", "c".repeat(64), source));
    expect(value).not.toBe(imageAssistanceInputCommitment("job-a", digest, { [PUSH_TOKEN_ENCRYPTION_KEY]: "d".repeat(64) }));
    expect(value).not.toBe(`hmac-sha256:${createHmac("sha256", resolveCurrentReflectionCommitmentKey(source)).update(digest).digest("hex")}`);
  });
  test("never invents a transient key or accepts an unvalidated input digest", () => {
    expect(() => imageAssistanceInputCommitment("job", "a".repeat(64), {})).toThrow("unavailable");
    expect(() => imageAssistanceInputCommitment("job", "raw question", { [PUSH_TOKEN_ENCRYPTION_KEY]: "a".repeat(64) })).toThrow("unavailable");
  });
});
