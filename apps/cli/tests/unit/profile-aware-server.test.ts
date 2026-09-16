import { expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveServerForCommand,
  buildAuthHeaders,
  withUnixSocket,
  type ResolvedServer,
} from "../../src/lib/profile-aware-server.ts";
import { profilesRootDir } from "../../src/lib/api-client.ts";
import { writeBootstrapToken } from "../../src/lib/bootstrap-tokens.ts";

let tmpHome: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `nautilo-pas-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpHome, ".nautilo", "profiles"), { recursive: true, mode: 0o700 });
  // Clear NAUTILO_SERVER_URL before each test
  delete process.env["NAUTILO_SERVER_URL"];
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  // Restore env
  Object.assign(process.env, originalEnv);
  if (!originalEnv["NAUTILO_SERVER_URL"]) {
    delete process.env["NAUTILO_SERVER_URL"];
  }
});

function createProfile(
  home: string,
  name: string,
  transport: "local" | "remote",
  lifecycle: "compose" | "external",
  extras: { domain?: string; port?: number; host?: string; compose_dir?: string } = {},
): void {
  const doc: Record<string, unknown> = { name, transport, lifecycle };
  if (extras["domain"]) doc["domain"] = extras["domain"];
  if (extras["port"] !== undefined) doc["port"] = extras["port"];
  if (extras["host"]) doc["host"] = extras["host"];
  if (extras["compose_dir"]) doc["compose_dir"] = extras["compose_dir"];
  const toml = Object.entries(doc)
    .map(([k, v]) => {
      const rhs =
        typeof v === "string" ? `"${v}"` : typeof v === "number" ? String(v) : JSON.stringify(v);
      return `${k} = ${rhs}`;
    })
    .join("\n");
  writeFileSync(join(profilesRootDir(home), `${name}.toml`), toml, { mode: 0o644 });
}

function setActiveProfile(home: string, name: string): void {
  writeFileSync(join(profilesRootDir(home), ".active"), `${name}\n`, { mode: 0o600 });
}

// Test 1: --server flag wins over env, env wins over profile, profile wins over default
test("--server flag wins over env, env wins over profile, profile wins over default", async () => {
  // Setup active profile
  createProfile(tmpHome, "myprofile", "local", "compose");
  mkdirSync(join(tmpHome, ".nautilo"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tmpHome, ".nautilo", "instance.json"),
    JSON.stringify({ server: { port: 5000 } }),
    { mode: 0o600 },
  );
  setActiveProfile(tmpHome, "myprofile");

  // Default (no flag, no env, no active profile) - should give default URL
  const defaultResult = await resolveServerForCommand({ home: tmpHome + "-nonexistent" });
  expect(defaultResult.source).toBe("default");
  expect(defaultResult.baseUrl).toContain("http://");

  // Profile wins over default
  const profileResult = await resolveServerForCommand({ home: tmpHome });
  expect(profileResult.source).toBe("profile");
  expect(profileResult.baseUrl).toBe("http://127.0.0.1:5000");

  // Env wins over profile
  process.env["NAUTILO_SERVER_URL"] = "http://env-server.example.com:8080";
  const envResult = await resolveServerForCommand({ home: tmpHome });
  expect(envResult.source).toBe("env");
  expect(envResult.baseUrl).toBe("http://env-server.example.com:8080");

  // Flag wins over env
  const flagResult = await resolveServerForCommand({
    serverFlag: "http://flag-server.example.com:9000",
    home: tmpHome,
  });
  expect(flagResult.source).toBe("flag");
  expect(flagResult.baseUrl).toBe("http://flag-server.example.com:9000");
});

// Test 2: With an active local profile and an existing fake socket file, unixSocketPath is set
test("local profile with existing socket file sets unixSocketPath and baseUrl=localhost", async () => {
  // Create socket file
  mkdirSync(join(tmpHome, ".nautilo"), { recursive: true, mode: 0o700 });
  const sock = join(tmpHome, ".nautilo", "server.sock");
  writeFileSync(sock, "");

  // `lifecycle="external"` because the Unix-socket transport path is
  // the Bun-on-host dev-server flow; M092 compose-lifecycle profiles
  // route through `~/.nautilo${suffix}/instance.json` instead.
  createProfile(tmpHome, "localprof", "local", "external");
  setActiveProfile(tmpHome, "localprof");

  const result = await resolveServerForCommand({ home: tmpHome });

  expect(result.source).toBe("profile");
  expect(result.baseUrl).toBe("http://localhost");
  expect(result.unixSocketPath).toBe(sock);
  expect(result.bearer).toBeUndefined();
});

// Test 3: docker-compose profile with domain and bootstrap token file gives HTTPS baseUrl and bearer
test("docker-compose profile with domain and bootstrap token gives HTTPS baseUrl and bearer", async () => {
  writeBootstrapToken("remote", "mysecrettoken123", { home: tmpHome });

  createProfile(tmpHome, "remote", "remote", "external", { domain: "nautilo.example.com" });
  setActiveProfile(tmpHome, "remote");

  const result = await resolveServerForCommand({ home: tmpHome });

  expect(result.source).toBe("profile");
  expect(result.baseUrl).toBe("https://nautilo.example.com");
  expect(result.bearer).toBe("mysecrettoken123");
  expect(result.unixSocketPath).toBeUndefined();
});

test("docker-compose profile does NOT lazily migrate legacy .env (Phase 6); error points at doctor migrate-config", async () => {
  const envPath = join(profilesRootDir(tmpHome), "legacyremote.env");
  writeFileSync(envPath, "NAUTILO_BOOTSTRAP_TOKEN=migratedFromLegacy\n", { mode: 0o600 });
  createProfile(tmpHome, "legacyremote", "remote", "external", { domain: "legacy.example.com" });
  setActiveProfile(tmpHome, "legacyremote");

  expect(resolveServerForCommand({ home: tmpHome })).rejects.toThrow(
    /legacyremote.*nautilo doctor migrate-config/s,
  );
  expect(existsSync(envPath)).toBe(true);
});

// Test 4: Missing bootstrap token for remote profile produces error referencing profile name and paths
test("remote profile with missing bootstrap token throws error referencing profile name", async () => {
  const envPath = join(profilesRootDir(tmpHome), "badremote.env");
  writeFileSync(envPath, "SOME_OTHER_VAR=value\n", { mode: 0o600 });

  createProfile(tmpHome, "badremote", "remote", "external", { domain: "bad.example.com" });
  setActiveProfile(tmpHome, "badremote");

  expect(resolveServerForCommand({ home: tmpHome })).rejects.toThrow(
    /badremote.*bootstrap-tokens\/badremote/s,
  );
});

// Test 5: buildAuthHeaders with only transport bearer
test("buildAuthHeaders uses transport bearer when no session bearer", () => {
  const transport: ResolvedServer = {
    baseUrl: "https://example.com",
    bearer: "bootstrap-token-123",
    source: "profile",
  };
  const headers = buildAuthHeaders(transport, undefined);
  expect(headers["Authorization"]).toBe("Bearer bootstrap-token-123");
  expect(headers["Content-Type"]).toBe("application/json");
});

// Test 6: buildAuthHeaders with session bearer (session wins)
test("buildAuthHeaders prefers session bearer over transport bearer", () => {
  const transport: ResolvedServer = {
    baseUrl: "https://example.com",
    bearer: "bootstrap-token-123",
    source: "profile",
  };
  const headers = buildAuthHeaders(transport, "session-access-token-456");
  expect(headers["Authorization"]).toBe("Bearer session-access-token-456");
});

// Test 7: buildAuthHeaders with neither bearer
test("buildAuthHeaders has no Authorization when neither bearer exists", () => {
  const transport: ResolvedServer = {
    baseUrl: "http://localhost:3201",
    source: "default",
  };
  const headers = buildAuthHeaders(transport, undefined);
  expect(headers["Authorization"]).toBeUndefined();
  expect(headers["Content-Type"]).toBe("application/json");
});

// Test 8: withUnixSocket returns init unchanged when no unixSocketPath
test("withUnixSocket returns unchanged init when no unix socket", () => {
  const transport: ResolvedServer = {
    baseUrl: "http://localhost:3201",
    source: "default",
  };
  const init: RequestInit = { headers: { "X-Custom": "value" } };
  const result = withUnixSocket(transport, init);
  expect(result).toEqual(init);
});

// Test 9: withUnixSocket adds unix option when unixSocketPath exists
test("withUnixSocket adds unix option when unixSocketPath exists", () => {
  const transport: ResolvedServer = {
    baseUrl: "http://localhost",
    unixSocketPath: "/tmp/test.sock",
    source: "profile",
  };
  const init: RequestInit = { headers: { Authorization: "Bearer token" } };
  const result = withUnixSocket(transport, init);
  // Bun-specific unix socket option
  expect((result as RequestInit & { unix?: string }).unix).toBe("/tmp/test.sock");
  expect((result.headers as Record<string, string>)["Authorization"]).toBe("Bearer token");
});

// Test 10: Empty active profile file falls back to default
test("empty active profile file falls back to default", async () => {
  // Create empty .active file
  writeFileSync(join(profilesRootDir(tmpHome), ".active"), "", { mode: 0o600 });

  const result = await resolveServerForCommand({ home: tmpHome });
  expect(result.source).toBe("default");
});

// Test 11: Whitespace-only active profile falls back to default
test("whitespace-only active profile falls back to default", async () => {
  writeFileSync(join(profilesRootDir(tmpHome), ".active"), "   \n", { mode: 0o600 });

  const result = await resolveServerForCommand({ home: tmpHome });
  expect(result.source).toBe("default");
});
