import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { lstat as nodeLstat, mkdir as nodeMkdir, mkdtemp, open as nodeOpen, realpath as nodeRealpath, readdir as nodeReaddir, rename as nodeRename, rm as nodeRm, symlink as nodeSymlink, writeFile as nodeWriteFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { CodexBindingRegistry, CodexProfileHomeRegistry, CodexProfileSupervisor, CodexRelayHostPort, CodexServiceDirectory, CodexWorkspaceReceiptAuthority, InMemoryCodexBindingStore, sameReservationAuthority, toRelayWorkspaceReceipt, type AppServerClient, type AppServerClientFactory, type BindingRequest, type ChildStdio, type CodexBindingStore, type CurrentFolderSnapshot, type HostClock, type HostFilesystem, type HostFileStat, type HostTimer, type HostTimerHandle, type ManagedChildProcess, type OpaqueHandle, type ProcessHost, type RuntimeLease, type RuntimeProvider, type SupervisorRequest } from "../../src/internal";
import { nodeProfileHomeRemovalFilesystem } from "../../src/node";

const handle = (value: string): OpaqueHandle => value as OpaqueHandle;
const removalGate = (assertDrained: (child: import("../../src/internal").ChildIdentity) => void | Promise<void> = () => undefined) => ({
  assertDrained: async (child: import("../../src/internal").ChildIdentity) => { await assertDrained(child); },
  assertDrainedNow: (_child: import("../../src/internal").ChildIdentity) => undefined,
  commitDestruction: () => undefined,
});

describe("workspace receipt authority", () => {
  test("binds the complete live v8 scope, uses two reads, and translates without a path", async () => {
    const fs = new FakeFilesystem(); fs.dir("/workspace");
    const source = new Snapshots([snap()]);
    const authority = new CodexWorkspaceReceiptAuthority({ snapshots: source, filesystem: fs, clock: new Clock(), newHandle: () => handle("receipt"), hmacKey: "persistent-host-key" });
    const receipt = await authority.mint();
    expect(toRelayWorkspaceReceipt(receipt)).toMatchObject({ workspaceRef: "receipt", revision: 4, issuedAt: "1970-01-01T00:00:00.000Z", expiresAt: "1970-01-02T00:00:00.000Z" });
    expect("selectedPath" in receipt).toBe(false);
    source.push(snap({ relaySessionId: "new-session" }));
    await rejects(authority.resolve(receipt), "WORKSPACE_STALE");
  });
  test("rejects an alias swapped between the pre- and post-resolution lstats", async () => {
    const fs = new FakeFilesystem(); fs.dir("/workspace"); fs.swapAliasOnSecondLstat = true;
    const authority = new CodexWorkspaceReceiptAuthority({ snapshots: new Snapshots([snap()]), filesystem: fs, clock: new Clock(), hmacKey: "key" });
    await rejects(authority.mint(), "WORKSPACE_STALE");
  });
});

describe("profile homes", () => {
  test("never chmods a pre-existing symlink and creates marked owner-only homes", async () => {
    const trap = new FakeFilesystem(); trap.dir("/"); trap.symlink("/profiles", "/elsewhere");
    const registry = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: trap, currentUid: () => 501 });
    await rejects(registry.ensure(profile("p")), "PROFILE_HOME_INVALID");
    expect(trap.chmods).toEqual([]);

    const fs = new FakeFilesystem(); fs.dir("/");
    const safe = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: fs, currentUid: () => 501 });
    const home = await safe.ensure(profile("p"));
    const path = await safe.resolveForLaunch(home); expect(path).toStartWith("/profiles/");
    fs.mutate(path, { uid: 999 }); await rejects(safe.resolveForLaunch(home), "PROFILE_HOME_INVALID");
    fs.mutate(path, { uid: 501, mode: 0o755 }); await rejects(safe.resolveForLaunch(home), "PROFILE_HOME_INVALID");
    fs.mutate(path, { mode: 0o700, ino: 999 }); await rejects(safe.resolveForLaunch(home), "PROFILE_HOME_INVALID");
    const stableFs = new FakeFilesystem(); stableFs.dir("/"); const stable = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: stableFs, currentUid: () => 501 });
    const one = await stable.ensure(profile("stable")); const stablePath = await stable.resolveForLaunch(one); const two = await stable.ensure({ ...profile("stable"), profileGeneration: 2 });
    expect(stablePath).toBe(await stable.resolveForLaunch(two));
  });
  test("does not mutate through an intermediate trusted-parent symlink", async () => {
    const fs = new FakeFilesystem(); fs.dir("/"); fs.symlink("/trusted", "/elsewhere");
    const registry = new CodexProfileHomeRegistry({ rootPath: "/trusted/profiles", trustedParentPath: "/trusted", filesystem: fs, currentUid: () => 501 });
    await rejects(registry.ensure(profile("p")), "PROFILE_HOME_INVALID"); expect(fs.mkdirs).toEqual([]);
  });

  test("removes only an exact drained marker-owned profile home", async () => {
    const fs = new FakeFilesystem(); fs.dir("/");
    const removals: Array<import("../../src/internal").ProfileHomeRemovalSpec> = []; let drained = 0;
    const registry = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: fs, currentUid: () => 501, removalFilesystem: { removeOwnedProfileHome: async (input) => { removals.push(input); input.assertAuthorizedNow(); input.commitDestruction(); } } });
    const home = await registry.ensure(profile("remove"));
    const child = { profile: home.identity, accountGeneration: 2, runtimeGeneration: 7, childGeneration: 1 };
    const context = { drainedChild: child, serviceDirectoryPath: "/service", runtimeCanonicalPaths: ["/runtime/codex"] };
    await registry.removeAfterDrain(home, context, removalGate(async (identity) => { expect(identity).toEqual(child); drained += 1; }));
    expect(drained).toBe(2); expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ containmentRoot: "/profiles", expectedIdentity: home.identity, markerName: ".nautilo-codex-profile.json", expectedMarker: { schemaVersion: 1, actorId: "human", profileGeneration: 1 } });
    expect(removals[0]?.path).toStartWith("/profiles/");

    const other = await registry.ensure(profile("other"));
    const otherContext = { ...context, drainedChild: { ...child, profile: other.identity } };
    await rejects(registry.removeAfterDrain({ ...other, identityFingerprint: "wrong" }, otherContext, removalGate()), "PROFILE_HOME_INVALID");
    await rejects(registry.removeAfterDrain(other, { ...otherContext, drainedChild: child }, removalGate()), "PROFILE_HOME_INVALID");
    const otherPath = await registry.resolveForLaunch(other);
    await rejects(registry.removeAfterDrain(other, { ...otherContext, serviceDirectoryPath: otherPath }, removalGate()), "PROFILE_HOME_INVALID");
    await rejects(registry.removeAfterDrain(other, { ...otherContext, runtimeCanonicalPaths: [otherPath] }, removalGate()), "PROFILE_HOME_INVALID");
    await rejectsFailure(registry.removeAfterDrain(other, otherContext, removalGate((candidate) => { if (candidate.childGeneration < 2) throw new Error("newer child exists"); })));
    fs.symlink("/profiles", "/elsewhere");
    await rejects(registry.removeAfterDrain(other, otherContext, removalGate()), "PROFILE_HOME_INVALID");
    expect(removals).toHaveLength(1);
  });

  test("keeps a home registered when the final deletion adapter detects an identity race", async () => {
    const fs = new FakeFilesystem(); fs.dir("/"); let raced = true; let calls = 0;
    const registry = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: fs, currentUid: () => 501, removalFilesystem: { removeOwnedProfileHome: async (input) => { calls += 1; if (raced) throw new Error("final identity mismatch"); input.assertAuthorizedNow(); input.commitDestruction(); } } });
    const home = await registry.ensure(profile("race")); const child = { profile: home.identity, accountGeneration: 2, runtimeGeneration: 7, childGeneration: 4 };
    const context = { drainedChild: child, serviceDirectoryPath: "/service", runtimeCanonicalPaths: ["/runtime/codex"] };
    await rejectsFailure(registry.removeAfterDrain(home, context, removalGate(async (candidate) => { expect(candidate).toEqual(child); })));
    raced = false;
    await registry.removeAfterDrain(home, context, removalGate());
    expect(calls).toBe(2);
  });
  test("rejects a custom deletion adapter that returns without an exact commit", async () => {
    const fs = new FakeFilesystem(); fs.dir("/"); let calls = 0;
    const registry = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: fs, currentUid: () => 501, removalFilesystem: { removeOwnedProfileHome: async () => { calls += 1; } } });
    const home = await registry.ensure(profile("uncommitted")); const child = { profile: home.identity, accountGeneration: 2, runtimeGeneration: 7, childGeneration: 1 };
    await rejects(registry.removeAfterDrain(home, { drainedChild: child, serviceDirectoryPath: "/service", runtimeCanonicalPaths: ["/runtime"] }, removalGate()), "PROFILE_HOME_INVALID");
    expect(calls).toBe(1); expect(await registry.resolveForLaunch(home)).toContain("/profiles/");
  });
  test("revokes a delayed deletion adapter before it can delete or unregister", async () => {
    const fs = new FakeFilesystem(); fs.dir("/"); const delayed = deferred<void>(); let authorized = true; let called = 0;
    const registry = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: fs, currentUid: () => 501, removalFilesystem: { removeOwnedProfileHome: async (input) => { await delayed.promise; await input.assertAuthorized(); called += 1; } } });
    const home = await registry.ensure(profile("revoked-adapter")); const child = { profile: home.identity, accountGeneration: 2, runtimeGeneration: 7, childGeneration: 1 }; const context = { drainedChild: child, serviceDirectoryPath: "/service", runtimeCanonicalPaths: ["/runtime"] };
    const removing = registry.removeAfterDrain(home, context, removalGate(async () => { if (!authorized) throw new Error("revoked"); })); authorized = false; delayed.resolve(); await rejectsFailure(removing); expect(called).toBe(0); expect(await registry.resolveForLaunch(home)).toContain("/profiles/");
  });
});

