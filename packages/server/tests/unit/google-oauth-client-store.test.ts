import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGoogleOAuthClient,
  GOOGLE_OAUTH_CLIENT_JSON_ENV,
  getGoogleOAuthClient,
  googleOAuthClientStatus,
  isGoogleOAuthClientConfigured,
  setGoogleOAuthClient,
  validateGoogleOAuthClientJson,
} from "../../src/lib/google-oauth-client-store";
import {
  encodeGoogleOAuthClientJsonForEnv,
  resetConfigGuardRateLimitForTests,
} from "@nautilo/config-guard";

const VALID_INSTALLED = JSON.stringify({
  installed: {
    client_id: "111111111111-client.apps.googleusercontent.com",
    client_secret: "GOCSPX-store-test",
  },
});

let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
  delete process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
  else process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV] = prevEnv;
});

describe("google-oauth-client-store validation", () => {
  test("validateGoogleOAuthClientJson mirrors config-guard text validation", () => {
    const result = validateGoogleOAuthClientJson(VALID_INSTALLED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.maskedClientId).toContain("111111111111");
  });
});

describe("google-oauth-client-store env reads", () => {
  test("getGoogleOAuthClient decodes configured env", () => {
    process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV] =
      encodeGoogleOAuthClientJsonForEnv(VALID_INSTALLED);
    expect(getGoogleOAuthClient()).toBe(VALID_INSTALLED);
    expect(isGoogleOAuthClientConfigured()).toBe(true);
    const status = googleOAuthClientStatus();
    expect(status.configured).toBe(true);
    expect(status.clientId).toContain("111111111111");
  });

  test("getGoogleOAuthClient returns null for absent env", () => {
    expect(getGoogleOAuthClient()).toBeNull();
    expect(isGoogleOAuthClientConfigured()).toBe(false);
    expect(googleOAuthClientStatus()).toEqual({ configured: false, clientId: null });
  });

  test("getGoogleOAuthClient returns null for invalid stored payload", () => {
    process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV] = Buffer.from("{}", "utf8").toString("base64");
    expect(getGoogleOAuthClient()).toBeNull();
    expect(isGoogleOAuthClientConfigured()).toBe(false);
  });
});

// D445 Phase 0 — regression coverage through the real Google OAuth store +
// config-guard transaction under the compose env_file / container-local
// instance.env topology. The deployed contract: an explicit
// `NAUTILO_DOTENV_PATH` pointing at a writable mounted file shared with
// compose. A missing/unwritable canonical target must fail CLOSED before
// mutation so compose-injected provider keys survive in process.env.
const D445_VALID_GOOGLE_JSON = JSON.stringify({
  installed: {
    client_id: "222222222222-d445.apps.googleusercontent.com",
    client_secret: "GOCSPX-d445-store-regression",
  },
});
const D445_OPENAI = "sk-proj-d445-store-regression-fixture-999";
const D445_TAVILY = "tvly-d445-store-regression-999";

