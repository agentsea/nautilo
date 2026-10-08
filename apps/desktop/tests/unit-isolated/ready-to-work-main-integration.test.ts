import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadyToWorkDesiredState, type ReadyToWorkBinding } from "../../electron/ready-to-work-contract";
import { ReadyToWorkStore } from "../../electron/ready-to-work-store";
import { ReadyToWorkProtectedReceiptStore, type ReadyToWorkSafeStorage } from "../../electron/ready-to-work-protected-receipt";
import { saveRememberedReadyToWork, migrateRememberedReadyToWork } from "../../electron/ready-to-work-persistence";
import { ReadyToWorkRemembered, settleReadyCleanup } from "../../electron/ready-to-work-remembered";
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
  let current: ReadyToWorkBinding | null = first;
  const ports = new ReadyToWorkRemembered({ desired, receipt }, () => current);
  return { root, legacy, desiredPath, legacyReceipt, receiptPath, safeStorage, desired, receipt, enroll, legacyEnroll, recover, ports, select: (binding: ReadyToWorkBinding | null) => { current = binding; } };
}

test("main ports select only the current Human/server and preserve choices across transport replacement", () => {
  const f = fixture(); f.enroll(); f.enroll(second); f.enroll(otherServer);
  expect(f.ports.persistence.attention()).toBeNull();
  const refreshed = { ...first, authority: { ...first.authority, revision: "later", connectionAttemptId: "later" } };
  f.select(refreshed);
  expect(f.ports.loadFor(refreshed)?.authority).toEqual(refreshed.authority);
  expect(f.ports.readReceipt(refreshed)).toMatchObject({ ok: true, ...proof });
  const replacement = { ...refreshed, authority: { ...refreshed.authority, serverFingerprint: "different-server" } };
  f.select(replacement); expect(f.ports.loadFor(replacement)).toBeNull(); expect(f.ports.readReceipt(replacement).ok).toBe(false);
  f.select(null); expect(f.ports.persistence.attention()).toBeNull();
  expect(f.recover(first)).not.toBeNull(); expect(f.recover(second)).not.toBeNull();
});

test("downgrade requires attention, blocks Restore, and permits explicit fresh enrollment without reviving another key", () => {
  const f = fixture(); f.enroll(); f.enroll(second); fs.unlinkSync(f.legacy);
  expect(f.ports.persistence.attention()).toMatchObject({ mode: "needs_attention" });
  expect(f.ports.persistence.mayRestore(true)).toBe(false);
  expect(f.ports.readReceipt(first).ok).toBe(false);
  f.ports.assertWritable();
  f.ports.save(createReadyToWorkDesiredState(first, selection), { ...proof, receipt: "fresh-pin-proof" }, () => true);
  expect(f.ports.persistence.attention()).toBeNull();
  expect(f.ports.readReceipt(first)).toMatchObject({ receipt: "fresh-pin-proof" });
  expect(f.recover(second)).toBeNull();
});

test("automatic refresh refuses downgrade repair and explicit Off", () => {
  const f = fixture(); f.enroll();
  expect(f.ports.refresh(first, proof.receipt, { ...proof, receipt: "rotated" }, () => true)).toBe(true);
  fs.unlinkSync(f.legacy);
  expect(() => f.ports.refresh(first, "rotated", proof, () => true)).toThrow();
  expect(fs.existsSync(f.legacy)).toBe(false);
});

test("Development disable durably reduces only that choice before invoking the immediate fence", async () => {
  const f = fixture(); f.enroll(); f.enroll(second); let fenced = false;
  const pending = f.ports.disableDevelopment(async () => {
    fenced = true;
    expect(f.ports.loadFor(first)?.components).toEqual({ ...selection, workstation: false });
    expect(f.ports.readReceipt(first).ok).toBe(false);
  });
  expect(fenced).toBe(true); await pending;
  expect(f.recover(second)).not.toBeNull();
});

test("failed Development Off still fences, remains latched after healthy status, and cannot Restore", async () => {
  const f = fixture(); f.enroll(); const saved = fs.readFileSync(f.desiredPath);
  fs.writeFileSync(f.desiredPath, "broken"); let fenced = 0;
  await f.ports.disableDevelopment(async () => { fenced++; }); expect(fenced).toBe(1);
  fs.writeFileSync(f.desiredPath, saved); f.ports.persistence.retryStatus();
  expect(f.ports.persistence.attention()).toMatchObject({ mode: "needs_attention", persistence: { liveAccess: "stopping" } });
  expect(f.ports.persistence.mayRestore(true)).toBe(false);
});

