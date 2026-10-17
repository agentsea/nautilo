import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ReadyToWorkBinding } from "../../electron/ready-to-work-contract";
import { ReadyToWorkProtectedReceiptStore } from "../../electron/ready-to-work-protected-receipt";

let root = "";
const binding: ReadyToWorkBinding = {
  humanId: "human-17",
  authority: {
    scope: "https://alpha.example.test",
    revision: "revision-17",
    connectionAttemptId: "attempt-17",
    serverFingerprint: "fingerprint-17",
  },
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-ready-receipt-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const safeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`, "utf8"),
  decryptString: (value: Buffer) => Buffer.from(value.toString("utf8").replace(/^sealed:/, ""), "base64").toString("utf8"),
});

describe("Ready Workstation protected receipt", () => {
  test("stores only OS-protected bytes and scopes reads to the exact binding", () => {
    const filePath = path.join(root, "receipt.bin");
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    expect(store.save({ binding, profileId: "developer-workstation", profileRevision: 4, receipt: "wsr1.secret" })).toBeTrue();
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("wsr1.secret");
    expect(store.readFor(binding)).toEqual({
      ok: true,
      receipt: "wsr1.secret",
      profileId: "developer-workstation",
      profileRevision: 4,
    });
    expect(store.readFor({ ...binding, humanId: "human-18" })).toEqual({ ok: false, code: "foreign" });
  });

  test("restores an OS-protected receipt after a source-development process restart", () => {
    const filePath = path.join(root, "receipt.bin");
    const sourceBinding: ReadyToWorkBinding = {
      ...binding,
      authority: {
        ...binding.authority,
        revision: "dev-process-one",
        connectionAttemptId: "legacy-dev-process-one",
      },
    };
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    expect(store.save({
      binding: sourceBinding,
      profileId: "developer-workstation",
      profileRevision: 4,
      receipt: "wsr1.secret",
    })).toBeTrue();

    expect(store.readFor({
      ...sourceBinding,
      authority: {
        ...sourceBinding.authority,
        revision: "dev-process-two",
        connectionAttemptId: "legacy-dev-process-two",
      },
    })).toEqual({
      ok: true,
      receipt: "wsr1.secret",
      profileId: "developer-workstation",
      profileRevision: 4,
    });
    expect(store.readFor({
      ...sourceBinding,
      authority: { ...sourceBinding.authority, serverFingerprint: "fingerprint-18" },
    })).toEqual({ ok: false, code: "foreign" });
  });

  test("fails closed when OS protection is unavailable or bytes are corrupt", () => {
    const filePath = path.join(root, "receipt.bin");
    const unavailable = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage(false) });
    expect(unavailable.save({ binding, profileId: "developer-workstation", profileRevision: 1, receipt: "opaque" })).toBeFalse();
    expect(unavailable.readFor(binding)).toEqual({ ok: false, code: "unavailable" });
    expect(fs.existsSync(filePath)).toBeFalse();

    fs.writeFileSync(filePath, "plaintext-receipt", "utf8");
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    expect(store.readFor(binding)).toEqual({ ok: false, code: "invalid" });
    expect(store.inspect()).toEqual({ status: "invalid" });
    expect(() => store.clear()).toThrow("READY_TO_WORK_PERSISTENCE_INVALID");
    expect(() => store.save({ binding, profileId: "developer-workstation", profileRevision: 1, receipt: "new-proof" }))
      .toThrow("READY_TO_WORK_PERSISTENCE_INVALID");
    expect(fs.readFileSync(filePath, "utf8")).toBe("plaintext-receipt");
  });

  test("preserves future headers and future encrypted versions without exposing proof", () => {
    const filePath = path.join(root, "receipt.bin");
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    for (const bytes of [Buffer.from("nautilo-ready-workstation-receipt-v2\0future-ciphertext"),
      Buffer.concat([Buffer.from("nautilo-ready-workstation-receipt-v1\0"), safeStorage().encryptString(JSON.stringify({ version: 2, secret: "fixture" }))])]) {
      fs.writeFileSync(filePath, bytes);
      expect(store.inspect()).toEqual({ status: "unsupported" });
      expect(store.readFor(binding)).toEqual({ ok: false, code: "invalid" });
      expect(() => store.save({ binding, profileId: "developer-workstation", profileRevision: 1, receipt: "new-proof" }))
        .toThrow("READY_TO_WORK_PERSISTENCE_UNSUPPORTED");
      expect(() => store.clear()).toThrow("READY_TO_WORK_PERSISTENCE_UNSUPPORTED");
      expect(fs.readFileSync(filePath)).toEqual(bytes);
    }
  });

  test("understood receipts replace and clear, while unavailable protection preserves ciphertext", () => {
    const filePath = path.join(root, "receipt.bin");
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    expect(store.inspect()).toEqual({ status: "missing" });
    expect(store.clear()).toBeFalse();
    const input = { binding, profileId: "developer-workstation", profileRevision: 1, receipt: "first" };
    expect(store.save(input)).toBeTrue();
    expect(store.save({ ...input, receipt: "second" })).toBeTrue();
    const bytes = fs.readFileSync(filePath);
    const unavailable = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage(false) });
    expect(unavailable.inspect()).toEqual({ status: "unavailable" });
    expect(unavailable.save(input)).toBeFalse();
    expect(() => unavailable.clear()).toThrow("READY_TO_WORK_PERSISTENCE_UNAVAILABLE");
    expect(fs.readFileSync(filePath)).toEqual(bytes);
    expect(store.clear()).toBeTrue();
  });

  test("observed external replacement survives save and only owned temporary bytes are cleaned", () => {
    const filePath = path.join(root, "receipt.bin");
    const input = { binding, profileId: "developer-workstation", profileRevision: 1, receipt: "first" };
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    store.save(input);
    const changed = Buffer.concat([Buffer.from("nautilo-ready-workstation-receipt-v1\0"),
      safeStorage().encryptString(JSON.stringify({ version: 1, humanId: binding.humanId, authority: binding.authority,
        profileId: input.profileId, profileRevision: 1, receipt: "changed" }))]);
    const racing = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage(), mintTemporaryId: () => "race",
      fs: { ...fs, writeFileSync: (fd, data) => { fs.writeFileSync(fd, data); fs.writeFileSync(filePath, changed); } } });
    expect(() => racing.save(input)).toThrow("READY_TO_WORK_PERSISTENCE_CHANGED");
    expect(fs.readFileSync(filePath)).toEqual(changed);
    expect(fs.existsSync(`${filePath}.race.tmp`)).toBeFalse();
    fs.writeFileSync(`${filePath}.collision.tmp`, "not owned");
    const collision = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage(), mintTemporaryId: () => "collision" });
    expect(collision.save(input)).toBeFalse();
    expect(fs.readFileSync(`${filePath}.collision.tmp`, "utf8")).toBe("not owned");
  });

  test("clear refuses a newly unsupported receipt and preserves its symlink target", () => {
    const filePath = path.join(root, "receipt.bin");
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    store.save({ binding, profileId: "developer-workstation", profileRevision: 1, receipt: "first" });
    const future = Buffer.from("nautilo-ready-workstation-receipt-v2\0future-ciphertext");
    let reads = 0;
    const racing = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage(),
      fs: { ...fs, readFileSync: (file) => {
        if (++reads === 2) fs.writeFileSync(file, future);
        return fs.readFileSync(file);
      } } });
    expect(() => racing.clear()).toThrow("READY_TO_WORK_PERSISTENCE_UNSUPPORTED");
    const target = path.join(root, "future.bin");
    fs.renameSync(filePath, target);
    fs.symlinkSync(process.platform === "win32" ? root : target, filePath,
      process.platform === "win32" ? "junction" : "file");
    const linkedFile = process.platform === "win32" ? path.join(filePath, "future.bin") : filePath;
    const linkedStore = new ReadyToWorkProtectedReceiptStore({ filePath: linkedFile, safeStorage: safeStorage() });
    expect(() => linkedStore.clear()).toThrow("READY_TO_WORK_PERSISTENCE_UNSUPPORTED");
    expect(fs.lstatSync(filePath).isSymbolicLink()).toBeTrue();
    expect(fs.readFileSync(target)).toEqual(future);
  });

  test("failed atomic replacement preserves the prior protected proof", () => {
    const filePath = path.join(root, "receipt.bin");
    const input = { binding, profileId: "developer-workstation", profileRevision: 1, receipt: "original" };
    const store = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage() });
    store.save(input);
    const bytes = fs.readFileSync(filePath);
    const failing = new ReadyToWorkProtectedReceiptStore({ filePath, safeStorage: safeStorage(), mintTemporaryId: () => "failed",
      fs: { ...fs, renameSync: () => { throw new Error("fixture rename failed"); } } });
    expect(failing.save({ ...input, receipt: "replacement" })).toBeFalse();
    expect(fs.readFileSync(filePath)).toEqual(bytes);
    expect(fs.existsSync(`${filePath}.failed.tmp`)).toBeFalse();
  });

  test("rejects Electron's plaintext Linux fallback", () => {
    const filePath = path.join(root, "receipt.bin");
    const store = new ReadyToWorkProtectedReceiptStore({
      filePath,
      safeStorage: { ...safeStorage(), getSelectedStorageBackend: () => "basic_text" },
    });
    expect(store.save({ binding, profileId: "developer-workstation", profileRevision: 1, receipt: "opaque" })).toBeFalse();
    expect(store.readFor(binding)).toEqual({ ok: false, code: "unavailable" });
    expect(fs.existsSync(filePath)).toBeFalse();
  });
});
