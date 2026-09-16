/**
 * M196 — unit tests for Google Workspace OAuth pure helpers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  canAdvertiseGoogleWorkspaceCapability,
  ensureGoogleOAuthClientConfig,
  ensureGogKeyringBackend,
  ensureGogKeyringPasswordEnv,
  googleAuthRequiredDispatchResult,
  GOOGLE_AUTH_REQUIRED_ERROR_CODE,
  hasHealthyGogAuthAccount,
  isLikelyGogAuthFailure,
  isValidConnectEmail,
  parseGogAuthListAccounts,
  queryGoogleOAuthConfigured,
  resolveGogKeyringBackend,
} from "../../electron/google-workspace-oauth";

describe("canAdvertiseGoogleWorkspaceCapability", () => {
  test("advertises a runnable gog with a healthy local account and no server OAuth", () => {
    expect(
      canAdvertiseGoogleWorkspaceCapability({
        gogRunnable: true,
        serverOAuthConfigured: false,
        localGogAuthHealthy: true,
      }),
    ).toBe(true);
  });

  test("advertises a runnable gog through the server-managed OAuth path", () => {
    expect(
      canAdvertiseGoogleWorkspaceCapability({
        gogRunnable: true,
        serverOAuthConfigured: true,
        localGogAuthHealthy: false,
      }),
    ).toBe(true);
  });

  test("does not advertise a runnable gog without usable authentication", () => {
    expect(
      canAdvertiseGoogleWorkspaceCapability({
        gogRunnable: true,
        serverOAuthConfigured: false,
        localGogAuthHealthy: false,
      }),
    ).toBe(false);
  });

  test("does not advertise an unrunnable gog even with OAuth configuration", () => {
    expect(
      canAdvertiseGoogleWorkspaceCapability({
        gogRunnable: false,
        serverOAuthConfigured: true,
        localGogAuthHealthy: true,
      }),
    ).toBe(false);
  });
});

describe("hasHealthyGogAuthAccount", () => {
  test("accepts an array with a valid account", () => {
    expect(hasHealthyGogAuthAccount(JSON.stringify([{ email: "a@example.com", valid: true }]))).toBe(
      true,
    );
  });

  test("accepts the gog { accounts } shape with a valid account", () => {
    expect(
      hasHealthyGogAuthAccount(
        JSON.stringify({ accounts: [{ email: "a@example.com", valid: true }] }),
      ),
    ).toBe(true);
  });

  test("rejects accounts whose token check failed despite a successful command", () => {
    expect(
      hasHealthyGogAuthAccount(
        JSON.stringify([
          { email: "a@example.com", valid: false, error: "token refresh failed" },
        ]),
      ),
    ).toBe(false);
  });

  test("rejects empty account lists", () => {
    expect(hasHealthyGogAuthAccount(JSON.stringify({ accounts: [] }))).toBe(false);
  });

  test("rejects malformed and legacy string-only output", () => {
    expect(hasHealthyGogAuthAccount("not json a@example.com")).toBe(false);
    expect(hasHealthyGogAuthAccount(JSON.stringify(["a@example.com"]))).toBe(false);
  });
});

describe("resolveGogKeyringBackend", () => {
  test("defaults to file", () => {
    expect(resolveGogKeyringBackend({})).toBe("file");
  });

  test("honors keychain and auto overrides (case-insensitive)", () => {
    expect(resolveGogKeyringBackend({ NAUTILO_GOG_KEYRING: "keychain" })).toBe("keychain");
    expect(resolveGogKeyringBackend({ NAUTILO_GOG_KEYRING: "AUTO" })).toBe("auto");
    expect(resolveGogKeyringBackend({ NAUTILO_GOG_KEYRING: "nonsense" })).toBe("file");
  });
});

describe("ensureGogKeyringBackend", () => {
  test("runs `auth keyring set file` by default", async () => {
    const calls: Array<readonly string[]> = [];
    await ensureGogKeyringBackend("/opt/homebrew/bin/gog", async (_bin, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    expect(calls).toEqual([["auth", "keyring", "set", "file"]]);
  });

  test("never throws when the backend command fails", async () => {
    await ensureGogKeyringBackend("/opt/homebrew/bin/gog", async () => {
      throw new Error("boom");
    });
  });
});

describe("ensureGogKeyringPasswordEnv", () => {
  const prev = process.env["GOG_KEYRING_PASSWORD"];
  afterEach(() => {
    if (prev === undefined) delete process.env["GOG_KEYRING_PASSWORD"];
    else process.env["GOG_KEYRING_PASSWORD"] = prev;
  });

  test("generates + persists a password and exports it when missing", () => {
    delete process.env["GOG_KEYRING_PASSWORD"];
    const writes: Array<{ path: string; data: string; mode: number }> = [];
    ensureGogKeyringPasswordEnv("/tmp/userData/gog-keyring-password", {
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: (p, data, opts) => writes.push({ path: p, data, mode: opts.mode }),
      randomPassword: () => "deadbeef",
    });
    expect(writes).toEqual([
      { path: "/tmp/userData/gog-keyring-password", data: "deadbeef\n", mode: 0o600 },
    ]);
    expect(process.env["GOG_KEYRING_PASSWORD"]).toBe("deadbeef");
  });

  test("reuses an existing password file without rewriting", () => {
    delete process.env["GOG_KEYRING_PASSWORD"];
    let wrote = false;
    ensureGogKeyringPasswordEnv("/tmp/userData/gog-keyring-password", {
      existsSync: () => true,
      readFileSync: () => "stored-pw\n",
      writeFileSync: () => {
        wrote = true;
      },
      randomPassword: () => "should-not-be-used",
    });
    expect(wrote).toBe(false);
    expect(process.env["GOG_KEYRING_PASSWORD"]).toBe("stored-pw");
  });

  test("respects a preset env password", () => {
    process.env["GOG_KEYRING_PASSWORD"] = "operator-set";
    let touched = false;
    ensureGogKeyringPasswordEnv("/tmp/userData/gog-keyring-password", {
      existsSync: () => {
        touched = true;
        return true;
      },
      readFileSync: () => "x",
      writeFileSync: () => {
        touched = true;
      },
      randomPassword: () => "y",
    });
    expect(touched).toBe(false);
    expect(process.env["GOG_KEYRING_PASSWORD"]).toBe("operator-set");
  });
});

describe("queryGoogleOAuthConfigured", () => {
  test("returns true only on 200 with configured:true", async () => {
    const fetchImpl = async () =>
      ({
        status: 200,
        ok: true,
        json: async () => ({ configured: true }),
      }) as Response;
    expect(await queryGoogleOAuthConfigured("https://nautilo.test", "tok", fetchImpl)).toBe(true);
  });

  test("returns false when configured is not true", async () => {
    const fetchImpl = async () =>
      ({
        status: 200,
        ok: true,
        json: async () => ({ configured: false }),
      }) as Response;
    expect(await queryGoogleOAuthConfigured("https://nautilo.test", "tok", fetchImpl)).toBe(false);
  });

  test("returns false for 401/403/404", async () => {
    for (const status of [401, 403, 404]) {
      const fetchImpl = async () => ({ status, ok: false }) as Response;
      expect(await queryGoogleOAuthConfigured("https://nautilo.test", "tok", fetchImpl)).toBe(
        false,
      );
    }
  });

  test("returns false on network failure", async () => {
    const fetchImpl = async () => {
      throw new Error("offline");
    };
    expect(await queryGoogleOAuthConfigured("https://nautilo.test", "tok", fetchImpl)).toBe(false);
  });
});

describe("ensureGoogleOAuthClientConfig", () => {
  test("writes oauth client with mode 0600 and imports credentials", async () => {
    const writes: Array<{ path: string; data: string; mode: number }> = [];
    const execCalls: Array<{ bin: string; args: readonly string[] }> = [];

    const result = await ensureGoogleOAuthClientConfig(
      "https://nautilo.test",
      "access-token",
      {
        fetchImpl: async () =>
          ({
            status: 200,
            ok: true,
            text: async () => '{"installed":{"client_id":"abc"}}',
          }) as Response,
        existsSync: () => false,
        writeFile: async (filePath, data, opts) => {
          writes.push({ path: filePath, data, mode: opts.mode });
        },
        execFileAsync: async (bin, args) => {
          execCalls.push({ bin, args });
          return { stdout: "", stderr: "" };
        },
        resolveGogBin: () => "/opt/homebrew/bin/gog",
        oauthClientPath: "/tmp/userData/google-oauth-client.json",
      },
    );

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual([
      {
        path: "/tmp/userData/google-oauth-client.json",
        data: '{"installed":{"client_id":"abc"}}',
        mode: 0o600,
      },
    ]);
    expect(execCalls).toEqual([
      {
        bin: "/opt/homebrew/bin/gog",
        args: ["auth", "keyring", "set", "file"],
      },
      {
        bin: "/opt/homebrew/bin/gog",
        args: ["auth", "credentials", "/tmp/userData/google-oauth-client.json"],
      },
    ]);
  });

  test("uses existing local oauth client without downloading", async () => {
    let fetchCalled = false;
    const execCalls: Array<{ bin: string; args: readonly string[] }> = [];

    const result = await ensureGoogleOAuthClientConfig(
      "https://nautilo.test",
      "access-token",
      {
        fetchImpl: async () => {
          fetchCalled = true;
          return { status: 500, ok: false } as Response;
        },
        existsSync: () => true,
        writeFile: async () => {
          throw new Error("writeFile should not run for existing config");
        },
        execFileAsync: async (bin, args) => {
          execCalls.push({ bin, args });
          return { stdout: "", stderr: "" };
        },
        resolveGogBin: () => "/opt/homebrew/bin/gog",
        oauthClientPath: "/tmp/userData/google-oauth-client.json",
      },
    );

    expect(result).toEqual({ ok: true });
    expect(fetchCalled).toBe(false);
    expect(execCalls).toEqual([
      {
        bin: "/opt/homebrew/bin/gog",
        args: ["auth", "keyring", "set", "file"],
      },
      {
        bin: "/opt/homebrew/bin/gog",
        args: ["auth", "credentials", "/tmp/userData/google-oauth-client.json"],
      },
    ]);
  });
});

describe("googleAuthRequiredDispatchResult", () => {
  test("returns stable errorCode and message", () => {
    expect(googleAuthRequiredDispatchResult()).toEqual({
      status: "error",
      errorCode: GOOGLE_AUTH_REQUIRED_ERROR_CODE,
      error: expect.stringContaining("Connect Google Workspace"),
    });
  });
});

describe("isLikelyGogAuthFailure", () => {
  test("detects auth-shaped gog stderr", () => {
    expect(isLikelyGogAuthFailure("token refresh failed")).toBe(true);
    expect(
      isLikelyGogAuthFailure(
        "OAuth client credentials missing (OAuth client ID JSON).",
      ),
    ).toBe(true);
    expect(isLikelyGogAuthFailure("permission denied for path")).toBe(false);
  });
});

describe("isValidConnectEmail", () => {
  test("requires non-empty string containing @", () => {
    expect(isValidConnectEmail("user@example.com")).toBe(true);
    expect(isValidConnectEmail("")).toBe(false);
    expect(isValidConnectEmail("not-an-email")).toBe(false);
  });
});

describe("parseGogAuthListAccounts", () => {
  test("parses accounts array from json stdout", () => {
    expect(
      parseGogAuthListAccounts(
        JSON.stringify([{ email: "a@example.com" }, { email: "b@example.com" }]),
      ),
    ).toEqual(["a@example.com", "b@example.com"]);
  });
});
