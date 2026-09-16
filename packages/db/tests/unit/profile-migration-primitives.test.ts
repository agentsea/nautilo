/**
 * D425 Wave 1A — pure unit tests for the profile-migration primitives that
 * do not touch Postgres: the frozen profile allowlist filter and the
 * target-state digest canonicalization. The transaction-aware DB behavior
 * is covered by `profile-migration-primitives.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  WAVE_1A_PROFILE_ALLOWED_FIELDS,
  WAVE_1A_PROFILE_EXCLUDED_IDENTITY_FIELDS,
  WAVE_1A_PROFILE_EXCLUDED_LIFECYCLE_FIELDS,
  WAVE_1A_PROFILE_EXCLUDED_PHOTO_FIELDS,
  applyWave1AProfileAllowlist,
  canonicalTargetState,
  computeTargetStateDigestFromState,
  extractHandleIntent,
  isWave1AProfileFieldAllowed,
} from "../../src/utils/profile-migration-primitives";

describe("D425 applyWave1AProfileAllowlist", () => {
  test("keeps approved portable fields and drops undefined values", () => {
    const { payload, refused, unknown } = applyWave1AProfileAllowlist({
      name: "Jeannie",
      soulFile: "soul.md",
      personalityPrompt: "warm",
      personalityTone: "playful",
      motherAnswer: "…",
      language: "en",
      voices: { default: { voiceId: "v1", voiceName: "Voice" } },
      defaultModel: "gpt-foo",
      fallbackEnabled: true,
      fallbackChain: ["a", "b"],
      privacySpectrum: 3,
      workLifeMode: "both",
      avatarRef: { kind: "preset", id: "avatar-01" },
      // explicitly undefined → treated as absent, not copied
      voiceName: undefined,
    });

    expect(payload.name).toBe("Jeannie");
    expect(payload.soulFile).toBe("soul.md");
    expect(payload.defaultModel).toBe("gpt-foo");
    expect(payload.fallbackChain).toEqual(["a", "b"]);
    expect(payload).not.toHaveProperty("avatarRef");
    expect(payload.voiceName).toBeUndefined();
    expect(refused).toEqual(["avatarRef"]);
    expect(unknown).toEqual([]);
  });

  test("refuses the three named lifecycle fields + identity/timestamp columns", () => {
    const { payload, refused, unknown } = applyWave1AProfileAllowlist({
      name: "Jeannie",
      onboardingCompleted: true,
      welcomeMessageSent: true,
      publicProfile: true,
      id: "uuid-never-portable",
      userId: "uuid-owner",
      agentId: "uuid-agent",
      createdAt: "2026-01-01",
      updatedAt: "2026-07-14",
    });

    expect(payload.name).toBe("Jeannie");
    expect(payload).not.toHaveProperty("onboardingCompleted");
    expect(payload).not.toHaveProperty("publicProfile");
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("agentId");
    expect(payload).not.toHaveProperty("updatedAt");
    expect(refused).toEqual(
      expect.arrayContaining([
        "onboardingCompleted",
        "welcomeMessageSent",
        "publicProfile",
        "id",
        "userId",
        "agentId",
        "createdAt",
        "updatedAt",
      ]) as string[],
    );
    expect(unknown).toEqual([]);
  });

  test("reports unknown keys without copying them", () => {
    const { payload, unknown, refused } = applyWave1AProfileAllowlist({
      name: "Jeannie",
      favoriteColor: "blue",
      secretVaultKey: "xxx",
      onboardingCompleted: false,
    });

    expect(payload.name).toBe("Jeannie");
    expect(payload).not.toHaveProperty("favoriteColor");
    expect(payload).not.toHaveProperty("secretVaultKey");
    expect(unknown).toEqual(
      expect.arrayContaining(["favoriteColor", "secretVaultKey"]) as string[],
    );
    expect(refused).toEqual(["onboardingCompleted"]);
  });

  test("every allowed field is recognized by isWave1AProfileFieldAllowed", () => {
    for (const f of WAVE_1A_PROFILE_ALLOWED_FIELDS) {
      expect(isWave1AProfileFieldAllowed(f)).toBe(true);
    }
    expect(isWave1AProfileFieldAllowed("onboardingCompleted")).toBe(false);
    expect(isWave1AProfileFieldAllowed("totallyInvented")).toBe(false);
  });

  test("the three lifecycle fields are a strict subset of the exclusion set", () => {
    // Guard: the spec names exactly these three as out-of-scope lifecycle.
    expect(WAVE_1A_PROFILE_EXCLUDED_LIFECYCLE_FIELDS).toEqual([
      "onboardingCompleted",
      "welcomeMessageSent",
      "publicProfile",
    ]);
    // Identity / timestamp columns must never appear on the allowlist.
    for (const idKey of WAVE_1A_PROFILE_EXCLUDED_IDENTITY_FIELDS) {
      expect(isWave1AProfileFieldAllowed(idKey)).toBe(false);
    }
    expect(WAVE_1A_PROFILE_EXCLUDED_PHOTO_FIELDS).toEqual(["avatarRef"]);
  });

  test("empty input yields empty payload and no refused/unknown", () => {
    const res = applyWave1AProfileAllowlist({});
    expect(res.payload).toEqual({});
    expect(res.refused).toEqual([]);
    expect(res.unknown).toEqual([]);
  });
});

describe("D425 extractHandleIntent", () => {
  test("customized source → customized intent carrying the handle", () => {
    expect(extractHandleIntent({ handle: "mybot", handleCustomized: true })).toEqual({
      kind: "customized",
      handle: "mybot",
    });
  });

  test("auto-derived source → auto intent (handle string dropped)", () => {
    expect(extractHandleIntent({ handle: "jeannie", handleCustomized: false })).toEqual({
      kind: "auto",
    });
  });
});

describe("D425 target-state digest", () => {
  test("canonical form is deterministic and key-sorted", () => {
    const state = {
      profileName: "Jeannie",
      profileUpdatedAt: new Date("2026-07-14T00:00:00.000Z"),
      agentHandle: "jeannie",
      agentHandleCustomized: false,
      agentUpdatedAt: new Date("2026-07-14T00:00:00.000Z"),
    };
    // Keys are sorted alphabetically.
    expect(canonicalTargetState(state)).toBe(
      [
        "agentHandle=jeannie",
        "agentHandleCustomized=false",
        "agentUpdatedAt=2026-07-14T00:00:00.000Z",
        "profileName=Jeannie",
        "profileUpdatedAt=2026-07-14T00:00:00.000Z",
      ].join("|"),
    );
  });

  test("digest is stable for equal state and changes for any mutated field", () => {
    const base = {
      profileName: "Jeannie",
      profileUpdatedAt: "2026-07-14T00:00:00.000Z",
      agentHandle: "jeannie",
      agentHandleCustomized: false,
      agentUpdatedAt: "2026-07-14T00:00:00.000Z",
    };
    const d0 = computeTargetStateDigestFromState(base);
    expect(d0).toBe(computeTargetStateDigestFromState({ ...base }));
    // each field mutation must change the digest
    expect(computeTargetStateDigestFromState({ ...base, profileName: "Other" })).not.toBe(d0);
    expect(
      computeTargetStateDigestFromState({ ...base, agentHandle: "other" }),
    ).not.toBe(d0);
    expect(
      computeTargetStateDigestFromState({ ...base, agentHandleCustomized: true }),
    ).not.toBe(d0);
    expect(
      computeTargetStateDigestFromState({ ...base, profileUpdatedAt: "2026-07-15T00:00:00.000Z" }),
    ).not.toBe(d0);
    expect(
      computeTargetStateDigestFromState({ ...base, agentUpdatedAt: "2026-07-15T00:00:00.000Z" }),
    ).not.toBe(d0);
  });

  test("null vs absent normalize identically (no crash)", () => {
    const dNull = computeTargetStateDigestFromState({
      profileName: null,
      profileUpdatedAt: null,
      agentHandle: null,
      agentHandleCustomized: null,
      agentUpdatedAt: null,
    });
    expect(dNull).toMatch(/^[0-9a-f]{64}$/);
  });

  test("digest matches a plain sha256 of the canonical string", () => {
    const state = {
      profileName: "Jeannie",
      profileUpdatedAt: new Date("2026-07-14T00:00:00.000Z"),
      agentHandle: "jeannie",
      agentHandleCustomized: true,
      agentUpdatedAt: new Date("2026-07-14T00:00:00.000Z"),
    };
    const expected = createHash("sha256")
      .update(canonicalTargetState(state))
      .digest("hex");
    expect(computeTargetStateDigestFromState(state)).toBe(expected);
  });
});
