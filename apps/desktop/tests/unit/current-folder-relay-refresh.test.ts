/**
 * Static checks for Current Folder -> relay root refresh wiring.
 *
 * `electron/main.ts` cannot be imported directly under bun:test without an
 * Electron runtime, so this pins the lifecycle wiring at source level.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");

function functionSlice(source: string, startSignature: string, endSignature: string): string {
  const start = source.indexOf(startSignature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endSignature, start + startSignature.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Current Folder relay root refresh wiring", () => {
  const main = normalizeStaticSource(
    readFileSync(join(desktopRoot, "electron/main.ts"), "utf-8"),
  );

  test("interactive commits persist before changing local authority, then refresh relay unless explicitly deferred", () => {
    const fnSlice = functionSlice(
      main,
      "function commitCurrentFolderPath(p: string, options: {refreshRelay?: boolean} = {}): void",
      "function showWorkingFolderCommitError()",
    );

    const usabilityIdx = fnSlice.indexOf("assertUsableWorkingFolderPath(p)");
    const persistIdx = fnSlice.indexOf("persistCurrentFolderPath(p)");
    const stateIdx = fnSlice.indexOf("currentFolderPath = p");
    const eventIdx = fnSlice.indexOf(
      'sendToActiveRenderer("currentFolder:pathChanged", p)',
    );
    const refreshIdx = fnSlice.indexOf('refreshRelayForCurrentFolder("current-folder commit")');
    const refreshGuardIdx = fnSlice.indexOf("if (options.refreshRelay !== false)");

    expect(usabilityIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(usabilityIdx);
    expect(stateIdx).toBeGreaterThan(persistIdx);
    expect(eventIdx).toBeGreaterThan(stateIdx);
    expect(refreshGuardIdx).toBeGreaterThan(eventIdx);
    expect(refreshIdx).toBeGreaterThan(refreshGuardIdx);
  });

  test("boot establishes a persisted Working Folder before workspace, renderer, or mutation-runtime consumers", () => {
    const boot = functionSlice(
      main,
      "async function boot(): Promise<void>",
      "function resumeQuitAfterPersistence()",
    );

    const resolveIdx = boot.indexOf("resolveWorkingFolderBootstrap(");
    const assignIdx = boot.indexOf("currentFolderPath = workingFolder.path");
    const runtimeIdx = boot.indexOf("void getDesktopDocumentMutationRuntime()");
    const workspaceIdx = boot.indexOf("genieWorkspaceRoot = ensureDefaultGenieWorkspace()");
    const relayIdx = boot.indexOf("finishReleasedDesktopBoot(serverUrl)");

    expect(resolveIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(resolveIdx);
    expect(runtimeIdx).toBeGreaterThan(assignIdx);
    expect(workspaceIdx).toBeGreaterThan(runtimeIdx);
    expect(relayIdx).toBeGreaterThan(workspaceIdx);
  });

  test("bootstrap never refreshes relay merely for its initial folder selection", () => {
    const boot = functionSlice(
      main,
      "async function boot(): Promise<void>",
      "function resumeQuitAfterPersistence()",
    );
    const bootstrapStart = boot.indexOf("resolveWorkingFolderBootstrap(");
    const workspaceIdx = boot.indexOf("genieWorkspaceRoot = ensureDefaultGenieWorkspace()");

    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(bootstrapStart);
    expect(boot.slice(bootstrapStart, workspaceIdx)).not.toContain(
      "refreshRelayForCurrentFolder",
    );
  });

  test("refresh helper serializes stop and boot through existing relay lifecycle", () => {
    const fnSlice = functionSlice(
      main,
      "async function refreshRelayForCurrentFolder",
      "function refreshAuthMenuState",
    );

    expect(fnSlice).toContain("if (relayRootRefreshPromise) {");
    expect(fnSlice).toContain("relayRootRefreshQueued = true");
    expect(fnSlice).toContain("return relayRootRefreshPromise");
    expect(fnSlice).toContain('status === "connected" || status === "connecting"');
    expect(fnSlice).toContain("await stopRelay()");
    expect(fnSlice).toContain("await bootRelayIfPossible(serverUrl)");
    expect(fnSlice).toContain("relayRootRefreshPromise = null");
    expect(fnSlice).toContain('refreshRelayForCurrentFolder("queued current-folder commit")');
  });

  test("relay keeps Genie Workspace as its baseline and never turns it into Current Folder", () => {
    const fnSlice = functionSlice(
      main,
      "async function startRelayForSession",
      "async function refreshRelayForCurrentFolder",
    );

    expect(fnSlice).toContain("workspacePath: genieWorkspaceRoot");
    expect(fnSlice).toContain(
      "currentFolderPathProvider: () => currentFolderPath ?? undefined",
    );
    expect(fnSlice).not.toContain("workspacePath: currentFolderPath ?? undefined");
    expect(fnSlice).not.toContain(
      "currentFolderPath ?? genieWorkspaceRoot ?? undefined",
    );
    expect(fnSlice).not.toContain("workspacePathProvider");
  });

  test("Electron relay has no hidden .nautilo/home/workspace execution fallback", () => {
    const relay = readFileSync(join(desktopRoot, "electron/relay.ts"), "utf-8");
    expect(relay).not.toContain(".nautilo/home/workspace");
    expect(relay).not.toContain("resolveDefaultWorkspace");
  });
});
