import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetAuthoredMemorySemanticChangeSinkForTests,
  emitAuthoredMemorySemanticChange,
  installAuthoredMemorySemanticChangeSink,
} from "../../src/store/authored-memory-semantic-change";

afterEach(() => _resetAuthoredMemorySemanticChangeSinkForTests());

describe("authored Memory semantic-change sink", () => {
  test("emits one content-free post-success change fact", async () => {
    const seen: unknown[] = [];
    installAuthoredMemorySemanticChangeSink(async (event) => {
      seen.push(event);
    });
    await emitAuthoredMemorySemanticChange(
      "66000000-0000-4000-8000-000000000001",
      "replace",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      memoryId: "66000000-0000-4000-8000-000000000001",
      changeKind: "replace",
    });
    expect((seen[0] as { changeRef: string }).changeRef)
      .toMatch(/^memory-change:[0-9a-f-]+$/u);
    expect(JSON.stringify(seen[0])).not.toContain("content");
  });

  test("enforces one owner and isolates committed mutations from sink failure", async () => {
    const uninstall = installAuthoredMemorySemanticChangeSink(() =>
      Promise.reject(new Error("adapter unavailable"))
    );
    expect(() => installAuthoredMemorySemanticChangeSink(async () => {}))
      .toThrow("already installed");
    await emitAuthoredMemorySemanticChange(
      "66000000-0000-4000-8000-000000000001",
      "archive",
    );
    uninstall();
    expect(() => installAuthoredMemorySemanticChangeSink(async () => {}))
      .not.toThrow();
  });
});
