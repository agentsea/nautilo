import { describe, expect, test } from "bun:test";
import {
  applyToolResultsToStreaks,
  buildNoProgressKey,
  serializeNoProgressKey,
  operationDiscriminator,
  normalizeToolError,
  resetStreakForKey,
  toNoProgressOutcome,
  toNoProgressOutcomeFromError,
  isNoProgressError,
  formatNoProgressLogToken,
  NoProgressError,
  NO_PROGRESS_CORRECTIVE_INSTRUCTION,
  DEFAULT_REPEATED_FAILURE_LIMIT,
  MAX_NO_PROGRESS_STREAKS,
  type NoProgressStreaks,
  type NoProgressToolResult,
} from "../../src/graph/no-progress";

/**
 * Stack 208 P2 — no-progress breaker (pure helper) unit tests.
 *
 * Covers R4: success resets the streak; successful repeated reads never
 * block; the same normalized failure three times triggers exactly one
 * corrective model turn; one more identical failure maps to a typed
 * no_progress stop and does not execute the tool a fifth time; a different
 * tool/operation/error starts a new streak; parallel tool calls are counted
 * independently and deterministic ordering does not cause false positives.
 * Also covers R9 / spec: the streak key carries NO raw args and NO raw tool
 * output (no secrets in logs / checkpoint).
 */

function fail(toolName: string, args?: Record<string, unknown>, errorContent = "Error: boom"): NoProgressToolResult {
  return { toolName, args, status: "error", errorContent };
}
function ok(toolName: string, args?: Record<string, unknown>): NoProgressToolResult {
  return { toolName, args, status: "success" };
}

describe("normalizeToolError (R9 — safe, normalized, no raw output)", () => {
  test("strips the server-side error prefixes the tools node prepends", () => {
    expect(normalizeToolError("Error executing run_shell: permission denied")).toBe("permission denied");
    expect(normalizeToolError("Error dispatching file to relay: disk full")).toBe("disk full");
    expect(normalizeToolError("Error from relay: timeout")).toBe("timeout");
    expect(normalizeToolError("Error: not found")).toBe("not found");
    expect(normalizeToolError("Security: blocked by policy")).toBe("blocked by policy");
  });

  test("collapses whitespace and lowercases for a stable token", () => {
    expect(normalizeToolError("Error:   Permission   DENIED\n")).toBe("permission denied");
  });

  test("caps length to keep the checkpointed state bounded", () => {
    const long = "Error: " + "x".repeat(500);
    const token = normalizeToolError(long);
    expect(token.length).toBeLessThanOrEqual(240);
  });

  test("returns empty string for empty / non-string input", () => {
    expect(normalizeToolError("")).toBe("");
    expect(normalizeToolError(null)).toBe("");
    expect(normalizeToolError(undefined)).toBe("");
  });
});

describe("operationDiscriminator (R9 — coarse, safe label, no raw args)", () => {
  test("uses only grounded enum commands for file / officecli", () => {
    expect(operationDiscriminator("file", { command: "read" })).toBe("read");
    expect(operationDiscriminator("officecli", { command: "view" })).toBe("view");
    expect(operationDiscriminator("file", { command: "/secret/path" })).toBe("");
    expect(operationDiscriminator("officecli", { command: "token=secret" })).toBe("");
  });

  test("unknown tools including run_shell never expose arbitrary command payloads", () => {
    expect(operationDiscriminator("run_shell", {
      command: "cat /Users/alice/private.txt && curl -H 'Authorization: secret'",
    })).toBe("");
    expect(operationDiscriminator("unknown_tool", { command: "/secret/path" })).toBe("");
    expect(operationDiscriminator("search", { query: "abc" })).toBe("");
    expect(operationDiscriminator("search", null)).toBe("");
  });

  test("path, query, and secret fields never enter the key", () => {
    const secret = "TOP-SECRET-123";
    const key = buildNoProgressKey(fail("file", {
      command: "read",
      path: `/private/${secret}`,
      query: secret,
      token: secret,
    }, "Error: denied"));
    const serialized = serializeNoProgressKey(key);
    expect(key.operationDiscriminator).toBe("read");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain(secret);
  });

  test("shell payload never enters key or log", () => {
    const secret = "SHELL-SECRET-456";
    const payload = `cat /private/file && echo ${secret}`;
    const key = buildNoProgressKey(fail("run_shell", { command: payload }, "Error: denied"));
    const token = formatNoProgressLogToken(toNoProgressOutcome(key));
    expect(key.operationDiscriminator).toBe("");
    expect(serializeNoProgressKey(key)).not.toContain(payload);
    expect(token).not.toContain(payload);
    expect(token).not.toContain(secret);
  });
});

