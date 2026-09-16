import { describe, expect, test } from "bun:test";
import { CODEX_RELAY_MAX_FRAME_BYTES } from "@nautilo/relay";
import { parseRelayEndpointClientMessage } from "../../src/realtime/relay-endpoint";

describe("D453 relay endpoint v8 parsing", () => {
  test("accepts only the strict dedicated status shape", () => {
    const raw = JSON.stringify({
      type: "relay:codex-status",
      socket: {
        relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
        pairingGenerationRef: "pair-ref-1", selectedProtocolVersion: 8,
      },
      capabilityRevision: 0,
      status: { state: "workspace_unavailable", workspace: { state: "unavailable" } },
    });
    expect(parseRelayEndpointClientMessage(raw).ok).toBe(true);
  });

  test("rejects user-id smuggling and classifies it as a Codex protocol failure", () => {
    const raw = JSON.stringify({
      type: "relay:codex-status", userId: "spoofed-owner",
      socket: {
        relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
        pairingGenerationRef: "pair-ref-1", selectedProtocolVersion: 8,
      },
      capabilityRevision: 0,
      status: { state: "workspace_unavailable", workspace: { state: "unavailable" } },
    });
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false, codex: true, error: "CODEX_FRAME_INVALID",
    });
  });

  test("does not let an escaped discriminator key fall through the generic parser", () => {
    const raw = `{"\\u0074ype":"relay:codex-status"}`;
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false, codex: true, error: "CODEX_FRAME_INVALID",
    });
  });

  test("finds escaped discriminator values after bounded nested fields and whitespace", () => {
    const raw = ` { "metadata" : {"nested":[1,{"ok":true}]}, "\\u0074ype" : "relay:codex-\\u0073tatus" } `;
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false, codex: true, error: "CODEX_FRAME_INVALID",
    });
  });

  test("rejects adversarial depth before JSON.parse", () => {
    const raw = `{"metadata":${"[".repeat(80)}0${"]".repeat(80)},"type":"relay:codex-status"}`;
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false, codex: true, error: "CODEX_FRAME_INVALID",
    });
  });

  test("preserves generic key-order behavior beyond the Codex ceiling", () => {
    const raw = JSON.stringify({
      padding: "x".repeat(CODEX_RELAY_MAX_FRAME_BYTES + 1),
      type: "relay:heartbeat",
      relayId: "relay-1",
    });
    const parsed = parseRelayEndpointClientMessage(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message.type).toBe("relay:heartbeat");
  });
});
