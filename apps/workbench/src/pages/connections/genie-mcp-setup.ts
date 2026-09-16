import type { NautiloApiClient } from "@nautilo/api-client/browser";
import type { RoomNavigationAPI } from "../../rooms/room-navigation-types";
import type { LocalMcpInstallFailureCode } from "@nautilo/types";
import {
  buildLocalMcpGenieHandoff,
  createGenieHandoffController,
  type LocalMcpHandoffInput,
} from "../../lib/genie-handoff";

export const DEFAULT_MCP_SETUP_REQUEST =
  "Help me set up a local MCP on this machine. Ask me what I want to connect, then find the exact official package or endpoint if needed. Before installing anything, show me the exact MCP install approval.";

interface NormalizedStdioServer {
  command: string;
  args: string[];
  envPassthrough?: string[];
}

interface NormalizedHttpServer {
  url: string;
}

export interface NormalizedMcpConfig {
  mcpServers: Record<string, NormalizedStdioServer | NormalizedHttpServer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("MCP arguments must be an array of strings.");
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("MCP arguments must be an array of strings.");
    }
    strings.push(item);
  }
  return strings;
}

function parseEnvironment(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    throw new Error("MCP environment must be an object.");
  }
  const names = Object.entries(value).map(([name, rawValue]) => {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) {
      throw new Error("MCP environment contains an invalid variable name.");
    }
    if (rawValue !== `\${${name}}`) {
      throw new Error(
        "MCP environment contains a literal value. Use a matching placeholder so the secret stays on this machine.",
      );
    }
    return name;
  });
  if (names.length > 64) throw new Error("MCP environment has too many names.");
  return [...new Set(names)].sort();
}

function normalizeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("MCP URL must be an absolute HTTP(S) URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
    || url.username || url.password || url.search || url.hash) {
    throw new Error("MCP URL must be an absolute HTTP(S) URL without credentials, query, or fragment.");
  }
  return url.toString();
}

function assertSafeArguments(args: readonly string[]): void {
  for (const arg of args) {
    const normalized = arg.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(normalized)
      || /^(?:--env|-e)(?:=|$)/iu.test(normalized)
      || /^--?(?:[a-z0-9_-]*token[a-z0-9_-]*|[a-z0-9_-]*password[a-z0-9_-]*|[a-z0-9_-]*api[_-]?key[a-z0-9_-]*|[a-z0-9_-]*credential[a-z0-9_-]*|[a-z0-9_-]*secret[a-z0-9_-]*)(?:=|$)/iu.test(normalized)) {
      throw new Error("MCP arguments must not contain environment assignments or credential flags.");
    }
  }
}

function assertMcpName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(name)) {
    throw new Error("MCP names must use the canonical local-MCP name format.");
  }
}

export function normalizeMcpConfigJson(raw: string): NormalizedMcpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("This is not valid JSON.");
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error('Expected an MCP configuration object with an "mcpServers" property.');
  }

  const entries = Object.entries(parsed.mcpServers);
  if (entries.length === 0) {
    throw new Error("Add at least one MCP server.");
  }

  const normalized: NormalizedMcpConfig = { mcpServers: {} };
  for (const [name, config] of entries) {
    if (!isRecord(config)) {
      throw new Error("Every MCP server needs an object configuration.");
    }
    assertMcpName(name);
    if (config.headers !== undefined) {
      throw new Error(
        `${name}.headers is not accepted by the JSON importer because it can expose secrets. Ask Genie to help configure authenticated HTTP MCPs.`,
      );
    }

    if (typeof config.url === "string" && config.url.trim()) {
      if (config.command !== undefined || config.args !== undefined || config.env !== undefined) {
        throw new Error(`${name} must use either url or command configuration, not both.`);
      }
      normalized.mcpServers[name] = { url: normalizeHttpUrl(config.url) };
      continue;
    }

    if (typeof config.command !== "string" || !config.command.trim()) {
      throw new Error(`${name} needs either a non-empty command or URL.`);
    }
    const args = parseStringArray(config.args);
    assertSafeArguments(args);
    const envPassthrough = parseEnvironment(config.env);
    normalized.mcpServers[name] = {
      command: config.command.trim(),
      args,
      ...(envPassthrough.length > 0 ? { envPassthrough } : {}),
    };
  }
  return normalized;
}

export function advancedMcpSetupRequest(config: NormalizedMcpConfig): string {
  return [
    "Set up the local MCP connection(s) in the normalized MCP configuration below on this machine.",
    "Verify packages and endpoints, clarify anything ambiguous, and use the exact MCP install approval before each installation.",
    "The JSON contains environment variable names only; read their values from this machine and never repeat secret values in chat.",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
  ].join("\n");
}

