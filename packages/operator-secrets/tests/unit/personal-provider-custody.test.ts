import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPersonalProviderCustody, decryptPersonalProviderCredential,
  encryptPersonalProviderCredential, parsePersonalProviderCustody,
  personalProviderCustodyFromEnvFile, serializePersonalProviderCustody,
} from "../../src/personal-provider-custody";
import { ensurePersonalProviderCustodyFile, resetPersonalProviderCustodyFile } from "../../src/personal-provider-custody-file";
import { assertPersonalProviderRestoreCustody } from "../../src/personal-provider-backup";

const context = { userId: "human-a", provider: "openai", id: "credential-a", revision: 1 };
const secret = "synthetic-personal-provider-credential";
const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "personal-custody-")); roots.push(path); return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("personal credential encryption", () => {
  test("authenticated randomized envelopes survive serialized custody restore", () => {
    const custody = createPersonalProviderCustody();
    const envelope = encryptPersonalProviderCredential(custody, secret, context);
    expect(encryptPersonalProviderCredential(custody, secret, context).nonceBase64).not.toBe(envelope.nonceBase64);
    const restored = parsePersonalProviderCustody(serializePersonalProviderCustody(custody));
    expect(decryptPersonalProviderCredential(restored, envelope, context)).toBe(secret);
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });
  test("uppercase custody UUID normalizes before envelope storage and AAD", () => {
    const custody = createPersonalProviderCustody();
    const uppercase = { ...custody, keyId: custody.keyId.toUpperCase() };
    const envelope = encryptPersonalProviderCredential(uppercase, secret, context);
    expect(envelope.keyId).toBe(custody.keyId);
    expect(parsePersonalProviderCustody(JSON.stringify(uppercase)).keyId).toBe(custody.keyId);
    expect(decryptPersonalProviderCredential(custody, envelope, context)).toBe(secret);
  });
  test("rejects owner/provider/identity/revision substitution and tag tampering", () => {
    const custody = createPersonalProviderCustody();
    const envelope = encryptPersonalProviderCredential(custody, secret, context);
    for (const change of [{ userId: "human-b" }, { provider: "anthropic" }, { id: "credential-b" }, { revision: 2 }]) {
      expect(() => decryptPersonalProviderCredential(custody, envelope, { ...context, ...change })).toThrow("credential_authentication_failed");
    }
    expect(() => decryptPersonalProviderCredential(custody, { ...envelope, authTagBase64: Buffer.alloc(16).toString("base64") }, context)).toThrow();
    expect(() => decryptPersonalProviderCredential(createPersonalProviderCustody(), envelope, context)).toThrow("custody_key_mismatch");
    expect(() => decryptPersonalProviderCredential({ ...createPersonalProviderCustody(), keyId: custody.keyId }, envelope, context)).toThrow("credential_authentication_failed");
  });
  test("errors never echo invalid custody or plaintext", () => {
    for (const value of [undefined, "", secret, JSON.stringify({ keyHex: secret })]) {
      try { parsePersonalProviderCustody(value); throw new Error("unexpected success"); } catch (error) {
        expect(String(error)).toContain("custody_"); expect(String(error)).not.toContain(secret);
      }
    }
  });
  test("dotenv parser preserves blank as invalid and rejects duplicate custody", () => {
    expect(personalProviderCustodyFromEnvFile("OTHER=x\n")).toBeUndefined();
    expect(personalProviderCustodyFromEnvFile("NAUTILO_PERSONAL_PROVIDER_CUSTODY=\n")).toBe("");
    expect(() => personalProviderCustodyFromEnvFile("NAUTILO_PERSONAL_PROVIDER_CUSTODY=\nNAUTILO_PERSONAL_PROVIDER_CUSTODY=x")).toThrow();
  });
});

