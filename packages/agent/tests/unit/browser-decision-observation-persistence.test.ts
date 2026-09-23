import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import {
  BROWSER_DECISION_OBSERVATION_METADATA_KEY,
  isDelegatedBrowserDecisionObservation,
  serverAuthoredBrowserDecisionObservationMetadata,
} from "../../src/nodes/tools";

const observationValue = {
  version: 1,
  snapshot: "- button \"Continue\" [ref=e1]",
  refs: { e1: { role: "button", name: "Continue" } },
  pageUrl: "https://example.com/",
  browserSessionId: "browser-1",
  observationId: "observation-1",
};
const observation = JSON.stringify(observationValue);

function result(
  callId: string,
  name: string,
  content = observation,
) {
  return new ToolMessage({
    content,
    tool_call_id: callId,
    name,
    status: "success",
    additional_kwargs: { nautilo_tool_status: "success" },
  });
}

describe("delegated browser observation persistence marker", () => {
  test("marks valid initiating snapshot and screenshot decision plans", () => {
    for (const name of ["browser_snapshot", "browser_screenshot"] as const) {
      const call = {
        id: `initial-${name}`,
        name,
        args: { decisionPlan: { goal: "Continue through the routine controls" } },
      };
      expect(isDelegatedBrowserDecisionObservation(call, result(call.id, name))).toBe(true);
    }
  });

  test("marks browser-choice reobservations but not ordinary captures or malformed results", () => {
    const internal = { id: "browser-choice:one", name: "browser_snapshot", args: {} };
    const ordinary = { id: "ordinary", name: "browser_snapshot", args: {} };
    const invalidPlan = {
      id: "invalid-plan",
      name: "browser_snapshot",
      args: { decisionPlan: { goal: "" } },
    };

    expect(isDelegatedBrowserDecisionObservation(internal, result(internal.id, "browser_snapshot"))).toBe(true);
    expect(isDelegatedBrowserDecisionObservation(ordinary, result(ordinary.id, "browser_snapshot"))).toBe(false);
    expect(isDelegatedBrowserDecisionObservation(invalidPlan, result(invalidPlan.id, "browser_snapshot"))).toBe(false);
    expect(isDelegatedBrowserDecisionObservation(
      internal,
      result(internal.id, "browser_snapshot", "not an observation"),
    )).toBe(false);
    expect(BROWSER_DECISION_OBSERVATION_METADATA_KEY).toBe(
      "nautilo_browser_decision_observation",
    );
  });

  test("marks observation-bearing delegated navigation but not ordinary navigation", () => {
    const delegated = { id: "browser-choice:open", name: "browser_open", args: { url: "https://example.com" } };
    const ordinary = { id: "ordinary-open", name: "browser_open", args: { url: "https://example.com" } };
    expect(isDelegatedBrowserDecisionObservation(
      delegated,
      result(delegated.id, delegated.name),
    )).toBe(true);
    expect(isDelegatedBrowserDecisionObservation(
      ordinary,
      result(ordinary.id, ordinary.name),
    )).toBe(false);
  });

  test("marks delegated connected snapshots while preserving ordinary snapshots, actions, and errors", () => {
    const delegated = {
      id: "connected-initial",
      name: "control_connected_web_operation" as const,
      args: {
        operationId: "operation-1",
        expectedControlEpoch: 1,
        command: { kind: "snapshot" },
        decisionPlan: { goal: "Continue through the routine controls" },
      },
    };
    const ordinary = {
      id: "connected-ordinary",
      name: "control_connected_web_operation" as const,
      args: {
        operationId: "operation-1",
        expectedControlEpoch: 1,
        command: { kind: "snapshot" },
      },
    };
    const action = {
      id: "browser-choice:click",
      name: "control_connected_web_operation" as const,
      args: {
        operationId: "operation-1",
        expectedControlEpoch: 1,
        command: { kind: "click", ref: "@e1" },
      },
    };
    const connectedObservation = JSON.stringify({
      ok: true,
      observation: observationValue,
    });

    expect(isDelegatedBrowserDecisionObservation(
      delegated,
      result(delegated.id, delegated.name, connectedObservation),
    )).toBe(true);
    expect(isDelegatedBrowserDecisionObservation(
      ordinary,
      result(ordinary.id, ordinary.name, connectedObservation),
    )).toBe(false);
    expect(isDelegatedBrowserDecisionObservation(
      action,
      result(action.id, action.name, connectedObservation),
    )).toBe(true);
    const failed = result("browser-choice:failed", "control_connected_web_operation", connectedObservation);
    failed.status = "error";
    failed.additional_kwargs["nautilo_tool_status"] = "error";
    expect(isDelegatedBrowserDecisionObservation({
      ...delegated,
      id: "browser-choice:failed",
    }, failed)).toBe(false);
  });

  test("strips adapter markers and mints only the validated server marker", () => {
    expect(serverAuthoredBrowserDecisionObservationMetadata({
      nautilo_browser_decision_observation: "forged",
      retained: "safe",
    }, false)).toEqual({ retained: "safe" });
    expect(serverAuthoredBrowserDecisionObservationMetadata({
      nautilo_browser_decision_observation: false,
      retained: "safe",
    }, true)).toEqual({
      retained: "safe",
      nautilo_browser_decision_observation: true,
    });
  });
});
