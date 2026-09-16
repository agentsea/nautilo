declare const nautiloProductIdBrand: unique symbol;

export type NautiloProductId<Kind extends string> = string & {
  readonly [nautiloProductIdBrand]: Kind;
};

export type NautiloActorId = NautiloProductId<"Actor">;
export type NautiloUserId = NautiloProductId<"User">;
export type NautiloRoomId = NautiloProductId<"Room">;
export type NautiloGroupId = NautiloProductId<"Group">;
export type NautiloDeviceId = NautiloProductId<"Device">;
export type NautiloNamespaceId = NautiloProductId<"Namespace">;

export type TranslationFailureCode =
  | "invalid_product_id"
  | "invalid_identity_fact"
  | "invalid_namespace_domain_input"
  | "invalid_participant_set"
  | "not_human_actor"
  | "cosmos_not_human"
  | "empty_participant_set"
  | "duplicate_participant"
  | "participant_limit_exceeded";

export interface TranslationFailure {
  readonly code: TranslationFailureCode;
  readonly message: string;
  readonly entityKind?: string;
  readonly inputIndex?: number;
  readonly limit?: number;
  readonly value?: unknown;
}

export type TranslationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: TranslationFailure };

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function productIdIsValid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value);
}

function invalidProductId(
  label: string,
  value: unknown,
): TranslationResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_product_id",
      message: `${label} must be a canonical lowercase UUID`,
      value,
    },
  };
}

function productId<Kind extends string>(
  label: string,
  value: unknown,
): TranslationResult<NautiloProductId<Kind>> {
  if (!productIdIsValid(value)) return invalidProductId(label, value);
  return {
    ok: true,
    value: value as NautiloProductId<Kind>,
  };
}

export function nautiloActorId(
  value: unknown,
): TranslationResult<NautiloActorId> {
  return productId("Nautilo Actor ID", value);
}

export function nautiloUserId(
  value: unknown,
): TranslationResult<NautiloUserId> {
  return productId("Nautilo User ID", value);
}

export function nautiloRoomId(
  value: unknown,
): TranslationResult<NautiloRoomId> {
  return productId("Nautilo Room ID", value);
}

export function nautiloGroupId(
  value: unknown,
): TranslationResult<NautiloGroupId> {
  return productId("Nautilo Group ID", value);
}

export function nautiloDeviceId(
  value: unknown,
): TranslationResult<NautiloDeviceId> {
  return productId("Nautilo Device ID", value);
}

export function nautiloNamespaceId(
  value: unknown,
): TranslationResult<NautiloNamespaceId> {
  return productId("Nautilo Namespace ID", value);
}
