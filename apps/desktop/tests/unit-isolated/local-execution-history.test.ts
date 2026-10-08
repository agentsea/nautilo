import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  LocalExecutionHistoryStore,
  parseLocalExecutionHistoryRecord,
  type LocalExecutionHistoryRecord,
  type LocalExecutionHistoryScope,
  type LocalExecutionHistoryStorage,
} from "../../electron/local-execution-history";
import { LocalExecutionHost, type LocalExecutionSnapshot } from "../../electron/local-execution-host";
import type { LocalProcessExit } from "../../electron/local-execution-process";

const roots: string[] = [];
const hosts: LocalExecutionHost[] = [];
const header = Buffer.from("nautilo-local-execution-history-v1\0");
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.finishDisposal();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function record(state: LocalExecutionSnapshot["state"] = "completed"): LocalExecutionHistoryRecord {
  const data = "private build diagnostic α😀\n";
  return {
    version: 1,
    scope: { instanceId: "instance-a", origin: "https://server.example", serverFingerprint: "server-fingerprint-a",
      humanUserId: "human-a", relayId: "relay-a", pairingGeneration: "pair-a" },
    owner: { instanceId: "instance-a", humanUserId: "human-a", agentId: "agent-a", runId: "run-a",
      conversationId: "room:room-a:bot:agent-a", relayId: "relay-a", desktopSessionId: "desktop-a",
      pairingGeneration: "pair-a", serverBindingId: "server-a", profileId: "profile-a", profileRevision: 1,
      grantIds: ["grant-a"], grantRevision: 1, protectedPolicyVersion: 1 },
    generation: "generation-a",
    snapshot: { executionId: "execution-a", state, tty: false, pid: 42,
      exitCode: state === "completed" ? 0 : null, signal: state === "cancelled" ? "SIGKILL" : null,
      terminationScope: "owned_process_group", failureCode: state === "failed" ? "LOCAL_EXECUTION_START_FAILED" : null,
      expiresAt: null, resources: "released",
      output: { data, cursor: 0, nextCursor: Buffer.byteLength(data), availableFrom: 0,
        produced: Buffer.byteLength(data), gap: false, hasMore: false } },
  };
}

/** Real authenticated ciphertext exercises disk round trips without an OS keychain. */
function encryptedStorage() {
  const key = Buffer.alloc(32, 0x42);
  const calls = { encrypt: 0, decrypt: 0 };
  const hooks: { encrypt: (() => void) | null; decrypt: (() => void) | null } = { encrypt: null, decrypt: null };
  const protection = { available: true, backend: "keychain" };
  const storage: LocalExecutionHistoryStorage = {
    isEncryptionAvailable: () => protection.available,
    getSelectedStorageBackend: () => protection.backend,
    encryptString(value) {
      calls.encrypt += 1;
      hooks.encrypt?.();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      calls.decrypt += 1;
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
      hooks.decrypt?.();
      return plaintext;
    },
  };
  return { storage, calls, hooks, protection };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "nautilo-execution-history-test-"));
  roots.push(root);
  const directory = path.join(root, "history");
  const crypto = encryptedStorage();
  const options = { directory, storage: crypto.storage };
  const store = new LocalExecutionHistoryStore(options);
  const archiveFile = async () => {
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toEndWith(".sealed");
    return path.join(directory, names[0]!);
  };
  return { root, directory, options, store, archiveFile, ...crypto };
}

function read(store: LocalExecutionHistoryStore, value: LocalExecutionHistoryRecord = record(), scope = value.scope) {
  return store.read(scope, value.generation, value.snapshot.executionId);
}

