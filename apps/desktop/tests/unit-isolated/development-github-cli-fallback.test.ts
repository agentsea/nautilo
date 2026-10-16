import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import type { Sandbox } from "@nautilo/sandbox";
import { createWorkspaceGuard, type RelayDispatchRequest, type RelayWorkstationShellBinding } from "@nautilo/relay";
import { LocalExecutionHost } from "../../electron/local-execution-host";
import { LocalExecutionDispatch } from "../../electron/relay-dispatch/local-execution";
import type { LocalProcessExit } from "../../electron/local-execution-process";

mock.module("electron", () => ({ app: { getPath: () => "/tmp/development-fallback-test" } }));
const originalPath = process.env["PATH"];
const userBin = realpathSync(mkdtempSync(join(tmpdir(), "development-user-bin-")));
process.env["PATH"] = [userBin, originalPath].filter(Boolean).join(path.delimiter);

// The Development environment runs POSIX login shells and `#!/bin/sh`
// executables through the POSIX process adapter; Windows refuses it.
const posixDevelopmentTest = process.platform === "win32" ? test.skip : test;

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
beforeAll(async () => { ({ makeDispatchHandler } = await import("../../electron/relay")); });

const roots: string[] = [userBin];
const hosts: LocalExecutionHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.finishDisposal();
  for (const root of roots.splice(1)) rmSync(root, { recursive: true, force: true });
});

