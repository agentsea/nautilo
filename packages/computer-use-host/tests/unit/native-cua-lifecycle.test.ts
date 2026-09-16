import { describe, expect, mock, test } from "bun:test";
import {
  CuaMainLifecycle,
  attestPackagedCuaDriver,
  ensureCuaRuntimeDirectory,
  resolvePackagedCuaDriverPath,
  type CuaHealthSupervisor,
  type CuaMainLifecycleFilesystem,
} from "../../src/native-cua-lifecycle.ts";
import type { CuaSupervisorHealth } from "../../src/native-cua-supervisor.ts";
import type { ComputerUseContextScope } from "../../src/native-context-registry.ts";

const uid = 501;
const hostBundleId = "com.example.cua-host-fixture";
const scope: ComputerUseContextScope = {
  computerUseContextId: "ctx", installationEpoch: "epoch", grantGeneration: 1,
  provider: "cua", providerGeneration: "generation",
  originHumanId: "human", originRunId: "run", originAgentId: "agent", lineageId: "lineage",
  serverBindingId: "binding", relayId: "relay", pairingGeneration: "pairing", desktopSessionId: "desktop",
};

function stat(kind: "directory" | "file" | "symlink", mode: number, owner = uid) {
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
    mode,
    uid: owner,
  };
}

function filesystem(binary: "present" | "missing" | "symlink" = "present"): CuaMainLifecycleFilesystem {
  return {
    mkdir: mock(async () => undefined),
    lstat: mock(async (path: string) => {
      if (path.includes("/tools-cua/")) {
        if (binary === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return binary === "symlink" ? stat("symlink", 0o777) : stat("file", 0o755);
      }
      return stat("directory", 0o700);
    }),
    // Mirrors Darwin, where /tmp is a symlink into /private. The lifecycle
    // must hand out only the canonical form so daemon-echoed paths can never
    // diverge from the sent path on symlink resolution.
    realpath: mock(async (path: string) => path.replace(/^\/tmp\//, "/private/tmp/")),
  };
}

function healthySupervisor(): CuaHealthSupervisor {
  const callContextTool = mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }));
  return {
    refreshHealth: mock(async () => ({ ok: true as const, health: { permission: "ready" as const, health: "ready" as const } })),
    existingHealthyGeneration: () => "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    subscribeInvalidation: () => () => {},
    callContextTool,
    launchApplication: async (scope, generation, bundleId, signal) => callContextTool(scope, generation, "launch_app", { bundle_id: bundleId }, signal),
    getWindowState: async (scope, generation, pid, windowId, _query, signal) => callContextTool(scope, generation, "get_window_state", { pid, window_id: windowId, include_screenshot: false }, signal),
    captureDesktopState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
    endContextLease: mock(async () => undefined),
    shutdown: mock(async () => undefined),
  };
}

function supervisorWithHealth(
  generation: string,
  health: CuaSupervisorHealth = { permission: "ready", health: "ready" },
  shutdown: () => Promise<void> = async () => undefined,
): CuaHealthSupervisor {
  const callContextTool = mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }));
  return {
    refreshHealth: mock(async () => ({ ok: true as const, health })),
    existingHealthyGeneration: () => generation,
    subscribeInvalidation: () => () => {},
    callContextTool,
    launchApplication: async (currentScope, currentGeneration, bundleId, signal) => callContextTool(currentScope, currentGeneration, "launch_app", { bundle_id: bundleId }, signal),
    getWindowState: async (currentScope, currentGeneration, pid, windowId, _query, signal) => callContextTool(currentScope, currentGeneration, "get_window_state", { pid, window_id: windowId, include_screenshot: false }, signal),
    captureDesktopState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
    clickDesktop: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
    endContextLease: mock(async () => undefined),
    shutdown: mock(shutdown),
  };
}

