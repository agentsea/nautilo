import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildIdentity, HostTimer } from "@nautilo/codex-app-server-host/internal";
import {
  createElectronCodexProductionHostFactory,
  prepareSecureCodexDirectories,
  type ElectronCodexProductionHostDependencies,
} from "../../electron/codex-production-host.ts";
import type { ElectronCodexClientCallbackBuilderInput } from "../../electron/codex-host.ts";
import { ElectronCodexTurnTerminalTracker } from "../../electron/codex-turn-terminal.ts";

describe("ElectronCodexTurnTerminalTracker", () => {
  test("resolves only the full exact child, binding, thread, and turn receipt", async () => {
    const tracker = new ElectronCodexTurnTerminalTracker(fakeTimer());
    const exact = terminalInput();
    let settled = false;
    const waiting = tracker.wait({ ...exact, timeoutMs: 10 }).then((value) => {
      settled = true;
      return value;
    });

    tracker.observe({ ...exact, child: { ...exact.child, childGeneration: 5 } });
    tracker.observe({ ...exact, binding: { ...exact.binding, bindingGeneration: 2 } });
    tracker.observe({ ...exact, binding: { ...exact.binding, child: { ...exact.child, childGeneration: 5 } } });
    tracker.observe({ ...exact, turnId: "sibling-turn" });
    await Promise.resolve();
    expect(settled).toBeFalse();

    tracker.observe(exact);
    expect(await waiting).toBeTrue();
  });

  test("accepts a terminal notification observed before the interrupt waiter", async () => {
    const tracker = new ElectronCodexTurnTerminalTracker(fakeTimer());
    const exact = terminalInput();
    tracker.observe(exact);
    expect(await tracker.wait({ ...exact, timeoutMs: 10 })).toBeTrue();
  });

  test("bounds timeout and shutdown cleanup without retaining waiters or timers", async () => {
    const timer = fakeTimer();
    const tracker = new ElectronCodexTurnTerminalTracker(timer);
    const timedOut = tracker.wait({ ...terminalInput(), timeoutMs: 10 });
    timer.runAll();
    expect(await timedOut).toBeFalse();
    expect(timer.pending()).toBe(0);

    const closing = tracker.wait({ ...terminalInput({ turnId: "closing-turn" }), timeoutMs: 10 });
    expect(timer.pending()).toBe(1);
    tracker.close();
    expect(await closing).toBeFalse();
    expect(timer.pending()).toBe(0);
  });
});

