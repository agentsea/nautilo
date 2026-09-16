import { describe, test, expect } from "bun:test";
import {
  constructPatch,
  countDiffStats,
  newPatchId,
  sha256Hex,
} from "../../src/tools/file/staged-patches";

const DEFAULT_OWNER = "owner-A";

function makeConstructInput(
  overrides: Partial<Parameters<typeof constructPatch>[0]> = {},
): Parameters<typeof constructPatch>[0] {
  return {
    turnId: "t-1",
    ownerId: DEFAULT_OWNER,
    path: "/tmp/x.md",
    zone: "workspace",
    zoneCtx: { workspaceRoot: "/tmp", currentFolder: null },
    originalBytes: Buffer.from("old\n"),
    originalSha256: "a".repeat(64),
    newBytes: Buffer.from("new\n"),
    unifiedDiff: [
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
    metadata: { command: "str_replace", args: { path: "x.md" } },
    ...overrides,
  };
}

describe("staged-patches builders", () => {
  test("constructPatch returns a patch with id prefix and computed stats", () => {
    const patch = constructPatch(makeConstructInput());
    expect(patch.patchId.startsWith("t-1:")).toBe(true);
    expect(patch.stats).toEqual({ additions: 1, deletions: 1 });
    expect(patch.createdAt).toBeGreaterThan(0);
  });

  test("constructPatch assigns unique ids within the same turn", () => {
    const a = constructPatch(makeConstructInput());
    const b = constructPatch(makeConstructInput());
    expect(a.patchId).not.toBe(b.patchId);
  });

  test("newPatchId embeds turnId", () => {
    expect(newPatchId("turn-xyz")).toMatch(/^turn-xyz:[0-9a-f]{8}$/);
  });

  test("sha256Hex is stable hex digest", () => {
    const bytes = Buffer.from("hello");
    expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
  });

  test("countDiffStats ignores diff headers", () => {
    const diff = ["--- a/x.md", "+++ b/x.md", "-old", "+new", "+more", ""].join("\n");
    expect(countDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });
});
