import { describe, expect, test } from "bun:test";
import { parseRelayBolterServerMessage, parseRelayBolterDesktopMessage } from "../../src/bolter-protocol";
import { projectRelayCapabilitiesForProtocol } from "../../src/protocol";
const scope = { relayId: "relay", relaySessionId: "socket", desktopSessionId: "desktop", pairingGenerationRef: "pair", selectedProtocolVersion: 30, capabilityRevision: 0 };
const command = { type: "relay:bolter-command", version: 30, scope, correlationId: "719f18c6-a3a9-4b8e-994a-9fa36136552e",
  command: { action: "check", connectionId: "a51f18c6-a3a9-4b8e-994a-9fa36136552e", generation: 1 } };
describe("finite Bolter wire", () => {
  test("rejects authority smuggling, arbitrary commands and wrong direction", () => {
    expect(parseRelayBolterServerMessage(command)).not.toBeNull();
    expect(parseRelayBolterDesktopMessage(command)).toBeNull();
    for (const value of [
      { ...command, userId: "foreign" },
      { ...command, scope: { ...scope, userId: "foreign" } },
      { ...command, scope: { ...scope, selectedProtocolVersion: 29 } },
      { ...command, command: { ...command.command, shell: "arbitrary" } },
      { ...command, command: { action: "exec", argv: [] } },
    ]) expect(parseRelayBolterServerMessage(value)).toBeNull();
  });
  test("rejects unqualified listening and foreign auth links", () => {
    const result = { type: "relay:bolter-result", version: 30, scope, correlationId: command.correlationId };
    expect(parseRelayBolterDesktopMessage({ ...result, result: { kind: "auth_pending", auth: { url: "https://bolter.chat/approve", code: "test" } } })).not.toBeNull();
    expect(parseRelayBolterDesktopMessage({ ...result, result: { kind: "auth_pending", auth: { url: "https://foreign.invalid/approve", code: "test" } } })).toBeNull();
    expect(parseRelayBolterDesktopMessage({ ...result, result: { kind: "observation", observation: {
      runtime: "qualification_required", authentication: "unknown", identity: null, receiver: "listening",
    } } })).toBeNull();
  });
  test("omits capability on old and headless peers", () => {
    const capability = { version: 1 as const, hostKind: "electron" as const };
    expect(projectRelayCapabilitiesForProtocol({ profile: "desktop-agent", bolter: capability }, 29).bolter).toBeUndefined();
    expect(projectRelayCapabilitiesForProtocol({ profile: "desktop-agent", bolter: capability }, 30).bolter).toEqual(capability);
    expect(projectRelayCapabilitiesForProtocol({ profile: "headless", bolter: capability } as never, 30).bolter).toBeUndefined();
  });
});

test("file bytes require the new negotiated peer and reject metadata or path overrides", () => {
  const file = { id: "10000000-0000-4000-8000-000000000001", filename: "brief.txt", mimeType: "text/plain", sizeBytes: 0, sha256: "a".repeat(64), base64: "" };
  const frame = { type: "relay:bolter-authorized", version: 30, scope: { ...scope, selectedProtocolVersion: 31 },
    correlationId: command.correlationId, outboxId: command.command.connectionId,
    content: { chatId: "fixture-chat", threadRootId: null, content: "Fixture text", files: [file] } };
  expect(parseRelayBolterServerMessage(frame)).not.toBeNull();
  expect(parseRelayBolterServerMessage({ ...frame, scope })).toBeNull();
  expect(parseRelayBolterServerMessage({ ...frame, content: { ...frame.content, files: [{ ...file, storageUri: "file:///path/to/foreign" }] } })).toBeNull();
});
