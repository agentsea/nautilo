import { describe, expect, test } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION,
  RELAY_MCP_DISPATCH_PROVENANCE_PROTOCOL_VERSION,
  RELAY_MCP_TRUTH_PROTOCOL_VERSION,
  RELAY_MCP_TRUTH_MAX_FRAME_BYTES,
  isRelayMcpConfigureResultMessage,
  isRelayMcpPreflightResultMessage,
  type RelayClientMessage,
  type RelayMcpConfigureResultMessage,
  type RelayMcpPreflightResultMessage,
  type RelayServerMessage,
  type RelayConfigureMcpMessage,
  type RelayAdvertiseMcpToolsMessage,
  type RelayDispatchMessage,
} from "../../src/protocol";

describe("relay protocol v3+ — MCP hosting (D384 Phase 5 Slice A)", () => {
  test("current Relay protocol is v19", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(20);
    expect(RELAY_MCP_TRUTH_PROTOCOL_VERSION).toBe(12);
    expect(RELAY_MCP_DISPATCH_PROVENANCE_PROTOCOL_VERSION).toBe(19);
    expect(RELAY_MCP_TRUTH_MAX_FRAME_BYTES).toBe(32 * 1024);
  });

  test("v19 hosted MCP dispatch carries exact Relay provenance without a tool union", () => {
    const message: RelayServerMessage = {
      type: "relay:dispatch",
      correlationId: "corr-mcp-v19",
      toolName: "future_runtime_tool",
      args: { query: "docs" },
      impact: "read-only",
      approvalObtained: true,
      hostedBy: "relay-1",
    } satisfies RelayDispatchMessage;

    expect(message.hostedBy).toBe("relay-1");
    expect(message.toolName).toBe("future_runtime_tool");
  });

  test("relay:configure-mcp is a valid server→relay message (additive)", () => {
    const msg: RelayServerMessage = {
      type: "relay:configure-mcp",
      servers: [
        {
          name: "context7",
          transportKind: "stdio",
          transport: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
          envPassthrough: ["CONTEXT7_API_KEY"],
          namespaceId: null,
        },
      ],
    } satisfies RelayConfigureMcpMessage;
    expect(msg.type).toBe("relay:configure-mcp");
    expect(msg.servers[0]?.name).toBe("context7");
    // envPassthrough carries NAMES only — no secret values on the wire.
    expect(msg.servers[0]?.envPassthrough).toEqual(["CONTEXT7_API_KEY"]);
  });

  test("relay:advertise-mcp-tools is a valid relay→server message (additive)", () => {
    const msg: RelayClientMessage = {
      type: "relay:advertise-mcp-tools",
      serverName: "context7",
      tools: [
        { name: "get-library-docs", description: "docs", inputSchema: { type: "object" } },
      ],
    } satisfies RelayAdvertiseMcpToolsMessage;
    expect(msg.type).toBe("relay:advertise-mcp-tools");
    expect(msg.tools).toHaveLength(1);
  });

  test("existing hot-path messages still fit the unions (heartbeat unchanged)", () => {
    const hb: RelayClientMessage = { type: "relay:heartbeat", relayId: "r1" };
    expect(hb.type).toBe("relay:heartbeat");
  });

  test("v12 MCP preflight result carries only names and presence booleans", () => {
    const result: RelayClientMessage = {
      type: "relay:mcp-preflight-result",
      requestId: "request-1",
      digest: "digest-1",
      targetName: "context7",
      status: "blocked",
      machineLabel: "Writer MacBook",
      launcher: "present",
      environment: [{ name: "CONTEXT7_API_KEY", present: false }],
      failure: { code: "missing_environment" },
    } satisfies RelayMcpPreflightResultMessage;
    expect(isRelayMcpPreflightResultMessage(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sekret");
  });

  test("v12 MCP configure results are correlated and reject malformed fields", () => {
    const result: RelayClientMessage = {
      type: "relay:mcp-configure-result",
      operationId: "operation-1",
      digest: "digest-1",
      targetName: "context7",
      state: "connected",
      toolNames: ["resolve-library-id", "get-library-docs"],
    } satisfies RelayMcpConfigureResultMessage;
    expect(isRelayMcpConfigureResultMessage(result)).toBe(true);
    expect(isRelayMcpConfigureResultMessage({ ...result, targetName: "" })).toBe(false);
    expect(isRelayMcpConfigureResultMessage({ ...result, toolNames: [42] })).toBe(false);
    expect(isRelayMcpConfigureResultMessage({ ...result, stderr: "do not smuggle raw stderr" })).toBe(false);
  });

  test("v12 truth frames reject contradictory cross-field states", () => {
    const preflight = {
      type: "relay:mcp-preflight-result",
      requestId: "request-1",
      digest: "digest-1",
      targetName: "context7",
      status: "ready",
      machineLabel: "Desktop",
      launcher: "present",
      environment: [{ name: "MCP_TOKEN", present: true }],
    } as const;
    expect(isRelayMcpPreflightResultMessage(preflight)).toBe(true);
    expect(isRelayMcpPreflightResultMessage({
      ...preflight,
      environment: [{ name: "MCP_TOKEN", present: false }],
    })).toBe(false);
    expect(isRelayMcpPreflightResultMessage({
      ...preflight,
      status: "blocked",
    })).toBe(false);
    expect(isRelayMcpPreflightResultMessage({
      ...preflight,
      failure: { code: "internal" },
    })).toBe(false);

    const connected = {
      type: "relay:mcp-configure-result",
      operationId: "operation-1",
      digest: "digest-1",
      targetName: "context7",
      state: "connected",
      toolNames: ["search-docs"],
    } as const;
    expect(isRelayMcpConfigureResultMessage(connected)).toBe(true);
    expect(isRelayMcpConfigureResultMessage({ ...connected, toolNames: [] })).toBe(false);
    expect(isRelayMcpConfigureResultMessage({ ...connected, state: "stopped" })).toBe(false);
    expect(isRelayMcpConfigureResultMessage({
      ...connected,
      state: "failed",
      failure: { code: "internal" },
    })).toBe(false);
    expect(isRelayMcpConfigureResultMessage({
      ...connected,
      state: "failed",
      toolNames: [],
    })).toBe(false);
  });

  test("machine labels use UTF-8 byte bounds, not JavaScript character counts", () => {
    const exact = "😀".repeat(40); // 160 UTF-8 bytes
    const result = {
      type: "relay:mcp-preflight-result",
      requestId: "request-1",
      digest: "digest-1",
      targetName: "context7",
      status: "ready",
      machineLabel: exact,
      launcher: "not-applicable",
      environment: [],
    } as const;
    expect(Buffer.byteLength(exact, "utf8")).toBe(160);
    expect(isRelayMcpPreflightResultMessage(result)).toBe(true);
    expect(isRelayMcpPreflightResultMessage({ ...result, machineLabel: `${exact}😀` })).toBe(false);
  });
});
