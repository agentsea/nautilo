import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPrivateFilesystemPath } from "@nautilo/config/private-filesystem";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadyToWorkDesiredState, readyToWorkRememberedKey, type ReadyToWorkBinding } from "../../electron/ready-to-work-contract";
import { ReadyToWorkStore, type ReadyToWorkStoreFs } from "../../electron/ready-to-work-store";
import { ReadyToWorkProtectedReceiptStore, type ReadyToWorkSafeStorage } from "../../electron/ready-to-work-protected-receipt";
import { disableRememberedDevelopment, refreshRememberedReadyReceipt, migrateRememberedReadyToWork, removeRememberedReadyToWork, saveRememberedReadyToWork } from "../../electron/ready-to-work-persistence";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const first: ReadyToWorkBinding = { humanId: "human-a", authority: { scope: "https://one.example", serverFingerprint: "server-a", revision: "revision-a", connectionAttemptId: "attempt-a" } };
const second: ReadyToWorkBinding = { ...first, humanId: "human-b" };
const otherServer: ReadyToWorkBinding = { ...first, authority: { ...first.authority, scope: "https://two.example", serverFingerprint: "server-b" } };
const selection = { voice: true, auto_approve: false, workstation: true, computer_use: false, coding_connection: true };
const proof = { profileId: "developer-workstation", profileRevision: 2, receipt: "wsr1.synthetic-sensitive-proof" };
function cryptoPort(): ReadyToWorkSafeStorage {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test-aes-gcm",
    encryptString: text => { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    decryptString: bytes => { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); } };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-ready-migration-")); roots.push(root);
  const legacy = path.join(root, "ready-v1.json"), desiredPath = path.join(root, "ready-v2.json");
  const legacyReceipt = path.join(root, "receipt-v1.bin"), receiptPath = path.join(root, "receipt-v2.bin");
  const safeStorage = cryptoPort();
  const desired = new ReadyToWorkStore({ filePath: legacy, rememberedFilePath: desiredPath });
  const receipt = new ReadyToWorkProtectedReceiptStore({ filePath: legacyReceipt, rememberedFilePath: receiptPath, safeStorage });
  const enroll = (binding = first) => saveRememberedReadyToWork({ desired, receipt, selection: createReadyToWorkDesiredState(binding, selection), proof, isCurrent: () => true });
  const legacyEnroll = (binding = first) => { desired.save(createReadyToWorkDesiredState(binding, selection)); expect(receipt.save({ binding, ...proof })).toBe(true); };
  const recover = (binding = first) => {
    const state = desired.inspectRemembered(binding);
    if (state.status !== "ready" || !state.desired?.components.workstation) return null;
    const result = receipt.readRememberedFor(binding, state.fenceId);
    return result.ok ? result : null;
  };
  return { root, legacy, desiredPath, legacyReceipt, receiptPath, safeStorage, desired, receipt, enroll, legacyEnroll, recover };
}

