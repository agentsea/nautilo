import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import { getRelayTokenStore, setRelayTokenStore } from "../../src/lib/relay-token-store";
import { deriveTestModeRelayCredential, TEST_MODE_RELAY_USER_ID } from "../../src/lib/test-mode-relay-credential";
import { installTestModeRelayFixture } from "../../src/lib/test-mode-relay-fixture";
import { validateRelayToken } from "../../src/realtime/relay-token";
import { handleRelayRegister, type RelaySocketLike } from "../../src/realtime/relay-endpoint";

describe("isolated smoke Relay credential", () => {
  const oldEnv = { ...process.env };
  const originalStore = getRelayTokenStore();
  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
    process.env["NAUTILO_TEST_MODE"] = "1";
    process.env["NAUTILO_TEST_MODE_ONLY"] = "1";
  });
  afterEach(() => {
    for (const key of ["NODE_ENV", "NAUTILO_TEST_MODE", "NAUTILO_TEST_MODE_ONLY"]) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    setRelayTokenStore(originalStore);
  });

  test("production and incomplete admission cannot install the fixture", () => {
    process.env["NODE_ENV"] = "production";
    expect(() => installTestModeRelayFixture("fixture-token")).toThrow();
    process.env["NODE_ENV"] = "test";
    delete process.env["NAUTILO_TEST_MODE_ONLY"];
    expect(() => installTestModeRelayFixture("fixture-token")).toThrow();
    process.env["NAUTILO_TEST_MODE_ONLY"] = "1";
    delete process.env["NAUTILO_TEST_MODE"];
    expect(() => installTestModeRelayFixture("fixture-token")).toThrow();
    expect(getRelayTokenStore()).toBe(originalStore);
  });

  test("only the paired credential validates and closing restores the prior store", async () => {
    const testToken = randomBytes(24).toString("base64url");
    const credential = deriveTestModeRelayCredential(testToken);
    expect(credential).toMatch(/^rty_[A-Za-z0-9_-]{32}$/);
    expect(credential).not.toContain(testToken);
    const restore = installTestModeRelayFixture(testToken);
    expect(await validateRelayToken(undefined)).toBeNull();
    expect(await validateRelayToken(testToken)).toBeNull();
    expect(await validateRelayToken(deriveTestModeRelayCredential(`${testToken}x`))).toBeNull();
    const validated = await validateRelayToken(credential);
    expect(validated?.userId).toBe(TEST_MODE_RELAY_USER_ID);
    restore();
    restore();
    expect(getRelayTokenStore()).toBe(originalStore);
    const restoreRestart = installTestModeRelayFixture(testToken);
    const restarted = await validateRelayToken(credential);
    expect(restarted?.userId).toBe(validated?.userId);
    expect(restarted?.tokenId).not.toBe(validated?.tokenId);
    restoreRestart();
  });

  test("real registration rejects missing/wrong credentials and stamps the paired owner", async () => {
    const testToken = randomBytes(24).toString("base64url");
    const restore = installTestModeRelayFixture(testToken);
    const users: string[] = [];
    try {
      for (const token of [undefined, deriveTestModeRelayCredential("wrong-token"), deriveTestModeRelayCredential(testToken)]) {
        const events: unknown[] = [];
        const socket: RelaySocketLike = {
          OPEN: 1, readyState: 1,
          send: (data) => { events.push(JSON.parse(data)); },
          close: (code) => { events.push({ closeCode: code }); },
        };
        await handleRelayRegister(socket, {
          type: "relay:register", relayId: "smoke-relay", userId: "spoofed-owner",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          ...(token === undefined ? {} : { token }),
          capabilities: { profile: "desktop-agent", canRunShell: true },
        }, { register: async (_id, userId) => { users.push(userId); } });
        if (token !== deriveTestModeRelayCredential(testToken)) {
          expect(events).toContainEqual({ closeCode: 4401 });
        } else {
          expect(events.some((event) => (event as { type?: string }).type === "relay:registered")).toBe(true);
        }
      }
      expect(users).toEqual([TEST_MODE_RELAY_USER_ID]);
    } finally { restore(); }
  });
});
