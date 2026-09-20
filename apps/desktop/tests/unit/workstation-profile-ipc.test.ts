/**
 * Workstation Profile review / activation-preparation IPC wiring checks.
 *
 * Electron is mocked by inspecting the registered handler source rather than
 * importing main.ts, whose top-level boot path requires an Electron runtime.
 * These tests prove the bridge is sender-gated, takes no renderer-supplied
 * filesystem/profile authority fields, never activates / creates / updates /
 * grants / calls the server activation route, and exposes only a narrow,
 * redacted preload + workbench surface.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");
const main = normalizeStaticSource(
  readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
);
const preload = normalizeStaticSource(
  readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8"),
);
const desktopTypes = readFileSync(
  join(desktopRoot, "../workbench/src/lib/desktop.ts"),
  "utf-8",
);

function handlerSlice(channel: string): string {
  const start = main.indexOf(`ipcMain.handle("workstationProfiles:${channel}"`);
  expect(start).toBeGreaterThan(-1);
  if (channel === "getServerSessionStatus") {
    const helperStart = main.indexOf("async function getWorkstationServerSessionStatus(");
    const helperEnd = main.indexOf('ipcMain.handle("workstationProfiles:getServerSessionStatus"', helperStart);
    return `${main.slice(helperStart, helperEnd)} ${main.slice(start, main.indexOf("ipcMain.handle(", start + 1))}`;
  }
  if (channel === "selectActiveProfile") {
    const helperStart = main.indexOf("async function activateStoredWorkstationProfile(");
    return `${main.slice(start, main.indexOf("ipcMain.handle(", start + 1))} ${main.slice(helperStart, start)}`;
  }
  if (channel === "deactivateActiveProfile") {
    const activationSection = main.indexOf("type WorkstationProfileServerActivationResponse =", start);
    expect(activationSection).toBeGreaterThan(start);
    return main.slice(start, activationSection);
  }
  const next = main.indexOf("ipcMain.handle(", start + 1);
  return main.slice(start, next === -1 ? undefined : next);
}

function uncontainedHandlerSlice(channel: "getStatus" | "activate" | "disable"): string {
  const start = main.indexOf(`ipcMain.handle("uncontainedHostCommands:${channel}"`);
  expect(start).toBeGreaterThan(-1);
  const next = main.indexOf("ipcMain.handle(", start + 1);
  return main.slice(start, next === -1 ? undefined : next);
}

describe("uncontained-host-command IPC", () => {
  test("sender-gates every operation and retains relay/session authority in main", () => {
    for (const channel of ["getStatus", "activate", "disable"] as const) {
      const slice = uncontainedHandlerSlice(channel);
      expect(slice).toContain("assertMainWindowSender(e)");
      expect(slice).toContain("uncontainedHostCommandsBinding()");
      expect(slice).toContain("uncontainedHostCommandsBearer()");
      expect(slice).not.toContain("args?.relayId");
      expect(slice).not.toContain("args?.desktopSessionId");
    }
  });

  test("preload and renderer surface expose only PIN activation plus status/disable", () => {
    expect(preload).toContain("uncontainedHostCommands: uncontainedHostCommandsAPI");
    expect(preload).toContain('ipcRenderer.invoke("uncontainedHostCommands:activate", input)');
    expect(desktopTypes).toContain("interface DesktopUncontainedHostCommandsAPI");
    expect(desktopTypes).not.toContain("activate: (input: { pin: string; relayId");
  });

  test("main, not renderer, supplies the relay/session facts in server requests", () => {
    const activate = uncontainedHandlerSlice("activate");
    const disable = uncontainedHandlerSlice("disable");
    expect(activate).toContain("relayId: binding.relayId");
    expect(activate).toContain("desktopSessionId: binding.desktopSessionId");
    expect(activate).toContain("pin: args.pin");
    expect(disable).toContain("relayId: binding.relayId");
    expect(disable).toContain("desktopSessionId: binding.desktopSessionId");
    expect(activate).not.toContain("args?.relayId");
    expect(disable).not.toContain("args?.desktopSessionId");
  });

  test("relay admission rechecks the main-owned exact status before the runner", () => {
    expect(main).toContain("verifyUncontainedHostCommandsForRelay");
    expect(main).toContain("/api/security/uncontained-host-commands/session?");
    expect(main).toContain("binding.desktopSessionId !== current.desktopSessionId");
    expect(main).toContain("verifyUncontainedHostCommands: verifyUncontainedHostCommandsForRelay");
  });
});

const REVIEW_CHANNELS = [
  "getSeedDescriptor",
  "runDiscoveryReview",
  "listProfiles",
  "getActiveProfileSummary",
  "prepareActivation",
] as const;

describe("workstation profile review IPC — sender gating", () => {
  test("every handler sender-gates before privileged work", () => {
    for (const channel of REVIEW_CHANNELS) {
      const slice = handlerSlice(channel);
      const senderGate = slice.indexOf("assertMainWindowSender(e)");
      expect(senderGate).toBeGreaterThan(-1);
      // The gate must precede any privileged call (seed/discovery/store reads).
      expect(senderGate).toBeLessThan(
        slice.indexOf(`workstationProfiles:${channel}`) + 160,
      );
    }
  });
});

describe("workstation profile review IPC — no renderer-supplied authority", () => {
  test("no handler reads renderer-supplied roots/env/executables/facts/profile", () => {
    const forbidden = [
      "args?.roots",
      "args?.env",
      "args?.executables",
      "args?.facts",
      "args?.profile",
      "args?.request",
      "args?.discoveredRoots",
      "args?.discoveredFacts",
      "args?.subject",
      "args?.grantIds",
    ];
    for (const channel of REVIEW_CHANNELS) {
      const slice = handlerSlice(channel);
      for (const token of forbidden) {
        expect(slice).not.toContain(token);
      }
    }
  });

  test("no handler activates, creates/updates a profile, grants roots, or calls the server route", () => {
    const forbidden = [
      "activeWorkstationProfileController.activate",
      "activeWorkstationProfileController.deactivate",
      ".getProfileStore().create",
      ".getProfileStore().update",
      "desktopFilesystemGrantStore.create",
      "compileWorkstationProfileSession",
      "reAdvertiseDesktopFilesystemGrantSnapshot",
      "refreshDesktopRelayCapabilities",
    ];
    for (const channel of REVIEW_CHANNELS) {
      const slice = handlerSlice(channel);
      for (const token of forbidden) {
        expect(slice).not.toContain(token);
      }
    }
  });

  test("prepareActivation runs main-side seed + discovery and returns review facts + seed identity only", () => {
    const slice = handlerSlice("prepareActivation");
    expect(slice).toContain("materializeSeedProfileForReview()");
    expect(slice).toContain("runSeedDiscoveryReview(seed.profile)");
    expect(slice).toContain("buildSeedDescriptor(seed.profile)");
    expect(slice).toContain("review: review.review");
    // It must not return discovered facts or activate.
    expect(slice).not.toContain("result.facts");
    expect(slice).not.toContain("activate(");
  });

  test("runDiscoveryReview returns the review + seed identity, not raw discovered facts", () => {
    const slice = handlerSlice("runDiscoveryReview");
    expect(slice).toContain("runSeedDiscoveryReview(seed.profile)");
    expect(slice).toContain("review: review.review");
    expect(slice).toContain("seedIdentity");
    // Return data carries only review + seedIdentity, never a raw facts field.
    expect(slice).not.toContain("result.facts");
    expect(slice).not.toContain("data: { facts");
  });

  test("getSeedDescriptor materializes the seed in main, not from renderer input", () => {
    const slice = handlerSlice("getSeedDescriptor");
    expect(slice).toContain("materializeSeedProfileForReview()");
    expect(slice).toContain("buildSeedDescriptor(seed.profile)");
  });
});

describe("workstation profile review IPC — redacted return shapes", () => {
  test("listProfiles returns redacted summaries via buildProfileSummary", () => {
    const slice = handlerSlice("listProfiles");
    expect(slice).toContain("getProfileStore().list()");
    expect(slice).toContain("listed.data.profiles.map(buildProfileSummary)");
    // The redacting helper must omit roots / executableRules / env values.
    const helperStart = main.indexOf("function buildProfileSummary(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = main.slice(helperStart, helperStart + 600);
    expect(helper).toContain("protectedPolicyVersion: profile.protectedPolicyVersion");
    expect(helper).toContain("networkMode: profile.network.mode");
    expect(helper).toContain("capabilities: redactProfileCapabilities(profile)");
    expect(helper).not.toContain("profile.roots");
    expect(helper).not.toContain("executableRules");
    expect(helper).not.toContain("profile.environmentKeys");
  });

  test("buildSeedDescriptor redacts roots and executable paths but keeps env KEY NAMES", () => {
    const helperStart = main.indexOf("function buildSeedDescriptor(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = main.slice(helperStart, helperStart + 600);
    expect(helper).toContain("environmentKeys: [...profile.environmentKeys]");
    expect(helper).toContain("capabilities: redactProfileCapabilities(profile)");
    expect(helper).not.toContain("profile.roots");
    expect(helper).not.toContain("executableRules");
  });

  test("getActiveProfileSummary omits subject + grantIds", () => {
    const slice = handlerSlice("getActiveProfileSummary");
    expect(slice).toContain("activeWorkstationProfileController.getActiveSession()");
    expect(slice).toContain("buildActiveProfileSummary(session)");
    const helperStart = main.indexOf("function buildActiveProfileSummary(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = main.slice(helperStart, helperStart + 600);
    expect(helper).toContain("profileId: session.profileId");
    expect(helper).toContain("compiledAt: session.compiledAt");
    expect(helper).not.toContain("session.subject");
    expect(helper).not.toContain("session.grantIds");
  });

  test("redactProfileCapabilities emits only id + backend", () => {
    const helperStart = main.indexOf("function redactProfileCapabilities(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = main.slice(helperStart, helperStart + 400);
    expect(helper).toContain("id: capability.id");
    expect(helper).toContain("backend: capability.backend");
    expect(helper).not.toContain("capability.executable");
    expect(helper).not.toContain("capability.roots");
    expect(helper).not.toContain("capability.environmentKeys");
  });
});

describe("workstation profile server-session status IPC", () => {
  test("is sender-gated and parses only the redacted profile selectors", () => {
    const slice = handlerSlice("getServerSessionStatus");
    expect(slice).toContain("assertMainWindowSender(e)");
    expect(slice).toContain("/api/workstation-access/session");
    expect(slice).toContain("profileId: session.profileId");
    expect(slice).toContain("profileRevision: session.profileRevision");
    expect(slice).not.toContain("grantIds: session.");
    expect(slice).not.toContain("serverBindingId: session.");
    expect(slice).not.toContain("desktopSessionId: session.");
  });

  test("fails closed for missing tokens, failed HTTP responses, and malformed server bodies", () => {
    const slice = handlerSlice("getServerSessionStatus");
    expect(slice).toContain("if (!bearerToken) return {confirmed: false, session: null}");
    expect(slice).toContain("if (!response.ok) return {confirmed: false, session: null}");
    expect(slice).toContain("body.ok !== true");
    expect(slice).toContain('typeof session?.profileId !== "string"');
    expect(slice).toContain("!Number.isSafeInteger(session.profileRevision)");
    expect(slice).toContain("return {confirmed: false, session: null}");
  });

  test("exposes the read-only status method through preload and workbench types", () => {
    expect(preload).toContain("getServerSessionStatus:");
    expect(preload).toContain('ipcRenderer.invoke("workstationProfiles:getServerSessionStatus")');
    expect(desktopTypes).toContain("DesktopWorkstationServerSessionStatus");
    expect(desktopTypes).toContain("getServerSessionStatus: ()");
  });
});

describe("workstation profile review IPC — preload + workbench surface", () => {
  test("preload exposes only the narrow bridge with no fs/profile-authority methods", () => {
    const bridgeStart = preload.indexOf("const workstationProfilesAPI = {");
    expect(bridgeStart).toBeGreaterThan(-1);
    const bridge = preload.slice(bridgeStart, bridgeStart + 1400);
    for (const method of [
      "getSeedDescriptor:",
      "runDiscoveryReview:",
      "listProfiles:",
      "getActiveProfileSummary:",
      "prepareActivation:",
    ]) {
      expect(bridge).toContain(method);
    }
    // No filesystem read/browse, no activation method, no create/update, no subject.
    expect(bridge).not.toContain("readDir");
    expect(bridge).not.toContain("readFile");
    expect(bridge).not.toContain("activate:");
    expect(bridge).not.toContain("selectActiveProfile");
    expect(bridge).not.toContain("createProfile");
    expect(bridge).not.toContain("updateProfile");
    expect(bridge).not.toContain("subject:");
    expect(bridge).not.toContain("grantIds:");
    // Every method invokes the matching channel with no privileged payload.
    for (const channel of REVIEW_CHANNELS) {
      expect(bridge).toContain(
        `ipcRenderer.invoke("workstationProfiles:${channel}")`,
      );
    }
  });

  test("preload mounts the namespace on the exposed desktop bridge", () => {
    expect(preload).toContain("workstationProfiles: workstationProfilesAPI");
  });

  test("workbench desktop.ts declares the redacted types + optional namespace", () => {
    expect(desktopTypes).toContain(
      "export interface DesktopWorkstationProfilesAPI",
    );
    expect(desktopTypes).toContain(
      "export interface DesktopWorkstationProfileSeedDescriptor",
    );
    expect(desktopTypes).toContain(
      "export interface DesktopWorkstationProfileSummary",
    );
    expect(desktopTypes).toContain(
      "export interface DesktopActiveWorkstationProfileSummary",
    );
    expect(desktopTypes).toContain(
      "export interface DesktopWorkstationDiscoveryReview",
    );
    expect(desktopTypes).toContain(
      "export type WorkstationProfileIpcFailureCode",
    );
    expect(desktopTypes).toContain("workstationProfiles?: DesktopWorkstationProfilesAPI");
    // The summary types must not expose roots / executableRules / subject.
    const summaryStart = desktopTypes.indexOf(
      "export interface DesktopWorkstationProfileSummary",
    );
    const summaryBlock = desktopTypes.slice(summaryStart, summaryStart + 400);
    expect(summaryBlock).not.toContain("roots:");
    expect(summaryBlock).not.toContain("executableRules:");
    const activeStart = desktopTypes.indexOf(
      "export interface DesktopActiveWorkstationProfileSummary",
    );
    const activeBlock = desktopTypes.slice(activeStart, activeStart + 400);
    expect(activeBlock).not.toContain("subject");
    expect(activeBlock).not.toContain("grantIds");
  });
});

// ── Workstation Profile management bridge (narrow, sender-gated) ────

const MANAGEMENT_CHANNELS = [
  "materializeSeedProfile",
  "deactivateActiveProfile",
] as const;

describe("workstation profile management IPC — sender gating", () => {
  test("every management handler sender-gates before privileged work", () => {
    for (const channel of MANAGEMENT_CHANNELS) {
      const slice = handlerSlice(channel);
      const senderGate = slice.indexOf("assertMainWindowSender(e)");
      expect(senderGate).toBeGreaterThan(-1);
      expect(senderGate).toBeLessThan(
        slice.indexOf(`workstationProfiles:${channel}`) + 160,
      );
    }
  });
});

describe("workstation profile management IPC — no renderer-supplied authority", () => {
  test("no management handler reads renderer-supplied roots/env/executables/facts/profile/subject", () => {
    const forbidden = [
      "args?.roots",
      "args?.env",
      "args?.executables",
      "args?.facts",
      "args?.profile",
      "args?.request",
      "args?.discoveredRoots",
      "args?.discoveredFacts",
      "args?.subject",
      "args?.grantIds",
      "args?.profileId",
    ];
    for (const channel of MANAGEMENT_CHANNELS) {
      const slice = handlerSlice(channel);
      for (const token of forbidden) {
        expect(slice).not.toContain(token);
      }
    }
  });

  test("no management handler activates, updates a profile, compiles, or re-advertises", () => {
    const forbidden = [
      "activeWorkstationProfileController.activate",
      ".getProfileStore().update",
      "compileWorkstationProfileSession",
      "reAdvertiseDesktopFilesystemGrantSnapshot",
      "refreshDesktopRelayCapabilities",
    ];
    for (const channel of MANAGEMENT_CHANNELS) {
      const slice = handlerSlice(channel);
      for (const token of forbidden) {
        expect(slice).not.toContain(token);
        // No `.activate(` call (precise: `.deactivate()` must still be allowed).
        expect(slice).not.toContain(".activate(");
      }
    }
  });
});

describe("workstation profile management IPC — materialize / deactivate behavior", () => {
  test("materializeSeedProfile idempotently persists the main-materialized seed via the owned store", () => {
    const slice = handlerSlice("materializeSeedProfile");
    // Main materializes the seed itself — no renderer profile payload.
    expect(slice).toContain("materializeSeedProfileForReview()");
    // Idempotent read-then-create against the controller's owned store.
    expect(slice).toContain("activeWorkstationProfileController.getProfileStore()");
    expect(slice).toContain("store.get({profileId: seed.profile.id})");
    expect(slice).toContain("store.create({profile: seed.profile})");
    // Returns a redacted summary (never roots / executableRules), a created
    // flag, and the store envelope revision.
    expect(slice).toContain("buildProfileSummary(");
    expect(slice).toContain("created: false");
    expect(slice).toContain("created: true");
    expect(slice).toContain("revision:");
    // It must NOT create authority or activate.
    expect(slice).not.toContain("activeWorkstationProfileController.activate");
    expect(slice).not.toContain("compileWorkstationProfileSession");
  });

  test("deactivateActiveProfile revokes the active session via the controller (authority-reducing only)", () => {
    const slice = handlerSlice("deactivateActiveProfile");
    expect(slice).toContain("activeWorkstationProfileController.deactivate()");
    // The renderer never supplies subject / grantIds — the controller owns
    // the session.
    expect(slice).not.toContain("args?.subject");
    expect(slice).not.toContain("args?.grantIds");
    // It must NOT activate or create/update a profile.
    expect(slice).not.toContain("activeWorkstationProfileController.activate");
    expect(slice).not.toContain(".getProfileStore().create");
    expect(slice).not.toContain(".getProfileStore().update");
    // A no-active-profile state is a benign no-op (cleared: 0), not a failure.
    expect(slice).toContain('"no_active_profile"');
    expect(slice).toContain("cleared: 0");
  });
});

describe("workstation profile management IPC — preload + workbench surface", () => {
  test("preload exposes the two management methods with no privileged payload", () => {
    const bridgeStart = preload.indexOf("const workstationProfilesAPI = {");
    expect(bridgeStart).toBeGreaterThan(-1);
    const bridge = preload.slice(bridgeStart, bridgeStart + 2000);
    for (const method of ["materializeSeedProfile:", "deactivateActiveProfile:"]) {
      expect(bridge).toContain(method);
    }
    for (const channel of MANAGEMENT_CHANNELS) {
      expect(bridge).toContain(
        `ipcRenderer.invoke("workstationProfiles:${channel}")`,
      );
    }
    // No filesystem read/browse, no activation, no create/update, no subject.
    expect(bridge).not.toContain("readDir");
    expect(bridge).not.toContain("readFile");
    expect(bridge).not.toContain("activate:");
    expect(bridge).not.toContain("createProfile");
    expect(bridge).not.toContain("updateProfile");
    expect(bridge).not.toContain("subject:");
  });

  test("workbench desktop.ts declares the management methods on the profiles API", () => {
    const apiStart = desktopTypes.indexOf("export interface DesktopWorkstationProfilesAPI");
    expect(apiStart).toBeGreaterThan(-1);
    const apiBlock = desktopTypes.slice(apiStart, apiStart + 2400);
    expect(apiBlock).toContain("materializeSeedProfile:");
    expect(apiBlock).toContain("deactivateActiveProfile:");
    // The materialize return carries a redacted summary + created flag +
    // revision; it must not expose roots / executableRules / subject.
    const materializeStart = apiBlock.indexOf("materializeSeedProfile:");
    const materializeBlock = apiBlock.slice(materializeStart, materializeStart + 500);
    expect(materializeBlock).toContain("DesktopWorkstationProfileSummary");
    expect(materializeBlock).toContain("created: boolean");
    expect(materializeBlock).toContain("revision: number");
    expect(materializeBlock).not.toContain("roots:");
    expect(materializeBlock).not.toContain("executableRules:");
    expect(materializeBlock).not.toContain("subject");
    // The deactivate return carries only cleared + skipped.
    const deactivateStart = apiBlock.indexOf("deactivateActiveProfile:");
    const deactivateBlock = apiBlock.slice(deactivateStart, deactivateStart + 400);
    expect(deactivateBlock).toContain("cleared: number");
    expect(deactivateBlock).toContain("skipped: readonly string[]");
    expect(deactivateBlock).not.toContain("subject");
    expect(deactivateBlock).not.toContain("grantIds");
  });
});

// ── Workstation Profile activation seam (selectActiveProfile) ───────
//
// The activation channel is the ONE bridge method that compiles a stored
// profile into live authority — and only after the server proof flow
// (capability gate + the activating user's OWN fresh PIN + authoritative
// relay binding) succeeds. The renderer supplies ONLY profileId +
// profileRevision + pin; every authority-bearing field is main/server
// derived.

const ACTIVATION_CHANNEL = "selectActiveProfile";

describe("workstation profile activation IPC — sender gating", () => {
  test("selectActiveProfile sender-gates before privileged work", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    const senderGate = slice.indexOf("assertMainWindowSender(e)");
    expect(senderGate).toBeGreaterThan(-1);
    expect(senderGate).toBeLessThan(
      slice.indexOf(`workstationProfiles:${ACTIVATION_CHANNEL}`) + 160,
    );
  });
});

describe("workstation profile activation IPC — renderer supplies only selectors + PIN", () => {
  test("the handler reads ONLY profileId + profileRevision + pin from args", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    // The three allowed renderer inputs.
    expect(slice).toContain("args?.profileId");
    expect(slice).toContain("args?.profileRevision");
    expect(slice).toContain("args?.pin");
    // The renderer must never supply privileged authority fields. profileId
    // + profileRevision are SELECTORS of an existing stored profile, not a
    // profile payload; they are the only allowed args keys.
    const forbidden = [
      "args?.roots",
      "args?.env",
      "args?.executables",
      "args?.facts",
      "args?.subject",
      "args?.grantIds",
      "args?.request",
      "args?.discoveredRoots",
      "args?.discoveredFacts",
    ];
    for (const token of forbidden) {
      expect(slice).not.toContain(token);
    }
  });
});

describe("workstation profile activation IPC — server proof gate before compile", () => {
  test("the handler calls the server activation seam + controller.activate + discovery on the success path", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    // The server proof seam — the authoritative gate.
    expect(slice).toContain("activateWorkstationProfileViaServer(");
    // Discovery + compile happen ONLY after the server proof succeeds.
    expect(slice).toContain("discoverWorkstationFacts({profile})");
    expect(slice).toContain("activeWorkstationProfileController.activate(");
    // The redacted summary is built from the compiled session.
    expect(slice).toContain("buildActiveProfileSummary(");
  });

  test("the handler explicitly awaits relay advertisement and rolls back on failure", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    expect(slice).toContain("const advertisement = refreshDesktopRelayCapabilities");
    expect(slice).toContain("? await advertisement");
    expect(slice).toContain("activeWorkstationProfileController.deactivate()");
  });

  test("the handler does NOT call the compiler directly (compile is via the controller)", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    expect(slice).not.toContain("compileWorkstationProfileSession");
  });

  test("the handler verifies the stored profile revision EXACTLY matches the request (wrong-revision rejection)", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    expect(slice).toContain("stored.data.profile.revision");
    expect(slice).toContain("stale_revision");
  });

  test("the handler maps server denials to typed IPC failures and compiles nothing on failure", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    // Server denial → typed IPC failure codes (no compile on failure).
    expect(slice).toContain('"invalid_pin"');
    expect(slice).toContain('"capability_missing"');
    expect(slice).toContain('"relay_binding_unavailable"');
    expect(slice).toContain('"duplicate_active"');
    expect(slice).toContain('"lockout"');
    // The controller.activate call must be guarded behind serverResult.ok.
    const activateIdx = slice.indexOf("activeWorkstationProfileController.activate(");
    const serverOkBranchIdx = slice.indexOf("if (!serverResult.ok)");
    expect(serverOkBranchIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(serverOkBranchIdx);
  });

  test("the handler translates internal activation conflict tokens before rendering them", () => {
    const slice = handlerSlice(ACTIVATION_CHANNEL);
    expect(slice).toContain("workstationProfileActivationErrorMessage(serverResult.error)");
    expect(slice).toContain("workstationProfileActivationErrorMessage(completed.error)");
    expect(main).toContain('error === "broader_revision"');
    expect(main).toContain("Developer Workstation changed during activation.");
  });
});

describe("workstation profile activation IPC — preload + workbench surface", () => {
  test("preload exposes selectActiveProfile with only profileId + profileRevision + pin", () => {
    const bridgeStart = preload.indexOf("const workstationProfilesAPI = {");
    expect(bridgeStart).toBeGreaterThan(-1);
    // Slice a wide window so the activation method (added at the end of the
    // object) is included.
    const bridge = preload.slice(bridgeStart, bridgeStart + 3200);
    expect(bridge).toContain("selectActiveProfile:");
    expect(bridge).toContain(
      'ipcRenderer.invoke("workstationProfiles:selectActiveProfile"',
    );
    // The preload input type carries only the three selectors — no
    // privileged authority fields.
    const methodStart = bridge.indexOf("selectActiveProfile:");
    const methodBlock = bridge.slice(methodStart, methodStart + 700);
    expect(methodBlock).toContain("profileId: string");
    expect(methodBlock).toContain("profileRevision: number");
    expect(methodBlock).toContain("pin: string");
    expect(methodBlock).not.toContain("subject:");
    expect(methodBlock).not.toContain("grantIds:");
    expect(methodBlock).not.toContain("roots:");
    // No filesystem read/browse, no create/update method names.
    expect(bridge).not.toContain("readDir");
    expect(bridge).not.toContain("readFile");
    expect(bridge).not.toContain("createProfile");
    expect(bridge).not.toContain("updateProfile");
  });

  test("workbench desktop.ts declares selectActiveProfile with the redacted return shape", () => {
    const apiStart = desktopTypes.indexOf("export interface DesktopWorkstationProfilesAPI");
    expect(apiStart).toBeGreaterThan(-1);
    const apiBlock = desktopTypes.slice(apiStart, apiStart + 3200);
    expect(apiBlock).toContain("selectActiveProfile:");
    const methodStart = apiBlock.indexOf("selectActiveProfile:");
    const methodBlock = apiBlock.slice(methodStart, methodStart + 900);
    // Input carries only the three selectors.
    expect(methodBlock).toContain("profileId: string");
    expect(methodBlock).toContain("profileRevision: number");
    expect(methodBlock).toContain("pin: string");
    expect(methodBlock).not.toContain("subject");
    expect(methodBlock).not.toContain("grantIds");
    expect(methodBlock).not.toContain("roots:");
    // Return carries the redacted active summary + outcome only.
    expect(methodBlock).toContain("DesktopActiveWorkstationProfileSummary");
    expect(methodBlock).toContain("outcome: string");
    expect(methodBlock).not.toContain("serverBindingId: string");
  });
});
