/**
 * M196 — unit tests for Google Workspace auth connect flow (injected deps).
 */

import { describe, expect, test } from "bun:test";
import {
  googleWorkspaceConnect,
  type GoogleWorkspaceAuthDeps,
} from "../../electron/google-workspace-oauth";

function makeDeps(overrides: Partial<GoogleWorkspaceAuthDeps> = {}): GoogleWorkspaceAuthDeps {
  return {
    fetchImpl: async () =>
      ({
        status: 200,
        ok: true,
        text: async () => '{"installed":{"client_id":"abc"}}',
      }) as Response,
    writeFile: async () => {},
    execFileAsync: async () => ({ stdout: "", stderr: "" }),
    existsSync: () => false,
    resolveGogBin: () => "/opt/homebrew/bin/gog",
    isGogAuthHealthy: async () => true,
    authorizeGogAccount: async ({ onAuthorized }) => {
      try {
        await onAuthorized();
        return { ok: true };
      } catch {
        return { ok: false, reason: "gog_auth_add_failed" };
      }
    },
    oauthClientPath: "/tmp/google-oauth-client.json",
    ...overrides,
  };
}

describe("googleWorkspaceConnect", () => {
  test("returns not_signed_in when token missing", async () => {
    const result = await googleWorkspaceConnect(
      {
        serverUrl: "https://nautilo.test",
        email: "user@example.com",
        refreshRelay: async () => {},
      },
      makeDeps(),
    );
    expect(result).toEqual({ ok: false, reason: "not_signed_in" });
  });

  test("runs the Nautilo-owned gog authorization and refreshes the relay after health verification", async () => {
    const execCalls: Array<{ bin: string; args: readonly string[] }> = [];
    const authorizationCalls: Array<{ bin: string; email: string; services: string }> = [];
    let refreshed = false;

    const result = await googleWorkspaceConnect(
      {
        serverUrl: "https://nautilo.test",
        token: "access-token",
        email: "user@example.com",
        refreshRelay: async () => {
          refreshed = true;
        },
      },
      makeDeps({
        execFileAsync: async (bin, args) => {
          execCalls.push({ bin, args });
          return { stdout: "", stderr: "" };
        },
        authorizeGogAccount: async ({ onAuthorized, ...args }) => {
          authorizationCalls.push(args);
          await onAuthorized();
          return { ok: true };
        },
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(authorizationCalls).toEqual([
      {
        bin: "/opt/homebrew/bin/gog",
        email: "user@example.com",
        services: "drive,docs,gmail,calendar,sheets,slides,forms,appscript,contacts,tasks",
      },
    ]);
    expect(execCalls.some((call) => call.args[0] === "auth" && call.args[1] === "add")).toBe(false);
    expect(refreshed).toBe(true);
  });

  test("does not report success when the stored gog account fails its health check", async () => {
    let refreshed = false;
    const result = await googleWorkspaceConnect(
      {
        serverUrl: "https://nautilo.test",
        token: "access-token",
        email: "user@example.com",
        refreshRelay: async () => {
          refreshed = true;
        },
      },
      makeDeps({ isGogAuthHealthy: async () => false }),
    );

    expect(result).toEqual({ ok: false, reason: "gog_auth_add_failed" });
    expect(refreshed).toBe(false);
  });
});
