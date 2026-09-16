/**
 * D418 — IPC wiring checks without loading Electron main. Electron is mocked
 * by inspecting the registered handler source rather than importing main.ts,
 * whose top-level boot path requires an Electron runtime.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");
const mainSource = readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8");
const main = normalizeStaticSource(mainSource);
const preload = normalizeStaticSource(
  readFileSync(join(desktopRoot, "electron/preload.ts"), "utf-8"),
);
const desktopTypes = readFileSync(join(desktopRoot, "../workbench/src/lib/desktop.ts"), "utf-8");

function handlerSlice(channel: string): string {
  const start = main.indexOf(`ipcMain.handle("desktopFilesystemGrants:${channel}"`);
  expect(start).toBeGreaterThan(-1);
  const next = main.indexOf("ipcMain.handle(", start + 1);
  return main.slice(start, next === -1 ? undefined : next);
}

describe("Desktop Filesystem Grant IPC", () => {
  test("all five handlers sender-gate before privileged work", () => {
    for (const channel of ["pick", "validate", "create", "list", "revoke"]) {
      const slice = handlerSlice(channel);
      const senderGate = slice.indexOf("assertMainWindowSender(e)");
      expect(senderGate).toBeGreaterThan(-1);
      expect(senderGate).toBeLessThan(slice.indexOf(`desktopFilesystemGrants:${channel}`) + 160);
    }
  });

  test("pick is only a candidate and validate captures identity", () => {
    const pick = handlerSlice("pick");
    const validate = handlerSlice("validate");
    expect(pick).toContain("return pickFolder()");
    expect(pick).not.toContain("desktopFilesystemGrantStore.create");
    expect(validate).toContain("captureDesktopFilesystemGrantRootIdentity(args.path)");
    expect(validate).not.toContain("desktopFilesystemGrantStore.create");
  });

  test("create accepts only validated filesystem facts and constructs security fields locally", () => {
    const create = handlerSlice("create");
    expect(create).toContain("parseDesktopFilesystemGrantCreateRequest(args?.request)");
    expect(create).toContain("revalidateDesktopFilesystemGrantRootIdentity(request.filesystemIdentity)");
    expect(create).toContain("getPersistedDesktopRelayId()");
    expect(create).toContain("DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE");
    expect(create).toContain("id: randomUUID()");
    expect(create).toContain("origin: \"user_picker\"");
    expect(create).toContain("createdBy: userId");
    expect(create).toContain("createdAt: new Date().toISOString()");
    expect(create).toContain("policyVersion: 1");
    expect(create).toContain("instanceId: desktopInstance.instanceId");
    expect(create).not.toContain("args?.grant");
    expect(create).not.toContain("request.subject");
    expect(create).not.toContain("request.id");
    expect(create).not.toContain("request.policyVersion");
    expect(create).not.toContain("request.origin");
  });

  test("create request parser rejects renderer-supplied privileged fields", () => {
    const createParserStart = main.indexOf("function parseDesktopFilesystemGrantCreateRequest(");
    expect(createParserStart).toBeGreaterThan(-1);
    const createParser = main.slice(createParserStart, main.indexOf('ipcMain.handle("desktopFilesystemGrants:pick"', createParserStart));
    expect(createParser).toContain('new Set(["canonicalRoot", "filesystemIdentity", "access", "lifetime"])');
    expect(createParser).toContain("Object.keys(request).some");
    expect(createParser).toContain("new Set([\"realRoot\", \"device\", \"inode\"])");
  });

  test("list and revoke remain scoped to the resolved caller user", () => {
    expect(handlerSlice("list")).toContain("desktopFilesystemGrantStore.list({userId,");
    expect(handlerSlice("revoke")).toContain("desktopFilesystemGrantStore.revoke({userId, grantId:");
  });

  test("create and revoke re-advertise the advisory snapshot only after a successful local mutation", () => {
    const create = handlerSlice("create");
    expect(create).toContain("if (!created.ok) return grantStoreFailure(created.code);");
    expect(create).toContain('reAdvertiseDesktopFilesystemGrantSnapshot("Desktop Filesystem Grant create")');
    // The re-advertise must follow the successful store write, never precede it.
    expect(create.indexOf("desktopFilesystemGrantStore.create")).toBeLessThan(
      create.indexOf("reAdvertiseDesktopFilesystemGrantSnapshot"),
    );

    const revoke = handlerSlice("revoke");
    expect(revoke).toContain("if (!revoked.ok) return grantStoreFailure(revoked.code);");
    expect(revoke).toContain('reAdvertiseDesktopFilesystemGrantSnapshot("Desktop Filesystem Grant revoke")');

    // The bridge rebuilds the snapshot from local state via the atomic
    // capability-update path — it must never push renderer data into the
    // server snapshot. Re-advertisement now goes through
    // refreshDesktopRelayCapabilities (D418 protocol v7) instead of a
    // stop/start reconnect.
    const helperStart = main.indexOf("function reAdvertiseDesktopFilesystemGrantSnapshot(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = main.slice(helperStart, helperStart + 500);
    expect(helper).toContain("refreshDesktopRelayCapabilities(reason)");
    expect(helper).not.toContain("refreshRelayForCurrentFolder(reason)");
  });

  test("preload and workbench expose only the narrow bridge", () => {
    const bridgeStart = preload.indexOf("const desktopFilesystemGrantsAPI = {");
    const bridge = preload.slice(bridgeStart, bridgeStart + 1800);
    expect(bridgeStart).toBeGreaterThan(-1);
    for (const method of ["pick:", "validate:", "create:", "list:", "revoke:"]) {
      expect(bridge).toContain(method);
    }
    expect(bridge).not.toContain("readDir");
    expect(bridge).not.toContain("readFile");
    expect(bridge).toContain('ipcRenderer.invoke("desktopFilesystemGrants:create", {request})');
    expect(bridge).not.toContain("getCurrentSubject");
    expect(bridge).not.toContain("subject:");
    expect(desktopTypes).toContain("export interface DesktopFilesystemGrantsAPI");
    expect(desktopTypes).toContain("export interface DesktopFilesystemGrantCreateRequest");
    expect(desktopTypes).toContain("desktopFilesystemGrants?: DesktopFilesystemGrantsAPI");
  });
});

describe("active Workstation Profile lifecycle wiring (D418)", () => {
  test("sign-out deactivates the active workstation profile", () => {
    const start = main.indexOf("async function handleSignOut()");
    expect(start).toBeGreaterThan(-1);
    // Slice the function body (up to the next top-level closing brace).
    const end = main.indexOf("\n}\n", start + 1);
    const slice = main.slice(start, end === -1 ? undefined : end + 3);
    expect(slice).toContain("activeWorkstationProfileController.deactivate");
  });

  test("app quit (before-quit) deactivates the active workstation profile", () => {
    const sourceFile = ts.createSourceFile(
      "main.ts",
      mainSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let beforeQuitRegistration: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(sourceFile) === "app"
        && node.expression.name.text === "on"
        && node.arguments.length > 0
        && ts.isStringLiteral(node.arguments[0]!)
        && node.arguments[0].text === "before-quit"
      ) {
        beforeQuitRegistration = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(beforeQuitRegistration).toBeDefined();
    const handler = normalizeStaticSource(beforeQuitRegistration?.getText(sourceFile) ?? "");
    expect(handler).toContain("await activeWorkstationProfileController.deactivate()");
  });

  test("server picker stays sender-gated and defers profile teardown to verified promotion", () => {
    const pickerStart = main.indexOf("async function openServerPicker()");
    const pickerEnd = main.indexOf('ipcMain.handle("servers:open-picker"', pickerStart);
    expect(pickerStart).toBeGreaterThan(-1);
    expect(pickerEnd).toBeGreaterThan(pickerStart);
    const picker = main.slice(pickerStart, pickerEnd);
    expect(picker).toContain("await showGuardedServerPicker({");
    expect(picker).toContain('mode: "switch-server"');
    expect(picker).not.toContain("activeWorkstationProfileController.deactivate");
    expect(picker).not.toContain("app.relaunch()");
    expect(picker).not.toContain("app.exit(0)");

    const handler = main.slice(pickerEnd, main.indexOf("/**", pickerEnd));
    expect(handler).toContain("assertMainWindowSender(e)");
    expect(handler).toContain("await openServerPicker()");

    // The shared connection promotion owns the old authority. It performs
    // the profile deactivation only after a candidate passes the guarded
    // picker/connection flow, alongside the old Codex and relay handoff.
    const flowStart = main.indexOf("const desktopConnectionFlow = new DesktopConnectionFlow(");
    const flowEnd = main.indexOf("function coldBootTerminalRuntime()", flowStart);
    expect(flowStart).toBeGreaterThan(-1);
    expect(flowEnd).toBeGreaterThan(flowStart);
    const flow = main.slice(flowStart, flowEnd);
    expect(flow).toContain("stopOldCodex: async () => {await codexConnection.disable();}");
    // D516 revokes the old server-bound Computer Use authority during the
    // already-committed handoff, so a signed-out target cannot retain it.
    const stopOldRelayStart = flow.indexOf("stopOldRelay: async () => {");
    const deactivateOldProfileStart = flow.indexOf("deactivateOldProfile: async () => {");
    expect(stopOldRelayStart).toBeGreaterThan(-1);
    expect(deactivateOldProfileStart).toBeGreaterThan(stopOldRelayStart);
    const oldRelayHandoff = flow.slice(stopOldRelayStart, deactivateOldProfileStart);
    expect(oldRelayHandoff).toContain("await stopRelay();");
    expect(oldRelayHandoff).toContain("await configureComputerUseForServer(null);");
    expect(flow).toContain("deactivateOldProfile: async () => {await activeWorkstationProfileController.deactivate();}");
  });
});