describe("node profile-home removal adapter", () => {
  test("removes only a current exact marker-owned directory and refuses marker, inode, and symlink races", async () => {
    const root = await nodeRealpath(await mkdtemp(join(tmpdir(), "nautilo-removal-")));
    const identity = profile("node-remove");
    const create = async (name: string) => {
      const path = join(root, name); await nodeMkdir(path, { mode: 0o700 }); const stat = await nodeLstat(path);
      const fingerprint = createHash("sha256").update(`${stat.dev}:${stat.ino}`).digest("hex");
      await nodeWriteFile(join(path, ".nautilo-codex-profile.json"), JSON.stringify({ schemaVersion: 1, actorId: identity.actorId, profileHandle: identity.profileHandle, profileGeneration: identity.profileGeneration, homeIdentityFingerprint: fingerprint }), { mode: 0o600 });
      return { path, spec: { path, containmentRoot: root, expectedDevice: Number(stat.dev), expectedInode: Number(stat.ino), expectedIdentity: identity, expectedIdentityFingerprint: fingerprint, markerName: ".nautilo-codex-profile.json" as const, expectedMarker: { schemaVersion: 1 as const, actorId: identity.actorId, profileHandle: identity.profileHandle, profileGeneration: identity.profileGeneration, homeIdentityFingerprint: fingerprint }, assertAuthorized: async () => undefined, assertAuthorizedNow: () => undefined, commitDestruction: () => undefined } };
    };
    try {
      const valid = await create("valid"); await nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(valid.spec); await rejectsFailure(nodeLstat(valid.path));
      const marker = await create("marker"); await nodeWriteFile(join(marker.path, ".nautilo-codex-profile.json"), "{}", { mode: 0o600 }); await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(marker.spec), "PROFILE_HOME_INVALID");
      // Allocate the replacement while the original inode is still live. A
      // remove-then-mkdir sequence may legally reuse the same inode on ext4,
      // which made this identity-race fixture nondeterministic in Linux CI.
      const inode = await create("inode"); const replacementPath = join(root, "inode-replacement"); await nodeMkdir(replacementPath, { mode: 0o700 }); await nodeWriteFile(join(replacementPath, ".nautilo-codex-profile.json"), JSON.stringify(inode.spec.expectedMarker), { mode: 0o600 }); const replacementInode = Number((await nodeLstat(replacementPath)).ino); expect(replacementInode).not.toBe(inode.spec.expectedInode); await nodeRm(inode.path, { recursive: true }); await nodeRename(replacementPath, inode.path); await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(inode.spec), "PROFILE_HOME_INVALID"); expect(Number((await nodeLstat(inode.path)).ino)).toBe(replacementInode);
      const link = await create("link"); await nodeRm(link.path, { recursive: true }); await nodeSymlink(root, link.path); await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(link.spec), "PROFILE_HOME_INVALID");
    } finally { await nodeRm(root, { recursive: true, force: true }); }
  });
  test("enforces exact N/N+1 tree bounds and restores an unsafe quarantine without overwriting a target", async () => {
    const root = await nodeRealpath(await mkdtemp(join(tmpdir(), "nautilo-removal-bounds-")));
    const identity = profile("node-bounds");
    const create = async (name: string) => {
      const path = join(root, name); await nodeMkdir(path, { mode: 0o700 }); const stat = await nodeLstat(path);
      const fingerprint = createHash("sha256").update(`${stat.dev}:${stat.ino}`).digest("hex");
      await nodeWriteFile(join(path, ".nautilo-codex-profile.json"), JSON.stringify({ schemaVersion: 1, actorId: identity.actorId, profileHandle: identity.profileHandle, profileGeneration: identity.profileGeneration, homeIdentityFingerprint: fingerprint }), { mode: 0o600 });
      return { path, spec: { path, containmentRoot: root, expectedDevice: Number(stat.dev), expectedInode: Number(stat.ino), expectedIdentity: identity, expectedIdentityFingerprint: fingerprint, markerName: ".nautilo-codex-profile.json" as const, expectedMarker: { schemaVersion: 1 as const, actorId: identity.actorId, profileHandle: identity.profileHandle, profileGeneration: identity.profileGeneration, homeIdentityFingerprint: fingerprint }, assertAuthorized: async () => undefined, assertAuthorizedNow: () => undefined, commitDestruction: () => undefined } };
    };
    const addFiles = async (path: string, count: number) => { for (let index = 0; index < count; index += 1) await nodeWriteFile(join(path, `f-${index}`), ""); };
    try {
      // Marker plus 1,023 files is the 1,024-entry limit; one more fails and
      // is restored to its original exact path rather than being deleted.
      const entriesAtLimit = await create("entries-at-limit"); await addFiles(entriesAtLimit.path, 1_023); await nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(entriesAtLimit.spec); await rejectsFailure(nodeLstat(entriesAtLimit.path));
      const entriesOver = await create("entries-over"); await addFiles(entriesOver.path, 1_024); await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(entriesOver.spec), "PROFILE_HOME_INVALID"); expect((await nodeLstat(entriesOver.path)).ino).toBe(entriesOver.spec.expectedInode);

      const depthAtLimit = await create("depth-at-limit"); let exact = depthAtLimit.path; for (let index = 0; index < 16; index += 1) { exact = join(exact, `d-${index}`); await nodeMkdir(exact); } await nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(depthAtLimit.spec); await rejectsFailure(nodeLstat(depthAtLimit.path));
      const depthOver = await create("depth-over"); exact = depthOver.path; for (let index = 0; index < 17; index += 1) { exact = join(exact, `d-${index}`); await nodeMkdir(exact); } await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(depthOver.spec), "PROFILE_HOME_INVALID"); expect((await nodeLstat(depthOver.path)).ino).toBe(depthOver.spec.expectedInode);

      const bytesAtLimit = await create("bytes-at-limit"); const markerSize = Number((await nodeLstat(join(bytesAtLimit.path, ".nautilo-codex-profile.json"))).size); const exactBytes = await nodeOpen(join(bytesAtLimit.path, "payload"), "w"); await exactBytes.truncate((64 * 1024 * 1024) - markerSize); await exactBytes.close(); await nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(bytesAtLimit.spec); await rejectsFailure(nodeLstat(bytesAtLimit.path));
      const bytesOver = await create("bytes-over"); const over = await nodeOpen(join(bytesOver.path, "payload"), "w"); await over.truncate((64 * 1024 * 1024)); await over.close(); await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(bytesOver.spec), "PROFILE_HOME_INVALID"); expect((await nodeLstat(bytesOver.path)).ino).toBe(bytesOver.spec.expectedInode);
      const special = await create("special-file"); const socket = createServer(); const shortSocketPath = join("/tmp", `n-${randomUUID()}`); await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(shortSocketPath, resolve); }); await nodeRename(shortSocketPath, join(special.path, "socket")); await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(special.spec), "PROFILE_HOME_INVALID"); await new Promise<void>((resolve) => socket.close(() => resolve())); expect((await nodeLstat(special.path)).ino).toBe(special.spec.expectedInode);

      // No unrelated sibling is ever a deletion target; restored failures do
      // not leave guessed quarantine names behind.
      expect((await nodeReaddir(root)).filter((name) => name.startsWith(".nautilo-codex-removal-"))).toEqual([]);
    } finally { await nodeRm(root, { recursive: true, force: true }); }
  });
  test("restores the exact marker after final authorization is revoked, then permits a clean retry", async () => {
    const root = await nodeRealpath(await mkdtemp(join(tmpdir(), "nautilo-removal-recover-"))); const identity = profile("node-recover"); const path = join(root, "home"); await nodeMkdir(path); const stat = await nodeLstat(path); const fingerprint = createHash("sha256").update(`${stat.dev}:${stat.ino}`).digest("hex"); const marker = { schemaVersion: 1 as const, actorId: identity.actorId, profileHandle: identity.profileHandle, profileGeneration: identity.profileGeneration, homeIdentityFingerprint: fingerprint }; await nodeWriteFile(join(path, ".nautilo-codex-profile.json"), JSON.stringify(marker)); let committed = false;
    const base = { path, containmentRoot: root, expectedDevice: Number(stat.dev), expectedInode: Number(stat.ino), expectedIdentity: identity, expectedIdentityFingerprint: fingerprint, markerName: ".nautilo-codex-profile.json" as const, expectedMarker: marker, assertAuthorized: async () => undefined };
    const revoked = { ...base, assertAuthorizedNow: () => { if (committed) throw new Error("revoked after marker"); }, commitDestruction: () => { committed = true; } };
    try {
      await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(revoked), "PROFILE_HOME_INVALID");
      expect(JSON.parse(await Bun.file(join(path, ".nautilo-codex-profile.json")).text())).toEqual(marker);
      await nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome({ ...base, assertAuthorizedNow: () => undefined, commitDestruction: () => undefined });
      await rejectsFailure(nodeLstat(path));
    } finally { await nodeRm(root, { recursive: true, force: true }); }
  });
  test("fails closed and preserves an empty replacement entry after final revalidation", async () => {
    const root = await nodeRealpath(await mkdtemp(join(tmpdir(), "nautilo-removal-entry-"))); const identity = profile("node-entry"); const path = join(root, "home"); await nodeMkdir(path); const stat = await nodeLstat(path); const fingerprint = createHash("sha256").update(`${stat.dev}:${stat.ino}`).digest("hex"); const marker = { schemaVersion: 1 as const, actorId: identity.actorId, profileHandle: identity.profileHandle, profileGeneration: identity.profileGeneration, homeIdentityFingerprint: fingerprint }; await nodeWriteFile(join(path, ".nautilo-codex-profile.json"), JSON.stringify(marker)); await nodeWriteFile(join(path, "payload"), "owned"); let authorizations = 0;
    const spec = { path, containmentRoot: root, expectedDevice: Number(stat.dev), expectedInode: Number(stat.ino), expectedIdentity: identity, expectedIdentityFingerprint: fingerprint, markerName: ".nautilo-codex-profile.json" as const, expectedMarker: marker, assertAuthorized: async () => { authorizations += 1; if (authorizations === 3) { const quarantine = (await nodeReaddir(root)).find((name) => name.startsWith(".nautilo-codex-removal-")); if (!quarantine) throw new Error("missing quarantine"); const payload = join(root, quarantine, "payload"); await nodeRm(payload); await nodeMkdir(payload); } }, assertAuthorizedNow: () => undefined, commitDestruction: () => undefined };
    try {
      await rejects(nodeProfileHomeRemovalFilesystem.removeOwnedProfileHome(spec), "PROFILE_HOME_INVALID");
      expect((await nodeLstat(join(path, "payload"))).isDirectory()).toBeTrue();
      expect(JSON.parse(await Bun.file(join(path, ".nautilo-codex-profile.json")).text())).toEqual(marker);
    } finally { await nodeRm(root, { recursive: true, force: true }); }
  });
});

describe("account-only service directory", () => {
  test("requires a private marked owner-only non-symlink cwd", async () => {
    const trap = new FakeFilesystem(); trap.dir("/"); trap.symlink("/service", "/elsewhere");
    const unsafe = new CodexServiceDirectory({ path: "/service", trustedParentPath: "/", filesystem: trap, currentUid: () => 501 });
    await rejects(unsafe.ensure(), "SUPERVISOR_UNAVAILABLE");

    const fs = new FakeFilesystem(); fs.dir("/"); const service = new CodexServiceDirectory({ path: "/service", trustedParentPath: "/", filesystem: fs, currentUid: () => 501 });
    const directory = await service.ensure(); expect(await service.resolveForLaunch(directory, ["/profiles", "/runtime"])).toBe("/service");
    await rejects(service.resolveForLaunch(directory, ["/service/nested"]), "SUPERVISOR_UNAVAILABLE");
    fs.mutate("/service", { ino: 99 }); await rejects(service.resolveForLaunch(directory, ["/profiles", "/runtime"]), "SUPERVISOR_UNAVAILABLE");
  });
});

