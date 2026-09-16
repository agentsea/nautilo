import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupStatusCmd } from "../../src/commands/setup-status";

const validReadyGuest = {
  instanceId: "",
  serverUrl: "http://127.0.0.1:9",
  deploymentMode: "local-self-host",
  setupState: "ready",
  claimRequired: false,
  recommendedSetupSurface: { kind: "cli", url: null },
};

const validFreshGuest = {
  ...validReadyGuest,
  setupState: "fresh-unclaimed",
  claimRequired: true,
  recommendedSetupSurface: { kind: "electron-onboarding", url: "http://127.0.0.1:3000" },
};

describe("setup-status command (D112 Phase 5.1)", () => {
  const prevUrl = process.env["NAUTILO_SERVER_URL"];
  const origFetch = globalThis.fetch;
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    process.env["NAUTILO_SERVER_URL"] = "http://127.0.0.1:9";
    origLog = console.log;
    origErr = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    globalThis.fetch = origFetch;
    if (prevUrl === undefined) delete process.env["NAUTILO_SERVER_URL"];
    else process.env["NAUTILO_SERVER_URL"] = prevUrl;
  });

  test("exit 0 when setupState is ready", async () => {
    globalThis.fetch = (async (input: unknown) => {
      const u = typeof input === "string" ? input : String(input);
      expect(u).toContain("/api/setup/status");
      return new Response(JSON.stringify(validReadyGuest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    expect(await setupStatusCmd([])).toBe(0);
  });

  test("exit 2 when setupState is not ready", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(validFreshGuest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await setupStatusCmd([])).toBe(2);
  });

  test("exit 2 on HTTP failure", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await setupStatusCmd([])).toBe(2);
  });
});
