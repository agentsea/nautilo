import { describe, expect, test } from "bun:test";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import { projectToolResultForEvent, TOOL_RESULT_MAX_BYTES } from "@nautilo/types";
import { projectSemanticComputerResult } from "@nautilo/agent";
import { getToolRenderer } from "./index";
import { parseComputerUseResult, preserveComputerUseResultForCard } from "./computer-use";

const projected = JSON.stringify({
  version: 1,
  ok: true,
  settlement: "completed",
  presentation: { label: "Observe desktop", summary: "One window observed." },
  // Deliberately hostile/private-looking bytes: the renderer must not parse
  // this structural result body.
  result: { privateTarget: "dtgt_secret", provider: "cua", fence: "private" },
});

describe("catalogue-projected Computer Use card", () => {
  test("renders any catalogue tool name through one sealed generic renderer", () => {
    expect(getToolRenderer("computer_future_signed_contract")).toBeDefined();
    expect(getToolRenderer("computer_future_signed_contract")?.displayName).toBe("Computer Use");
  });

  test("keeps only the compact presentation DTO", () => {
    expect(parseComputerUseResult(projected)).toEqual({
      label: "Observe desktop", summary: "One window observed.", settlement: "completed", ok: true,
    });
    expect(preserveComputerUseResultForCard("computer_future_signed_contract", projected)).toBe(projected);
  });

  test("rejects unprojected, widened, or private result envelopes", () => {
    expect(parseComputerUseResult(JSON.stringify({ version: 1, ok: true, settlement: "completed", result: {} }))).toBeNull();
    expect(parseComputerUseResult(JSON.stringify({ version: 1, ok: true, settlement: "completed", presentation: { label: "x", summary: "y", provider: "cua" } }))).toBeNull();
    expect(preserveComputerUseResultForCard("run_shell", projected)).toBeUndefined();
    expect(parseComputerUseResult(projected.replace('"settlement":"completed"', '"settlement":"invented"'))).toBeNull();
    expect(parseComputerUseResult(projected.replace('"ok":true', '"ok":false'))).toBeNull();
    expect(parseComputerUseResult(projected.replace('"settlement":"completed"', '"settlement":"failed"'))).toBeNull();
  });

  test("does not fabricate a blocked execution state when presentation is unavailable", () => {
    const renderer = getToolRenderer("computer_observe");
    expect(renderer?.stateOverride?.({
      args: {}, resultText: JSON.stringify({ version: 1, ok: true, settlement: "completed", result: {} }),
      resultTruncated: false, state: "success", toolName: "computer_observe",
    })).toBeNull();
    expect(renderer?.stateOverride?.({
      args: {}, resultText: projected.replace('"ok":true', '"ok":false').replace('"completed"', '"not_completed"'),
      resultTruncated: false, state: "success", toolName: "computer_observe",
    })).toBe("blocked");
    expect(renderer?.stateOverride?.({
      args: {}, resultText: projected.replace('"ok":true', '"ok":false').replace('"completed"', '"failed"'),
      resultTruncated: false, state: "success", toolName: "computer_observe",
    })).toBe("error");
  });

  test("keeps the sealed presentation for an oversized current flat desktop-state result", () => {
    const context = `dctx_${"a".repeat(43)}`;
    const targets = Array.from({ length: 100 }, (_, index) => ({
      target: { version: 1, context, reference: `dtgt_${String(index).padStart(3, "0")}${"b".repeat(40)}` },
      evidence: {
        kind: "window", appLabel: `Application ${index}`,
        windowLabel: `Window ${index} ${"x".repeat(120)}`,
        bounds: { x: index, y: index, width: 800, height: 600 },
      },
    }));
    const semantic = projectSemanticComputerResult("computer_observe", JSON.stringify({
      kind: "result", protocol: { major: 3, minor: 0 }, requestId: "request-large-observe",
      fence: { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 0 },
      contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      settlement: "completed",
      result: {
        version: 1, operation: "desktop_state", context, completeness: "complete",
        discovered: 100, returned: 100, omitted: 0,
        boundary: { kind: "none", retryable: false }, uninspected: null, continuation: null,
        alternatives: [{ kind: "observe_again", available: true }], targets,
        applicationTargets: { discovered: 0, returned: 0, omitted: 0, targets: [] },
        outcome: {
          version: 1, phase: "observe", retrySafety: "safe", stateChangeCertainty: "not_applicable",
          providerCondition: "ready", targetCondition: "current", recovery: ["retry_same_request"],
        },
      },
    }));
    expect(new TextEncoder().encode(semantic).byteLength).toBeGreaterThan(TOOL_RESULT_MAX_BYTES);
    const event = projectToolResultForEvent("computer_observe", semantic);
    expect(event.truncated).toBe(true);
    expect(parseComputerUseResult(event.result)).toMatchObject({ ok: true, settlement: "completed" });
    expect(JSON.parse(event.result)).toMatchObject({
      eventProjection: { kind: "computer_use", resultOmitted: true },
    });
  });
});
