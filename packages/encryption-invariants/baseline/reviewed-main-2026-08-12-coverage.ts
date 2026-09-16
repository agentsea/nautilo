import type { EncryptionCoverageEntry } from "../src/model";

const PREFERENCE_EVIDENCE =
  "apps/workbench/tests/unit-isolated/app-preferences.test.ts";

const DEVICE_LOCAL_PREFERENCE_LOCATORS = [
  "app_bridge:app_to_host:nautilo.app.preferences.req#get",
  "app_bridge:app_to_host:nautilo.app.preferences.req#get#key",
  "app_bridge:app_to_host:nautilo.app.preferences.req#set",
  "app_bridge:app_to_host:nautilo.app.preferences.req#set#key",
  "app_bridge:app_to_host:nautilo.app.preferences.req#set#value",
  "app_bridge:app_to_host:nautilo.app.preferences.subscribe",
  "app_bridge:app_to_host:nautilo.app.preferences.subscribe#key",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceGetRequest",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceGetRequest#key",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceSetRequest",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceSetRequest#key",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceSetRequest#value",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceSubscribeMessage",
  "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppPreferenceSubscribeMessage#key",
  "app_bridge:host_to_app:nautilo.app.preferences.changed",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest#key",
] as const;

/**
 * Writer spell preferences, including the Human-authored personal dictionary,
 * never leave the browser profile. The app bridge is an in-process sandbox
 * boundary and validates the sole supported key and closed value schema before
 * best-effort device-local persistence.
 */
export const REVIEWED_MAIN_2026_08_12_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] =
  DEVICE_LOCAL_PREFERENCE_LOCATORS.map((locator, index) => ({
    id: `wire.main-2026-08-12.device-preference-${index + 1}`,
    surface: "wire",
    locator,
    owner: "apps/workbench",
    readers: ["apps/workbench/src/apps/app-bridge.ts"],
    writers: ["apps/workbench/src/lib/app-preferences.ts"],
    migrationState: "not_applicable",
    retention:
      "Retained only in the current browser profile for the owning viewer and mini-app; no server or shared product repository receives it.",
    testEvidence: [PREFERENCE_EVIDENCE],
    classification: "device_local",
    deviceStorage:
      "Browser localStorage under nautilo.app-preferences.v1, scoped by viewer, app, and the closed preference key.",
    cleanupContract:
      "Clearing Nautilo site data or the browser profile removes the preference; anonymous viewers cannot persist it and no server-side copy exists.",
  }));
