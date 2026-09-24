import {
  taskOperationalCreateV1Schema,
  taskOperationalUpdateV1Schema,
} from "@nautilo/api-client/browser";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeTaskPayloadV1 } from "./task-payload-v1.ts";

const DOMAIN = "nautilo/task-operational-fields/v1\n";
const DUAL_DOMAIN = new TextEncoder().encode(
  "nautilo/task-dual-publication-fields/v1\0",
);

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new TypeError("Task operational fields must be finite, acyclic JSON values");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1
        || keys.some((key) => key !== "length"
          && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)))) {
        throw new TypeError("Task operational arrays must contain only their ordered elements");
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Task operational arrays must contain JSON elements");
        }
        entries.push(canonicalJson(descriptor.value, ancestors));
      }
      return `[${entries.join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Task operational fields must be plain JSON objects");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("Task operational object keys must be strings");
    }
    return `{${(keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Task operational fields must contain JSON properties");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** The same strict transport shape and canonical bytes are used by client and server. */
export function encodeTaskOperationalFieldsV1(
  operation: "create" | "update",
  value: unknown,
): Uint8Array {
  // Reject values JSON transport cannot represent before Zod reads properties.
  canonicalJson(value);
  if (operation !== "create" && operation !== "update") {
    throw new TypeError("Task operational-field operation is invalid");
  }
  const parsed = operation === "create"
    ? taskOperationalCreateV1Schema.parse(value)
    : taskOperationalUpdateV1Schema.parse(value);
  return new TextEncoder().encode(`${DOMAIN}${canonicalJson(parsed)}`);
}

export function fingerprintTaskOperationalFieldsV1(
  operation: "create" | "update",
  value: unknown,
): Uint8Array {
  return sha256(encodeTaskOperationalFieldsV1(operation, value));
}

/** Authenticates both Shadow siblings with one domain-separated commitment. */
export function fingerprintTaskDualPublicationFieldsV1(
  operation: "create" | "update",
  operationalFields: unknown,
  canonicalOrdinaryPayloadBytes: Uint8Array,
): Uint8Array {
  if (!(canonicalOrdinaryPayloadBytes instanceof Uint8Array)) {
    throw new TypeError("Dual Task ordinary payload bytes must be Uint8Array");
  }
  decodeTaskPayloadV1(canonicalOrdinaryPayloadBytes);
  const operationalBytes = encodeTaskOperationalFieldsV1(
    operation,
    operationalFields,
  );
  const frame = new Uint8Array(9);
  const view = new DataView(frame.buffer);
  frame[0] = operation === "create" ? 1 : 2;
  view.setUint32(1, operationalBytes.length, false);
  view.setUint32(5, canonicalOrdinaryPayloadBytes.length, false);
  try {
    return sha256.create()
      .update(DUAL_DOMAIN)
      .update(frame)
      .update(operationalBytes)
      .update(canonicalOrdinaryPayloadBytes)
      .digest();
  } finally {
    frame.fill(0);
    operationalBytes.fill(0);
  }
}
