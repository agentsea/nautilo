/**
 * Nominal wrapper used at the server-storage boundary. Plain `Uint8Array`
 * values and key-shaped objects are intentionally not assignable.
 *
 * This marker does not claim to detect whether arbitrary bytes are genuinely
 * encrypted; that proof belongs to the producing crypto operation. It does
 * make every persistence call explicit and lets the reference implementation
 * reject common untyped-boundary substitutions at runtime.
 */

export type OpaqueByteKind =
  | "human-keyring-envelope"
  | "ai-keyring-envelope"
  | "encrypted-payload"
  | "namespace-object-envelope"
  | "agent-runtime-config-dek"
  | "agent-runtime-domain-envelope"
  | "grant"
  | "recovery-archive";

declare const opaqueBytesBrand: unique symbol;
const opaqueSnapshots = new WeakMap<
  object,
  Readonly<{
    readonly kind: OpaqueByteKind;
    readonly ciphertext: Uint8Array;
  }>
>();

const typedArrayTagDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag,
)!;

/**
 * Copy a genuine Uint8Array view through its internal typed-array slots.
 * Subclass-owned slice, species, iterator, and length hooks are never invoked.
 */
export function copyOwnedBytesV2(value: Uint8Array): Uint8Array {
  if (
    typedArrayTagDescriptor.get!.call(value) !== "Uint8Array"
  ) {
    throw new TypeError("owned byte source must be a genuine Uint8Array");
  }
  return new Uint8Array(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.every((byte, index) => byte === right[index]);
}

export type OpaqueBytes<Kind extends OpaqueByteKind> = Readonly<{
  readonly classification: "opaque-ciphertext";
  readonly kind: Kind;
  readonly ciphertext: Uint8Array;
  readonly [opaqueBytesBrand]: true;
}>;

export type OpaqueAgentRuntimeConfigDekV2 =
  OpaqueBytes<"agent-runtime-config-dek">;

export function opaqueBytes<Kind extends OpaqueByteKind>(
  kind: Kind,
  ciphertext: Uint8Array,
): OpaqueBytes<Kind> {
  if (!(ciphertext instanceof Uint8Array)) {
    throw new TypeError(`opaque ${kind} must contain Uint8Array ciphertext`);
  }
  const value = Object.freeze({
    classification: "opaque-ciphertext" as const,
    kind,
    ciphertext: copyOwnedBytesV2(ciphertext),
  }) as OpaqueBytes<Kind>;
  opaqueSnapshots.set(value, {
    kind,
    ciphertext: copyOwnedBytesV2(value.ciphertext),
  });
  return value;
}

/**
 * Internal construction capability used only after the Runtime crypto
 * workflow has authenticated and produced a wrapped config DEK.
 * It is intentionally absent from the supported package root.
 */
export function authenticatedAgentRuntimeConfigDekV2(
  ciphertext: Uint8Array,
): OpaqueAgentRuntimeConfigDekV2 {
  return opaqueBytes("agent-runtime-config-dek", ciphertext);
}

export function assertOpaqueBytes<Kind extends OpaqueByteKind>(
  label: string,
  value: unknown,
  expectedKind: Kind,
): asserts value is OpaqueBytes<Kind> {
  const reject = (): never => {
    throw new TypeError(
      `${label} must be opaque ${expectedKind} ciphertext`,
    );
  };
  const candidate = Object(value) as Record<string, unknown>;
  const snapshot = opaqueSnapshots.get(candidate);
  if (
    snapshot === undefined
    || snapshot.kind !== expectedKind
    || !equalBytes(
      snapshot.ciphertext,
      candidate["ciphertext"] as Uint8Array,
    )
  ) {
    reject();
  }
}

export function cloneOpaqueBytes<Kind extends OpaqueByteKind>(
  value: OpaqueBytes<Kind>,
): OpaqueBytes<Kind> {
  assertOpaqueBytes("opaque bytes", value, value.kind);
  return opaqueBytes(value.kind, value.ciphertext);
}
