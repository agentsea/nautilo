import { GRANT_FORMAT_VERSION, serializeGrant } from "./format/grant-v1.ts";
import { ENCRYPTED_OBJECT_FORMAT_VERSION } from "./format/object-v1.ts";
import { LATTICE_LIMITS } from "./limits.ts";
import type {
  Epoch,
  Grant,
  GrantOperation,
  NamespaceId,
} from "./types/index.ts";
import { utf8 } from "./util/bytes.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const OPERATIONS = new Set<GrantOperation>(["decrypt", "encrypt"]);

export class InputValidationError extends RangeError {
  override readonly name = "InputValidationError";
}

function fail(message: string): never {
  throw new InputValidationError(message);
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertId(label: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !ID_PATTERN.test(value) ||
    utf8(value).length > LATTICE_LIMITS.idBytes
  ) {
    fail(
      `${label} must be 1-${LATTICE_LIMITS.idBytes} UTF-8 bytes using the portable identifier grammar`,
    );
  }
}

export function idIsValid(value: unknown): value is string {
  try {
    assertId("id", value);
    return true;
  } catch {
    return false;
  }
}

export function assertIdList(
  label: string,
  values: unknown,
  minimum: number,
  maximum: number,
): asserts values is string[] {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
    fail(`${label} must contain ${minimum}-${maximum} identifiers`);
  }
  for (const value of values) assertId(`${label} entry`, value);
}

function assertCanonicalIdSet(
  label: string,
  values: unknown,
  minimum: number,
  maximum: number,
): asserts values is string[] {
  assertIdList(label, values, minimum, maximum);
  const canonical = [...new Set(values)].sort((left, right) =>
    left.localeCompare(right)
  );
  if (
    canonical.length !== values.length ||
    canonical.some((value, index) => value !== values[index])
  ) {
    fail(`${label} must be sorted and duplicate-free`);
  }
}

export function assertEpoch(label: string, value: unknown): asserts value is Epoch {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
}

