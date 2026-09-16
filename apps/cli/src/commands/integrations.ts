import { readSync } from "node:fs";
import type { ConnectionAuditResponse, ConnectionListResponse } from "@nautilo/api-client";
import { ApiError } from "@nautilo/api-client";
import type { CommandModule } from "yargs";
import { createAuthenticatedAdminClient, type AuthenticatedAdminClient } from "../lib/authenticated-admin-client.ts";
import { readHiddenLine } from "../lib/host-provider-prompt.ts";
import { writeServerAdminError, writeServerAdminSuccess, type ServerAdminFormat } from "../lib/server-admin-output.ts";

type BaseArgs = { server?: string; format: ServerAdminFormat };
type ConnectionArgs = BaseArgs & { service: string; field: string; expiresAt?: string; proofFd?: number; yes: boolean };
type McpMutationArgs = BaseArgs & { name: string; tool?: string };
type GoogleMutationArgs = BaseArgs & { proofFd?: number; yes: boolean };

export interface IntegrationsDependencies {
  authenticate(input: { serverFlag?: string }): Promise<AuthenticatedAdminClient>;
  readHidden(prompt: string): Promise<string>;
  readDescriptor(fd: number): string;
  readOAuthDescriptor(fd: number): string;
  interactive(): boolean;
}

function readDescriptor(fd: number): string {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("invalid_descriptor");
  const result: number[] = [];
  const byte = Buffer.allocUnsafe(1);
  while (result.length <= 16_384) {
    const count = readSync(fd, byte, 0, 1, null);
    if (count === 0 || byte[0] === 10) break;
    result.push(byte[0] ?? 0);
  }
  if (result.length === 0 || result.length > 16_384 || result.includes(0) || result.includes(13)) throw new Error("invalid_descriptor");
  return Buffer.from(result).toString("utf8");
}


function readOAuthDescriptor(fd: number): string {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("invalid_descriptor");
  const chunks: Buffer[] = [];
  let length = 0;
  const chunk = Buffer.allocUnsafe(8_192);
  while (length <= 256 * 1024) {
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    length += count;
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  const value = Buffer.concat(chunks);
  if (value.length === 0 || value.length > 256 * 1024 || value.includes(0)) {
    throw new Error("invalid_descriptor");
  }
  return value.toString("utf8");
}

const DEFAULT_DEPS: IntegrationsDependencies = {
  authenticate: (input) => createAuthenticatedAdminClient(input),
  readHidden: readHiddenLine,
  readDescriptor,
  readOAuthDescriptor,
  interactive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
};

function authInput(server: string | undefined): { serverFlag?: string } { return server === undefined ? {} : { serverFlag: server }; }
function safe(value: string | null | undefined): string { return [...(value ?? "-")].map((c) => { const n = c.codePointAt(0) ?? 0; return n <= 31 || (n >= 127 && n <= 159) ? "�" : c; }).join("").slice(0, 200); }
function stableError(error: unknown) {
  if (error instanceof ApiError && error.status === 403) return { code: "authority_denied", message: "The server denied this Integration mutation for the signed-in Human or topology." };
  if (error instanceof ApiError && error.status === 400) return { code: "connection_rejected", message: "The server rejected the Connection metadata or protected value." };
  return { code: "integrations_unavailable", message: "Integration administration could not be completed safely." };
}


async function observeMcp(client: AuthenticatedAdminClient, name: string) {
  const matches = (await client.api.listMcpAdminSummaries()).filter((row) => row.name === name);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? "mcp_not_found" : "mcp_ambiguous");
  return matches[0]!;
}

function listHuman(value: ConnectionListResponse): string[] {
  return [`connections: ${value.connections.length}`, ...value.connections.map((row) => `- ${safe(row.service)}/${safe(row.field)} scope=${safe(row.scope_label)} updated=${safe(row.updated_at)}`)];
}
function auditHuman(value: ConnectionAuditResponse): string[] {
  return [`findings: ${value.findings.length}`, ...value.findings.map((row) => `- ${safe(row.severity)} ${safe(row.kind)} service=${safe(row.service)} field=${safe(row.field)}`)];
}

