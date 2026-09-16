import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NautiloApiClient, loadCliSession } from "@nautilo/api-client";
import * as cliAuth from "@nautilo/cli-auth";
import type { DeviceFlowEvent } from "@nautilo/cli-auth";

/** Bun `spyOn` return is loosely typed; we only need teardown in tests. */
interface SpyRestorable {
  mockRestore(): void;
}

describe("nautilo login --remote", () => {
  let dir: string;
  let runDeviceFlowSpy: SpyRestorable;
  let healthSpy: SpyRestorable;
  let whoamiSpy: SpyRestorable;
  let fetchSpy: SpyRestorable;
  let previousHome: string | undefined;

  beforeEach(() => {
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "nautilo-login-dev-"));
    previousHome = process.env["HOME"];
    process.env["HOME"] = dir;
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;

    const refreshedTok = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.refreshed`;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/auth/whoami")) {
        return new Response(
          JSON.stringify({ sessionUserId: "u", mustChangePassword: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/oidc\/token$/.test(url)) {
        return new Response(
          JSON.stringify({
            access_token: refreshedTok,
            refresh_token: "rt2",
            id_token: "it2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unmocked fetch: ${url}`);
    }) as unknown as typeof fetch) as SpyRestorable;

    healthSpy = spyOn(NautiloApiClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      logtoEndpoint: "http://127.0.0.1:4444/",
      logtoTuiAppId: "tui-device-app",
      logtoResource: "urn:nautilo:api",
    }) as SpyRestorable;

    const tok = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.x`;

    async function* fakeFlow(): AsyncGenerator<DeviceFlowEvent> {
      yield {
        type: "code",
        data: {
          device_code: "dc",
          user_code: "CODE",
          verification_uri: "http://127.0.0.1:4444/verify",
          expires_in: 600,
          interval: 5,
        },
      };
      yield {
        type: "success",
        data: { access_token: tok, refresh_token: "rt", id_token: "it", expires_in: 3600 },
      };
    }

    runDeviceFlowSpy = spyOn(cliAuth, "runDeviceFlow").mockImplementation(
      () => fakeFlow(),
    ) as SpyRestorable;

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
    runDeviceFlowSpy.mockRestore();
    whoamiSpy.mockRestore();
    healthSpy.mockRestore();
    fetchSpy.mockRestore();
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  test("writes cli-session on mocked device success", async () => {
    const { loginModule } = await import("../../src/commands/login.ts");
    await (loginModule.handler as (a: unknown) => Promise<void>)({
      remote: true,
      device: false,
      server: "http://127.0.0.1:5555",
    });
    expect(process.exitCode as unknown as number).toBe(0);
    const s = await loadCliSession();
    expect(s?.source).toBe("device");
    expect(s?.authBinding).toEqual({
      flow: "device",
      issuer: "http://127.0.0.1:4444/",
      clientId: "tui-device-app",
      resource: "urn:nautilo:api",
    });
    expect(s?.targetBinding).toEqual({ kind: "http-origin", value: "http://127.0.0.1:5555" });
    expect(s?.handle).toBe("a");
  });

  test("JSON mode emits exactly one final error document after a late device failure", async () => {
    runDeviceFlowSpy.mockRestore();
    async function* lateFailure(): AsyncGenerator<DeviceFlowEvent> {
      yield {
        type: "code",
        data: {
          device_code: "dc", user_code: "CODE", verification_uri: "http://127.0.0.1:4444/verify",
          expires_in: 600, interval: 5,
        },
      };
      yield { type: "error", message: "TOKEN=must-not-appear", recoverable: false };
    }
    runDeviceFlowSpy = spyOn(cliAuth, "runDeviceFlow").mockImplementation(
      () => lateFailure(),
    ) as SpyRestorable;
    const { loginModule } = await import("../../src/commands/login.ts");
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
        remote: true, device: false, format: "json", server: "http://127.0.0.1:5555",
      });
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
    expect(process.exitCode as unknown as number).toBe(2);
    expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      schema: "nautilo.server-admin.v1", ok: false, error: { code: "login_failed" },
    });
    expect(stderr).toContain("Open: http://127.0.0.1:4444/verify");
    expect(stderr).toContain("Code: CODE");
    expect(stdout).not.toContain("TOKEN=");
    expect(stderr).not.toContain("TOKEN=");
  });

  test("rejects cross-origin and terminal-control device instructions before any unsafe output", async () => {
    runDeviceFlowSpy.mockRestore();
    const attempts = [
      { verification_uri: "https://evil.example/verify?token=EVIL_URI_SECRET", user_code: "CODE" },
      { verification_uri: "http://127.0.0.1:4444/verify", user_code: "CODE\u001b[31mEVIL_CODE_SECRET" },
    ];
    const { loginModule } = await import("../../src/commands/login.ts");
    for (const attempt of attempts) {
      async function* malformedInstruction(): AsyncGenerator<DeviceFlowEvent> {
        yield {
          type: "code",
          data: {
            device_code: "dc", user_code: attempt.user_code, verification_uri: attempt.verification_uri,
            expires_in: 600, interval: 5,
          },
        };
      }
      runDeviceFlowSpy = spyOn(cliAuth, "runDeviceFlow").mockImplementation(
        () => malformedInstruction(),
      ) as SpyRestorable;
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
          remote: true, device: false, format: "json", server: "http://127.0.0.1:5555",
        });
      } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
        runDeviceFlowSpy.mockRestore();
      }
      expect(process.exitCode as unknown as number).toBe(2);
      expect(stdout).toContain('"code":"login_failed"');
      expect(stderr).toBe("");
      expect(`${stdout}${stderr}`).not.toContain("evil.example");
      expect(`${stdout}${stderr}`).not.toContain("EVIL_URI_SECRET");
      expect(`${stdout}${stderr}`).not.toContain("EVIL_CODE_SECRET");
    }
  });
});