async function expectError(operation: Promise<unknown>, message: string): Promise<void> {
  const outcome: unknown = await operation.then(() => null, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toBe(message);
}

describe("encrypted managed execution history", () => {
  for (const state of ["completed", "failed", "cancelled", "unknown"] as const) {
    test(`a fresh store restores exact ${state} truth and the final Unicode window`, async () => {
      const f = await fixture();
      const value = record(state);
      await f.store.save(value);
      const restarted = new LocalExecutionHistoryStore({ directory: f.directory, storage: encryptedStorage().storage });
      expect(await read(restarted, value)).toEqual(value);
    });
  }

  test("nonzero command completion and uncertain cleanup remain distinct", async () => {
    const f = await fixture();
    const failedBuild = record();
    const value = { ...failedBuild, snapshot: { ...failedBuild.snapshot, exitCode: 7 } };
    await f.store.save(value);
    expect(await read(f.store, value)).toMatchObject({ snapshot: { state: "completed", exitCode: 7, resources: "released" } });
    const uncertain = record("unknown");
    const cleanup = { ...uncertain, snapshot: { ...uncertain.snapshot, executionId: "execution-cleanup",
      resources: "release_failed" as const, failureCode: "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED" } };
    await f.store.save(cleanup);
    expect(await read(new LocalExecutionHistoryStore(f.options), cleanup)).toEqual(cleanup);
  });

  test("a retained output gap survives restart without recreating the lost prefix", async () => {
    const f = await fixture();
    const base = record();
    const data = "😀 final window";
    const value = { ...base, snapshot: { ...base.snapshot, output: { data, cursor: 90, availableFrom: 90,
      nextCursor: 90 + Buffer.byteLength(data), produced: 90 + Buffer.byteLength(data), gap: true, hasMore: false } } };
    await f.store.save(value);
    expect(await read(new LocalExecutionHistoryStore(f.options), value)).toEqual(value);
  });

  for (const dimension of ["instanceId", "humanUserId", "serverFingerprint", "origin", "relayId", "pairingGeneration"] as const) {
    test(`the opaque execution reference cannot bypass exact ${dimension} scope`, async () => {
      const f = await fixture();
      const value = record();
      await f.store.save(value);
      const foreign: LocalExecutionHistoryScope = { ...value.scope, [dimension]: "foreign" };
      expect(await read(f.store, value, foreign)).toBeNull();
      expect(await read(f.store, value)).toEqual(value);
    });
  }

  test("generation and execution identity are exact, and an absent archive is not a running receipt", async () => {
    const f = await fixture();
    const value = record();
    expect(await read(f.store)).toBeNull();
    await f.store.save(value);
    expect(await f.store.read(value.scope, "generation-other", value.snapshot.executionId)).toBeNull();
    expect(await f.store.read(value.scope, value.generation, "execution-other")).toBeNull();
  });

  for (const state of ["starting", "running", "cancelling"] as const) {
    test(`${state} cannot become a durable final receipt`, async () => {
      const f = await fixture();
      expect(parseLocalExecutionHistoryRecord(record(state))).toBeNull();
      await expectError(f.store.save(record(state)), "LOCAL_EXECUTION_HISTORY_INVALID");
      expect(await read(f.store)).toBeNull();
    });
  }

  test("malformed enums, unsafe cursors, incomplete windows and live ownership fail closed", async () => {
    const base = record();
    const malformed: unknown[] = [
      { ...base, snapshot: { ...base.snapshot, state: ["completed"] } },
      { ...base, snapshot: { ...base.snapshot, resources: ["released"] } },
      { ...base, snapshot: { ...base.snapshot, resources: "owned" } },
      { ...base, snapshot: { ...base.snapshot, resources: "release_failed" } },
      { ...base, snapshot: { ...base.snapshot, expiresAt: 1234 } },
      { ...base, owner: { ...base.owner, humanUserId: "foreign" } },
      { ...base, owner: { ...base.owner, instanceId: "foreign" } },
      { ...base, owner: { ...base.owner, relayId: "foreign" } },
      { ...base, owner: { ...base.owner, pairingGeneration: "foreign" } },
      ...[
        { nextCursor: Number.MAX_SAFE_INTEGER + 1 }, { cursor: 1 }, { produced: 0 },
        { data: "different byte length" }, { gap: true }, { hasMore: true },
      ].map(output => ({ ...base, snapshot: { ...base.snapshot, output: { ...base.snapshot.output, ...output } } })),
    ];
    for (const value of malformed) expect(parseLocalExecutionHistoryRecord(value)).toBeNull();
  });

  test("only ciphertext is persisted with private file and directory permissions", async () => {
    const f = await fixture();
    const value = record();
    await f.store.save(value);
    const file = await f.archiveFile();
    const bytes = await fs.readFile(file);
    expect(bytes.subarray(0, header.length)).toEqual(header);
    for (const plaintext of [value.snapshot.output.data, value.scope.humanUserId, value.owner.conversationId]) {
      expect(bytes.includes(Buffer.from(plaintext))).toBe(false);
    }
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(f.directory)).mode & 0o777).toBe(0o700);
  });

  for (const unavailable of ["unavailable", "basic_text"] as const) {
    test(`${unavailable} protection never writes plaintext or decrypts a saved receipt`, async () => {
      const f = await fixture();
      if (unavailable === "unavailable") f.protection.available = false;
      else f.protection.backend = "basic_text";
      await expectError(f.store.save(record()), "LOCAL_EXECUTION_HISTORY_PROTECTION_UNAVAILABLE");
      expect(f.calls).toEqual({ encrypt: 0, decrypt: 0 });
      expect(await fs.readdir(f.root)).toEqual([]);
      f.protection.available = true;
      f.protection.backend = "keychain";
      await f.store.save(record());
      const bytes = await fs.readFile(await f.archiveFile());
      const decrypts = f.calls.decrypt;
      if (unavailable === "unavailable") f.protection.available = false;
      else f.protection.backend = "basic_text";
      await expectError(read(f.store), "LOCAL_EXECUTION_HISTORY_PROTECTION_UNAVAILABLE");
      expect(f.calls.decrypt).toBe(decrypts);
      expect(await fs.readFile(await f.archiveFile())).toEqual(bytes);
    });
  }

  test("concurrent identical saves are idempotent while a conflicting final receipt cannot overwrite", async () => {
    const f = await fixture();
    const value = record();
    await Promise.all([f.store.save(value), f.store.save(structuredClone(value)), f.store.save(value)]);
    const before = await fs.readFile(await f.archiveFile());
    expect(f.calls.encrypt).toBe(1);
    await expectError(f.store.save({ ...value, snapshot: { ...value.snapshot, exitCode: 7 } }), "LOCAL_EXECUTION_HISTORY_CONFLICT");
    await expectError(f.store.save({ ...value, scope: { ...value.scope, serverFingerprint: "foreign" } }), "LOCAL_EXECUTION_HISTORY_CONFLICT");
    expect(await fs.readFile(await f.archiveFile())).toEqual(before);
    expect(await read(f.store)).toEqual(value);
  });

  test("save captures its caller's record before queued work can observe later mutation", async () => {
    const f = await fixture();
    const value = record();
    const expected = structuredClone(value);
    const pending = f.store.save(value);
    Object.assign(value.snapshot.output, { data: "changed" });
    await pending;
    expect(await read(f.store)).toEqual(expected);
  });

  test("parallel final receipts retain every execution rather than losing a queued update", async () => {
    const f = await fixture();
    const values = ["first", "second", "third"].map(executionId => {
      const value = record();
      return { ...value, snapshot: { ...value.snapshot, executionId } };
    });
    await Promise.all(values.map(value => f.store.save(value)));
    const restarted = new LocalExecutionHistoryStore(f.options);
    for (const value of values) expect(await read(restarted, value)).toEqual(value);
    expect(await fs.readdir(f.directory)).toHaveLength(values.length);
  });

  for (const corruption of ["unknown-header", "unknown-version", "corrupt-ciphertext", "foreign-key-record"] as const) {
    test(`${corruption} remains byte-for-byte preserved through failed reads and saves`, async () => {
      const f = await fixture();
      const value = record();
      await f.store.save(value);
      const file = await f.archiveFile();
      const malformed = corruption === "unknown-header" ? Buffer.from("nautilo-local-execution-history-v2\0future")
        : corruption === "corrupt-ciphertext" ? Buffer.concat([header, Buffer.from("broken ciphertext")])
          : Buffer.concat([header, f.storage.encryptString(JSON.stringify(corruption === "unknown-version"
            ? { ...value, version: 2 } : { ...value, generation: "foreign-generation" }))]);
      await fs.writeFile(file, malformed);
      await expectError(read(f.store), "LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
      await expectError(f.store.save(value), "LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
      expect(await fs.readFile(file)).toEqual(malformed);
      expect(await fs.readdir(f.directory)).toHaveLength(1);
      await f.store.clear();
      expect(await read(f.store)).toBeNull();
    });
  }

  test("sealed-file symlinks are denied without reading or overwriting their external target", async () => {
    const f = await fixture();
    await f.store.save(record());
    const file = await f.archiveFile();
    const outside = path.join(f.root, "external.sealed");
    const original = await fs.readFile(file);
    await fs.rename(file, outside);
    await fs.symlink(outside, file);
    const decrypts = f.calls.decrypt;
    await expectError(read(f.store), "LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
    await expectError(f.store.save(record()), "LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
    expect(f.calls.decrypt).toBe(decrypts);
    expect(await fs.readFile(outside)).toEqual(original);
    await f.store.clear();
    expect(await fs.readFile(outside)).toEqual(original);
  });

  test("directory symlinks are denied and explicit clear removes the link, not its target", async () => {
    const f = await fixture();
    await f.store.save(record());
    const fileName = path.basename(await f.archiveFile());
    const outside = path.join(f.root, "external-history");
    await fs.rename(f.directory, outside);
    await fs.symlink(outside, f.directory);
    const before = await fs.readFile(path.join(outside, fileName));
    await expectError(read(f.store), "LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
    await expectError(f.store.save(record()), "LOCAL_EXECUTION_HISTORY_INVALID");
    await f.store.clear();
    expect(await fs.readFile(path.join(outside, fileName))).toEqual(before);
  });

  test("clear fences queued saves and reads, then permits a new explicit save", async () => {
    const f = await fixture();
    const save = f.store.save(record());
    const pendingRead = read(f.store);
    const clear = f.store.clear();
    await Promise.all([save, clear]);
    expect(await pendingRead).toBeNull();
    expect(f.calls.encrypt).toBe(0);
    expect(await fs.readdir(f.root)).toEqual([]);
    await f.store.save(record());
    expect(await read(f.store)).toEqual(record());
  });

  test("clear during an in-flight encrypted write cannot resurrect the old record", async () => {
    const f = await fixture();
    const clears: Promise<void>[] = [];
    f.hooks.encrypt = () => { clears.push(f.store.clear()); };
    await f.store.save(record());
    expect(clears).toHaveLength(1);
    await Promise.all(clears);
    expect(await fs.readdir(f.root)).toEqual([]);
    expect(await read(f.store)).toBeNull();
  });

  test("clear during decryption prevents an already-read receipt escaping to its caller", async () => {
    const f = await fixture();
    await f.store.save(record());
    const clears: Promise<void>[] = [];
    f.hooks.decrypt = () => { clears.push(f.store.clear()); };
    expect(await read(f.store)).toBeNull();
    expect(clears).toHaveLength(1);
    await Promise.all(clears);
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  test("synchronous host settlement captures the pre-clear epoch before pending history flush", async () => {
    const f = await fixture();
    const host = new LocalExecutionHost({ retention: { maxOutputBytes: 1024, maxTotalOutputBytes: 4096,
      maxExecutions: 8, maxActiveExecutions: 4, completedTtlMs: 1000, maxInputRequestsPerExecution: 8 } });
    hosts.push(host);
    const value = record("cancelled");
    let saves = 0;
    host.subscribeSettled((snapshot, ownerKey) => {
      expect(ownerKey).toBe("trusted-owner");
      saves += 1;
      return f.store.save({ ...value, generation: host.hostGeneration, snapshot: { ...snapshot, expiresAt: null } });
    });
    host.reserveCancellation({ executionId: value.snapshot.executionId, ownerKey: "trusted-owner", hostGeneration: host.hostGeneration });
    const clearing = f.store.clear();
    await host.finishDisposal();
    await clearing;
    expect(saves).toBe(1);
    expect(f.calls.encrypt).toBe(0);
    expect(await fs.readdir(f.root)).toEqual([]);
    expect(await f.store.read(value.scope, host.hostGeneration, value.snapshot.executionId)).toBeNull();
  });

  test("the host archives only after final output drain and resource disposal, then restart restores exit seven", async () => {
    const f = await fixture();
    let finish!: (exit: LocalProcessExit) => void;
    const exited = new Promise<LocalProcessExit>(resolve => { finish = resolve; });
    let release!: () => void;
    const disposal = new Promise<void>(resolve => { release = resolve; });
    let markDisposing!: () => void;
    const disposing = new Promise<void>(resolve => { markDisposing = resolve; });
    let markSpawned!: () => void;
    const spawned = new Promise<void>(resolve => { markSpawned = resolve; });
    const host = new LocalExecutionHost({ retention: { maxOutputBytes: 1024, maxTotalOutputBytes: 4096,
      maxExecutions: 8, maxActiveExecutions: 4, completedTtlMs: 1000, maxInputRequestsPerExecution: 8 },
    spawn(_prepared, _tty, output) {
      const finalBytes = Buffer.from("final diagnostic α😀\n");
      // Split a code point as a real process pipe can do; final capture must decode it once.
      output("stdout", finalBytes.subarray(0, finalBytes.length - 2));
      output("stdout", finalBytes.subarray(finalBytes.length - 2));
      markSpawned();
      return { pid: 42, exited, write() {}, terminate() { finish({ exitCode: null, signal: "SIGKILL" }); } };
    } });
    hosts.push(host);
    const value = record();
    let markArchived!: () => void;
    const archived = new Promise<void>(resolve => { markArchived = resolve; });
    let saves = 0;
    host.subscribeSettled(async snapshot => {
      saves += 1;
      await f.store.save({ ...value, generation: host.hostGeneration, snapshot: { ...snapshot, expiresAt: null } });
      markArchived();
    });
    host.start({ executionId: value.snapshot.executionId, requestIdentity: "actual-tool-call",
      requestFingerprint: "exact-command-fingerprint", ownerKey: "trusted-owner", hostGeneration: host.hostGeneration,
      tty: false, prepare: async () => ({ program: "/bin/sh", args: ["-c", "fixture"], cwd: "/tmp", env: {},
        dispose: async () => { markDisposing(); await disposal; } }) });
    await spawned;
    expect(saves).toBe(0);
    finish({ exitCode: 7, signal: null });
    await disposing;
    expect(saves).toBe(0);
    expect(await fs.readdir(f.root)).toEqual([]);
    release();
    await archived;
    await host.finishDisposal();
    expect(saves).toBe(1);
    const restored = await f.store.read(value.scope, host.hostGeneration, value.snapshot.executionId);
    expect(restored).toMatchObject({ snapshot: { state: "completed", exitCode: 7, expiresAt: null,
      resources: "released", output: { data: "final diagnostic α😀\n", gap: false, hasMore: false } } });
    expect(await read(new LocalExecutionHistoryStore(f.options), restored!)).toEqual(restored);
  });
});
