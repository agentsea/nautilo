import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliSessionSecurityError, NautiloApiClient, type CliSessionV1Payload } from "@nautilo/api-client";
import {
  AuthenticatedAdminClientError,
  createAuthenticatedAdminClient,
  createRestrictedPasswordChangeClient,
  resolveHumanServer,
  sessionTargetBindingFor,
  assertSafeLogtoIssuer,
  type AuthenticatedAdminErrorCode,
  type AuthenticatedWhoami,
} from "../../src/lib/authenticated-admin-client.ts";
import type { ResolvedServer } from "../../src/lib/profile-aware-server.ts";

const transport: ResolvedServer = {
  baseUrl: "https://server.example",
  source: "profile",
};

function session(overrides: Partial<CliSessionV1Payload> = {}): CliSessionV1Payload {
  return {
    schemaVersion: 1,
    instanceId: "instance-a",
    serverUrl: "https://server.example/",
    handle: "alice",
    displayName: "Alice",
    externalId: "user-a",
    targetBinding: { kind: "http-origin", value: "https://server.example" },
    authBinding: {
      flow: "device",
      issuer: "https://persisted-logto.example",
      clientId: "persisted-device-app",
      resource: "https://persisted-api.example",
    },
    revision: "revision-a",
    accessToken: "access-a",
    refreshToken: "refresh-a",
    tokenType: "Bearer",
    expiresAt: 200_000,
    scopes: [],
    source: "device",
    obtainedAt: 1,
    ...overrides,
  };
}

function api(health: {
  status: string;
  logtoEndpoint?: string | null;
  logtoTuiAppId?: string | null;
  logtoTuiLoopbackAppId?: string | null;
  logtoResource?: string | null;
} = {
  status: "ok",
  logtoEndpoint: "https://logto.example",
  logtoTuiAppId: "app-a",
  logtoResource: "https://api.example",
}): NautiloApiClient {
  const client = new NautiloApiClient("https://server.example");
  client.getHealth = async () => health;
  return client;
}

function dependencies(
  stored: CliSessionV1Payload | null,
  overrides: Parameters<typeof createAuthenticatedAdminClient>[1] = {},
) {
  return {
    resolveServer: async () => transport,
    readActiveProfileName: () => "prod",
    profileInstanceId: () => "instance-a",
    sessions: {
      migrateLegacy: async () => false,
      load: async () => stored,
      compareAndSwap: async () => true,
    },
    createApiClient: () => api(),
    fetchWhoami: async () => ({ sessionUserId: "user-a", instanceId: "instance-a" } as AuthenticatedWhoami),
    now: () => 1_000,
    ...overrides,
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: AuthenticatedAdminErrorCode,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected an authenticated-client error");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthenticatedAdminClientError);
    expect((error as AuthenticatedAdminClientError).code).toBe(code);
    expect((error as Error).message).not.toContain("access-a");
    expect((error as Error).message).not.toContain("refresh-a");
  }
}