describe("google-oauth-client-store D445 Phase 0 canonical-target topology", () => {
  let home: string;
  let envPath: string;
  const prevHome = process.env["HOME"];
  const prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
  const prevNautiloHome = process.env["NAUTILO_HOME"];
  const prevOpenai = process.env["OPENAI_API_KEY"];
  const prevTavily = process.env["TAVILY_API_KEY"];
  const prevGoogle = process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "d445-store-"));
    envPath = join(home, "config", "instance.env");
    process.env["HOME"] = home;
    delete process.env["NAUTILO_HOME"];
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
    delete process.env["OPENAI_API_KEY"];
    delete process.env["TAVILY_API_KEY"];
    delete process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
    resetConfigGuardRateLimitForTests();
  });

  afterEach(async () => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["TAVILY_API_KEY"];
    delete process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    if (prevNautiloHome !== undefined) process.env["NAUTILO_HOME"] = prevNautiloHome;
    else delete process.env["NAUTILO_HOME"];
    if (prevDotenv !== undefined) process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    else delete process.env["NAUTILO_DOTENV_PATH"];
    if (prevOpenai !== undefined) process.env["OPENAI_API_KEY"] = prevOpenai;
    if (prevTavily !== undefined) process.env["TAVILY_API_KEY"] = prevTavily;
    if (prevGoogle !== undefined) process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV] = prevGoogle;
    await rm(home, { recursive: true, force: true });
    resetConfigGuardRateLimitForTests();
  });

  test("missing canonical target: set fails closed, preserves compose-injected provider keys, no secret in detail", async () => {
    process.env["OPENAI_API_KEY"] = D445_OPENAI;
    process.env["TAVILY_API_KEY"] = D445_TAVILY;

    const result = await setGoogleOAuthClient(D445_VALID_GOOGLE_JSON);

    expect(result.configured).toBe(false);
    if (result.configured) return;
    expect(result.detail).toContain("Canonical config target is missing");
    expect(result.detail).not.toContain("GOCSPX");
    expect(result.detail).not.toContain(D445_VALID_GOOGLE_JSON);
    expect(process.env["OPENAI_API_KEY"]).toBe(D445_OPENAI);
    expect(process.env["TAVILY_API_KEY"]).toBe(D445_TAVILY);
    expect(process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV]).toBeUndefined();
    expect(isGoogleOAuthClientConfigured()).toBe(false);
  });

  test("populated canonical target: set preserves providers on disk + process.env, then clear preserves providers", async () => {
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      envPath,
      `OPENAI_API_KEY=${D445_OPENAI}\nTAVILY_API_KEY=${D445_TAVILY}\n`,
      "utf-8",
    );
    process.env["OPENAI_API_KEY"] = D445_OPENAI;
    process.env["TAVILY_API_KEY"] = D445_TAVILY;

    const setResult = await setGoogleOAuthClient(D445_VALID_GOOGLE_JSON);
    expect(setResult.configured).toBe(true);
    if (!setResult.configured) return;
    expect(setResult.clientId).toContain("222222222222");
    expect(setResult.clientId).not.toContain("GOCSPX");

    const diskAfterSet = await readFile(envPath, "utf-8");
    expect(diskAfterSet).toContain("OPENAI_API_KEY=" + D445_OPENAI);
    expect(diskAfterSet).toContain("TAVILY_API_KEY=" + D445_TAVILY);
    expect(diskAfterSet).toContain(GOOGLE_OAUTH_CLIENT_JSON_ENV + "=");
    expect(process.env["OPENAI_API_KEY"]).toBe(D445_OPENAI);
    expect(process.env["TAVILY_API_KEY"]).toBe(D445_TAVILY);
    expect(process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV]).toBeDefined();
    expect(isGoogleOAuthClientConfigured()).toBe(true);

    const cleared = await clearGoogleOAuthClient();
    expect(cleared).toBe(true);

    const diskAfterClear = await readFile(envPath, "utf-8");
    expect(diskAfterClear).toContain("OPENAI_API_KEY=" + D445_OPENAI);
    expect(diskAfterClear).toContain("TAVILY_API_KEY=" + D445_TAVILY);
    expect(diskAfterClear).not.toContain(GOOGLE_OAUTH_CLIENT_JSON_ENV + "=");
    expect(process.env["OPENAI_API_KEY"]).toBe(D445_OPENAI);
    expect(process.env["TAVILY_API_KEY"]).toBe(D445_TAVILY);
    expect(process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV]).toBeUndefined();
    expect(isGoogleOAuthClientConfigured()).toBe(false);
  });

  test("durability: a recreated container re-reading the canonical file loads Google + providers", async () => {
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      envPath,
      `OPENAI_API_KEY=${D445_OPENAI}\nTAVILY_API_KEY=${D445_TAVILY}\n`,
      "utf-8",
    );
    process.env["OPENAI_API_KEY"] = D445_OPENAI;
    process.env["TAVILY_API_KEY"] = D445_TAVILY;

    const setResult = await setGoogleOAuthClient(D445_VALID_GOOGLE_JSON);
    expect(setResult.configured).toBe(true);

    const recreated = new Map<string, string>();
    for (const line of (await readFile(envPath, "utf-8")).split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) recreated.set(line.slice(0, eq), line.slice(eq + 1));
    }
    expect(recreated.get("OPENAI_API_KEY")).toBe(D445_OPENAI);
    expect(recreated.get("TAVILY_API_KEY")).toBe(D445_TAVILY);
    expect(recreated.get(GOOGLE_OAUTH_CLIENT_JSON_ENV)).toBeDefined();
    expect(recreated.get(GOOGLE_OAUTH_CLIENT_JSON_ENV)).not.toContain("GOCSPX");
  });
});