export function assertTimestamp(
  label: string,
  value: unknown,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a finite non-negative safe integer`);
  }
}

export function assertBytes(
  label: string,
  value: unknown,
  minimum: number,
  maximum: number,
): asserts value is Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail(`${label} must contain ${minimum}-${maximum} bytes`);
  }
}

export function assertPlaintext(value: unknown): asserts value is Uint8Array {
  assertBytes("plaintext", value, 0, LATTICE_LIMITS.plaintextBytes);
}

export function plaintextIsValid(value: unknown): value is Uint8Array {
  try {
    assertPlaintext(value);
    return true;
  } catch {
    return false;
  }
}

export function assertBatchSize(label: string, length: number): void {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > LATTICE_LIMITS.batchItems
  ) {
    fail(`${label} batch exceeds the ${LATTICE_LIMITS.batchItems}-item limit`);
  }
}

export function assertGrantTtl(ttlMs: unknown): asserts ttlMs is number {
  if (
    !Number.isSafeInteger(ttlMs) ||
    (ttlMs as number) <= 0 ||
    (ttlMs as number) > LATTICE_LIMITS.grantTtlMs
  ) {
    fail(
      `ttlMs must be a finite positive integer no greater than ${LATTICE_LIMITS.grantTtlMs}`,
    );
  }
}

function assertOperations(
  operations: unknown,
): asserts operations is GrantOperation[] {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 2) {
    fail("operations must contain one or two capabilities");
  }
  const seen = new Set<string>();
  for (const operation of operations) {
    if (
      typeof operation !== "string" ||
      !OPERATIONS.has(operation as GrantOperation) ||
      seen.has(operation)
    ) {
      fail("operations must be unique values from decrypt and encrypt");
    }
    seen.add(operation);
  }
}

export function canonicalOperations(
  operations: GrantOperation[],
): GrantOperation[] {
  assertOperations(operations);
  return [...operations].sort((left, right) => left.localeCompare(right));
}

export function assertHistoricalEpochs(
  value: unknown,
): asserts value is Record<NamespaceId, Epoch[]> {
  if (!isPlainRecord(value)) fail("historical epochs must be a plain object");
  const entries = Object.entries(value);
  if (entries.length > LATTICE_LIMITS.coveredNamespaces) {
    fail("historical epochs exceed the namespace limit");
  }
  let total = 0;
  for (const [namespaceId, epochs] of entries) {
    assertId("historical epoch namespace id", namespaceId);
    if (
      !Array.isArray(epochs) ||
      epochs.length > LATTICE_LIMITS.epochsPerNamespace
    ) {
      fail(
        `historical epochs must contain at most ${LATTICE_LIMITS.epochsPerNamespace} epochs per namespace`,
      );
    }
    for (const epoch of epochs) assertEpoch("historical epoch", epoch);
    if (new Set(epochs).size !== epochs.length) {
      fail("historical epochs must be duplicate-free");
    }
    total += epochs.length;
    if (total > LATTICE_LIMITS.totalGrantEpochs) {
      fail("historical epochs exceed the total epoch limit");
    }
  }
}

function shapeFailure(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid input";
  }
}

export function grantShapeFailure(value: unknown): string | null {
  return shapeFailure(() => {
    if (!isPlainRecord(value)) fail("grant must be a plain object");
    if (value["formatVersion"] !== GRANT_FORMAT_VERSION) {
      fail("grant format version is unsupported");
    }
    assertId("grant id", value["id"]);
    assertId("issuing device id", value["issuingDeviceId"]);
    assertCanonicalIdSet(
      "grant scope",
      value["scope"],
      1,
      LATTICE_LIMITS.grantScope,
    );
    assertOperations(value["operations"]);
    const operations = value["operations"];
    const sortedOperations = [...operations].sort((left, right) =>
      left.localeCompare(right)
    );
    if (sortedOperations.some((operation, index) =>
      operation !== operations[index]
    )) {
      fail("grant operations must be canonical");
    }
    assertTimestamp("grant issuedAt", value["issuedAt"]);
    assertTimestamp("grant expiresAt", value["expiresAt"]);
    const issuedAt = value["issuedAt"];
    const expiresAt = value["expiresAt"];
    if (expiresAt <= issuedAt) {
      fail("grant expiry must be after issuance");
    }
    if (expiresAt - issuedAt > LATTICE_LIMITS.grantTtlMs) {
      fail("grant lifetime exceeds the TTL limit");
    }
    if (!isPlainRecord(value["coveredEpochs"])) {
      fail("covered epochs must be a plain object");
    }
    const entries = Object.entries(value["coveredEpochs"]);
    if (
      entries.length > LATTICE_LIMITS.coveredNamespaces
    ) {
      fail("covered epochs exceed the namespace limit");
    }
    const namespaceIds = entries.map(([namespaceId]) => namespaceId);
    const sortedNamespaceIds = [...namespaceIds].sort((left, right) =>
      left.localeCompare(right)
    );
    if (sortedNamespaceIds.some((id, index) => id !== namespaceIds[index])) {
      fail("covered epoch namespaces must be canonical");
    }
    let totalEpochs = 0;
    for (const [namespaceId, epochs] of entries) {
      assertId("covered epoch namespace id", namespaceId);
      if (
        !Array.isArray(epochs) ||
        epochs.length < 1 ||
        epochs.length > LATTICE_LIMITS.epochsPerNamespace
      ) {
        fail("covered epoch set is empty or exceeds its limit");
      }
      for (const epoch of epochs) assertEpoch("covered epoch", epoch);
      const canonicalEpochs = [...new Set(epochs)].sort(
        (left, right) => left - right,
      );
      if (
        canonicalEpochs.length !== epochs.length ||
        canonicalEpochs.some((epoch, index) => epoch !== epochs[index])
      ) {
        fail("covered epoch sets must be sorted and duplicate-free");
      }
      totalEpochs += epochs.length;
      if (totalEpochs > LATTICE_LIMITS.totalGrantEpochs) {
        fail("covered epochs exceed the total epoch limit");
      }
    }
    assertBytes(
      "grant encrypted secret",
      value["encryptedSecret"],
      1,
      LATTICE_LIMITS.grantSecretBytes,
    );
    assertId("grant scheme", value["scheme"]);
    if (utf8(value["scheme"]).length > LATTICE_LIMITS.schemeIdBytes) {
      fail("grant scheme exceeds its byte limit");
    }
    assertBytes(
      "grant signature",
      value["signature"],
      LATTICE_LIMITS.signatureBytes,
      LATTICE_LIMITS.signatureBytes,
    );
    if (
      typeof value["singleUse"] !== "boolean" ||
      typeof value["consumed"] !== "boolean"
    ) {
      fail("grant flags must be boolean");
    }
    if (serializeGrant(value as unknown as Grant).length >
      LATTICE_LIMITS.grantWireBytes) {
      fail("grant wire bytes exceed the limit");
    }
  });
}

export function objectShapeFailure(value: unknown): string | null {
  return shapeFailure(() => {
    if (!isPlainRecord(value)) fail("encrypted object must be a plain object");
    if (value["formatVersion"] !== ENCRYPTED_OBJECT_FORMAT_VERSION) {
      fail("encrypted object format version is unsupported");
    }
    assertId("object id", value["id"]);
    assertId("object namespace id", value["namespaceId"]);
    assertEpoch("object epoch", value["epoch"]);
    assertTimestamp("object createdAt", value["createdAt"]);
    assertBytes(
      "wrapped DEK",
      value["wrappedDek"],
      40,
      LATTICE_LIMITS.wrappedDekBytes,
    );
    assertBytes(
      "ciphertext",
      value["ciphertext"],
      40,
      LATTICE_LIMITS.ciphertextBytes,
    );
  });
}
