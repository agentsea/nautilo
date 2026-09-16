import type { Argon2idParams } from "@nautilo/profile-portability";

/** Typed, transfer-only protocol. No passphrase, KEK, or DEK is logged or persisted. */
export type ProfileBundleCryptoWorkerRequest = {
  readonly type: "derive-argon2id";
  readonly requestId: string;
  readonly passphrase: ArrayBuffer;
  readonly salt: ArrayBuffer;
  readonly params: Argon2idParams;
};

export type ProfileBundleCryptoWorkerResponse =
  | { readonly type: "derived"; readonly requestId: string; readonly bytes: ArrayBuffer }
  | { readonly type: "error"; readonly requestId: string; readonly code: "INVALID_REQUEST" | "DERIVATION_FAILED" };

function isArgon2idParams(value: unknown): value is Argon2idParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const params = value as Record<string, unknown>;
  return typeof params["memoryCostKiB"] === "number" && Number.isInteger(params["memoryCostKiB"])
    && typeof params["timeCost"] === "number" && Number.isInteger(params["timeCost"])
    && typeof params["parallelism"] === "number" && Number.isInteger(params["parallelism"])
    && typeof params["outputLength"] === "number" && Number.isInteger(params["outputLength"]);
}

export function isProfileBundleCryptoWorkerRequest(value: unknown): value is ProfileBundleCryptoWorkerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request["type"] === "derive-argon2id" && typeof request["requestId"] === "string"
    && request["passphrase"] instanceof ArrayBuffer && request["salt"] instanceof ArrayBuffer
    && isArgon2idParams(request["params"]);
}
