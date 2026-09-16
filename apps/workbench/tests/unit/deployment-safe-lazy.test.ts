import { describe, expect, test } from "bun:test";
import {
  attemptLazyImportRecovery,
  isEligibleStaleChunkError,
  shouldReloadForLazyImportFailure,
  type LazyImportRecoveryDependencies,
} from "../../src/lib/deployment-safe-lazy";

const staleImportError = new TypeError(
  "Failed to fetch dynamically imported module: https://nautilo.test/assets/reader-abc.js",
);

function recoveryDependencies(
  overrides: Partial<LazyImportRecoveryDependencies> = {},
): LazyImportRecoveryDependencies {
  return {
    isOnline: () => true,
    hasUnsentComposerText: () => false,
    getBaselineIdentity: () => "deploy-old",
    getCurrentIdentity: async () => "deploy-new",
    getReloadedIdentity: () => null,
    markReloadedIdentity: () => {},
    acceptIdentity: () => {},
    reload: () => {},
    ...overrides,
  };
}

describe("deployment-safe lazy import recovery", () => {
  test("classifies only canonical chunk and dynamic-import failures", () => {
    expect(isEligibleStaleChunkError(staleImportError)).toBe(true);
    expect(
      isEligibleStaleChunkError(
        Object.assign(new Error("Loading chunk reader-abc failed."), {
          name: "ChunkLoadError",
        }),
      ),
    ).toBe(true);
    expect(isEligibleStaleChunkError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isEligibleStaleChunkError(new Error("module initialization failed"))).toBe(false);
    expect(isEligibleStaleChunkError("Loading chunk reader failed")).toBe(false);
  });

  test("pure policy requires online, changed identity, no draft, and no prior reload", () => {
    const eligible = {
      error: staleImportError,
      isOnline: true,
      hasUnsentComposerText: false,
      baselineIdentity: "deploy-old",
      currentIdentity: "deploy-new",
      reloadedIdentity: null,
    };
    expect(shouldReloadForLazyImportFailure(eligible)).toBe(true);
    expect(
      shouldReloadForLazyImportFailure({ ...eligible, isOnline: false }),
    ).toBe(false);
    expect(
      shouldReloadForLazyImportFailure({
        ...eligible,
        hasUnsentComposerText: true,
      }),
    ).toBe(false);
    expect(
      shouldReloadForLazyImportFailure({
        ...eligible,
        currentIdentity: "deploy-old",
      }),
    ).toBe(false);
    expect(
      shouldReloadForLazyImportFailure({
        ...eligible,
        reloadedIdentity: "deploy-new",
      }),
    ).toBe(false);
  });

  test("verifies deployment identity and latches before one reload", async () => {
    const events: string[] = [];
    const recovered = await attemptLazyImportRecovery(
      staleImportError,
      recoveryDependencies({
        getCurrentIdentity: async () => {
          events.push("health");
          return "deploy-new";
        },
        markReloadedIdentity: (identity) => events.push(`mark:${identity}`),
        acceptIdentity: (identity) => events.push(`accept:${identity}`),
        reload: () => events.push("reload"),
      }),
    );

    expect(recovered).toBe(true);
    expect(events).toEqual([
      "health",
      "mark:deploy-new",
      "accept:deploy-new",
      "reload",
    ]);
  });

  test("does not probe or reload with unsent composer text", async () => {
    let healthCalls = 0;
    let reloadCalls = 0;
    const recovered = await attemptLazyImportRecovery(
      staleImportError,
      recoveryDependencies({
        hasUnsentComposerText: () => true,
        getCurrentIdentity: async () => {
          healthCalls += 1;
          return "deploy-new";
        },
        reload: () => {
          reloadCalls += 1;
        },
      }),
    );

    expect(recovered).toBe(false);
    expect(healthCalls).toBe(0);
    expect(reloadCalls).toBe(0);
  });

  test("rechecks the composer guard after the health request", async () => {
    let guardChecks = 0;
    let reloadCalls = 0;
    const recovered = await attemptLazyImportRecovery(
      staleImportError,
      recoveryDependencies({
        hasUnsentComposerText: () => {
          guardChecks += 1;
          return guardChecks > 1;
        },
        reload: () => {
          reloadCalls += 1;
        },
      }),
    );

    expect(recovered).toBe(false);
    expect(guardChecks).toBe(2);
    expect(reloadCalls).toBe(0);
  });

  test("treats failed health probes and prior reloads as non-recoverable", async () => {
    expect(
      await attemptLazyImportRecovery(
        staleImportError,
        recoveryDependencies({
          getCurrentIdentity: async () => {
            throw new TypeError("offline");
          },
        }),
      ),
    ).toBe(false);

    let reloadCalls = 0;
    expect(
      await attemptLazyImportRecovery(
        staleImportError,
        recoveryDependencies({
          getReloadedIdentity: () => "deploy-new",
          reload: () => {
            reloadCalls += 1;
          },
        }),
      ),
    ).toBe(false);
    expect(reloadCalls).toBe(0);
  });
});
