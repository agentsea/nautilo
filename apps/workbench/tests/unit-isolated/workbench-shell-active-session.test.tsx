import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shellSource = readFileSync(
  join(import.meta.dir, "../../src/layouts/workbench-shell.tsx"),
  "utf-8",
);
const authSource = readFileSync(
  join(import.meta.dir, "../../src/hooks/use-auth.ts"),
  "utf-8",
);

describe("WorkbenchShell active desktop session lifecycle", () => {
  test("gates terminal polling while inactive and restores it on activation", () => {
    expect(shellSource).toContain(
      "const [desktopSessionActive, setDesktopSessionActive] = useState(() => !isDesktop)",
    );
    expect(shellSource).toContain(
      "if (!api || !auth.viewer.isVerified || !desktopSessionActive)",
    );
    expect(shellSource).toContain(
      "}, [auth.viewer.isVerified, desktopSessionActive]);",
    );
    expect(shellSource).toContain(
      "const timer = setInterval(",
    );
    expect(shellSource).toContain(
      "return () => clearInterval(timer);",
    );
    expect(shellSource).toContain(
      '<TerminalSurface\n                activeSession={desktopSessionActive}',
    );
  });

  test("gates auth IPC and viewer polling while the renderer is inactive", () => {
    expect(authSource).toContain(
      "if (!desktopSessionActive) return lastTokenRef.current",
    );
    expect(authSource).toContain("enabled: desktopSessionActive");
    expect(authSource).toContain("if (!enabledRef.current) return");
    expect(authSource).toContain("if (!enabled) return");
  });

  test("reveals Terminal when launched from a full-width management page", () => {
    expect(shellSource).toContain(
      'if (fullWidthManagementRoute) void navigate("/");',
    );
    expect(shellSource).toContain(
      "[auth.viewer.isVerified, fullWidthManagementRoute, navigate, panelSizes, requestWorkSurfaceTransition, setWorkSurface]",
    );
  });

  test("routes mini-app replacement and retry through the awaited lifecycle guard", () => {
    expect(shellSource).toContain("if (guard && !(await guard(next.kind === \"none\" ? \"close\" : \"replace\")))");
    expect(shellSource).toContain("pendingWorkSurfaceTransitionRef.current = update");
    expect(shellSource).toContain('const ready = await guard("navigate")');
    expect(shellSource).toContain("const routeBlocker = useBlocker");
    expect(shellSource).toContain("shellMountedRef.current = true");
    expect(shellSource).toContain("transition.proceed()");
    expect(shellSource).toContain("pendingRoute?.reset()");
    expect(shellSource).toContain("onRegisterTransitionGuard={registerMiniAppTransitionGuard}");
    expect(shellSource).toContain("onLifecycleRetryReady={retryMiniAppTransition}");
    expect(shellSource).toContain("onLifecycleCancel={cancelMiniAppTransition}");
    expect(shellSource).toContain("registerBeforeLeave={registerMiniAppBeforeLeave}");
    expect(shellSource).toContain("onClose={clearWorkSurface}");
  });

  test("defers the legacy route guard after canonical lifecycle registration", () => {
    expect(shellSource.match(/useBlocker\(/g)).toHaveLength(1);
    expect(shellSource).toContain("const miniAppRouteWaiting = useMiniAppRouteGuard(");
    expect(shellSource).toContain(
      "Boolean(appWorkSurface) && !miniAppGuardRegistered",
    );
    expect(shellSource).toContain(
      "requestWorkSurfaceTransition(clearWorkSurfaceImmediately)",
    );
  });

  test("registers every mounted workbench renderer for native quit preparation", () => {
    expect(shellSource).toContain("desktopAPI?.workbench?.onPrepareQuit");
    expect(shellSource).toContain("cancellation.onCancelled(releasePreparedUi)");
    expect(shellSource).toContain("cancellation.isCancelled()");
    expect(shellSource).toContain('const ready = await guard("quit")');
    expect(shellSource).toContain("if (!guard) {");
    expect(shellSource).toContain("setNativeQuitInteractionLock(true)");
    expect(shellSource).toContain("ready: false");
    expect(shellSource).toContain("if (ready) setNativeQuitInteractionLock(true)");
    expect(shellSource).toContain('shellRootRef.current?.setAttribute("inert", "")');
    expect(shellSource).toContain("Open work preserved. Quitting Nautilo…");
  });
});
