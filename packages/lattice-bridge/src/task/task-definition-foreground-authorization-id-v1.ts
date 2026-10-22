import type { LatticeCrypto } from "@nautilo/lattice-crypto";

const PREFIX = "task1:";
const PAYLOAD_BYTES = 90;
const ENCODED_LENGTH = 126;
const PARENT_OPERATION_HASH_DOMAIN =
  "nautilo/task-definition-parent-operation/v1\n";
const RECIPIENT_KEY_HASH_DOMAIN =
  "nautilo/task-definition-recipient-key/v1\n";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type TaskDefinitionForegroundAuthorizationCoordinatesV1 = Readonly<{
  taskId: string;
  operation: "create" | "update";
  targetContentRevision: number;
  parentOperationHash: Uint8Array;
  workDescriptorDigest: Uint8Array;
}>;

/** The Device-signed V2 recipient ID commits the exact temporary author key.
 * It stays within the existing 128-byte portable ID format. */
export function deriveTaskDefinitionForegroundRecipientKeyIdV1(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Readonly<{ authorizationId: string; parentAgentSignerPublicKey: Uint8Array }>,
): string {
  const coordinates = parseTaskDefinitionForegroundAuthorizationIdV1(input.authorizationId);
  if (coordinates === null) throw new TypeError("Task definition authorization ID is invalid");
  coordinates.parentOperationHash.fill(0);
  coordinates.workDescriptorDigest.fill(0);
  if (!(input.parentAgentSignerPublicKey instanceof Uint8Array)
    || input.parentAgentSignerPublicKey.length !== 32) {
    throw new TypeError("Task definition parent signer key is invalid");
  }
  const prefix = new TextEncoder().encode(
    `${RECIPIENT_KEY_HASH_DOMAIN}${input.authorizationId}\n`,
  );
  const material = new Uint8Array(prefix.length + input.parentAgentSignerPublicKey.length);
  material.set(prefix);
  material.set(input.parentAgentSignerPublicKey, prefix.length);
  let digest: Uint8Array | undefined;
  try {
    digest = crypto.hash(material);
    return `task-key:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  } finally {
    prefix.fill(0);
    material.fill(0);
    digest?.fill(0);
  }
}

/** Encodes the exact Task mutation into the existing portable V2 authorization ID. */
export function taskDefinitionForegroundAuthorizationIdV1(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Readonly<{
    parentOperationId: string;
    taskId: string;
    operation: "create" | "update";
    targetContentRevision: number;
    workDescriptorDigest: Uint8Array;
  }>,
): string {
  if (!(input.workDescriptorDigest instanceof Uint8Array)
    || input.workDescriptorDigest.length !== 32) {
    throw new TypeError("Task definition work descriptor digest is invalid");
  }
  if (!Number.isSafeInteger(input.targetContentRevision)
    || input.targetContentRevision < 1) {
    throw new TypeError("Task definition target content revision is invalid");
  }
  const taskId = uuidBytes(input.taskId);
  const parentMaterial = new TextEncoder().encode(
    `${PARENT_OPERATION_HASH_DOMAIN}${input.parentOperationId}`,
  );
  const parentOperationHash = crypto.hash(parentMaterial);
  const value = new Uint8Array(PAYLOAD_BYTES);
  try {
    value[0] = 1;
    value[1] = input.operation === "create" ? 0 : 1;
    value.set(taskId, 2);
    new DataView(value.buffer, value.byteOffset, value.byteLength)
      .setBigUint64(18, BigInt(input.targetContentRevision), false);
    value.set(parentOperationHash, 26);
    value.set(input.workDescriptorDigest, 58);
    return `${PREFIX}${base64url(value)}`;
  } finally {
    taskId.fill(0);
    parentMaterial.fill(0);
    parentOperationHash.fill(0);
    value.fill(0);
  }
}

export function parseTaskDefinitionForegroundAuthorizationIdV1(
  authorizationId: string,
): TaskDefinitionForegroundAuthorizationCoordinatesV1 | null {
  if (authorizationId.length !== ENCODED_LENGTH
    || !authorizationId.startsWith(PREFIX)) return null;
  const encoded = authorizationId.slice(PREFIX.length);
  let value: Uint8Array;
  try { value = fromBase64url(encoded); }
  catch { return null; }
  if (value.length !== PAYLOAD_BYTES
    || base64url(value) !== encoded
    || value[0] !== 1
    || (value[1] !== 0 && value[1] !== 1)) {
    value.fill(0);
    return null;
  }
  const revision = new DataView(value.buffer, value.byteOffset, value.byteLength)
    .getBigUint64(18, false);
  if (revision < 1n || revision > BigInt(Number.MAX_SAFE_INTEGER)) {
    value.fill(0);
    return null;
  }
  const parsed = Object.freeze({
    taskId: uuidString(value.subarray(2, 18)),
    operation: value[1] === 0 ? "create" as const : "update" as const,
    targetContentRevision: Number(revision),
    parentOperationHash: value.slice(26, 58),
    workDescriptorDigest: value.slice(58, 90),
  });
  value.fill(0);
  return parsed;
}

export function taskDefinitionForegroundAuthorizationIdV1Matches(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Readonly<{
    authorizationId: string;
    parentOperationId: string;
    taskId: string;
    operation: "create" | "update";
    targetContentRevision: number;
    workDescriptorDigest: Uint8Array;
  }>,
): boolean {
  try {
    return taskDefinitionForegroundAuthorizationIdV1(crypto, input)
      === input.authorizationId;
  } catch {
    return false;
  }
}

function uuidBytes(value: string): Uint8Array {
  if (!UUID.test(value)) {
    throw new TypeError("Task definition Task ID is invalid");
  }
  const hex = value.replaceAll("-", "");
  const result = new Uint8Array(16);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function uuidString(value: Uint8Array): string {
  const hex = Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}
