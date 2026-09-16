import { describe, expect, test } from "bun:test";
import {
  runNautiloGogAuthorization,
  type NautiloGogAuthorizationDeps,
} from "../../electron/google-workspace-oauth-loopback";

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1]!;
}

function googleAuthUrl(redirectUri: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", "state-fixture");
  url.searchParams.set("code_challenge", "challenge-fixture");
  return url.toString();
}

const args = {
  bin: "/opt/nautilo/gog",
  email: "human@example.com",
  services: "drive,docs,sheets",
};

describe("runNautiloGogAuthorization", () => {
  test("uses gog's state-checked two-step flow and serves a Nautilo completion page", async () => {
    const calls: string[][] = [];
    let browserResponse: Promise<Response> | null = null;
    let authorized = false;

    const deps: NautiloGogAuthorizationDeps = {
      execFileAsync: async (_bin, commandArgs) => {
        calls.push([...commandArgs]);
        if (flagValue(commandArgs, "--step") === "1") {
          return {
            stdout: JSON.stringify({
              auth_url: googleAuthUrl(flagValue(commandArgs, "--redirect-uri")),
              state_reused: false,
            }),
            stderr: "",
          };
        }
        const callback = new URL(flagValue(commandArgs, "--auth-url"));
        expect(callback.hostname).toBe("127.0.0.1");
        expect(callback.searchParams.get("code")).toBe("code-fixture");
        expect(callback.searchParams.get("state")).toBe("state-fixture");
        return { stdout: JSON.stringify({ stored: true }), stderr: "" };
      },
      openExternal: async (authUrl) => {
        const redirectUri = new URL(authUrl).searchParams.get("redirect_uri");
        if (!redirectUri) throw new Error("missing redirect URI");
        browserResponse = fetch(`${redirectUri}?code=code-fixture&state=state-fixture`);
      },
    };

    const result = await runNautiloGogAuthorization(
      {
        ...args,
        onAuthorized: async () => {
          authorized = true;
        },
      },
      deps,
    );

    expect(result).toEqual({ ok: true });
    expect(authorized).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--remote");
    expect(calls[0]).toContain("--no-input");
    expect(calls[1]).toContain("--auth-url");

    const response = await browserResponse!;
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Google account connected");
    expect(html).toContain("Return to Nautilo");
    expect(html).not.toContain("gog");
    expect(html).not.toContain("terminal");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("shows a safe cancellation page without running gog step two", async () => {
    const calls: string[][] = [];
    let browserResponse: Promise<Response> | null = null;

    const result = await runNautiloGogAuthorization(
      {
        ...args,
        onAuthorized: async () => {
          throw new Error("must not run");
        },
      },
      {
        execFileAsync: async (_bin, commandArgs) => {
          calls.push([...commandArgs]);
          return {
            stdout: JSON.stringify({
              auth_url: googleAuthUrl(flagValue(commandArgs, "--redirect-uri")),
            }),
            stderr: "",
          };
        },
        openExternal: async (authUrl) => {
          const redirectUri = new URL(authUrl).searchParams.get("redirect_uri");
          if (!redirectUri) throw new Error("missing redirect URI");
          browserResponse = fetch(`${redirectUri}?error=access_denied&state=state-fixture`);
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: "google_auth_cancelled" });
    expect(calls).toHaveLength(1);
    const response = await browserResponse!;
    expect(await response.text()).toContain("Google connection cancelled");
  });

  test("fails closed when gog returns an unexpected authorization URL", async () => {
    let opened = false;
    const result = await runNautiloGogAuthorization(
      { ...args, onAuthorized: async () => {} },
      {
        execFileAsync: async () => ({
          stdout: JSON.stringify({ auth_url: "https://example.com/not-google" }),
          stderr: "",
        }),
        openExternal: async () => {
          opened = true;
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: "gog_auth_add_failed" });
    expect(opened).toBe(false);
  });

  test("times out and closes the one-shot listener when no callback arrives", async () => {
    const result = await runNautiloGogAuthorization(
      { ...args, onAuthorized: async () => {} },
      {
        execFileAsync: async (_bin, commandArgs) => ({
          stdout: JSON.stringify({
            auth_url: googleAuthUrl(flagValue(commandArgs, "--redirect-uri")),
          }),
          stderr: "",
        }),
        openExternal: async () => {},
        callbackTimeoutMs: 10,
      },
    );

    expect(result).toEqual({ ok: false, reason: "google_auth_timed_out" });
  });
});