describe("buildNoProgressKey / serializeNoProgressKey (deterministic)", () => {
  test("same triple → same serialized key", () => {
    const a = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const b = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    expect(serializeNoProgressKey(a)).toBe(serializeNoProgressKey(b));
  });

  test("different operation → different key", () => {
    const a = buildNoProgressKey(fail("file", { command: "read" }, "Error: x"));
    const b = buildNoProgressKey(fail("file", { command: "write" }, "Error: x"));
    expect(serializeNoProgressKey(a)).not.toBe(serializeNoProgressKey(b));
  });

  test("different error → different key", () => {
    const a = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const b = buildNoProgressKey(fail("file", { command: "read" }, "Error: permission denied"));
    expect(serializeNoProgressKey(a)).not.toBe(serializeNoProgressKey(b));
  });

  test("different tool → different key", () => {
    const a = buildNoProgressKey(fail("file", { command: "read" }, "Error: x"));
    const b = buildNoProgressKey(fail("officecli", { command: "view" }, "Error: x"));
    expect(serializeNoProgressKey(a)).not.toBe(serializeNoProgressKey(b));
  });
});

describe("applyToolResultsToStreaks — success resets (R4)", () => {
  test("a success removes the streak for that key", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const prev: NoProgressStreaks = new Map([
      [serializeNoProgressKey(key), { count: 2, correctiveTurnIssued: false }],
    ]);
    const { streaks, action } = applyToolResultsToStreaks(prev, [
      ok("file", { command: "read" }),
    ]);
    expect(streaks.size).toBe(0);
    expect(action.kind).toBe("continue");
  });

  test("successful repeated reads never block (streak stays empty)", () => {
    let streaks: NoProgressStreaks = new Map();
    for (let i = 0; i < 10; i++) {
      const t = applyToolResultsToStreaks(streaks, [ok("file", { command: "read" })]);
      streaks = t.streaks;
      expect(t.action.kind).toBe("continue");
    }
    expect(streaks.size).toBe(0);
  });
});

describe("applyToolResultsToStreaks — corrective + stop (R4)", () => {
  test("three identical failures trigger exactly one corrective turn", () => {
    let streaks: NoProgressStreaks = new Map();
    let action = applyToolResultsToStreaks(streaks, [fail("file", { command: "read" }, "Error: not found")]);
    expect(action.action.kind).toBe("continue");
    streaks = action.streaks;

    action = applyToolResultsToStreaks(streaks, [fail("file", { command: "read" }, "Error: not found")]);
    expect(action.action.kind).toBe("continue");
    streaks = action.streaks;

    action = applyToolResultsToStreaks(streaks, [fail("file", { command: "read" }, "Error: not found")]);
    expect(action.action.kind).toBe("inject_corrective");
    streaks = action.streaks;
    const entry = streaks.values().next().value;
    expect(entry?.count).toBe(3);
    expect(entry?.correctiveTurnIssued).toBe(true);
  });

  test("after a corrective turn, one more identical failure maps to stop_no_progress", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const streaks: NoProgressStreaks = new Map([
      [serializeNoProgressKey(key), { count: 3, correctiveTurnIssued: true }],
    ]);
    const { action } = applyToolResultsToStreaks(streaks, [
      fail("file", { command: "read" }, "Error: not found"),
    ]);
    expect(action.kind).toBe("stop_no_progress");
  });

  test("the stop does not re-issue another corrective turn", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const streaks: NoProgressStreaks = new Map([
      [serializeNoProgressKey(key), { count: 3, correctiveTurnIssued: true }],
    ]);
    const { action, streaks: next } = applyToolResultsToStreaks(streaks, [
      fail("file", { command: "read" }, "Error: not found"),
    ]);
    expect(action.kind).toBe("stop_no_progress");
    expect(next.values().next().value?.correctiveTurnIssued).toBe(true);
  });

  test("two failures then a success resets the streak (no corrective)", () => {
    let streaks: NoProgressStreaks = new Map();
    streaks = applyToolResultsToStreaks(streaks, [fail("file", { command: "read" }, "Error: x")]).streaks;
    streaks = applyToolResultsToStreaks(streaks, [fail("file", { command: "read" }, "Error: x")]).streaks;
    const t = applyToolResultsToStreaks(streaks, [ok("file", { command: "read" })]);
    expect(t.streaks.size).toBe(0);
    expect(t.action.kind).toBe("continue");
  });
});

