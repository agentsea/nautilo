import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { modelOutputPreflightNode } from "../../src/nodes/model-output-preflight";
import { shouldContinue } from "../../src/agent/graph";
import { NoProgressError } from "../../src/graph/no-progress";
import { resolveGraphExecutionPolicy } from "../../src/graph/execution-policy";
import type { NautiloState } from "../../src/agent/state";

function malformed(valid = false): AIMessage {
  return new AIMessage({ content: "", id: "response",
    additional_kwargs: { tool_calls: [{ id: "broken", type: "function", function: { name: "security_scan", arguments: 'sensitive malformed raw input' } }] },
    tool_calls: valid ? [{ id: "valid", name: "file", args: { command: "read", path: "src/api.ts" }, type: "tool_call" }] : [],
    invalid_tool_calls: [{ id: "broken", name: "security_scan", args: '{"fileCitations":[]]{"startLine":1}]', error: "Malformed args.", type: "invalid_tool_call" }],
  });
}
function state(message = malformed()): NautiloState {
  return { messages: [message], approvedToolCalls: [], awaitResponse: false } as unknown as NautiloState;
}

describe("provider malformed-call recovery", () => {
  test("pairs a non-executable repair receipt instead of empty-response termination", () => {
    const s = state(); const update = modelOutputPreflightNode(s);
    const next = { ...s, ...update };
    expect(shouldContinue(next)).toBe("pre_model");
    expect(update.modelRejectedToolCallIds).toEqual(["broken"]);
    const assistant = update.messages![0] as AIMessage;
    expect(assistant.invalid_tool_calls).toEqual([]);
    expect(assistant.additional_kwargs.tool_calls).toBeUndefined();
    expect(assistant.tool_calls![0]!.args).toEqual({});
    expect(update.messages![1]).toBeInstanceOf(ToolMessage);
    expect(update.messages![1]!.content).toContain("MALFORMED_TOOL_ARGUMENTS");
    expect(JSON.stringify(update)).not.toContain("sensitive malformed raw input");
  });
  test("retains valid siblings for ordinary approval and counts mixed rounds only at tools", () => {
    const update = modelOutputPreflightNode(state(malformed(true)));
    expect((update.messages![0] as AIMessage).tool_calls!.map((c) => c.id)).toEqual(["valid", "broken"]);
    expect(update.noProgressStreaks).toBeUndefined();
    expect(shouldContinue({ ...state(), ...update, approvedToolCalls: [{ id: "valid", name: "file", args: {} }] })).toBe("tools");
  });
  test("repeated invalid-only output reaches the canonical corrective turn and no-progress error", () => {
    let s = state();
    for (let i = 0; i < resolveGraphExecutionPolicy().repeatedFailureLimit; i++) {
      s = { ...s, ...modelOutputPreflightNode(s), messages: [malformed()] };
    }
    expect(s.noProgressPendingCorrection).toBeDefined();
    expect(() => modelOutputPreflightNode(s)).toThrow(NoProgressError);
  });
  test("a new valid response clears rejection state", () => {
    expect(modelOutputPreflightNode({ ...state(new AIMessage("Done")), modelRejectedToolCallIds: ["old"] })).toEqual({ modelRejectedToolCallIds: [], researchContinuationRequired: false });
  });
});

describe("requested security Task completion", () => {
  const researching = () => ({ ...state(new AIMessage("I will stop after the first section.")), taskRun: true, toolWhitelist: ["security_scan", "file"] });
  test("continues the same Task without changing its authority or requiring a Human reply", () => {
    const s = { ...researching(), relaySessionId: "original-relay" };
    const update = modelOutputPreflightNode(s);
    expect(update.researchContinuationRequired).toBe(true);
    expect(update.messages!.at(-1)!.content).toContain("same authorized Task");
    expect(shouldContinue({ ...s, ...update })).toBe("pre_model");
    expect(update).not.toHaveProperty("relaySessionId");
    expect(update).not.toHaveProperty("taskRun");
    expect(update).not.toHaveProperty("approvedToolCalls");
  });
  test("leaves ordinary chat and other Tasks alone", () => {
    expect(modelOutputPreflightNode({ ...researching(), taskRun: false }).researchContinuationRequired).toBe(false);
    expect(modelOutputPreflightNode({ ...researching(), toolWhitelist: ["file"] }).researchContinuationRequired).toBe(false);
  });
  test("uses canonical no-progress recovery, resetting after actual successful tool work", () => {
    let s: NautiloState = researching();
    for (let i = 0; i < resolveGraphExecutionPolicy().repeatedFailureLimit; i++) {
      s = { ...s, ...modelOutputPreflightNode(s), messages: researching().messages };
    }
    expect(() => modelOutputPreflightNode(s)).toThrow(NoProgressError);
    const progress = new ToolMessage({ name: "file", tool_call_id: "read", content: "source", additional_kwargs: { nautilo_tool_status: "success" } });
    expect(modelOutputPreflightNode({ ...s, messages: [progress, ...researching().messages] }).researchContinuationRequired).toBe(true);
  });
});

test("an explicit canonical Human-reply wait is preserved", () => {
  const s = { ...state(new AIMessage("The external input is required.")), taskRun: true, toolWhitelist: ["security_scan"], awaitResponse: true };
  const update = modelOutputPreflightNode(s);
  expect(update.researchContinuationRequired).toBe(false);
  expect(shouldContinue({ ...s, ...update })).toBe("await_reply");
});

test("successful JSON repair clears the malformed-call streak despite a now-known operation", () => {
  let s: NautiloState = state();
  for (let i = 0; i < resolveGraphExecutionPolicy().repeatedFailureLimit + 2; i++) {
    s = { ...s, ...modelOutputPreflightNode({ ...s, messages: [malformed()] }) };
    s.messages = [...s.messages, new AIMessage({ content: "", tool_calls: [{ id: `fixed-${i}`, name: "security_scan", args: { operation: "record" } }] })];
    s = { ...s, ...modelOutputPreflightNode(s) };
    expect(s.noProgressStreaks?.size).toBe(0);
  }
});
