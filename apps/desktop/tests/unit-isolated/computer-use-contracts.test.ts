import { describe, expect, test } from "bun:test";
import { DESKTOP_AUTOMATION_RECEIPT_VERSION, parseDesktopAutomationReceipt } from "../../electron/computer-use/contracts.ts";

const receipt = {
  version: DESKTOP_AUTOMATION_RECEIPT_VERSION,
  installationEpoch: "computer-use-epoch-aaaaaaaaaaaaaaaa",
  instanceId: "",
  humanUserId: "human-1",
  agentId: "agent-1",
  serverBindingId: "server-binding-aaaaaaaaaaaaaaaa",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  grantGeneration: 1,
  issuedAt: "2026-08-11T12:00:00.000Z",
};

describe("Cua-only local Computer Use contracts", () => {
  test("accepts only the non-secret durable receipt schema", () => {
    expect(parseDesktopAutomationReceipt(receipt)).toEqual(receipt);
    for (const invalid of [{ ...receipt, desktopSessionId: "per-launch" }, { ...receipt, pin: "never-store" }, { ...receipt, grantGeneration: 0 }, { ...receipt, version: 2 }]) {
      expect(parseDesktopAutomationReceipt(invalid)).toBeNull();
    }
  });
});
