import { describe, expect, test } from "bun:test";

import { normalizeDeviceAuthorizationInstruction } from "../../src/device-instruction";

describe("device authorization terminal instruction", () => {
  test("accepts the exact bounded issuer-origin URI and user-code policy", () => {
    const origin = "https://identity.example";
    const uri = `${origin}/${"a".repeat(2_048 - origin.length - 1)}`;
    const userCode = "A".repeat(128);
    expect(normalizeDeviceAuthorizationInstruction(origin, uri, userCode)).toEqual({
      verificationUri: uri,
      userCode,
    });
  });

  test("rejects N+1 values, terminal controls, credentials, and another origin", () => {
    const origin = "https://identity.example";
    const oversizedUri = `${origin}/${"a".repeat(2_048 - origin.length)}`;
    expect(() => normalizeDeviceAuthorizationInstruction(origin, oversizedUri, "CODE"))
      .toThrow("device_authorization_failed");
    expect(() => normalizeDeviceAuthorizationInstruction(origin, `${origin}/device`, "A".repeat(129)))
      .toThrow("device_authorization_failed");
    expect(() => normalizeDeviceAuthorizationInstruction(origin, `${origin}/device`, "CODE\u001b[31m"))
      .toThrow("device_authorization_failed");
    expect(() => normalizeDeviceAuthorizationInstruction(origin, "https://user:pass@identity.example/device", "CODE"))
      .toThrow("device_authorization_failed");
    expect(() => normalizeDeviceAuthorizationInstruction(origin, "https://evil.example/device", "CODE"))
      .toThrow("device_authorization_failed");
  });
});