export function createIntegrationsModule(overrides: Partial<IntegrationsDependencies> = {}): CommandModule {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  return {
    command: "integrations",
    describe: "Inspect provider readiness and administer Connections, MCP, and Google integration settings.",
    builder: (root) => root
      .command({
        command: "providers",
        describe: "Show secret-free provider readiness.",
        builder: (child) => child.option("format", { choices: ["human", "json"] as const, default: "human" }),
        handler: async (raw) => {
          const argv = raw as unknown as BaseArgs;
          try {
            const client = await deps.authenticate(authInput(argv.server));
            if (!client.whoami.capabilities.includes("read_server_settings")) throw new ApiError(403, "forbidden");
            const status = await client.api.getSetupStatus();
            const providers = status.providers;
            if (!providers) throw new Error("provider_status_unavailable");
            const projection = { llm: providers.hasLlm, voice: providers.hasVoice ?? false, search: providers.hasSearch ?? false, conversion: providers.hasConversion ?? false, managedByCloud: providers.managedByCloud, freshness: "request-time", validation: "not-run" };
            writeServerAdminSuccess(argv.format, projection, Object.entries(projection).map(([key, value]) => `${key}: ${String(value)}`)); process.exitCode = 0;
          } catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
        },
      })
      .command({
        command: "connections",
        describe: "List, audit, set, rotate, or remove current-Human Connections.",
        builder: (child) => child
          .command({ command: "list", describe: "List current-Human Connections without returning stored values.", builder: (c) => c.option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as BaseArgs;
            try { const client = await deps.authenticate(authInput(argv.server)); const result = await client.api.getConnections(); writeServerAdminSuccess(argv.format, { ...result, ownership: "current-human" }, listHuman(result)); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "audit", describe: "Inspect redacted Connection security findings.", builder: (c) => c.option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as BaseArgs;
            try { const client = await deps.authenticate(authInput(argv.server)); const result = await client.api.auditConnections(); const safeResult = { status: result.status, findings: result.findings.map((finding) => ({ kind: finding.kind, severity: finding.severity, service: finding.service ?? null, field: finding.field ?? null, tool: finding.tool ?? null })) }; writeServerAdminSuccess(argv.format, safeResult, auditHuman(result)); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "set <service> <field>", describe: "Store or rotate a write-only Connection value.", builder: (c) => c.positional("service", { type: "string", demandOption: true }).positional("field", { type: "string", demandOption: true }).option("expires-at", { type: "string" }).option("proof-fd", { type: "number" }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as ConnectionArgs;
            try {
              if (argv.proofFd === undefined && !deps.interactive()) throw new Error("protected_input_required");
              const client = await deps.authenticate(authInput(argv.server));
              const value = argv.proofFd === undefined ? await deps.readHidden("Connection value (input hidden): ") : deps.readDescriptor(argv.proofFd);
              const result = await client.api.storeConnection({ service: argv.service, field: argv.field, value, ...(argv.expiresAt ? { expiresAt: argv.expiresAt } : {}) });
              writeServerAdminSuccess(argv.format, { status: result.status, connection: result.connection, valueReturned: false }, [`stored: ${safe(argv.service)}/${safe(argv.field)}`, "value: never returned"]); process.exitCode = 0;
            } catch (error) { const stable = error instanceof Error && error.message === "protected_input_required" ? { code: "protected_input_required", message: "A hidden terminal prompt or explicit --proof-fd is required." } : stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "remove <service> <field>", describe: "Remove one current-Human Connection value.", builder: (c) => c.positional("service", { type: "string", demandOption: true }).positional("field", { type: "string", demandOption: true }).option("yes", { type: "boolean", default: false }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as ConnectionArgs;
            if (!argv.yes) { writeServerAdminError(argv.format, "confirmation_required", "Connection removal requires --yes."); process.exitCode = 2; return; }
            try { const client = await deps.authenticate(authInput(argv.server)); const result = await client.api.deleteConnection(argv.service, argv.field); writeServerAdminSuccess(argv.format, { ...result, stateChanged: result.status === "deleted" }, [`status: ${safe(result.status)}`]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .demandCommand(1, 1).strict(),
        handler: () => {},
      })
      .command({
        command: "mcp",
        describe: "Inspect and administer redacted MCP health and lifecycle controls.",
        builder: (child) => child
          .command({ command: "list", describe: "List redacted MCP server state and health.", builder: (c) => c.option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as BaseArgs;
            try { const client = await deps.authenticate(authInput(argv.server)); const servers = await client.api.listMcpAdminSummaries(); writeServerAdminSuccess(argv.format, { servers, complete: true }, [`servers: ${servers.length}`, ...servers.map((row) => `- ${safe(row.name)} host=${safe(row.host)} enabled=${String(row.enabled)} health=${safe(row.health)} tools=${row.toolCount}`)]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "tools <name>", describe: "List discovered tools and their enabled state.", builder: (c) => c.positional("name", { type: "string", demandOption: true }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as BaseArgs & { name: string };
            try { const client = await deps.authenticate(authInput(argv.server)); const tools = await client.api.getMcpAdminTools(argv.name); writeServerAdminSuccess(argv.format, { serverName: argv.name, tools, complete: true }, [`tools: ${tools.length}`, ...tools.map((tool) => `- ${safe(tool.name)} enabled=${String(tool.enabled)}`)]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "check <name>", describe: "Refresh a local MCP prerequisite check.", builder: (c) => c.positional("name", { type: "string", demandOption: true }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as McpMutationArgs;
            try { const client = await deps.authenticate(authInput(argv.server)); const before = await observeMcp(client, argv.name); if (!before.host.startsWith("relay-")) throw new Error("mcp_check_not_local"); await client.api.checkMcpAdminServer(argv.name); const observed = await observeMcp(client, argv.name); writeServerAdminSuccess(argv.format, { server: observed, observedAfterWrite: true }, [`checked: ${safe(observed.name)}`, `health: ${safe(observed.health)}`]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "enable <name>", describe: "Enable one MCP server using its observed revision.", builder: (c) => c.positional("name", { type: "string", demandOption: true }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as McpMutationArgs;
            try { const client = await deps.authenticate(authInput(argv.server)); const before = await observeMcp(client, argv.name); await client.api.setMcpAdminEnabled(argv.name, true, before.revision); const observed = await observeMcp(client, argv.name); writeServerAdminSuccess(argv.format, { server: observed, observedAfterWrite: true }, [`enabled: ${safe(observed.name)}`, `health: ${safe(observed.health)}`]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "disable <name>", describe: "Disable one MCP server using its observed revision.", builder: (c) => c.positional("name", { type: "string", demandOption: true }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as McpMutationArgs;
            try { const client = await deps.authenticate(authInput(argv.server)); const before = await observeMcp(client, argv.name); await client.api.setMcpAdminEnabled(argv.name, false, before.revision); const observed = await observeMcp(client, argv.name); writeServerAdminSuccess(argv.format, { server: observed, observedAfterWrite: true }, [`disabled: ${safe(observed.name)}`, `health: ${safe(observed.health)}`]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "tool <name> <tool> <state>", describe: "Enable or disable one discovered MCP tool using its server revision.", builder: (c) => c.positional("name", { type: "string", demandOption: true }).positional("tool", { type: "string", demandOption: true }).positional("state", { choices: ["enable", "disable"] as const, demandOption: true }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as McpMutationArgs & { tool: string; state: "enable" | "disable" };
            try { const client = await deps.authenticate(authInput(argv.server)); const before = await observeMcp(client, argv.name); await client.api.setMcpAdminToolEnabled(argv.name, argv.tool, argv.state === "enable", before.revision); const observed = await observeMcp(client, argv.name); const tools = await client.api.getMcpAdminTools(argv.name); writeServerAdminSuccess(argv.format, { server: observed, tools, observedAfterWrite: true }, [`server: ${safe(observed.name)}`, `tool: ${safe(argv.tool)} ${argv.state}d`]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .demandCommand(1, 1).strict(),
        handler: () => {},
      })
      .command({
        command: "google",
        describe: "Inspect or configure the server Google OAuth client.",
        builder: (child) => child
          .command({ command: "status", describe: "Show redacted Google OAuth client readiness.", builder: (c) => c.option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as BaseArgs; try { const client = await deps.authenticate(authInput(argv.server)); const status = await client.api.getGoogleIntegrationStatus(); writeServerAdminSuccess(argv.format, { ...status, oauthClientSecret: "write-only", userTokens: "excluded" }, [`configured: ${String(status.configured)}`, `clientId: ${safe(status.clientId)}`, "client secret: write-only", "user tokens: excluded"]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "configure", describe: "Upload OAuth client JSON from a protected descriptor.", builder: (c) => c.option("proof-fd", { type: "number", demandOption: true }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as GoogleMutationArgs; try { const client = await deps.authenticate(authInput(argv.server)); if (argv.proofFd === undefined) throw new Error("protected_input_required"); const secretJson = deps.readOAuthDescriptor(argv.proofFd); await client.api.configureGoogleOAuthClient(new Blob([secretJson], { type: "application/json" })); const observed = await client.api.getGoogleIntegrationStatus(); if (!observed.configured) throw new Error("google_not_configured"); writeServerAdminSuccess(argv.format, { ...observed, observedAfterWrite: true, oauthClientSecret: "write-only", userTokens: "excluded" }, [`configured: true`, `clientId: ${safe(observed.clientId)}`, "client secret: write-only"]); process.exitCode = 0; }
            catch (error) { const stable = error instanceof Error && error.message === "protected_input_required" ? { code: "protected_input_required", message: "Google OAuth client JSON requires --proof-fd." } : stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .command({ command: "remove", describe: "Remove the Google OAuth client configuration.", builder: (c) => c.option("yes", { type: "boolean", default: false }).option("format", { choices: ["human", "json"] as const, default: "human" }), handler: async (raw) => {
            const argv = raw as unknown as GoogleMutationArgs; if (!argv.yes) { writeServerAdminError(argv.format, "confirmation_required", "Google OAuth client removal requires --yes and disconnects future Google authorization setup."); process.exitCode = 2; return; }
            try { const client = await deps.authenticate(authInput(argv.server)); await client.api.removeGoogleOAuthClient(); const observed = await client.api.getGoogleIntegrationStatus(); if (observed.configured) throw new Error("google_still_configured"); writeServerAdminSuccess(argv.format, { ...observed, observedAfterWrite: true, oauthClientSecret: "removed", userTokens: "not_modified" }, ["configured: false", "existing user tokens: not modified"]); process.exitCode = 0; }
            catch (error) { const stable = stableError(error); writeServerAdminError(argv.format, stable.code, stable.message); process.exitCode = 2; }
          } })
          .demandCommand(1, 1).strict(),
        handler: () => {},
      })
      .demandCommand(1, 1).strict(),
    handler: () => {},
  };
}

export const integrationsModule = createIntegrationsModule();
