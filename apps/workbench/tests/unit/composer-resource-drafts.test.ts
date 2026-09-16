import { afterEach, describe, expect, test } from "bun:test";
import {
  addFocusedResource,
  clearFocusedResources,
  getFocusedResources,
  removeFocusedResource,
  restoreFocusedResources,
} from "../../src/adapters/composer-focused-resources-ref";

afterEach(() => clearFocusedResources());

describe("composer focused resource drafts", () => {
  test("dedupes resources by kind identity and preserves a bounded snapshot", () => {
    const first = addFocusedResource(
      { kind: "workspace-artifact", artifactId: "workspace/D423.md" },
      "@D423.md",
    );
    const duplicate = addFocusedResource(
      { kind: "workspace-artifact", artifactId: "workspace/D423.md" },
      "@another-label.md",
    );
    expect(first?.entryId).toBe(duplicate?.entryId);
    expect(getFocusedResources()).toHaveLength(1);

    const snapshot = getFocusedResources();
    clearFocusedResources();
    restoreFocusedResources(snapshot);
    expect(getFocusedResources()).toEqual(snapshot);
  });

  test("programmatic removal removes the authoritative entry", () => {
    const item = addFocusedResource(
      {
        kind: "local-file",
        path: "/tmp/README.md",
        rootPath: "/tmp",
        name: "README.md",
        relayId: "relay-1",
      },
      "@README.md",
    );
    expect(item).not.toBeNull();
    removeFocusedResource(item!.entryId);
    expect(getFocusedResources()).toHaveLength(0);
  });
});
