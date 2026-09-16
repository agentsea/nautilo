import { describe, expect, test } from "bun:test";
import { ComputerUseHostRuntime } from "../../electron/computer-use-host-runtime/runtime.ts";
import type {
  ComputerUseHostRecord,
  ComputerUseHostRelease,
  ComputerUseHostRuntimeOptions,
  ComputerUseHostStagedArtifact,
} from "../../electron/computer-use-host-runtime/contracts.ts";

const member = {
  path: "bin/nautilo-computer-use-host",
  bytes: 7,
  sha256: "a".repeat(64),
  executable: true as const,
};

function release(id: string, digest = "b".repeat(64), version = "1.0.0"): ComputerUseHostRelease {
  return {
    schemaVersion: 1,
    releaseId: id,
    version,
    pointerUrl: "https://releases.nautilo.example/computer-use-host/latest.json",
    archive: { format: "tar.gz", url: `https://releases.nautilo.example/computer-use-host/${id}.tar.gz`, bytes: 11, sha256: digest },
    entrypoint: member.path,
    members: [member],
    architectures: ["arm64", "x64"],
    signature: { teamId: "ABCD123456", designatedRequirement: "identifier com.nautilo.computer-use-host", notarized: true },
  };
}

function fixture(options: {
  readonly remote?: ComputerUseHostRelease;
  readonly invalidRemoteArchive?: boolean;
  readonly healthy?: boolean;
  readonly unhealthyReleaseIds?: readonly string[];
} = {}) {
  const bundled = release("bundled");
  let remote = options.remote;
  const releases = new Map<string, ComputerUseHostRelease>([[bundled.archive.sha256, bundled]]);
  const active: Partial<Record<"active" | "rollback", ComputerUseHostRecord>> = {};
  let rootSafe = true;
  const invalidInstalled = new Set<string>();
  const stage = (candidate: ComputerUseHostRelease, invalid = false): ComputerUseHostStagedArtifact => ({
    archiveBytes: invalid ? candidate.archive.bytes + 1 : candidate.archive.bytes,
    archiveSha256: candidate.archive.sha256,
    root: `/private/nautilo/computer-use-host/${candidate.releaseId}`,
    members: [member],
  });
  const receivedPointers: string[] = [];
  const config: ComputerUseHostRuntimeOptions = {
    officialPointerUrl: bundled.pointerUrl,
    bundledRelease: bundled,
    expectedArchitectures: ["arm64", "x64"],
    releaseAuthority: {
      async resolveOfficialRelease(pointer) {
        receivedPointers.push(pointer);
        if (!remote) throw new Error("offline");
        releases.set(remote.archive.sha256, remote);
        return remote;
      },
    },
    storage: {
      async recoverStaging() {},
      async ensurePrivateRoot() { return rootSafe; },
      async readRecord(kind) { return active[kind] ?? null; },
      async findRelease(record) { return releases.get(record.archiveSha256) ?? null; },
      async openInstalled(candidate) { if (invalidInstalled.has(candidate.releaseId)) throw new Error("installed release rejected"); return stage(candidate); },
      async stageBundled(candidate) { return stage(candidate); },
      async downloadAndStage(candidate) { return stage(candidate, options.invalidRemoteArchive); },
      async publish(stagedArtifact, candidate) { releases.set(candidate.archive.sha256, candidate); return stagedArtifact; },
      async writeRecord(kind, record) { active[kind] = record; },
    },
    attestor: {
      async verifyMacosRelease() { return true; },
      async health(_entrypoint, candidate) {
        return options.healthy !== false && !options.unhealthyReleaseIds?.includes(candidate.releaseId);
      },
    },
  };
  return {
    config,
    active,
    receivedPointers,
    invalidInstalled,
    setRemote(value: ComputerUseHostRelease) { remote = value; },
    setRootSafe(value: boolean) { rootSafe = value; },
  };
}

