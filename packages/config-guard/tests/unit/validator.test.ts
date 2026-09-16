import { describe, expect, test } from "bun:test";
import { validateOperations } from "../../src/validator";
import { FULL_LOGTO_PROCESS_ENV } from "../fixtures/full-logto-env";

describe("validator", () => {
  test("rejects unknown env var", () => {
    const { errors } = validateOperations(
      [{ type: "set", key: "PATH", value: "x" }],
      { overwrite: false, existingEnv: {} },
    );
    expect(errors.some((e) => e.includes("Unknown"))).toBe(true);
  });

  test("skips when overwrite false and key exists", () => {
    const { apply, errors } = validateOperations(
      [{ type: "set", key: "OPENAI_API_KEY", value: "sk-123456789012345678901234" }],
      {
        overwrite: false,
        existingEnv: { ...FULL_LOGTO_PROCESS_ENV, OPENAI_API_KEY: "already" },
      },
    );
    expect(errors.length).toBe(0);
    expect(apply[0]?.skip).toBe(true);
  });

  test("rejects empty value for set", () => {
    const { errors } = validateOperations(
      [{ type: "set", key: "OPENAI_API_KEY", value: "   " }],
      { overwrite: true, existingEnv: {} },
    );
    expect(errors.some((e) => e.includes("required"))).toBe(true);
  });

  test("rejects bad format for known key", () => {
    const { errors } = validateOperations(
      [{ type: "set", key: "OPENAI_API_KEY", value: "not-a-real-openai-key-shape" }],
      { overwrite: true, existingEnv: {} },
    );
    expect(errors.some((e) => e.includes("invalid format"))).toBe(true);
  });

  test("accepts non-AIzaSy Google API keys that meet length", () => {
    const { apply, errors } = validateOperations(
      [
        {
          type: "set",
          key: "GOOGLE_API_KEY",
          value: "AQ.Ab8RN6KMRdJWBR7PpH7JDKKrkJVstiPHi2_XVSZrmGJdmA8EaA",
        },
      ],
      { overwrite: true, existingEnv: {} },
    );
    expect(errors).toEqual([]);
    expect(apply[0]?.skip).toBe(false);
  });

  test("accepts remove for registry key", () => {
    const { apply, errors } = validateOperations(
      [{ type: "remove", key: "TAVILY_API_KEY" }],
      {
        overwrite: false,
        existingEnv: {
          ...FULL_LOGTO_PROCESS_ENV,
          TAVILY_API_KEY: "tvly-test",
        },
      },
    );
    expect(errors.length).toBe(0);
    expect(apply[0]?.operation.type).toBe("remove");
    expect(apply[0]?.skip).toBe(false);
  });
});