describe("applyToolResultsToStreaks — pair/error reset semantics (R4)", () => {
  test("a different operation does not advance another key's streak", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const prev: NoProgressStreaks = new Map([
      [serializeNoProgressKey(key), { count: 2, correctiveTurnIssued: false }],
    ]);
    const { streaks, action } = applyToolResultsToStreaks(prev, [
      fail("file", { command: "write" }, "Error: not found"),
    ]);
    expect(streaks.size).toBe(2);
    expect(action.kind).toBe("continue");
    const readEntry = streaks.get(serializeNoProgressKey(key));
    expect(readEntry?.count).toBe(2);
    const writeEntry = streaks.get(
      serializeNoProgressKey(buildNoProgressKey(fail("file", { command: "write" }, "Error: not found"))),
    );
    expect(writeEntry?.count).toBe(1);
  });

  test("a different error on the same tool+operation replaces the prior streak", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const prev: NoProgressStreaks = new Map([
      [serializeNoProgressKey(key), { count: 2, correctiveTurnIssued: false }],
    ]);
    const { streaks } = applyToolResultsToStreaks(prev, [
      fail("file", { command: "read" }, "Error: permission denied"),
    ]);
    expect(streaks.size).toBe(1);
    expect(streaks.has(serializeNoProgressKey(key))).toBe(false);
    const replacement = buildNoProgressKey(
      fail("file", { command: "read" }, "Error: permission denied"),
    );
    expect(streaks.get(serializeNoProgressKey(replacement))?.count).toBe(1);
  });

  test("A,A,B,A leaves final A at count 1, not corrective", () => {
    let streaks: NoProgressStreaks = new Map();
    const a = fail("file", { command: "read" }, "Error: A");
    const b = fail("file", { command: "read" }, "Error: B");
    streaks = applyToolResultsToStreaks(streaks, [a]).streaks;
    streaks = applyToolResultsToStreaks(streaks, [a]).streaks;
    const afterB = applyToolResultsToStreaks(streaks, [b]);
    expect(afterB.action.kind).toBe("continue");
    streaks = afterB.streaks;
    const finalA = applyToolResultsToStreaks(streaks, [a]);
    expect(finalA.action.kind).toBe("continue");
    expect(finalA.streaks.size).toBe(1);
    const aKey = serializeNoProgressKey(buildNoProgressKey(a));
    expect(finalA.streaks.get(aKey)?.count).toBe(1);
  });
});

