import { describe, expect, test } from "bun:test";

import {
  COMPUTER_DO_ACTIONS,
  NATIVE_CONTRACT_SCHEMAS,
  computerDoInputSchema,
  computerObserveInputSchema,
  computerNativeControlStateSchema,
} from "../../src/native.ts";

const suffix = "a".repeat(43);
const context = `dctx_${suffix}`;
const windowTarget = { version: 1, context, reference: `dtgt_${suffix}` } as const;
const appTarget = { version: 1, context, reference: `datgt_${"c".repeat(43)}` } as const;
const snapshotTarget = { version: 1, context, reference: `dsnap_${suffix}` } as const;
const regionTarget = { version: 1, context, reference: `dsnap_${"b".repeat(43)}` } as const;

describe("native Computer Use action contract", () => {
  test("selected control state preserves provider values without inventing missing state", () => {
    const state = { completeness: "partial" as const, value: "0", valueDescription: "Muted", selected: false,
      range: { minimum: 0, maximum: 100 } };
    expect(computerNativeControlStateSchema.parse(state)).toEqual(state);
    expect(computerNativeControlStateSchema.parse({ completeness: "partial", value: "" }))
      .toEqual({ completeness: "partial", value: "" });
    for (const invalid of [
      { ...state, value: 0 }, { ...state, selected: "false" }, { ...state, completeness: "complete" },
      { ...state, range: { minimum: 1, maximum: 1 } }, { ...state, range: { minimum: 0 } },
      { ...state, range: { minimum: 0, maximum: Infinity } }, { ...state, checked: false },
      { ...state, element_token: "private-token" },
    ]) expect(computerNativeControlStateSchema.safeParse(invalid).success).toBe(false);
  });
  test("exposes real pointer movement only with its truthful desktop-coordinate contract", () => {
    const operation = { kind: "move_pointer", scope: "desktop", target: snapshotTarget, coordinateSpace: "presented_snapshot_pixels", x: 12, y: 24 };
    expect(computerDoInputSchema.safeParse({ operation }).success).toBe(true);
    for (const override of [{ scope: "window" }, { target: windowTarget }, { coordinateSpace: "window_snapshot_pixels" }, { x: -1 }, { x: Infinity }, { deliveryMode: "background" }, { cursor_id: "overlay" }]) {
      expect(computerDoInputSchema.safeParse({ operation: { ...operation, ...override } }).success).toBe(false);
    }
  });
  test("distinguishes current-focus desktop input from window-pixel targeting and carries Cua pacing", () => {
    const desktopText = { kind: "type_text", scope: "desktop", target: snapshotTarget, text: "focused input" };
    const desktopKey = { kind: "press_key", scope: "desktop", target: snapshotTarget, key: "tab", modifiers: ["command"] };
    for (const delayMs of [0, 30, 200]) {
      for (const operation of [desktopText, { kind: "type_text", target: windowTarget, text: "window input" }]) {
        expect(computerDoInputSchema.safeParse({ operation: { ...operation, delayMs } }).success).toBe(true);
      }
    }
    expect(computerDoInputSchema.safeParse({ operation: desktopKey }).success).toBe(true);
    for (const operation of [desktopText, desktopKey]) {
      for (const extra of [{ deliveryMode: "background" }, { x: 1, y: 2, coordinateSpace: "presented_snapshot_pixels" }, { target: windowTarget }]) {
        expect(computerDoInputSchema.safeParse({ operation: { ...operation, ...extra } }).success).toBe(false);
      }
    }
    for (const delayMs of [-1, 201, 0.5, null, "30"]) {
      expect(computerDoInputSchema.safeParse({ operation: { ...desktopText, delayMs } }).success).toBe(false);
    }
  });
  test("admits full Cua drag ranges and desktop or cropped-window coordinates", () => {
    const drag = { kind: "drag_drop", target: snapshotTarget, coordinateSpace: "presented_snapshot_pixels", from: { x: 2, y: 3 }, to: { x: 20, y: 30 } };
    for (const coordinateSpace of ["presented_snapshot_pixels", "window_snapshot_pixels"]) {
      for (const button of ["left", "right", "middle"]) {
        for (const [durationMs, steps] of [[0, 1], [500, 20], [10_000, 200]]) {
          expect(computerDoInputSchema.safeParse({ operation: { ...drag, coordinateSpace, button, durationMs, steps, modifiers: ["cmd", "shift", "option"], deliveryMode: "foreground" } }).success).toBe(true);
        }
      }
    }
    expect(computerDoInputSchema.safeParse({ operation: drag }).success).toBe(true);
    for (const invalid of [{ durationMs: -1 }, { durationMs: 10_001 }, { durationMs: 1.5 }, { steps: 0 }, { steps: 201 }, { steps: 1.5 }, { button: "extra" }, { modifiers: ["extra"] }]) {
      expect(computerDoInputSchema.safeParse({ operation: { ...drag, ...invalid } }).success).toBe(false);
    }
  });
  test("admits Cua pixel buttons, counts, modifiers and native accessibility actions", () => {
    for (const coordinateSpace of ["window_snapshot_pixels", "presented_snapshot_pixels"] as const) {
      for (const button of ["left", "right", "middle"]) {
        expect(computerDoInputSchema.safeParse({ operation: {
          kind: "click", target: snapshotTarget, coordinateSpace, x: 10, y: 20,
          button, count: 3, modifiers: ["cmd", "shift", "option", "alt", "ctrl"], deliveryMode: "foreground",
        } }).success).toBe(true);
      }
    }
    for (const axAction of ["press", "show_menu", "pick", "confirm", "cancel", "open"]) {
      expect(computerDoInputSchema.safeParse({ operation: {
        kind: "click", target: { version: 1, context, reference: `detgt_${suffix}` }, axAction,
      } }).success).toBe(true);
    }
    const pixel = { kind: "click", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 10, y: 20 };
    for (const override of [
      { count: 0 }, { count: -1 }, { count: 1.5 }, { count: Number.MAX_SAFE_INTEGER + 1 },
      { button: "unknown" }, { modifiers: ["unknown"] }, { axAction: "press" },
      { deliveryMode: "unknown" },
    ]) {
      expect(computerDoInputSchema.safeParse({ operation: { ...pixel, ...override } }).success).toBe(false);
    }
  });

  test("selects typing, replacement and scrolling by observed role and explicit operation", () => {
    for (const role of ["text_field", "text_area", "combo_box", "popup_button", "scroll_area", "outline", "future_control"]) {
      for (const action of ["type_text", "set_value", "scroll"]) {
        expect(computerObserveInputSchema.safeParse({ operation: "window_state", target: windowTarget,
          selector: { role, action, labelEquals: "Observed control" } }).success).toBe(true);
      }
    }
  });
  test("selects click interactions by observed role, not a fixture role allowlist", () => {
    for (const role of ["row", "link", "outline", "radio_button", "tab_group", "future_control", "text_field", "checkbox"]) {
      for (const interaction of [undefined, "right_click", "double_click"]) {
        expect(computerObserveInputSchema.safeParse({
          operation: "window_state", target: windowTarget,
          selector: { role, action: "click", labelEquals: "Observed control", ...(interaction === undefined ? {} : { interaction }) },
        }).success).toBe(true);
      }
    }
    expect(computerObserveInputSchema.safeParse({
      operation: "window_state", target: windowTarget,
      selector: { role: "checkbox", interaction: "double_click" },
    }).success).toBe(true);
    // A role is evidence, not a provider method or native-token escape hatch.
    for (const selector of [
      { role: "row", action: "run_shell" },
      { role: "row", action: "click", element_token: "private-token" },
      { role: "row", action: "click", interaction: "arbitrary_provider_method" },
    ]) {
      expect(computerObserveInputSchema.safeParse({ operation: "window_state", target: windowTarget, selector }).success).toBe(false);
    }
  });

  test("advertises the complete canonical action family", () => {
    expect(COMPUTER_DO_ACTIONS).toEqual([
      "focus", "click", "type_text", "set_value", "press_key", "drag_drop", "scroll",
      "invoke_menu", "set_window_frame", "launch_app", "create_window", "move_pointer", "hotkey",
    ]);
  });

  test("admits exact window-snapshot input, native menus, and unrestricted finite window coordinates", () => {
    for (const operation of [
      { kind: "type_text", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 12, y: 24, text: "one pixel write" },
      { kind: "press_key", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", x: 12, y: 24, key: "return", modifiers: ["shift"] },
      { kind: "invoke_menu", target: windowTarget, menuPath: ["View", "as List"] },
      { kind: "set_window_frame", target: windowTarget, frame: { x: -500, y: 120, width: 900, height: 700 } },
    ]) {
      expect(computerDoInputSchema.safeParse({ operation }).success).toBe(true);
    }
  });

  test("rejects mismatched coordinate authority and widened provider-facing fields", () => {
    for (const operation of [
      { kind: "type_text", target: windowTarget, coordinateSpace: "window_snapshot_pixels", x: 12, y: 24, text: "wrong target" },
      { kind: "press_key", target: snapshotTarget, coordinateSpace: "desktop_pixels", x: 12, y: 24, key: "return" },
      { kind: "invoke_menu", target: windowTarget, menuPath: [" View"] },
      { kind: "set_window_frame", target: windowTarget, frame: { x: 0, y: 0, width: 0, height: 700 } },
      { kind: "set_window_frame", target: windowTarget, frame: { x: 0, y: 0, width: 900, height: 700 }, pid: 42 },
    ]) {
      expect(computerDoInputSchema.safeParse({ operation }).success).toBe(false);
    }
  });

  test("mirrors the complete checked Cua query, scroll, and menu domains without clamping", () => {
    expect(computerObserveInputSchema.safeParse({
      operation: "window_state",
      target: windowTarget,
      query: "q".repeat(240),
    }).success).toBe(true);
    expect(computerObserveInputSchema.safeParse({
      operation: "window_state",
      target: windowTarget,
      query: "q".repeat(241),
    }).success).toBe(false);

    for (const candidate of [
      { operation: "window_state", target: windowTarget, effort: { maxElements: 1 } },
      { operation: "window_state", target: windowTarget, selector: { role: "button" }, effort: { maxDepth: 40 } },
      { operation: "window_state", target: windowTarget, capture: "window_snapshot", effort: { maxElements: 5_000, maxDepth: 60 } },
      { operation: "window_state", target: windowTarget, query: "needle", effort: { maxElements: 9_000 } },
      {
        operation: "window_state", target: windowTarget, query: "needle",
        selector: { role: "button" }, capture: "window_snapshot",
        effort: { maxElements: 9_000, maxDepth: 60 },
      },
      { operation: "application_windows", target: appTarget, query: "needle", effort: { maxDepth: 80 } },
    ]) {
      expect(computerObserveInputSchema.safeParse(candidate).success).toBe(true);
    }
    for (const effort of [
      {},
      { maxElements: 0 },
      { maxDepth: -1 },
      { maxElements: 1.5 },
      { maxDepth: Number.MAX_SAFE_INTEGER + 1 },
      { maxElements: 10, unknown: 1 },
    ]) {
      expect(computerObserveInputSchema.safeParse({
        operation: "window_state", target: windowTarget, query: "needle", effort,
      }).success).toBe(false);
    }
    expect(computerObserveInputSchema.safeParse({
      operation: "application_windows", target: appTarget, effort: { maxElements: 500 },
    }).success).toBe(false);

    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse({
      version: 1,
      operation: "window_state",
      target: windowTarget,
      evidence: { kind: "window", appLabel: "Fixture" },
      completeness: "sufficient",
      degraded: false,
      verification: "supported",
      element: {
        selector: { role: "button" }, disposition: "unique", target: { version: 1, context, reference: `detgt_${suffix}` },
        evidence: { kind: "element", role: "button", action: "click" },
      },
      windowSnapshot: {
        target: snapshotTarget, evidence: { kind: "screen" },
        metadata: { format: "png", dimensions: { width: 100, height: 80 }, coordinateSpace: "window_snapshot_pixels" },
      },
      semanticQuery: {
        query: "needle", effort: { maxElements: 9_000, maxDepth: 60 }, exhaustive: false,
        matched: 1, returned: 1, omitted: 0,
        matches: [{ role: "button", label: "Needle", labelTruncated: false, valueTruncated: false }],
      },
      outcome: {
        version: 1, phase: "observe", retrySafety: "safe", stateChangeCertainty: "not_applicable",
        providerCondition: "ready", targetCondition: "current", recovery: ["retry_same_request"],
      },
    }).success).toBe(true);

    const queriedInventory = {
      version: 1,
      operation: "application_windows",
      target: appTarget,
      completeness: "complete",
      discovered: 1,
      returned: 1,
      omitted: 0,
      candidates: [{
        target: windowTarget,
        evidence: { kind: "window", appLabel: "Fixture", windowLabel: "Document" },
        semanticQuery: {
          query: "missing", exhaustive: false, matched: 0, returned: 0, omitted: 0, matches: [],
        },
      }],
      semanticQuery: { query: "missing", exhaustive: false, inspected: 1, uninspected: 0 },
      outcome: {
        version: 1, phase: "observe", retrySafety: "safe", stateChangeCertainty: "not_applicable",
        providerCondition: "ready", targetCondition: "current", recovery: ["retry_same_request"],
      },
    } as const;
    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(queriedInventory).success).toBe(true);
    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse({
      ...queriedInventory,
      semanticQuery: { ...queriedInventory.semanticQuery, inspected: 0 },
    }).success).toBe(false);

    expect(computerDoInputSchema.safeParse({
      operation: {
        kind: "scroll",
        target: snapshotTarget,
        coordinateSpace: "window_snapshot_pixels",
        x: 12,
        y: 24,
        direction: "down",
        amount: 50,
        by: "line",
      },
    }).success).toBe(true);
    expect(computerDoInputSchema.safeParse({
      operation: {
        kind: "scroll",
        target: snapshotTarget,
        coordinateSpace: "window_snapshot_pixels",
        x: 12,
        y: 24,
        direction: "down",
        amount: 51,
        by: "line",
      },
    }).success).toBe(false);

    expect(computerDoInputSchema.safeParse({
      operation: { kind: "invoke_menu", target: windowTarget, menuPath: Array.from({ length: 16 }, () => "m".repeat(200)) },
    }).success).toBe(true);
    expect(computerDoInputSchema.safeParse({
      operation: { kind: "invoke_menu", target: windowTarget, menuPath: Array.from({ length: 17 }, () => "menu") },
    }).success).toBe(false);
    expect(computerDoInputSchema.safeParse({
      operation: { kind: "invoke_menu", target: windowTarget, menuPath: ["m".repeat(201)] },
    }).success).toBe(false);
  });

  test("admits one-shot precision regions and region-pixel actions without exposing provider coordinates", () => {
    const region = {
      operation: "window_region",
      target: snapshotTarget,
      coordinateSpace: "window_snapshot_pixels",
      region: { x: 20, y: 30, width: 300, height: 120 },
    } as const;
    expect(computerObserveInputSchema.safeParse(region).success).toBe(true);
    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse({
      version: 1,
      operation: "window_region",
      source: snapshotTarget,
      regionSnapshot: {
        target: regionTarget,
        evidence: { kind: "screen" },
        metadata: {
          format: "png",
          dimensions: { width: 300, height: 120 },
          coordinateSpace: "presented_snapshot_pixels",
        },
      },
      outcome: {
        version: 1,
        phase: "observe",
        retrySafety: "never",
        stateChangeCertainty: "not_applicable",
        providerCondition: "ready",
        targetCondition: "current",
        recovery: [],
      },
    }).success).toBe(true);
    for (const operation of [
      { kind: "click", target: regionTarget, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3 },
      { kind: "type_text", target: regionTarget, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, text: "precise" },
      { kind: "press_key", target: regionTarget, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, key: "return" },
      { kind: "scroll", target: regionTarget, coordinateSpace: "presented_snapshot_pixels", x: 2, y: 3, direction: "down", amount: 2, by: "line" },
    ]) {
      expect(computerDoInputSchema.safeParse({ operation }).success).toBe(true);
    }
  });

  test("rejects invalid precision rectangles, stale-space guesses, and provider-facing fields", () => {
    for (const candidate of [
      { operation: "window_region", target: snapshotTarget, coordinateSpace: "desktop_pixels", region: { x: 0, y: 0, width: 10, height: 10 } },
      { operation: "window_region", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", region: { x: -1, y: 0, width: 10, height: 10 } },
      { operation: "window_region", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", region: { x: 0, y: 0, width: 0, height: 10 } },
      { operation: "window_region", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", region: { x: 0.5, y: 0, width: 10, height: 10 } },
      { operation: "window_region", target: snapshotTarget, coordinateSpace: "window_snapshot_pixels", region: { x: 0, y: 0, width: 10, height: 10 }, pid: 42 },
    ]) {
      expect(computerObserveInputSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
