import { describe, expect, test } from "bun:test";
import {
  decodeGoogleOAuthClientJsonFromEnv,
  encodeGoogleOAuthClientJsonForEnv,
  maskGoogleOAuthClientId,
  validateGoogleOAuthClientJsonBase64Env,
  validateGoogleOAuthClientJsonText,
} from "../../src/google-oauth-client-json";

const VALID_INSTALLED = JSON.stringify({
  installed: {
    client_id: "123456789012-abcdefghijklmnop.apps.googleusercontent.com",
    client_secret: "GOCSPX-installed-secret",
  },
});

const VALID_WEB = JSON.stringify({
  web: {
    client_id: "987654321098-zyxwvutsrqponmlk.apps.googleusercontent.com",
    client_secret: "GOCSPX-web-secret",
  },
});

describe("validateGoogleOAuthClientJsonText", () => {
  test("accepts installed credentials", () => {
    const result = validateGoogleOAuthClientJsonText(VALID_INSTALLED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clientId).toContain("123456789012");
    expect(result.maskedClientId).toBe(
      maskGoogleOAuthClientId(
        "123456789012-abcdefghijklmnop.apps.googleusercontent.com",
      ),
    );
  });

  test("accepts web credentials", () => {
    const result = validateGoogleOAuthClientJsonText(VALID_WEB);
    expect(result.ok).toBe(true);
  });

  test("rejects invalid JSON", () => {
    const result = validateGoogleOAuthClientJsonText("{ not json");
    expect(result).toEqual({ ok: false, detail: "invalid JSON" });
  });

  test("rejects missing credential block", () => {
    const result = validateGoogleOAuthClientJsonText('{"foo":"bar"}');
    expect(result.ok).toBe(false);
  });

  test("rejects empty client_id", () => {
    const result = validateGoogleOAuthClientJsonText(
      JSON.stringify({ web: { client_id: "  ", client_secret: "secret" } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("base64 env roundtrip", () => {
  test("encode/decode preserves valid JSON", () => {
    const encoded = encodeGoogleOAuthClientJsonForEnv(VALID_INSTALLED);
    const decoded = decodeGoogleOAuthClientJsonFromEnv(encoded);
    expect(decoded).toBe(VALID_INSTALLED);
    expect(validateGoogleOAuthClientJsonBase64Env(encoded)).toBeNull();
  });

  test("base64 validator rejects non-JSON payload", () => {
    const encoded = Buffer.from("not-json", "utf8").toString("base64");
    expect(typeof validateGoogleOAuthClientJsonBase64Env(encoded)).toBe("string");
  });

  test("decode returns null for invalid base64", () => {
    expect(decodeGoogleOAuthClientJsonFromEnv("%%%")).toBeNull();
  });
});

describe("maskGoogleOAuthClientId", () => {
  test("masks long ids with prefix and ellipsis", () => {
    expect(maskGoogleOAuthClientId("123456789012-abcdefghijklmnop.apps.googleusercontent.com")).toBe(
      "123456789012…",
    );
  });

  test("masks short ids conservatively", () => {
    expect(maskGoogleOAuthClientId("abcd")).toBe("abcd…");
  });
});
