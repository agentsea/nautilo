import { beforeEach, describe, expect, test } from "bun:test";

import {
  assertCryptoAdmissionAccess,
  getCryptoAdmissionSnapshot,
  isCryptoAdmissionAllowed,
  registerCryptoAdmissionAccessOwner,
  requestCryptoAdmissionRefresh,
  resetCryptoAdmissionAccess,
  runWithCryptoAdmission,
  setCryptoAdmissionAccessState,
  subscribeCryptoAdmissionAccess,
} from "../../src/lib/crypto-admission-access";

const policy = {
  mode: "encrypted_only" as const,
  shadowBehavior: "strict" as const,
};

beforeEach(() => resetCryptoAdmissionAccess());

describe("crypto admission operation fence", () => {
  test("unmanaged pre-gate callers are permitted", () => {
    expect(getCryptoAdmissionSnapshot().status).toBe("unmanaged");
    expect(isCryptoAdmissionAllowed()).toBe(true);
    expect(() => assertCryptoAdmissionAccess()).not.toThrow();
  });

  test("invalidates once on pause and does not bump an unchanged successful refresh", () => {
    setCryptoAdmissionAccessState({ status: "checking", identity: "account:device:a", policy });
    setCryptoAdmissionAccessState({ status: "open", identity: "account:device:a", policy });
    const opened = getCryptoAdmissionSnapshot();

    requestCryptoAdmissionRefresh("encryption_policy_changed");
    const paused = getCryptoAdmissionSnapshot();
    expect(paused.status).toBe("paused");
    expect(paused.generation).toBe(opened.generation + 1);
    expect(() => assertCryptoAdmissionAccess(opened.generation))
      .toThrow("Protected workspace access is paused");

    setCryptoAdmissionAccessState({ status: "open", identity: "account:device:a", policy });
    expect(getCryptoAdmissionSnapshot().generation).toBe(paused.generation);
    expect(() => assertCryptoAdmissionAccess(paused.generation)).not.toThrow();
  });

  test("publishes synchronously before notifying the owner and hard-blocks removal", () => {
    setCryptoAdmissionAccessState({ status: "open", identity: "account:device:a", policy });
    const observations: string[] = [];
    const unsubscribe = subscribeCryptoAdmissionAccess(() => {
      observations.push(`subscriber:${getCryptoAdmissionSnapshot().status}`);
    });
    const unregister = registerCryptoAdmissionAccessOwner((reason) => {
      observations.push(`owner:${reason}:${getCryptoAdmissionSnapshot().status}`);
    });

    requestCryptoAdmissionRefresh("device_removed_or_stale");

    expect(observations).toEqual([
      "subscriber:blocked",
      "owner:device_removed_or_stale:blocked",
    ]);
    expect(isCryptoAdmissionAllowed()).toBe(false);
    expect(() => assertCryptoAdmissionAccess()).toThrow("Protected workspace access is blocked");
    unsubscribe();
    unregister();
  });

  test("identity changes invalidate old generations and owner cleanup resets to unmanaged", () => {
    const unregister = registerCryptoAdmissionAccessOwner(() => undefined);
    setCryptoAdmissionAccessState({ status: "open", identity: "account-a:device:a", policy });
    const prior = getCryptoAdmissionSnapshot().generation;

    setCryptoAdmissionAccessState({ status: "checking", identity: "account-b:device:b", policy: null });

    expect(getCryptoAdmissionSnapshot().generation).toBe(prior + 1);
    expect(() => assertCryptoAdmissionAccess(prior)).toThrow("Protected workspace access is paused");
    unregister();
    expect(getCryptoAdmissionSnapshot().status).toBe("unmanaged");
  });

  test("does not invoke protected async work while paused", async () => {
    setCryptoAdmissionAccessState({ status: "paused", identity: "account:device:a", policy });
    let invoked = false;

    const error: unknown = await runWithCryptoAdmission(async () => {
      invoked = true;
      return "unexpected";
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "crypto_admission_paused" });
    expect(invoked).toBe(false);
  });

  test("rejects a protected async result when admission changes while it is pending", async () => {
    setCryptoAdmissionAccessState({ status: "open", identity: "account:device:a", policy });
    let finish!: (value: string) => void;
    const operation = runWithCryptoAdmission(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));

    requestCryptoAdmissionRefresh("transport_disconnected");
    finish("stale result");

    const error: unknown = await operation.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "crypto_admission_paused" });
  });

  test("rejects an old result after gate cleanup resets access to unmanaged", async () => {
    setCryptoAdmissionAccessState({ status: "open", identity: "account:device:a", policy });
    let finish!: (value: string) => void;
    const operation = runWithCryptoAdmission(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));

    resetCryptoAdmissionAccess();
    finish("old identity result");

    expect(() => assertCryptoAdmissionAccess()).not.toThrow();
    const error: unknown = await operation.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "crypto_admission_paused" });
  });
});
