/**
 * Browser-safe wire contract for the D458 mobile controller proof.
 *
 * This deliberately owns the bytes which are signed.  Both the Expo client
 * and the Node verifier must produce this exact JSON array; objects are not
 * used because property ordering is too easy to accidentally change.
 */
export const REMOTE_PAIRING_PROOF_ALGORITHM = "Ed25519" as const;
export const REMOTE_PAIRING_TRANSCRIPT_DOMAIN =
  "nautilo.remote-pairing.consume.v1" as const;
export const REMOTE_ORDINARY_REQUEST_TRANSCRIPT_DOMAIN =
  "nautilo.remote-origin.ordinary-request.v1" as const;

const UUID_LOWERCASE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RemotePairingProofInput {
  readonly challengeId: string;
  readonly ceremonyContext: string;
  readonly installationId: string;
  readonly algorithm: typeof REMOTE_PAIRING_PROOF_ALGORITHM;
  /** Raw 32-byte Ed25519 public key, lowercase hex. */
  readonly publicKey: string;
}

/** Only canonical lowercase hex is accepted on the remote-control wire. */
export function isLowercaseHex(value: string, byteLength: number): boolean {
  return value.length === byteLength * 2 && /^[0-9a-f]+$/.test(value);
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/**
 * Exact UTF-8 text to sign. It intentionally throws for non-canonical input
 * so a caller cannot sign one representation and submit another.
 */
export function canonicalRemotePairingTranscript(input: RemotePairingProofInput): string {
  if (!UUID_LOWERCASE.test(input.challengeId)) {
    throw new Error("remote pairing challenge id must be a lowercase UUID");
  }
  if (!UUID_LOWERCASE.test(input.installationId)) {
    throw new Error("remote pairing installation id must be a lowercase UUID");
  }
  if (input.algorithm !== REMOTE_PAIRING_PROOF_ALGORITHM) {
    throw new Error("unsupported remote pairing proof algorithm");
  }
  if (!isLowercaseHex(input.ceremonyContext, 32)) {
    throw new Error("remote pairing ceremony context must be 32-byte lowercase hex");
  }
  if (!isLowercaseHex(input.publicKey, 32)) {
    throw new Error("remote pairing public key must be 32-byte lowercase hex");
  }
  return JSON.stringify([
    REMOTE_PAIRING_TRANSCRIPT_DOMAIN,
    input.challengeId,
    input.ceremonyContext,
    input.installationId,
    input.algorithm,
    input.publicKey,
  ]);
}

export interface RemoteOrdinaryRequestProofInput {
  readonly serverInstanceId: string;
  readonly serverBindingGeneration: number;
  readonly controllerInstallationId: string;
  readonly installationId: string;
  readonly installationGeneration: number;
  readonly requestId: string;
  readonly issuedAtMs: number;
  readonly method: string;
  readonly path: string;
  readonly bodySha256: string;
}

export interface RemoteOrdinaryRequestProof extends RemoteOrdinaryRequestProofInput {
  readonly algorithm: typeof REMOTE_PAIRING_PROOF_ALGORITHM;
  readonly signature: string;
}

/**
 * Compact server-authored provenance retained on ordinary causal work after
 * proof verification. This is not a host selection and carries no credential.
 */
export interface VerifiedPairedMobileOrigin {
  readonly kind: "paired_mobile";
  readonly serverInstanceId: string;
  readonly serverBindingGeneration: number;
  readonly userId: string;
  readonly actorId: string;
  readonly controllerInstallationId: string;
  readonly installationGeneration: number;
  readonly requestId: string;
}

/**
 * Server-verified provenance for an ordinary message submitted by Electron
 * main through its authenticated, launch-bound Relay session.  The renderer
 * never authors this shape and never receives the credential used to mint it.
 */
export interface VerifiedLocalElectronOrigin {
  readonly kind: "local_electron";
  readonly userId: string;
  readonly actorId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
  readonly requestId: string;
}

/** The only origins that may acquire host-scoped authority in ordinary chat. */
export type VerifiedOrdinaryOrigin =
  | VerifiedPairedMobileOrigin
  | VerifiedLocalElectronOrigin;

/**
 * The JSON subset Electron main may normalize before it mints a local-origin
 * credential. This is deliberately distinct from the canonicalizer below:
 * normalization applies JSON's omission/null rules, while canonicalization
 * remains strict for the paired-mobile/shared signing boundary.
 */
export type RemoteOrdinaryRequestJsonValue =
  | null
  | boolean
  | number
  | string
  | RemoteOrdinaryRequestJsonValue[]
  | RemoteOrdinaryRequestJsonObject;

export interface RemoteOrdinaryRequestJsonObject {
  [key: string]: RemoteOrdinaryRequestJsonValue;
}

const REMOTE_ORDINARY_NORMALIZATION_MAX_DEPTH = 64;
const REMOTE_ORDINARY_NORMALIZATION_MAX_PATH_CHARS = 160;
const REMOTE_ORDINARY_NORMALIZATION_MAX_KEY_CHARS = 48;

function normalizationPathForKey(path: string, key: string): string {
  const segment = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && key.length <= REMOTE_ORDINARY_NORMALIZATION_MAX_KEY_CHARS
    ? `.${key}`
    : ".[key]";
  const candidate = `${path}${segment}`;
  return candidate.length <= REMOTE_ORDINARY_NORMALIZATION_MAX_PATH_CHARS
    ? candidate
    : `${candidate.slice(0, REMOTE_ORDINARY_NORMALIZATION_MAX_PATH_CHARS - 1)}…`;
}

function normalizationPathForIndex(path: string, index: number): string {
  const candidate = `${path}[${index}]`;
  return candidate.length <= REMOTE_ORDINARY_NORMALIZATION_MAX_PATH_CHARS
    ? candidate
    : `${candidate.slice(0, REMOTE_ORDINARY_NORMALIZATION_MAX_PATH_CHARS - 1)}…`;
}

function rejectRemoteOrdinaryNormalization(valueClass: string, path: string): never {
  throw new Error(
    `remote ordinary body normalization rejected ${valueClass} at ${path}`,
  );
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function normalizeRemoteOrdinaryRequestJsonValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: WeakSet<object>,
): RemoteOrdinaryRequestJsonValue {
  if (depth > REMOTE_ORDINARY_NORMALIZATION_MAX_DEPTH) {
    return rejectRemoteOrdinaryNormalization("nesting limit", path);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return rejectRemoteOrdinaryNormalization("non-finite number", path);
    }
    return value;
  }
  if (value === undefined) {
    return rejectRemoteOrdinaryNormalization("undefined", path);
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return rejectRemoteOrdinaryNormalization(typeof value, path);
  }
  if (typeof value !== "object") {
    return rejectRemoteOrdinaryNormalization(typeof value, path);
  }
  if (ancestors.has(value)) {
    return rejectRemoteOrdinaryNormalization("cyclic reference", path);
  }
  if (!Array.isArray(value) && !isPlainJsonObject(value)) {
    return rejectRemoteOrdinaryNormalization("unsupported object", path);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const array = value as readonly unknown[];
      const normalized: RemoteOrdinaryRequestJsonValue[] = [];
      for (let index = 0; index < array.length; index += 1) {
        const item = array[index];
        normalized.push(
          item === undefined
            ? null
            : normalizeRemoteOrdinaryRequestJsonValue(
              item,
              normalizationPathForIndex(path, index),
              depth + 1,
              ancestors,
            ),
        );
      }
      return normalized;
    }

    const normalized: RemoteOrdinaryRequestJsonObject = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined) continue;
      // Assignment would invoke Object.prototype's __proto__ setter and lose a
      // valid JSON own key. Define an own data property so normalized JSON
      // preserves every non-undefined source key with ordinary object shape.
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: normalizeRemoteOrdinaryRequestJsonValue(
          item,
          normalizationPathForKey(path, key),
          depth + 1,
          ancestors,
        ),
        writable: true,
      });
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces the JSON object Electron main will both digest and transmit.
 *
 * Object-valued `undefined` follows JSON omission semantics and array slots
 * become `null`; all other non-JSON values fail closed with a bounded,
 * value-free structural diagnostic. The body is object-only because the room
 * message API has an object request contract.
 */