test("Ready Off removes only the selected entry, and unknown identity cannot remove any key", async () => {
  const f = fixture(); f.enroll(); f.enroll(second);
  await f.ports.persistence.disable(async desired => { expect(desired?.humanId).toBe(first.humanId); });
  expect(f.ports.loadFor(first)).toBeNull(); expect(f.recover(second)).not.toBeNull();
  f.select(null); let fenced = false;
  await f.ports.persistence.disable(async (_, failed) => { fenced = true; expect(failed).toBe(true); });
  expect(fenced).toBe(true); expect(f.recover(second)).not.toBeNull();
});

test("legacy intent is attention rather than restoration authority until exact server proof migration", async () => {
  const f = fixture(); f.legacyEnroll();
  expect(f.ports.loadFor(first)).toBeNull(); expect(f.ports.readReceipt(first).ok).toBe(false);
  expect(f.ports.persistence.attention()).toMatchObject({ mode: "needs_attention" });
  expect(await migrateRememberedReadyToWork({ ...f, binding: first, isCurrent: () => true, validate: async value => value })).toBe("migrated");
  expect(f.ports.persistence.attention()).toBeNull(); expect(f.ports.loadFor(first)?.components).toEqual(selection);
});

test("server Forget and account-removal ports preserve unrelated durable identities", () => {
  const f = fixture(); f.enroll(); f.enroll(second); f.enroll(otherServer);
  f.ports.remove({ kind: "server", origin: first.authority.scope, serverFingerprint: first.authority.serverFingerprint }, () => true);
  expect(f.recover(first)).toBeNull(); expect(f.recover(second)).toBeNull(); expect(f.recover(otherServer)).not.toBeNull();
  f.enroll(second); f.ports.remove({ kind: "human", humanId: first.humanId }, () => true);
  expect(f.recover(otherServer)).toBeNull(); expect(f.recover(second)).not.toBeNull();
});

test("narrow enrollment preserves a foreign proof and refuses stale activation writes", () => {
  const f = fixture(); f.enroll(); f.enroll(second);
  expect(() => f.ports.save(createReadyToWorkDesiredState(first, selection), proof, () => false)).toThrow();
  f.ports.save(createReadyToWorkDesiredState(first, { ...selection, workstation: false }), null, () => true);
  expect(f.ports.readReceipt(first).ok).toBe(false); expect(f.recover(second)).not.toBeNull();
});

test("failed Off blocks legacy migration even after underlying bytes become readable", async () => {
  const f = fixture(); f.legacyEnroll(); const saved = fs.readFileSync(f.legacy);
  expect(f.ports.mayMigrate()).toBe(true);
  fs.writeFileSync(f.legacy, "invalid"); await f.ports.persistence.disable(async () => {});
  fs.writeFileSync(f.legacy, saved);
  expect(f.ports.mayMigrate()).toBe(false);
});


test("failed remote cleanup settles its barrier so fresh explicit enrollment can recover", async () => {
  const f = fixture(); f.enroll();
  let release!: () => void;
  const remote = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const tail = settleReadyCleanup(Promise.reject(new Error("old cleanup failed")), [remote, Promise.reject(new Error("remote failed"))]).then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  release(); await tail;
  const saved = fs.readFileSync(f.desiredPath); fs.writeFileSync(f.desiredPath, "broken");
  await f.ports.disableDevelopment(async () => {});
  expect(f.ports.persistence.attention()).not.toBeNull();
  fs.writeFileSync(f.desiredPath, saved);
  f.ports.save(createReadyToWorkDesiredState(first, selection), { ...proof, receipt: "fresh-after-repair" }, () => true);
  expect(f.ports.persistence.attention()).toBeNull();
  expect(f.ports.readReceipt(first)).toMatchObject({ receipt: "fresh-after-repair" });
});

test("component-only save preserves encrypted Development proof and rejects stale workstation bits", () => {
  const f = fixture(); f.enroll(); const sealed = fs.readFileSync(f.receiptPath);
  f.ports.saveComponents(createReadyToWorkDesiredState(first, { ...selection, voice: false }), () => true);
  expect(fs.readFileSync(f.receiptPath)).toEqual(sealed);
  expect(f.ports.readReceipt(first)).toMatchObject({ ok: true, ...proof });
  expect(f.ports.loadFor(first)?.components.voice).toBe(false);
  expect(() => f.ports.saveComponents(createReadyToWorkDesiredState(first, { ...selection, workstation: false }), () => true)).toThrow();
  expect(() => f.ports.saveComponents(createReadyToWorkDesiredState(first, selection), () => false)).toThrow();
  fs.unlinkSync(f.legacy);
  expect(() => f.ports.saveComponents(createReadyToWorkDesiredState(first, selection), () => true)).toThrow();
  expect(fs.existsSync(f.legacy)).toBe(false);
});
