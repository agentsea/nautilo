import { expect, test } from "bun:test";

import { createSecurityController, securityErrorMessage, validatePinDraft, type SecurityApi } from "@/features/settings/security-controller";

const account = { linkedToLogto: true, requiresPasswordChange: false, passwordChangeReason: null, requiredSince: null, completedAt: null, logtoRecoveryCodes: { remaining: 8, total: 8, lastGeneratedAt: null } } as const;
function api(overrides: Partial<SecurityApi> = {}): SecurityApi { return { getPinEnrollment: async () => ({ enrolled: false }), getRecoveryCodeStatus: async () => ({ total: 10, used: 2, remaining: 8 }), getAccountSecurity: async () => account, getLogtoRecoveryCodeStatus: async () => ({ total: 8, remaining: 8, lastGeneratedAt: null }), changePin: async () => ({ ok: true, enrolled: true, recoveryCodes: ["pin-code-a"] }), recoverPin: async () => ({ codesRemaining: 7 }), recoverPinWithFreshJwt: async () => ({ codesRemaining: 7 }), changePassword: async () => ({ ok: true }), ...overrides }; }

test("PIN absent enrollment reveals codes only after canonical refresh", async () => {
  const controller = createSecurityController(); controller.state.setScope({ serverId: "s", userId: "u", actorId: "a" }); await controller.load(api());
  expect((await controller.savePin(api(), { currentPin: "", newPin: "246810", confirmPin: "246810" })).status).toBe("saved");
  expect(controller.state.getState().data?.pinEnrolled).toBe(false); // fake canonical endpoint owns truth
  expect(controller.state.getState().secret).toEqual({ status: "revealed", secret: "pin-code-a" });
});

test("PIN present sends current PIN and races re-fetch as an error", async () => {
  let args: unknown; const existing = api({ getPinEnrollment: async () => ({ enrolled: true }), changePin: async (value) => { args = value; throw Object.assign(new Error("PIN already enrolled"), { status: 409 }); } });
  const controller = createSecurityController(); controller.state.setScope({ serverId: "s", userId: "u", actorId: "a" }); await controller.load(existing);
  const result = await controller.savePin(existing, { currentPin: "246810", newPin: "135790", confirmPin: "135790" });
  expect(args).toEqual({ currentPin: "246810", newPin: "135790" }); expect(result.message).toContain("enrolled elsewhere");
});

test("PIN validation rejects malformed, weak, mismatched and missing-current values", () => {
  expect(validatePinDraft({ currentPin: "", newPin: "123", confirmPin: "123" }, false)).toBe("PIN must be 6–8 digits.");
  expect(validatePinDraft({ currentPin: "", newPin: "123456", confirmPin: "123456" }, false)).toContain("predictable");
  expect(validatePinDraft({ currentPin: "", newPin: "246810", confirmPin: "246811" }, false)).toContain("do not match");
  expect(validatePinDraft({ currentPin: "", newPin: "246810", confirmPin: "246810" }, true)).toContain("current PIN");
});

test("wrong current, lockout and upstream errors have safe canonical messages", () => {
  expect(securityErrorMessage(Object.assign(new Error("Current PIN is incorrect"), { status: 401 }), "x")).toBe("Current PIN is incorrect");
  expect(securityErrorMessage(Object.assign(new Error("x"), { status: 429 }), "x")).toContain("Too many attempts");
  expect(securityErrorMessage(new Error("service unavailable"), "x")).toBe("service unavailable");
});

test("password canonical state preserves linked and unlinked account modes", async () => {
  for (const linkedToLogto of [true, false]) {
    const controller = createSecurityController(); controller.state.setScope({ serverId: "s", userId: "u", actorId: "a" });
    await controller.load(api({ getAccountSecurity: async () => ({ ...account, linkedToLogto }) }));
    expect(controller.state.getState().data?.account.linkedToLogto).toBe(linkedToLogto);
  }
});

test("recovery-code families use distinct canonical status methods", async () => {
  let pinStatusCalls = 0; let logtoStatusCalls = 0;
  const controller = createSecurityController(); controller.state.setScope({ serverId: "s", userId: "u", actorId: "a" });
  await controller.load(api({ getRecoveryCodeStatus: async () => { pinStatusCalls += 1; return { total: 10, used: 3, remaining: 7 }; }, getLogtoRecoveryCodeStatus: async () => { logtoStatusCalls += 1; return { total: 8, remaining: 6, lastGeneratedAt: null }; } }));
  expect(pinStatusCalls).toBe(1); expect(logtoStatusCalls).toBe(1);
  expect(controller.state.getState().data?.pinRecoveryCodes.remaining).toBe(7);
  expect(controller.state.getState().data?.logtoRecoveryCodes?.remaining).toBe(6);
});

test("password save re-fetches canonical state and keeps wrong-current errors secret-free", async () => {
  let changes = 0; const controller = createSecurityController(); controller.state.setScope({ serverId: "s", userId: "u", actorId: "a" });
  const client = api({ getAccountSecurity: async () => ({ ...account, requiresPasswordChange: changes === 0 }), changePassword: async () => { changes += 1; return { ok: true }; } });
  await controller.load(client);
  expect((await controller.savePassword(client, { currentPassword: "old", newPassword: "new", confirmPassword: "new" })).status).toBe("saved");
  expect(controller.state.getState().data?.account.requiresPasswordChange).toBe(false);
  const wrong = api({ changePassword: async () => { throw Object.assign(new Error("Current password is incorrect."), { status: 422 }); } });
  expect((await controller.savePassword(wrong, { currentPassword: "wrong", newPassword: "new", confirmPassword: "new" })).message).toBe("Current password is incorrect.");
});
