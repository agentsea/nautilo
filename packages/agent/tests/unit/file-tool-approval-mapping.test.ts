/**
 * D079 Phase 4 / D087 Phase 1 — `effectiveFileToolImpact` tests.
 *
 * This mapping decides what ToolImpact the severity-resolver sees for
 * each `file({command, zone, ...})` call. It's the hinge between the
 * per-command `FILE_COMMAND_POLICIES` severity and the D061 verb map.
 *
 * D087 §1.3.5 change (2026-04-23): every mutating command (write /
 * insert / str_replace / delete / move / copy) now classifies as
 * `read_only` at the command-policy layer because they STAGE a patch
 * instead of mutating disk at call time. The DiffView Accept click is
 * the HIL gate. This mapping reflects that — every staging command
 * resolves to `read-only` ToolImpact regardless of zone.
 *
 * Read-only commands (list / read / grep / stat) are unchanged.
 * Unknown commands still fail closed to `destructive` via
 * `resolveFileCommandPolicy`'s `destructive_high` default.
 */

import { describe, test, expect } from "bun:test";
import { effectiveFileToolImpact } from "../../src/nodes/post-model";

describe("effectiveFileToolImpact — exit-criteria mapping", () => {
  test("Exit #1: list+current → read-only (auto)", () => {
    expect(
      effectiveFileToolImpact({ command: "list", zone: "current" }, "destructive"),
    ).toBe("read-only");
  });

  test("Exit #2: write+workspace → read-only (stage, DiffView gates)", () => {
    expect(
      effectiveFileToolImpact({ command: "write", zone: "workspace" }, "destructive"),
    ).toBe("read-only");
  });

  test("Exit #3: str_replace outside workspace → read-only (stage, DiffView gates)", () => {
    // Pre-D087 this was `destructive` because str_replace hit disk
    // directly. Post-D087 §1.3.5 it stages; the DiffView Accept
    // click is the HIL gate and the tool-call itself is safe.
    for (const zone of ["current", "absolute"] as const) {
      expect(
        effectiveFileToolImpact({ command: "str_replace", zone }, "destructive"),
      ).toBe("read-only");
    }
  });

  test("Exit #4: delete → read-only regardless of zone (stage; DiffView shows bytes about to disappear)", () => {
    // Pre-D087 delete was `destructive_high` and HIL-always. Post-
    // §1.3.5 it stages; the DiffView shows an all-red preview of the
    // file content about to be removed, so the user eyeballs the
    // payload before clicking Accept.
    for (const zone of ["workspace", "current", "absolute"] as const) {
      expect(
        effectiveFileToolImpact({ command: "delete", zone }, "destructive"),
      ).toBe("read-only");
    }
  });
});

describe("effectiveFileToolImpact — full command × zone matrix", () => {
  // Read family: read-only regardless of zone (unchanged).
  for (const command of ["list", "read", "grep", "stat"]) {
    for (const zone of ["workspace", "current", "absolute", "home", "scratch"]) {
      test(`${command} + ${zone} → read-only`, () => {
        expect(
          effectiveFileToolImpact({ command, zone }, "destructive"),
        ).toBe("read-only");
      });
    }
  }

  // Content-staging commands: read-only everywhere (D087 §1.3).
  for (const command of ["write", "insert", "str_replace"]) {
    for (const zone of ["workspace", "current", "absolute", "home", "scratch"]) {
      test(`${command} + ${zone} → read-only (staging)`, () => {
        expect(
          effectiveFileToolImpact({ command, zone }, "destructive"),
        ).toBe("read-only");
      });
    }
  }

  // Structural-staging commands: read-only everywhere (D087 §1.3.5).
  for (const command of ["delete", "move", "copy"]) {
    for (const zone of ["workspace", "current", "absolute", "home", "scratch"]) {
      test(`${command} + ${zone} → read-only (structural staging)`, () => {
        expect(
          effectiveFileToolImpact({ command, zone }, "destructive"),
        ).toBe("read-only");
      });
    }
  }

});

describe("effectiveFileToolImpact — defensive fallbacks", () => {
  test("null args → fallback impact (destructive)", () => {
    expect(effectiveFileToolImpact(null, "destructive")).toBe("destructive");
  });

  test("undefined args → fallback", () => {
    expect(effectiveFileToolImpact(undefined, "destructive")).toBe("destructive");
  });

  test("non-string command → fallback", () => {
    expect(
      effectiveFileToolImpact({ command: 42, zone: "workspace" }, "destructive"),
    ).toBe("destructive");
  });

  test("missing command → fallback", () => {
    expect(
      effectiveFileToolImpact({ zone: "workspace" }, "destructive"),
    ).toBe("destructive");
  });

  test("unknown command → destructive (via resolveFileCommandPolicy fail-closed)", () => {
    // resolveFileCommandPolicy returns destructive_high for unknown
    // commands. Our mapping converts destructive_high → destructive
    // at the ToolImpact layer regardless of zone. Unknown command
    // is treated as destructive = ask, which preserves the
    // fail-closed property from D079.
    expect(
      effectiveFileToolImpact(
        { command: "typo_command", zone: "workspace" },
        "destructive",
      ),
    ).toBe("destructive");
  });
});
