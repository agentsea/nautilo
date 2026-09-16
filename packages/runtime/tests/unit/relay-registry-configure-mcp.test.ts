/**
 * D384 Phase 5 — `InMemoryRelayRegistry.sendConfigureMcp` locks the live
 * hot-reconfigure path: a create/enable pushes a fresh `relay:configure-mcp`
 * to the already-connected relay (so a newly-enabled local MCP starts + loads
 * its tools without a relay reconnect), and is a no-op for an absent relay.
 */
import { describe, it, expect } from "bun:test";
import type {
  RelayCapabilities,
  RelayMcpConfigureResultMessage,
  RelayMcpPreflightResultMessage,
  RelayMcpServerConfig,
  RelayServerMessage,
} from "@nautilo/relay";
import { InMemoryRelayRegistry, RelayMcpTruthError } from "../../src/relay-registry";

const CAPS: RelayCapabilities = { mcpTools: [] } as unknown as RelayCapabilities;
const MCP_SESSION = "desktop-session-1";

const SERVERS: RelayMcpServerConfig[] = [
  {
    name: "maestro",
    transportKind: "stdio",
    transport: { command: "maestro", args: ["mcp"] },
  } as unknown as RelayMcpServerConfig,
];

describe("InMemoryRelayRegistry.sendConfigureMcp (D384 P5 hot-reconfigure)", () => {
  it("pushes relay:configure-mcp to a connected relay and returns true", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (m) => sent.push(m), 3);

    const ok = registry.sendConfigureMcp("relay-1", SERVERS);

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<RelayServerMessage, { type: "relay:configure-mcp" }>;
    expect(msg.type).toBe("relay:configure-mcp");
    expect(msg.servers).toEqual(SERVERS);
  });

  it("is a no-op (returns false) when the relay is not connected", () => {
    const registry = new InMemoryRelayRegistry();
    expect(registry.sendConfigureMcp("ghost", SERVERS)).toBe(false);
  });

  it("keeps v11 legacy configure while declining v12 correlated truth", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-v11", "alice", CAPS, (message) => sent.push(message), 11, MCP_SESSION);

    expect(registry.preflightMcp("relay-v11", {
      requestId: "preflight-v11",
      digest: "digest-v11",
      expectedDesktopSessionId: MCP_SESSION,
      server: SERVERS[0]!,
    })).rejects.toMatchObject({ code: "relay_protocol_unsupported" });
    expect(registry.sendConfigureMcp("relay-v11", SERVERS)).toBe(true);
    expect(sent).toHaveLength(1);
    const configure = sent[0];
    if (configure?.type !== "relay:configure-mcp") throw new Error("expected configure-mcp");
    expect(configure.servers).toEqual(SERVERS);
    expect(configure.operation).toBeUndefined();
  });

  it("awaits only an exact correlated MCP preflight result", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (message) => sent.push(message), 12, MCP_SESSION);

    const pending = registry.preflightMcp("relay-1", {
      requestId: "preflight-1",
      digest: "digest-1",
      expectedDesktopSessionId: MCP_SESSION,
      server: SERVERS[0]!,
    });
    expect(sent[0]).toMatchObject({ type: "relay:mcp-preflight", requestId: "preflight-1" });

    expect(registry.acceptMcpPreflightResult("relay-1", {
      type: "relay:mcp-preflight-result",
      requestId: "preflight-1",
      digest: "digest-1",
      targetName: "maestro",
      status: "ready",
      machineLabel: "Test Desktop",
      launcher: "present",
      environment: [],
    })).toBe(true);
    expect(pending).resolves.toMatchObject({ status: "ready", targetName: "maestro" });
    expect(registry.acceptMcpPreflightResult("relay-1", {
      type: "relay:mcp-preflight-result",
      requestId: "preflight-1",
      digest: "digest-1",
      targetName: "maestro",
      status: "ready",
      machineLabel: "Test Desktop",
      launcher: "present",
      environment: [],
    })).toBe(false);
  });

  it("rejects shape-valid truth that contradicts requested transport, env names, or phase", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "alice", CAPS, () => {}, 12, MCP_SESSION);
    const preflightServer: RelayMcpServerConfig = {
      ...SERVERS[0]!,
      envPassthrough: ["FIRST_ENV", "SECOND_ENV"],
    };
    const preflightCases: Array<{
      readonly label: string;
      readonly server: RelayMcpServerConfig;
      readonly launcher: "present" | "not-applicable";
      readonly environment: RelayMcpPreflightResultMessage["environment"];
    }> = [
      {
        label: "stdio ready without a launcher",
        server: preflightServer,
        launcher: "not-applicable",
        environment: [{ name: "FIRST_ENV", present: true }, { name: "SECOND_ENV", present: true }],
      },
      {
        label: "omitted required env name",
        server: preflightServer,
        launcher: "present",
        environment: [{ name: "FIRST_ENV", present: true }],
      },
      {
        label: "added env name",
        server: preflightServer,
        launcher: "present",
        environment: [
          { name: "FIRST_ENV", present: true },
          { name: "SECOND_ENV", present: true },
          { name: "THIRD_ENV", present: true },
        ],
      },
      {
        label: "reordered env names",
        server: preflightServer,
        launcher: "present",
        environment: [{ name: "SECOND_ENV", present: true }, { name: "FIRST_ENV", present: true }],
      },
      {
        label: "duplicated env name",
        server: preflightServer,
        launcher: "present",
        environment: [{ name: "FIRST_ENV", present: true }, { name: "FIRST_ENV", present: true }],
      },
      {
        label: "HTTP transport falsely claims a local launcher",
        server: { ...preflightServer, transportKind: "streamable-http", transport: { url: "https://example.test/mcp" } },
        launcher: "present",
        environment: [{ name: "FIRST_ENV", present: true }, { name: "SECOND_ENV", present: true }],
      },
    ];
    for (const [index, testCase] of preflightCases.entries()) {
      const requestId = `semantic-preflight-${index}`;
      const pending = registry.preflightMcp("relay-1", {
        requestId,
        digest: `digest-${index}`,
        expectedDesktopSessionId: MCP_SESSION,
        server: testCase.server,
      });
      const outcome = pending.then(() => null, (error: unknown) => error);
      const result: RelayMcpPreflightResultMessage = {
        type: "relay:mcp-preflight-result",
        requestId,
        digest: `digest-${index}`,
        targetName: "maestro",
        status: "ready",
        machineLabel: "Dishonest Desktop",
        launcher: testCase.launcher,
        environment: testCase.environment,
      };
      expect(registry.acceptMcpPreflightResult("relay-1", result), testCase.label).toBe(false);
      expect(outcome, testCase.label).resolves.toMatchObject({ code: "mcp_response_mismatch" });
    }

    const configureCases: Array<{
      readonly phase: "start" | "rollback";
      readonly result: Pick<RelayMcpConfigureResultMessage, "state" | "toolNames" | "failure">;
    }> = [
      { phase: "start", result: { state: "stopped", toolNames: [] } },
      { phase: "rollback", result: { state: "connected", toolNames: ["dishonest-tool"] } },
    ];
    for (const [index, testCase] of configureCases.entries()) {
      const operationId = `semantic-configure-${index}`;
      const pending = registry.configureMcpWithOutcome("relay-1", {
        servers: SERVERS,
        operation: { operationId, digest: `configure-digest-${index}`, targetName: "maestro", phase: testCase.phase },
        expectedDesktopSessionId: MCP_SESSION,
      });
      const outcome = pending.then(() => null, (error: unknown) => error);
      const result: RelayMcpConfigureResultMessage = {
        type: "relay:mcp-configure-result",
        operationId,
        digest: `configure-digest-${index}`,
        targetName: "maestro",
        ...testCase.result,
      };
      expect(registry.acceptMcpConfigureResult("relay-1", result)).toBe(false);
      expect(outcome).resolves.toMatchObject({ code: "mcp_response_mismatch" });
    }
  });

  it("resolves shape-valid failed configure outcomes for both phases", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "alice", CAPS, () => {}, 12, MCP_SESSION);
    const failures: Array<{
      readonly phase: "start" | "rollback";
      readonly code: "spawn_failed" | "protocol_failed";
    }> = [
      { phase: "start", code: "spawn_failed" },
      { phase: "rollback", code: "protocol_failed" },
    ];
    for (const [index, failure] of failures.entries()) {
      const operationId = `failed-configure-${index}`;
      const pending = registry.configureMcpWithOutcome("relay-1", {
        servers: SERVERS,
        operation: {
          operationId,
          digest: `failed-digest-${index}`,
          targetName: "maestro",
          phase: failure.phase,
        },
        expectedDesktopSessionId: MCP_SESSION,
      });
      const result: RelayMcpConfigureResultMessage = {
        type: "relay:mcp-configure-result",
        operationId,
        digest: `failed-digest-${index}`,
        targetName: "maestro",
        state: "failed",
        toolNames: [],
        failure: { code: failure.code },
      };
      expect(registry.acceptMcpConfigureResult("relay-1", result)).toBe(true);
      expect(pending).resolves.toMatchObject({
        state: "failed",
        failure: { code: failure.code },
      });
    }
  });

  it("rejects a mismatched configure result, times out deterministically, and rejects on disconnect", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (message) => sent.push(message), 12, MCP_SESSION);

    const mismatch = registry.configureMcpWithOutcome("relay-1", {
      servers: SERVERS,
      operation: { operationId: "operation-1", digest: "digest-1", targetName: "maestro", phase: "start" },
      expectedDesktopSessionId: MCP_SESSION,
    });
    expect(registry.acceptMcpConfigureResult("relay-1", {
      type: "relay:mcp-configure-result",
      operationId: "operation-1",
      digest: "different-digest",
      targetName: "maestro",
      state: "connected",
      toolNames: ["tool"],
    })).toBe(false);
    expect(mismatch).rejects.toBeInstanceOf(RelayMcpTruthError);
    expect(mismatch).rejects.toMatchObject({ code: "mcp_response_mismatch" });

    const timeout = registry.preflightMcp("relay-1", {
      requestId: "preflight-timeout",
      digest: "digest-1",
      expectedDesktopSessionId: MCP_SESSION,
      server: SERVERS[0]!,
      timeoutMs: 1,
    });
    expect(timeout).rejects.toMatchObject({ code: "mcp_preflight_timeout" });

    const disconnected = registry.configureMcpWithOutcome("relay-1", {
      servers: SERVERS,
      operation: { operationId: "operation-2", digest: "digest-1", targetName: "maestro", phase: "rollback" },
      expectedDesktopSessionId: MCP_SESSION,
    });
    await registry.unregister("relay-1");
    expect(disconnected).rejects.toMatchObject({ code: "relay_disconnected" });
    expect(sent.some((message) => message.type === "relay:configure-mcp")).toBe(true);
  });

  it("rejects pending MCP truth when a relay id is re-registered on a replacement socket", async () => {
    const registry = new InMemoryRelayRegistry();
    const sentA: RelayServerMessage[] = [];
    const sentB: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (message) => sentA.push(message), 12, MCP_SESSION);
    const pending = registry.preflightMcp("relay-1", {
      requestId: "preflight-replaced",
      digest: "digest-replaced",
      expectedDesktopSessionId: MCP_SESSION,
      server: SERVERS[0]!,
    });

    await registry.register("relay-1", "alice", CAPS, (message) => sentB.push(message), 12, "replacement-session");
    expect(pending).rejects.toMatchObject({ code: "relay_replaced" });
    expect(registry.acceptMcpPreflightResult("relay-1", {
      type: "relay:mcp-preflight-result",
      requestId: "preflight-replaced",
      digest: "digest-replaced",
      targetName: "maestro",
      status: "ready",
      machineLabel: "Replacement Desktop",
      launcher: "present",
      environment: [],
    })).toBe(false);
    expect(sentA).toHaveLength(1);
    expect(sentB).toHaveLength(0);
  });

  it("never sends an old expected Desktop operation to a replacement entry", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (message) => sent.push(message), 12, "replacement-session");

    expect(registry.preflightMcp("relay-1", {
      requestId: "old-preflight",
      digest: "old-digest",
      expectedDesktopSessionId: MCP_SESSION,
      server: SERVERS[0]!,
    })).rejects.toMatchObject({ code: "relay_replaced" });
    expect(registry.configureMcpWithOutcome("relay-1", {
      servers: SERVERS,
      operation: { operationId: "old-configure", digest: "old-digest", targetName: "maestro", phase: "start" },
      expectedDesktopSessionId: MCP_SESSION,
    })).rejects.toMatchObject({ code: "relay_replaced" });
    expect(sent).toEqual([]);
  });

  it("keeps concurrent configure operations separately correlated", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (message) => sent.push(message), 12, MCP_SESSION);
    const first = registry.configureMcpWithOutcome("relay-1", {
      servers: SERVERS,
      operation: { operationId: "operation-first", digest: "digest-first", targetName: "maestro", phase: "start" },
      expectedDesktopSessionId: MCP_SESSION,
    });
    const second = registry.configureMcpWithOutcome("relay-1", {
      servers: SERVERS,
      operation: { operationId: "operation-second", digest: "digest-second", targetName: "maestro", phase: "start" },
      expectedDesktopSessionId: MCP_SESSION,
    });
    expect(sent.filter((message) => message.type === "relay:configure-mcp")).toHaveLength(2);

    expect(registry.acceptMcpConfigureResult("relay-1", {
      type: "relay:mcp-configure-result",
      operationId: "operation-second",
      digest: "digest-second",
      targetName: "maestro",
      state: "connected",
      toolNames: ["second-tool"],
    })).toBe(true);
    expect(registry.acceptMcpConfigureResult("relay-1", {
      type: "relay:mcp-configure-result",
      operationId: "operation-first",
      digest: "digest-first",
      targetName: "maestro",
      state: "connected",
      toolNames: ["first-tool"],
    })).toBe(true);
    expect(second).resolves.toMatchObject({ toolNames: ["second-tool"] });
    expect(first).resolves.toMatchObject({ toolNames: ["first-tool"] });
  });
});
