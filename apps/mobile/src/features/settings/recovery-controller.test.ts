import { expect, test } from "bun:test";

import { clearRecoveryCodes, RECOVERY_CODE_FAMILIES, recoveryExitDisposition, revealRecoveryCodes } from "@/features/settings/recovery-controller";
import { createSettingsDataState } from "@/features/settings/settings-data-state";
import { createSettingsReauthFence, reauthenticateThenResume } from "@/lib/settings-reauth";

test("PIN and Logto account codes retain distinct labels", () => {
  expect(RECOVERY_CODE_FAMILIES.pin.title).toBe("PIN recovery codes");
  expect(RECOVERY_CODE_FAMILIES["logto-account"].title).toBe("Logto account recovery codes");
});

test("empty regeneration never reveals a secret", () => {
  const state = createSettingsDataState<unknown, unknown>(); state.setScope({ serverId: "s", userId: "u", actorId: "a" });
  expect(revealRecoveryCodes(state, [])).toBe(false); expect(state.getState().secret.status).toBe("hidden");
});

test("every secret exit clears reveal custody", () => {
  const state = createSettingsDataState<unknown, unknown>(); state.setScope({ serverId: "s", userId: "u", actorId: "a" });
  expect(revealRecoveryCodes(state, ["account-code"])).toBe(true); clearRecoveryCodes(state);
  expect(state.getState().secret).toEqual({ status: "hidden", secret: null });
  revealRecoveryCodes(state, ["account-code"]); state.setScope(null);
  expect(state.getState().secret.status).toBe("hidden");
});

test("all named secret exits are irreversible", () => {
  const exits = ["dismiss", "navigation", "unmount", "background", "server switch", "logout", "auth-dead", "error"];
  for (const _exit of exits) {
    const state = createSettingsDataState<unknown, unknown>(); state.setScope({ serverId: "s", userId: "u", actorId: "a" });
    revealRecoveryCodes(state, ["one-time-code"]); clearRecoveryCodes(state);
    expect(state.getState().secret.status).toBe("hidden");
  }
});

test("reauth cancellation discards the exact recovery regeneration action", async () => {
  const fence = createSettingsReauthFence(); let resumed = false;
  try { await reauthenticateThenResume(fence, async () => { throw new Error("cancelled"); }, { serverId: "s", userId: "u", actorId: "a" }, () => { resumed = true; }); } catch (error) { expect(error).toBeInstanceOf(Error); }
  expect(resumed).toBe(false); expect(fence.hasPendingAction()).toBe(false);
});

test("unacknowledged codes guard navigation but security exits clear immediately", () => {
  expect(recoveryExitDisposition(true, "navigation")).toBe("confirm-discard");
  expect(recoveryExitDisposition(false, "navigation")).toBe("clear-now");
  expect(recoveryExitDisposition(true, "background")).toBe("clear-now");
  expect(recoveryExitDisposition(true, "auth-boundary")).toBe("clear-now");
});
