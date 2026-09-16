/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { decideAuthRecovery } from "./auth-state-decision";

describe("D468 Auth ownership recovery decisions", () => {
  test("a prior durably confirmed Human stays signed-in and stale on transient whoami failure", () => {
    expect(decideAuthRecovery({
      hasDurablyConfirmedOwner: true,
      cleanupFailed: false,
    })).toEqual({
      status: "signed-in",
      viewerState: "stale",
      clearViewer: false,
      notice: "Nautilo could not verify this session right now. Check your connection and try again.",
    });
  });

  test("a never-confirmed session leaves loading for a truthful sign-in state", () => {
    expect(decideAuthRecovery({
      hasDurablyConfirmedOwner: false,
      cleanupFailed: false,
    })).toEqual({
      status: "signed-out",
      viewerState: "none",
      clearViewer: true,
      notice: "Nautilo could not verify this session. Sign in again.",
    });
  });

  test("a cleanup persistence failure is explicit and recoverable, never loading", () => {
    expect(decideAuthRecovery({
      hasDurablyConfirmedOwner: true,
      cleanupFailed: true,
    })).toEqual({
      status: "signed-in",
      viewerState: "stale",
      clearViewer: false,
      notice: "Nautilo could not finish securing this session. Check your connection and try again.",
    });
  });
});