describe("createAuthenticatedAdminClient", () => {
  test("rejects a missing session as login_required", async () => {
    await expectCode(createAuthenticatedAdminClient({}, dependencies(null)), "login_required");
  });

  test("migrates legacy state before loading the selected profile session", async () => {
    const migrations: string[] = [];
    const result = await createAuthenticatedAdminClient(
      {},
      dependencies(session(), {
        sessions: {
          migrateLegacy: async (name) => {
            migrations.push(name);
            return true;
          },
          load: async () => session(),
          compareAndSwap: async () => true,
        },
      }),
    );
    expect(migrations).toEqual(["prod"]);
    expect(result.api.getToken()).toBe("access-a");
    expect("session" in result).toBe(false);
  });

  test("constructs a canonical client for a valid bound session", async () => {
    const result = await createAuthenticatedAdminClient({}, dependencies(session()));
    expect(result.transport).toBe(transport);
    expect(result.profileName).toBe("prod");
    expect(result.identity.handle).toBe("alice");
  });

  test("blocks admin clients while allowing the narrow password-change client", async () => {
    const restricted = dependencies(session(), {
      fetchWhoami: async () => ({
        sessionUserId: "user-a",
        instanceId: "instance-a",
        mustChangePassword: true,
      } as AuthenticatedWhoami),
    });
    await expectCode(createAuthenticatedAdminClient({}, restricted), "password_change_required");
    const recovery = await createRestrictedPasswordChangeClient({}, restricted);
    expect(recovery.whoami.mustChangePassword).toBe(true);
    expect("identity" in recovery).toBe(false);
  });

  test("refreshes an expired or near-expiry session once and rotates it by CAS", async () => {
    const calls: string[] = [];
    const original = session({ expiresAt: 1_050 });
    const result = await createAuthenticatedAdminClient(
      {},
      dependencies(original, {
        refresh: async (input) => {
          calls.push(input.refreshToken);
          expect(input.appId).toBe("persisted-device-app");
          expect(input.endpoint).toBe("https://persisted-logto.example");
          expect(input.resource).toBe("https://persisted-api.example");
          return {
            kind: "ok",
            tokens: {
              access_token: "access-b",
              refresh_token: "refresh-b",
              id_token: "",
              expires_in: 3600,
            },
          };
        },
        sessions: {
          migrateLegacy: async () => false,
          load: async () => original,
          compareAndSwap: async (expected, replacement) => {
            expect(expected).toBe("revision-a");
            expect(replacement.refreshToken).toBe("refresh-b");
            return true;
          },
        },
      }),
    );
    expect(calls).toEqual(["refresh-a"]);
    expect(result.api.getToken()).toBe("access-b");
  });

  test("requires login when refresh is revoked and preserves the stored session", async () => {
    let compareAndSwapCalled = false;
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session({ expiresAt: 1_050 }), {
          refresh: async () => ({ kind: "invalid_grant" }),
          sessions: {
            migrateLegacy: async () => false,
            load: async () => session({ expiresAt: 1_050 }),
            compareAndSwap: async () => {
              compareAndSwapCalled = true;
              return true;
            },
          },
        }),
      ),
      "refresh_revoked",
    );
    expect(compareAndSwapCalled).toBe(false);
  });

  test("preserves session and forbids domain use on transient refresh failure", async () => {
    let whoamiCalled = false;
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session({ expiresAt: 1_050 }), {
          refresh: async () => ({ kind: "transient", reason: "network" }),
          fetchWhoami: async () => {
            whoamiCalled = true;
            return { sessionUserId: "user-a", instanceId: "instance-a" } as AuthenticatedWhoami;
          },
        }),
      ),
      "refresh_transient",
    );
    expect(whoamiCalled).toBe(false);
  });

  test("rejects a concurrent rotation rather than overwriting it", async () => {
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session({ expiresAt: 1_050 }), {
          refresh: async () => ({
            kind: "ok",
            tokens: { access_token: "access-b", refresh_token: "refresh-b", id_token: "", expires_in: 60 },
          }),
          sessions: {
            migrateLegacy: async () => false,
            load: async () => session({ expiresAt: 1_050 }),
            compareAndSwap: async () => false,
          },
        }),
      ),
      "session_rotation_conflict",
    );
  });

  test("uses the loopback Logto client for a browser refresh", async () => {
    const original = session({
      expiresAt: 1_050,
      authBinding: {
        flow: "browser_loopback",
        issuer: "https://persisted-browser-logto.example",
        clientId: "persisted-browser-app",
        resource: "https://persisted-browser-api.example",
      },
    });
    await createAuthenticatedAdminClient(
      {},
      dependencies(original, {
        createApiClient: () => api({
          status: "ok",
          logtoEndpoint: "https://logto.example",
          logtoTuiLoopbackAppId: "loopback-app",
          logtoTuiAppId: "device-app",
          logtoResource: "https://api.example",
        }),
        refresh: async (input) => {
          expect(input.appId).toBe("persisted-browser-app");
          expect(input.endpoint).toBe("https://persisted-browser-logto.example");
          expect(input.resource).toBe("https://persisted-browser-api.example");
          return {
            kind: "ok",
            tokens: { access_token: "access-b", refresh_token: "refresh-b", id_token: "", expires_in: 60 },
          };
        },
      }),
    );
  });

  test("requires re-login before refreshing a legacy session without flow and revision metadata", async () => {
    let refreshCalled = false;
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session({ expiresAt: 1_050, authBinding: undefined, revision: undefined }), {
          refresh: async () => {
            refreshCalled = true;
            return { kind: "invalid_grant" };
          },
        }),
      ),
      "session_expired",
    );
    expect(refreshCalled).toBe(false);
  });

  test("reactively refreshes once after whoami 401 and retries only whoami", async () => {
    let refreshes = 0;
    let whoamiCalls = 0;
    const original = session({ expiresAt: 200_000 });
    const result = await createAuthenticatedAdminClient(
      {},
      dependencies(original, {
        refresh: async () => {
          refreshes += 1;
          return {
            kind: "ok",
            tokens: { access_token: "access-b", refresh_token: "refresh-b", id_token: "", expires_in: 60 },
          };
        },
        fetchWhoami: async () => {
          whoamiCalls += 1;
          if (whoamiCalls === 1) throw new AuthenticatedAdminClientError("session_expired");
          return { sessionUserId: "user-a", instanceId: "instance-a" } as AuthenticatedWhoami;
        },
      }),
    );
    expect(refreshes).toBe(1);
    expect(whoamiCalls).toBe(2);
    expect(result.api.getToken()).toBe("access-b");
  });

  test("fails closed before whoami when the cached target differs", async () => {
    let whoamiCalled = false;
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session({
          serverUrl: "https://other.example",
          targetBinding: { kind: "http-origin", value: "https://other.example" },
        }), {
          fetchWhoami: async () => {
            whoamiCalled = true;
            return { sessionUserId: "user-a", instanceId: "instance-a" } as AuthenticatedWhoami;
          },
        }),
      ),
      "target_mismatch",
    );
    expect(whoamiCalled).toBe(false);
  });

  test("fails closed when a Unix target lacks its exact persisted binding", async () => {
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session(), {
          resolveServer: async () => ({ ...transport, baseUrl: "http://localhost", unixSocketPath: "/tmp/nautilo.sock" }),
        }),
      ),
      "target_mismatch",
    );
  });

  test("accepts only the exact persisted canonical Unix target binding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-auth-client-unix-"));
    const socket = join(dir, "server.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    try {
      const unixTransport: ResolvedServer = {
        baseUrl: "http://localhost",
        unixSocketPath: socket,
        source: "profile",
      };
      const bound = session({
        serverUrl: "http://localhost",
        targetBinding: { kind: "unix-socket", value: join(realpathSync(dir), "server.sock") },
      });
      await createAuthenticatedAdminClient(
        {},
        dependencies(bound, { resolveServer: async () => unixTransport }),
      );
      await expectCode(
        createAuthenticatedAdminClient(
          {},
          dependencies(session({ serverUrl: "http://localhost", targetBinding: undefined }), {
            resolveServer: async () => unixTransport,
          }),
        ),
        "target_mismatch",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a regular file presented as a Unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-auth-client-unix-file-"));
    const path = join(dir, "not-a-socket");
    writeFileSync(path, "fixture");
    try {
      await expectCode(
        sessionTargetBindingFor({ baseUrl: "http://localhost", unixSocketPath: path, source: "profile" }),
        "target_mismatch",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checks the selected profile instance before transmitting a Human bearer", async () => {
    let whoamiCalled = false;
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session(), {
          profileInstanceId: () => "instance-b",
          fetchWhoami: async () => {
            whoamiCalled = true;
            return { sessionUserId: "user-a", instanceId: "instance-b" } as AuthenticatedWhoami;
          },
        }),
      ),
      "instance_mismatch",
    );
    expect(whoamiCalled).toBe(false);
  });

  test("rejects a fresh whoami response from another instance", async () => {
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session(), {
          fetchWhoami: async () => ({ sessionUserId: "user-a", instanceId: "instance-b" } as AuthenticatedWhoami),
        }),
      ),
      "instance_mismatch",
    );
  });

  test("rejects a malformed whoami projection and redacts an injected transport failure", async () => {
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session(), { fetchWhoami: async () => ({} as AuthenticatedWhoami) }),
      ),
      "session_expired",
    );
    await expectCode(
      createAuthenticatedAdminClient(
        {},
        dependencies(session(), {
          fetchWhoami: async () => {
            throw new Error("access-a refresh-a upstream body");
          },
        }),
      ),
      "transport_unreachable",
    );
  });

  test("classifies a malformed canonical whoami body without falling back to guest", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ malformed: true }), { status: 200 }),
    );
    try {
      const stored = session();
      await expectCode(
        createAuthenticatedAdminClient({}, {
          resolveServer: async () => transport,
          readActiveProfileName: () => "prod",
          profileInstanceId: () => "instance-a",
          sessions: {
            migrateLegacy: async () => false,
            load: async () => stored,
            compareAndSwap: async () => true,
          },
          now: () => 1_000,
        }),
        "invalid_server_response",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("rejects a cleartext non-loopback Human endpoint", async () => {
    await expectCode(resolveHumanServer({ serverFlag: "http://server.example" }), "target_mismatch");
    await expectCode(resolveHumanServer({ serverFlag: "https://server.example/path" }), "target_mismatch");
    await expectCode(resolveHumanServer({ serverFlag: "https://user:pass@server.example" }), "target_mismatch");
    await expectCode(resolveHumanServer({ serverFlag: "https://server.example?query=1" }), "target_mismatch");
  });

  test("validates an active profile identifier before resolving an override endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-auth-invalid-profile-"));
    const previousHome = process.env["HOME"];
    process.env["HOME"] = dir;
    try {
      const profiles = join(dir, ".nautilo", "profiles");
      mkdirSync(profiles, { recursive: true });
      writeFileSync(join(profiles, ".active"), "../invalid\n");
      expect(resolveHumanServer({ serverFlag: "https://server.example" })).rejects.toBeInstanceOf(CliSessionSecurityError);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects decorated or non-loopback Logto issuers before token refresh", () => {
    expect(() => assertSafeLogtoIssuer("http://logto.example")).toThrow(AuthenticatedAdminClientError);
    expect(() => assertSafeLogtoIssuer("https://user:pass@logto.example")).toThrow(AuthenticatedAdminClientError);
    expect(() => assertSafeLogtoIssuer("https://logto.example/oidc")).toThrow(AuthenticatedAdminClientError);
    expect(() => assertSafeLogtoIssuer("http://127.0.0.1:3001")).not.toThrow();
  });
});
