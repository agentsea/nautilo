import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import {
  Sandbox,
  canonicalize,
  type SandboxBackend,
  type SandboxConfig,
} from "@nautilo/sandbox";

import { makeDispatchHandler } from "../../src/index";

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

function makeTestSandbox(workspace: string, onClose: () => void): Sandbox {
  const config: SandboxConfig = {
    mode: "disabled",
    writablePaths: [],
    projectPaths: [],
    passthroughEnv: [],
  };
  const backend: SandboxBackend = { kind: "none" };
  return new Sandbox({
    config,
    workspace,
    dataDir: `${workspace}/data`,
    toolsBin: `${workspace}/tools`,
    backend,
    networkProxy: {
      url: "http://127.0.0.1:49152",
      port: 49152,
      close: () => {
        onClose();
        return Promise.resolve();
      },
    },
  });
}

function mkRequest(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    id: "relay-close-test",
    toolName: "run_shell",
    args: { command: "/bin/echo closed" },
    impact: "low",
    approvalObtained: false,
    sandboxProfile: {
      workspace: "/tmp",
      dataDir: "/tmp/data",
      toolsBin: "/tmp/tools",
      mode: "desktop-permissive",
      securityLevel: "standard",
      failIfNoBackend: false,
      config: {
        mode: "disabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
    },
    ...overrides,
  } as RelayDispatchRequest;
}

