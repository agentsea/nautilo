/**
 * M203 — `effectiveOfficeCliImpact` tests.
 *
 * The `officecli` tool's catalog impact is "low" (auto), which is correct for
 * workspace/home/scratch writes (server-owned zones). Since M203 it also
 * supports `zone: "current" | "absolute"` (the user's machine, via the relay
 * byte transport). Those MUTATIONS must HIL-gate like the `file` tool's
 * current/absolute writes, while read-only office commands stay auto.
 *
 * This mapping is the hinge between (command, zone) and the D061 verb map.
 */

import { describe, test, expect } from "bun:test";
import { effectiveOfficeCliImpact } from "../../src/nodes/post-model";

const READ_ONLY_COMMANDS = ["view", "get", "query", "validate", "dump", "raw", "help"] as const;
const MUTATING_COMMANDS = [
  "create",
  "set",
  "add",
  "remove",
  "move",
  "swap",
  "merge",
  "batch",
  "raw_set",
  "add_part",
  "open",
  "save",
  "close",
  "refresh",
] as const;

describe("effectiveOfficeCliImpact — read-only commands stay auto everywhere", () => {
  for (const command of READ_ONLY_COMMANDS) {
    for (const zone of ["workspace", "current", "absolute", "home", "scratch"]) {
      test(`${command} + ${zone} → read-only`, () => {
        expect(effectiveOfficeCliImpact({ command, zone }, "low")).toBe("read-only");
      });
    }
  }
});

describe("effectiveOfficeCliImpact — mutations on server-owned zones stay auto (low)", () => {
  for (const command of MUTATING_COMMANDS) {
    for (const zone of ["workspace", "home", "scratch"]) {
      test(`${command} + ${zone} → low (auto — her drawer)`, () => {
        expect(effectiveOfficeCliImpact({ command, zone }, "low")).toBe("low");
      });
    }
  }
});

describe("effectiveOfficeCliImpact — mutations on the user's machine HIL-gate", () => {
  for (const command of MUTATING_COMMANDS) {
    for (const zone of ["current", "absolute"] as const) {
      test(`${command} + ${zone} → destructive (ask)`, () => {
        expect(effectiveOfficeCliImpact({ command, zone }, "low")).toBe("destructive");
      });
    }
  }
});

describe("effectiveOfficeCliImpact — defensive fallbacks", () => {
  test("null args → fallback", () => {
    expect(effectiveOfficeCliImpact(null, "low")).toBe("low");
  });

  test("undefined args → fallback", () => {
    expect(effectiveOfficeCliImpact(undefined, "low")).toBe("low");
  });

  test("missing command → fallback", () => {
    expect(effectiveOfficeCliImpact({ zone: "current" }, "low")).toBe("low");
  });

  test("non-string command → fallback", () => {
    expect(effectiveOfficeCliImpact({ command: 7, zone: "current" }, "low")).toBe("low");
  });

  test("mutation with missing zone → low (server-owned default, not relay)", () => {
    // No zone means the tool's default "workspace" applies at runtime; the
    // approval mapping treats a non-current/absolute zone as server-owned.
    expect(effectiveOfficeCliImpact({ command: "set" }, "low")).toBe("low");
  });
});
