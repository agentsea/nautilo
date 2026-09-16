import { describe, expect, test } from "bun:test";
import type { ChatFocusedResourceRef } from "@nautilo/types";
import { mergeFocusedResourcesForSend } from "./focused-resource-send";

const artifact = (artifactId: string): ChatFocusedResourceRef => ({
  kind: "workspace-artifact",
  artifactId,
});

describe("mergeFocusedResourcesForSend", () => {
  test("keeps explicit references first and dedupes Reader context", () => {
    expect(
      mergeFocusedResourcesForSend(
        [artifact("explicit"), artifact("same")],
        [artifact("same"), artifact("reader")],
      ),
    ).toEqual([artifact("explicit"), artifact("same"), artifact("reader")]);
  });

  test("uses kind-specific local-file identity", () => {
    const local: ChatFocusedResourceRef = {
      kind: "local-file",
      path: "/workspace/a.md",
      rootPath: "/workspace",
      name: "a.md",
      relayId: "relay-1",
    };
    expect(mergeFocusedResourcesForSend([local], [{ ...local }, artifact("reader")])).toEqual([
      local,
      artifact("reader"),
    ]);
  });

  test("preserves the 30-reference wire bound with explicit references winning", () => {
    const explicit = Array.from({ length: 30 }, (_, index) => artifact(`explicit-${index}`));
    const merged = mergeFocusedResourcesForSend(explicit, [artifact("reader")]);
    expect(merged).toHaveLength(30);
    expect(merged[29]).toEqual(artifact("explicit-29"));
  });
});