export function normalizeRemoteOrdinaryRequestBody(
  value: unknown,
): RemoteOrdinaryRequestJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return rejectRemoteOrdinaryNormalization(
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      "$",
    );
  }
  if (!isPlainJsonObject(value)) {
    return rejectRemoteOrdinaryNormalization("unsupported object", "$");
  }
  return normalizeRemoteOrdinaryRequestJsonValue(value, "$", 0, new WeakSet()) as RemoteOrdinaryRequestJsonObject;
}

/**
 * Canonical JSON for the body digest shared by Expo and the server. Object
 * keys sort; array order remains meaningful; non-JSON values fail closed.
 */
export function canonicalRemoteOrdinaryRequestBody(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("remote ordinary body number must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRemoteOrdinaryRequestBody).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) {
        throw new Error("remote ordinary body cannot contain undefined");
      }
      return `${JSON.stringify(key)}:${canonicalRemoteOrdinaryRequestBody(record[key])}`;
    }).join(",")}}`;
  }
  throw new Error("remote ordinary body must be JSON-compatible");
}

/** Exact ordinary-message bytes signed by an already-paired mobile install. */
export function canonicalRemoteOrdinaryRequestTranscript(
  input: RemoteOrdinaryRequestProofInput,
): string {
  for (const [name, value] of [
    ["server instance", input.serverInstanceId],
    ["controller installation", input.controllerInstallationId],
    ["installation", input.installationId],
    ["request", input.requestId],
  ] as const) {
    if (!UUID_LOWERCASE.test(value)) {
      throw new Error(`remote ordinary ${name} id must be a lowercase UUID`);
    }
  }
  if (!Number.isSafeInteger(input.serverBindingGeneration) || input.serverBindingGeneration < 1) {
    throw new Error("remote ordinary server binding generation must be positive");
  }
  if (!Number.isSafeInteger(input.installationGeneration) || input.installationGeneration < 1) {
    throw new Error("remote ordinary installation generation must be positive");
  }
  if (!Number.isSafeInteger(input.issuedAtMs) || input.issuedAtMs < 1) {
    throw new Error("remote ordinary issued-at must be a positive integer");
  }
  if (!/^[A-Z]{3,12}$/.test(input.method)) {
    throw new Error("remote ordinary method must be canonical uppercase ASCII");
  }
  if (
    input.path.length < 1 ||
    input.path.length > 1024 ||
    !input.path.startsWith("/") ||
    input.path.includes("?") ||
    input.path.includes("#") ||
    hasAsciiControl(input.path)
  ) {
    throw new Error("remote ordinary path must be a canonical path without query or fragment");
  }
  if (!isLowercaseHex(input.bodySha256, 32)) {
    throw new Error("remote ordinary body digest must be 32-byte lowercase hex");
  }
  return JSON.stringify([
    REMOTE_ORDINARY_REQUEST_TRANSCRIPT_DOMAIN,
    input.serverInstanceId,
    input.serverBindingGeneration,
    input.controllerInstallationId,
    input.installationId,
    input.installationGeneration,
    input.requestId,
    input.issuedAtMs,
    input.method,
    input.path,
    input.bodySha256,
  ]);
}