describe("production Electron Codex host factory", () => {
  test("creates only private direct children beneath a trusted host parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nautilo-codex-production-"));
    const paths = pathsUnder(parent);
    try {
      await prepareSecureCodexDirectories({ ...paths, currentUid: process.getuid?.() ?? -1 });
      for (const directory of Object.values(paths)) {
        const info = await lstat(directory);
        expect(info.isDirectory()).toBeTrue();
        expect(info.isSymbolicLink()).toBeFalse();
        expect(info.mode & 0o077).toBe(0);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("rejects a symlink host root instead of traversing it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nautilo-codex-production-"));
    const target = await mkdtemp(join(tmpdir(), "nautilo-codex-target-"));
    const paths = pathsUnder(parent);
    try {
      await symlink(target, paths.codexHostDirPath);
      await expect(prepareSecureCodexDirectories({ ...paths, currentUid: process.getuid?.() ?? -1 }))
        .rejects.toThrow("unsafe_codex_host_directory");
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("is inert until explicit enable, then shares one manager/controller authority and fails closed", async () => {
    const calls: string[] = [];
    const manager = { marker: "one-manager" };
    const controller = {
      resolveRuntimeHandleForGeneration: () => null,
      status: () => ({ state: "runtime_unavailable" as const, runtime: { state: "absent" as const } }),
      onSupervisorFault: async () => { calls.push("project-fault"); return true; },
    };
    let serviceOptions: Record<string, unknown> | undefined;
    let capturedCallbacks: ElectronCodexClientCallbackBuilderInput | undefined;
    let capturedClientOptions: Readonly<{ experimentalApi: true }> | undefined;
    const host = {
      isReady: () => true,
      refreshStatus: () => { calls.push("refresh-status"); },
      shutdown: async () => { calls.push("shutdown"); },
    };
    const dependencies: Partial<ElectronCodexProductionHostDependencies> = {
      prepareDirectories: async () => { calls.push("directories"); },
      createRuntimeHost: (() => { calls.push("external"); return {}; }) as never,
      createManagedRuntimeHost: (() => { calls.push("managed"); return {}; }) as never,
      createRuntimeManager: ((external: unknown, managed: unknown) => {
        expect(external).toEqual({});
        expect(managed).toEqual({});
        calls.push("manager");
        return manager;
      }) as never,
      createRuntimeControllerAdapter: ((exactManager: unknown) => {
        expect(exactManager).toBe(manager);
        calls.push("adapter");
        return { inspect: async () => ({ state: "absent" as const }), install: async () => ({ state: "failed" as const }) };
      }) as never,
      createController: ((options: { openExternal: (url: string) => Promise<void> }) => {
        calls.push("controller");
        expect(options.openExternal).toBe(openExternal);
        return controller;
      }) as never,
      createRuntimeProvider: ((exactManager: unknown, exactController: unknown) => {
        expect(exactManager).toBe(manager);
        expect(exactController).toBe(controller);
        calls.push("provider");
        return {};
      }) as never,
      createClients: (callbacks, clientOptions) => {
        capturedCallbacks = callbacks;
        capturedClientOptions = clientOptions;
        return {} as never;
      },
      createServices: ((options: Record<string, unknown>) => {
        serviceOptions = options;
        // Simulate the one supervisor constructor asking for its exact client.
        options.createClients as ((callbacks: typeof capturedCallbacks) => unknown);
        (options.createClients as (callbacks: NonNullable<typeof capturedCallbacks>) => unknown)({
          isCurrent: () => true,
          onClientFault: async () => { calls.push("fault"); },
          onNotification: async () => {},
          onServerRequest: async () => { throw new Error("request callback test seam"); },
        });
        calls.push("services");
        return async () => ({} as never);
      }) as never,
      createHost: ((options: { status(): unknown }) => {
        calls.push("host");
        expect(options.status()).toEqual({ state: "runtime_unavailable", runtime: { state: "absent" } });
        return host;
      }) as never,
      randomBytes: (size) => { calls.push(`hmac:${size}`); return new Uint8Array(size); },
    };
    const openExternal = async (_url: string) => { calls.push("openExternal"); };
    const factory = createElectronCodexProductionHostFactory({
      actorId: "server-resolved-actor",
      currentFolder: () => ({ path: "/private/workspace", revision: 9 }),
      paths: pathsUnder("/private/trusted-parent"),
      openExternal,
      dependencies,
    });

    expect(calls).toEqual([]);
    const enabled = await factory();
    expect(enabled).toBe(host);
    expect(calls).toEqual(["directories", "external", "managed", "manager", "adapter", "controller", "provider", "hmac:32", "services", "host"]);
    expect(serviceOptions?.actorId as () => string).toBeInstanceOf(Function);
    expect((serviceOptions?.actorId as () => string)()).toBe("server-resolved-actor");
    const terminal = (serviceOptions?.createTurnTerminal as () => ElectronCodexTurnTerminalTracker)();
    const exact = terminalInput();
    terminal.observe(exact);
    expect(await terminal.wait({ ...exact, timeoutMs: 1 })).toBeTrue();
    expect(capturedCallbacks).toBeDefined();
    expect(capturedCallbacks?.onServerRequest).toBeFunction();
    expect(capturedClientOptions).toEqual({ experimentalApi: true });
    await capturedCallbacks!.onClientFault({} as ChildIdentity);
    expect(calls).toContain("fault");
    await (serviceOptions?.onFault as (fault: unknown) => Promise<void>)({
      kind: "child_crashed",
      child: {} as ChildIdentity,
    });
    expect(calls.slice(-2)).toEqual(["project-fault", "refresh-status"]);
  });
});

function pathsUnder(parent: string) {
  const codexHostDirPath = join(parent, "codex");
  return {
    codexHostDirPath,
    codexRuntimeDirPath: join(codexHostDirPath, "runtime"),
    codexProfileHomesDirPath: join(codexHostDirPath, "profile-homes"),
    codexHostStateDirPath: join(codexHostDirPath, "state"),
  };
}

function terminalInput(overrides: Partial<{
  readonly child: ChildIdentity;
  readonly binding: {
    readonly bindingId: string;
    readonly bindingGeneration: number;
    readonly threadId: string;
    readonly child: ChildIdentity;
  };
  readonly turnId: string;
}> = {}) {
  const child = overrides.child ?? {
    profile: { actorId: "actor", profileHandle: "profile", profileGeneration: 1 },
    accountGeneration: 2,
    runtimeGeneration: 3,
    childGeneration: 4,
  } as ChildIdentity;
  return {
    child,
    binding: overrides.binding ?? {
      bindingId: "binding",
      bindingGeneration: 1,
      threadId: "thread",
      child,
    },
    turnId: overrides.turnId ?? "turn",
  };
}

function fakeTimer(): HostTimer & { runAll(): void; pending(): number } {
  const entries: Array<{ callback: () => void; cleared: boolean }> = [];
  return {
    setTimeout(callback) {
      const entry = { callback, cleared: false };
      entries.push(entry);
      return entry as never;
    },
    clearTimeout(handle) {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
    runAll() {
      for (const entry of entries) {
        if (entry.cleared) continue;
        entry.cleared = true;
        entry.callback();
      }
    },
    pending() {
      return entries.filter((entry) => !entry.cleared).length;
    },
  };
}
