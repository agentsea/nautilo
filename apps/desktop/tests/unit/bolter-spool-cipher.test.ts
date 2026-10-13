import { expect, test } from "bun:test";
import { createBolterSpoolCipher } from "../../electron/bolter-bridge/spool-cipher";

// A codec spy verifies OS-storage admission, not the security of an OS keyring.
function fixture(backend: string | undefined = undefined) {
  let available = true;
  let reads = 0;
  let writes = 0;
  const storage = {
    isEncryptionAvailable: () => available,
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
    encryptString: (text: string) => { writes++; return Buffer.from(`fixture:${text}`); },
    decryptString: (bytes: Buffer) => { reads++; return bytes.toString().slice("fixture:".length); },
  };
  return { storage, retire: () => { available = false; }, counts: () => ({ reads, writes }) };
}

test("OS storage codec has a versioned format and never accepts raw plaintext or another store", async () => {
  const f = fixture();
  const cipher = createBolterSpoolCipher(f.storage, "darwin");
  expect(cipher.isAvailable()).toBe(true);
  expect(await cipher.open(await cipher.seal("synthetic batch"))).toBe("synthetic batch");
  await expect(cipher.open(Buffer.from("synthetic batch"))).rejects.toThrow("unavailable");
  await expect(cipher.open(Buffer.from("nautilo-other-store-v1\0payload"))).rejects.toThrow("unavailable");
  expect(f.counts()).toEqual({ reads: 1, writes: 1 });
});

test("Linux needs a recognized protected backend and unavailable storage has no fallback", async () => {
  for (const backend of [undefined, "basic_text", "unknown", "future-backend"]) {
    const f = fixture(backend);
    const cipher = createBolterSpoolCipher(f.storage, "linux");
    expect(cipher.isAvailable()).toBe(false);
    await expect(cipher.seal("synthetic batch")).rejects.toThrow("unavailable");
    expect(f.counts()).toEqual({ reads: 0, writes: 0 });
  }
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    expect(createBolterSpoolCipher(fixture(backend).storage, "linux").isAvailable()).toBe(true);
  }
  const f = fixture();
  const cipher = createBolterSpoolCipher(f.storage, "darwin");
  const sealed = await cipher.seal("synthetic batch");
  f.retire();
  await expect(cipher.open(sealed)).rejects.toThrow("unavailable");
  await expect(cipher.seal("other batch")).rejects.toThrow("unavailable");
  expect(f.counts()).toEqual({ reads: 0, writes: 1 });
});

test("OS failures remain sanitized and changing caller methods cannot replace the codec", async () => {
  const f = fixture();
  const cipher = createBolterSpoolCipher(f.storage, "darwin");
  f.storage.encryptString = () => { throw new Error("raw private OS diagnostic"); };
  expect(await cipher.open(await cipher.seal("synthetic"))).toBe("synthetic");
  const broken = createBolterSpoolCipher(f.storage, "darwin");
  await expect(broken.seal("synthetic")).rejects.toThrow("Bolter inbox protection is unavailable.");
  expect(createBolterSpoolCipher(f.storage, "freebsd").isAvailable()).toBe(false);
});
