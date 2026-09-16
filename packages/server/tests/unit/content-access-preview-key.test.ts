import { describe, expect, spyOn, test } from "bun:test";

import { resolveContentAccessPreviewKey } from "../../src/content-access/preview-key";
import { resolveCurrentReflectionCommitmentKey } from "../../src/reflection/record-repository-selection";

const environment = (secret: string) => ({
  NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY: secret,
});

describe("ordinary content-access preview key", () => {
  test("is stable for the same persisted instance secret across composition restarts", () => {
    const firstComposition = resolveContentAccessPreviewKey(environment("ab".repeat(32)));
    const restartedComposition = resolveContentAccessPreviewKey(environment("ab".repeat(32)));

    expect(firstComposition).toEqual(restartedComposition);
    expect(firstComposition).toHaveLength(32);
  });

  test("is independent across source keys and from the Reflection domain", () => {
    const source = environment("cd".repeat(32));
    const first = resolveContentAccessPreviewKey(source);
    const otherInstance = resolveContentAccessPreviewKey(environment("ef".repeat(32)));
    const reflection = resolveCurrentReflectionCommitmentKey(source);

    expect(first).not.toEqual(otherInstance);
    expect(first).not.toEqual(reflection);
    expect(Buffer.from(first).toString("hex")).not.toBe("cd".repeat(32));
  });

  test("fails closed for absent or malformed source secrets without logging them", () => {
    const logged: unknown[][] = [];
    const spies = ["log", "warn", "error"].map((method) =>
      spyOn(console, method as "log").mockImplementation((...values: unknown[]) => {
        logged.push(values);
      }));
    const malformed = "not-a-valid-secret-value";

    try {
      for (const candidate of [{}, environment(malformed)]) {
        let error: unknown;
        try {
          resolveContentAccessPreviewKey(candidate);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(
          "Content access preview key source is unavailable",
        );
        expect((error as Error).message).not.toContain(malformed);
      }
      expect(logged).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
