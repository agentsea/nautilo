/**
 * Key-slot validators. Validates slot shape, slot-id uniqueness/range, slot
 * count bounds, declared Argon2id bounds (recovery), salt/wrapped-DEK
 * lengths, and rejects keychain slots as not-implemented (deferred). Does NOT
 * perform Argon2id derivation or key unwrapping.
 */

import { ARGON2ID_BOUNDS } from "../protection/argon2-bounds";
import { appendError, fail, ok, type PortabilityError, type ValidationResult } from "../errors";
import { LIMITS } from "../container/limits";
import type { KeySlotV1, RecoverySlot, KeychainSlot } from "./types";

type Rec = Record<string, unknown>;

function isObject(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

function validateArgon2idParams(v: unknown, path: string, errors: PortabilityError[]): boolean {
  if (!isObject(v)) {
    errors.push({ code: "KDF_PARAM_OUT_OF_BOUNDS", message: "kdfParams must be object", path });
    return false;
  }
  let good = true;
  const b = ARGON2ID_BOUNDS;
  const m = v["memoryCostKiB"];
  if (typeof m !== "number" || !Number.isInteger(m) || m < b.memoryCostKiB.min || m > b.memoryCostKiB.max) {
    errors.push({ code: "KDF_PARAM_OUT_OF_BOUNDS", message: `memoryCostKiB must be integer in [${b.memoryCostKiB.min}, ${b.memoryCostKiB.max}]`, path: `${path}.memoryCostKiB` });
    good = false;
  }
  const t = v["timeCost"];
  if (typeof t !== "number" || !Number.isInteger(t) || t < b.timeCost.min || t > b.timeCost.max) {
    errors.push({ code: "KDF_PARAM_OUT_OF_BOUNDS", message: `timeCost must be integer in [${b.timeCost.min}, ${b.timeCost.max}]`, path: `${path}.timeCost` });
    good = false;
  }
  const p = v["parallelism"];
  if (typeof p !== "number" || !Number.isInteger(p) || p < b.parallelism.min || p > b.parallelism.max) {
    errors.push({ code: "KDF_PARAM_OUT_OF_BOUNDS", message: `parallelism must be integer in [${b.parallelism.min}, ${b.parallelism.max}]`, path: `${path}.parallelism` });
    good = false;
  }
  const o = v["outputLength"];
  if (typeof o !== "number" || o !== b.outputLength.exactly) {
    errors.push({ code: "KDF_PARAM_OUT_OF_BOUNDS", message: `outputLength must be ${b.outputLength.exactly}`, path: `${path}.outputLength` });
    good = false;
  }
  return good;
}

function validateRecoverySlot(v: Rec, path: string, errors: PortabilityError[]): void {
  if (v["kdf"] !== "argon2id") {
    errors.push({ code: "SLOT_KDF_UNSUPPORTED", message: `kdf must be argon2id, got ${String(v["kdf"])}`, path: `${path}.kdf` });
  }
  validateArgon2idParams(v["kdfParams"], `${path}.kdfParams`, errors);
  const salt = v["salt"];
  if (!isBytes(salt) || salt.length !== ARGON2ID_BOUNDS.saltLength.exactly) {
    errors.push({ code: "SALT_LENGTH_INVALID", message: `salt must be ${ARGON2ID_BOUNDS.saltLength.exactly} bytes`, path: `${path}.salt` });
  }
  const wrapped = v["wrappedDek"];
  if (!isBytes(wrapped) || wrapped.length === 0) {
    errors.push({ code: "WRAPPED_DEK_LENGTH_INVALID", message: "wrappedDek must be non-empty bytes", path: `${path}.wrappedDek` });
  }
  if (!isBytes(v["aad"])) {
    errors.push({ code: "WRAPPED_DEK_LENGTH_INVALID", message: "aad must be bytes", path: `${path}.aad` });
  }
}

function validateKeychainSlot(v: Rec, path: string, errors: PortabilityError[]): void {
  const label = v["keychainLabel"];
  if (typeof label !== "string" || label.length === 0) {
    errors.push({ code: "SLOT_KIND_UNSUPPORTED", message: "keychainLabel must be non-empty string", path: `${path}.keychainLabel` });
  }
  const wrapped = v["wrappedDek"];
  if (!isBytes(wrapped) || wrapped.length === 0) {
    errors.push({ code: "WRAPPED_DEK_LENGTH_INVALID", message: "wrappedDek must be non-empty bytes", path: `${path}.wrappedDek` });
  }
  if (!isBytes(v["aad"])) {
    errors.push({ code: "WRAPPED_DEK_LENGTH_INVALID", message: "aad must be bytes", path: `${path}.aad` });
  }
  errors.push({ code: "KEYCHAIN_SLOT_NOT_IMPLEMENTED", message: "keychain slot is declared but not implemented in Wave 0", path });
}

/** Validate a single key slot. */
export function validateKeySlot(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return fail("SLOT_KIND_UNSUPPORTED", "slot must be object");
  }
  const errors: PortabilityError[] = [];
  const slotId = value["slotId"];
  const path = `keySlots[${typeof slotId === "number" ? slotId : "?"}]`;
  if (typeof slotId !== "number" || !Number.isInteger(slotId) || slotId < 0 || slotId > LIMITS.maxKeySlots) {
    errors.push({ code: "SLOT_ID_OUT_OF_RANGE", message: `slotId must be integer in [0, ${LIMITS.maxKeySlots}]`, path: `${path}.slotId` });
  }
  const kind = value["kind"];
  if (kind === "recovery") {
    validateRecoverySlot(value, path, errors);
  } else if (kind === "keychain") {
    validateKeychainSlot(value, path, errors);
  } else {
    errors.push({ code: "SLOT_KIND_UNSUPPORTED", message: `unknown slot kind: ${String(kind)}`, path: `${path}.kind` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok();
}

/** Validate the full key-slot registry on a header. */
export function validateKeySlots(slots: unknown): ValidationResult {
  if (!isUnknownArray(slots)) {
    return fail("SLOT_COUNT_OUT_OF_BOUNDS", "keySlots must be array");
  }
  let result: ValidationResult = ok();
  if (slots.length < LIMITS.minKeySlots || slots.length > LIMITS.maxKeySlots) {
    result = appendError(result, "SLOT_COUNT_OUT_OF_BOUNDS", `keySlots count must be in [${LIMITS.minKeySlots}, ${LIMITS.maxKeySlots}]`, "keySlots");
  }
  const seen = new Set<number>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const r = validateKeySlot(slot);
    if (!r.ok) {
      for (const e of r.errors) {
        result = appendError(result, e.code, e.message, e.path !== undefined ? e.path : `keySlots[${i}]`);
      }
    }
    if (isObject(slot) && typeof slot["slotId"] === "number") {
      const id = slot["slotId"];
      if (seen.has(id)) {
        result = appendError(result, "SLOT_ID_DUPLICATE", `duplicate slotId ${id}`, `keySlots[${i}].slotId`);
      } else {
        seen.add(id);
      }
    }
  }
  return result;
}

/** Type guards. */
export function isRecoverySlot(v: unknown): v is RecoverySlot {
  return isObject(v) && v["kind"] === "recovery" && validateKeySlot(v).ok;
}

export function isKeychainSlot(v: unknown): v is KeychainSlot {
  return isObject(v) && v["kind"] === "keychain";
}

export function isKeySlotV1(v: unknown): v is KeySlotV1 {
  return validateKeySlot(v).ok;
}
