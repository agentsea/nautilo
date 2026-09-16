import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { SshCapabilityStore } from "../../electron/structured-ssh/capability-store";

// relay.ts loads Electron path helpers at module evaluation time. The dispatch
// cases below do not use Electron itself, so use the same narrow test stub as
// the relay's existing focused suites.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d500-raw-lane-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay"));
});

const subject = {
  instanceId: "",
  userId: "user-1",
  agentId: "agent-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-1",
};
const sshTools = { auth: true, exec: true, copyUpload: true, copyDownload: true };

function createCapabilityStore() {
  let bytes: string | null = null;
  return new SshCapabilityStore({
    instanceId: subject.instanceId,
    serverBindingId: "ssh-server-binding-aaaaaaaaaaaaaaaa",
    filePath: "/unused/d500-structured-ssh-capability.json",
    storage: {
      read: async () => bytes,
      writeAtomic: async (next) => { bytes = next; },
    },
    clock: () => new Date("2026-08-09T12:00:00.000Z"),
  });
}

function rawWorkstationRequest(command: string): RelayDispatchRequest {
  return {
    correlationId: `d500-raw-${command}`,
    toolName: "run_shell",
    args: { command, execution: "workstation" },
    impact: "low",
    approvalObtained: true,
    executionClass: "real_workstation",
  };
}

describe("D500 structured SSH raw-lane independence", () => {
  test("capability enablement, disablement, and revocation leave raw developer commands on the same no-Current-Folder workstation route", async () => {
    // The always-present visible Genie Workspace must be an existing local
    // directory; this suite deliberately leaves the optional Current Folder
    // unset below.
    const workspace = process.cwd();
    const capabilityStore = createCapabilityStore();
    const dispatches: Array<{ command: string; cwd: string; workspacePath?: string }> = [];
    let workstationProfileReads = 0;

    // If any raw workstation dispatch starts consulting SSH state, this fails
    // before a command could be sent. The lifecycle below uses the real store;
    // the poison object is only the relay's SSH execution dependency.
    const poisonStructuredSshRuntime = new Proxy({}, {
      get: () => { throw new Error("raw workstation dispatch must not read Structured SSH runtime"); },
    });
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: workspace }), {
      isProduction: true,
      structuredSsh: poisonStructuredSshRuntime as never,
      getLocalWorkspacePath: () => undefined,
      workstationWorkspacePath: workspace,
      workstationProfileStateProvider: {
        getProfileSnapshot: async () => {
          workstationProfileReads += 1;
          return undefined;
        },
      },
      runWorkstationShell: async ({ command, cwd, workspacePath, onStdoutChunk }) => {
        dispatches.push({ command, cwd, workspacePath });
        onStdoutChunk?.(Buffer.from(command));
        return {
          status: "ok",
          result: {
            version: 1,
            execution: "workstation",
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            durationMs: 1,
            stdout: command,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            sideEffectsMayHaveStarted: false,
            profileRevision: null,
          },
        };
      },
    });

    const rawDeveloperCommands = [
      "git status",
      "gh auth status",
      "brew --version",
      "ssh -G build.example.test",
    ];
    const assertRawLane = async (state: string) => {
      for (const command of rawDeveloperCommands) {
        await expect(handler(rawWorkstationRequest(command))).resolves.toMatchObject({
          status: "ok",
          result: { execution: "workstation", stdout: command },
        });
      }
      await expect(handler({
        correlationId: `d500-terminal-${state}`,
        toolName: "terminal",
        args: { action: "list" },
        impact: "low",
        approvalObtained: true,
        sandboxProfile: {
          workspace,
          dataDir: `${workspace}/data`,
          toolsBin: `${workspace}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
        },
      })).resolves.toMatchObject({ status: "ok", result: { sessions: expect.any(Array) } });
      expect(dispatches.slice(-rawDeveloperCommands.length)).toEqual(
        rawDeveloperCommands.map((command) => ({ command, cwd: workspace, workspacePath: workspace })),
      );
      expect(workstationProfileReads, `${state} SSH state must not read or alter workstation profile authority`).toBe(0);
    };

    await assertRawLane("empty");

    const enabled = await capabilityStore.enable({ subject, expectedRevision: 0, tools: sshTools });
    expect(enabled).toMatchObject({ ok: true, data: { capability: { enabled: true }, revision: 1 } });
    if (!enabled.ok) throw new Error("structured SSH capability enablement failed");
    await assertRawLane("enabled");

    const disabled = await capabilityStore.disable({ subject, expectedRevision: enabled.data.revision });
    expect(disabled).toMatchObject({ ok: true, data: { capability: { enabled: false }, revision: 2 } });
    if (!disabled.ok) throw new Error("structured SSH capability disablement failed");
    await assertRawLane("disabled");

    const reenabled = await capabilityStore.enable({ subject, expectedRevision: disabled.data.revision, tools: sshTools });
    if (!reenabled.ok) throw new Error("structured SSH capability re-enablement failed");
    const revoked = await capabilityStore.revoke({ subject, expectedRevision: reenabled.data.revision });
    expect(revoked).toMatchObject({ ok: true, data: { capability: { enabled: false, revokedAt: "2026-08-09T12:00:00.000Z" }, revision: 4 } });
    await assertRawLane("revoked");
  });
});
