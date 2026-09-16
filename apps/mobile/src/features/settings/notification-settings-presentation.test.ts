/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  canSendNotificationTest,
  deriveNotificationJourney,
  NOTIFICATION_SCOPE_OPTIONS,
} from "./notification-settings-presentation";

const base = {
  permission: "allowed" as const,
  alertCapability: "available" as const,
  selectedLevel: "direct" as const,
  binding: undefined,
  reconciliation: undefined,
  hasVerifiedServerScope: true,
  setupInFlight: false,
  deviceError: null,
  setupError: null,
};

const activeBinding = {
  kind: "registered" as const,
  status: {
    version: 1 as const,
    installationId: "11111111-1111-4111-8111-111111111111",
    bindingId: "22222222-2222-4222-8222-222222222222",
    platform: "ios" as const,
    enabled: true,
    tokenGeneration: 1,
    permission: "granted" as const,
    state: "active" as const,
    updatedAt: "2026-08-08T00:00:00.000Z",
  },
};

describe("D468 notification settings presentation", () => {
  test("denied permission wins over every binding/setup state and gives the only primary recovery", () => {
    expect(deriveNotificationJourney({
      ...base,
      permission: "denied",
      binding: activeBinding,
      reconciliation: "registered",
      setupInFlight: true,
    })).toEqual({
      kind: "off",
      title: "Notifications are off",
      detail: "Allow notifications in this phone's system settings so Nautilo can tell you when something important needs you.",
      action: { kind: "open_system_settings", label: "Open system settings" },
    });
  });

  test("unknown permission gives an explicit prompt action rather than pretending setup is running", () => {
    expect(deriveNotificationJourney({ ...base, permission: "unknown", setupInFlight: true })).toMatchObject({
      kind: "off",
      action: { kind: "request_permission", label: "Turn on notifications" },
    });
  });

  test("permission granted + active enabled binding is the only ready test state", () => {
    const journey = deriveNotificationJourney({ ...base, binding: activeBinding, reconciliation: "registered" });
    expect(journey.kind).toBe("on");
    expect(canSendNotificationTest(activeBinding)).toBe(true);
    expect(canSendNotificationTest({ ...activeBinding, status: { ...activeBinding.status, enabled: false } })).toBe(false);
  });

  test("does not treat a stale active binding as on when native push is unavailable", () => {
    expect(deriveNotificationJourney({
      ...base,
      binding: activeBinding,
      reconciliation: "native_unavailable",
    }).kind).toBe("needs_attention");
  });

  test("requires native alert capability and treats a blocked channel as system recovery", () => {
    expect(deriveNotificationJourney({
      ...base,
      binding: activeBinding,
      reconciliation: "registered",
      alertCapability: "blocked",
    })).toMatchObject({
      kind: "needs_attention",
      action: { kind: "open_system_settings" },
    });
  });

  test("treats Nothing as off by choice and iOS provisional delivery as on quietly", () => {
    expect(deriveNotificationJourney({
      ...base,
      binding: activeBinding,
      reconciliation: "registered",
      selectedLevel: "none",
    })).toMatchObject({ kind: "off", title: "Message notifications are off" });
    expect(deriveNotificationJourney({
      ...base,
      binding: activeBinding,
      reconciliation: "registered",
      permission: "provisional",
    })).toMatchObject({ kind: "on_quietly", title: "Notifications are on quietly" });
  });

  test("registration failures become actionable recovery rather than an infinite connecting state", () => {
    expect(deriveNotificationJourney({ ...base, reconciliation: "unavailable" })).toMatchObject({
      kind: "needs_attention",
      action: { kind: "retry_setup", label: "Try again" },
    });
    expect(deriveNotificationJourney({ ...base, reconciliation: "registered" })).toMatchObject({
      kind: "needs_attention",
      action: { kind: "retry_setup", label: "Try again" },
    });
  });

  test("keeps exact canonical policy enum mappings and visible outcome descriptions", () => {
    expect(NOTIFICATION_SCOPE_OPTIONS).toEqual([
      { value: "direct", label: "Directed messages", description: "Messages addressed to you." },
      { value: "all", label: "All messages", description: "Every eligible message in your chats." },
      { value: "none", label: "Nothing", description: "Do not send alerts from this server." },
    ]);
  });
});