describe("relay adapter and boundary", () => {
  test("projects an exact negotiated v8+ scope through a local opaque receipt and has no sandbox/grants imports", async () => {
    const receipt = { handle: handle("local"), actorId: "human", relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop", pairingGenerationRef: "pairing-ref", capabilityRevision: 3, revision: 4, fingerprint: "fp", issuedAt: 0, expiresAt: 10 };
    let seen: SupervisorRequest | undefined;
    const port = new CodexRelayHostPort({ ensure: async (request: SupervisorRequest) => { seen = request; return { profile: request.profile, accountGeneration: request.accountGeneration, runtimeGeneration: request.runtimeGeneration, childGeneration: 1 }; } } as unknown as CodexProfileSupervisor, { resolve: async () => ({ actorId: "human", workspace: receipt }) }, { resolve: async (requested) => requested ?? "/workspace" });
    await port.ensure({ relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop", pairingGenerationRef: "pairing-ref", selectedProtocolVersion: 9, capabilityRevision: 3, profileHandle: "p", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 7 }, { workspaceRef: "wire", revision: 4, fingerprint: "fp", issuedAt: "1970-01-01T00:00:00.000Z", expiresAt: "1970-01-01T00:00:00.010Z" });
    expect(seen?.workspace.handle).toBe(handle("local"));
    const packageText = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    expect(packageText).not.toContain("@nautilo/sandbox"); expect(packageText).not.toContain("@nautilo/desktop-filesystem-grants");
    const mainBarrel = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text();
    for (const forbidden of ["CurrentFolderSnapshot", "HostFilesystem", "AppServerClient", "CodexProfileSupervisor", "CodexWorkspaceReceiptAuthority", "RuntimeProvider", "ProcessHost", "CodexRelayHostPort"]) expect(mainBarrel).not.toContain(forbidden);
  });

  test("opens an exact callback-free scope through supervisor admission", async () => {
    const receipt = { handle: handle("local"), actorId: "human", relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop", pairingGenerationRef: "pairing-ref", capabilityRevision: 3, revision: 4, fingerprint: "fp", issuedAt: 0, expiresAt: 10 };
    let opened: BindingRequest | undefined;
    const port = new CodexRelayHostPort({
      open: async (_request: SupervisorRequest, binding: BindingRequest) => {
        opened = binding;
        return {
          bindingId: handle("binding"),
          bindingGeneration: 1,
          threadId: "thread",
          child: {
            profile: { actorId: "human", profileHandle: handle("p"), profileGeneration: 1 },
            accountGeneration: 2,
            runtimeGeneration: 7,
            childGeneration: 1,
          },
        };
      },
    } as unknown as CodexProfileSupervisor, {
      resolve: async () => ({ actorId: "human", workspace: receipt }),
    }, { resolve: async (requested) => requested ?? "/workspace" });
    const scope = {
      relayId: "relay",
      relaySessionId: "relay-session",
      desktopSessionId: "desktop",
      pairingGenerationRef: "pairing-ref",
      selectedProtocolVersion: 8 as const,
      capabilityRevision: 3,
      profileHandle: "p",
      profileGeneration: 1,
      accountGeneration: 2,
      runtimeGeneration: 7,
      childGeneration: 1,
      workspace: {
        workspaceRef: "wire",
        revision: 4,
        fingerprint: "fp",
        issuedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:00:00.010Z",
      },
      bindingId: "binding",
      bindingGeneration: 1,
      taskId: "task",
      jobId: "job",
    };
    await port.open(scope, {
      posture: { kind: "codex_default", anchorMode: "default" },
      workingDirectory: "/projects/nautilo",
    });
    expect(opened?.workingDirectory).toBe("/projects/nautilo");
  });

  test("releases only the exact authenticated binding through supervisor admission", async () => {
    const receipt = { handle: handle("local"), actorId: "human", relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop", pairingGenerationRef: "pairing-ref", capabilityRevision: 3, revision: 4, fingerprint: "fp", issuedAt: 0, expiresAt: 10 };
    const calls: unknown[][] = [];
    const port = new CodexRelayHostPort({
      releaseBindingExact: async (...input: unknown[]) => { calls.push(input); },
    } as unknown as CodexProfileSupervisor, {
      resolve: async () => ({ actorId: "human", workspace: receipt }),
    }, { resolve: async (requested) => requested ?? "/workspace" });
    await port.release({
      relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop",
      pairingGenerationRef: "pairing-ref", selectedProtocolVersion: 9, capabilityRevision: 3,
      profileHandle: "p", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 7,
      childGeneration: 1, bindingId: "binding", bindingGeneration: 0, taskId: "task",
      jobId: "job", threadId: "thread",
      workspace: { workspaceRef: "wire", revision: 4, fingerprint: "fp", issuedAt: "1970-01-01T00:00:00.000Z", expiresAt: "1970-01-01T00:00:00.010Z" },
    });
    expect(calls).toEqual([[
      { profile: { actorId: "human", profileHandle: "p", profileGeneration: 1 }, accountGeneration: 2, runtimeGeneration: 7, childGeneration: 1 },
      { bindingId: "binding", bindingGeneration: 0, workspace: receipt, taskId: "task", jobId: "job", threadId: "thread" },
    ]]);
  });

  test("interrupts an active turn directly without attempting to resume it", async () => {
    const receipt = { handle: handle("local"), actorId: "human", relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop", pairingGenerationRef: "pairing-ref", capabilityRevision: 3, revision: 4, fingerprint: "fp", issuedAt: 0, expiresAt: 10 };
    const expectedChild = {
      profile: { actorId: "human", profileHandle: handle("p"), profileGeneration: 1 },
      accountGeneration: 2,
      runtimeGeneration: 7,
      childGeneration: 1,
    };
    let resumes = 0;
    let interruptedChild: typeof expectedChild | undefined;
    const port = new CodexRelayHostPort({
      resume: async () => {
        resumes += 1;
        throw new Error("active turns must not be resumed before interrupt");
      },
      interrupt: async (child: import("../../src/internal").ChildIdentity) => {
        interruptedChild = child;
      },
    } as unknown as CodexProfileSupervisor, {
      resolve: async () => ({ actorId: "human", workspace: receipt }),
    }, { resolve: async (requested) => requested ?? "/workspace" });
    await port.interrupt({
      relayId: "relay",
      relaySessionId: "relay-session",
      desktopSessionId: "desktop",
      pairingGenerationRef: "pairing-ref",
      selectedProtocolVersion: 8,
      capabilityRevision: 3,
      profileHandle: "p",
      profileGeneration: 1,
      accountGeneration: 2,
      runtimeGeneration: 7,
      // The wire scope names the child that originally opened the binding.
      childGeneration: 1,
      workspace: {
        workspaceRef: "wire",
        revision: 4,
        fingerprint: "fp",
        issuedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:00:00.010Z",
      },
      bindingId: "binding",
      bindingGeneration: 1,
      taskId: "task",
      jobId: "job",
      threadId: "thread",
      turnId: "turn",
    });
    expect(resumes).toBe(0);
    expect(interruptedChild).toEqual(expectedChild);
  });

  test("steers only through the exact authenticated turn scope", async () => {
    const receipt = {
      handle: handle("local"),
      actorId: "human",
      relayId: "relay",
      relaySessionId: "relay-session",
      desktopSessionId: "desktop",
      pairingGenerationRef: "pairing-ref",
      capabilityRevision: 3,
      revision: 4,
      fingerprint: "fp",
      issuedAt: 0,
      expiresAt: 10,
    };
    const calls: unknown[] = [];
    const port = new CodexRelayHostPort({
      steer: async (...input: unknown[]) => {
        calls.push(input);
      },
    } as unknown as CodexProfileSupervisor, {
      resolve: async () => ({ actorId: "human", workspace: receipt }),
    }, { resolve: async (requested) => requested ?? "/workspace" });
    await port.steer({
      relayId: "relay",
      relaySessionId: "relay-session",
      desktopSessionId: "desktop",
      pairingGenerationRef: "pairing-ref",
      selectedProtocolVersion: 8,
      capabilityRevision: 3,
      profileHandle: "p",
      profileGeneration: 1,
      accountGeneration: 2,
      runtimeGeneration: 7,
      childGeneration: 1,
      workspace: {
        workspaceRef: "wire",
        revision: 4,
        fingerprint: "fp",
        issuedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:00:00.010Z",
      },
      bindingId: "binding",
      bindingGeneration: 1,
      taskId: "task",
      jobId: "job",
      threadId: "thread",
      turnId: "turn",
    }, {
      text: "Focus on tests",
      actorRef: "actor-ref",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([
      { childGeneration: 1 },
      "binding",
      "turn",
      { text: "Focus on tests", clientUserMessageId: "actor-ref" },
    ]);
  });
});

describe("profile supervisor", () => {
  test("routes fixed ChatGPT account operations only to the exact current child", async () => {
    const h = await harness();
    const child = await h.supervisor.ensure({ profile: h.request.profile, accountGeneration: h.request.accountGeneration, runtimeGeneration: h.request.runtimeGeneration });
    expect(await h.supervisor.startChatgptLogin(child)).toEqual({ upstreamLoginId: "upstream", authUrl: "https://chatgpt.com/auth" });
    expect(await h.supervisor.cancelLogin(child, "upstream")).toEqual({ cancelled: true });
    expect(await h.supervisor.readAccount(child)).toEqual({ state: "signed_out", requiresOpenaiAuth: true });
    expect(await h.supervisor.readUsage(child)).toEqual({ dailyUsage: [] });
    await h.supervisor.logout(child);
    await rejects(h.supervisor.readAccount({ ...child, childGeneration: 99 }), "CHILD_GENERATION_STALE");
  });
  test("leases account RPCs, serializes mutations, and rejects responses from replaced children", async () => {
    const serialized = await harness(); const child = await serialized.supervisor.ensure(serialized.request);
    let releaseLogin!: () => void; serialized.clients.loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
    const login = serialized.supervisor.startChatgptLogin(child); const cancel = serialized.supervisor.cancelLogin(child, "upstream");
    await Promise.resolve(); await flush(serialized.timer);
    expect(serialized.clients.accountCalls).toEqual(["login"]); expect(serialized.processes.children[0]?.signals).toEqual([]);
    releaseLogin(); await login; await cancel;
    expect(serialized.clients.accountCalls).toEqual(["login", "cancel"]);

    for (const operation of ["login", "read", "logout"] as const) {
      const h = await harness(); h.processes.cooperateNext = true; const old = await h.supervisor.ensure(h.request);
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      if (operation === "login") h.clients.loginGate = gate;
      if (operation === "read") h.clients.readGate = gate;
      if (operation === "logout") h.clients.logoutGate = gate;
      const pending = operation === "login" ? h.supervisor.startChatgptLogin(old) : operation === "read" ? h.supervisor.readAccount(old) : h.supervisor.logout(old);
      await Promise.resolve();
      const replacement = await h.supervisor.ensure({ ...h.request, runtimeGeneration: 8 });
      expect(replacement.childGeneration).toBe(2);
      release();
      await rejects(pending, "CHILD_GENERATION_STALE");
    }
  });
  test("shutdown fences an admitted open before thread/start and durable completion", async () => {
    const h = await harness(); await h.supervisor.ensure(h.request); h.snapshots.blockNext();
    const opening = h.supervisor.open(h.request, binding("shutdown-open", h.receipt, 1)); const openingResult = opening.then(() => undefined, (error: unknown) => error); await Promise.resolve();
    let shutdownComplete = false; const shutdown = h.supervisor.shutdown().then(() => { shutdownComplete = true; });
    await Promise.resolve(); expect(shutdownComplete).toBe(false); h.snapshots.release(); for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await flush(h.timer); } await shutdown;
    expect(await openingResult).toMatchObject({ code: "SUPERVISOR_UNAVAILABLE" }); expect(h.clients.startedCwds).toEqual([]);
  });
  test("isolates profile homes and children, rejects cross/stale identities, and preserves a sibling after an exact-child fault", async () => {
    const h = await harness(); const childA = await h.supervisor.ensure(h.request); const requestB = { ...h.request, profile: profile("profile-b") };
    const childB = await h.supervisor.ensure(requestB);
    expect(childA.profile).not.toEqual(childB.profile); expect(childA.childGeneration).toBe(1); expect(childB.childGeneration).toBe(1);
    expect(h.processes.specs[0]?.env["CODEX_HOME"]).not.toBe(h.processes.specs[1]?.env["CODEX_HOME"]);
    await h.supervisor.open(h.request, binding("binding-a", h.receipt, 1));
    await h.supervisor.open(requestB, binding("binding-b", h.receipt, 1));
    await h.supervisor.updateBindingActivity(childB, handle("binding-b"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    await rejects(h.supervisor.interrupt(childB, handle("binding-a"), "turn"), "CHILD_GENERATION_STALE");
    await rejects(h.supervisor.interrupt({ ...childA, profile: { ...childA.profile, actorId: "other-actor" } }, handle("binding-a"), "turn"), "CHILD_GENERATION_STALE");
    await rejects(h.supervisor.interrupt({ ...childA, profile: { ...childA.profile, profileGeneration: 99 } }, handle("binding-a"), "turn"), "CHILD_GENERATION_STALE");
    const fault = h.supervisor.onClientFault(childA); await flush(h.timer); await fault;
    expect(await h.supervisor.ensure(requestB)).toEqual(childB); expect(h.processes.children[1]?.signals).toEqual([]);
  });
  test("releases an unreachable binding only for its exact child, generation, task, and thread", async () => {
    const h = await harness();
    const child = await h.supervisor.ensure(h.request);
    const request = binding("cas-loser", h.receipt, 0);
    const opened = await h.supervisor.open(h.request, request);
    const exact = {
      bindingId: request.bindingId,
      bindingGeneration: request.bindingGeneration,
      workspace: h.receipt,
      taskId: request.taskId,
      jobId: request.jobId,
      threadId: opened.threadId,
    };

    await rejects(h.supervisor.releaseBindingExact(child, {
      ...exact,
      bindingGeneration: exact.bindingGeneration + 1,
    }), "CHILD_GENERATION_STALE");
    await h.supervisor.resume(h.request, exact);

    await h.supervisor.releaseBindingExact(child, exact);
    await rejects(h.supervisor.resume(h.request, exact), "CHILD_GENERATION_STALE");
  });
  test("reports exact current, stale, and successor children without throwing", async () => {
    const h = await harness(); h.processes.cooperateNext = true; const current = await h.supervisor.ensure(h.request);
    expect(h.supervisor.isCurrentChild(current)).toBe(true);
    expect(h.supervisor.isCurrentChild({ ...current, childGeneration: current.childGeneration + 1 })).toBe(false);
    expect(h.supervisor.isCurrentChild({ ...current, runtimeGeneration: current.runtimeGeneration + 1 })).toBe(false);
    h.processes.cooperateNext = true;
    const successor = await h.supervisor.ensure({ ...h.request, runtimeGeneration: 8 });
    expect(h.supervisor.isCurrentChild(current)).toBe(false);
    expect(h.supervisor.isCurrentChild(successor)).toBe(true);
    await h.supervisor.onClientFault(current);
    expect(h.supervisor.isCurrentChild(successor)).toBe(true);
    expect(h.faults).toEqual([]);
    const fault = h.supervisor.onClientFault(successor); await flush(h.timer); await fault;
    expect(h.supervisor.isCurrentChild(successor)).toBe(false);
    expect(h.faults).toEqual([{ kind: "child_crashed", child: successor }]);
  });
  test("prepends only verified runtime PATH entries and leaves external PATH baseline unchanged", async () => {
    const managed = await harness({ environment: { PATH: "baseline", SAFE: "yes" }, pathDelimiter: "|" }); const entries = Object.freeze(["/managed/bin", "/managed/tools"]); managed.runtime.pathEntries = entries;
    await managed.supervisor.ensure(managed.request); expect(managed.processes.specs[0]?.env["PATH"]).toBe("/managed/bin|/managed/tools|baseline"); expect(managed.processes.specs[0]?.env["SAFE"]).toBe("yes"); expect(Object.isFrozen(entries)).toBe(true);
    const external = await harness({ environment: { PATH: "baseline", SAFE: "yes" }, pathDelimiter: "|" }); await external.supervisor.ensure(external.request); expect(external.processes.specs[0]?.env["PATH"]).toBe("baseline");
    const mainBarrel = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text(); expect(mainBarrel).not.toContain("RuntimeLaunchSpec"); expect(mainBarrel).not.toContain("pathEntries");
  });
  test("rejects a child that reports a different CODEX_HOME and tears it down", async () => {
    const h = await harness(); h.clients.codexHomeOverride = "/not-the-profile-home"; h.processes.cooperateNext = true;
    const work = h.supervisor.ensure(h.request); await flush(h.timer); await rejects(work, "PROFILE_HOME_INVALID");
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(h.runtime.releases).toBe(1);
  });
  test("keeps an uncertain durable open reservation from starting a second Codex thread", async () => {
    const h = await harness(); h.clients.rejectStart = true;
    await h.supervisor.open(h.request, binding("uncertain", h.receipt, 1)).catch(() => undefined);
    h.clients.rejectStart = false;
    await rejects(h.supervisor.open(h.request, binding("uncertain", h.receipt, 1)), "BINDING_UNCERTAIN");
    expect(h.clients.startedCwds).toEqual([]);
  });
  test("singleflights a durable rebind before upstream resume", async () => {
    const h = await harness(); const opened = await h.supervisor.open(h.request, binding("rebind", h.receipt, 1));
    let release!: () => void; h.clients.resumeGate = new Promise<void>((resolve) => { release = resolve; });
    const request = { bindingId: handle("rebind"), bindingGeneration: 1, taskId: "task-a", jobId: "job-a", threadId: opened.threadId, successorWorkspace: h.receipt, nextBindingGeneration: 2 };
    const both = Promise.all([h.supervisor.rebind(h.request, request), h.supervisor.rebind(h.request, request)]);
    await Promise.resolve(); release(); const rebound = await both;
    expect(rebound.map((entry) => entry.bindingGeneration)).toEqual([2, 2]); expect(h.clients.resumedCwds).toEqual(["/workspace"]);
  });
  test("uses stable workspace identity across reconnects but rejects changed pairing or fingerprint", async () => {
    const h = await harness(); const opened = await h.supervisor.open(h.request, binding("reconnect", h.receipt, 1));
    h.snapshots.push(snap({ relaySessionId: "new-relay-session", desktopSessionId: "new-desktop", capabilityRevision: 9 }));
    const fresh = await h.authority.mint();
    expect(await h.supervisor.rebind({ ...h.request, workspace: fresh }, { bindingId: handle("reconnect"), bindingGeneration: 1, taskId: "task-a", jobId: "job-a", threadId: opened.threadId, successorWorkspace: fresh, nextBindingGeneration: 2 })).toMatchObject({ bindingGeneration: 2 });
    h.snapshots.push(snap({ relaySessionId: "another", desktopSessionId: "another-desktop", pairingGenerationRef: "changed-pairing", capabilityRevision: 10 }));
    const changedPairing = await h.authority.mint();
    await rejects(h.supervisor.rebind({ ...h.request, workspace: changedPairing }, { bindingId: handle("reconnect"), bindingGeneration: 2, taskId: "task-a", jobId: "job-a", threadId: opened.threadId, successorWorkspace: changedPairing, nextBindingGeneration: 3 }), "WORKSPACE_STALE");
  });
  test("revalidates an idempotent existing open before returning it", async () => {
    const h = await harness(); const request = binding("existing-stale", h.receipt, 1);
    await h.supervisor.open(h.request, request);
    h.snapshots.push(snap({ desktopSessionId: "replaced-desktop" }));
    await rejects(h.supervisor.open(h.request, request), "WORKSPACE_STALE");
    expect(h.clients.startedCwds).toEqual(["/workspace"]);
  });
  test("holds an exact-child lease through final workspace resolution", async () => {
    const existing = await harness(); existing.processes.cooperateNext = true;
    const existingBinding = binding("existing-race", existing.receipt, 1); await existing.supervisor.open(existing.request, existingBinding);
    existing.snapshots.blockNext(); const existingWork = existing.supervisor.open(existing.request, existingBinding); await until(() => existing.snapshots.isBlocked());
    let existingReplaced = false; const existingReplacement = existing.supervisor.ensure({ ...existing.request, runtimeGeneration: 8 }).then(() => { existingReplaced = true; });
    await Promise.resolve(); expect(existingReplaced).toBe(false); existing.snapshots.release();
    expect((await existingWork).threadId).toBe("host-thread-1"); await existingReplacement;

    const opening = await harness(); opening.processes.cooperateNext = true; await opening.supervisor.ensure(opening.request);
    opening.snapshots.blockNext(); const openWork = opening.supervisor.open(opening.request, binding("new-race", opening.receipt, 1)); await until(() => opening.snapshots.isBlocked());
    let openReplaced = false; const openReplacement = opening.supervisor.ensure({ ...opening.request, runtimeGeneration: 8 }).then(() => { openReplaced = true; });
    await Promise.resolve(); expect(openReplaced).toBe(false); opening.snapshots.release();
    expect((await openWork).threadId).toBe("host-thread-1"); await openReplacement;

    const resume = await harness(); resume.processes.cooperateNext = true;
    const resumeBinding = binding("resume-race", resume.receipt, 1); await resume.supervisor.open(resume.request, resumeBinding);
    resume.snapshots.blockNext(); const resumeWork = resume.supervisor.resume(resume.request, resumeBinding); await until(() => resume.snapshots.isBlocked());
    let resumeReplaced = false; const resumeReplacement = resume.supervisor.ensure({ ...resume.request, runtimeGeneration: 8 }).then(() => { resumeReplaced = true; });
    await Promise.resolve(); expect(resumeReplaced).toBe(false); resume.snapshots.release();
    expect((await resumeWork).threadId).toBe("host-thread-1"); await resumeReplacement;

    const rebind = await harness(); rebind.processes.cooperateNext = true;
    const rebindBinding = binding("rebind-race", rebind.receipt, 1); const opened = await rebind.supervisor.open(rebind.request, rebindBinding);
    rebind.snapshots.blockNext();
    const rebindWork = rebind.supervisor.rebind(rebind.request, { bindingId: handle("rebind-race"), bindingGeneration: 1, taskId: "task-a", jobId: "job-a", threadId: opened.threadId, successorWorkspace: rebind.receipt, nextBindingGeneration: 2 });
    await until(() => rebind.snapshots.isBlocked());
    let rebindReplaced = false; const rebindReplacement = rebind.supervisor.ensure({ ...rebind.request, runtimeGeneration: 8 }).then(() => { rebindReplaced = true; });
    await Promise.resolve(); expect(rebindReplaced).toBe(false); rebind.snapshots.release();
    expect((await rebindWork).bindingGeneration).toBe(2); await rebindReplacement;
  });
  test("replacement waits for blocked thread RPCs to finish under their lease", async () => {
    const opening = await harness(); opening.processes.cooperateNext = true; await opening.supervisor.ensure(opening.request);
    let releaseStart!: () => void; opening.clients.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const openWork = opening.supervisor.open(opening.request, binding("rpc-open-race", opening.receipt, 1));
    await until(() => opening.clients.startedCwds.length === 1);
    let openReplaced = false; const openReplacement = opening.supervisor.ensure({ ...opening.request, runtimeGeneration: 8 }).then(() => { openReplaced = true; });
    await Promise.resolve(); expect(openReplaced).toBe(false); releaseStart();
    expect((await openWork).threadId).toBe("host-thread-1"); await openReplacement;

    const resume = await harness(); resume.processes.cooperateNext = true;
    const resumeBinding = binding("rpc-resume-race", resume.receipt, 1); await resume.supervisor.open(resume.request, resumeBinding);
    let releaseResume!: () => void; resume.clients.resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    const resumeWork = resume.supervisor.resume(resume.request, resumeBinding); await until(() => resume.clients.resumedCwds.length === 1);
    let resumeReplaced = false; const resumeReplacement = resume.supervisor.ensure({ ...resume.request, runtimeGeneration: 8 }).then(() => { resumeReplaced = true; });
    await Promise.resolve(); expect(resumeReplaced).toBe(false); releaseResume();
    expect((await resumeWork).threadId).toBe("host-thread-1"); await resumeReplacement;
  });
  test("replacement waits through durable open/rebind completion and rejects late old authority", async () => {
    const openStore = new GatedBindingStore(); let releaseOpen!: () => void;
    openStore.completeOpenGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const opening = await harness({ bindings: openStore }); opening.processes.cooperateNext = true; await opening.supervisor.ensure(opening.request);
    const openWork = opening.supervisor.open(opening.request, binding("durable-open", opening.receipt, 1));
    await until(() => openStore.openCompleting);
    let openReplaced = false; const openReplacement = opening.supervisor.ensure({ ...opening.request, runtimeGeneration: 8 }).then(() => { openReplaced = true; });
    const lateOld = opening.supervisor.open({ ...opening.request, runtimeGeneration: 8 }, binding("durable-open", opening.receipt, 1));
    await Promise.resolve(); expect(openReplaced).toBe(false); releaseOpen();
    expect((await openWork).threadId).toBe("host-thread-1"); await openReplacement;
    await rejects(lateOld, "CHILD_GENERATION_STALE");

    const rebindStore = new GatedBindingStore(); const rebind = await harness({ bindings: rebindStore }); rebind.processes.cooperateNext = true;
    const original = binding("durable-rebind", rebind.receipt, 1); const opened = await rebind.supervisor.open(rebind.request, original);
    let releaseRebind!: () => void; rebindStore.completeRebindGate = new Promise<void>((resolve) => { releaseRebind = resolve; });
    const rebindWork = rebind.supervisor.rebind(rebind.request, { bindingId: handle("durable-rebind"), bindingGeneration: 1, taskId: "task-a", jobId: "job-a", threadId: opened.threadId, successorWorkspace: rebind.receipt, nextBindingGeneration: 2 });
    await until(() => rebindStore.rebindCompleting);
    let rebindReplaced = false; const replacement = rebind.supervisor.ensure({ ...rebind.request, runtimeGeneration: 8 }).then(() => { rebindReplaced = true; });
    await Promise.resolve(); expect(rebindReplaced).toBe(false); releaseRebind();
    expect((await rebindWork).bindingGeneration).toBe(2); await replacement;
  });
  test("does not join pending opens whose durable authority differs", async () => {
    const h = await harness(); const child = await h.supervisor.ensure(h.request); const registry = new CodexBindingRegistry(child, new InMemoryCodexBindingStore());
    const first = binding("pending", h.receipt, 1); const reserved = await registry.reserveOpen(first); expect(reserved.kind).toBe("started");
    if (reserved.kind === "started") { const { model: _omitted, ...restartShape } = reserved.reservation; expect(sameReservationAuthority(reserved.reservation, restartShape as typeof reserved.reservation)).toBe(true); }
    await rejects(registry.reserveOpen({ ...first, model: "different-model" }), "CHILD_GENERATION_STALE");
  });
  test("classifies an exact client fault once according to proven process-group death", async () => {
    const safe = await harness(); safe.processes.cooperateNext = true; const safeChild = await safe.supervisor.ensure(safe.request); const safeFault = safe.supervisor.onClientFault(safeChild); await flush(safe.timer); await safeFault; expect(safe.faults).toEqual([{ kind: "child_crashed", child: safeChild }]);
    const uncertain = await harness(); const uncertainChild = await uncertain.supervisor.ensure(uncertain.request); const uncertainFault = uncertain.supervisor.onClientFault(uncertainChild); await flush(uncertain.timer); await uncertainFault; expect(uncertain.faults).toEqual([{ kind: "process_group_uncertain", child: uncertainChild }]);
  });
  test("does not classify a client fault that arrives during an intentional drain", async () => {
    const h = await harness(); h.processes.cooperateNext = true; const child = await h.supervisor.ensure(h.request);
    const draining = h.supervisor.drain(child);
    const fault = h.supervisor.onClientFault(child);
    await Promise.all([draining, fault]);
    expect(h.faults).toEqual([]);
  });
  test("lets only one of two simultaneous exact client faults stop and classify", async () => {
    const h = await harness(); h.processes.cooperateNext = true; const child = await h.supervisor.ensure(h.request);
    const first = h.supervisor.onClientFault(child);
    const second = h.supervisor.onClientFault(child);
    await Promise.all([first, second]);
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(h.faults).toEqual([{ kind: "child_crashed", child }]);
  });
  test("reserves a binding before thread/start, rejects mismatched resume, and advances a real rebind exactly once", async () => {
    const h = await harness();
    const request = binding("same", h.receipt, 1);
    const opened = await Promise.all(Array.from({ length: 12 }, () => h.supervisor.open(h.request, request)));
    expect(new Set(opened.map((entry) => entry.threadId))).toEqual(new Set(["host-thread-1"]));
    expect(h.clients.startedCwds).toEqual(["/workspace"]);
    await rejects(h.supervisor.resume(h.request, { ...request, threadId: "host-thread-1", jobId: "wrong-job" }), "CHILD_GENERATION_STALE");
    const rebound = await h.supervisor.rebind(h.request, { ...request, threadId: "host-thread-1", successorWorkspace: h.receipt, nextBindingGeneration: 2 });
    expect(rebound.bindingGeneration).toBe(2);
    await rejects(h.supervisor.rebind(h.request, { ...request, threadId: "host-thread-1", successorWorkspace: h.receipt, nextBindingGeneration: 2 }), "CHILD_GENERATION_STALE");
    await rejects(h.supervisor.open(h.request, { ...request, bindingGeneration: 2, model: "different-model" }), "CHILD_GENERATION_STALE");
    expect(h.clients.startedCwds).toEqual(["/workspace"]);
  });

  test("singleflights 20 ensures, uses host-minted distinct threads, and replaces old generations", async () => {
    const h = await harness(); h.processes.cooperateNext = true;
    const children = await Promise.all(Array.from({ length: 20 }, () => h.supervisor.ensure(h.request)));
    expect(new Set(children.map((child) => child.childGeneration))).toEqual(new Set([1]));
    expect(h.processes.children).toHaveLength(1);
    const first = await h.supervisor.open(h.request, binding("a", h.receipt, 1));
    const second = await h.supervisor.open(h.request, binding("b", h.receipt, 1));
    expect([first.threadId, second.threadId]).toEqual(["host-thread-1", "host-thread-2"]);
    expect(h.clients.startedCwds).toEqual(["/workspace", "/workspace"]);
    h.processes.cooperateNext = true;
    const nextRequest = { ...h.request, runtimeGeneration: 8 };
    const replacing = h.supervisor.ensure(nextRequest); await flush(h.timer); const replacement = await replacing;
    expect(replacement.childGeneration).toBe(2);
    await rejects(h.supervisor.interrupt(children[0]!, handle("a"), "late-turn"), "CHILD_GENERATION_STALE");
  });

  test("uses private service cwd for account children, and revalidates every workspace resume", async () => {
    const h = await harness();
    h.runtime.afterAcquire = () => h.snapshots.push(snap({ capabilityRevision: 9 }));
    const start = await h.supervisor.ensure({ profile: h.request.profile, accountGeneration: h.request.accountGeneration, runtimeGeneration: h.request.runtimeGeneration });
    expect(start.childGeneration).toBe(1); expect(h.processes.specs[0]?.cwd).toBe("/service");

    const good = await harness();
    good.processes.cooperateNext = true;
    const child = await good.supervisor.ensure(good.request);
    const opened = await good.supervisor.open(good.request, binding("a", good.receipt, 1));
    good.snapshots.push(snap({ desktopSessionId: "changed" }));
    await rejects(good.supervisor.resume(good.request, binding("a", good.receipt, 1)), "WORKSPACE_STALE");
    const drain = good.supervisor.drain(child); await flush(good.timer); await drain;
    expect(good.processes.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(opened.threadId).toBe("host-thread-1");

    const hard = await harness(); const hardChild = await hard.supervisor.ensure(hard.request);
    const hardDrain = hard.supervisor.drain(hardChild); await flush(hard.timer); await hardDrain;
    expect(hard.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("rejects service cwd overlap with profile/runtime and workspace overlap with host storage", async () => {
    const profileOverlap = await harness({ servicePath: "/profiles" });
    await rejects(profileOverlap.supervisor.ensure(profileOverlap.request), "SUPERVISOR_UNAVAILABLE");
    expect(profileOverlap.processes.children).toHaveLength(0);

    const runtimeOverlap = await harness({ servicePath: "/verified" });
    await rejects(runtimeOverlap.supervisor.ensure(runtimeOverlap.request), "SUPERVISOR_UNAVAILABLE");
    expect(runtimeOverlap.processes.children).toHaveLength(0);

    const workspaceOverlap = await harness({ servicePath: "/workspace" });
    await workspaceOverlap.supervisor.ensure(workspaceOverlap.request);
    await rejects(workspaceOverlap.supervisor.open(workspaceOverlap.request, binding("overlap", workspaceOverlap.receipt, 1)), "WORKSPACE_UNAVAILABLE");
    expect(workspaceOverlap.clients.startedCwds).toEqual([]);
  });

  test("keeps a child alive for active binding work and releases failed-start leases", async () => {
    const h = await harness(); h.processes.cooperateNext = true;
    const child = await h.supervisor.ensure(h.request);
    await h.supervisor.open(h.request, binding("a", h.receipt, 1));
    await h.supervisor.updateBindingActivity(child, handle("a"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    await flush(h.timer);
    await h.supervisor.interrupt(child, handle("a"), "turn");
    expect(h.clients.interrupted).toEqual([]);
    await rejects(h.supervisor.updateBindingActivity(child, handle("a"), { activeTurns: 0, pendingRequests: 0, outstandingRpcs: 0 }), "CHILD_GENERATION_STALE");
    await rejects(h.supervisor.interrupt(child, handle("a"), "turn"), "CHILD_GENERATION_STALE");

    const failed = await harness(); failed.clients.failNextInitialize = true; failed.processes.cooperateNext = true;
    const start = failed.supervisor.ensure(failed.request); await flush(failed.timer); await rejects(start, "SUPERVISOR_UNAVAILABLE");
    expect(failed.runtime.releases).toBe(1);
  });

  test("reports active binding counters through the read-only lifecycle fence", async () => {
    const h = await harness();
    const child = await h.supervisor.ensure(h.request);
    await h.supervisor.open(h.request, binding("activity", h.receipt, 1));
    expect(await h.supervisor.hasActiveWork()).toBe(false);
    for (const change of [
      { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 },
      { activeTurns: 0, pendingRequests: 1, outstandingRpcs: 0 },
      { activeTurns: 0, pendingRequests: 0, outstandingRpcs: 1 },
    ]) {
      await h.supervisor.updateBindingActivity(child, handle("activity"), change);
      expect(await h.supervisor.hasActiveWork()).toBe(true);
    }
    await h.supervisor.updateBindingActivity(child, handle("activity"), {
      activeTurns: 0,
      pendingRequests: 0,
      outstandingRpcs: 0,
    });
    expect(await h.supervisor.hasActiveWork()).toBe(false);
  });

  test("serializes active turns within one profile so whole-tree Stop cannot hit a sibling turn", async () => {
    const h = await harness();
    const child = await h.supervisor.ensure(h.request);
    const a = binding("serialized-a", h.receipt, 1);
    const b = binding("serialized-b", h.receipt, 1);
    await h.supervisor.open(h.request, a);
    const openedB = await h.supervisor.open(h.request, b);
    const resumedB = { ...b, threadId: openedB.threadId };

    await h.supervisor.startTurn(h.request, a, {
      text: "first",
      clientUserMessageId: "human-a",
      collaborationMode: "work",
    });
    await rejects(h.supervisor.interrupt(child, a.bindingId, "stale-turn"), "CHILD_GENERATION_STALE");
    expect(h.processes.children[0]?.signals).toEqual([]);
    await rejects(h.supervisor.startTurn(h.request, resumedB, {
      text: "second",
      clientUserMessageId: "human-b",
      collaborationMode: "work",
    }), "SUPERVISOR_UNAVAILABLE");

    await h.supervisor.completeTurn(child, a.bindingId);
    const second = await h.supervisor.startTurn(h.request, resumedB, {
      text: "second",
      clientUserMessageId: "human-b",
      collaborationMode: "work",
    });
    expect(second.turnId).toStartWith("host-turn-");
  });

  test("treats in-flight child startup and binding open as active before counters exist", async () => {
    const starting = await harness();
    const releaseInitialize = deferred<void>();
    starting.clients.initializeGate = releaseInitialize.promise;
    const ensure = starting.supervisor.ensure(starting.request);
    await until(() => starting.processes.children.length === 1);
    expect(await starting.supervisor.hasActiveWork()).toBe(true);
    releaseInitialize.resolve();
    await ensure;
    expect(await starting.supervisor.hasActiveWork()).toBe(false);

    const opening = await harness();
    await opening.supervisor.ensure(opening.request);
    const releaseStart = deferred<void>();
    opening.clients.startGate = releaseStart.promise;
    const open = opening.supervisor.open(opening.request, binding("opening", opening.receipt, 1));
    await until(() => opening.clients.startedCwds.length === 1);
    expect(await opening.supervisor.hasActiveWork()).toBe(true);
    releaseStart.resolve();
    await open;
    expect(await opening.supervisor.hasActiveWork()).toBe(false);
  });

  test("caps profile slots, closes admission on shutdown, and escalates a nonterminal turn only in its child", async () => {
    const h = await harness();
    const starts = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => h.supervisor.ensure({ ...h.request, profile: profile(`p-${index}`) })));
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    const shutdown = h.supervisor.shutdown(); await flush(h.timer); await shutdown;
    await rejects(h.supervisor.ensure(h.request), "SUPERVISOR_UNAVAILABLE");

    const turn = await harness(); turn.terminal.result = false; turn.processes.cooperateNext = true;
    const child = await turn.supervisor.ensure(turn.request); await turn.supervisor.open(turn.request, binding("a", turn.receipt, 1));
    await turn.supervisor.updateBindingActivity(child, handle("a"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    const interrupted = turn.supervisor.interrupt(child, handle("a"), "never-finishes"); await flush(turn.timer); await interrupted;
    expect(turn.processes.children[0]?.signals).toEqual(["SIGTERM"]);
  });
  test("escalates only the exact non-cooperative turn child and retains its sibling profile", async () => {
    const h = await harness(); h.terminal.result = false;
    const childA = await h.supervisor.ensure(h.request);
    const requestB = { ...h.request, profile: profile("non-cooperative-sibling") };
    const childB = await h.supervisor.ensure(requestB);
    await h.supervisor.open(h.request, binding("non-cooperative-a", h.receipt, 1));
    await h.supervisor.open(requestB, binding("non-cooperative-b", h.receipt, 1));
    await h.supervisor.updateBindingActivity(childA, handle("non-cooperative-a"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    await h.supervisor.updateBindingActivity(childB, handle("non-cooperative-b"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });

    const interrupted = h.supervisor.interrupt(childA, handle("non-cooperative-a"), "never-finishes");
    await flush(h.timer);
    await rejects(interrupted, "SUPERVISOR_UNAVAILABLE");

    // The only destructive signals belong to A's isolated process group. A
    // failed containment proof is surfaced for review instead of implicitly
    // treating this as a clean, resumable completion.
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.processes.children[1]?.signals).toEqual([]);
    expect(h.faults).toEqual([{ kind: "process_group_uncertain", child: childA }]);
    await rejects(h.supervisor.ensure(h.request), "SUPERVISOR_UNAVAILABLE");

    // A sibling must neither be drained nor replaced by A's escalation.
    expect(h.supervisor.isCurrentChild(childB)).toBe(true);
    expect(await h.supervisor.ensure(requestB)).toEqual(childB);
    expect(await h.supervisor.readAccount(childB)).toMatchObject({ state: "signed_out" });
  });
  test("continues TERM/KILL when leader exits but its group remains live, retaining the lease", async () => {
    const h = await harness(); h.processes.leaderExitGroupLiveNext = true;
    const child = await h.supervisor.ensure(h.request); const drain = h.supervisor.drain(child); await flush(h.timer); await drain;
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(h.runtime.releases).toBe(0);
    await rejects(h.supervisor.ensure(h.request), "SUPERVISOR_UNAVAILABLE");
    await rejects(h.supervisor.ensure({ ...h.request, runtimeGeneration: 8 }), "SUPERVISOR_UNAVAILABLE");
    expect(h.processes.children).toHaveLength(1); expect(h.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("account-only child initialization does not read Current Folder", async () => {
    const h = await harness(); h.snapshots.blockNext();
    const child = await h.supervisor.ensure({ profile: h.request.profile, accountGeneration: h.request.accountGeneration, runtimeGeneration: h.request.runtimeGeneration });
    expect(child.childGeneration).toBe(1); expect(h.processes.specs[0]?.cwd).toBe("/service");
  });
  test("contains the exact child without trusting the provider interrupt RPC", async () => {
    const h = await harness(); const child = await h.supervisor.ensure(h.request); await h.supervisor.open(h.request, binding("a", h.receipt, 1)); await h.supervisor.updateBindingActivity(child, handle("a"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 }); h.clients.rejectInterrupt = true; const work = h.supervisor.interrupt(child, handle("a"), "turn"); await flush(h.timer); try { await work; } catch { /* expected uncertain process proof */ } expect(h.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(h.clients.interrupted).toEqual([]);
  });
  test("freezes the process tree before client EOF and admits a clean successor after Stop", async () => {
    const h = await harness(); h.processes.cooperateNext = true;
    const child = await h.supervisor.ensure(h.request); await h.supervisor.open(h.request, binding("ordered-stop", h.receipt, 1)); await h.supervisor.updateBindingActivity(child, handle("ordered-stop"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    const stopped = h.supervisor.interrupt(child, handle("ordered-stop"), "turn");
    await until(() => h.processes.children[0]?.signals.includes("SIGTERM") === true);
    expect(h.clients.closed).toBe(0);
    await flush(h.timer); await stopped;
    expect(h.clients.closed).toBe(1);
    expect((await h.supervisor.ensure(h.request)).childGeneration).toBe(2);
  });
  test("does not wait for a semantic terminal before exact containment", async () => {
    const h = await harness(); h.terminal.never = true; const child = await h.supervisor.ensure(h.request); await h.supervisor.open(h.request, binding("a", h.receipt, 1)); await h.supervisor.updateBindingActivity(child, handle("a"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 }); const work = h.supervisor.interrupt(child, handle("a"), "turn"); await flush(h.timer); await rejects(work, "SUPERVISOR_UNAVAILABLE"); expect(h.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("profile removal fails closed for active bindings without a coordinator, then rechecks coordinator work", async () => {
    const blocked = await harness(); const blockedHome = await blocked.homes.ensure(blocked.request.profile);
    const blockedChild = await blocked.supervisor.ensure(blocked.request); await blocked.supervisor.open(blocked.request, binding("remove-active", blocked.receipt, 1));
    await blocked.supervisor.updateBindingActivity(blockedChild, handle("remove-active"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    await rejects(blocked.supervisor.removeProfile({ ...accountOnly(blocked.request), home: blockedHome, existingChild: blockedChild }), "SUPERVISOR_UNAVAILABLE");
    expect(blocked.runtime.releases).toBe(0); expect(blocked.removals()).toBe(0);

    let coordinatorCalls = 0; const coordinatedBindings = new InMemoryCodexBindingStore();
    const h = await harness({ bindings: coordinatedBindings, removalTurnCoordinator: { cancelAndWait: async ({ bindings }) => { coordinatorCalls += 1; for (const value of bindings) await coordinatedBindings.update({ ...value, activeTurns: 0, pendingRequests: 0, outstandingRpcs: 0 }); } } });
    const home = await h.homes.ensure(h.request.profile); h.processes.cooperateNext = true;
    const child = await h.supervisor.ensure(h.request); await h.supervisor.open(h.request, binding("remove-coordinated", h.receipt, 1));
    await h.supervisor.updateBindingActivity(child, handle("remove-coordinated"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    await h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child });
    expect(coordinatorCalls).toBe(1); expect(h.clients.accountCalls).toEqual(["logout"]); expect(h.runtime.releases).toBe(1); expect(h.removals()).toBe(1);
  });

  test("profile removal keeps a gated child for logout retry and retries home deletion from retained proof", async () => {
    const h = await harness({ removalFails: true }); const home = await h.homes.ensure(h.request.profile); h.processes.cooperateNext = true;
    const child = await h.supervisor.ensure(h.request); h.clients.rejectLogout = true;
    await rejects(h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child }), "SUPERVISOR_UNAVAILABLE");
    expect(h.runtime.releases).toBe(0); expect(h.removals()).toBe(0);
    h.clients.rejectLogout = false;
    await rejectsFailure(h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child }));
    expect(h.runtime.releases).toBe(1); expect(h.removals()).toBe(1);
    await h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child });
    expect(h.runtime.releases).toBe(1); expect(h.removals()).toBe(2);
  });

  test("a child that dies during logout retains its home and requires a fresh removal-only logout before deletion", async () => {
    const h = await harness(); const home = await h.homes.ensure(h.request.profile); const logout = deferred<void>(); h.clients.logoutGate = logout.promise;
    const child = await h.supervisor.ensure(h.request); const remove = h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child }); await until(() => h.clients.accountCalls.includes("logout"));
    h.processes.children[0]!.exit(); h.clients.rejectLogout = true; logout.resolve();
    await rejects(remove, "SUPERVISOR_UNAVAILABLE"); expect(h.removals()).toBe(0); expect(h.runtime.releases).toBe(1);
    h.clients.rejectLogout = false; h.clients.logoutGate = undefined; h.processes.cooperateNext = true;
    await h.supervisor.removeProfile({ ...accountOnly(h.request), home });
    expect(h.removals()).toBe(1); expect(h.runtime.releases).toBe(2); expect(h.processes.children).toHaveLength(2);
  });

  test("profile removal never deletes or releases on uncertain process proof and never drains a successor", async () => {
    const uncertain = await harness(); const home = await uncertain.homes.ensure(uncertain.request.profile);
    const child = await uncertain.supervisor.ensure(uncertain.request); const remove = uncertain.supervisor.removeProfile({ ...accountOnly(uncertain.request), home, existingChild: child }); await flush(uncertain.timer);
    await rejects(remove, "SUPERVISOR_UNAVAILABLE");
    expect(uncertain.removals()).toBe(0); expect(uncertain.runtime.releases).toBe(0); expect(uncertain.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await rejects(uncertain.supervisor.ensure(uncertain.request), "CHILD_GENERATION_STALE");

    const successor = await harness(); const successorHome = await successor.homes.ensure(successor.request.profile); successor.processes.cooperateNext = true;
    const next = await successor.supervisor.ensure({ ...successor.request, runtimeGeneration: 8 });
    await rejects(successor.supervisor.removeProfile({ ...accountOnly(successor.request), home: successorHome, existingChild: next }), "CHILD_GENERATION_STALE");
    expect(successor.processes.children[0]?.signals).toEqual([]); expect(successor.removals()).toBe(0);
  });

  test("contains rejected group signals and marks an unprovable live group uncertain", async () => {
    const h = await harness(); h.processes.rejectSignalsNext = true;
    const child = await h.supervisor.ensure(h.request);

    const shutdown = h.supervisor.shutdown(); await flush(h.timer); await shutdown;

    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
    expect(h.faults).toEqual([{ kind: "process_group_uncertain", child }]);
    expect(h.runtime.releases).toBe(0);
    await rejects(h.supervisor.ensure(h.request), "SUPERVISOR_UNAVAILABLE");
  });

  test("profile removal gate wins over a late public ensure while its removal-only launch remains available", async () => {
    const h = await harness(); const home = await h.homes.ensure(h.request.profile); const initialized = deferred<void>(); h.clients.initializeGate = initialized.promise; h.processes.cooperateNext = true;
    const lateEnsure = h.supervisor.ensure(h.request); await until(() => h.processes.children.length === 1);
    const remove = h.supervisor.removeProfile({ ...accountOnly(h.request), home }); initialized.resolve();
    await rejects(lateEnsure, "CHILD_GENERATION_STALE"); await remove;
    expect(h.removals()).toBe(1); expect(h.runtime.releases).toBe(1);
  });
  test("revokes a timed-out logout before returning, rejects late completion, and retries with a fresh removal-only child", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); const home = await h.homes.ensure(h.request.profile); h.processes.cooperateNext = true;
    const child = await h.supervisor.ensure(h.request); const logout = deferred<void>(); h.clients.logoutGate = logout.promise;
    const removing = h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child }); await until(() => h.clients.accountCalls.includes("logout"));
    await flush(h.timer); await rejects(removing, "SUPERVISOR_UNAVAILABLE");
    // The rejection precedes late dependency completion; the attempt has
    // already been revoked and no registry deletion may be reached later.
    expect(h.removals()).toBe(0); logout.resolve(); await flush(h.timer); expect(h.removals()).toBe(0);
    await until(() => h.runtime.releases === 1);
    h.clients.logoutGate = undefined; h.processes.cooperateNext = true;
    await h.supervisor.removeProfile({ ...accountOnly(h.request), home });
    expect(h.removals()).toBe(1); expect(h.processes.children).toHaveLength(2); expect(h.runtime.releases).toBe(2);
  });
  test("bounds stuck thread, account, and coordinator settlement without permitting late deletion", async () => {
    const thread = await harness({ profileRemovalTimeoutMs: 1 }); const threadHome = await thread.homes.ensure(thread.request.profile); thread.processes.cooperateNext = true;
    const threadChild = await thread.supervisor.ensure(thread.request); const start = deferred<void>(); thread.clients.startGate = start.promise;
    const opening = thread.supervisor.open(thread.request, binding("removal-thread-gate", thread.receipt, 1)); await until(() => thread.clients.startedCwds.length === 1);
    const removingThread = thread.supervisor.removeProfile({ ...accountOnly(thread.request), home: threadHome, existingChild: threadChild }); await flush(thread.timer); await rejects(removingThread, "SUPERVISOR_UNAVAILABLE"); expect(thread.removals()).toBe(0); const threadShutdown = thread.supervisor.shutdown(); await flush(thread.timer); await threadShutdown; start.resolve(); await rejects(opening, "CHILD_GENERATION_STALE"); await flush(thread.timer); expect(thread.removals()).toBe(0);

    const account = await harness({ profileRemovalTimeoutMs: 1 }); const accountHome = await account.homes.ensure(account.request.profile); account.processes.cooperateNext = true;
    const accountChild = await account.supervisor.ensure(account.request); const read = deferred<void>(); account.clients.readGate = read.promise;
    const reading = account.supervisor.readAccount(accountChild); await until(() => account.clients.accountCalls.includes("read")); const removingAccount = account.supervisor.removeProfile({ ...accountOnly(account.request), home: accountHome, existingChild: accountChild }); await flush(account.timer); await rejects(removingAccount, "SUPERVISOR_UNAVAILABLE"); expect(account.removals()).toBe(0); read.resolve(); await rejects(reading, "CHILD_GENERATION_STALE"); await flush(account.timer); expect(account.removals()).toBe(0); const shutdown = account.supervisor.shutdown(); await flush(account.timer); await shutdown;

    const cancelled = deferred<void>(); const coordinator = await harness({ profileRemovalTimeoutMs: 1, removalTurnCoordinator: { cancelAndWait: async () => cancelled.promise } }); const coordinatorHome = await coordinator.homes.ensure(coordinator.request.profile); coordinator.processes.cooperateNext = true;
    const coordinatorChild = await coordinator.supervisor.ensure(coordinator.request); await coordinator.supervisor.open(coordinator.request, binding("removal-coordinator-gate", coordinator.receipt, 1)); await coordinator.supervisor.updateBindingActivity(coordinatorChild, handle("removal-coordinator-gate"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    const removingCoordinator = coordinator.supervisor.removeProfile({ ...accountOnly(coordinator.request), home: coordinatorHome, existingChild: coordinatorChild }); await flush(coordinator.timer); await rejects(removingCoordinator, "SUPERVISOR_UNAVAILABLE"); expect(coordinator.removals()).toBe(0); cancelled.resolve(); await flush(coordinator.timer); expect(coordinator.removals()).toBe(0);
  });
  test("an exit during a stuck removal is finalised once and cannot delete before fresh official logout", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); const home = await h.homes.ensure(h.request.profile); h.processes.cooperateNext = true;
    const child = await h.supervisor.ensure(h.request); const logout = deferred<void>(); h.clients.logoutGate = logout.promise;
    const removing = h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child }); await until(() => h.clients.accountCalls.includes("logout"));
    h.processes.children[0]!.exit(); await flush(h.timer); await rejects(removing, "SUPERVISOR_UNAVAILABLE"); await until(() => h.runtime.releases === 1);
    expect(h.removals()).toBe(0); logout.resolve(); await flush(h.timer); expect(h.runtime.releases).toBe(1); expect(h.removals()).toBe(0);
    h.clients.logoutGate = undefined; h.processes.cooperateNext = true;
    await h.supervisor.removeProfile({ ...accountOnly(h.request), home });
    expect(h.processes.children).toHaveLength(2); expect(h.runtime.releases).toBe(2); expect(h.removals()).toBe(1);
  });
  test("a gated child exiting after no-coordinator failure cleans up once and fresh retry performs official logout", async () => {
    const h = await harness(); const home = await h.homes.ensure(h.request.profile); const child = await h.supervisor.ensure(h.request);
    await h.supervisor.open(h.request, binding("exit-after-failed-removal", h.receipt, 1));
    await h.supervisor.updateBindingActivity(child, handle("exit-after-failed-removal"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    await rejects(h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child }), "SUPERVISOR_UNAVAILABLE");
    expect(h.removals()).toBe(0); h.processes.children[0]!.exit(); await until(() => h.runtime.releases === 1);
    expect(h.removals()).toBe(0); expect(h.runtime.releases).toBe(1);
    h.processes.cooperateNext = true;
    await h.supervisor.removeProfile({ ...accountOnly(h.request), home });
    expect(h.processes.children).toHaveLength(2); expect(h.clients.accountCalls).toEqual(["logout"]); expect(h.runtime.releases).toBe(2); expect(h.removals()).toBe(1);
  });
  test("re-enters exact exit finalization when a child exits during a coordinator attempt that later fails", async () => {
    let coordinatorStarted = false; const releaseCoordinator = deferred<void>();
    const h = await harness({ removalTurnCoordinator: { cancelAndWait: async () => { coordinatorStarted = true; await releaseCoordinator.promise; } } }); const home = await h.homes.ensure(h.request.profile); const child = await h.supervisor.ensure(h.request);
    await h.supervisor.open(h.request, binding("coordinator-exit", h.receipt, 1)); await h.supervisor.updateBindingActivity(child, handle("coordinator-exit"), { activeTurns: 1, pendingRequests: 0, outstandingRpcs: 0 });
    const removing = h.supervisor.removeProfile({ ...accountOnly(h.request), home, existingChild: child }); await until(() => coordinatorStarted);
    h.processes.children[0]!.exit(); releaseCoordinator.resolve(); await rejects(removing, "SUPERVISOR_UNAVAILABLE"); await until(() => h.runtime.releases === 1);
    expect(h.removals()).toBe(0); expect(h.runtime.releases).toBe(1);
  });
  test("shutdown contains a spawned start that finishes after its bounded wait", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); const home = await h.homes.ensure(h.request.profile); const initialized = deferred<void>(); h.clients.initializeGate = initialized.promise; h.processes.cooperateNext = true;
    const starting = h.supervisor.ensure(h.request); await until(() => h.processes.children.length === 1); const removing = h.supervisor.removeProfile({ ...accountOnly(h.request), home }); await flush(h.timer); await rejects(removing, "SUPERVISOR_UNAVAILABLE"); const shutdown = h.supervisor.shutdown(); await flush(h.timer); await shutdown;
    // Shutdown returned only after it contained the already-spawned child,
    // not merely after it stopped awaiting initialize().
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(h.runtime.releases).toBe(1);
    initialized.resolve(); await flush(h.timer); await rejects(starting, "SUPERVISOR_UNAVAILABLE");
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(h.runtime.releases).toBe(1); expect(h.removals()).toBe(0);
  });
  test("a late connect after shutdown closes only its new client and never re-signals the contained pid", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); const connected = deferred<void>(); h.clients.connectGate = connected.promise; h.processes.cooperateNext = true;
    const starting = h.supervisor.ensure(h.request); await until(() => h.processes.children.length === 1);
    const shutdown = h.supervisor.shutdown(); await flush(h.timer); await shutdown;
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(h.runtime.releases).toBe(1);
    connected.resolve(); await flush(h.timer); await rejects(starting, "SUPERVISOR_UNAVAILABLE");
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(h.runtime.releases).toBe(1);
  });
  test("a removal timeout contains an unpublished matching start without shutdown", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); const home = await h.homes.ensure(h.request.profile); const connected = deferred<void>(); h.clients.connectGate = connected.promise; h.processes.cooperateNext = true;
    const starting = h.supervisor.ensure(h.request); await until(() => h.processes.children.length === 1);
    const removing = h.supervisor.removeProfile({ ...accountOnly(h.request), home }); await flush(h.timer); await rejects(removing, "SUPERVISOR_UNAVAILABLE");
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(h.runtime.releases).toBe(1); expect(h.removals()).toBe(0);
    connected.resolve(); await flush(h.timer); await rejects(starting, "SUPERVISOR_UNAVAILABLE");
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(h.runtime.releases).toBe(1);
  });
  test("a timeout with an unproven pending process permanently blocks a removal retry", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); const home = await h.homes.ensure(h.request.profile); const connected = deferred<void>(); h.clients.connectGate = connected.promise;
    const starting = h.supervisor.ensure(h.request); await until(() => h.processes.children.length === 1);
    const removing = h.supervisor.removeProfile({ ...accountOnly(h.request), home }); await flush(h.timer); await rejects(removing, "SUPERVISOR_UNAVAILABLE"); await flush(h.timer);
    await rejects(h.supervisor.removeProfile({ ...accountOnly(h.request), home }), "SUPERVISOR_UNAVAILABLE"); expect(h.processes.children).toHaveLength(1);
    connected.resolve(); await flush(h.timer); await rejects(starting, "SUPERVISOR_UNAVAILABLE");
  });
  test("shutdown waits through each bounded containment signal stage before reporting completion", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); const connected = deferred<void>(); h.clients.connectGate = connected.promise; h.processes.stallSignalsNext = true;
    const starting = h.supervisor.ensure(h.request); await until(() => h.processes.children.length === 1);
    let settled = false; const shutdown = h.supervisor.shutdown().then(() => { settled = true; }); await microtasks(); expect(settled).toBe(false);
    // Admission timeout enters the bounded tree-containment edge before
    // shutdown may report completion.
    h.timer.next(); await microtasks(); expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]); expect(settled).toBe(false);
    h.processes.children[0]!.releaseSignalStalls(); connected.resolve(); await microtasks(); await flush(h.timer); await rejects(starting, "SUPERVISOR_UNAVAILABLE"); await shutdown; expect(settled).toBe(true);
  });
  test("a superseded normal stop never signals its exact child a second time", async () => {
    const h = await harness({ profileRemovalTimeoutMs: 1 }); h.processes.cooperateNext = true;
    const child = await h.supervisor.ensure(h.request); const start = deferred<void>(); h.clients.startGate = start.promise;
    const opening = h.supervisor.open(h.request, binding("stale-stop", h.receipt, 1)); await until(() => h.clients.startedCwds.length === 1);
    const draining = h.supervisor.drain(child); const shutdown = h.supervisor.shutdown(); await flush(h.timer); await shutdown;
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]);
    start.resolve(); await rejects(opening, "CHILD_GENERATION_STALE"); await draining;
    expect(h.processes.children[0]?.signals).toEqual(["SIGTERM"]);
  });
});

