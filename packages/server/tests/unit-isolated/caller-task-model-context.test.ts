import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const HUMAN = "11111111-1111-4111-8111-111111111111";
let capabilities: string[] = ["use_personal_provider_credentials"];
let personalProviders = ["gateway", "openrouter"];

const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");

mock.module("@nautilo/db", () => ({
  ...actualDb,
  getServerProviderPolicy: async () => ({
    allowPersonalProviderKeys: true,
    fundingPreference: "personal_first" as const,
  }),
  listPersonalProviderCredentials: async () => personalProviders.map((provider) => ({ provider })),
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: async () => capabilities,
}));
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => ({}) }));

const { callerTaskModelEnvironment } = await import("../../src/lib/caller-task-model-context");

const previousGatewayKey = process.env["NAUTILO_GATEWAY_API_KEY"];
const previousGatewayBase = process.env["NAUTILO_GATEWAY_BASE_URL"];

beforeEach(() => {
  capabilities = ["use_personal_provider_credentials"];
  personalProviders = ["gateway", "openrouter"];
  process.env["NAUTILO_GATEWAY_API_KEY"] = "server-gateway-secret";
  process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://gateway.invalid/v1";
});

afterAll(() => {
  if (previousGatewayKey === undefined) delete process.env["NAUTILO_GATEWAY_API_KEY"];
  else process.env["NAUTILO_GATEWAY_API_KEY"] = previousGatewayKey;
  if (previousGatewayBase === undefined) delete process.env["NAUTILO_GATEWAY_BASE_URL"];
  else process.env["NAUTILO_GATEWAY_BASE_URL"] = previousGatewayBase;
  mock.restore();
});

describe("caller task model environment", () => {
  test("ignores a retained personal Gateway row while projecting supported personal providers", async () => {
    const env = await callerTaskModelEnvironment(HUMAN);

    expect(env["OPENROUTER_API_KEY"]).toBe("configured");
    expect(env["NAUTILO_GATEWAY_API_KEY"]).toBeUndefined();
    expect(env["NAUTILO_GATEWAY_BASE_URL"]).toBeUndefined();
  });

  test("preserves an administrator Gateway only for a caller with server credential authority", async () => {
    capabilities = ["use_personal_provider_credentials", "use_server_provider_credentials"];
    const env = await callerTaskModelEnvironment(HUMAN);

    expect(env["NAUTILO_GATEWAY_API_KEY"]).toBe("server-gateway-secret");
    expect(env["NAUTILO_GATEWAY_BASE_URL"]).toBe("https://gateway.invalid/v1");
  });
});
