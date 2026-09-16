import { describe, expect, test } from "bun:test";
import { parseDesktopAutomationRouteBinding } from "@nautilo/types";
import {
  deriveComputerUseInvocationId,
  parseComputerUseInvocationBinding,
} from "../../src/runtime/computer-use-admission";

const binding = {
  version: 12, computerUseContextId: "context-1", computerUseInvocationId: "computer-invocation:fixture-1",
  relayId: "relay-1", pairingGeneration: "pairing-1", desktopSessionId: "session-1",
  originHumanId: "human-1", originRunId: "run-1", originAgentId: "agent-1", lineageId: "lineage-1",
  installationEpoch: "epoch-1", grantGeneration: 1, provider: "cua", providerGeneration: "provider-1",
} as const;

describe("generic Computer Use authority", () => {
  test("accepts the opaque route and binding without a compiled action list", () => {
    expect(parseDesktopAutomationRouteBinding({ version: 2, provider: "cua", providerGeneration: "provider-1", grantGeneration: 1 })).toEqual({ version: 2, provider: "cua", providerGeneration: "provider-1", grantGeneration: 1 });
    expect(parseComputerUseInvocationBinding(binding)).toEqual(binding);
  });
  test("derives request identity from the signed-catalogue tool request", () => {
    expect(deriveComputerUseInvocationId("context-1", { id: "call-1", name: "computer_observe", args: { operation: "desktop_state" } })).toMatch(/^computer-invocation:/);
  });
});
