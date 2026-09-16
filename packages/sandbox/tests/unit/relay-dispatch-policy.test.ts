import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Sandbox,
  canonicalize,
  hasSandboxCwdFailure,
  resolveRelayDispatchSandbox,
  sandboxCurrentFolderError,
  unusableCurrentFolderError,
  type SandboxEnvelopeLike,
} from "../../src";

const envelope: SandboxEnvelopeLike = {
  workspace: "/tmp/relay-policy-workspace",
  dataDir: "/tmp/relay-policy-data",
  toolsBin: "/tmp/relay-policy-tools",
  failIfNoBackend: false,
  config: {
    mode: "disabled",
    writablePaths: [],
    projectPaths: [],
    passthroughEnv: [],
  },
};

function testSandbox(root: string): Sandbox {
  return new Sandbox({
    config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
    workspace: root,
    dataDir: root,
    toolsBin: root,
    backend: { kind: "none" },
  });
}

describe("resolveRelayDispatchSandbox", () => {
  test("returns the exact factory sandbox for a supplied envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-policy-success-"));
    try {
      const sandbox = testSandbox(root);
      const received: SandboxEnvelopeLike[] = [];
      const receivedAuthority: boolean[] = [];
      const result = await resolveRelayDispatchSandbox({
        envelope,
        isProduction: true,
        developmentRoot: root,
        toolName: "run_shell",
        localAuthority: { allowWorkspaceGovernanceWrites: true },
        createSandbox: async (input, localAuthority) => {
          received.push(input);
          receivedAuthority.push(localAuthority?.allowWorkspaceGovernanceWrites === true);
          return sandbox;
        },
      });

      expect(result).toEqual({ ok: true, sandbox });
      expect(received).toEqual([envelope]);
      expect(receivedAuthority).toEqual([true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps a factory rejection to the established dispatch error", async () => {
    const result = await resolveRelayDispatchSandbox({
      envelope,
      isProduction: true,
      developmentRoot: process.cwd(),
      toolName: "run_shell",
      createSandbox: async () => Promise.reject(new Error("backend detection failed")),
    });

    expect(result).toEqual({
      ok: false,
      error: "Failed to construct sandbox from envelope: backend detection failed",
    });
  });

  test("refuses a production dispatch without an envelope without factory or warning", async () => {
    let factoryCalls = 0;
    const warnings: string[] = [];
    const result = await resolveRelayDispatchSandbox({
      envelope: undefined,
      isProduction: true,
      developmentRoot: process.cwd(),
      toolName: "run_shell",
      createSandbox: async () => {
        factoryCalls += 1;
        return testSandbox(process.cwd());
      },
      reportWarning: (message) => warnings.push(message),
    });

    expect(result).toEqual({
      ok: false,
      error:
        "This tool could not start because the server did not supply its security configuration. " +
        "Reconnect Desktop to the server and retry. If it persists, update the server and Desktop. No operation was started.",
    });
    expect(factoryCalls).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("warns once and returns a disabled sandbox rooted at the supplied development root", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-policy-dev-"));
    try {
      const warnings: string[] = [];
      const result = await resolveRelayDispatchSandbox({
        envelope: undefined,
        isProduction: false,
        developmentRoot: root,
        toolName: "run_shell",
        reportWarning: (message) => warnings.push(message),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sandbox.workspacePath()).toBe(canonicalize(root));
        expect(result.sandbox.getConfig().mode).toBe("disabled");
      }
      expect(warnings).toEqual([
        "[relay] Dispatch received without sandboxProfile (run_shell). " +
          "Development-build dev loop — release builds will refuse this path.",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Current Folder helper parity", () => {
  test("recognizes valid, file, and missing Current Folder paths", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-policy-cwd-"));
    const file = join(root, "not-a-directory");
    const missing = join(root, "missing");
    try {
      writeFileSync(file, "test");

      expect(unusableCurrentFolderError(root)).toBeNull();
      expect(unusableCurrentFolderError(file)).toContain("is not a directory");
      expect(unusableCurrentFolderError(missing)).toContain("cannot access");
      expect(unusableCurrentFolderError(missing)).toContain("ENOENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recognizes sandbox getcwd failures and retains the same remediation", () => {
    expect(
      hasSandboxCwdFailure("shell-init: error retrieving current directory: getcwd: Operation not permitted"),
    ).toBe(true);
    expect(hasSandboxCwdFailure("ordinary command failure")).toBe(false);
    expect(sandboxCurrentFolderError("/tmp/project")).toBe(
      "Current Folder is unusable for run_shell: the sandbox cannot access /tmp/project. " +
        "Choose a normal user directory (for example, a folder in your home directory) and retry.",
    );
  });
});
