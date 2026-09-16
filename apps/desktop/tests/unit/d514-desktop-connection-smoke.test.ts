import { describe, expect, test } from "bun:test";
import {
  D514_DELAYED_HEALTH_HOLD_MS,
  d514DiagnosticDurationIsClose,
  d514DiagnosticIsSanitized,
  d514InitialPageTargetTimeoutMs,
  reacquireD514Page,
} from "../../scripts/d514-desktop-connection-smoke";

describe("D514 controlled Electron smoke helpers", () => {
  test("reacquires the exact page after a stale websocket closes", async () => {
    const expectedUrl = "file:///worktree/bootstrap.html";
    const stale = { type: "page", url: expectedUrl, webSocketDebuggerUrl: "ws://stale" };
    const current = { type: "page", url: expectedUrl, webSocketDebuggerUrl: "ws://current" };
    const wrong = { type: "page", url: `${expectedUrl}?old`, webSocketDebuggerUrl: "ws://wrong" };
    let poll = 0;
    let now = 0;
    const found = await reacquireD514Page({
      expectedUrl,
      expectedText: "Starting Nautilo",
      timeoutMs: 100,
      listTargets: async () => ++poll === 1 ? [wrong, stale] : [wrong, current],
      evaluate: async (target) => {
        if (target === stale) throw new Error("Inspected target navigated or closed");
        return "Starting Nautilo";
      },
      pause: async () => { now += 10; },
      now: () => now,
    });
    expect(found?.target).toBe(current);
    expect(found?.text).toBe("Starting Nautilo");
    expect(poll).toBe(2);
  });

  test("delayed-health hold and diagnostic duration prove the intended window", () => {
    expect(D514_DELAYED_HEALTH_HOLD_MS).toBeGreaterThanOrEqual(5_000);
    expect(D514_DELAYED_HEALTH_HOLD_MS).toBeLessThanOrEqual(6_000);
    const line = `[desktop][d514] category=verified durationMs=${D514_DELAYED_HEALTH_HOLD_MS + 200}`;
    expect(d514DiagnosticDurationIsClose(line, D514_DELAYED_HEALTH_HOLD_MS, 1_000)).toBe(true);
    expect(d514DiagnosticDurationIsClose(line, D514_DELAYED_HEALTH_HOLD_MS, 100)).toBe(false);
  });

  test("allows packaged cold start more time without weakening source polling", () => {
    expect(d514InitialPageTargetTimeoutMs("unpackaged")).toBe(12_000);
    expect(d514InitialPageTargetTimeoutMs("packaged")).toBe(30_000);
  });

  test("accepts the stable content-safe diagnostic projection", () => {
    expect(
      d514DiagnosticIsSanitized(
        "[desktop][d514] cold-boot generation=3 phase=health category=verified durationMs=1500 acceptedGeneration=true stateChanged=true",
        ["http://127.0.0.1:43210", "identity-secret", "fixture-marker"],
      ),
    ).toBe(true);
  });

  test("rejects fixture URL, identity, and response-marker leakage", () => {
    const values = ["http://127.0.0.1:43210", "identity-secret", "fixture-marker"];
    for (const leaked of values) {
      expect(
        d514DiagnosticIsSanitized(`[desktop][d514] ${leaked}`, values),
      ).toBe(false);
    }
  });
});
