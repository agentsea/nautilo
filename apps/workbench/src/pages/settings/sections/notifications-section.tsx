import type { NotificationLevel } from "@nautilo/types";
import { useEffect, useState } from "react";
import { useAuth } from "../../../hooks/use-auth";
import {
  desktopAPI,
  type DesktopNotificationDeliveryStatus,
} from "../../../lib/desktop";
import { useNotificationState } from "../../../notifications/notification-state-context";
import { Button, FieldRow, SectionCard } from "../ui";

const LEVELS: readonly NotificationLevel[] = ["none", "direct", "all"];

const LABELS: Readonly<Record<NotificationLevel, string>> = {
  none: "Nothing",
  direct: "Directed messages",
  all: "All messages",
};

export function NotificationsSection() {
  const auth = useAuth();
  const notifications = useNotificationState();
  const current = notifications.snapshot?.preferences.defaultLevel;
  const mutation = notifications.defaultPreferenceMutation;
  const [deliveryStatus, setDeliveryStatus] =
    useState<DesktopNotificationDeliveryStatus | null>(null);
  const [settingsError, setSettingsError] = useState(false);

  useEffect(() => {
    const api = desktopAPI?.notifications;
    if (!api) return;
    let mounted = true;
    void api
      .getDeliveryStatus()
      .then((status) => {
        if (mounted) setDeliveryStatus(status);
      })
      .catch(() => {
        if (mounted) setDeliveryStatus(null);
      });
    const unsubscribe = api.onDeliveryStatusChange((status) => {
      if (mounted) setDeliveryStatus(status);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const openNotificationSettings = (): void => {
    setSettingsError(false);
    void desktopAPI?.notifications
      ?.openSystemSettings()
      .then((result) => setSettingsError(!result.ok))
      .catch(() => setSettingsError(true));
  };

  return (
    <SectionCard
      id="notifications"
      title="Notifications"
      description="Choose which unread messages Nautilo highlights as important."
    >
      {!auth.viewer.isVerified ? (
        <p className="text-sm text-foreground-muted">
          Sign in to manage your notification preferences.
        </p>
      ) : current === undefined ? (
        <p
          role={notifications.error ? "alert" : undefined}
          className="text-sm text-foreground-muted"
        >
          {notifications.error ??
            "Notification preferences are not available yet."}
        </p>
      ) : (
        <FieldRow
          label="Default"
          htmlFor="notification-default-level"
          hint="Applies to Rooms that do not have their own override."
        >
          <select
            id="notification-default-level"
            value={current}
            disabled={mutation.busy}
            aria-busy={mutation.busy ? "true" : undefined}
            onChange={(event) => {
              void notifications.setDefaultNotificationLevel(
                event.target.value as NotificationLevel,
              );
            }}
            className="w-full rounded-md border border-border bg-background-element px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {LABELS[level]}
              </option>
            ))}
          </select>
          {mutation.error ? (
            <p role="alert" className="mt-2 text-xs text-error">
              {mutation.error}. Try again.
            </p>
          ) : null}
          <p className="mt-2 text-xs text-foreground-muted">
            This changes which unread messages are highlighted as important.
            It does not mark messages read or silence Agents and Genies.
          </p>
        </FieldRow>
      )}
      {deliveryStatus ? (
        <div className="mt-4 border-t border-border pt-4">
          <p
            role={
              deliveryStatus.state === "delivery-failed"
                ? "alert"
                : undefined
            }
            className={
              deliveryStatus.state === "delivery-failed"
                ? "text-sm text-error"
                : "text-sm text-foreground-muted"
            }
          >
            {deliveryStatus.state === "unsupported"
              ? "Native message notifications are not supported by this desktop build."
              : deliveryStatus.state === "delivery-failed"
                ? "macOS could not complete the last native notification or Dock update."
                : "Nautilo can request macOS notifications. macOS controls whether they are displayed."}
          </p>
          {desktopAPI?.platform === "darwin" ? (
            <>
              <p className="mt-2 text-xs text-foreground-muted">
                Check System Settings → Notifications → Nautilo.
              </p>
              <div className="mt-2">
                <Button onClick={openNotificationSettings}>
                  Open notification settings
                </Button>
              </div>
            </>
          ) : null}
          {settingsError ? (
            <p role="alert" className="mt-2 text-xs text-error">
              Could not open System Settings. Open System Settings →
              Notifications → Nautilo manually.
            </p>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}
