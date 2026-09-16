import { describe, expect, test } from "bun:test";

import {
  resolveCurrentRecordRepositorySelection,
  resolveCurrentReflectionCommitmentKey,
} from "../../src/reflection/record-repository-selection";

describe("Record repository selection", () => {
  test("projects the current disabled encryption stage as ordinary", () => {
    expect(resolveCurrentRecordRepositorySelection()).toEqual({
      selectedRepresentation: "ordinary",
      migrationGeneration: 1,
    });
  });

  test("does not return mutable shared state", () => {
    expect(Object.isFrozen(resolveCurrentRecordRepositorySelection())).toBe(true);
  });

  test("derives one stable purpose-separated key from the persisted instance secret", () => {
    const first = resolveCurrentReflectionCommitmentKey({
      NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
    });
    const second = resolveCurrentReflectionCommitmentKey({
      NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
    });
    const other = resolveCurrentReflectionCommitmentKey({
      NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY: "cd".repeat(32),
    });
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(first).toHaveLength(32);
    expect(Buffer.from(first).toString("hex")).not.toBe("ab".repeat(32));
  });

  test("fails closed when the durable secret is absent or malformed", () => {
    expect(() => resolveCurrentReflectionCommitmentKey({})).toThrow(
      "Reflection commitment key source is unavailable",
    );
    expect(() => resolveCurrentReflectionCommitmentKey({
      NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY: "short",
    })).toThrow("Reflection commitment key source is unavailable");
  });
});
