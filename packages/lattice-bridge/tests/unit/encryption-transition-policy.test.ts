import { describe, expect, test } from "bun:test";

import {
  ENCRYPTION_TRANSITION_MODES,
  selectLiveEncryptionRepresentationPolicy,
  selectLiveShadowEncryptionTransitionPolicy,
} from "../../src/transition/encryption-transition-policy.ts";

describe("production encryption transition policy", () => {
  test("keeps the stable vocabulary and selects every live transition mode", () => {
    expect(ENCRYPTION_TRANSITION_MODES).toEqual([
      "plaintext_only",
      "shadow_encryption",
      "encrypted_only",
    ]);
    expect(selectLiveShadowEncryptionTransitionPolicy({
      mode: "plaintext_only",
    })).toEqual({
      ok: true,
      value: { mode: "plaintext_only", shadowBehavior: "fallback" },
    });
    expect(selectLiveShadowEncryptionTransitionPolicy({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
    })).toEqual({
      ok: true,
      value: { mode: "shadow_encryption", shadowBehavior: "strict" },
    });
    expect(selectLiveShadowEncryptionTransitionPolicy({
      mode: "shadow_reads",
    })).toMatchObject({ ok: false, reason: "invalid_policy" });
    expect(selectLiveShadowEncryptionTransitionPolicy({
      mode: "encrypted_only",
    })).toEqual({
      ok: true,
      value: { mode: "encrypted_only", shadowBehavior: "fallback" },
    });
  });

  test("fails closed on absent, hidden, and unknown policy state", () => {
    expect(selectLiveShadowEncryptionTransitionPolicy(undefined)).toMatchObject({
      ok: false,
      reason: "invalid_policy",
    });
    expect(selectLiveShadowEncryptionTransitionPolicy({
      mode: "plaintext_only",
      environmentOverride: true,
    })).toMatchObject({ ok: false, reason: "invalid_policy" });
    expect(selectLiveShadowEncryptionTransitionPolicy({
      mode: "future_mode",
    })).toMatchObject({ ok: false, reason: "invalid_policy" });
    expect(selectLiveShadowEncryptionTransitionPolicy({
      mode: "plaintext_only",
      shadowBehavior: "strict",
    })).toMatchObject({ ok: false, reason: "invalid_policy" });
  });

  test("selects explicit representation access and repair dispositions by mode", () => {
    expect(selectLiveEncryptionRepresentationPolicy({
      mode: "plaintext_only",
      shadowBehavior: "fallback",
    })).toEqual({
      read: "ordinary_only",
      write: "ordinary_only",
      allowOrdinaryFallback: false,
      allowOrdinaryLoader: true,
      allowProtectedCrypto: false,
      allowForwardRepair: false,
      allowReverseRepair: false,
    });
    expect(selectLiveEncryptionRepresentationPolicy({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
    })).toEqual({
      read: "protected_first",
      write: "ordinary_and_protected",
      allowOrdinaryFallback: false,
      allowOrdinaryLoader: true,
      allowProtectedCrypto: true,
      allowForwardRepair: true,
      allowReverseRepair: true,
    });
    expect(selectLiveEncryptionRepresentationPolicy({
      mode: "encrypted_only",
      shadowBehavior: "fallback",
    })).toEqual({
      read: "protected_only",
      write: "protected_only",
      allowOrdinaryFallback: false,
      allowOrdinaryLoader: false,
      allowProtectedCrypto: true,
      allowForwardRepair: false,
      allowReverseRepair: false,
    });
  });

  test("permits ordinary fallback only in Fallback Shadow, not merely either Shadow", () => {
    const fallback = selectLiveEncryptionRepresentationPolicy({
      mode: "shadow_encryption", shadowBehavior: "fallback",
    });
    const strict = selectLiveEncryptionRepresentationPolicy({
      mode: "shadow_encryption", shadowBehavior: "strict",
    });
    expect(fallback).toEqual({ ...strict, allowOrdinaryFallback: true });
    // Strict can load an ordinary repair source without permission to consume
    // it after failed protection. Loading and successful consumption differ.
    expect(strict.allowOrdinaryLoader).toBe(true);
    expect(strict.allowOrdinaryFallback).toBe(false);
  });

  test("does not derive a representation disposition from malformed policy", () => {
    for (const input of [
      undefined,
      { mode: "future_mode" },
      { mode: "encrypted_only", hiddenOverride: true },
    ]) {
      const selected = selectLiveShadowEncryptionTransitionPolicy(input);
      expect(selected).toMatchObject({ ok: false, reason: "invalid_policy" });
      if (!selected.ok) {
        continue;
      }
      selectLiveEncryptionRepresentationPolicy(selected.value);
      throw new Error("Malformed policy unexpectedly reached disposition selection");
    }
  });
});