describe("headless relay sandbox lifecycle", () => {
  test("production refuses a missing envelope before the factory is called", async () => {
    const workspace = mkTmp("relay-bin-production-refusal-");
    try {
      let factoryCalls = 0;
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
        isProduction: true,
        createSandbox: async () => {
          factoryCalls += 1;
          return makeTestSandbox(workspace, () => undefined);
        },
      });
      const { sandboxProfile, ...requestWithoutEnvelope } = mkRequest();
      void sandboxProfile;

      const result = await handler(requestWithoutEnvelope as RelayDispatchRequest);

      expect(result).toMatchObject({ status: "error" });
      expect(result.status === "error" && result.error).toContain("security configuration");
      expect(result.status === "error" && result.error).not.toMatch(/D060|G5\.4|ship plan|sandboxProfile/);
      expect(factoryCalls).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("development fallback preserves the headless warning and single sandboxed result path", async () => {
    const workspace = mkTmp("relay-bin-development-fallback-");
    const originalError = console.error;
    const warnings: string[] = [];
    console.error = (message: unknown) => warnings.push(String(message));
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
        isProduction: false,
      });
      const { sandboxProfile, ...requestWithoutEnvelope } = mkRequest({
        args: { command: "/bin/echo development-fallback" },
      });
      void sandboxProfile;

      const result = await handler(requestWithoutEnvelope as RelayDispatchRequest);

      expect(result).toMatchObject({ status: "ok" });
      expect(result.status === "ok" && (result.result as { stdout: string }).stdout).toBe(
        "development-fallback",
      );
      expect(warnings).toContain(
        "[WARN] [relay] Dispatch received without sandboxProfile (run_shell). " +
          "Development-build dev loop — release builds will refuse this path.",
      );
    } finally {
      console.error = originalError;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("closes per-request sandbox after run_shell dispatch", async () => {
    const workspace = mkTmp("relay-bin-close-shell-");
    const guard = createWorkspaceGuard({ workspaceRoot: workspace });
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: () =>
        Promise.resolve(makeTestSandbox(workspace, () => {
          closeCalls += 1;
        })),
    });

    const result = await handler(mkRequest());

    expect(result.status).toBe("ok");
    expect(closeCalls).toBe(1);
  }, 15_000);

  test("run_shell cwd follows sandboxProfile.workspace over registered guard root", async () => {
    const registeredRoot = mkTmp("relay-bin-registered-");
    const currentFolder = mkTmp("relay-bin-current-");
    const guard = createWorkspaceGuard({ workspaceRoot: registeredRoot });
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: () =>
        Promise.resolve(makeTestSandbox(currentFolder, () => {
          closeCalls += 1;
        })),
    });

    const result = await handler(
      mkRequest({
        allowedRoots: [currentFolder],
        sandboxProfile: {
          workspace: currentFolder,
          dataDir: `${currentFolder}/data`,
          toolsBin: `${currentFolder}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: {
            mode: "disabled",
            writablePaths: [],
            projectPaths: [],
            passthroughEnv: [],
          },
        },
        args: { command: "/bin/pwd" },
      }),
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect((result.result as { stdout: string }).stdout).toBe(currentFolder);
    }
    expect(closeCalls).toBe(1);
  });

  test("run_shell explains when the Current Folder is no longer usable", async () => {
    const registeredRoot = mkTmp("relay-bin-registered-");
    const deletedCurrentFolder = mkTmp("relay-bin-deleted-current-");
    const guard = createWorkspaceGuard({ workspaceRoot: registeredRoot });
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: () =>
        Promise.resolve(makeTestSandbox(deletedCurrentFolder, () => {
          closeCalls += 1;
        })),
    });
    rmSync(deletedCurrentFolder, { recursive: true, force: true });

    const result = await handler(
      mkRequest({
        sandboxProfile: {
          workspace: deletedCurrentFolder,
          dataDir: `${deletedCurrentFolder}/data`,
          toolsBin: `${deletedCurrentFolder}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: {
            mode: "disabled",
            writablePaths: [],
            projectPaths: [],
            passthroughEnv: [],
          },
        },
      }),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Current Folder is unusable");
      expect(result.error).toContain("normal user directory");
    }
    expect(closeCalls).toBe(1);
  });

  test("run_shell maps sandbox getcwd failures to Current Folder guidance", async () => {
    const currentFolder = mkTmp("relay-bin-sandbox-cwd-");
    const guard = createWorkspaceGuard({ workspaceRoot: currentFolder });
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: () =>
        Promise.resolve(makeTestSandbox(currentFolder, () => {
          closeCalls += 1;
        })),
    });

    const result = await handler(
      mkRequest({
        args: {
          command:
            "printf 'shell-init: error retrieving current directory: getcwd: Operation not permitted\\n' >&2; exit 1",
        },
      }),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Current Folder is unusable");
      expect(result.error).toContain("normal user directory");
      expect(result.error).not.toContain("run_shell exit");
    }
    expect(closeCalls).toBe(1);
  });

  test("run_shell redacts known secrets from successful stdout and stderr", async () => {
    const workspace = mkTmp("relay-bin-redaction-ok-");
    const secret = "headless_success_secret_123456";
    const previous = process.env["NAUTILO_HEADLESS_TEST_TOKEN"];
    process.env["NAUTILO_HEADLESS_TEST_TOKEN"] = secret;
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: workspace }),
        { isProduction: false },
      );
      const result = await handler(
        mkRequest({
          sandboxProfile: undefined,
          args: {
            command: `printf '${secret}'; printf 'token=${secret}' >&2`,
          },
        }),
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const output = result.result as { stdout: string; stderr: string };
        expect(output.stdout).toContain("[REDACTED]");
        expect(output.stderr).toContain("[REDACTED]");
        expect(JSON.stringify(output)).not.toContain(secret);
      }
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_HEADLESS_TEST_TOKEN"];
      else process.env["NAUTILO_HEADLESS_TEST_TOKEN"] = previous;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("run_shell redacts stderr embedded in nonzero-exit errors", async () => {
    const workspace = mkTmp("relay-bin-redaction-error-");
    const secret = "headless_error_secret_123456";
    const previous = process.env["NAUTILO_HEADLESS_TEST_PASSWORD"];
    process.env["NAUTILO_HEADLESS_TEST_PASSWORD"] = secret;
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: workspace }),
        { isProduction: false },
      );
      const result = await handler(
        mkRequest({
          sandboxProfile: undefined,
          args: { command: `printf '${secret}' >&2; exit 3` },
        }),
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toContain("[REDACTED]");
        expect(result.error).not.toContain(secret);
      }
    } finally {
      if (previous === undefined)
        delete process.env["NAUTILO_HEADLESS_TEST_PASSWORD"];
      else process.env["NAUTILO_HEADLESS_TEST_PASSWORD"] = previous;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("run_shell clamps too-small timeouts instead of admitting an immediate kill", async () => {
    const workspace = mkTmp("relay-bin-timeout-floor-");
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: workspace }),
        { isProduction: false },
      );
      const result = await handler(
        mkRequest({
          sandboxProfile: undefined,
          timeout: 0,
          args: { command: "sleep 0.05; printf admitted" },
        }),
      );

      expect(result).toMatchObject({
        status: "ok",
        result: { stdout: "admitted" },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("run_shell forwards Relay cancellation to sandbox process supervision", async () => {
    const workspace = mkTmp("relay-bin-cancel-");
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: workspace }),
        { isProduction: false },
      );
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = handler(
        mkRequest({
          sandboxProfile: undefined,
          args: { command: "sleep 10" },
        }),
        controller.signal,
      );
      setTimeout(() => controller.abort(), 25);
      const result = await pending;

      expect(result.status).toBe("error");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("closes per-request sandbox after unknown legacy tool name (relay error)", async () => {
    const workspace = mkTmp("relay-bin-close-list-");
    const guard = createWorkspaceGuard({ workspaceRoot: workspace });
    let closeCalls = 0;
    const handler = makeDispatchHandler(guard, {
      createSandbox: () =>
        Promise.resolve(makeTestSandbox(workspace, () => {
          closeCalls += 1;
        })),
    });

    const result = await handler(
      mkRequest({
        toolName: "list_directory",
        args: { path: workspace },
      }),
    );

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toContain("Unknown tool");
    expect(closeCalls).toBe(1);
  });
});
