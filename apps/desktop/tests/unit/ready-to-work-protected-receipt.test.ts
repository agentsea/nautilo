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
    expect(store.clear()).toBeTrue();
    expect(store.readFor(binding)).toEqual({ ok: false, code: "missing" });
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