describe("applyToolResultsToStreaks — parallel calls counted independently (R4)", () => {
  test("parallel identical failures advance the streak by ONE step (no false positive)", () => {
    // A single tools-node batch with 5 parallel identical failures advances
    // the streak by one step, not five — so the corrective turn is honored
    // between the limit and the stop, and deterministic ordering cannot
    // manufacture a false positive.
    let streaks: NoProgressStreaks = new Map();
    const batch = [
      fail("file", { command: "read" }, "Error: not found"),
      fail("file", { command: "read" }, "Error: not found"),
      fail("file", { command: "read" }, "Error: not found"),
      fail("file", { command: "read" }, "Error: not found"),
      fail("file", { command: "read" }, "Error: not found"),
    ];
    const t = applyToolResultsToStreaks(streaks, batch);
    expect(t.action.kind).toBe("continue");
    expect(t.streaks.values().next().value?.count).toBe(1);
    streaks = t.streaks;

    // Second batch (next round) → count 2.
    const t2 = applyToolResultsToStreaks(streaks, batch);
    expect(t2.action.kind).toBe("continue");
    expect(t2.streaks.values().next().value?.count).toBe(2);
    streaks = t2.streaks;

    // Third batch → count 3 → corrective.
    const t3 = applyToolResultsToStreaks(streaks, batch);
    expect(t3.action.kind).toBe("inject_corrective");
    streaks = t3.streaks;

    // Fourth batch (after the corrective turn) → stop.
    const t4 = applyToolResultsToStreaks(streaks, batch);
    expect(t4.action.kind).toBe("stop_no_progress");
  });

  test("a mix of success + failure for the same key resets (success wins)", () => {
    // Deterministic ordering: regardless of input order, a success for the
    // same key in the batch resets the streak (the agent IS making progress).
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: not found"));
    const prev: NoProgressStreaks = new Map([
      [serializeNoProgressKey(key), { count: 2, correctiveTurnIssued: false }],
    ]);
    const failFirst = applyToolResultsToStreaks(prev, [
      fail("file", { command: "read" }, "Error: not found"),
      ok("file", { command: "read" }),
    ]);
    const okFirst = applyToolResultsToStreaks(prev, [
      ok("file", { command: "read" }),
      fail("file", { command: "read" }, "Error: not found"),
    ]);
    expect(failFirst.streaks.size).toBe(0);
    expect(okFirst.streaks.size).toBe(0);
    expect(failFirst.action.kind).toBe("continue");
    expect(okFirst.action.kind).toBe("continue");
  });

  test("parallel failures for DIFFERENT keys are tracked independently", () => {
    const { streaks, action } = applyToolResultsToStreaks(new Map(), [
      fail("file", { command: "read" }, "Error: not found"),
      fail("run_shell", { command: "ls" }, "Error: permission denied"),
      ok("search", { query: "x" }),
    ]);
    expect(streaks.size).toBe(2);
    expect(action.kind).toBe("continue");
  });

  test("different errors for one pair in a parallel batch do not create a streak", () => {
    const { streaks, action } = applyToolResultsToStreaks(new Map(), [
      fail("file", { command: "read" }, "Error: A"),
      fail("file", { command: "read" }, "Error: B"),
    ]);
    expect(streaks.size).toBe(0);
    expect(action.kind).toBe("continue");
  });
});

describe("applyToolResultsToStreaks — bounded checkpoint state", () => {
  test("evicts the oldest insertion deterministically at the named maximum", () => {
    let streaks: NoProgressStreaks = new Map();
    for (let i = 0; i < MAX_NO_PROGRESS_STREAKS + 1; i++) {
      streaks = applyToolResultsToStreaks(streaks, [
        fail(`tool_${i}`, {}, `Error: class_${i}`),
      ]).streaks;
    }
    expect(streaks.size).toBe(MAX_NO_PROGRESS_STREAKS);
    const oldestKey = serializeNoProgressKey(
      buildNoProgressKey(fail("tool_0", {}, "Error: class_0")),
    );
    const secondKey = serializeNoProgressKey(
      buildNoProgressKey(fail("tool_1", {}, "Error: class_1")),
    );
    expect(streaks.has(oldestKey)).toBe(false);
    expect(streaks.has(secondKey)).toBe(true);
  });
});

describe("applyToolResultsToStreaks — invalid limit", () => {
  test("rejects a non-positive / non-integer limit", () => {
    expect(() => applyToolResultsToStreaks(new Map(), [], 0)).toThrow();
    expect(() => applyToolResultsToStreaks(new Map(), [], -1)).toThrow();
    expect(() => applyToolResultsToStreaks(new Map(), [], 2.5)).toThrow();
  });
});

describe("resetStreakForKey", () => {
  test("removes only the named key", () => {
    const k1 = buildNoProgressKey(fail("file", { command: "read" }, "Error: a"));
    const k2 = buildNoProgressKey(fail("file", { command: "write" }, "Error: b"));
    const prev: NoProgressStreaks = new Map([
      [serializeNoProgressKey(k1), { count: 1, correctiveTurnIssued: false }],
      [serializeNoProgressKey(k2), { count: 1, correctiveTurnIssued: false }],
    ]);
    const next = resetStreakForKey(prev, k1);
    expect(next.size).toBe(1);
    expect(next.has(serializeNoProgressKey(k2))).toBe(true);
  });
});

