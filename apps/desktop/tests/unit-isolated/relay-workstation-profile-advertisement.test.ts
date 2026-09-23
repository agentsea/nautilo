/**
 * Relay Workstation Profile advertisement wiring tests.
 *
 * Verifies the relay capability builder includes the shared
 * ActiveWorkstationProfileController's redacted profile snapshot in
 * `RelayCapabilities.workstationProfileSnapshot`, that the relay shares the
 * main-process controller (no duplicate stores), and that activation /
 * deactivation re-advertises atomically via `refreshDesktopRelayCapabilities`.
 *
 * `electron/main.ts` cannot be imported under bun:test (Electron runtime
 * boot), so main wiring is pinned at source level. The relay helper is
 * exercised directly with electron mocked.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeStaticSource } from "../unit/static-source";

import { parseRelayWorkstationProfileSnapshot, type RelayWorkstationProfileSnapshot } from "@nautilo/relay";

// `../../electron/relay` transitively imports `./paths`, which imports the
// Electron `app`. Under `bun test` (no Electron runtime) that module throws
// at load, so we stub it before dynamically importing the helper below.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-test-userdata" },
}));

type ResolveDesktopProfileAdvertisement = (
  provider: import("../../electron/relay").RelayWorkstationProfileSnapshotProvider | null | undefined,
) => Promise<RelayWorkstationProfileSnapshot | undefined>;

let resolveDesktopProfileAdvertisement: ResolveDesktopProfileAdvertisement;

beforeAll(async () => {
  ({
    resolveDesktopProfileAdvertisement,
  } = await import("../../electron/relay"));
});

const SNAPSHOT: RelayWorkstationProfileSnapshot = {
  profileId: "profile-developer-workstation",
  profileRevision: 3,
  grantIds: ["grant-1", "grant-2"],
  protectedPolicyVersion: 2,
  networkMode: "isolated",
  capabilities: [
    { id: "cap-bun", backend: "sandboxed" },
    { id: "cap-docker-compose", backend: "brokered_host_service" },
  ],
};

describe("resolveDesktopProfileAdvertisement — builder inclusion helper", () => {
  test("returns the provider's snapshot so the builder can spread it into capabilities", async () => {
    const provider = { getProfileSnapshot: async () => SNAPSHOT };
    const result = await resolveDesktopProfileAdvertisement(provider);
    expect(result).toEqual(SNAPSHOT);
    // The snapshot must round-trip the strict protocol parser.
    expect(parseRelayWorkstationProfileSnapshot(result!)).toEqual({ ok: true, snapshot: SNAPSHOT });
  });

  test("returns undefined when no provider is bound so the builder omits the field", async () => {
    expect(await resolveDesktopProfileAdvertisement(null)).toBeUndefined();
    expect(await resolveDesktopProfileAdvertisement(undefined)).toBeUndefined();
  });

  test("returns undefined when the provider has no active profile", async () => {
    const provider = { getProfileSnapshot: async () => undefined };
    expect(await resolveDesktopProfileAdvertisement(provider)).toBeUndefined();
  });

  test("swallows a provider error so a controller fault never tears down a capability update", async () => {
    const provider = {
      getProfileSnapshot: async (): Promise<RelayWorkstationProfileSnapshot | undefined> => {
        throw new Error("controller unavailable");
      },
    };
    expect(await resolveDesktopProfileAdvertisement(provider)).toBeUndefined();
  });
});

describe("relay capability builder — profile snapshot inclusion (source wiring)", () => {
  const desktopRoot = join(import.meta.dir, "../..");
  const relay = readFileSync(join(desktopRoot, "electron/relay.ts"), "utf-8");

  test("StartRelayOptions carries a workstationProfileController provider field", () => {
    const optsStart = relay.indexOf("export interface StartRelayOptions");
    expect(optsStart).toBeGreaterThan(-1);
    const optsSlice = relay.slice(optsStart, relay.indexOf("export async function startRelay", optsStart));
    expect(optsSlice).toContain("workstationProfileController?:");
    expect(optsSlice).toContain("RelayWorkstationProfileSnapshotProvider");
  });

  test("startRelay captures the controller in its session-local builder", () => {
    const startFn = relay.indexOf("export async function startRelay");
    expect(startFn).toBeGreaterThan(-1);
    const startSlice = relay.slice(startFn, relay.indexOf("export async function stopRelay", startFn));
    // The provider is consumed directly from options and retained only by
    // this session's builder and resolver.
    expect(startSlice).toContain("options.workstationProfileController ?? null");
    expect(startSlice).not.toContain("workstationProfileSnapshotProvider");
  });

  test("startRelay constructs the shell-binding authority from the controller-sourced provider", () => {
    const startFn = relay.indexOf("export async function startRelay");
    expect(startFn).toBeGreaterThan(-1);
    const startSlice = relay.slice(startFn, relay.indexOf("export async function stopRelay", startFn));
    // The provider capture MUST precede the shell-binding authority build so
    // the resolver is constructed on a fresh relay (defect 1: previously the
    // authority was gated on the module global, which was only assigned AFTER
    // the authority block, so the resolver was absent on a fresh startRelay).
    const providerIdx = startSlice.indexOf("options.workstationProfileController ?? null");
    expect(providerIdx).toBeGreaterThan(-1);
    const authorityIdx = startSlice.indexOf("const workstationShellBindingAuthority =");
    expect(authorityIdx).toBeGreaterThan(-1);
    expect(authorityIdx).toBeGreaterThan(providerIdx);
    // The authority gates on the controller-sourced local, not the global.
    const authoritySlice = startSlice.slice(authorityIdx, startSlice.indexOf("undefined;", authorityIdx));
    expect(authoritySlice).toContain("workstationProfileProvider !== null");
    expect(authoritySlice).toContain("profileProvider: workstationProfileProvider");
    expect(authoritySlice).not.toContain("workstationProfileSnapshotProvider");
  });

  test("the capability builder resolves the profile snapshot and spreads it into RelayCapabilities", () => {
    const builderStart = relay.indexOf("const capabilitiesBuilder = async (): Promise<RelayCapabilities> =>");
    expect(builderStart).toBeGreaterThan(-1);
    const builderEnd = relay.indexOf("const candidateMcpHost = createRelayMcpHost", builderStart);
    expect(builderEnd).toBeGreaterThan(builderStart);
    const builder = relay.slice(builderStart, builderEnd);

    const resolveIdx = builder.indexOf("resolveDesktopProfileAdvertisement(");
    const spreadIdx = builder.indexOf("workstationProfileSnapshot: profileSnapshot");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(spreadIdx).toBeGreaterThan(resolveIdx);
    // The snapshot is omitted (conditional spread) when no profile is bound.
    expect(builder).toMatch(
      /\.\.\.\(profileSnapshot\s*\?\s*\{\s*workstationProfileSnapshot:\s*profileSnapshot\s*\}\s*:\s*\{\}\)/,
    );
  });

  test("the provider interface is exported for the main-process controller to implement", () => {
    expect(relay).toContain("export interface RelayWorkstationProfileSnapshotProvider");
    expect(relay).toContain("getProfileSnapshot(): Promise<RelayWorkstationProfileSnapshot | undefined>");
  });

  test("the active session owns its publisher and acknowledged revision without shadow state", () => {
    const startFn = relay.indexOf("export async function startRelay");
    const stopFn = relay.indexOf("export async function stopRelay");
    const startSlice = relay.slice(startFn, stopFn);
    const stopSlice = relay.slice(stopFn, relay.indexOf("export function getRelayStatus", stopFn));

    expect(relay).toContain('import {\n  createRelayCapabilityPublisher,');
    expect(startSlice).toContain("let candidatePublisher: RelayCapabilityPublisher | null = null;");
    expect(startSlice).toContain("candidatePublisher = createRelayCapabilityPublisher({");
    expect(startSlice).toContain("client: candidateClient,");
    expect(startSlice).toContain("capabilityBuilder: capabilitiesBuilder,");
    expect(startSlice).toContain("candidateSession.attachTransport(candidateClient, candidatePublisher);");
    expect(startSlice).toContain("sessionClient?.getAcknowledgedCapabilityRevision() ?? -1");
    expect(startSlice).toContain("activeRelaySession = candidateSession;");
    expect(startSlice).toContain("capabilityPublisher = candidatePublisher;");
    expect(stopSlice).toContain("const pendingSessionToRetire = pendingRelayCandidate?.session ?? null;");
    expect(stopSlice).toContain("const activeSessionToRetire = activeRelaySession;");
    expect(stopSlice).toContain("activeRelaySession = null;");
    expect(stopSlice).toContain("capabilityPublisher = null;");
    expect(stopSlice).toContain("const retiredSessions = sessionsToRetire.map");
    expect(stopSlice).toContain("retired: session.retire(),");
    expect(stopSlice.indexOf("session.retire()")).toBeLessThan(
      stopSlice.indexOf("await retired.client?.disconnect()"),
    );
    expect(relay).toContain("return activeRelaySession?.publisher?.refresh(reason) ?? false;");
    expect(relay).not.toContain("currentCapabilityRevision");
    expect(relay).not.toContain("activeRefresh");
    expect(relay).not.toContain("refreshFollowUpPending");
    expect(relay).not.toContain("relayRefreshForTests");
  });

  test("cleans up a rejected candidate and defers initial topology reconciliation to its exact publisher", () => {
    const startFn = relay.indexOf("export async function startRelay");
    const stopFn = relay.indexOf("export async function stopRelay");
    const startSlice = relay.slice(startFn, stopFn);
    const candidateCatchStart = startSlice.lastIndexOf("} catch (error) {");
    const candidateCatchEnd = startSlice.indexOf("throw error;", candidateCatchStart);
    const candidateCatch = startSlice.slice(candidateCatchStart, candidateCatchEnd);
    const reconciliationStart = startSlice.indexOf("const reconcileCandidateComputerUseTopology =");
    const refreshContinuationStart = startSlice.indexOf("const refreshCandidateCapabilities =");
    const candidateClientStart = startSlice.indexOf("const candidateClient = createDesktopRelaySidecarClient({");
    const reconciliation = startSlice.slice(reconciliationStart, candidateClientStart);
    const refreshContinuation = startSlice.slice(
      refreshContinuationStart,
      reconciliationStart,
    );
    const activatedPublisher = startSlice.indexOf("capabilityPublisher = candidatePublisher;");
    const pendingDrain = startSlice.indexOf("if (pendingComputerUseTopologyReconciliation)", activatedPublisher);

    expect(candidateCatch).toContain("sessionClient = null;");
    expect(candidateCatch).toContain("const retired = candidateSession.retire();");
    expect(candidateCatch).toContain("await retired.client?.disconnect();");
    expect(candidateCatch).toContain("await retired.mcpHost?.stop();");
    expect(candidateCatch.indexOf("sessionClient = null")).toBeLessThan(
      candidateCatch.indexOf("candidateSession.retire()"),
    );
    expect(candidateCatch.indexOf("await retired.client?.disconnect()")).toBeLessThan(
      candidateCatch.indexOf("await retired.mcpHost?.stop()"),
    );
    expect(reconciliation).toMatch(
      /candidatePublisher === null\s*\|\|\s*capabilityPublisher !== candidatePublisher/,
    );
    expect(refreshContinuation).toContain(
      "const refreshCandidateCapabilities = (reason?: string): Promise<boolean> => {",
    );
    expect(refreshContinuation).toMatch(
      /candidatePublisher === null\s*\|\|\s*capabilityPublisher !== candidatePublisher/,
    );
    expect(refreshContinuation).toContain("return Promise.resolve(false);");
    expect(refreshContinuation).toContain("return candidatePublisher.refresh(reason);");
    expect(reconciliation).toContain("pendingComputerUseTopologyReconciliation = true");
    expect(reconciliation).toContain("retired or failed candidates cannot reach a replacement");
    expect(activatedPublisher).toBeGreaterThan(candidateClientStart);
    expect(pendingDrain).toBeGreaterThan(activatedPublisher);
    expect(startSlice.slice(activatedPublisher, pendingDrain)).toContain(
      "const requiresComputerUseReconciliation = applyCandidateComputerUseTopology(topology);",
    );
    expect(startSlice.slice(pendingDrain)).toContain(
      "if (requiresComputerUseReconciliation)",
    );
    expect(startSlice.slice(pendingDrain)).toContain(
      "void options.onComputerUseTopologyChange?.(refreshCandidateCapabilities);",
    );
    expect(reconciliation).toContain("if (applyCandidateComputerUseTopology(topology))");
  });
});

describe("local authority-boundary correction — dispatch handler wiring (source wiring)", () => {
  const desktopRoot = join(import.meta.dir, "../..");
  const relay = readFileSync(join(desktopRoot, "electron/relay.ts"), "utf-8");

  test("DispatchHandlerOptions carries a workstationProfileStateProvider field", () => {
    const optsStart = relay.indexOf("export interface DispatchHandlerOptions");
    expect(optsStart).toBeGreaterThan(-1);
    const optsSlice = relay.slice(optsStart, relay.indexOf("const MUTATING_FS_OPS", optsStart));
    expect(optsSlice).toContain("workstationProfileStateProvider?:");
    expect(optsSlice).toContain("RelayWorkstationProfileSnapshotProvider");
  });

  test("makeDispatchHandler gates run_shell before generic sandbox construction under an active profile", () => {
    const fnStart = relay.indexOf("export function makeDispatchHandler");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = relay.slice(fnStart, relay.indexOf("export function makeDispatchHandler", fnStart + 1));
    // The gate reads the active-profile state provider and refuses with a
    // stable code BEFORE the generic sandbox envelope construction.
    const gateIdx = fnSlice.indexOf("WORKSTATION_SHELL_BINDING_REQUIRED");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(fnSlice.indexOf("WORKSTATION_PROFILE_LOOKUP_FAILED", gateIdx)).toBeGreaterThan(gateIdx);
    const policyIdx = fnSlice.indexOf("prepareLocalDispatchPolicy({");
    expect(policyIdx).toBeGreaterThan(-1);
    // The request-local policy evaluates the injected refusal before it
    // augments an envelope or constructs a Sandbox.
    const policy = readFileSync(
      join(desktopRoot, "electron/relay-dispatch/local-dispatch-policy.ts"),
      "utf-8",
    );
    expect(policy.indexOf("const unboundRefusal = await input.checkUnboundRunShell()")).toBeLessThan(
      policy.indexOf("resolveRelayDispatchSandbox({"),
    );
    // The gate is run_shell-specific and only fires when no binding is carried.
    expect(fnSlice).toContain('req.toolName !== "run_shell"');
    expect(fnSlice).toContain("req.workstationShellBinding !== undefined");
    expect(fnSlice).toContain("options.workstationProfileStateProvider === undefined");
  });

  test("startRelay threads the shared controller into makeDispatchHandler as the state provider", () => {
    const startFn = relay.indexOf("export async function startRelay");
    expect(startFn).toBeGreaterThan(-1);
    const startSlice = relay.slice(startFn, relay.indexOf("export async function stopRelay", startFn));
    expect(startSlice).toContain("workstationProfileStateProvider: workstationProfileProvider");
  });
});

describe("main — shared controller wiring (source wiring)", () => {
  const desktopRoot = join(import.meta.dir, "../..");
  const main = normalizeStaticSource(
    readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
  );

  test("constructs one ActiveWorkstationProfileController bound to the shared authority", () => {
    const ctorStart = main.indexOf("const activeWorkstationProfileController = new ActiveWorkstationProfileController");
    expect(ctorStart).toBeGreaterThan(-1);
    const ctor = main.slice(ctorStart, ctorStart + 600);
    expect(ctor).toContain("ActiveWorkstationProfileController");
    expect(ctor).toContain("instanceId: desktopInstance.instanceId");
    // Shares the SAME authority the grant IPC handlers and relay read.
    expect(ctor).toContain("authority: desktopFilesystemGrantStore");
    // Owns the instance-scoped profiles file path.
    expect(ctor).toContain("filePath: workstationProfilesFilePath()");
  });

  test("activation / deactivation re-advertises atomically via refreshDesktopRelayCapabilities", () => {
    const ctorStart = main.indexOf("const activeWorkstationProfileController = new ActiveWorkstationProfileController");
    const ctor = main.slice(ctorStart, ctorStart + 800);
    expect(ctor).toContain("onActiveProfileChanged:");
    expect(ctor).toContain("reAdvertiseDesktopFilesystemGrantSnapshot(reason)");
    // The re-advertise helper must route through the atomic capability update,
    // not a stop/start reconnect.
    const helperStart = main.indexOf("function reAdvertiseDesktopFilesystemGrantSnapshot(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = main.slice(helperStart, helperStart + 400);
    expect(helper).toContain("refreshDesktopRelayCapabilities(reason)");
    expect(helper).not.toContain("refreshRelayForCurrentFolder");
  });

  test("topology reconciliation receives and uses the exact session refresh continuation", () => {
    const optionStart = main.indexOf("onComputerUseTopologyChange: (refreshRelayCapabilities) =>");
    const option = main.slice(optionStart, optionStart + 220);
    const reconcileStart = main.indexOf("async function reconcileComputerUseTopology(");
    const reconcileEnd = main.indexOf(
      "const desktopFilesystemGrantDurableStore",
      reconcileStart,
    );
    expect(reconcileEnd).toBeGreaterThan(reconcileStart);
    const reconcile = main.slice(reconcileStart, reconcileEnd);

    expect(optionStart).toBeGreaterThan(-1);
    expect(option).toContain("reconcileComputerUseTopology(refreshRelayCapabilities)");
    expect(reconcile).toContain("refreshRelayCapabilities: (reason?: string) => Promise<boolean>");
    const statusIdx = reconcile.indexOf("await computerUseSetup?.status()");
    const refreshIdx = reconcile.indexOf(
      'await refreshRelayCapabilities("computer use topology reconciliation")',
    );
    expect(statusIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(statusIdx);
    expect(reconcile).not.toContain("refreshComputerUseRelay(");
  });

  test("the activate callback skips its fire-and-forget re-advertise so it cannot race the handler's awaited refresh", () => {
    // The first-enable race begins when `activate()` fires `onActiveProfileChanged`
    // synchronously, which used to fire-and-forget a refresh that raced the
    // handler's explicit awaited `refreshDesktopRelayCapabilities("workstation
    // profile activation complete")`. The callback must now short-circuit for
    // the activate reason (the handler is the sole activate() caller and owns
    // the authoritative awaited advertisement), while deactivation still
    // re-advertises.
    const ctorStart = main.indexOf("const activeWorkstationProfileController = new ActiveWorkstationProfileController");
    const ctor = main.slice(ctorStart, ctorStart + 1600);
    expect(ctor).toContain("onActiveProfileChanged:");
    // The guard keys on the activate reason and returns before re-advertising.
    expect(ctor).toContain('"workstation profile activate"');
    const guardIdx = ctor.indexOf('"workstation profile activate"');
    const reAdvertiseIdx = ctor.indexOf("reAdvertiseDesktopFilesystemGrantSnapshot(reason)", guardIdx);
    expect(reAdvertiseIdx).toBeGreaterThan(-1);
    // A return precedes the re-advertise call so the activate path skips it.
    const returnIdx = ctor.indexOf("return", guardIdx);
    expect(returnIdx).toBeGreaterThan(guardIdx);
    expect(returnIdx).toBeLessThan(reAdvertiseIdx);
    // The handler still performs exactly one explicit awaited completion
    // refresh before phase-two server completion.
    const handlerStart = main.indexOf('ipcMain.handle("workstationProfiles:selectActiveProfile"');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = main.indexOf("ipcMain.handle(", handlerStart + 1);
    const helperStart = main.indexOf("async function activateStoredWorkstationProfile(");
    const handler = `${main.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd)} ${main.slice(helperStart, handlerStart)}`;
    expect(handler).toContain('const advertisement = refreshDesktopRelayCapabilities("workstation profile activation complete")');
    expect(handler).toContain("? await advertisement");
    // The handler must NOT also fire a second re-advertise for the activation
    // (the callback owns that, and it is suppressed above).
    expect(handler).not.toContain('reAdvertiseDesktopFilesystemGrantSnapshot("workstation profile activate")');
  });

  test("startRelay receives the shared controller (no duplicate profile stores)", () => {
    const optsStart = main.indexOf("const relayOpts: StartRelayOptions =");
    expect(optsStart).toBeGreaterThan(-1);
    const optsEnd = main.indexOf("await setActiveRelay(", optsStart);
    expect(optsEnd).toBeGreaterThan(optsStart);
    const opts = main.slice(optsStart, optsEnd);
    expect(opts).toContain("workstationProfileController: activeWorkstationProfileController");
    // The relay also continues to receive the shared grant authority.
    expect(opts).toContain("desktopFilesystemGrantAuthority: desktopFilesystemGrantStore");
  });

  test("imports the controller and the instance-scoped profiles file path", () => {
    expect(main).toContain('import {ActiveWorkstationProfileController} from "./workstation-profiles/active-controller"');
    expect(main).toContain("workstationProfilesFilePath,");
  });
});