export function fixLocalMcpRequest(input: {
  name: string;
  failureCode?: string | null;
  missingEnvironment?: readonly string[] | null;
}): string {
  const missing = input.missingEnvironment?.length
    ? ` Missing environment variables: ${input.missingEnvironment.join(", ")}.`
    : "";
  const failure = input.failureCode ? ` Last safe check: ${input.failureCode}.` : "";
  return `Help me fix and reconnect the existing local MCP “${input.name}” on this machine.${failure}${missing} Check its prerequisites, resolve or clarify the problem, and show the exact MCP install approval before launching it again. Never request or repeat secret values in chat.`;
}

const SAFE_HANDOFF_FAILURE_CODES = new Set<LocalMcpInstallFailureCode>([
  "invalid_request",
  "relay_unavailable",
  "relay_protocol_unsupported",
  "missing_launcher",
  "missing_environment",
  "spawn_failed",
  "protocol_failed",
  "discovery_timeout",
  "empty_toolset",
  "internal",
]);

const KNOWN_FAILURE_CODES = new Set<LocalMcpInstallFailureCode>([
  "invalid_request", "approval_stale", "relay_unavailable", "relay_protocol_unsupported",
  "missing_launcher", "missing_environment", "install_in_progress", "spawn_failed",
  "protocol_failed", "discovery_timeout", "empty_toolset", "rollback_unconfirmed", "internal",
]);

function normalizedEnvironmentNames(names: readonly string[] | null | undefined): string[] {
  if (!names) return [];
  if (names.length > 64 || names.some((name) => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name))) {
    throw new Error("MCP environment names are not supported.");
  }
  return [...new Set(names)].sort();
}

export function defaultMcpSetupHandoffInput(): LocalMcpHandoffInput {
  return { intent: DEFAULT_MCP_SETUP_REQUEST, context: {} };
}

export function advancedMcpSetupHandoffInput(config: NormalizedMcpConfig): LocalMcpHandoffInput {
  const entries = Object.entries(config.mcpServers);
  const environmentNames = normalizedEnvironmentNames(entries.flatMap(([, server]) =>
    "envPassthrough" in server ? server.envPassthrough ?? [] : [],
  ));
  return {
    intent: advancedMcpSetupRequest(config),
    context: {
      ...(entries.length === 1 ? { mcpName: entries[0][0] } : {}),
      ...(environmentNames.length > 0 ? { environmentNames } : {}),
    },
  };
}

export function fixLocalMcpHandoffInput(input: {
  name: string;
  failureCode?: string | null;
  missingEnvironment?: readonly string[] | null;
}): LocalMcpHandoffInput {
  assertMcpName(input.name);
  const knownFailureCode = input.failureCode ?? undefined;
  if (knownFailureCode !== undefined
    && !KNOWN_FAILURE_CODES.has(knownFailureCode as LocalMcpInstallFailureCode)) {
    throw new Error("MCP failure evidence is not supported.");
  }
  const failureCode = knownFailureCode as LocalMcpInstallFailureCode | undefined;
  const contextFailureCode = failureCode && SAFE_HANDOFF_FAILURE_CODES.has(failureCode)
    ? failureCode
    : undefined;
  const environmentNames = normalizedEnvironmentNames(input.missingEnvironment);
  return {
    intent: fixLocalMcpRequest({
      name: input.name,
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(environmentNames.length === 0 ? {} : { missingEnvironment: environmentNames }),
    }),
    context: {
      mcpName: input.name,
      ...(contextFailureCode === undefined ? {} : { failureCode: contextFailureCode }),
      ...(environmentNames.length > 0 ? { environmentNames } : {}),
    },
  };
}

export async function sendMcpSetupToGenie(args: {
  apiClient: NautiloApiClient;
  roomNavigation: Pick<RoomNavigationAPI, "refreshRooms" | "setActiveRoom">;
  input: LocalMcpHandoffInput;
}): Promise<string> {
  let openedRoomId: string | null = null;
  const controller = createGenieHandoffController({
    apiClient: args.apiClient,
    getCurrentRoomId: () => null,
    appendCurrentRoomDraft: () => { throw new Error("MCP setup cannot create a draft."); },
    refreshRooms: args.roomNavigation.refreshRooms,
    setActiveRoom: (roomId) => {
      openedRoomId = roomId;
      return args.roomNavigation.setActiveRoom(roomId);
    },
  });
  await controller.deliver(buildLocalMcpGenieHandoff(args.input), { explicitHumanAction: true });
  if (!openedRoomId) throw new Error("MCP setup Room did not open.");
  return openedRoomId;
}
