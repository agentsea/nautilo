import { describe, expect, test } from "bun:test";

import { CuaBrowserRuntime } from "../../../../computer-use-host/src/browser-runtime.ts";
import { ComputerUseHost } from "../../../../computer-use-host/src/runtime.ts";
import { resolveComputerUseHostToolRequest } from "../../config/computer-use-catalogue/host-tool-admission.ts";
import { projectSemanticComputerResult } from "./model-result-projector.ts";

describe("browser failure through production admission, Host and model projection", () => {
  test("page recovery reaches Genie through the exact current signed-schema contract", async () => {
    const calls: string[] = [];
    const authority = { authorityLeaseId: "fixture-authority", authorityGeneration: 1 };
    const window = { version: 1 as const, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
    const runtime = new CuaBrowserRuntime({ client: {
      async callTool(name, args) {
        calls.push(name);
        if (name !== "get_browser_state") return { isError: false, structuredContent: { status: "ok" } };
        if (args["pid"] !== undefined) return { isError: false, structuredContent: {
          status: "ok", mode: "bind", target_id: "private-target", binding_quality: "exact",
          binding_route: "native_cdp_window", endpoint_transport: "dev_tools_active_port",
          endpoint_access_class: "driver_owned", mutation_allowed: true, native_title: "Fixture",
          tabs: [{ tab_id: "private-tab", title: "Fixture", url: "https://example.com/", active: false }],
        } };
        return { isError: true, structuredContent: { status: "refused", refusal: {
          code: "authorization_host_failed",
          message: "confirmation provider failed: could not prove the live top-level browser document: private-diagnostic",
        } } };
      },
    } });
    const host = new ComputerUseHost({ hostGeneration: "fixture-host", driverGeneration: "fixture-driver", handlers: runtime.handlers });
    const dispatch = async (name: string, args: unknown) => {
      const admitted = resolveComputerUseHostToolRequest(name, args);
      if (admitted === null) throw new Error("current catalogue must admit fixture");
      const raw = await host.dispatch({
        kind: "request", protocol: { major: 3, minor: 0 }, requestId: name, authority,
        fence: { hostGeneration: "fixture-host", driverGeneration: "fixture-driver", cancellationGeneration: 0 },
        ...admitted,
      });
      return JSON.parse(projectSemanticComputerResult(name, JSON.stringify(raw))) as unknown;
    };
    try {
      runtime.targets.registerWindow(window, { pid: 1234, windowId: 5678 }, authority);
      const bound = await dispatch("computer_browser_bind_window", { window });
      expect(bound).toMatchObject({ ok: true, settlement: "completed" });
      const binding = bound as { result: { target: unknown; tabs: Array<{ target: unknown }> } };
      const projected = await dispatch("computer_browser_read_page", {
        target: binding.result.target, tab: binding.result.tabs[0]!.target,
      });
      expect(projected).toMatchObject({ ok: false, settlement: "not_completed", result: {
        recovery: "use_native_window", failure: { reason: "page_unavailable", stage: "read",
          stateChangeCertainty: "not_changed", retryCondition: "route_or_provider_change" },
      } });
      expect(JSON.stringify(projected)).not.toMatch(/private-|1234|5678|schemaDigest|fixture-authority/);
      expect(calls).toEqual(["start_session", "get_browser_state", "get_browser_state"]);
    } finally {
      await runtime.close();
    }
  });

  test("current bind failure reaches Genie while uncertain preparation remains fenced", async () => {
    const calls: string[] = [];
    const authority = { authorityLeaseId: "fixture-authority", authorityGeneration: 1 };
    const window = { version: 1 as const, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
    const fresh = { ...window, reference: `dtgt_${"c".repeat(43)}` };
    const runtime = new CuaBrowserRuntime({ client: {
      async callTool(name) {
        calls.push(name);
        if (name === "browser_prepare" || name === "get_browser_state") return { isError: true, structuredContent: {
          status: "refused", refusal: {
            code: name === "browser_prepare" ? "browser_wrong_target_refused" : "browser_binding_ambiguous",
            message: "private-driver-context",
          },
        } };
        return { isError: false, structuredContent: { status: "ok" } };
      },
    } });
    const host = new ComputerUseHost({ hostGeneration: "fixture-host", driverGeneration: "fixture-driver", handlers: runtime.handlers });
    const dispatch = async (name: string, target: typeof window, requestId: string) => {
      const admitted = resolveComputerUseHostToolRequest(name, { window: target });
      if (admitted === null) throw new Error("current catalogue must admit the actual fixture request");
      const raw = await host.dispatch({
        kind: "request", protocol: { major: 3, minor: 0 }, requestId, authority,
        fence: { hostGeneration: "fixture-host", driverGeneration: "fixture-driver", cancellationGeneration: 0 },
        ...admitted,
      });
      return JSON.parse(projectSemanticComputerResult(name, JSON.stringify(raw))) as unknown;
    };
    try {
      runtime.targets.registerWindow(window, { pid: 1234, windowId: 5678 }, authority);
      const preparation = await dispatch("computer_browser_prepare", window, "prepare-fixture");
      runtime.targets.registerWindow(fresh, { pid: 1234, windowId: 5678 }, authority);
      const rebound = await dispatch("computer_browser_bind_window", fresh, "rebind-fixture");
      expect(rebound).toMatchObject({ version: 1, ok: false, settlement: "not_completed", result: {
        recovery: "use_native_window", failure: {
          reason: "target_ambiguous", stage: "bind", stateChangeCertainty: "unknown",
          retryCondition: "inspect_effects_before_continuing",
        },
      } });
      expect(JSON.stringify(rebound)).not.toMatch(/private-driver-context|1234|5678|schemaDigest|fixture-authority/);
      expect(await dispatch("computer_browser_prepare", fresh, "cached-prepare-fixture")).toEqual(preparation);
      expect(calls).toEqual(["start_session", "browser_prepare", "get_browser_state"]);
    } finally {
      await runtime.close();
    }
    expect(calls.at(-1)).toBe("end_session");
  });

  test("cold setup ambiguity survives every boundary without provider content or replay", async () => {
    const calls: string[] = [];
    const authority = { authorityLeaseId: "fixture-authority", authorityGeneration: 1 };
    const window = { version: 1 as const, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
    const runtime = new CuaBrowserRuntime({ client: {
      async callTool(name) {
        calls.push(name);
        return name === "browser_prepare" ? { isError: true, structuredContent: {
          status: "refused", refusal: {
            code: "browser_wrong_target_refused",
            message: "multiple distinct native New Tab buttons matched",
            detail: { diagnostic: "private-driver-context" },
          },
        } } : { isError: false, structuredContent: { status: "ok" } };
      },
    } });
    runtime.targets.registerWindow(window, { pid: 1234, windowId: 5678 }, authority);
    const host = new ComputerUseHost({ hostGeneration: "fixture-host", driverGeneration: "fixture-driver", handlers: runtime.handlers });
    const admitted = resolveComputerUseHostToolRequest("computer_browser_prepare", { window });
    if (admitted === null) throw new Error("current catalogue must admit the actual fixture request");
    const raw = await host.dispatch({
      kind: "request", protocol: { major: 3, minor: 0 }, requestId: "cold-setup-fixture",
      authority, fence: { hostGeneration: "fixture-host", driverGeneration: "fixture-driver", cancellationGeneration: 0 },
      ...admitted,
    });
    const projected = JSON.parse(projectSemanticComputerResult("computer_browser_prepare", JSON.stringify(raw))) as unknown;
    expect(projected).toMatchObject({
      version: 1, ok: false, settlement: "not_completed",
      result: {
        status: "recovery_required", recovery: "use_native_window", doNotReplay: true,
        failure: { reason: "setup_control_ambiguous", stage: "prepare", stateChangeCertainty: "not_changed",
          retryCondition: "route_or_provider_change" },
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/AXButton|New Tab|private-driver-context|1234|5678|schemaDigest|fixture-authority/);
    // This exact selector refusal precedes every setup effect, so it does not
    // need a retained session. Changed/unknown failures are tested separately.
    expect(calls).toEqual(["start_session", "browser_prepare", "end_session"]);
    await runtime.close();
    expect(calls).toEqual(["start_session", "browser_prepare", "end_session"]);
  });
});
