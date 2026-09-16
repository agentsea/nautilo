import { describe, expect, test } from "bun:test";
import { redactError, redactSecretsInText } from "../../src/redact.ts";

describe("redactSecretsInText (SEC1)", () => {
  test("redacts Authorization Bearer headers", () => {
    const out = redactSecretsInText(
      "request failed — Authorization: Bearer abcdef1234567890XYZ.token",
    );
    expect(out).not.toContain("abcdef1234567890XYZ");
    expect(out).toContain("[redacted]");
  });

  test("redacts bare Bearer tokens", () => {
    const out = redactSecretsInText("used Bearer sekrettokenvalue1234 to auth");
    expect(out).not.toContain("sekrettokenvalue1234");
  });

  test("redacts GitHub tokens", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    expect(redactSecretsInText(`token ${secret} leaked`)).not.toContain(secret);
  });

  test("redacts sk- API keys", () => {
    const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV";
    expect(redactSecretsInText(`key ${secret} leaked`)).not.toContain(secret);
  });

  test("leaves clean text untouched", () => {
    expect(redactSecretsInText("no secrets here, just a message")).toBe(
      "no secrets here, just a message",
    );
  });
});

describe("redactError", () => {
  test("scrubs secrets from a thrown Error message", () => {
    const out = redactError(new Error("connect failed: Bearer verysecrettoken12345"));
    expect(out).not.toContain("verysecrettoken12345");
  });

  test("coerces non-Error values to string", () => {
    expect(redactError("plain string")).toBe("plain string");
  });
});
