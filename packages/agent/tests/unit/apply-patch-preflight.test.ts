import { describe, expect, test } from "bun:test";
import { preflightApplyPatch } from "../../src/tools/apply-patch/preflight";

const MEBIBYTE = 1024 * 1024;
const WITHDRAWN_FILE_COUNT = 101;
const WITHDRAWN_HUNK_COUNT = 1001;

/**
 * Constructed in-memory so this regression exercises the actual parser without
 * checking a multi-megabyte fixture into the repository. It deliberately
 * crosses every former D448 product ceiling in one valid patch.
 */
function historicallyLargePatch(): string {
  const lines = ["*** Begin Patch", "*** Add File: bulk/large.txt", `+${"x".repeat(MEBIBYTE + 1)}`];
  for (let index = 0; index < WITHDRAWN_FILE_COUNT - 1; index += 1) {
    lines.push(`*** Add File: bulk/file-${index.toString().padStart(3, "0")}.txt`);
    lines.push(`+${"y".repeat(80_000)}`);
  }
  lines.push("*** Update File: existing.txt");
  for (let index = 0; index < WITHDRAWN_HUNK_COUNT; index += 1) {
    lines.push("@@", `-old-${index}`, `+new-${index}`);
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}

describe("D448 apply_patch preflight", () => {
  test("independently parses a canonical multi-operation plan", () => {
    const result = preflightApplyPatch([
      "*** Begin Patch", "*** Environment ID: test", "*** Add File: docs/new.md", "+hello",
      "*** Update File: src/a.ts", "@@", "-before", "+after",
      "*** Update File: src/old.ts", "*** Move to: src/new.ts", "@@", "-old", "+new",
      "*** Delete File: tmp/old.txt", "*** End Patch",
    ].join("\n"));
    expect(result).toEqual({
      ok: true,
      summary: {
        operations: [
          { operation: "add", path: "docs/new.md" },
          { operation: "update", path: "src/a.ts" },
          { operation: "move", fromPath: "src/old.ts", path: "src/new.ts" },
          { operation: "delete", path: "tmp/old.txt" },
        ],
      },
    });
  });

  test("fails closed on malformed grammar while leaving path policy to the authority boundary", () => {
    expect(preflightApplyPatch("*** Begin Patch\n*** Update File: a.txt\n*** End Patch"))
      .toMatchObject({ ok: false, error: { code: "parse_error" } });
    expect(preflightApplyPatch("*** Begin Patch\n*** Add File: ../outside\n+x\n*** End Patch").ok).toBe(true);
    expect(preflightApplyPatch("*** Begin Patch\n*** Add File: a\n+x\n*** Delete File: a\n*** End Patch").ok).toBe(true);
  });

  test("accepts a patch beyond every withdrawn D448 semantic ceiling", () => {
    const patch = historicallyLargePatch();
    expect(Buffer.byteLength(patch, "utf8")).toBeGreaterThan(8 * MEBIBYTE);
    expect(patch.match(/^@@$/gm)).toHaveLength(WITHDRAWN_HUNK_COUNT);

    const result = preflightApplyPatch(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    expect(result.summary.operations).toHaveLength(WITHDRAWN_FILE_COUNT + 1);
    expect(result.summary.operations.filter(({ operation }) => operation === "add")).toHaveLength(WITHDRAWN_FILE_COUNT);
    expect(result.summary.operations.at(-1)).toEqual({ operation: "update", path: "existing.txt" });
  });
});
