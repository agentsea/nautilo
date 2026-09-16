import type { NotificationLevel } from "@nautilo/types";

import type { NotificationBindingState } from "./notification-settings-controller";

/** The only three server-owned choices a Human makes on this screen. */
export const NOTIFICATION_SCOPE_OPTIONS: readonly {
  readonly value: NotificationLevel;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "direct",
    label: "Directed messages",
    description: "Messages addressed to you.",
  },
  {
    value: "all",
    label: "All messages",
    description: "Every eligible message in your chats.",
  },
  {
    value: "none",
    label: "Nothing",
    description: "Do not send alerts from this server.",
  },
];

export type NotificationJourneyKind = "off" | "connecting" | "on_quietly" | "on" | "needs_attention";

export type NotificationJourneyAction =
  | { readonly kind: "request_permission"; readonly label: "Turn on notifications" }
  | { readonly kind: "open_system_settings"; readonly label: "Open system settings" }
  | { readonly kind: "retry_setup"; readonly label: "Try again" }
  | null;

export interface NotificationJourney {
  readonly kind: NotificationJourneyKind;
  readonly title: string;
  readonly detail: string;
  readonly action: NotificationJourneyAction;
}

export interface NotificationJourneyInput {
  readonly permission: "unavailable" | "unknown" | "provisional" | "allowed" | "denied" | undefined;
  readonly alertCapability: "available" | "blocked" | "unavailable" | undefined;
  readonly selectedLevel: NotificationLevel | undefined;
  readonly binding: NotificationBindingState | undefined;
  readonly reconciliation:
    | "registered"
    | "disabled"
    | "unchanged"
    | "signed_out"
    | "identity_unverified"
    | "identity_mismatch"
    | "native_unavailable"
    | "removed"
    | "unavailable"
    | "cancelled"
    | undefined;
  readonly hasVerifiedServerScope: boolean;
  readonly setupInFlight: boolean;
  readonly deviceError: string | null;
  readonly setupError: string | null;
}

function needsAttention(
  title: string,
  detail: string,
  action: Exclude<NotificationJourneyAction, null> | null = null,
): NotificationJourney {
  return {
    kind: "needs_attention",
    title,
    detail,
    action,
  };
}

function activeBinding(binding: NotificationBindingState | undefined): boolean {
  return binding?.kind === "registered"
    && binding.status.state === "active"
    && binding.status.enabled;
}

/**
 * Collapses native permission, local binding, and server reconciliation into
 * one Human-readable outcome. Those authorities remain separate in code.
 * The permission branches deliberately precede every setup branch: a denied
 * OS permission must never render a misleading connecting state.
 */
export function deriveNotificationJourney(input: NotificationJourneyInput): NotificationJourney {
  if (input.permission === "denied") {
    return {
      kind: "off",
      title: "Notifications are off",
      detail: "Allow notifications in this phone's system settings so Nautilo can tell you when something important needs you.",
      action: { kind: "open_system_settings", label: "Open system settings" },
    };
  }

  if (input.permission === "unknown") {
    return {
      kind: "off",
      title: "Notifications are off",
      detail: "Allow Nautilo to tell you when something important needs you.",
      action: { kind: "request_permission", label: "Turn on notifications" },
    };
  }

  if (input.permission === "unavailable") {
    return needsAttention(
      "Notifications aren't available",
      "This device or app build cannot receive Nautilo notifications.",
    );
  }

  if (input.permission === undefined) {
    return {
      kind: "connecting",
      title: "Checking notifications",
      detail: "Nautilo is checking this phone's notification permission.",
      action: null,
    };
  }

  if (input.deviceError) {
    return needsAttention("Notifications need attention", input.deviceError, { kind: "retry_setup", label: "Try again" });
  }

  if (!input.hasVerifiedServerScope) {
    return needsAttention(
      "Sign in to set up notifications",
      "Reconnect to this server before changing its notification settings.",
    );
  }

  if (input.reconciliation === "signed_out") {
    return needsAttention("Sign in to set up notifications", "Sign in again to connect this phone to this server.");
  }
  if (input.reconciliation === "identity_unverified" || input.reconciliation === "identity_mismatch") {
    return needsAttention("Notifications need attention", "Verify this account before connecting this phone to this server.");
  }
  if (input.reconciliation === "native_unavailable") {
    return needsAttention("Notifications aren't available", "This app build cannot connect this phone for push notifications.");
  }
  if (input.alertCapability === "blocked") {
    return needsAttention(
      "Notifications need attention",
      "Alerts are disabled in this phone's system notification settings.",
      { kind: "open_system_settings", label: "Open system settings" },
    );
  }
  if (input.reconciliation === "unavailable" || input.binding?.kind === "unavailable" || input.setupError) {
    return needsAttention(
      "Nautilo couldn't connect this phone",
      input.setupError ?? "This server is temporarily unavailable. Try connecting this phone again.",
      { kind: "retry_setup", label: "Try again" },
    );
  }
  if (input.binding?.kind === "registered" && input.binding.status.state === "disabled") {
    return needsAttention("Notifications are paused", "This phone's notification delivery is disabled on this server.", { kind: "retry_setup", label: "Try again" });
  }
  if (input.binding?.kind === "registered" && input.binding.status.state === "revoked") {
    return needsAttention("Notifications need attention", "This phone is no longer registered with this server.", { kind: "retry_setup", label: "Try again" });
  }

  // A stale persisted binding is not proof that Android's current channel /
  // native token is usable. A current successful reconciliation is required
  // before presenting delivery as on.
  const reconciledBinding = activeBinding(input.binding)
    && (input.reconciliation === "registered" || input.reconciliation === "unchanged");
  if (reconciledBinding && input.alertCapability === "available" && input.selectedLevel === "none") {
    return {
      kind: "off",
      title: "Message notifications are off",
      detail: "This phone is ready, but you chose not to receive message alerts from this server.",
      action: null,
    };
  }
  if (reconciledBinding && input.alertCapability === "available") {
    return {
      kind: input.permission === "provisional" ? "on_quietly" : "on",
      title: input.permission === "provisional" ? "Notifications are on quietly" : "Notifications are on",
      detail: input.permission === "provisional"
        ? "This phone delivers Nautilo notifications quietly. You can allow prominent alerts in system settings."
        : "Nautilo can privately alert this phone when something important needs you.",
      action: null,
    };
  }

  if (input.setupInFlight || input.reconciliation === undefined || input.reconciliation === "cancelled") {
    return {
      kind: "connecting",
      title: "Connecting this phone",
      detail: "System permission is on. Nautilo is securely connecting this phone to this server.",
      action: null,
    };
  }

  return needsAttention(
    "Nautilo couldn't connect this phone",
    "This phone is not registered for notifications on this server yet.",
    { kind: "retry_setup", label: "Try again" },
  );
}

export function canSendNotificationTest(binding: NotificationBindingState | undefined): boolean {
  return activeBinding(binding);
}
