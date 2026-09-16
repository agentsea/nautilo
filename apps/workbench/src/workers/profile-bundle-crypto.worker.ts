import { argon2id } from "hash-wasm";
import { protection } from "@nautilo/profile-portability";
import {
  isProfileBundleCryptoWorkerRequest,
  type ProfileBundleCryptoWorkerResponse,
} from "./profile-bundle-crypto-worker-protocol";

const workerScope = self as unknown as { postMessage(message: ProfileBundleCryptoWorkerResponse, transfer?: Transferable[]): void };
const ARGON2ID_BOUNDS = protection.ARGON2ID_BOUNDS;

function wipe(bytes: Uint8Array): void { bytes.fill(0); }

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleMessage(event.data);
});

async function handleMessage(message: unknown): Promise<void> {
  if (!isProfileBundleCryptoWorkerRequest(message) || !withinBounds(message.params)) {
    const requestId = typeof message === "object" && message !== null && "requestId" in message && typeof (message as { requestId?: unknown }).requestId === "string"
      ? (message as { requestId: string }).requestId : "";
    workerScope.postMessage({ type: "error", requestId, code: "INVALID_REQUEST" } satisfies ProfileBundleCryptoWorkerResponse);
    return;
  }
  const passphrase = new Uint8Array(message.passphrase);
  const salt = new Uint8Array(message.salt);
  let derived: Uint8Array | null = null;
  try {
    derived = await argon2id({
      password: passphrase,
      salt,
      iterations: message.params.timeCost,
      parallelism: message.params.parallelism,
      memorySize: message.params.memoryCostKiB,
      hashLength: message.params.outputLength,
      outputType: "binary",
    });
    const buffer = derived.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error("Argon2id produced a non-transferable buffer");
    workerScope.postMessage({ type: "derived", requestId: message.requestId, bytes: buffer } satisfies ProfileBundleCryptoWorkerResponse, [buffer]);
  } catch {
    workerScope.postMessage({ type: "error", requestId: message.requestId, code: "DERIVATION_FAILED" } satisfies ProfileBundleCryptoWorkerResponse);
  } finally {
    wipe(passphrase);
    wipe(salt);
    // A successful transfer detaches the buffer. Wipe it if posting failed.
    if (derived !== null && derived.byteLength > 0) wipe(derived);
  }
}

function withinBounds(params: { readonly memoryCostKiB: number; readonly timeCost: number; readonly parallelism: number; readonly outputLength: number }): boolean {
  return params.memoryCostKiB >= ARGON2ID_BOUNDS.memoryCostKiB.min && params.memoryCostKiB <= ARGON2ID_BOUNDS.memoryCostKiB.max
    && params.timeCost >= ARGON2ID_BOUNDS.timeCost.min && params.timeCost <= ARGON2ID_BOUNDS.timeCost.max
    && params.parallelism >= ARGON2ID_BOUNDS.parallelism.min && params.parallelism <= ARGON2ID_BOUNDS.parallelism.max
    && params.outputLength === ARGON2ID_BOUNDS.outputLength.exactly;
}