describe("D516 packaged Cua main lifecycle", () => {
  test("resolves only the exact packaged Darwin resource", () => {
    expect(resolvePackagedCuaDriverPath({ platform: "darwin", isPackaged: true, resourcesPath: "/Applications/Nautilo.app/Contents/Resources" }))
      .toBe("/Applications/Nautilo.app/Contents/Resources/tools-cua/cua-driver");
    expect(resolvePackagedCuaDriverPath({ platform: "darwin", isPackaged: false, resourcesPath: "/resources" })).toBeNull();
    expect(resolvePackagedCuaDriverPath({ platform: "linux", isPackaged: true, resourcesPath: "/resources" })).toBeNull();
    expect(resolvePackagedCuaDriverPath({ platform: "darwin", isPackaged: true, resourcesPath: "relative" })).toBeNull();
  });

  test("creates and attests only a private current-user tuple runtime leaf", async () => {
    const fs = filesystem();
    const runtimeDir = await ensureCuaRuntimeDirectory("/tuple/userData", uid, fs);
    // The returned directory is the CANONICAL path (Darwin: /private/tmp),
    // never the /tmp symlink spelling that a canonicalizing daemon would
    // refuse to echo verbatim.
    expect(runtimeDir).toMatch(/^\/private\/tmp\/nautilo-cua-[a-f0-9]{24}$/);
    expect(fs.mkdir).toHaveBeenCalledWith(runtimeDir.replace("/private/tmp/", "/tmp/"), { recursive: true, mode: 0o700 });
    expect(await ensureCuaRuntimeDirectory("/tuple/other-userData", uid, fs)).not.toBe(runtimeDir);

    // The longest supervisor leaf is `cua_` + 32 base64url bytes + `.sock`.
    // Keep the actual UTF-8 path below Darwin's 104-byte sockaddr boundary,
    // even when the source tuple path itself is arbitrarily long.
    const longRuntimeDir = await ensureCuaRuntimeDirectory(`/Users/tester/Library/Application Support/${"long-profile-".repeat(40)}`, uid, fs);
    expect(Buffer.byteLength(`${longRuntimeDir}/cua_${"a".repeat(32)}.sock`)).toBeLessThan(104);

    // A deterministic final `/tmp/nautilo-cua-X` leaf must not be allowed to
    // redirect through a safe-looking canonical target. The requested leaf is
    // attested before `realpath`, so the canonical path is never consulted.
    const requestedLeafSymlink: CuaMainLifecycleFilesystem = {
      ...fs,
      lstat: mock(async (path: string) => path.startsWith("/tmp/nautilo-cua-")
        ? stat("symlink", 0o700)
        : stat("directory", 0o700)),
      realpath: mock(async () => "/private/tmp/safe-target"),
    };
    await expect(ensureCuaRuntimeDirectory("/tuple/userData", uid, requestedLeafSymlink)).rejects.toThrow("private current-user");
    expect(requestedLeafSymlink.realpath).not.toHaveBeenCalled();

    // Attesting the requested leaf is not enough: the canonical `/private`
    // target must independently remain a private current-user directory too.
    const canonicalSymlink: CuaMainLifecycleFilesystem = {
      ...fs,
      lstat: async (path: string) => path.startsWith("/tmp/nautilo-cua-")
        ? stat("directory", 0o700)
        : stat("symlink", 0o700),
    };
    await expect(ensureCuaRuntimeDirectory("/tuple/userData", uid, canonicalSymlink)).rejects.toThrow("private current-user");
    const foreignCanonical: CuaMainLifecycleFilesystem = {
      ...fs,
      lstat: async (path: string) => path.startsWith("/tmp/nautilo-cua-")
        ? stat("directory", 0o700)
        : stat("directory", 0o700, uid + 1),
    };
    await expect(ensureCuaRuntimeDirectory("/tuple/userData", uid, foreignCanonical)).rejects.toThrow("private current-user");
  });

  test("status is local and does not create a directory, supervisor, or child", () => {
    const fs = filesystem();
    const createSupervisor = mock(() => healthySupervisor());
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: fs, createSupervisor,
    });
    expect(lifecycle.status()).toEqual({ lifecycle: "installed" });
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(createSupervisor).not.toHaveBeenCalled();
  });

  test("keeps the build-bound host bundle identifier at its established 255-code-unit containment", () => {
    const overlongHostBundleId = `com.${"a".repeat(252)}`;
    expect(overlongHostBundleId).toHaveLength(256);
    expect(() => new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId: overlongHostBundleId, expectedUid: uid, filesystem: filesystem(),
    })).toThrow("valid build-bound host bundle id");
  });

  test("automatic startup verifies the exact file and mints the same fresh checked generation used by manual recovery", async () => {
    const fs = filesystem();
    const supervisor = healthySupervisor();
    const createSupervisor = mock(() => supervisor);
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: fs, createSupervisor,
    });
    await expect(lifecycle.startup()).resolves.toEqual({ lifecycle: "healthy" });
    expect(createSupervisor).toHaveBeenCalledWith(
      "/resources/tools-cua/cua-driver",
      expect.stringMatching(/^\/private\/tmp\/nautilo-cua-[a-f0-9]{24}$/),
      uid,
      hostBundleId,
    );
    expect(supervisor.refreshHealth).toHaveBeenCalledTimes(1);
    // This port is readiness-check-bound only; status itself never invokes it.
    expect(lifecycle.checkedContextPort()?.generation).toBe("cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(lifecycle.status()).toEqual({ lifecycle: "healthy" });
  });

  test("automatic startup degrades without publishing a route when health is not ready", async () => {
    const supervisor = healthySupervisor();
    supervisor.refreshHealth = mock(async () => ({ ok: true as const, health: { permission: "unavailable" as const, health: "degraded" as const } }));
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: filesystem(), createSupervisor: () => supervisor,
    });
    await expect(lifecycle.startup()).resolves.toEqual({ lifecycle: "unhealthy" });
    expect(lifecycle.checkedContextPort()).toBeNull();
  });

  test("mints a port only for the exact healthy Check generation and clears it on invalidation", async () => {
    const fs = filesystem();
    let invalidate: (() => void) | null = null;
    const generation = "cua_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const callContextTool = mock(async () => ({
      ok: false as const,
      code: "context_fenced" as const,
      stage: "session" as const,
    }));
    const endContextLease = mock(async () => undefined);
    const captureDesktopState = mock(async () => ({ ok: false as const, code: "context_fenced" as const }));
    const awaitOutstandingOperations = mock(async () => undefined);
    const supervisor: CuaHealthSupervisor = {
      refreshHealth: mock(async () => ({ ok: true as const, health: { permission: "ready" as const, health: "ready" as const } })),
      existingHealthyGeneration: () => generation,
      subscribeInvalidation: (listener) => {
        invalidate = listener;
        return () => { invalidate = null; };
      },
      callContextTool,
      launchApplication: async (scope, currentGeneration, bundleId, signal) => callContextTool(scope, currentGeneration, "launch_app", { bundle_id: bundleId }, signal),
      getWindowState: async (scope, currentGeneration, pid, windowId, _query, signal) => callContextTool(scope, currentGeneration, "get_window_state", { pid, window_id: windowId, include_screenshot: false }, signal),
      captureDesktopState,
      awaitOutstandingOperations,
      endContextLease,
      shutdown: mock(async () => undefined),
    };
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      expectedUid: uid, filesystem: fs, createSupervisor: () => supervisor,
    });

    expect(lifecycle.checkedContextPort()).toBeNull();
    await expect(lifecycle.check()).resolves.toEqual({ lifecycle: "healthy" });
    const port = lifecycle.checkedContextPort();
    expect(port?.generation).toBe(generation);
    await port?.callContextTool(scope, "list_apps", {});
    expect(callContextTool).toHaveBeenCalledWith(
      scope, generation, "list_apps", {}, undefined, undefined,
    );
    await port?.launchApplication?.(scope, "com.apple.TextEdit");
    expect(callContextTool).toHaveBeenCalledWith(
      scope, generation, "launch_app", { bundle_id: "com.apple.TextEdit" }, undefined,
    );
    await port?.getWindowState?.(scope, 42, 90);
    expect(callContextTool).toHaveBeenCalledWith(
      scope, generation, "get_window_state", { pid: 42, window_id: 90, include_screenshot: false }, undefined,
    );
    await port?.captureDesktopState(scope);
    expect(captureDesktopState).toHaveBeenCalledWith(scope, generation, undefined);
    const requestSignal = new AbortController().signal;
    await port?.awaitOutstandingOperations(scope, requestSignal);
    expect(awaitOutstandingOperations).toHaveBeenCalledWith(scope, generation, requestSignal);

    invalidate?.();
    expect(lifecycle.status()).toEqual({ lifecycle: "unhealthy" });
    expect(lifecycle.checkedContextPort()).toBeNull();
  });

  test("clears an exact checked generation before synchronous invalidation listeners run", async () => {
    const fs = filesystem();
    let invalidate: (() => void) | null = null;
    const generation = "cua_dddddddddddddddddddddddddddddddd";
    const supervisor: CuaHealthSupervisor = {
      refreshHealth: mock(async () => ({ ok: true as const, health: { permission: "ready" as const, health: "ready" as const } })),
      existingHealthyGeneration: () => generation,
      subscribeInvalidation: (listener) => {
        invalidate = listener;
        return () => { invalidate = null; };
      },
      callContextTool: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
      launchApplication: async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }),
      getWindowState: async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }),
      endContextLease: mock(async () => undefined),
      shutdown: mock(async () => undefined),
    };
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      expectedUid: uid, filesystem: fs, createSupervisor: () => supervisor,
    });
    const events: unknown[] = [];
    lifecycle.subscribeCheckedGenerationInvalidation((event) => {
      events.push(event);
      expect(lifecycle.checkedContextPort()).toBeNull();
    });

    await lifecycle.check();
    invalidate?.();
    expect(events).toEqual([{ generation, reason: "supervisor_invalidated" }]);
  });

  test("a semantically malformed provider result synchronously withdraws readiness but preserves the lifecycle owner", async () => {
    const supervisor = healthySupervisor();
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: filesystem(), createSupervisor: () => supervisor,
    });
    const events: unknown[] = [];
    lifecycle.subscribeCheckedGenerationInvalidation((event) => events.push(event));
    await lifecycle.startup();
    const port = lifecycle.checkedContextPort();
    expect(port).not.toBeNull();
    port?.invalidateCheckedGeneration?.();
    expect(lifecycle.status()).toEqual({ lifecycle: "unhealthy" });
    expect(lifecycle.checkedContextPort()).toBeNull();
    expect(events).toEqual([{ generation: "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", reason: "provider_malformed" }]);
    expect(supervisor.shutdown).not.toHaveBeenCalled();
  });

  test("does not publish a healthy token when invalidation lands during Check generation capture", async () => {
    const fs = filesystem();
    let invalidate: (() => void) | null = null;
    const supervisor: CuaHealthSupervisor = {
      refreshHealth: mock(async () => ({ ok: true as const, health: { permission: "ready" as const, health: "ready" as const } })),
      // This is the deterministic seam between fresh health and token publication.
      existingHealthyGeneration: () => {
        invalidate?.();
        return "cua_cccccccccccccccccccccccccccccccc";
      },
      subscribeInvalidation: (listener) => {
        invalidate = listener;
        return () => { invalidate = null; };
      },
      callContextTool: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
      launchApplication: async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }),
      getWindowState: async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }),
      endContextLease: mock(async () => undefined),
      shutdown: mock(async () => undefined),
    };
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      expectedUid: uid, filesystem: fs, createSupervisor: () => supervisor,
    });

    await expect(lifecycle.check()).resolves.toEqual({ lifecycle: "unhealthy" });
    expect(lifecycle.checkedContextPort()).toBeNull();
  });

  test("a missing or symlinked packaged resource is not installed and never spawns", async () => {
    for (const binary of ["missing", "symlink"] as const) {
      const fs = filesystem(binary);
      const createSupervisor = mock(() => healthySupervisor());
      const lifecycle = new CuaMainLifecycle({
        platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
        expectedUid: uid, filesystem: fs, createSupervisor,
      });
      await expect(lifecycle.check()).resolves.toEqual({ lifecycle: "not_installed" });
      expect(createSupervisor).not.toHaveBeenCalled();
      await expect(attestPackagedCuaDriver("/resources/tools-cua/cua-driver", fs)).resolves.toBe(false);
    }
  });

  test("shutdown aborts an unbounded fresh Check without a timeout and permanently fences restart", async () => {
    const fs = filesystem();
    const shutdown = mock(async () => undefined);
    let observedAbort = false;
    let refreshStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const supervisor: CuaHealthSupervisor = {
      refreshHealth: mock(async (signal?: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        refreshStarted?.();
        const abort = () => { observedAbort = true; reject(new Error("aborted")); };
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      })),
      existingHealthyGeneration: () => null,
      subscribeInvalidation: () => () => {},
      callContextTool: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
      launchApplication: async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }),
      getWindowState: async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const }),
      endContextLease: mock(async () => undefined),
      shutdown,
    };
    const createSupervisor = mock(() => supervisor);
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      expectedUid: uid, filesystem: fs, createSupervisor,
    });
    const checking = lifecycle.check();
    await started;
    await expect(lifecycle.shutdown()).resolves.toBeUndefined();
    await expect(checking).resolves.toEqual({ lifecycle: "unhealthy" });
    expect(observedAbort).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await expect(lifecycle.check()).resolves.toEqual({ lifecycle: "unhealthy" });
    expect(supervisor.refreshHealth).toHaveBeenCalledTimes(1);
  });

  test("a responsible-host permission transition withdraws the checked route before retiring its child, then mints only a fresh generation", async () => {
    const old = supervisorWithHealth("cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const fresh = supervisorWithHealth("cua_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let created = 0;
    const createSupervisor = mock(() => created++ === 0 ? old : fresh);
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: filesystem(), createSupervisor,
    });
    const invalidations: unknown[] = [];
    lifecycle.subscribeCheckedGenerationInvalidation((event) => {
      invalidations.push(event);
      expect(lifecycle.checkedContextPort()).toBeNull();
      expect(old.shutdown).not.toHaveBeenCalled();
    });

    await lifecycle.check();
    expect(lifecycle.checkedContextPort()?.generation).toBe("cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(lifecycle.reconcileHostPermissions()).resolves.toEqual({ lifecycle: "healthy" });

    expect(invalidations).toEqual([{
      generation: "cua_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "host_permissions_changed",
    }]);
    expect(old.shutdown).toHaveBeenCalledTimes(1);
    expect(createSupervisor).toHaveBeenCalledTimes(2);
    expect(fresh.refreshHealth).toHaveBeenCalledTimes(1);
    expect(lifecycle.checkedContextPort()?.generation).toBe("cua_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  test("a permission transition keeps Cua unhealthy when the freshly spawned child reports missing host permission", async () => {
    const old = supervisorWithHealth("cua_cccccccccccccccccccccccccccccccc");
    const missing = supervisorWithHealth(
      "cua_dddddddddddddddddddddddddddddddd",
      { permission: "unavailable", health: "degraded" },
    );
    let calls = 0;
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: filesystem(), createSupervisor: () => calls++ === 0 ? old : missing,
    });
    await lifecycle.check();
    await expect(lifecycle.reconcileHostPermissions()).resolves.toEqual({ lifecycle: "unhealthy" });
    expect(old.shutdown).toHaveBeenCalledTimes(1);
    expect(missing.refreshHealth).toHaveBeenCalledTimes(1);
    expect(lifecycle.checkedContextPort()).toBeNull();
  });

  test("a failed permission-transition cleanup fences every later check and successor child", async () => {
    const old = supervisorWithHealth("cua_iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii");
    old.shutdown = mock(async () => { throw new Error("child may still be live"); });
    const fresh = supervisorWithHealth("cua_jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj");
    let calls = 0;
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: filesystem(), createSupervisor: () => calls++ === 0 ? old : fresh,
    });
    await lifecycle.check();
    await expect(lifecycle.reconcileHostPermissions()).resolves.toEqual({ lifecycle: "unhealthy" });
    await expect(lifecycle.check()).resolves.toEqual({ lifecycle: "unhealthy" });
    await expect(lifecycle.reconcileHostPermissions()).resolves.toEqual({ lifecycle: "unhealthy" });
    expect(old.shutdown).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    expect(fresh.refreshHealth).not.toHaveBeenCalled();
    expect(lifecycle.checkedContextPort()).toBeNull();
  });

  test("concurrent host-permission transitions coalesce to one child retirement and one fresh check", async () => {
    const old = supervisorWithHealth("cua_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    const fresh = supervisorWithHealth("cua_ffffffffffffffffffffffffffffffff");
    let calls = 0;
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: filesystem(), createSupervisor: () => calls++ === 0 ? old : fresh,
    });
    await lifecycle.check();
    const one = lifecycle.reconcileHostPermissions();
    const two = lifecycle.reconcileHostPermissions();
    expect(two).toBe(one);
    await expect(Promise.all([one, two])).resolves.toEqual([{ lifecycle: "healthy" }, { lifecycle: "healthy" }]);
    expect(old.shutdown).toHaveBeenCalledTimes(1);
    expect(fresh.refreshHealth).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  test("host shutdown waits for a permission-transition child retirement and prevents the fresh restart", async () => {
    let releaseOldShutdown: (() => void) | null = null;
    let oldShutdownStarted: (() => void) | null = null;
    const oldShutdown = new Promise<void>((resolve) => { releaseOldShutdown = resolve; });
    const shutdownStarted = new Promise<void>((resolve) => { oldShutdownStarted = resolve; });
    const old = supervisorWithHealth("cua_gggggggggggggggggggggggggggggggg");
    old.shutdown = mock(async () => {
      oldShutdownStarted?.();
      await oldShutdown;
    });
    const fresh = supervisorWithHealth("cua_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh");
    let calls = 0;
    const lifecycle = new CuaMainLifecycle({
      platform: "darwin", isPackaged: true, resourcesPath: "/resources", userDataPath: "/tuple/userData",
      hostBundleId, expectedUid: uid, filesystem: filesystem(), createSupervisor: () => calls++ === 0 ? old : fresh,
    });
    await lifecycle.check();
    const transition = lifecycle.reconcileHostPermissions();
    await shutdownStarted;
    const closing = lifecycle.shutdown();
    releaseOldShutdown?.();
    await expect(transition).resolves.toEqual({ lifecycle: "unhealthy" });
    await expect(closing).resolves.toBeUndefined();
    expect(old.shutdown).toHaveBeenCalledTimes(1);
    expect(fresh.refreshHealth).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });
});
