/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  createSettingsReauthFence,
  reauthenticateThenResume,
} from "./settings-reauth";

const viewer = { serverId: "srv_example", userId: "user-1", actorId: "actor-1" };

describe("Settings fresh-reauth fence", () => {
  test("resumes the intended sensitive action only after fresh auth succeeds", async () => {
    const fence = createSettingsReauthFence();
    let resolveAuth: (() => void) | undefined;
    let actionRuns = 0;
    const auth = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });

    const completion = reauthenticateThenResume(
      fence,
      async () => {
        await auth;
        return viewer;
      },
      viewer,
      () => {
        actionRuns += 1;
      },
    );

    await Promise.resolve();
    expect(actionRuns).toBe(0);
    expect(fence.hasPendingAction()).toBe(true);

    resolveAuth?.();
    expect(await completion).toBe(true);
    expect(actionRuns).toBe(1);
    expect(fence.hasPendingAction()).toBe(false);
  });

  test("failed, cancelled, or unverified reauthentication erases the fenced action", async () => {
    const fence = createSettingsReauthFence();
    let actionRuns = 0;

    let failure: unknown;
    try {
      await reauthenticateThenResume(
        fence,
        async () => {
          throw new Error("Unable to verify fresh sign-in");
        },
        viewer,
        () => {
          actionRuns += 1;
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Unable to verify fresh sign-in");
    expect(actionRuns).toBe(0);
    expect(fence.hasPendingAction()).toBe(false);
  });

  test("a stale auth completion cannot resume a replacement action", async () => {
    const fence = createSettingsReauthFence();
    let firstRuns = 0;
    let secondRuns = 0;
    const firstAttempt = fence.fence(() => {
      firstRuns += 1;
    }, viewer);
    const secondAttempt = fence.fence(() => {
      secondRuns += 1;
    }, viewer);

    expect(await fence.resumeAfterFreshAuth(firstAttempt, viewer)).toBe(false);
    expect(await fence.resumeAfterFreshAuth(secondAttempt, viewer)).toBe(true);
    expect(firstRuns).toBe(0);
    expect(secondRuns).toBe(1);
  });

  test("a fresh login for a different identity cannot resume the action", async () => {
    const fence = createSettingsReauthFence();
    let actionRuns = 0;
    const attempt = fence.fence(() => {
      actionRuns += 1;
    }, viewer);

    expect(
      await fence.resumeAfterFreshAuth(attempt, {
        serverId: "srv_example",
        userId: "user-2",
        actorId: "actor-2",
      }),
    ).toBe(false);
    expect(actionRuns).toBe(0);
    expect(fence.hasPendingAction()).toBe(false);
  });
});
