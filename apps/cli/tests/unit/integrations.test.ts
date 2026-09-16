import { afterEach, beforeEach, expect, test } from "bun:test";
import yargs from "yargs/yargs";
import { createIntegrationsModule } from "../../src/commands/integrations.ts";
import type { AuthenticatedAdminClient } from "../../src/lib/authenticated-admin-client.ts";

let stdout = ""; let original: typeof process.stdout.write;
beforeEach(() => { stdout = ""; original = process.stdout.write; process.stdout.write = ((value: string | Uint8Array) => { stdout += typeof value === "string" ? value : Buffer.from(value).toString(); return true; }) as typeof process.stdout.write; });
afterEach(() => { process.stdout.write = original; process.exitCode = undefined; });

function client(): AuthenticatedAdminClient {
  return { whoami: { capabilities: ["read_server_settings"], sessionUserId: "u1" }, api: {
    getSetupStatus: async () => ({ providers: { hasLlm: true, hasVoice: false, hasSearch: true, hasConversion: false, managedByCloud: false } }),
    getConnections: async () => ({ status: "ok", connections: [] }),
    auditConnections: async () => ({ status: "ok", findings: [{ kind: "plaintext_config", severity: "warning", envVar: "SECRET_ENV", message: "secret detail" }] }),
    storeConnection: async (input: { service: string; field: string }) => ({ status: "stored", connection: { id: "c1", service: input.service, field: input.field, category: "user", namespace_id: "n1", agent_id: "a1", updated_at: "2026-08-12T00:00:00Z", expires_at: null, scope_label: "current room", configured: true, valid: null } }),
    deleteConnection: async (service: string, field: string) => ({ status: "missing", service, field }),
    listMcpAdminSummaries: async () => [{ id: "m1", name: "docs", host: "server", enabled: true, trustTier: "official", health: "connected", toolCount: 2, lastCheckStatus: "connected", lastCheckFailureCode: null, lastCheckedAt: "now", lastConnectedAt: "now", revision: "2026-08-12T00:00:00.000Z" }],
    getMcpAdminTools: async () => [{ name: "search", enabled: true }],
    checkMcpAdminServer: async () => ({ id: "m1", name: "docs", host: "server", enabled: true, trustTier: "official", health: "connected", toolCount: 2, lastCheckStatus: "connected", lastCheckFailureCode: null, lastCheckedAt: "now", lastConnectedAt: "now", revision: "2026-08-12T00:00:00.000Z" }),
    setMcpAdminEnabled: async (_name: string, enabled: boolean) => ({ id: "m1", name: "docs", host: "server", enabled, trustTier: "official", health: enabled ? "connected" : "disabled", toolCount: 2, lastCheckStatus: "connected", lastCheckFailureCode: null, lastCheckedAt: "now", lastConnectedAt: "now", revision: "2026-08-12T00:00:00.000Z" }),
    setMcpAdminToolEnabled: async () => ({ server: { id: "m1", name: "docs", host: "server", enabled: true, trustTier: "official", health: "connected", toolCount: 2, lastCheckStatus: "connected", lastCheckFailureCode: null, lastCheckedAt: "now", lastConnectedAt: "now", revision: "2026-08-12T00:00:00.000Z" }, tools: [{ name: "search", enabled: false }] }),
    getGoogleIntegrationStatus: async () => ({ configured: true, clientId: "google-client" }),
    configureGoogleOAuthClient: async () => ({ configured: true, clientId: "google-client" }),
    removeGoogleOAuthClient: async () => ({ configured: false }),
  } } as unknown as AuthenticatedAdminClient;
}

async function run(args: string[], admin = client(), deps: Parameters<typeof createIntegrationsModule>[0] = {}) {
  await yargs(args).exitProcess(false).command(createIntegrationsModule({ authenticate: async () => admin, ...deps })).strict().parseAsync();
}

test("provider status is secret-free readiness only", async () => {
  await run(["integrations", "providers", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { llm: true, search: true, validation: "not-run" } });
  expect(stdout).not.toMatch(/envVar|masked|signup|fragment/i);
});

test("Connection audit strips internal messages and environment names", async () => {
  await run(["integrations", "connections", "audit", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { findings: [{ kind: "plaintext_config", severity: "warning" }] } });
  expect(stdout).not.toContain("SECRET_ENV"); expect(stdout).not.toContain("secret detail");
});

test("Connection set requires protected input and never returns its value", async () => {
  let captured = ""; const admin = client();
  (admin.api as unknown as { storeConnection(input: { value: string }): Promise<unknown> }).storeConnection = async (input) => { captured = input.value; return { status: "stored", connection: { id: "c1", service: "svc", field: "key", category: "user", namespace_id: "n1", agent_id: "a1", updated_at: "now", expires_at: null, scope_label: "current room", configured: true, valid: null } }; };
  await run(["integrations", "connections", "set", "svc", "key", "--proof-fd", "7", "--format", "json"], admin, { readDescriptor: () => "canary-secret" });
  expect(captured).toBe("canary-secret"); expect(stdout).not.toContain("canary-secret");
});

test("Connection removal is confirm-first and idempotent", async () => {
  await run(["integrations", "connections", "remove", "svc", "key", "--yes", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { status: "missing", stateChanged: false } });
});

test("MCP and Google reads expose only bounded redacted projections", async () => {
  await run(["integrations", "mcp", "list", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { servers: [{ name: "docs", health: "connected" }], complete: true } });
  expect(stdout).not.toMatch(/transport|environment|command|header/i);
  stdout = "";
  await run(["integrations", "google", "status", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { configured: true, clientId: "google-client", oauthClientSecret: "write-only", userTokens: "excluded" } });
});

test("MCP reversible state commands are direct and return observation-only projections", async () => {
  await run(["integrations", "mcp", "enable", "docs", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { server: { name: "docs" }, observedAfterWrite: true } });
  stdout = "";
  await run(["integrations", "mcp", "tool", "docs", "search", "disable", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { server: { name: "docs" }, observedAfterWrite: true } });
  expect(stdout).not.toMatch(/transport|environment|command|header/i);
});

test("Google configure accepts OAuth JSON only through the protected descriptor", async () => {
  const admin = client(); let captured = "";
  (admin.api as unknown as { configureGoogleOAuthClient(value: Blob): Promise<unknown> }).configureGoogleOAuthClient = async (value) => { captured = await value.text(); return { configured: true, clientId: "google-client" }; };
  await run(["integrations", "google", "configure", "--proof-fd", "9", "--format", "json"], admin, { readOAuthDescriptor: () => '{"installed":{"client_secret":"canary-google-secret"}}' });
  expect(captured).toContain("canary-google-secret");
  expect(stdout).not.toContain("canary-google-secret");
  expect(JSON.parse(stdout)).toMatchObject({ data: { configured: true, observedAfterWrite: true, oauthClientSecret: "write-only" } });
});
