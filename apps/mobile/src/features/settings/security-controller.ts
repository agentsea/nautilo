import type { AccountSecurityResponse, PinMutationResponse } from "@nautilo/api-client/browser";

import {
  createSettingsDataState,
  type SettingsDataScope,
  type SettingsDataStateController,
} from "@/features/settings/settings-data-state";

export interface SecuritySnapshot {
  pinEnrolled: boolean;
  pinRecoveryCodes: { total: number; used: number; remaining: number };
  account: AccountSecurityResponse;
  logtoRecoveryCodes: { total: number; remaining: number; lastGeneratedAt: string | null } | null;
}

export interface SecurityApi {
  getPinEnrollment(): Promise<{ enrolled: boolean }>;
  getRecoveryCodeStatus(): Promise<{ total: number; used: number; remaining: number }>;
  getAccountSecurity(): Promise<AccountSecurityResponse>;
  getLogtoRecoveryCodeStatus(): Promise<{ total: number; remaining: number; lastGeneratedAt: string | null }>;
  changePin(args: { currentPin?: string; newPin: string }): Promise<PinMutationResponse>;
  recoverPin(recoveryCode: string, newPin: string): Promise<{ codesRemaining: number }>;
  recoverPinWithFreshJwt(newPin: string): Promise<{ codesRemaining: number }>;
  changePassword(args: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<{ ok: true }>;
}

export interface PinDraft {
  currentPin: string;
  newPin: string;
  confirmPin: string;
}

const WEAK_PINS = new Set([
  "123456", "000000", "111111", "222222", "333333", "444444", "555555", "666666",
  "777777", "888888", "999999", "123123", "121212", "112233", "654321", "012345",
  "987654", "12345678", "00000000", "11111111",
]);

export function validatePinDraft(draft: PinDraft, enrolled: boolean): string | null {
  if (enrolled && !draft.currentPin) return "Enter your current PIN to change it.";
  if (!/^\d{6,8}$/.test(draft.newPin)) return "PIN must be 6–8 digits.";
  if (WEAK_PINS.has(draft.newPin)) return "PIN is too predictable — choose something less obvious.";
  if (draft.newPin !== draft.confirmPin) return "New PIN and confirmation do not match.";
  return null;
}

export function securityErrorMessage(error: unknown, fallback: string): string {
  const status = statusOf(error);
  if (status === 409) return "A PIN was enrolled elsewhere. Refresh and enter the current PIN.";
  if (status === 429) return "Too many attempts. Wait before trying again.";
  if (status === 401) return error instanceof Error && error.message ? error.message : "Current PIN is incorrect.";
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isFreshReauthRequired(error: unknown): boolean {
  return statusOf(error) === 401 && error instanceof Error &&
    (error.message.includes("fresh_reauth_required") || error.message.includes("recently-issued access token"));
}

export interface SecurityController {
  readonly state: SettingsDataStateController<SecuritySnapshot, null>;
  load(api: SecurityApi): ReturnType<SettingsDataStateController<SecuritySnapshot, null>["load"]>;
  savePin(api: SecurityApi, draft: PinDraft): Promise<{ status: "saved" | "invalid" | "failed" | "ignored"; message?: string }>;
  resetPinWithCode(api: SecurityApi, recoveryCode: string, draft: Omit<PinDraft, "currentPin">): Promise<{ status: "saved" | "invalid" | "failed" | "ignored"; message?: string }>;
  resetPinAfterReauth(api: SecurityApi, draft: Omit<PinDraft, "currentPin">): Promise<{ status: "saved" | "invalid" | "failed" | "ignored"; message?: string }>;
  savePassword(api: SecurityApi, value: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<{ status: "saved" | "invalid" | "failed" | "ignored"; message?: string }>;
}

export function createSecurityController(): SecurityController {
  const state = createSettingsDataState<SecuritySnapshot, null>();
  const reload = (api: SecurityApi) => async (_scope: SettingsDataScope): Promise<SecuritySnapshot> => {
    const [pin, pinRecoveryCodes, account] = await Promise.all([
      api.getPinEnrollment(), api.getRecoveryCodeStatus(), api.getAccountSecurity(),
    ]);
    // This endpoint is deliberately distinct from account-security metadata.
    // Do not call it for unlinked users, because the server correctly rejects it.
    const logtoRecoveryCodes = account.linkedToLogto ? await api.getLogtoRecoveryCodeStatus() : null;
    return { pinEnrolled: pin.enrolled, pinRecoveryCodes, account, logtoRecoveryCodes };
  };
  return {
    state,
    load(api) { return state.load(reload(api)); },
    async savePin(api, draft) {
      const snapshot = state.getState().data;
      if (!snapshot) return { status: "ignored" };
      const invalid = validatePinDraft(draft, snapshot.pinEnrolled);
      if (invalid) return { status: "invalid", message: invalid };
      let plaintext: string[] = [];
      const result = await state.mutate(async () => {
        const response = await api.changePin(snapshot.pinEnrolled
          ? { currentPin: draft.currentPin, newPin: draft.newPin }
          : { newPin: draft.newPin });
        if ("enrolled" in response && response.enrolled) plaintext = response.recoveryCodes;
      }, reload(api));
      if (result.status === "applied") {
        if (plaintext.length) state.revealSecret(plaintext.join("\n"));
        return { status: "saved" };
      }
      return result.status === "failed"
        ? { status: "failed", message: securityErrorMessage(result.error, "Could not save PIN.") }
        : { status: "ignored" };
    },
    async resetPinWithCode(api, recoveryCode, draft) {
      const invalid = validatePinDraft({ ...draft, currentPin: "" }, false);
      if (invalid) return { status: "invalid", message: invalid };
      if (!recoveryCode.trim()) return { status: "invalid", message: "Enter a PIN recovery code." };
      const result = await state.mutate(async () => { await api.recoverPin(recoveryCode.trim(), draft.newPin); }, reload(api));
      return mutationResult(result, "Could not reset PIN.");
    },
    async resetPinAfterReauth(api, draft) {
      const invalid = validatePinDraft({ ...draft, currentPin: "" }, false);
      if (invalid) return { status: "invalid", message: invalid };
      const result = await state.mutate(async () => { await api.recoverPinWithFreshJwt(draft.newPin); }, reload(api));
      return mutationResult(result, "Could not reset PIN.");
    },
    async savePassword(api, value) {
      if (!value.currentPassword || !value.newPassword) return { status: "invalid", message: "Enter your current and new password." };
      if (value.newPassword !== value.confirmPassword) return { status: "invalid", message: "New password and confirmation do not match." };
      const result = await state.mutate(async () => { await api.changePassword(value); }, reload(api));
      return mutationResult(result, "Could not save password.");
    },
  };
}

function mutationResult(result: { status: string; error?: unknown }, fallback: string) {
  if (result.status === "applied") return { status: "saved" as const };
  if (result.status === "failed") return { status: "failed" as const, message: securityErrorMessage(result.error, fallback) };
  return { status: "ignored" as const };
}

function statusOf(error: unknown): number | null {
  return error !== null && typeof error === "object" && "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status : null;
}
