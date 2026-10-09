import type { ElectronSafeStoragePort } from "@nautilo/lattice-bridge/client/electron";
import type { BolterSpoolCipher } from "./inbox-spool";

const header = Buffer.from("nautilo-bolter-inbox-v1\0");
const unavailable = () => new Error("Bolter inbox protection is unavailable.");

/** Electron main owns the OS-protected codec; renderer and CLI never receive it. */
export function createBolterSpoolCipher(
  storage: ElectronSafeStoragePort,
  platform: NodeJS.Platform = process.platform,
): BolterSpoolCipher {
  const available = storage.isEncryptionAvailable.bind(storage);
  const backend = storage.getSelectedStorageBackend?.bind(storage);
  const encrypt = storage.encryptString.bind(storage);
  const decrypt = storage.decryptString.bind(storage);
  const isAvailable = () => {
    try {
      if (!available()) return false;
      // Linux must establish a real keyring rather than Electron's basic_text fallback.
      if (platform === "linux") return backend !== undefined &&
        ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend());
      return (platform === "darwin" || platform === "win32") && backend?.() !== "basic_text";
    } catch { return false; }
  };
  return Object.freeze({
    isAvailable,
    seal(plaintext: string): Promise<Uint8Array> {
      try {
        if (!isAvailable()) throw unavailable();
        const ciphertext = encrypt(plaintext);
        if (ciphertext.length === 0 || !isAvailable()) throw unavailable();
        return Promise.resolve(Buffer.concat([header, ciphertext]));
      } catch { return Promise.reject(unavailable()); }
    },
    open(ciphertext: Uint8Array): Promise<string> {
      try {
        if (!isAvailable()) throw unavailable();
        const bytes = Buffer.from(ciphertext);
        if (bytes.length <= header.length || !bytes.subarray(0, header.length).equals(header)) throw unavailable();
        const plaintext = decrypt(bytes.subarray(header.length));
        if (!isAvailable()) throw unavailable();
        return Promise.resolve(plaintext);
      } catch { return Promise.reject(unavailable()); }
    },
  });
}