describe("NoProgressError + outcome mapping (R9)", () => {
  test("NoProgressError carries the safe key, not raw args/output", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: permission denied"));
    const err = new NoProgressError(key);
    expect(err.code).toBe("no_progress");
    expect(err.name).toBe("NoProgressError");
    expect(err.outcome.kind).toBe("no_progress");
    expect(err.outcome.toolName).toBe("file");
    expect(err.outcome.operationDiscriminator).toBe("read");
    expect(err.outcome.normalizedError).toBe("permission denied");
    // The error message itself does not echo raw args/output.
    expect(err.message).not.toContain("permission denied");
  });

  test("isNoProgressError recognizes a real instance + rewrapped throws", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: x"));
    expect(isNoProgressError(new NoProgressError(key))).toBe(true);
    expect(isNoProgressError({ name: "NoProgressError" })).toBe(true);
    expect(isNoProgressError({ code: "no_progress" })).toBe(true);
    expect(isNoProgressError(new Error("timeout"))).toBe(false);
    expect(isNoProgressError(null)).toBe(false);
  });

  test("toNoProgressOutcomeFromError maps an instance and returns null for others", () => {
    const key = buildNoProgressKey(fail("file", { command: "read" }, "Error: x"));
    expect(toNoProgressOutcomeFromError(new NoProgressError(key))?.kind).toBe("no_progress");
    expect(toNoProgressOutcomeFromError(new Error("timeout"))).toBeNull();
    expect(toNoProgressOutcomeFromError(null)).toBeNull();
  });

  test("toNoProgressOutcome builds the typed outcome from a key", () => {
    const key = buildNoProgressKey(fail("run_shell", {}, "Error: command not found"));
    const o = toNoProgressOutcome(key);
    expect(o.kind).toBe("no_progress");
    expect(o.toolName).toBe("run_shell");
  });

  test("formatNoProgressLogToken is grep-able and never logs normalized error", () => {
    const leakage = "/Users/alice/private.txt token=TOP-SECRET user words";
    const key = buildNoProgressKey(fail("file", { command: "read" }, `Error: ${leakage}`));
    const token = formatNoProgressLogToken(toNoProgressOutcome(key));
    expect(token).toContain("no_progress");
    expect(token).toContain("tool=file");
    expect(token).toContain("operation=read");
    expect(token).not.toContain("error=");
    expect(token).not.toContain(leakage);
    expect(token).not.toContain("TOP-SECRET");
  });

  test("formatNoProgressLogToken sanitizes unsafe tool and operation tokens", () => {
    const token = formatNoProgressLogToken({
      kind: "no_progress",
      toolName: "tool name\nsecret=value",
      operationDiscriminator: "/private/path",
      normalizedError: "never log this",
    });
    expect(token).toBe("no_progress tool=<unknown> operation=<unknown>");
    expect(token).not.toContain("secret");
    expect(token).not.toContain("private");
    expect(token).not.toContain("never log this");
  });
});

describe("NO_PROGRESS_CORRECTIVE_INSTRUCTION", () => {
  test("is a non-empty internal instruction that does not echo raw payloads", () => {
    expect(NO_PROGRESS_CORRECTIVE_INSTRUCTION.length).toBeGreaterThan(0);
    expect(NO_PROGRESS_CORRECTIVE_INSTRUCTION).toContain("nautilo/no-progress");
    // No raw error / arg tokens in the generic instruction.
    expect(NO_PROGRESS_CORRECTIVE_INSTRUCTION.toLowerCase()).not.toContain("permission denied");
  });
});

describe("DEFAULT_REPEATED_FAILURE_LIMIT", () => {
  test("is 3 per the spec policy", () => {
    expect(DEFAULT_REPEATED_FAILURE_LIMIT).toBe(3);
  });
});



test("successful security status polling cannot erase repeated failed finalization", () => {
  let streaks: NoProgressStreaks = new Map();
  for (let attempt = 0; attempt < DEFAULT_REPEATED_FAILURE_LIMIT; attempt++) {
    const failure = applyToolResultsToStreaks(streaks, [fail("security_scan", { operation: "results" }, "Research incomplete: missing counterevidence")]);
    expect(failure.action.kind).toBe(attempt === DEFAULT_REPEATED_FAILURE_LIMIT - 1 ? "inject_corrective" : "continue");
    streaks = applyToolResultsToStreaks(failure.streaks, [ok("security_scan", { operation: "status" })]).streaks;
  }
  expect(applyToolResultsToStreaks(streaks, [fail("security_scan", { operation: "results" }, "Research incomplete: missing counterevidence")]).action.kind).toBe("stop_no_progress");
  expect(operationDiscriminator("security_scan", { operation: "private arbitrary text" })).toBe("");
});
