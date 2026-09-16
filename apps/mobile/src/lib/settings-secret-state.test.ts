/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  EMPTY_RECOVERY_SECRET_STATE,
  clearRecoverySecret,
  transitionRecoverySecretState,
  type RecoverySecretExit,
} from "./settings-secret-state";

describe("recovery-secret custody state", () => {
  test("holds the secret only while explicitly revealed", () => {
    const revealed = transitionRecoverySecretState(EMPTY_RECOVERY_SECRET_STATE, {
      type: "reveal",
      secret: "recovery-secret",
    });

    expect(revealed).toEqual({ status: "revealed", secret: "recovery-secret" });
  });

  for (const exit of [
    "dismiss",
    "navigation",
    "unmount",
    "scope-change",
    "logout",
    "auth-dead",
    "error",
    "abort",
    "complete",
  ] as const satisfies readonly RecoverySecretExit[]) {
    test(`${exit} erases the recovery secret`, () => {
      const revealed = { status: "revealed" as const, secret: "recovery-secret" };

      expect(transitionRecoverySecretState(revealed, { type: exit })).toEqual({
        status: "hidden",
        secret: null,
      });
    });
  }

  test("imperative cleanup also returns an empty custody state", () => {
    expect(clearRecoverySecret()).toEqual({ status: "hidden", secret: null });
  });
});
