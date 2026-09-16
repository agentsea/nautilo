import type { RelayMcpHostHandle } from "@nautilo/mcp-client";
import type {
  RelayAcpHostPort,
  RelayCapabilities,
  RelayClaudeConnectionHostPort,
  RelayClaudeExecutionHostPort,
  RelayCodexHostPort,
} from "@nautilo/relay";

export type HostedCapabilityFragment = Pick<RelayCapabilities, "mcpTools"> &
  Partial<Pick<RelayCapabilities, "codex" | "acp" | "claude" | "claudeExecution">>;

/** Closed projection of Electron-owned hosted ports into relay capabilities and client options. */
export function createDesktopHostedRelayAdapter(options: {
  readonly codexHostPort?: RelayCodexHostPort | undefined;
  readonly acpHostPort?: RelayAcpHostPort | undefined;
  readonly claudeConnectionHostPort?: RelayClaudeConnectionHostPort | undefined;
  readonly claudeExecutionHostPort?: RelayClaudeExecutionHostPort | undefined;
}): {
  readonly capabilities: () => HostedCapabilityFragment;
  readonly clientPorts: (mcpHost: RelayMcpHostHandle) => {
    readonly mcpHost: RelayMcpHostHandle;
    readonly codexHostPort?: RelayCodexHostPort;
    readonly acpHostPort?: RelayAcpHostPort;
    readonly claudeConnectionHostPort?: RelayClaudeConnectionHostPort;
    readonly claudeExecutionHostPort?: RelayClaudeExecutionHostPort;
  };
} {
  return {
    capabilities: () => {
      let codexReady = false;
      try {
        codexReady = options.codexHostPort?.isReady?.() === true;
      } catch {
        codexReady = false;
      }

      let acpReady = false;
      let acpRegistrations:
        | readonly ["hermes-acp"]
        | readonly ["opencode-acp"]
        | readonly ["hermes-acp", "opencode-acp"] = [
          "hermes-acp",
          "opencode-acp",
        ];
      try {
        const registrations =
          options.acpHostPort?.registrations?.() ?? acpRegistrations;
        if (registrations.length === 1 && registrations[0] === "hermes-acp") {
          acpRegistrations = ["hermes-acp"];
        } else if (
          registrations.length === 1 &&
          registrations[0] === "opencode-acp"
        ) {
          acpRegistrations = ["opencode-acp"];
        } else if (
          registrations.length === 2 &&
          registrations[0] === "hermes-acp" &&
          registrations[1] === "opencode-acp"
        ) {
          acpRegistrations = ["hermes-acp", "opencode-acp"];
        }
        acpReady =
          registrations.length > 0 && options.acpHostPort?.isReady?.() === true;
      } catch {
        acpReady = false;
      }

      let claudeConnectionReady = false;
      try {
        claudeConnectionReady =
          options.claudeConnectionHostPort?.isReady() === true;
      } catch {
        claudeConnectionReady = false;
      }

      let claudeExecutionReady = false;
      try {
        claudeExecutionReady =
          options.claudeExecutionHostPort?.isReady() === true;
      } catch {
        claudeExecutionReady = false;
      }

      return {
        mcpTools: [],
        ...(codexReady
          ? {
              codex: {
                version: 1 as const,
                hostKind: "electron" as const,
                maxProfiles: 4 as const,
                maxActiveTurns: 4 as const,
              },
            }
          : {}),
        ...(acpReady
          ? {
              acp: {
                version: 2 as const,
                hostKind: "electron" as const,
                registrations: acpRegistrations,
              },
            }
          : {}),
        ...(claudeConnectionReady
          ? {
              claude: {
                version: 1 as const,
                hostKind: "electron" as const,
                registrations: ["claude-agent-sdk"] as const,
              },
            }
          : {}),
        ...(claudeExecutionReady
          ? { claudeExecution: { version: 2 as const } }
          : {}),
      };
    },
    clientPorts: (mcpHost) => ({
      mcpHost,
      ...(options.codexHostPort
        ? { codexHostPort: options.codexHostPort }
        : {}),
      ...(options.acpHostPort ? { acpHostPort: options.acpHostPort } : {}),
      ...(options.claudeConnectionHostPort
        ? { claudeConnectionHostPort: options.claudeConnectionHostPort }
        : {}),
      ...(options.claudeExecutionHostPort
        ? { claudeExecutionHostPort: options.claudeExecutionHostPort }
        : {}),
    }),
  };
}
