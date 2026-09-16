import { describe, expect, test } from "bun:test";
import {
  handleRelayClaudeConnectionDiscoveryResult,
  parseRelayEndpointClientMessage,
  publishClaudeConnectionContextAfterAck,
} from "../../src/realtime/relay-endpoint";

const result = {
  type: "relay:claude-connection-discovery-result",
  version: 17,
  correlationId: "6d141ab4-8ccc-4b69-9e81-75068454f013",
  scope: { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 17, capabilityRevision: 0 },
  profileRef: "719f18c6-a3a9-4b8e-994a-9fa36136552e",
  runtime: { state: "ready", version: "2.1.235", executionQualified: true },
  account: { state: "connected", apiProvider: "firstParty" },
  catalog: { state: "unavailable", complete: false, models: [] },
} as const;

describe("D452 relay endpoint Claude Connections frames", () => {
  test("admits only a bounded strict v17 result before endpoint ownership fencing", () => {
    expect(parseRelayEndpointClientMessage(JSON.stringify(result))).toMatchObject({ ok: true, message: result });
    expect(parseRelayEndpointClientMessage(JSON.stringify({ ...result, sessionId: "private" }))).toEqual({ ok: false, codex: false, error: "CLAUDE_CONNECTION_FRAME_INVALID" });
    expect(parseRelayEndpointClientMessage(JSON.stringify({ ...result, catalog: { state: "unavailable", complete: false, models: [{ id: "stale", displayName: "stale", description: "stale" }] } }))).toEqual({ ok: false, codex: false, error: "CLAUDE_CONNECTION_FRAME_INVALID" });
    expect(parseRelayEndpointClientMessage(JSON.stringify({ ...result, catalog: { ...result.catalog, padding: "😀".repeat(20_000) } }))).toEqual({ ok: false, codex: false, error: "CLAUDE_CONNECTION_FRAME_TOO_LARGE" });
  });

  test("routes a result only from the acknowledged current v17 socket", () => {
    const received: unknown[] = [];
    const registry = {
      acceptClaudeConnectionDiscoveryResult: (input: unknown) => {
        received.push(input);
        return { ok: true as const };
      },
    };
    expect(handleRelayClaudeConnectionDiscoveryResult({
      registeredRelayId: "relay-1", registeredUserId: "owner-1", registeredProtocolVersion: 17,
      currentSocket: true, message: result, registry,
    })).toEqual({ ok: true });
    expect(received).toEqual([{ relayId: "relay-1", userId: "owner-1", message: result }]);
    expect(handleRelayClaudeConnectionDiscoveryResult({
      registeredRelayId: "relay-1", registeredUserId: "owner-1", registeredProtocolVersion: 17,
      currentSocket: false, message: result, registry,
    })).toEqual({ ok: false, error: "CLAUDE_CONNECTION_UNAVAILABLE" });
    expect(handleRelayClaudeConnectionDiscoveryResult({
      registeredRelayId: "relay-1", registeredUserId: "owner-1", registeredProtocolVersion: 16,
      currentSocket: true, message: result, registry,
    })).toEqual({ ok: false, error: "CLAUDE_CONNECTION_UNAVAILABLE" });
    expect(received).toHaveLength(1);
  });

  test("publishes a new discovery context only after the ack owns an open socket", () => {
    const publications: Array<[string, string]> = [];
    const registry = {
      publishClaudeConnectionContext: (relayId: string, userId: string) => {
        publications.push([relayId, userId]);
        return true;
      },
    };
    for (const input of [
      { acknowledged: false, socketOpen: true, currentSocket: true },
      { acknowledged: true, socketOpen: false, currentSocket: true },
      { acknowledged: true, socketOpen: true, currentSocket: false },
    ]) {
      expect(publishClaudeConnectionContextAfterAck({ ...input, relayId: "relay-1", userId: "owner-1", registry })).toBe(false);
    }
    expect(publications).toEqual([]);
    expect(publishClaudeConnectionContextAfterAck({
      acknowledged: true, socketOpen: true, currentSocket: true,
      relayId: "relay-1", userId: "owner-1", registry,
    })).toBe(true);
    expect(publications).toEqual([["relay-1", "owner-1"]]);
  });
});
