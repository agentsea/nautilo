import type {
  MobilePushInstallationStatus,
  MobilePushInstallationTestResponse,
  NotificationLevel,
  NotificationPreferencesDto,
} from "@nautilo/types";

import {
  createSettingsDataState,
  type SettingsDataScope,
  type SettingsDataStateController,
  type SettingsLoadResult,
  type SettingsMutationResult,
} from "./settings-data-state";

export interface NotificationSettingsApi {
  getNotificationPreferences(): Promise<NotificationPreferencesDto>;
  getPushInstallationStatus(bindingId: string): Promise<MobilePushInstallationStatus>;
  setDefaultNotificationLevel(level: NotificationLevel): Promise<NotificationPreferencesDto>;
  sendPushInstallationTest(bindingId: string): Promise<MobilePushInstallationTestResponse>;
}

export type NotificationBindingState =
  | { readonly kind: "not_registered" }
  | { readonly kind: "registered"; readonly status: MobilePushInstallationStatus }
  | { readonly kind: "unavailable" };

export interface NotificationSettingsData {
  readonly preferences: NotificationPreferencesDto;
  readonly binding: NotificationBindingState;
}

export interface NotificationSettingsDraft {
  readonly defaultLevel: NotificationLevel;
}

export type NotificationSettingsOutcome =
  | { readonly status: "applied" }
  | { readonly status: "ignored" }
  | { readonly status: "failed"; readonly message: string };

export interface NotificationSettingsController {
  readonly data: SettingsDataStateController<NotificationSettingsData, NotificationSettingsDraft>;
  setScope(scope: SettingsDataScope | null): void;
  load(): Promise<SettingsLoadResult<NotificationSettingsData>>;
  retry(): Promise<SettingsLoadResult<NotificationSettingsData>>;
  setDefaultLevel(level: NotificationLevel): Promise<NotificationSettingsOutcome>;
  sendTest(): Promise<NotificationSettingsOutcome>;
}

function statusOf(error: unknown): number | null {
  return error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

function bindingIsGone(error: unknown): boolean {
  const status = statusOf(error);
  return status === 404 || status === 410;
}

function notificationSettingsErrorMessage(error: unknown, operation: "policy" | "test"): string {
  const status = statusOf(error);
  if (status === 401) return "Your session has expired. Sign in again before changing notifications.";
  if (status === 403) return "This server no longer allows this notification setting.";
  if (operation === "test" && status === 429) return "A test was sent recently. Wait a moment before trying again.";
  if (status === 503) return "Notifications are temporarily unavailable on this server.";
  return error instanceof Error && error.message
    ? error.message
    : operation === "test"
      ? "Nautilo could not send a test notification."
      : "Nautilo could not update your notification settings.";
}

function testable(binding: NotificationBindingState): binding is Extract<NotificationBindingState, { kind: "registered" }> {
  return binding.kind === "registered"
    && binding.status.enabled
    && binding.status.state === "active";
}

/**
 * Owns server-backed notification settings for one verified Human/server
 * scope. The native permission, app badge, and registration reconciler remain
 * outside this controller so they cannot be confused with M233 policy.
 */
export function createNotificationSettingsController(
  apiForScope: (scope: SettingsDataScope) => NotificationSettingsApi,
  localBindingId: (serverId: string) => Promise<string | null>,
): NotificationSettingsController {
  const data = createSettingsDataState<NotificationSettingsData, NotificationSettingsDraft>();

  const load = async (scope: SettingsDataScope): Promise<NotificationSettingsData> => {
    const api = apiForScope(scope);
    const [preferences, bindingId] = await Promise.all([
      api.getNotificationPreferences(),
      localBindingId(scope.serverId),
    ]);
    if (!bindingId) return { preferences, binding: { kind: "not_registered" } };
    try {
      const status = await api.getPushInstallationStatus(bindingId);
      return { preferences, binding: { kind: "registered", status } };
    } catch (error) {
      // The binding is locally known, so a server-side deletion/revocation is
      // a truthful re-registration state—not a generic broken Settings page.
      if (bindingIsGone(error)) return { preferences, binding: { kind: "not_registered" } };
      return { preferences, binding: { kind: "unavailable" } };
    }
  };

  const mutate = async (
    operation: (scope: SettingsDataScope) => Promise<void>,
  ): Promise<SettingsMutationResult<NotificationSettingsData>> => data.mutate(operation, load);

  return {
    data,
    setScope: (scope) => data.setScope(scope),
    load: () => data.load(load),
    retry: () => data.retryLoad(load),
    async setDefaultLevel(level) {
      const current = data.getState().data;
      if (!current || data.getState().mutating || current.preferences.defaultLevel === level) {
        return { status: "ignored" };
      }
      data.setDraft({ defaultLevel: level });
      const result = await mutate(async (scope) => {
        await apiForScope(scope).setDefaultNotificationLevel(level);
      });
      // An optimistic radio state is never a retry draft. Re-render the last
      // canonical policy after failure and make the error explicit to the UI.
      data.clearDraft();
      if (result.status === "applied") return { status: "applied" };
      if (result.status === "ignored") return { status: "ignored" };
      return { status: "failed", message: notificationSettingsErrorMessage(result.error, "policy") };
    },
    async sendTest() {
      const current = data.getState().data;
      if (!current || data.getState().mutating) return { status: "ignored" };
      const binding = current.binding;
      if (binding.kind === "not_registered") {
        return { status: "failed", message: "This phone is not registered for notifications on this server yet." };
      }
      if (binding.kind === "unavailable") {
        return { status: "failed", message: "Nautilo cannot confirm this server's notification binding right now." };
      }
      if (!testable(binding)) {
        return { status: "failed", message: "Notification delivery is not active for this phone on this server." };
      }
      const result = await mutate(async (scope) => {
        await apiForScope(scope).sendPushInstallationTest(binding.status.bindingId);
      });
      if (result.status === "applied") return { status: "applied" };
      if (result.status === "ignored") return { status: "ignored" };
      return { status: "failed", message: notificationSettingsErrorMessage(result.error, "test") };
    },
  };
}
