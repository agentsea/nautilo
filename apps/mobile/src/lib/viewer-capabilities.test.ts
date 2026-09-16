import { describe, expect, test } from "bun:test";

import { viewerCan } from "./viewer-capabilities";

describe("Mobile viewer capabilities", () => {
  test("fails closed without an exact active viewer", () => {
    expect(viewerCan(null, "invoke_agents")).toBe(false);
    expect(viewerCan(undefined, "write_artifacts")).toBe(false);
  });

  test("uses effective capability slugs instead of Role labels", () => {
    const viewer = {
      capabilities: ["invoke_agents", "write_artifacts"] as const,
    };
    expect(viewerCan(viewer, "invoke_agents")).toBe(true);
    expect(viewerCan(viewer, "write_artifacts")).toBe(true);
    expect(viewerCan(viewer, "manage_rooms")).toBe(false);
  });
});
