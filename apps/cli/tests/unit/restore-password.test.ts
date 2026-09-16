import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NautiloApiClient } from "@nautilo/api-client";
import * as cliAuth from "@nautilo/cli-auth";
import { restorePasswordModule } from "../../src/commands/restore-password.ts";

interface SpyRestorable {
  mockRestore(): void;
}

describe("nautilo auth restore-password", () => {
  let dir: string;
  let healthSpy: SpyRestorable;
  let openSpy: SpyRestorable;
  let detectSpy: SpyRestorable;

  beforeEach(() => {
    process.exitCode = undefined;
    dir = mkdtempSync(join(tmpdir(), "nautilo-rp-"));
    process.env["NAUTILO_HOME_OVERRIDE"] = dir;
    healthSpy = spyOn(NautiloApiClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      logtoEndpoint: "http://logto.test/",
    }) as SpyRestorable;
    openSpy = spyOn(cliAuth, "openUrlInDefaultBrowser").mockImplementation(() => {}) as SpyRestorable;
    detectSpy = spyOn(cliAuth, "detectHeadless").mockReturnValue({
      headless: false,
      reasons: [],
    }) as SpyRestorable;
  });
  afterEach(() => {
    healthSpy.mockRestore();
    openSpy.mockRestore();
    detectSpy.mockRestore();
    delete process.env["NAUTILO_HOME_OVERRIDE"];
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  test("default opens Logto /forgot-password in the browser", async () => {
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (restorePasswordModule.handler as (a: unknown) => Promise<void>)({
        server: "http://127.0.0.1:9",
      });
    } finally {
      process.stdout.write = ow;
    }
    expect(process.exitCode as unknown as number).toBe(0);
    expect(out).toContain("http://logto.test/forgot-password");
    expect(out).toContain("Opened Logto's password-reset page");
    expect(out).toContain("nautilo login");
  });

  test("--remote prints the URL without opening a browser", async () => {
    const localOpenSpy = spyOn(cliAuth, "openUrlInDefaultBrowser").mockImplementation(() => {});
    let out = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      out += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (restorePasswordModule.handler as (a: unknown) => Promise<void>)({
        remote: true,
        server: "http://127.0.0.1:9",
      });
    } finally {
      process.stdout.write = ow;
      localOpenSpy.mockRestore();
    }
    expect(process.exitCode as unknown as number).toBe(0);
    expect(out).toContain("Open this URL on a device");
    expect(out).toContain("http://logto.test/forgot-password");
    expect(localOpenSpy).not.toHaveBeenCalled();
  });

  test("missing Logto endpoint exits 2", async () => {
    healthSpy.mockRestore();
    const noLogtoSpy = spyOn(NautiloApiClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
    });
    let err = "";
    const ew = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      await (restorePasswordModule.handler as (a: unknown) => Promise<void>)({
        server: "http://127.0.0.1:9",
      });
    } finally {
      process.stderr.write = ew;
      noLogtoSpy.mockRestore();
    }
    expect(process.exitCode).toBe(2);
    expect(err).toContain("Logto endpoint");
  });
});
