import { describe, expect, test } from "bun:test";
import { windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";
import { CuaComputerUseAdapter } from "../../src/native-runtime.ts";
import type { ComputerUseContextScope } from "../../src/native-context-registry.ts";
import type { CuaCheckedContextPort } from "../../src/native-cua-lifecycle.ts";
import type { CuaContextToolCallResult, CuaContextToolResult } from "../../src/native-cua-supervisor.ts";

const scope: ComputerUseContextScope = {
  computerUseContextId: "computer-use-context-capture-recovery",
  installationEpoch: "epoch-1",
  grantGeneration: 1,
  provider: "cua",
  providerGeneration: "provider-generation-1",
  originHumanId: "human-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  serverBindingId: "server-binding-1",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "session-1",
};

const generation = "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sessionId = "cua-session-1";

function providerResult(structuredContent: Readonly<Record<string, unknown>>): CuaContextToolResult {
  return { content: [{ type: "text", text: "fixture" }], isError: false, structuredContent };
}

function captureRecoveryPort(): Readonly<{ port: CuaCheckedContextPort; invalidations(): number }> {
  const responses: readonly CuaContextToolResult[] = [
    providerResult({
      apps: [{
        pid: 77,
        name: "Spotify",
        bundle_id: "com.spotify.client",
        active: true,
        running: true,
        launch_path: null,
        kind: "application",
        last_used: null,
        windows: [],
      }],
    }),
    providerResult({
      pid: 77,
      bundle_id: "com.spotify.client",
      name: "Spotify",
      windows: [{
        window_id: 500,
        pid: 77,
        app_name: "Spotify",
        title: "Spotify Premium",
        bounds: { x: 1, y: 2, width: 800, height: 600 },
        layer: 0,
        z_index: 0,
        is_on_screen: false,
        current_space_id: 1,
        on_current_space: false,
        space_ids: [2],
      }],
      launch_state: { requested: true, process_running: true, window_ready: true },
    }),
    providerResult({
      window_id: 500,
      pid: 77,
      element_count: 0,
      total_element_count: 0,
      returned_element_count: 0,
      elements_complete: false,
      tree_markdown: "private tree",
      elements: [],
      _note: "private note",
      degraded: true,
      degraded_reason: "ax_window_unresolved: private off-Space provider reason",
      escalation: { recommended: "foreground" },
      background_input: { exact_window: { status: "ax_unresolved" } },
      screenshot_frame_valid: false,
      screenshot_error: {
        code: "px_capture_unavailable",
        reason: "private ScreenCaptureKit diagnostic",
        suggestion: "private provider recovery text",
        window_id: 500,
      },
    }),
  ];
  let cursor = 0;
  let invalidations = 0;

  const next = (): CuaContextToolCallResult => {
    const result = responses[cursor];
    cursor += 1;
    if (result === undefined) throw new Error("unexpected Cua call");
    return { ok: true, generation, sessionId, result };
  };

  const port: CuaCheckedContextPort = {
    generation,
    invalidateCheckedGeneration: () => { invalidations += 1; },
    callContextTool: async () => next(),
    launchApplication: async () => next(),
    getWindowState: async () => next(),
    captureWindowState: async () => ({
      ...next(),
      png: null,
    }),
    captureDesktopState: async () => ({ ok: false, code: "capture_unavailable" }),
    clickDesktop: async () => ({ ok: false, code: "capture_required" }),
    endContextLease: async () => undefined,
  };
  return { port, invalidations: () => invalidations };
}

describe("D516 Cua capture recovery", () => {
  test("keeps Cua ready and returns focus recovery for an off-Space window", async () => {
    const checked = captureRecoveryPort();
    const subject = new CuaComputerUseAdapter({ port: checked.port });
    const launched = await subject.launchApp({
      scope,
      operation: { kind: "launch_app", app: { name: "Spotify" } },
    });
    if (!launched.ok || launched.receipt.window === null) throw new Error("expected exact Spotify window");

    const observed = await subject.observeWindowState({
      scope,
      target: launched.receipt.window,
      capture: "window_snapshot",
    });

    expect(observed).toMatchObject({
      ok: true,
      observation: {
        completeness: "partial",
        degraded: true,
        verification: "indeterminate",
        outcome: {
          providerCondition: "ready",
          targetCondition: "current",
          recovery: ["focus_target"],
        },
      },
    });
    if (!observed.ok) throw new Error("expected recoverable partial observation");
    expect(observed.observation.windowSnapshot).toBeUndefined();
    expect(windowStateObservationSchema.safeParse(observed.observation).success).toBe(true);
    expect(checked.invalidations()).toBe(0);
    expect(JSON.stringify(observed)).not.toMatch(/ScreenCaptureKit|off-Space|window_id|private/);
  });
});
