import { describe, expect, test } from "bun:test";
import {
  createRetiredRunShellTool,
  resolveRunShellTimeout,
} from "../../src/tools/shell/run-shell";

describe("retained run_shell timeout decoding", () => {
  test("keeps persisted timeout values bounded while stale calls are being refused", () => {
    expect(resolveRunShellTimeout({})).toEqual({
      ok: true,
      timeoutMs: undefined,
      requiresReason: false,
    });
    expect(resolveRunShellTimeout({ timeout_seconds: 5 }, { soft: 10, hard: 20 })).toEqual({
      ok: true,
      timeoutMs: 5_000,
      requiresReason: false,
    });
    expect(resolveRunShellTimeout(
      { timeout_seconds: 15, timeout_reason: "saved call" },
      { soft: 10, hard: 20 },
    )).toEqual({ ok: true, timeoutMs: 15_000, requiresReason: true });
  });

  test("rejects invalid or unjustified persisted timeout values", () => {
    expect(resolveRunShellTimeout({ timeout_seconds: 0 }, { soft: 10, hard: 20 }))
      .toMatchObject({ ok: false });
    expect(resolveRunShellTimeout({ timeout_seconds: 15 }, { soft: 10, hard: 20 }))
      .toMatchObject({ ok: false });
    expect(resolveRunShellTimeout({ timeout_seconds: 21 }, { soft: 10, hard: 20 }))
      .toMatchObject({ ok: false });
    expect(resolveRunShellTimeout({
      output_artifact: { reference: "retained-reference" },
      timeout_seconds: 1,
    })).toMatchObject({ ok: false });
  });

  test("the compatibility tombstone has no executable schema", async () => {
    const tool = createRetiredRunShellTool();
    expect(tool.schema.safeParse({}).success).toBeTrue();
    expect(tool.schema.safeParse({ command: "echo forbidden" }).success).toBeFalse();
    const failure: unknown = await tool.invoke({}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toContain(
      "legacy local execution interface has been retired",
    );
  });
});