async function harness(config: { readonly environment?: Readonly<Record<string, string>>; readonly pathDelimiter?: string; readonly servicePath?: string; readonly bindings?: CodexBindingStore; readonly removalTurnCoordinator?: import("../../src/internal").ProfileRemovalTurnCoordinator; readonly removalFails?: boolean; readonly profileRemovalTimeoutMs?: number } = {}) {
  const fs = new FakeFilesystem(); fs.dir("/"); fs.dir("/workspace");
  const snapshots = new Snapshots([snap()]); const clock = new Clock(); const timer = new Timer();
  const authority = new CodexWorkspaceReceiptAuthority({ snapshots, filesystem: fs, clock, newHandle: () => handle("receipt"), hmacKey: "persistent-host-key" });
  const receipt = await authority.mint(); const runtime = new Runtime(); const processes = new Processes(); const clients = new Clients(); const bindings = config.bindings ?? new InMemoryCodexBindingStore(); let removals = 0;
  const terminal = { result: true, never: false }; const faults: unknown[] = [];
  const homes = new CodexProfileHomeRegistry({ rootPath: "/profiles", trustedParentPath: "/", filesystem: fs, currentUid: () => 501, removalFilesystem: { removeOwnedProfileHome: async (input) => { removals += 1; if (config.removalFails && removals === 1) throw new Error("delete failed"); input.assertAuthorizedNow(); input.commitDestruction(); } } });
  const supervisor = new CodexProfileSupervisor({ workspaces: authority, homes, serviceDirectory: new CodexServiceDirectory({ path: config.servicePath ?? "/service", trustedParentPath: "/", filesystem: fs, currentUid: () => 501 }), runtimes: runtime, processes, clients, bindings, clock, timer, idleReapMs: 60_000, initializeTimeoutMs: 10, interruptGraceMs: 1, ...(config.profileRemovalTimeoutMs ? { profileRemovalTimeoutMs: config.profileRemovalTimeoutMs } : {}), ...(config.environment ? { environment: config.environment } : {}), ...(config.pathDelimiter ? { pathDelimiter: config.pathDelimiter } : {}), ...(config.removalTurnCoordinator ? { removalTurnCoordinator: config.removalTurnCoordinator } : {}), turnTerminal: { wait: async () => terminal.never ? new Promise<boolean>(() => undefined) : terminal.result }, onFault: async (fault) => { faults.push(fault); } });
  return { supervisor, homes, bindings, removals: () => removals, authority, receipt, runtime, processes, clients, timer, snapshots, terminal, faults, request: { profile: profile("p"), accountGeneration: 2, runtimeGeneration: 7, workspace: receipt } satisfies SupervisorRequest };
}
function accountOnly(request: SupervisorRequest) { return { profile: request.profile, accountGeneration: request.accountGeneration, runtimeGeneration: request.runtimeGeneration }; }
function snap(overrides: Partial<CurrentFolderSnapshot> = {}): CurrentFolderSnapshot { return { actorId: "human", relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop", pairingGenerationRef: "pairing-ref", capabilityRevision: 3, revision: 4, selectedPath: "/workspace", ...overrides }; }
function profile(id: string) { return { actorId: "human", profileHandle: handle(id), profileGeneration: 1 }; }
function binding(id: string, workspace: SupervisorRequest["workspace"], generation: number) { return { bindingId: handle(id), bindingGeneration: generation, workspace, taskId: "task-a", jobId: "job-a", workingDirectory: "/workspace", threadId: "host-thread-1", posture: { kind: "codex_default" } as const }; }
async function rejects(work: Promise<unknown>, code: string) { try { await work; } catch (error) { expect(error).toMatchObject({ code }); return; } throw new Error(`Expected ${code}`); }
async function rejectsFailure(work: Promise<unknown>) { try { await work; } catch { return; } throw new Error("Expected failure"); }
async function flush(timer: Timer) { for (let i = 0; i < 32; i += 1) { await Promise.resolve(); timer.next(); } }
async function microtasks() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i += 1) { if (predicate()) return; await Promise.resolve(); } throw new Error("condition not reached"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((next) => { resolve = next; }); return { promise, resolve }; }

class Clock implements HostClock { now() { return 0; } }
class Snapshots { private index = 0; private gate: Promise<void> | undefined; private resolveGate: (() => void) | undefined; private waiting = false; constructor(private readonly values: CurrentFolderSnapshot[]) {} push(value: CurrentFolderSnapshot) { this.values.push(value); } blockNext() { this.gate = new Promise((resolve) => { this.resolveGate = resolve; }); } isBlocked() { return this.waiting; } release() { this.resolveGate?.(); } async read() { const gate = this.gate; this.gate = undefined; if (gate) { this.waiting = true; await gate; this.waiting = false; } return this.values[Math.min(this.index++, this.values.length - 1)]!; } }
class Timer implements HostTimer { private callbacks = new Map<number, () => void>(); private id = 0; setTimeout(callback: () => void, _delay: number): HostTimerHandle { const id = ++this.id; this.callbacks.set(id, callback); return { __hostTimerHandle: id } as unknown as HostTimerHandle; } clearTimeout(timer: HostTimerHandle) { this.callbacks.delete((timer as unknown as { __hostTimerHandle: number }).__hostTimerHandle); } next() { const value = this.callbacks.entries().next().value as [number, () => void] | undefined; if (!value) return; this.callbacks.delete(value[0]); value[1](); } }

type Entry = { type: "dir" | "file" | "symlink"; mode: number; uid: number; dev: number; ino: number; target?: string; text?: string };
class FakeFilesystem implements HostFilesystem {
  private readonly entries = new Map<string, Entry>(); private inode = 1; readonly chmods: string[] = []; readonly mkdirs: string[] = []; private lstatCount = 0; swapAliasOnSecondLstat = false;
  dir(path: string) { this.entries.set(normalize(path), this.entry("dir")); } symlink(path: string, target: string) { this.entries.set(normalize(path), { ...this.entry("symlink"), target: normalize(target) }); }
  mutate(path: string, patch: Partial<Entry>) { Object.assign(this.must(path), patch); }
  async lstat(path: string) { this.lstatCount += 1; if (this.swapAliasOnSecondLstat && this.lstatCount === 2) this.dir(path); return this.statAt(path, false); } async stat(path: string) { return this.statAt(path, true); } async realpath(path: string) { const e = this.must(path); return e.type === "symlink" ? e.target! : normalize(path); }
  async mkdir(path: string, _options: { readonly recursive: boolean; readonly mode: number }) { this.mkdirs.push(normalize(path)); const key = normalize(path); if (this.entries.has(key)) return false; this.dir(key); return true; }
  async chmod(path: string, mode: number) { this.chmods.push(normalize(path)); this.must(path).mode = mode; }
  async writeFile(path: string, text: string, options: { readonly mode: number; readonly flag: "wx" | "w" }) { const key = normalize(path); if (options.flag === "wx" && this.entries.has(key)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); this.entries.set(key, { ...this.entry("file"), mode: options.mode, text }); }
  async readFile(path: string) { const e = this.must(path); if (e.type !== "file" || e.text === undefined) throw new Error("not file"); return e.text; } async unlink(path: string) { this.entries.delete(normalize(path)); } async rename(from: string, to: string) { const entry = this.must(from); this.entries.delete(normalize(from)); this.entries.set(normalize(to), entry); }
  private statAt(path: string, follow: boolean): HostFileStat { const original = this.must(path); const e = follow && original.type === "symlink" ? this.must(original.target!) : original; return { mode: e.mode, uid: e.uid, dev: e.dev, ino: e.ino, isDirectory: e.type === "dir", isSymbolicLink: !follow && original.type === "symlink" }; }
  private must(path: string) { const e = this.entries.get(normalize(path)); if (!e) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return e; } private entry(type: Entry["type"]): Entry { return { type, mode: 0o700, uid: 501, dev: 1, ino: this.inode++ }; }
}
class GatedBindingStore extends InMemoryCodexBindingStore {
  completeOpenGate: Promise<void> | undefined; completeRebindGate: Promise<void> | undefined;
  openCompleting = false; rebindCompleting = false;
  override async completeOpen(...args: Parameters<InMemoryCodexBindingStore["completeOpen"]>) {
    this.openCompleting = true; await this.completeOpenGate; return super.completeOpen(...args);
  }
  override async completeRebind(...args: Parameters<InMemoryCodexBindingStore["completeRebind"]>) {
    this.rebindCompleting = true; await this.completeRebindGate; return super.completeRebind(...args);
  }
}
class Runtime implements RuntimeProvider { afterAcquire: (() => void) | undefined; pathEntries: readonly string[] | undefined; releases = 0; async acquire(generation: number) { this.afterAcquire?.(); return { launch: { executablePath: "/verified/codex", args: ["app-server"], ...(this.pathEntries ? { pathEntries: this.pathEntries } : {}), runtimeGeneration: generation }, lease: { release: async () => { this.releases += 1; } } satisfies RuntimeLease }; } }
const emptyStream: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true as const, value: undefined }) }) };
class Process implements ManagedChildProcess { readonly stdio: ChildStdio = { stdin: { write: async () => undefined, end: async () => undefined }, stdout: emptyStream, stderr: emptyStream }; readonly signals: string[] = []; private resolve!: (value: { code: number | null; signal: string | null }) => void; private exitedState = false; readonly exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { this.resolve = (value) => { this.exitedState = true; resolve(value); }; }); constructor(readonly pid: number, private readonly cooperate: boolean, private readonly groupLive: boolean, private stallSignals: boolean, private readonly rejectSignals: boolean, readonly codexHome: string) {} releaseSignalStalls() { this.stallSignals = false; } exit() { this.resolve({ code: 0, signal: null }); } async isProcessGroupGone() { return this.exitedState && !this.groupLive; } async sendInterrupt() { this.signals.push("SIGINT"); if (this.rejectSignals) throw Object.assign(new Error("denied"), { code: "EPERM" }); if (this.stallSignals) await new Promise<void>(() => undefined); if (this.cooperate || this.groupLive) this.resolve({ code: 0, signal: "SIGINT" }); } async signalProcessGroup(signal: "SIGTERM" | "SIGKILL") { this.signals.push(signal); if (this.rejectSignals) throw Object.assign(new Error("denied"), { code: "EPERM" }); if (this.stallSignals) await new Promise<void>(() => undefined); if (this.cooperate && signal === "SIGTERM") this.resolve({ code: 0, signal }); } }
class Processes implements ProcessHost { readonly children: Process[] = []; readonly specs: import("../../src/internal").SpawnSpec[] = []; cooperateNext = false; leaderExitGroupLiveNext = false; stallSignalsNext = false; rejectSignalsNext = false; async spawn(spec: import("../../src/internal").SpawnSpec) { this.specs.push(spec); const child = new Process(this.children.length + 1, this.cooperateNext, this.leaderExitGroupLiveNext, this.stallSignalsNext, this.rejectSignalsNext, spec.env["CODEX_HOME"]!); this.cooperateNext = false; this.leaderExitGroupLiveNext = false; this.stallSignalsNext = false; this.rejectSignalsNext = false; this.children.push(child); return child; } }
class Clients implements AppServerClientFactory {
  startedCwds: string[] = []; resumedCwds: string[] = []; interrupted: Array<{ readonly threadId: string; readonly turnId: string }> = [];
  closed = 0;
  accountCalls: string[] = []; loginGate: Promise<void> | undefined; readGate: Promise<void> | undefined; logoutGate: Promise<void> | undefined;
  failNextInitialize = false; rejectInterrupt = false; rejectStart = false; rejectLogout = false; codexHomeOverride: string | undefined; connectGate: Promise<void> | undefined; initializeGate: Promise<void> | undefined; startGate: Promise<void> | undefined; resumeGate: Promise<void> | undefined;
  private count = 0;
  async connect(child: ManagedChildProcess): Promise<AppServerClient> {
    await this.connectGate;
    const fail = this.failNextInitialize; this.failNextInitialize = false;
    return {
      initialize: async () => { if (fail) throw new Error("init"); await this.initializeGate; return { codexHome: this.codexHomeOverride ?? (child as Process).codexHome }; },
      startChatgptLogin: async () => { this.accountCalls.push("login"); await this.loginGate; return { upstreamLoginId: "upstream", authUrl: "https://chatgpt.com/auth" }; },
      cancelLogin: async () => { this.accountCalls.push("cancel"); return { cancelled: true }; },
      readAccount: async () => { this.accountCalls.push("read"); await this.readGate; return { state: "signed_out", requiresOpenaiAuth: true }; },
      readUsage: async () => ({ dailyUsage: [] }),
      listModels: async () => ({ models: [] }),
      logout: async () => { this.accountCalls.push("logout"); await this.logoutGate; if (this.rejectLogout) throw new Error("logout"); },
      startThread: async ({ cwd }) => { if (this.rejectStart) throw new Error("start"); this.startedCwds.push(cwd); await this.startGate; return { threadId: `host-thread-${++this.count}`, cwd }; },
      resumeThread: async ({ cwd }) => { this.resumedCwds.push(cwd); await this.resumeGate; return { cwd }; },
      startTurn: async () => ({ turnId: `host-turn-${++this.count}` }),
      interruptThread: async (input) => { this.interrupted.push(input); if (this.rejectInterrupt) throw new Error("rpc"); },
      steerThread: async () => undefined,
      close: async () => { this.closed += 1; },
    };
  }
}
