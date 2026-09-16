import { describe, expect, test } from "bun:test";
import type { RelayMcpHostHandle } from "@nautilo/mcp-client";
import type {
  RelayAcpHostPort,
  RelayClaudeConnectionHostPort,
  RelayClaudeExecutionHostPort,
  RelayCodexHostPort,
} from "@nautilo/relay";

import { createDesktopHostedRelayAdapter } from "../../electron/relay-hosted-adapters.ts";

const mcpHost = { identity: "candidate-mcp-host" } as unknown as RelayMcpHostHandle;

function claudeConnection(
  isReady: () => boolean,
): RelayClaudeConnectionHostPort {
  return {
    isReady,
    onRegistered: () => {},
    onDiscover: () => {},
  };
}

function claudeExecution(
  isReady: () => boolean,
): RelayClaudeExecutionHostPort {
  return {
    isReady,
    onRegistered: () => {},
    onCommand: () => {},
  };
}

describe("closed Desktop hosted relay adapter", () => {
  test("advertises only the exact MCP candidate and omits absent optional ports", () => {
    const adapter = createDesktopHostedRelayAdapter({});

    expect(adapter.capabilities()).toEqual({ mcpTools: [] });
    const ports = adapter.clientPorts(mcpHost);
    expect(ports).toEqual({ mcpHost });
    expect(ports.mcpHost).toBe(mcpHost);
  });

  test("passes every optional port by object identity while unready ports advertise nothing", () => {
    const codexHostPort: RelayCodexHostPort = { isReady: () => false };
    const acpHostPort: RelayAcpHostPort = {
      isReady: () => false,
      registrations: () => ["hermes-acp", "opencode-acp"],
    };
    const claudeConnectionHostPort = claudeConnection(() => false);
    const claudeExecutionHostPort = claudeExecution(() => false);
    const adapter = createDesktopHostedRelayAdapter({
      codexHostPort,
      acpHostPort,
      claudeConnectionHostPort,
      claudeExecutionHostPort,
    });

    expect(adapter.capabilities()).toEqual({ mcpTools: [] });
    const ports = adapter.clientPorts(mcpHost);
    expect(ports.mcpHost).toBe(mcpHost);
    expect(ports.codexHostPort).toBe(codexHostPort);
    expect(ports.acpHostPort).toBe(acpHostPort);
    expect(ports.claudeConnectionHostPort).toBe(claudeConnectionHostPort);
    expect(ports.claudeExecutionHostPort).toBe(claudeExecutionHostPort);
  });

  test("fails closed independently when hosted readiness or registration reads throw", () => {
    const adapter = createDesktopHostedRelayAdapter({
      codexHostPort: {
        isReady: () => {
          throw new Error("codex readiness unavailable");
        },
      },
      acpHostPort: {
        registrations: () => {
          throw new Error("ACP registrations unavailable");
        },
        isReady: () => true,
      },
      claudeConnectionHostPort: claudeConnection(() => {
        throw new Error("Claude connection readiness unavailable");
      }),
      claudeExecutionHostPort: claudeExecution(() => {
        throw new Error("Claude execution readiness unavailable");
      }),
    });

    expect(adapter.capabilities()).toEqual({ mcpTools: [] });
  });

  test("advertises the closed ready capability shapes and preserves the same host ports", () => {
    const codexHostPort: RelayCodexHostPort = { isReady: () => true };
    const acpHostPort: RelayAcpHostPort = { isReady: () => true };
    const claudeConnectionHostPort = claudeConnection(() => true);
    const claudeExecutionHostPort = claudeExecution(() => true);
    const adapter = createDesktopHostedRelayAdapter({
      codexHostPort,
      acpHostPort,
      claudeConnectionHostPort,
      claudeExecutionHostPort,
    });

    expect(adapter.capabilities()).toEqual({
      mcpTools: [],
      codex: {
        version: 1,
        hostKind: "electron",
        maxProfiles: 4,
        maxActiveTurns: 4,
      },
      acp: {
        version: 2,
        hostKind: "electron",
        registrations: ["hermes-acp", "opencode-acp"],
      },
      claude: {
        version: 1,
        hostKind: "electron",
        registrations: ["claude-agent-sdk"],
      },
      claudeExecution: { version: 2 },
    });
    const ports = adapter.clientPorts(mcpHost);
    expect(ports).toMatchObject({
      mcpHost,
      codexHostPort,
      acpHostPort,
      claudeConnectionHostPort,
      claudeExecutionHostPort,
    });
    expect(ports.mcpHost).toBe(mcpHost);
    expect(ports.codexHostPort).toBe(codexHostPort);
    expect(ports.acpHostPort).toBe(acpHostPort);
    expect(ports.claudeConnectionHostPort).toBe(claudeConnectionHostPort);
    expect(ports.claudeExecutionHostPort).toBe(claudeExecutionHostPort);
  });

  test("normalizes canonical ACP subsets, defaults missing/current registrations, and rejects empty", () => {
    const cases: Array<{
      readonly registrations?: RelayAcpHostPort["registrations"];
      readonly expected?: readonly string[];
    }> = [
      { registrations: () => ["hermes-acp"], expected: ["hermes-acp"] },
      { registrations: () => ["opencode-acp"], expected: ["opencode-acp"] },
      {
        registrations: () => ["hermes-acp", "opencode-acp"],
        expected: ["hermes-acp", "opencode-acp"],
      },
      { expected: ["hermes-acp", "opencode-acp"] },
      {
        registrations: () => ["opencode-acp", "hermes-acp"],
        expected: ["hermes-acp", "opencode-acp"],
      },
      { registrations: () => [] },
    ];

    for (const entry of cases) {
      const adapter = createDesktopHostedRelayAdapter({
        acpHostPort: {
          isReady: () => true,
          ...(entry.registrations === undefined
            ? {}
            : { registrations: entry.registrations }),
        },
      });
      const capabilities = adapter.capabilities();
      if (entry.expected === undefined) {
        expect(capabilities).toEqual({ mcpTools: [] });
      } else {
        expect(capabilities.acp?.registrations).toEqual(entry.expected);
      }
    }
  });
});
