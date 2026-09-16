import {
  type Argon2idDeriveFn,
  type Argon2idParams,
  type DecryptProfileBundleResult,
  decryptProfileBundleFile,
  encryptProfileBundleFile,
  parseProfileBundleFile,
  serializeProfileBundleFile,
  type EncryptProfileBundleInput,
  type ProfileBundleFile,
} from "@nautilo/profile-portability";
import type { ProfileBundleCryptoWorkerResponse } from "../workers/profile-bundle-crypto-worker-protocol";

class ProfileBundleBrowserCryptoError extends Error {
  public constructor(message: string) { super(message); this.name = "ProfileBundleBrowserCryptoError"; }
}

/** Explicit ownership cleanup for the only durable key returned by decryption. */
export function disposeDecryptedProfileBundle(result: DecryptProfileBundleResult): void {
  result.dek.fill(0);
}

export function wipeProfileBundleSecret(bytes: Uint8Array): void { bytes.fill(0); }

export interface ProfileBundleBrowserCrypto {
  readonly argon2id: Argon2idDeriveFn;
  dispose(): void;
}

/**
 * A lazy browser Worker adapter. KDF inputs are transferred (not cloned), the
 * worker wipes its views after each derivation, and `dispose()` terminates it.
 * The returned key remains local to this page and is owned by the caller.
 */
export function createProfileBundleBrowserCrypto(): ProfileBundleBrowserCrypto {
  let worker: Worker | null = null;
  let disposed = false;
  const pending = new Map<string, { resolve: (value: Uint8Array) => void; reject: (reason: Error) => void }>();
  const getWorker = (): Worker => {
    if (disposed) throw new ProfileBundleBrowserCryptoError("profile bundle crypto has been disposed");
    if (worker !== null) return worker;
    worker = new Worker(new URL("../workers/profile-bundle-crypto.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<ProfileBundleCryptoWorkerResponse>) => {
      const response = event.data;
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      if (response.type === "derived") request.resolve(new Uint8Array(response.bytes));
      else request.reject(new ProfileBundleBrowserCryptoError(`Argon2id worker failed: ${response.code}`));
    });
    worker.addEventListener("error", () => {
      for (const request of pending.values()) request.reject(new ProfileBundleBrowserCryptoError("Argon2id worker failed"));
      pending.clear();
    });
    return worker;
  };
  return {
    argon2id: ({ passphrase, salt, params }: { readonly passphrase: Uint8Array; readonly salt: Uint8Array; readonly params: Argon2idParams }) => new Promise<Uint8Array>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const passphraseCopy = passphrase.slice();
      const saltCopy = salt.slice();
      pending.set(requestId, { resolve, reject });
      try {
        getWorker().postMessage({ type: "derive-argon2id", requestId, passphrase: passphraseCopy.buffer, salt: saltCopy.buffer, params }, [passphraseCopy.buffer, saltCopy.buffer]);
      } catch (error) {
        pending.delete(requestId);
        wipeProfileBundleSecret(passphraseCopy);
        wipeProfileBundleSecret(saltCopy);
        reject(error instanceof Error ? error : new ProfileBundleBrowserCryptoError(String(error)));
      }
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      worker?.terminate();
      worker = null;
      for (const request of pending.values()) request.reject(new ProfileBundleBrowserCryptoError("profile bundle crypto was disposed"));
      pending.clear();
    },
  };
}

/** Browser-visible scope guard: V1 never reads or emits artifact sidecars. */
export function assertBrowserSupportedProfileBundle(file: ProfileBundleFile): void {
  if (file.artifactStream !== undefined) throw new ProfileBundleBrowserCryptoError("This backup contains artifacts and cannot be restored here yet.");
}

export async function encryptBrowserProfileBundle(input: Omit<EncryptProfileBundleInput, "argon2id">, cryptoAdapter: ProfileBundleBrowserCrypto): Promise<string> {
  try { return serializeProfileBundleFile(await encryptProfileBundleFile({ ...input, argon2id: cryptoAdapter.argon2id })); }
  finally { wipeProfileBundleSecret(input.passphrase); }
}

export async function decryptBrowserProfileBundle(text: string, passphrase: Uint8Array, cryptoAdapter: ProfileBundleBrowserCrypto): Promise<DecryptProfileBundleResult> {
  try {
    const file = parseProfileBundleFile(text);
    assertBrowserSupportedProfileBundle(file);
    return await decryptProfileBundleFile(file, passphrase, cryptoAdapter.argon2id);
  } finally { wipeProfileBundleSecret(passphrase); }
}