test("v1 remains operational until explicit opt-in; fresh proof is OS-protected and contains no transport lookup key", () => {
  const f = fixture(); f.legacyEnroll();
  expect(f.desired.loadFor(first)?.components).toEqual(selection);
  expect(fs.existsSync(f.desiredPath)).toBe(false);
  f.enroll(); expect(f.recover()).toMatchObject(proof);
  expect(f.desired.inspect().status).toBe("unsupported");
  expect(fs.readFileSync(f.receiptPath).includes(Buffer.from(proof.receipt))).toBe(false);
  const bytes = fs.readFileSync(f.desiredPath, "utf8");
  expect(bytes).not.toContain("attempt-a"); expect(bytes).not.toContain("revision-a");
  for (const file of [f.desiredPath, f.receiptPath]) {
    expect(isPrivateFilesystemPath(file)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  }
});

test("keyed choices survive transport rotation and keep Humans, origins and fingerprints separate", () => {
  const f = fixture(); f.enroll(first); f.enroll(second); f.enroll(otherServer);
  expect(f.recover(first)).not.toBeNull(); expect(f.recover(second)).not.toBeNull(); expect(f.recover(otherServer)).not.toBeNull();
  expect(f.recover({ ...first, authority: { ...first.authority, revision: "new", connectionAttemptId: "new" } })).not.toBeNull();
  expect(f.recover({ ...first, authority: { ...first.authority, serverFingerprint: "replacement" } })).toBeNull();
  expect(f.desired.inspectRemembered(second)).toMatchObject({ desired: { humanId: second.humanId } });
});

for (const mutation of ["delete", "off", "replace-fence"] as const) {
  test(`legacy ${mutation} blocks every proof; fresh enrollment of one key never revives another`, () => {
    const f = fixture(); f.enroll(first); f.enroll(second);
    if (mutation === "delete") fs.unlinkSync(f.legacy);
    else if (mutation === "off") fs.writeFileSync(f.legacy, JSON.stringify(createReadyToWorkDesiredState(first, { ...selection, workstation: false })));
    else fs.writeFileSync(f.legacy, JSON.stringify({ version: 2, kind: "ready_to_work_migrated", fenceId: "foreign-fence" }));
    expect(f.desired.inspectRemembered(first).status).toBe("confirmation_required");
    expect(f.recover(first)).toBeNull(); expect(f.recover(second)).toBeNull();
    f.enroll(second); expect(f.recover(second)).not.toBeNull(); expect(f.recover(first)).toBeNull();
    expect(new ReadyToWorkStore({ filePath: f.legacy, rememberedFilePath: f.desiredPath }).inspectRemembered(first)).toMatchObject({ status: "ready", desired: { components: { workstation: true } } });
    expect(f.receipt.readRememberedFor(first, (f.desired.inspectRemembered(second) as { fenceId: string }).fenceId)).toEqual({ ok: false, code: "missing" });
  });
}

test("exact legacy migration needs fresh proof validation and preserves unrelated selections", async () => {
  const f = fixture(); f.legacyEnroll(); let validated = 0;
  expect(await migrateRememberedReadyToWork({ ...f, binding: first, isCurrent: () => true, validate: async old => { validated++; return old; } })).toBe("migrated");
  expect(validated).toBe(1); expect(f.recover()).toMatchObject(proof);
  expect(f.desired.inspectRemembered(first)).toMatchObject({ desired: { components: selection } });
  expect(await migrateRememberedReadyToWork({ ...f, binding: first, isCurrent: () => true, validate: async old => old })).toBe("not_eligible");
});

test("foreign singleton is preserved as non-authoritative migration input until its exact binding qualifies", async () => {
  const f = fixture(); f.legacyEnroll(first); f.enroll(second);
  expect(f.recover(first)).toBeNull(); expect(f.recover(second)).not.toBeNull();
  expect(f.desired.pendingLegacyFor(first)).toMatchObject({ humanId: first.humanId, components: selection });
  expect(f.receipt.pendingLegacyFor(first)).toMatchObject(proof);
  expect(await migrateRememberedReadyToWork({ ...f, binding: first, isCurrent: () => true, validate: async old => old })).toBe("migrated");
  expect(f.recover(first)).not.toBeNull(); expect(f.recover(second)).not.toBeNull();
});

test("downgrade cannot resurrect a pending legacy proof through the import route", async () => {
  const f = fixture(); f.legacyEnroll(first); f.enroll(second); fs.unlinkSync(f.legacy); f.enroll(second);
  let calls = 0;
  expect(await migrateRememberedReadyToWork({ ...f, binding: first, isCurrent: () => true, validate: async old => { calls++; return old; } })).toBe("not_eligible");
  expect(calls).toBe(0); expect(f.recover(first)).toBeNull();
  expect(fs.readFileSync(f.desiredPath, "utf8")).toContain("human-a");
});

for (const reason of ["intent-only", "foreign", "profile-change", "proof-rejected"] as const) {
  test(`legacy ${reason} cannot create remembered Development`, async () => {
    const f = fixture(); f.legacyEnroll();
    if (reason === "intent-only") fs.unlinkSync(f.legacyReceipt);
    expect(await migrateRememberedReadyToWork({ ...f, binding: reason === "foreign" ? second : first, isCurrent: () => true,
      validate: async old => reason === "proof-rejected" ? null : reason === "profile-change" ? { ...old, profileRevision: 3 } : old })).toBe("not_eligible");
    expect(f.recover()).toBeNull(); expect(fs.existsSync(f.desiredPath)).toBe(false);
  });
}

test("Off during asynchronous proof validation fences the stale import", async () => {
  const f = fixture(); f.legacyEnroll(); let finish!: (value: typeof proof) => void; let current = true;
  const pending = migrateRememberedReadyToWork({ ...f, binding: first, isCurrent: () => current, validate: () => new Promise(resolve => { finish = resolve; }) });
  current = false; f.desired.clear(); finish(proof);
  expect(await pending).toBe("stale"); expect(f.recover()).toBeNull(); expect(fs.existsSync(f.desiredPath)).toBe(false);
});

test("Development disable reduces only the exact key before proof removal and always fences live work", async () => {
  const f = fixture(); f.enroll(first); f.enroll(second); let fences = 0;
  const pending = disableRememberedDevelopment({ ...f, binding: first, isCurrent: () => true, fence: async () => {
    fences++; expect(f.desired.inspectRemembered(first)).toMatchObject({ desired: { components: { ...selection, workstation: false } } });
    expect(f.recover(first)).toBeNull();
  } });
  expect(fences).toBe(1); await pending; expect(f.recover(second)).not.toBeNull();
});

test("server Forget and local account removal preserve unrelated entries", async () => {
  const f = fixture(); f.enroll(first); f.enroll(second); f.enroll(otherServer);
  await removeRememberedReadyToWork({ ...f, scope: { kind: "server", origin: first.authority.scope, serverFingerprint: first.authority.serverFingerprint }, isCurrent: () => true, fence: async () => {} });
  expect(f.recover(first)).toBeNull(); expect(f.recover(second)).toBeNull(); expect(f.recover(otherServer)).not.toBeNull();
  await removeRememberedReadyToWork({ ...f, scope: { kind: "human", humanId: first.humanId }, isCurrent: () => true, fence: async () => {} });
  expect(f.recover(otherServer)).toBeNull();
});

test("unknown desired format is preserved while Off still fences", async () => {
  const f = fixture(); f.enroll(); const future = JSON.stringify({ version: 3, future: "preserve" }); fs.writeFileSync(f.desiredPath, future); let fenced = false;
  const result = disableRememberedDevelopment({ ...f, binding: first, isCurrent: () => true, fence: async () => { fenced = true; } });
  expect(fenced).toBe(true); expect(await result.then(() => false, () => true)).toBe(true);
  expect(fs.readFileSync(f.desiredPath, "utf8")).toBe(future); expect(() => f.enroll()).toThrow("UNSUPPORTED");
});

test("corrupt protected bytes are never overwritten and OS-protection loss never falls back to plaintext", () => {
  const f = fixture(); f.enroll(); const broken = Buffer.from("corrupt-protected-content"); fs.writeFileSync(f.receiptPath, broken);
  expect(() => f.enroll()).toThrow("INVALID"); expect(fs.readFileSync(f.receiptPath)).toEqual(broken);
  expect(f.recover()).toBeNull();
  const receipt = new ReadyToWorkProtectedReceiptStore({ filePath: f.legacyReceipt, rememberedFilePath: f.receiptPath, safeStorage: { ...f.safeStorage, isEncryptionAvailable: () => false } });
  expect(() => saveRememberedReadyToWork({ ...f, receipt, selection: createReadyToWorkDesiredState(first, selection), proof, isCurrent: () => true })).toThrow("UNAVAILABLE");
});

test("intent replacement failure leaves an orphan proof but cannot publish a remembered choice", () => {
  const f = fixture();
  const broken: ReadyToWorkStoreFs = { ...fs, renameSync: (from, to) => { if (to === f.desiredPath) throw new Error("disk failure"); fs.renameSync(from, to); } };
  const desired = new ReadyToWorkStore({ filePath: f.legacy, rememberedFilePath: f.desiredPath, fs: broken });
  expect(() => saveRememberedReadyToWork({ ...f, desired, selection: createReadyToWorkDesiredState(first, selection), proof, isCurrent: () => true })).toThrow("disk failure");
  expect(fs.existsSync(f.receiptPath)).toBe(true); expect(f.recover()).toBeNull(); expect(fs.existsSync(f.legacy)).toBe(false);
});

test("crash between intent and sentinel replacement is visibly unconfirmed and never auto-repaired", () => {
  const f = fixture();
  const broken: ReadyToWorkStoreFs = { ...fs, renameSync: (from, to) => { if (to === f.legacy) throw new Error("sentinel failure"); fs.renameSync(from, to); } };
  const desired = new ReadyToWorkStore({ filePath: f.legacy, rememberedFilePath: f.desiredPath, fs: broken });
  expect(() => saveRememberedReadyToWork({ ...f, desired, selection: createReadyToWorkDesiredState(first, selection), proof, isCurrent: () => true })).toThrow("sentinel failure");
  expect(f.desired.inspectRemembered(first).status).toBe("confirmation_required"); expect(f.recover()).toBeNull();
  expect(fs.existsSync(f.legacy)).toBe(false); expect(f.desired.pendingLegacyFor(first)).toBeNull();
});

test("captured plans reject changed legacy state and cannot be reused", () => {
  const f = fixture(); f.enroll(); const plan = f.desired.prepareRememberedWrite(); fs.unlinkSync(f.legacy);
  expect(plan.isCurrent()).toBe(false); expect(() => plan.commit({ kind: "remove", scope: { kind: "key", key: readyToWorkRememberedKey(first) } })).toThrow("CHANGED");
  const fresh = f.desired.prepareRememberedWrite(); fresh.commit({ kind: "save", desired: createReadyToWorkDesiredState(first, { ...selection, workstation: false }) });
  expect(() => fresh.commit({ kind: "remove", scope: { kind: "human", humanId: first.humanId } })).toThrow("CHANGED");
});

test("failed scoped legacy cleanup never re-imports the removed proof on later enrollment", async () => {
  const f = fixture(); f.legacyEnroll(first); f.enroll(second);
  const receipt = new ReadyToWorkProtectedReceiptStore({ filePath: f.legacyReceipt, rememberedFilePath: f.receiptPath, safeStorage: f.safeStorage,
    fs: { ...fs, unlinkSync: file => { if (file === f.legacyReceipt) throw new Error("legacy cleanup failed"); fs.unlinkSync(file); } } });
  expect(await removeRememberedReadyToWork({ ...f, receipt, scope: { kind: "human", humanId: first.humanId }, isCurrent: () => true, fence: async () => {} }).then(() => false, () => true)).toBe(true);
  expect(fs.existsSync(f.legacyReceipt)).toBe(true);
  f.enroll(second); expect(f.receipt.pendingLegacyFor(first)).toEqual({ ok: false, code: "missing" });
  expect(f.desired.pendingLegacyFor(first)).toBeNull(); expect(f.recover(first)).toBeNull();
});

test("successful account removal clears its old ciphertext without deleting another Human's live entry", async () => {
  const f = fixture(); f.legacyEnroll(first); f.enroll(second);
  await removeRememberedReadyToWork({ ...f, scope: { kind: "human", humanId: first.humanId }, isCurrent: () => true, fence: async () => {} });
  expect(fs.existsSync(f.legacyReceipt)).toBe(false); expect(f.recover(second)).not.toBeNull();
});

test("normal subsequent save collects an orphan proof left by failed intent publication", () => {
  const f = fixture(); f.enroll(second);
  const desired = new ReadyToWorkStore({ filePath: f.legacy, rememberedFilePath: f.desiredPath,
    fs: { ...fs, renameSync: (from, to) => { if (to === f.desiredPath) throw new Error("disk failure"); fs.renameSync(from, to); } } });
  expect(() => saveRememberedReadyToWork({ ...f, desired, selection: createReadyToWorkDesiredState(first, selection), proof, isCurrent: () => true })).toThrow("disk failure");
  expect(f.recover(first)).toBeNull(); f.enroll(second);
  const state = f.desired.inspectRemembered(second); if (state.status !== "ready") throw new Error("missing fixture intent");
  expect(f.receipt.readRememberedFor(first, state.fenceId)).toEqual({ ok: false, code: "missing" });
});

test("initial Development disable preserves unrelated legacy choices", async () => {
  const f = fixture(); f.legacyEnroll();
  await disableRememberedDevelopment({ ...f, binding: first, isCurrent: () => true, fence: async () => {} });
  expect(f.desired.inspectRemembered(first)).toMatchObject({ desired: { components: { ...selection, workstation: false } } });
  expect(f.recover()).toBeNull(); expect(fs.existsSync(f.legacyReceipt)).toBe(false);
});

test("changed legacy bytes during proof replacement preserve Off and withhold new intent", () => {
  const f = fixture(); f.enroll(); let changed = false;
  const receipt = new ReadyToWorkProtectedReceiptStore({ filePath: f.legacyReceipt, rememberedFilePath: f.receiptPath, safeStorage: f.safeStorage,
    fs: { ...fs, writeFileSync: (fd, data) => { fs.writeFileSync(fd, data); if (!changed) { changed = true; fs.unlinkSync(f.legacy); } } } });
  expect(() => saveRememberedReadyToWork({ ...f, receipt, selection: createReadyToWorkDesiredState(second, selection), proof, isCurrent: () => true })).toThrow("CHANGED");
  expect(f.recover(first)).toBeNull(); expect(f.recover(second)).toBeNull(); expect(fs.existsSync(f.legacy)).toBe(false);
});

test("temporary filename collision never removes an unowned existing file", () => {
  const f = fixture(); const collision = `${f.desiredPath}.collision.tmp`; fs.writeFileSync(collision, "not-owned");
  const desired = new ReadyToWorkStore({ filePath: f.legacy, rememberedFilePath: f.desiredPath, mintTemporaryId: () => "collision" });
  expect(() => saveRememberedReadyToWork({ ...f, desired, selection: createReadyToWorkDesiredState(first, selection), proof, isCurrent: () => true })).toThrow();
  expect(fs.readFileSync(collision, "utf8")).toBe("not-owned");
});

test("legacy future format and unknown symlink target are preserved", () => {
  const f = fixture(); const future = JSON.stringify({ version: 9, data: "unknown" }); const target = path.join(f.root, "future.json"); fs.writeFileSync(target, future);
  fs.symlinkSync(process.platform === "win32" ? f.root : target, f.legacy, process.platform === "win32" ? "junction" : "file");
  const linkedFile = process.platform === "win32" ? path.join(f.legacy, "future.json") : f.legacy;
  const desired = new ReadyToWorkStore({ filePath: linkedFile, rememberedFilePath: f.desiredPath });
  expect(() => saveRememberedReadyToWork({ desired, receipt: f.receipt, selection: createReadyToWorkDesiredState(first, selection), proof, isCurrent: () => true })).toThrow("UNSUPPORTED");
  expect(fs.lstatSync(f.legacy).isSymbolicLink()).toBe(true); expect(fs.readFileSync(target, "utf8")).toBe(future);
});


test("automatic receipt rotation preserves intent and cannot repair a downgrade or re-enable Basic", async () => {
  const f = fixture(); f.enroll(); const before = fs.readFileSync(f.desiredPath, "utf8");
  const rotated = { ...proof, receipt: "wsr1.rotated-proof" };
  refreshRememberedReadyReceipt({ ...f, binding: first, expectedReceipt: proof.receipt, proof: rotated, isCurrent: () => true });
  expect(f.recover()).toMatchObject(rotated); expect(fs.readFileSync(f.desiredPath, "utf8")).toBe(before);
  fs.unlinkSync(f.legacy);
  expect(() => refreshRememberedReadyReceipt({ ...f, binding: first, expectedReceipt: rotated.receipt, proof, isCurrent: () => true })).toThrow("CHANGED");
  expect(fs.existsSync(f.legacy)).toBe(false);
  await disableRememberedDevelopment({ ...f, binding: first, isCurrent: () => true, fence: async () => {} });
  expect(() => refreshRememberedReadyReceipt({ ...f, binding: first, expectedReceipt: rotated.receipt, proof, isCurrent: () => true })).toThrow("CHANGED");
  expect(f.recover()).toBeNull();
});

test("legacy migration uses durable identity plus renewed server proof, not obsolete transport revisions", async () => {
  const f = fixture(); f.legacyEnroll();
  const current = { ...first, authority: { ...first.authority, revision: "current-revision", connectionAttemptId: "current-attempt" } };
  expect(await migrateRememberedReadyToWork({ ...f, binding: current, isCurrent: () => true, validate: async old => old })).toBe("migrated");
  expect(f.recover(current)).not.toBeNull();
  expect(f.desired.inspectRemembered(current)).toMatchObject({ desired: { authority: current.authority } });
});

test("a newer protected format is preserved rather than treated as an empty key set", () => {
  const f = fixture(); f.enroll(); const future = Buffer.from("nautilo-ready-workstation-receipt-v3\0future ciphertext");
  fs.writeFileSync(f.receiptPath, future);
  expect(f.receipt.inspectRemembered().status).toBe("unsupported");
  expect(() => f.enroll(second)).toThrow("UNSUPPORTED"); expect(fs.readFileSync(f.receiptPath)).toEqual(future);
});
