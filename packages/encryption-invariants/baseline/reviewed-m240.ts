import type { EncryptionCoverageEntry } from "../src/model";

/** M240 replaces the former room-message popup seam with the locked Wave 4 payload. */
export const REVIEWED_M240_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [{
    id: "notification.m240.desktop-important-message",
    surface: "notification",
    locator: "apps/desktop/electron/chat-notifications.ts#showImportantMessage",
    owner: "apps/desktop",
    readers: ["macOS Notification Center"],
    writers: [
      "apps/workbench/src/notifications/notification-state-context.tsx",
      "apps/desktop/electron/main.ts",
    ],
    migrationState: "not_applicable",
    retention:
      "The native notification is transient device-local presentation retained only under the operating system's notification lifecycle.",
    testEvidence: [
      "apps/desktop/tests/unit-isolated/chat-notifications.test.ts",
      "apps/workbench/tests/unit-isolated/notification-state-context.test.tsx",
    ],
    classification: "device_local",
    deviceStorage: "macOS Notification Center for the signed-in desktop user",
    cleanupContract:
      "Nautilo closes its live notification handle after click or close; later operating-system history retention and clearing remain under the local user's Notification Center controls.",
  }];
