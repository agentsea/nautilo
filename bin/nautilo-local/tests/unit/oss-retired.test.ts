/**
 * M100 Phase 4 — `bun run oss` root script points here; stderr hint + exit 2.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";

describe("oss-retired", () => {
  test("exits 2 and prints retirement hint on stderr", async () => {
    const script = path.join(import.meta.dir, "../../src/oss-retired.ts");
    const proc = Bun.spawn(["bun", script], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);
    expect(stderr).toContain(
      "Use infra:start + dev-stack as a minimal path.",
    );
    expect(
      stderr.split("\n").some((line) =>
        line.startsWith("`bun run oss` is retired"),
      ),
    ).toBe(true);
  });
});