describe("durable instance custody", () => {
  test("persists an explicitly selected canonical filename", async () => {
    const instanceRootDir = await root();
    const instanceEnvPath = join(instanceRootDir, "mounted.env");
    await writeFile(instanceEnvPath, "OTHER=kept\n", { mode: 0o600 });
    const custody = await ensurePersonalProviderCustodyFile({ instanceRootDir, instanceEnvPath, hasCredentialRecords: async () => false });
    expect(parsePersonalProviderCustody(personalProviderCustodyFromEnvFile(await readFile(instanceEnvPath, "utf8")))).toEqual(custody);
    expect(await readFile(join(instanceRootDir, "instance.env")).then(() => true, () => false)).toBe(false);
  });
  test("concurrent initial provisioning writes once, preserves config and survives restart", async () => {
    const instanceRootDir = await root();
    await writeFile(join(instanceRootDir, "instance.env"), "OTHER=kept\n", { mode: 0o600 });
    let probes = 0;
    const options = { instanceRootDir, hasCredentialRecords: async () => { probes++; return false; } };
    const [a, b] = await Promise.all([ensurePersonalProviderCustodyFile(options), ensurePersonalProviderCustodyFile(options)]);
    expect(a).toEqual(b); expect(probes).toBe(1);
    expect(await ensurePersonalProviderCustodyFile(options)).toEqual(a);
    expect(await readFile(join(instanceRootDir, "instance.env"), "utf8")).toContain("OTHER=kept");
    expect((await stat(join(instanceRootDir, "instance.env"))).mode & 0o777).toBe(0o600);
  });
  test("missing custody with records or unavailable DB never writes", async () => {
    const instanceRootDir = await root();
    expect(await ensurePersonalProviderCustodyFile({ instanceRootDir, hasCredentialRecords: async () => true }).catch(String)).toContain("custody_missing");
    expect(await ensurePersonalProviderCustodyFile({ instanceRootDir, hasCredentialRecords: async () => { throw new Error("DB unavailable"); } }).catch(String)).toContain("DB unavailable");
    expect(await readFile(join(instanceRootDir, "instance.env")).then(() => false, () => true)).toBe(true);
  });
  test("malformed existing custody is retained rather than silently replaced", async () => {
    const instanceRootDir = await root();
    const path = join(instanceRootDir, "instance.env");
    const before = "NAUTILO_PERSONAL_PROVIDER_CUSTODY=bad\n";
    await writeFile(path, before);
    expect(await ensurePersonalProviderCustodyFile({ instanceRootDir, hasCredentialRecords: async () => false }).catch(String)).toContain("custody_invalid");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  test("explicit reset is retryable and leaves old envelopes unusable until replaced", async () => {
    const instanceRootDir = await root();
    const old = createPersonalProviderCustody();
    const encrypted = encryptPersonalProviderCredential(old, secret, context);
    const options = { instanceRootDir, lostKeyId: old.keyId, confirmReset: true as const, hasLostKeyRecords: async () => true };
    const replacement = await resetPersonalProviderCustodyFile(options);
    expect(replacement.keyId).not.toBe(old.keyId);
    expect(replacement.resetFromKeyId).toBe(old.keyId);
    expect(await resetPersonalProviderCustodyFile(options)).toEqual(replacement);
    expect(() => decryptPersonalProviderCredential(replacement, encrypted, context)).toThrow("custody_key_mismatch");
    const updatedContext = { ...context, revision: 2 };
    expect(decryptPersonalProviderCredential(replacement, encryptPersonalProviderCredential(replacement, secret, updatedContext), updatedContext)).toBe(secret);
  });
  test("reset-transition backups preserve old rows without accepting unrelated key IDs", async () => {
    const instanceRootDir = await root();
    const old = createPersonalProviderCustody();
    const replacement = await resetPersonalProviderCustodyFile({
      instanceRootDir, lostKeyId: old.keyId, confirmReset: true,
      hasLostKeyRecords: async () => true,
    });
    const instanceEnvRaw = await readFile(join(instanceRootDir, "instance.env"), "utf8");
    for (const keyIds of [[old.keyId], [old.keyId, replacement.keyId], [replacement.keyId]]) {
      expect(() => assertPersonalProviderRestoreCustody({
        database: { state: "rows", keyIds }, instanceEnvRaw,
      })).not.toThrow();
    }
    expect(() => assertPersonalProviderRestoreCustody({
      database: { state: "rows", keyIds: [createPersonalProviderCustody().keyId] }, instanceEnvRaw,
    })).toThrow("custody identity does not match");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's rejection matcher settles before filesystem cleanup.
    await expect(resetPersonalProviderCustodyFile({
      instanceRootDir, lostKeyId: createPersonalProviderCustody().keyId,
      confirmReset: true, hasLostKeyRecords: async () => true,
    })).rejects.toThrow();
  });
});
