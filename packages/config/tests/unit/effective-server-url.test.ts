import { describe, expect, test } from "bun:test";
import {
  effectiveServerScheme,
  resolveEffectiveServerUrl,
} from "../../src/effective-server-url";

describe("effective server URL", () => {
  test("localhost hosts use HTTP", () => {
    expect(effectiveServerScheme("127.0.0.1")).toBe("http");
    expect(effectiveServerScheme("localhost")).toBe("http");
    expect(resolveEffectiveServerUrl({
      server: { host: "127.0.0.1", port: 3001 },
    })).toBe("http://127.0.0.1:3001");
    expect(resolveEffectiveServerUrl({
      server: { host: "localhost", port: 3001 },
    })).toBe("http://127.0.0.1:3001");
  });

  test("LAN bind hosts use HTTPS and display a loopback URL locally", () => {
    expect(effectiveServerScheme("0.0.0.0")).toBe("https");
    expect(resolveEffectiveServerUrl({
      server: { host: "0.0.0.0", port: 3001 },
    })).toBe("https://127.0.0.1:3001");
  });

  test("actual listen port overrides configured preferred port", () => {
    expect(resolveEffectiveServerUrl(
      { server: { host: "0.0.0.0", port: 3001 } },
      { port: 3002 },
    )).toBe("https://127.0.0.1:3002");
  });

  test("M092 — NAUTILO_DISABLE_TLS forces http even on LAN-host bind", () => {
    const env = { NAUTILO_DISABLE_TLS: "1" } as NodeJS.ProcessEnv;
    expect(effectiveServerScheme("0.0.0.0", env)).toBe("http");
    expect(effectiveServerScheme("192.168.1.50", env)).toBe("http");
    expect(
      resolveEffectiveServerUrl(
        { server: { host: "0.0.0.0", port: 3001 } },
        { env },
      ),
    ).toBe("http://127.0.0.1:3001");
  });

  test("NAUTILO_DISABLE_TLS accepts 1 / true / yes / on (case-insensitive); other values are no-op", () => {
    for (const truthy of ["1", "true", "TRUE", "yes", "YES", "on", "ON"]) {
      expect(
        effectiveServerScheme("0.0.0.0", {
          NAUTILO_DISABLE_TLS: truthy,
        } as NodeJS.ProcessEnv),
      ).toBe("http");
    }
    for (const falsy of ["0", "false", "no", "off", "", " "]) {
      expect(
        effectiveServerScheme("0.0.0.0", {
          NAUTILO_DISABLE_TLS: falsy,
        } as NodeJS.ProcessEnv),
      ).toBe("https");
    }
  });

  test("undefined env leaves the host-based decision intact", () => {
    expect(effectiveServerScheme("0.0.0.0", undefined)).toBe("https");
    expect(effectiveServerScheme("127.0.0.1", undefined)).toBe("http");
  });
});
