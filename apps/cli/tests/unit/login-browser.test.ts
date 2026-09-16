import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NautiloApiClient, loadCliSession } from "@nautilo/api-client";
import * as cliAuth from "@nautilo/cli-auth";
import { loginModule, parseMode } from "../../src/commands/login.ts";

interface SpyRestorable {
  mockRestore(): void;
}

describe("nautilo login browser PKCE", () => {
  let dir: string;
  let fetchSpy: SpyRestorable;
  let whoamiSpy: SpyRestorable;
  let healthSpy: SpyRestorable;
  let pkceSpy: SpyRestorable;
  let detectSpy: SpyRestorable;
  let previousHome: string | undefined;

  beforeEach(() => {
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "nautilo-login-br-"));
    previousHome = process.env["HOME"];
    process.env["HOME"] = dir;
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
    delete process.env["NAUTILO_FORCE_DEVICE_FLOW"];
    delete process.env["SSH_CONNECTION"];
    delete process.env["NAUTILO_TOKEN"];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/auth/whoami")) {
        return new Response(
          JSON.stringify({
            sessionUserId: "u",
            mustChangePassword: false,
            groups: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unmocked fetch: ${url}`);
    }) as unknown as typeof fetch) as SpyRestorable;
    const tok = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.x`;
    detectSpy = spyOn(cliAuth, "detectHeadless").mockReturnValue({
      headless: false,
      reasons: [],
    }) as SpyRestorable;
    pkceSpy = spyOn(cliAuth, "runLoopbackPkce").mockResolvedValue({
      accessToken: tok,
      expiresIn: 3600,
      refreshToken: "rt",
    }) as SpyRestorable;
    healthSpy = spyOn(NautiloApiClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      logtoEndpoint: "http://127.0.0.1:4444/",
      logtoTuiLoopbackAppId: "loop-app",
      logtoResource: "urn:nautilo:api",
    }) as SpyRestorable;
    whoamiSpy = spyOn(NautiloApiClient.prototype, "whoami").mockResolvedValue({
      sessionUserId: "u",
      sessionActorId: "a",
      userIdentity: "@a@l",
      handle: "a",
      displayName: "A",
      highestRole: "owner",
      externalId: "sub",
      instanceId: "i1",
      mustChangePassword: false,
      groups: [{ id: "g1", type: "owners", label: "Owners", roleSlug: "owner" }],
      capabilities: [],
    }) as SpyRestorable;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    whoamiSpy.mockRestore();
    healthSpy.mockRestore();
    pkceSpy.mockRestore();
    detectSpy.mockRestore();
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    delete process.env["NAUTILO_TOKEN"];
  });

  test("persists browser auth binding and exact HTTP target after mocked PKCE", async () => {
    process.exitCode = undefined;
    expect(
      parseMode(
        { remote: false, device: false, server: "http://127.0.0.1:5555" } as Record<string, unknown>,
        process.env,
      ),
    ).toBe("browser");
    await (loginModule.handler as (a: unknown) => Promise<void>)({
      remote: false,
      device: false,
      server: "http://127.0.0.1:5555",
    });
    expect(process.exitCode as unknown as number).toBe(0);
    const s = await loadCliSession();
    expect(s?.source).toBe("device");
    expect(s?.authBinding).toEqual({
      flow: "browser_loopback",
      issuer: "http://127.0.0.1:4444/",
      clientId: "loop-app",
      resource: "urn:nautilo:api",
    });
    expect(s?.targetBinding).toEqual({ kind: "http-origin", value: "http://127.0.0.1:5555" });
    expect(s?.handle).toBe("a");
  });

  test("does not persist a login when the selected profile declares another instance", async () => {
    const profiles = join(dir, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, ".active"), "prod\n");
    writeFileSync(
      join(profiles, "prod.toml"),
      [
        'name = "prod"',
        'transport = "remote"',
        'lifecycle = "external"',
        'domain = "server.example"',
        'instance_id = "i2"',
      ].join("\n"),
    );
    await (loginModule.handler as (a: unknown) => Promise<void>)({ remote: false, device: false });
    expect(process.exitCode as unknown as number).toBe(2);
    expect(await loadCliSession({ profile: "prod" })).toBeNull();
  });

  test("headless detection selects device flow without an explicit flag", () => {
    detectSpy.mockRestore();
    detectSpy = spyOn(cliAuth, "detectHeadless").mockReturnValue({
      headless: true,
      reasons: ["ssh"],
    }) as SpyRestorable;

    expect(parseMode({ remote: false, device: false }, process.env)).toBe("device");
  });

  test("browser recovery failures emit one fixed JSON document and save no session", async () => {
    const cases = [
      { failure: new Error("Browser launch failed"), code: "browser_unavailable" },
      { failure: new Error("OAuth error: access_denied"), code: "login_cancelled" },
      { failure: new Error("Loopback callback timeout after 10ms"), code: "login_timeout" },
      { failure: new Error("listen EADDRINUSE"), code: "callback_unavailable" },
    ] as const;

    for (const item of cases) {
      pkceSpy.mockRestore();
      pkceSpy = spyOn(cliAuth, "runLoopbackPkce").mockRejectedValue(item.failure) as SpyRestorable;
      let stdout = "";
      let stderr = "";
      const stdoutWrite = process.stdout.write.bind(process.stdout);
      const stderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = (value: string | Uint8Array) => {
        stdout += typeof value === "string" ? value : Buffer.from(value).toString();
        return true;
      };
      process.stderr.write = (value: string | Uint8Array) => {
        stderr += typeof value === "string" ? value : Buffer.from(value).toString();
        return true;
      };
      try {
        await (loginModule.handler as (a: unknown) => Promise<void>)({
          remote: false,
          device: false,
          format: "json",
          server: "http://127.0.0.1:5555",
        });
      } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
      }
      expect(process.exitCode as unknown as number).toBe(2);
      expect(stderr).toBe("");
      expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({
        schema: "nautilo.server-admin.v1",
        ok: false,
        error: { code: item.code },
      });
      expect(await loadCliSession()).toBeNull();
    }
  });
});
