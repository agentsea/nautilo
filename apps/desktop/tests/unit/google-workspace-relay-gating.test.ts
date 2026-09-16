/**
 * M196 — static assertions for relay Google Workspace gating (no Electron boot).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import {
  createGoogleWorkspaceDispatchHandler,
  type GoogleWorkspaceDispatchPorts,
} from "../../electron/relay-dispatch/google-workspace.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";
import { normalizeStaticSource } from "./static-source";

const desktopRoot = join(import.meta.dir, "../..");
const providerRuntimePath = join(desktopRoot, "electron/relay-provider-runtime.ts");
const guard = createWorkspaceGuard({ workspaceRoot: "/tmp" });

function request(
  args: Record<string, unknown>,
  toolName = "google_workspace",
): RelayDispatchRequest {
  return {
    correlationId: "google-workspace-adapter",
    toolName,
    args,
    impact: "read-only",
    approvalObtained: true,
    executionClass: "google_workspace",
  };
}

function ports(
  overrides: Partial<GoogleWorkspaceDispatchPorts> = {},
): GoogleWorkspaceDispatchPorts {
  return {
    resolveBinary: () => "/managed/gog",
    prepareKeyring: async () => {},
    authHealthy: async () => true,
    ensureOAuthClient: async () => null,
    execFile: async () => ({ stdout: "result\n", stderr: "" }),
    timeoutMs: 45_000,
    installHint: () => "install managed gog",
    ...overrides,
  };
}

async function dispatch(
  dispatchPorts: GoogleWorkspaceDispatchPorts,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return await createGoogleWorkspaceDispatchHandler(dispatchPorts)({
    request: request(args),
    signal,
    guard,
  });
}

describe("relay google workspace gating (M196)", () => {
  test("Electron main injects the relay-owned gog ports without an auth-to-relay back-edge", () => {
    const auth = readFileSync(
      join(desktopRoot, "electron/google-workspace-auth.ts"),
      "utf8",
    );
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
    expect(auth).not.toContain('from "./relay"');
    expect(auth).toContain("export function createGoogleWorkspaceAuth(");
    expect(main).toContain("} = createGoogleWorkspaceAuth({ resolveGogBin, isGogAuthHealthy });");
    expect(main).toContain("googleWorkspaceAuthStatus({");
    expect(main).toContain("googleWorkspaceConnect({");
    expect(main).toContain("googleWorkspaceDisconnect({");
  });

  test("googleWorkspaceRuntimeCapabilities uses the shared local-auth capability decision", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    const fnStart = runtime.indexOf("async function googleWorkspaceRuntimeCapabilities");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = runtime.slice(fnStart, runtime.indexOf("async function probeToolRuntime", fnStart));
    expect(fnBody).toContain("queryGoogleOAuthConfigured");
    expect(fnBody).toContain("probeGogAuthHealth(resolved.bin, context, isClosed)");
    expect(fnBody).toContain("canAdvertiseGoogleWorkspaceCapability");
    expect(fnBody).toContain("localGogAuthHealthy: localAuthHealthy");
  });

  test("gog auth probing prepares the keyring environment before checking health", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    const fnStart = runtime.indexOf("async function probeGogAuthHealth");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = runtime.slice(fnStart, runtime.indexOf("function toolRuntimeMetadata", fnStart));
    expect(fnBody.indexOf("applyGogKeyringPasswordEnv(context, isClosed)")).toBeLessThan(
      fnBody.indexOf("isGogAuthHealthy(bin)"),
    );
    expect(fnBody).toContain("ensureGogKeyringBackend(bin, execFileAsync)");
    expect(fnBody).toContain("if (isClosed()) return false;");
  });

  test("gog health checks require a valid account from the JSON result", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    const fnStart = runtime.indexOf("async function isGogAuthHealthy");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = runtime.slice(fnStart, runtime.indexOf("async function probeGogAuthHealth", fnStart));
    expect(fnBody).toContain("const { stdout } = await execFileAsync");
    expect(fnBody).toContain("hasHealthyGogAuthAccount(stdout)");
  });

  test("Google Workspace adapter parses before runtime work and declines nonmatches", async () => {
    let runtimeCalls = 0;
    const handler = createGoogleWorkspaceDispatchHandler(ports({
      resolveBinary: () => {
        runtimeCalls += 1;
        return "/managed/gog";
      },
    }));
    expect(await handler({
      request: request({}, "browser_snapshot"),
      signal: undefined,
      guard,
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
    expect(await handler({
      request: request({ command: "docs.cat" }),
      signal: undefined,
      guard,
    })).toEqual({
      handled: true,
      result: {
        status: "error",
        error: "google_workspace docs.cat requires a non-empty string `docId`",
      },
    });
    expect(runtimeCalls).toBe(0);
  });

  test("healthy local auth skips OAuth provisioning and executes exact argv without a signal", async () => {
    const calls: string[] = [];
    const executions: unknown[] = [];
    let oauthCalls = 0;
    const signal = new AbortController().signal;
    expect(await dispatch(ports({
      resolveBinary: () => {
        calls.push("resolve");
        return "/managed/gog";
      },
      prepareKeyring: async (binary) => {
        calls.push(`keyring:${binary}`);
      },
      authHealthy: async (binary) => {
        calls.push(`auth:${binary}`);
        return true;
      },
      ensureOAuthClient: async () => {
        oauthCalls += 1;
        return null;
      },
      execFile: async (binary, argv, options) => {
        calls.push("exec");
        executions.push({ binary, argv, options });
        return { stdout: "  workspace result  \n" };
      },
    }), { command: "docs.cat", docId: "doc-1" }, signal)).toEqual({
      handled: true,
      result: { status: "ok", result: "workspace result" },
    });
    expect(calls).toEqual([
      "resolve",
      "keyring:/managed/gog",
      "auth:/managed/gog",
      "exec",
    ]);
    expect(oauthCalls).toBe(0);
    expect(executions).toEqual([{
      binary: "/managed/gog",
      argv: [
        "--readonly",
        "--account", "auto",
        "--json",
        "--no-input",
        "--wrap-untrusted",
        "docs", "cat", "doc-1",
      ],
      options: { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
    }]);
  });

  test("unhealthy auth provisions OAuth once, rechecks, and fails closed if still unhealthy", async () => {
    let authCalls = 0;
    let oauthCalls = 0;
    let execCalls = 0;
    expect(await dispatch(ports({
      authHealthy: async () => {
        authCalls += 1;
        return false;
      },
      ensureOAuthClient: async () => {
        oauthCalls += 1;
        return null;
      },
      execFile: async () => {
        execCalls += 1;
        return { stdout: "unreachable" };
      },
    }), { command: "calendar.eventsToday" })).toMatchObject({
      handled: true,
      result: { status: "error", errorCode: "google_auth_required" },
    });
    expect(authCalls).toBe(2);
    expect(oauthCalls).toBe(1);
    expect(execCalls).toBe(0);
  });

  test("unhealthy auth executes only after a successful provisioned recheck", async () => {
    let authCalls = 0;
    let oauthCalls = 0;
    expect(await dispatch(ports({
      authHealthy: async () => {
        authCalls += 1;
        return authCalls === 2;
      },
      ensureOAuthClient: async () => {
        oauthCalls += 1;
        return null;
      },
    }), { command: "calendar.eventsToday" })).toEqual({
      handled: true,
      result: { status: "ok", result: "result" },
    });
    expect(authCalls).toBe(2);
    expect(oauthCalls).toBe(1);
  });

  test("Google Workspace adapter preserves runtime error mappings", async () => {
    const args = { command: "calendar.eventsToday" };
    const executeError = async (error: Error) =>
      await dispatch(ports({
        execFile: async () => {
          throw error;
        },
      }), args);

    expect(await executeError(Object.assign(new Error("missing"), {
      code: "ENOENT",
    }))).toEqual({
      handled: true,
      result: {
        status: "error",
        error: "gog is not available. install managed gog",
      },
    });
    expect(await executeError(Object.assign(new Error("timeout"), {
      killed: true,
    }))).toEqual({
      handled: true,
      result: {
        status: "error",
        error: "google_workspace timed out after 45000ms",
      },
    });
    expect(await executeError(Object.assign(new Error("ignored"), {
      stdout: "stdout detail",
      stderr: "stderr detail",
    }))).toEqual({
      handled: true,
      result: { status: "error", error: "stderr detail" },
    });
    expect(await executeError(Object.assign(new Error("ignored"), {
      stderr: "OAuth token expired",
    }))).toEqual({
      handled: true,
      result: {
        status: "error",
        errorCode: "google_auth_required",
        error: "OAuth token expired",
      },
    });
  });

  test("startRelay gives its candidate session the exact server and signed-in OAuth tuple", () => {
    const relay = readFileSync(join(desktopRoot, "electron/relay.ts"), "utf8");
    const callStart = relay.indexOf("const candidateSession = new DesktopRelaySession({");
    const callBody = relay.slice(callStart, relay.indexOf("  });", callStart));
    expect(callBody).toContain("serverUrl: options.serverUrl");
    expect(callBody).toContain("{ token: options.googleOAuthStatusToken }");
    expect(callBody).toContain("{ clientPath: options.googleOAuthClientPath }");
    expect(callBody).not.toContain("token: options.token");
    expect(relay).not.toContain("relayGoogleOAuthContext");
  });

  test("preload exposes googleWorkspace auth IPC channels", () => {
    const preload = normalizeStaticSource(
      readFileSync(join(desktopRoot, "electron/preload.ts"), "utf8"),
    );
    expect(preload).toContain('ipcRenderer.invoke("googleWorkspace:authStatus")');
    expect(preload).toContain('ipcRenderer.invoke("googleWorkspace:connect"');
    expect(preload).toContain('ipcRenderer.invoke("googleWorkspace:disconnect"');
  });
});
