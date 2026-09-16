import { describe, expect, test } from "bun:test";
import { ACP_RELAY_READINESS_MAX_FRAME_BYTES } from "@nautilo/relay";
import { parseRelayEndpointClientMessage } from "../../src/realtime/relay-endpoint";

describe("D452 relay endpoint ACP v13 parsing", () => {
  test("accepts only the dedicated safe readiness-result envelope", () => {
    const raw = JSON.stringify({
      type: "relay:acp-readiness-result", requestId: "request-1", registrationId: "hermes-acp", state: "missing",
      scope: {
        relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
        pairingGenerationRef: "pair-1", selectedProtocolVersion: 13, capabilityRevision: 0,
      },
    });
    expect(parseRelayEndpointClientMessage(raw).ok).toBe(true);
  });

  test("rejects raw host evidence and classifies the result as an ACP protocol failure", () => {
    const raw = JSON.stringify({
      type: "relay:acp-readiness-result", requestId: "request-1", registrationId: "hermes-acp", state: "ready",
      executablePath: "/Users/private/.hermes", versionOutput: "credential-like",
      scope: {
        relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
        pairingGenerationRef: "pair-1", selectedProtocolVersion: 13, capabilityRevision: 0,
      },
    });
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false, codex: false, error: "ACP_FRAME_INVALID",
    });
  });

  test("rejects an oversized readiness frame before parsing at the preserved v13 cap", () => {
    const raw = `{"type":"relay:acp-readiness-result","padding":"${"x".repeat(ACP_RELAY_READINESS_MAX_FRAME_BYTES)}"}`;
    expect(parseRelayEndpointClientMessage(raw)).toEqual({ ok: false, codex: false, error: "ACP_FRAME_TOO_LARGE" });
  });
});
