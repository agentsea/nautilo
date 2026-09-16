import { describe, expect, test } from "bun:test";

import { commitMemoryMutationV1 } from "../../src/memory/memory-mutation-commitment.ts";

describe("Memory mutation commitment", () => {
  test("binds save type and content and domain-separates replacement", () => {
    const save = (type: string, content: string) => commitMemoryMutationV1({
      kind: "save",
      payload: { formatVersion: 1, type, content },
    });
    expect(save("fact", "same")).not.toEqual(save("goal", "same"));
    expect(save("fact", "same")).not.toEqual(save("fact", "changed"));
    expect(save("fact", "same")).not.toEqual(
      commitMemoryMutationV1({ kind: "replace", content: "same" }),
    );
    expect(save("fact", "same")).toEqual(save("fact", "same"));
  });
});
