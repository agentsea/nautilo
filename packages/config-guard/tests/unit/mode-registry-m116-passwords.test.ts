import { describe, expect, test } from "bun:test";
import { getModeByEnvVar } from "../../src/mode-registry";

const PASSWORD_KEYS = [
  "APP_DB_PASSWORD",
  "POSTGRES_PASSWORD",
  "NAUTILO_DB_PASSWORD",
  "LOGTO_DB_PASSWORD",
  "NAUTILO_AGENT_DB_PASSWORD",
] as const;

describe("mode-registry M116 DB passwords", () => {
  test("registers the five server/runtime password keys and the sentinel", () => {
    for (const key of PASSWORD_KEYS) {
      expect(getModeByEnvVar(key)?.envVar).toBe(key);
    }
    expect(
      getModeByEnvVar("NAUTILO_M116_DB_PASSWORDS_GENERATED_AT")?.envVar,
    ).toBe("NAUTILO_M116_DB_PASSWORDS_GENERATED_AT");
  });

  test("keeps the dormant crypto-role password out of instance.env registry", () => {
    expect(getModeByEnvVar("NAUTILO_CRYPTO_DB_PASSWORD")).toBeUndefined();
  });

  test("password entries have redact: true", () => {
    for (const key of PASSWORD_KEYS) {
      expect(getModeByEnvVar(key)?.redact).toBe(true);
    }
    expect(
      getModeByEnvVar("NAUTILO_M116_DB_PASSWORDS_GENERATED_AT")?.redact,
    ).toBeUndefined();
  });

  test("validateHexPassword accepts 48-char hex and rejects empty / single-quote", () => {
    const validator = getModeByEnvVar("APP_DB_PASSWORD")!.validator;
    expect(validator("a".repeat(48))).toBeNull();
    expect(validator("")).toBe("must not be empty");
    expect(validator("safe'unsafe")).toBe(
      "contains characters unsafe for SQL string assembly",
    );
  });

  test("validateIso8601Timestamp accepts ISO-8601 and rejects garbage", () => {
    const validator = getModeByEnvVar(
      "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT",
    )!.validator;
    expect(validator("2026-05-21T12:34:56.000Z")).toBeNull();
    expect(validator("not a date")).toBe("must be a valid ISO-8601 timestamp");
  });
});
