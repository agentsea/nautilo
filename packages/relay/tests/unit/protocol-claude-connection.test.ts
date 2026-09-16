import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CONNECTION_MAX_FRAME_BYTES,
  CLAUDE_CONNECTION_PROTOCOL_VERSION,
  parseRelayClaudeConnectionDiscoverCommand,
  parseRelayClaudeConnectionDiscoveryResult,
} from "../../src/index";

const correlationId = "6d141ab4-8ccc-4b69-9e81-75068454f013";
const profileRef = "719f18c6-a3a9-4b8e-994a-9fa36136552e";
const scope = {
  relayId: "relay-1",
  relaySessionId: "relay-session-1",
  desktopSessionId: "desktop-session-1",
  pairingGenerationRef: "pairing-1",
  selectedProtocolVersion: CLAUDE_CONNECTION_PROTOCOL_VERSION,
  capabilityRevision: 0,
} as const;

const command = {
  type: "relay:claude-connection-discover",
  version: CLAUDE_CONNECTION_PROTOCOL_VERSION,
  correlationId,
  scope,
  profileRef,
} as const;

const result = {
  type: "relay:claude-connection-discovery-result",
  version: CLAUDE_CONNECTION_PROTOCOL_VERSION,
  correlationId,
  scope,
  profileRef,
  runtime: { state: "ready", version: "2.1.235", executionQualified: true },
  account: { state: "connected", apiProvider: "firstParty", email: "writer@example.test" },
  catalog: {
    state: "complete",
    complete: true,
    models: [{
      id: "claude-fable-5",
      resolvedModel: "claude-fable-5-20260815",
      displayName: "Fable 5",
      description: "Frontier model",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsEffort: true,
      supportsAdaptiveThinking: true,
      supportsFastMode: false,
      supportsAutoMode: true,
    }],
  },
} as const;

describe("D452 Claude Connections v17 protocol", () => {
  test("accepts the exact v17 discovery command and fully scoped result", () => {
    expect(parseRelayClaudeConnectionDiscoverCommand(command)).toEqual(command);
    expect(parseRelayClaudeConnectionDiscoveryResult(result)).toEqual(result);
  });

  test("requires exact protocol and registered-scope bounds on both directions", () => {
    expect(parseRelayClaudeConnectionDiscoverCommand({ ...command, version: 16 })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoverCommand({ ...command, correlationId: "request-1" })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoverCommand({ ...command, profileRef: "profile-1" })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoverCommand({ ...command, scope: { ...scope, selectedProtocolVersion: 16 } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, scope: { ...scope, capabilityRevision: -1 } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, scope: { ...scope, capabilityRevision: 0.5 } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, scope: { ...scope, relayId: "relay\nsmuggle" } })).toBeNull();
  });

  test("keeps runtime, account, and catalog independently truthful", () => {
    expect(parseRelayClaudeConnectionDiscoveryResult({
      ...result,
      runtime: { state: "unavailable" },
      account: { state: "disconnected" },
      catalog: { state: "unavailable", complete: false, models: [] },
    })).not.toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, account: { state: "connected" } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, runtime: { state: "ready" } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, runtime: { state: "ready", version: "2.1.39", executionQualified: false } })).not.toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, catalog: { state: "incomplete", complete: true, models: [] } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, catalog: { state: "unavailable", complete: false, models: [result.catalog.models[0]] } })).toBeNull();
  });

  test("retains supported capability booleans and rejects default/exhaustive claims", () => {
    expect(parseRelayClaudeConnectionDiscoveryResult(result)?.catalog.models[0]).toEqual(result.catalog.models[0]);
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, catalog: { ...result.catalog, defaultModel: "claude-fable-5" } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, catalog: { ...result.catalog, exhaustive: true } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, catalog: { ...result.catalog, models: [{ ...result.catalog.models[0], supportsEffort: "yes" }] } })).toBeNull();
  });

  test("rejects smuggled private fields and malformed control text", () => {
    expect(parseRelayClaudeConnectionDiscoverCommand({ ...command, taskId: "task-private" })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, sessionId: "private-session" })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, catalog: { ...result.catalog, models: [{ ...result.catalog.models[0], path: "/private" }] } })).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, account: { ...result.account, email: "writer\u0000@example.test" } })).toBeNull();
  });

  test("uses an aggregate UTF-8 guard and safely rejects unserializable frames", () => {
    const largeModel = {
      id: "i".repeat(320),
      resolvedModel: "r".repeat(320),
      displayName: "d".repeat(320),
      description: "x".repeat(320),
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsEffort: true,
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    } as const;
    const oversized = { ...result, catalog: { state: "complete", complete: true, models: Array.from({ length: 12 }, () => largeModel) } };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(CLAUDE_CONNECTION_MAX_FRAME_BYTES);
    expect(parseRelayClaudeConnectionDiscoveryResult(oversized)).toBeNull();
    expect(parseRelayClaudeConnectionDiscoveryResult({ ...result, broken: BigInt(1) })).toBeNull();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(parseRelayClaudeConnectionDiscoveryResult(cyclic)).toBeNull();
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error("untrusted getter"); } });
    expect(parseRelayClaudeConnectionDiscoveryResult(hostile)).toBeNull();
  });

  test("admits every provider model when the complete catalogue fits the wire frame", () => {
    const models = Array.from({ length: 13 }, (_, index) => ({
      id: `claude-${index}`,
      displayName: `Claude ${index}`,
      description: "Available model",
    }));
    expect(parseRelayClaudeConnectionDiscoveryResult({
      ...result,
      catalog: { state: "complete", complete: true, models },
    })?.catalog.models).toHaveLength(13);
  });
});
