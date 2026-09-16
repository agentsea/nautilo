import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NautiloApiClient, loadCliSession } from "@nautilo/api-client";
import * as cliAuth from "@nautilo/cli-auth";
import type { DeviceFlowEvent } from "@nautilo/cli-auth";
import { loginModule } from "../../src/commands/login.ts";

interface SpyRestorable {
  mockRestore(): void;
}

describe("nautilo login device flow — mustChangePassword", () => {
  let dir: string;
  let healthSpy: SpyRestorable;
  let runDeviceFlowSpy: SpyRestorable;
  let fetchSpy: SpyRestorable;
  let previousHome: string | undefined;

  beforeEach(() => {
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "nautilo-login-fc-"));
    previousHome = process.env["HOME"];
    process.env["HOME"] = dir;
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
    delete process.env["NAUTILO_TOKEN"];

    const refreshedTok = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.refreshed`;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/auth/whoami")) {
        return new Response(
          JSON.stringify({
            sessionUserId: "u",
            sessionActorId: "a",
            userIdentity: "u@test.local",
            handle: "tempuser",
            displayName: "Temporary User",
            externalId: "logto-u",
            instanceId: "instance-a",
            mustChangePassword: true,
            groups: [],
            capabilities: [],
            features: { office: { enabled: false } },
            highestRole: "member",
          }),
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
  });
  afterEach(() => {
    runDeviceFlowSpy.mockRestore();
    healthSpy.mockRestore();
    fetchSpy.mockRestore();
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  test("saves a restricted session and directs the user to secure CLI rotation", async () => {
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (loginModule.handler as (a: unknown) => Promise<void>)({
        remote: true,
        server: "http://127.0.0.1:5555",
      });
    } finally {
      process.stderr.write = ew;
    }
    expect(process.exitCode as unknown as number).toBe(2);
    expect(err).toContain("restricted CLI session was saved");
    expect(err).toContain("nautilo change-password");
    expect(err).not.toContain("rt2");
    expect(await loadCliSession()).toMatchObject({
      instanceId: "instance-a",
      handle: "tempuser",
    });
    process.exitCode = undefined;
  });
});
