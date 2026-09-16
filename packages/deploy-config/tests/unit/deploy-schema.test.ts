import { describe, test, expect } from "bun:test";
import { DeployConfigV1 } from "../../src/index.ts";

const minimalAdmin = {
  handle: "alice",
  displayName: "Alice Operator",
  password: { value: "12345678" },
};

const explicitGenie = {
  mode: "explicit" as const,
  name: "Astra",
  voice: "openai:nova",
  defaultModel: "openai:gpt-4o-mini",
  personality: "Warm.",
  avatar: { kind: "preset" as const, presetId: "avatar-03" },
};

describe("DeployConfigV1", () => {
  test("happy path: minimal (admin + zero providers)", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: minimalAdmin,
      providers: [],
    });
    expect(r.success).toBe(true);
  });

  test("happy path: maximal admin + five providers + genie explicit", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: {
        ...minimalAdmin,
        pin: { fromEnv: "NAUTILO_ADMIN_PIN" },
      },
      providers: [
        { key: "OPENAI_API_KEY", value: { fromEnv: "OPENAI_API_KEY" } },
        { key: "ANTHROPIC_API_KEY", value: { fromEnv: "ANTHROPIC_API_KEY" } },
        { key: "GOOGLE_API_KEY", value: { fromEnv: "GOOGLE_API_KEY" } },
        { key: "FIREWORKS_API_KEY", value: { fromEnv: "FIREWORKS_API_KEY" } },
        { key: "TAVILY_API_KEY", value: { value: "tavily-secret-here" } },
      ],
      genie: explicitGenie,
    });
    expect(r.success).toBe(true);
  });

  test("happy path: genie randomize round-trip", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: minimalAdmin,
      genie: {
        mode: "randomize",
        seed: 42,
        name: "R",
        voice: "openai:nova",
        defaultModel: "openai:gpt-4o-mini",
        personality: "P".repeat(10),
      },
    });
    expect(r.success).toBe(true);
  });

  test("happy path: genie skip round-trip", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: minimalAdmin,
      genie: { mode: "skip" },
    });
    expect(r.success).toBe(true);
  });

  test("rejects schemaVersion other than 1", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 2,
      admin: minimalAdmin,
    });
    expect(r.success).toBe(false);
  });

  test("strict: unknown top-level field rejected", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: minimalAdmin,
      extraTop: 1,
    });
    expect(r.success).toBe(false);
  });

  test("strict: unknown field inside admin rejected", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: {
        ...minimalAdmin,
        mystery: true,
      },
    });
    expect(r.success).toBe(false);
  });

  test("admin.handle length bounds", () => {
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: { ...minimalAdmin, handle: "" },
      }).success,
    ).toBe(false);
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: { ...minimalAdmin, handle: "x".repeat(129) },
      }).success,
    ).toBe(false);
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: { ...minimalAdmin, handle: "ok" },
      }).success,
    ).toBe(true);
  });

  test("admin.displayName length bounds", () => {
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: { ...minimalAdmin, displayName: "" },
      }).success,
    ).toBe(false);
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: { ...minimalAdmin, displayName: "x".repeat(257) },
      }).success,
    ).toBe(false);
  });

  test("admin.password SecretField: value and fromEnv variants", () => {
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: { ...minimalAdmin, password: { value: "12345678" } },
      }).success,
    ).toBe(true);
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: { ...minimalAdmin, password: { fromEnv: "NAUTILO_ADMIN_PASSWORD" } },
      }).success,
    ).toBe(true);
  });

  test("admin.password inlined value under 8 chars rejected by minLengthSecret", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: { ...minimalAdmin, password: { value: "short" } },
    });
    expect(r.success).toBe(false);
  });

  test("providers: empty array allowed", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: minimalAdmin,
      providers: [],
    });
    expect(r.success).toBe(true);
  });

  test("providers: key regex enforced", () => {
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: minimalAdmin,
        providers: [{ key: "OPENAI_API_KEY", value: { value: "x" } }],
      }).success,
    ).toBe(true);
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: minimalAdmin,
        providers: [{ key: "bad-key", value: { value: "x" } }],
      }).success,
    ).toBe(false);
    expect(
      DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: minimalAdmin,
        providers: [{ key: "openai", value: { value: "x" } }],
      }).success,
    ).toBe(false);
  });

  test("omits unsupported forcePasswordChangeOnFirstSignIn from parsed admin", () => {
    const r = DeployConfigV1.safeParse({
      schemaVersion: 1,
      admin: {
        handle: "a",
        displayName: "A",
        password: { value: "12345678" },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("forcePasswordChangeOnFirstSignIn" in r.data.admin).toBe(false);
    }
  });

  test.each([true, false])(
    "rejects explicit forcePasswordChangeOnFirstSignIn=%s",
    (forcePasswordChangeOnFirstSignIn) => {
      const r = DeployConfigV1.safeParse({
        schemaVersion: 1,
        admin: {
          ...minimalAdmin,
          forcePasswordChangeOnFirstSignIn,
        },
      });
      expect(r.success).toBe(false);
    },
  );
});
