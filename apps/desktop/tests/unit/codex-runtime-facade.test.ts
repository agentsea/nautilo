import { describe, expect, test } from "bun:test";
import {
  CodexRuntimeManager,
  createCodexRuntimeControllerAdapter,
} from "../../electron/codex-runtime/index.ts";
import { CODEX_REVIEWED_RUNTIME_ARTIFACT_REF } from "@nautilo/relay";
import {
  createCodexRuntimeProviderForSupervisor,
  resolveCodexRuntimeLaunchSpecForSupervisor,
} from "../../electron/codex-runtime/facade.ts";

const details = Object.freeze({
  state: "ready" as const,
  source: "managed" as const,
  kind: "standalone" as const,
  version: "0.139.0",
  checkedAt: 1,
  compatibility: "certified" as const,
  handle: "opaque-managed-handle",
});

describe("CodexRuntimeManager facade", () => {
  test("routes all sources through one opaque-handle DTO without path leakage", async () => {
    const managed = {
      async install() { return details; },
      async resolveActive() { return details; },
      inspect(handle: string) { return handle === details.handle ? details : null; },
      acquireLease(handle: string) { return handle === details.handle ? { generation: 1, release() {} } : null; },
      async revalidate(handle: string) { return handle === details.handle; },
      internalLaunchTarget(handle: string) { return handle === details.handle ? "/private/managed/bin/codex-app-server" : null; },
    };
    const external = {
      async resolveExternal() { return { ...details, source: "configured" as const, kind: "full_cli" as const, handle: "opaque-managed-handle" }; },
      inspect() { return null; },
      async revalidate() { return false; },
      internalLaunchTarget(handle: string) { return handle === "opaque-managed-handle" ? "/private/external/codex" : null; },
    };
    const facade = new CodexRuntimeManager(external as never, managed as never);
    const externalResolved = await facade.resolveExternal();
    const resolved = await facade.resolveActiveManaged();
    expect(facade.inspect(resolved.handle!)).toMatchObject({ ...details, handle: resolved.handle });
    expect(facade.acquire(resolved.handle!)?.generation).toBe(1);
    expect(facade.inspect(externalResolved.handle!)?.source).toBe("configured");
    expect(externalResolved.handle).not.toBe(resolved.handle);
    expect("internalLaunchSpec" in facade).toBeFalse();
    expect(Object.keys(facade)).toEqual([]);
    expect(resolveCodexRuntimeLaunchSpecForSupervisor(facade, externalResolved.handle!)).toEqual({ command: "/private/external/codex", argv: ["app-server", "--listen", "stdio://"], pathEntries: [] });
    expect(resolveCodexRuntimeLaunchSpecForSupervisor(facade, resolved.handle!)).toEqual({ command: "/private/managed/bin/codex-app-server", argv: ["--listen", "stdio://"], pathEntries: ["/private/managed/codex-path"] });
    const provider = createCodexRuntimeProviderForSupervisor(facade, {
      resolveRuntimeHandleForGeneration: (generation) => generation === 9 ? resolved.handle! : null,
    });
    expect((await provider.acquire(9)).launch).toEqual({
      executablePath: "/private/managed/bin/codex-app-server",
      args: ["--listen", "stdio://"],
      pathEntries: ["/private/managed/codex-path"],
      runtimeGeneration: 9,
    });
    await expect(provider.acquire(10)).rejects.toThrow("codex_runtime_generation_unavailable");
    await facade.resolveExternal();
    expect(facade.acquire(resolved.handle!)?.generation).toBe(1);
    const reResolved = await facade.resolveActiveManaged();
    await facade.resolveExternal();
    expect(facade.acquire(reResolved.handle!)?.generation).toBe(1);
    expect(await facade.revalidate(resolved.handle!)).toBeTrue();
    expect(JSON.stringify(resolved)).not.toContain("/private/");
    expect(JSON.stringify(facade.inspect(resolved.handle!))).not.toContain("codex-app-server");
  });

  test("accepts only the reviewed artifact, preserves the exact abort signal, and projects bounded provenance", async () => {
    let observedSignal: AbortSignal | undefined;
    const states: unknown[] = [];
    let installs = 0;
    const managed = managedSource({
      install: async (options?: { signal?: AbortSignal; onState?: (state: unknown) => void }) => {
        installs += 1;
        observedSignal = options?.signal;
        options?.onState?.({ phase: "resolving", receivedBytes: 0, totalBytes: 128, canCancel: true });
        return { ...details, executableFingerprint: "runtime-fingerprint", handle: "source-managed-handle" };
      },
    });
    const facade = new CodexRuntimeManager(externalSource({ state: "unavailable" }), managed as never);
    const adapter = createCodexRuntimeControllerAdapter(facade);
    const abort = new AbortController();
    const installed = await adapter.install({ artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF, signal: abort.signal, onState: (state) => { states.push(state); } });
    expect(observedSignal).toBe(abort.signal);
    expect(installed).toEqual({ state: "ready", fingerprint: expect.stringMatching(/^runtime-id-/), handle: expect.stringMatching(/^runtime-/), source: "managed", version: "0.139.0" });
    expect(JSON.stringify(installed)).not.toContain("source-managed-handle");
    expect(JSON.stringify(installed)).not.toMatch(/private|path|url|source-managed-handle/i);
    expect(states).toEqual([{ phase: "resolving", receivedBytes: 0, totalBytes: 128, canCancel: true }]);
    await expect(adapter.install({ artifactRef: "reviewed-codex-runtime-artifact", signal: abort.signal })).rejects.toThrow("codex_runtime_artifact_unapproved");
    expect(installs).toBe(1);
  });

  test("resolves preferred runtime offline as external, then active managed, without installing", async () => {
    for (const choice of ["external", "managed"] as const) {
      let installs = 0;
      const external = externalSource(choice === "external" ? { ...details, source: "configured", kind: "full_cli", handle: "external-source" } : { state: "unavailable" });
      const managed = managedSource({
        install: async () => { installs += 1; return details; },
        resolveActive: async () => choice === "managed" ? { ...details, handle: "active-source" } : { state: "unavailable", checkedAt: 1 },
      });
      const resolved = await new CodexRuntimeManager(external as never, managed as never).resolvePreferred();
      expect(resolved.source).toBe(choice === "external" ? "configured" : "managed");
      expect(installs).toBe(0);
    }
  });

  test("threads one inspection abort signal through external and active-managed resolution", async () => {
    let externalSignal: AbortSignal | undefined;
    let activeSignal: AbortSignal | undefined;
    const external = {
      async resolveExternal(options?: { readonly signal?: AbortSignal }) {
        externalSignal = options?.signal;
        return { state: "unavailable" as const, code: "CODEX_RUNTIME_NOT_FOUND" as const, checkedAt: 1 };
      },
      inspect() { return null; },
      async revalidate() { return false; },
      internalLaunchTarget() { return null; },
    };
    const managed = managedSource({
      resolveActive: async (options?: { readonly signal?: AbortSignal }) => {
        activeSignal = options?.signal;
        return { state: "unavailable" as const, code: "CODEX_RUNTIME_NOT_FOUND" as const, checkedAt: 1 };
      },
    });
    const signal = new AbortController().signal;
    await createCodexRuntimeControllerAdapter(new CodexRuntimeManager(external as never, managed as never)).inspect({ signal });
    expect(externalSignal).toBe(signal);
    expect(activeSignal).toBe(signal);
  });

  test("keeps a usable limited external runtime ahead of managed fallback and projects it as product-ready", async () => {
    let activeResolutions = 0;
    const external = externalSource({
      ...details, state: "limited", source: "configured", kind: "full_cli", handle: "limited-external-source", executableFingerprint: "limited-fingerprint",
    });
    const managed = managedSource({
      resolveActive: async () => { activeResolutions += 1; return details; },
    });
    const facade = new CodexRuntimeManager(external as never, managed as never);
    const preferred = await facade.resolvePreferred();
    expect(preferred.source).toBe("configured");
    expect(activeResolutions).toBe(0);
    expect(await createCodexRuntimeControllerAdapter(facade).inspect()).toEqual({
      state: "ready", fingerprint: expect.stringMatching(/^runtime-id-/), handle: expect.stringMatching(/^runtime-/), source: "external", version: "0.139.0",
    });
  });

  test("retains validated limited feature gates with bounded provenance but no path metadata", async () => {
    const features = {
      stableConversation: true,
      explicitSteer: false,
      codexApprovals: false,
      requestUserInput: false,
      collaborationMode: false,
    };
    const facade = new CodexRuntimeManager(externalSource({
      ...details,
      state: "limited",
      source: "configured",
      kind: "full_cli",
      handle: "limited-source-handle",
      executableFingerprint: "limited-fingerprint",
      compatibility: "limited",
      features,
    }) as never, managedSource() as never);
    const projection = await createCodexRuntimeControllerAdapter(facade).inspect();
    expect(projection).toMatchObject({ state: "ready", compatibility: "limited", features });
    expect(projection).toMatchObject({ source: "external", version: "0.139.0" });
    expect(JSON.stringify(projection)).not.toMatch(/configured|source-handle|private|path/i);
  });

  test("projects bounded provenance for an incompatible external runtime", async () => {
    const facade = new CodexRuntimeManager(externalSource({
      ...details,
      state: "incompatible",
      source: "path",
      kind: "full_cli",
      version: "0.146.0-alpha.3.1",
      handle: "incompatible-source-handle",
      executableFingerprint: "incompatible-fingerprint",
      compatibilityDiagnostics: [{
        feature: "core",
        reason: "changed_field_shape",
      }],
    }) as never, managedSource({
      resolveActive: async () => ({
        state: "unavailable",
        code: "CODEX_RUNTIME_NOT_FOUND",
        checkedAt: 1,
      }),
    }) as never);
    const projection = await createCodexRuntimeControllerAdapter(facade).inspect();
    expect(projection).toEqual({
      state: "incompatible",
      source: "external",
      version: "0.146.0-alpha.3.1",
      compatibilityDiagnostics: [{
        feature: "core",
        reason: "changed_field_shape",
      }],
    });
    expect(JSON.stringify(projection)).not.toMatch(/source-handle|fingerprint|private|path/i);
  });

  test("requires exact opaque handle and fingerprint for activation revalidation", async () => {
    let valid = true;
    const managed = managedSource({ revalidate: async () => valid });
    const facade = new CodexRuntimeManager(externalSource({ state: "unavailable" }) as never, managed as never);
    const adapter = createCodexRuntimeControllerAdapter(facade);
    const inspected = await adapter.inspect();
    if (!inspected.handle || !inspected.fingerprint) throw new Error("missing controller handle");
    expect(await adapter.revalidateForActivation("unknown-runtime", inspected.fingerprint)).toBeFalse();
    expect(await adapter.revalidateForActivation(inspected.handle, "tampered-fingerprint")).toBeFalse();
    valid = false;
    expect(await adapter.revalidateForActivation(inspected.handle, inspected.fingerprint)).toBeFalse();
    valid = true;
    expect(await adapter.revalidateForActivation(inspected.handle, inspected.fingerprint)).toBeTrue();
  });

  test("hashes the full runtime identity so stable schema alone cannot reuse a product generation", async () => {
    let candidate: Record<string, unknown> = {
      ...details, source: "configured", kind: "full_cli", handle: "source-runtime", executableFingerprint: "executable-a", stableSchemaFingerprint: "same-schema",
    };
    const external = {
      async resolveExternal() { return candidate; },
      inspect() { return null; },
      async revalidate() { return true; },
      internalLaunchTarget() { return null; },
    };
    const adapter = createCodexRuntimeControllerAdapter(new CodexRuntimeManager(external as never, managedSource() as never));
    const first = await adapter.inspect();
    candidate = { ...candidate, executableFingerprint: "executable-b" };
    const changedExecutable = await adapter.inspect();
    candidate = { ...candidate, version: "different-reviewed-build" };
    const changedVersion = await adapter.inspect();
    expect(first).toMatchObject({ state: "ready", handle: expect.stringMatching(/^runtime-/) });
    expect(changedExecutable.fingerprint).not.toBe(first.fingerprint);
    expect(changedVersion.fingerprint).not.toBe(changedExecutable.fingerprint);
    expect(JSON.stringify([first, changedExecutable, changedVersion])).not.toContain("executable-");
    expect(JSON.stringify([first, changedExecutable, changedVersion])).not.toContain("same-schema");
  });

  test("projects absent only when every source is genuinely missing, and fails usable-but-incomplete or damaged results", async () => {
    const missing = () => ({ state: "unavailable", code: "CODEX_RUNTIME_NOT_FOUND", checkedAt: 1 });
    const absent = createCodexRuntimeControllerAdapter(new CodexRuntimeManager(
      externalSource(missing()) as never,
      managedSource({ resolveActive: async () => missing() }) as never,
    ));
    expect(await absent.inspect()).toEqual({ state: "absent" });
    const damaged = createCodexRuntimeControllerAdapter(new CodexRuntimeManager(
      externalSource({ state: "unavailable", code: "CODEX_RUNTIME_INSTALL_FAILED", checkedAt: 1 }) as never,
      managedSource({ resolveActive: async () => missing() }) as never,
    ));
    expect(await damaged.inspect()).toEqual({ state: "failed" });
    const incomplete = createCodexRuntimeControllerAdapter(new CodexRuntimeManager(
      externalSource({ ...details, source: "configured", kind: "full_cli", handle: "source-incomplete" }) as never,
      managedSource() as never,
    ));
    expect(await incomplete.inspect()).toEqual({ state: "failed" });
  });

  test("acquires a managed lease before asynchronous revalidation and releases it on every failed launch path", async () => {
    const events: string[] = [];
    let valid = false;
    let launchAvailable = false;
    const managed = managedSource({
      acquireLease: () => { events.push("acquire"); return { generation: 7, release: () => { events.push("release"); } }; },
      revalidate: async () => { events.push("revalidate"); return valid; },
      internalLaunchTarget: () => launchAvailable ? "/private/managed/bin/codex-app-server" : null,
    });
    const facade = new CodexRuntimeManager(externalSource({ state: "unavailable" }) as never, managed as never);
    const resolved = await facade.resolveActiveManaged();
    const provider = createCodexRuntimeProviderForSupervisor(facade, {
      resolveRuntimeHandleForGeneration: () => resolved.handle ?? null,
    });
    await expect(provider.acquire(7)).rejects.toThrow("codex_runtime_generation_unavailable");
    expect(events).toEqual(["acquire", "revalidate", "release"]);
    valid = true;
    await expect(provider.acquire(7)).rejects.toThrow("codex_runtime_generation_unavailable");
    expect(events).toEqual(["acquire", "revalidate", "release", "acquire", "revalidate", "release"]);
    launchAvailable = true;
    const acquired = await provider.acquire(7);
    await acquired.lease.release();
    expect(events).toEqual([
      "acquire", "revalidate", "release",
      "acquire", "revalidate", "release",
      "acquire", "revalidate", "release",
    ]);
  });
});

function managedSource(overrides: Record<string, unknown> = {}) {
  return {
    async install() { return details; },
    async resolveActive() { return { ...details, executableFingerprint: "runtime-fingerprint" }; },
    async rollback() { return null; },
    inspect(handle: string) { return handle === details.handle ? details : null; },
    acquireLease(handle: string) { return handle === details.handle ? { generation: 1, release() {} } : null; },
    async revalidate(handle: string) { return handle === details.handle; },
    internalLaunchTarget(handle: string) { return handle === details.handle ? "/private/managed/bin/codex-app-server" : null; },
    ...overrides,
  };
}

function externalSource(result: Record<string, unknown>) {
  return {
    async resolveExternal() { return result; },
    inspect() { return null; },
    async revalidate() { return false; },
    internalLaunchTarget() { return null; },
  };
}