function fixture(kind: "foreground" | "delegated", bundled: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "development-fallback-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "development-home-")));
  const tools = join(root, "tools");
  const bundledBin = join(root, "bundled-bin");
  mkdirSync(tools); mkdirSync(bundledBin);
  const gh = join(bundledBin, "gh"); writeFileSync(gh, "#!/bin/sh\n"); chmodSync(gh, 0o755);
  roots.push(root, home);
  let captured: { envelope: Parameters<NonNullable<Parameters<typeof makeDispatchHandler>[1]["createSandbox"]>>[0]; environment?: Readonly<Record<string, string>> } | undefined;
  let finish!: (exit: LocalProcessExit) => void;
  const exited = new Promise<LocalProcessExit>(resolve => { finish = resolve; });
  const host = new LocalExecutionHost({ retention: { maxOutputBytes: 1024, maxTotalOutputBytes: 4096, maxExecutions: 4,
    maxActiveExecutions: 2, completedTtlMs: 1000, maxInputRequestsPerExecution: 4 },
    spawn(prepared) { finish({ exitCode: 0, signal: null }); return { pid: 42, exited, write() {}, terminate() {} }; } });
  hosts.push(host);
  const source = { profileId: "profile", profileRevision: 2, protectedPolicyVersion: 1, home,
    environmentValues: {}, executables: [], userEnvironment: true } as const;
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: root }), {
    relayId: "relay", isProduction: true, localExecution: new LocalExecutionDispatch(host), trustedToolsBin: tools,
    getDevelopmentGitHubExecutable: async () => bundled ? gh : undefined,
    getLocalWorkspacePath: () => root,
    localShellWorkspaceAuthority: async () => ({ ok: true, workspace: root }),
    workstationShellBindingAuthority: async () => ({ ok: true, roots: [root], readOnlyRoots: [], writableRoots: [root],
      grantIds: ["grant"], networkPolicy: { mode: "host" } }),
    workstationProfileStateProvider: {
      getProfileSnapshot: async () => ({ profileId: "profile", profileRevision: 2, grantIds: ["grant"],
        protectedPolicyVersion: 1, networkMode: "host", capabilities: ["user_environment"] }),
      getExecutionEnvironment: () => source,
    },
    resolveLocalExecutionDelegation: async () => ({ root, grantIds: ["grant"], access: ["read", "create_modify", "delete", "execute"],
      dataDir: join(root, "data"), readOnlyRoots: [], writableRoots: [], networkPolicy: { mode: "host" },
      developmentEnvironment: source, isCurrent: () => true }),
    createGuardedShellScratch: () => ({ workspace: root, protectedFileMaskPath: join(root, "mask") }),
    createSandbox: async (envelope, authority) => {
      captured = { envelope, environment: authority?.preparedEnvironment };
      return { containmentActive: () => true, protectedFileMaskSupported: () => true,
        wrap: (program: string, args: readonly string[], cwd: string) => ({ program, args: [...args], cwd, env: { ...authority?.preparedEnvironment } }),
        close: () => Promise.resolve() } as unknown as Sandbox;
    },
  });
  const owner = { instanceId: "instance", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "conversation",
    relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pair", serverBindingId: "server",
    profileId: "profile", profileRevision: 2, grantIds: ["grant"], grantRevision: 1, protectedPolicyVersion: 1 } as const;
  const shell: RelayWorkstationShellBinding = { version: 2, toolCallId: "call", relayId: "relay", desktopSessionId: "desktop",
    serverBindingId: "server", pairingGeneration: "pair", profileId: "profile", profileRevision: 2, grantIds: ["grant"],
    grantRevision: 1, capabilityRevision: 1, currentFolder: root, protectedPolicyVersion: 1,
    subject: { userId: "human", instanceId: "instance", relayId: "relay", agentScope: "all_owned_agents" },
    operation: "execute", executionClass: "profile_bound_sandbox" };
  const binding = kind === "foreground"
    ? { version: 1 as const, generation: host.hostGeneration, invocationId: "call", executionId: `${kind}-${bundled}`,
        operation: "start" as const, localNetworkPolicy: { mode: "host" as const }, owner }
    : { version: 4 as const, authority: { kind: "delegated" as const, roomId: "room", taskId: "task", taskRunId: "run",
        delegation: { version: 1 as const, humanUserId: "human", agentId: "agent", sourceRoomId: "room", sourceConversationId: "conversation",
          rootTaskId: "task", target: { instanceId: "instance", relayId: "relay", pairingGeneration: "pair",
            serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" }, projectGrantId: "grant", ceiling: "development" as const,
          profile: { id: "profile", revision: 2 } } }, generation: host.hostGeneration, invocationId: "call",
        executionId: `${kind}-${bundled}`, operation: "start" as const, localNetworkPolicy: { mode: "host" as const }, owner };
  const request: RelayDispatchRequest = { correlationId: "dispatch", toolName: "exec_command", args: { cmd: "true", yield_time_ms: 100 },
    impact: "destructive", approvalObtained: true, ...(kind === "foreground" ? { workstationShellBinding: shell } : {}),
    runShellOwnerBinding: { instanceId: "instance", userId: "human", relayId: "relay", desktopSessionId: "desktop" },
    localExecutionBinding: binding,
    sandboxProfile: { workspace: "/wire/workspace", dataDir: "/wire/data", toolsBin: "/wire/tools", mode: "desktop-permissive",
      securityLevel: "standard", failIfNoBackend: false,
      config: { mode: "disabled", writablePaths: ["/wire/write"], projectPaths: ["/wire/project"], readOnlyPaths: ["/wire/read"],
        passthroughEnv: ["GH_TOKEN"], networkPolicy: { mode: "isolated" } } },
  };
  return { handler, request, bundledBin, captured: () => captured };
}

for (const kind of ["foreground", "delegated"] as const) {
  posixDevelopmentTest(`${kind} Development derives the same native PATH fallback and ignores wire sandbox authority`, async () => {
    const f = fixture(kind, true);
    expect((await f.handler(f.request)).status).toBe("ok");
    const captured = f.captured(); expect(captured).toBeDefined();
    const directories = captured!.environment!["PATH"]!.split(path.delimiter);
    expect(directories.indexOf(userBin)).toBeGreaterThanOrEqual(0);
    expect(directories.indexOf(userBin)).toBeLessThan(directories.indexOf(f.bundledBin));
    expect(captured!.envelope.config.readOnlyPaths).toContain(f.bundledBin);
    expect(captured!.envelope.config.readOnlyPaths).not.toContain("/wire/read");
    expect(captured!.envelope.config.passthroughEnv).not.toContain("GH_TOKEN");
  });
}

posixDevelopmentTest("Development still runs when no verified bundled GitHub CLI fallback is available", async () => {
  const f = fixture("foreground", false);
  expect((await f.handler(f.request)).status).toBe("ok");
  expect(f.captured()?.environment?.["PATH"]?.split(path.delimiter)).toContain(userBin);
  expect(f.captured()?.envelope.config.readOnlyPaths ?? []).not.toContain(f.bundledBin);
});