describe("ComputerUseHostRuntime", () => {
  test("boots the signed bundled Host offline, atomically records it, and leases its launch", async () => {
    const f = fixture();
    const runtime = new ComputerUseHostRuntime(f.config);
    expect(await runtime.bootstrap()).toMatchObject({ state: "ready", source: "bundled", generation: 1 });
    expect(f.active.active).toMatchObject({ source: "bundled", generation: 1, archiveSha256: "b".repeat(64) });
    const launch = runtime.acquireLaunch();
    expect(launch?.entrypoint).toBe("/private/nautilo/computer-use-host/bundled/bin/nautilo-computer-use-host");
    expect(runtime.leaseCount(1)).toBe(1);
    launch?.lease.release();
    expect(runtime.leaseCount(1)).toBe(0);
  });

  test("uses only the compiled official pointer and leaves known-good active after a bad update", async () => {
    const f = fixture({ remote: release("remote", "c".repeat(64), "1.0.1"), invalidRemoteArchive: true });
    const runtime = new ComputerUseHostRuntime(f.config);
    await runtime.bootstrap();
    expect(await runtime.updateFromOfficialPointer()).toEqual({ state: "unavailable", code: "host_members_invalid" });
    expect(f.receivedPointers).toEqual(["https://releases.nautilo.example/computer-use-host/latest.json"]);
    expect(runtime.snapshot()).toMatchObject({ state: "ready", source: "bundled", generation: 1 });
    expect(f.active.rollback).toBeUndefined();
  });

  test("recovers the offline last-known-good record after a successful update", async () => {
    const f = fixture({ remote: release("remote", "c".repeat(64), "1.0.1") });
    const runtime = new ComputerUseHostRuntime(f.config);
    await runtime.bootstrap();
    expect(await runtime.updateFromOfficialPointer()).toMatchObject({ state: "ready", source: "managed", generation: 2 });
    const restarted = new ComputerUseHostRuntime({
      officialPointerUrl: f.config.officialPointerUrl,
      bundledRelease: f.config.bundledRelease,
      expectedArchitectures: f.config.expectedArchitectures,
      storage: f.config.storage,
      attestor: f.config.attestor,
    });
    expect(await restarted.bootstrap()).toMatchObject({ state: "ready", source: "managed", generation: 2 });
  });

  test("a newer app-sealed Host supersedes an older managed active record and retains it as rollback", async () => {
    const f = fixture({ remote: release("managed-old", "c".repeat(64), "1.0.1") });
    const runtime = new ComputerUseHostRuntime(f.config);
    await runtime.bootstrap();
    expect(await runtime.updateFromOfficialPointer()).toMatchObject({
      state: "ready",
      source: "managed",
      generation: 2,
      release: { releaseId: "managed-old", version: "1.0.1" },
    });

    const restarted = new ComputerUseHostRuntime({
      ...f.config,
      bundledRelease: release("bundled-new", "d".repeat(64), "1.0.2"),
    });
    expect(await restarted.bootstrap()).toMatchObject({
      state: "ready",
      source: "bundled",
      generation: 3,
      release: { releaseId: "bundled-new", version: "1.0.2" },
    });
    expect(f.active.active).toMatchObject({ releaseId: "bundled-new", source: "bundled", generation: 3 });
    expect(f.active.rollback).toMatchObject({ releaseId: "managed-old", source: "managed", generation: 2 });
    expect(await restarted.updateFromOfficialPointer()).toEqual({ state: "unavailable", code: "host_release_invalid" });
    expect(restarted.snapshot()).toMatchObject({
      state: "ready",
      source: "bundled",
      generation: 3,
      release: { releaseId: "bundled-new", version: "1.0.2" },
    });
  });

  test("retains the older healthy managed Host when a newer app-sealed Host fails health", async () => {
    const f = fixture({
      remote: release("managed-old", "c".repeat(64), "1.0.1"),
      unhealthyReleaseIds: ["bundled-new"],
    });
    const runtime = new ComputerUseHostRuntime(f.config);
    await runtime.bootstrap();
    await runtime.updateFromOfficialPointer();

    const restarted = new ComputerUseHostRuntime({
      ...f.config,
      bundledRelease: release("bundled-new", "d".repeat(64), "1.0.2"),
      releaseAuthority: undefined,
    });
    expect(await restarted.bootstrap()).toMatchObject({
      state: "ready",
      source: "managed",
      generation: 2,
      release: { releaseId: "managed-old", version: "1.0.1" },
    });
    expect(f.active.active).toMatchObject({ releaseId: "managed-old", source: "managed", generation: 2 });
  });

  test("allows the official managed form to replace the same-version bundled baseline exactly once", async () => {
    const f = fixture({ remote: release("official", "c".repeat(64), "1.0.0") });
    const runtime = new ComputerUseHostRuntime(f.config);
    expect(await runtime.bootstrap()).toMatchObject({ state: "ready", source: "bundled", generation: 1 });
    expect(await runtime.updateFromOfficialPointer()).toMatchObject({
      state: "ready",
      source: "managed",
      generation: 2,
      release: { releaseId: "official", version: "1.0.0", archive: { sha256: "c".repeat(64) } },
    });

    f.setRemote(release("substitution", "d".repeat(64), "1.0.0+other"));
    expect(await runtime.updateFromOfficialPointer()).toEqual({ state: "unavailable", code: "host_release_invalid" });
    expect(runtime.snapshot()).toMatchObject({
      state: "ready",
      source: "managed",
      generation: 2,
      release: { releaseId: "official", archive: { sha256: "c".repeat(64) } },
    });
  });

  test("rejects a pointer-label downgrade against the durable floor", async () => {
    const downgrade = fixture({ remote: release("remote", "c".repeat(64), "0.9.9") });
    const runtime = new ComputerUseHostRuntime(downgrade.config); await runtime.bootstrap();
    expect(await runtime.updateFromOfficialPointer()).toEqual({ state: "unavailable", code: "host_release_invalid" });
  });

  test("promotes a verified rollback with a fresh generation when the newer active bytes fail admission", async () => {
    const f = fixture({ remote: release("remote", "c".repeat(64), "1.0.1") });
    const runtime = new ComputerUseHostRuntime(f.config); await runtime.bootstrap(); await runtime.updateFromOfficialPointer();
    f.invalidInstalled.add("remote");
    const restarted = new ComputerUseHostRuntime({
      officialPointerUrl: f.config.officialPointerUrl,
      bundledRelease: f.config.bundledRelease,
      storage: f.config.storage,
      attestor: f.config.attestor,
      expectedArchitectures: f.config.expectedArchitectures,
    });
    expect(await restarted.bootstrap()).toMatchObject({ state: "ready", source: "rollback", generation: 3 });
    expect(f.active.active).toMatchObject({ releaseId: "bundled", generation: 3 });
  });

  test("fails closed before staging when the owned root is not exact 0700 private storage", async () => {
    const f = fixture();
    f.setRootSafe(false);
    expect(await new ComputerUseHostRuntime(f.config).bootstrap()).toEqual({ state: "unavailable", code: "host_root_unsafe" });
  });
});
