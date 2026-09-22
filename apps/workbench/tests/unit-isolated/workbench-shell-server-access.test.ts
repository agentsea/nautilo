import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shellSource = readFileSync(
  join(import.meta.dir, "../../src/layouts/workbench-shell.tsx"),
  "utf-8",
);

// The rendered rail/panel suites exercise the native bridge and user actions.
// These shell wiring checks cover the parent gates that those component tests
// cannot see, without mocking the shell's unrelated room and editor runtimes.
describe("WorkbenchShell desktop server access", () => {
  test("uses desktop bridge support independently of current-server permissions", () => {
    expect(shellSource).toMatch(
      /const canSelectDesktopServer = isDesktop && canSwitchDesktopServerInProcess\(\);/,
    );
    expect(shellSource).toMatch(/\{canSelectDesktopServer\s*\?\s*\(\s*<ServersRail/);
  });

  test("renders the selected Servers panel for a restricted desktop user", () => {
    expect(shellSource).toMatch(
      /\{showBrowserColumn && browserMode === "servers" && canSelectDesktopServer && \(\s*<ServersPanel/,
    );
  });

  test("restores server mode only on a desktop with the switching bridge", () => {
    expect(shellSource).toContain('(stored === "servers" && canSelectDesktopServer)');
    expect(shellSource).toContain("[browserModeViewerKey, canSelectDesktopServer]");
  });

  test("does not reset server mode when invocation or artifact permissions are lost", () => {
    const resetEffect = shellSource.match(
      /useEffect\(\(\) => \{\s*const modeRequiresInvocation[\s\S]*?\}, \[browserMode, canInvokeAgents, canWriteArtifacts\]\);/,
    )?.[0];
    expect(resetEffect).toBeDefined();
    expect(resetEffect).not.toContain('"servers"');
    expect(resetEffect).toContain('setBrowserMode("artifacts")');
  });

  test("preserves agent and artifact restrictions for Web and Apps", () => {
    expect(shellSource).toMatch(/\{canInvokeAgents\s*\?\s*\(\s*<WebRail/);
    expect(shellSource).toMatch(/\{canInvokeAgents && canWriteArtifacts\s*\?\s*\(\s*<AppsRail/);
    expect(shellSource).toMatch(
      /browserMode === "web" && canInvokeAgents && \(\s*<KnownWebAppsPanel/,
    );
    expect(shellSource).toMatch(
      /browserMode === "apps" && canInvokeAgents && canWriteArtifacts && \(\s*<AppsPanel/,
    );
    expect(shellSource).toContain('const modeRequiresInvocation = browserMode === "web";');
    expect(shellSource).toContain('const modeRequiresInvocationAndWrite = browserMode === "apps";');
    expect(shellSource).toContain("(modeRequiresInvocation && !canInvokeAgents)");
    expect(shellSource).toMatch(
      /modeRequiresInvocationAndWrite &&\s*\(!canInvokeAgents \|\| !canWriteArtifacts\)/,
    );
  });
});
