import { V2_LIMITS } from "./limits.ts";

const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

declare const portableIdBrand: unique symbol;
declare const counterBrand: unique symbol;

export type PortableId<Kind extends string> = string & {
  readonly [portableIdBrand]: Kind;
};

export type HumanId = PortableId<"HumanId">;
export type CryptoDeviceId = PortableId<"CryptoDeviceId">;
export type CryptoDomainId = PortableId<"CryptoDomainId">;
export type NamespaceId = PortableId<"NamespaceId">;
export type ObjectId = PortableId<"ObjectId">;
export type GrantId = PortableId<"GrantId">;
export type AgentId = PortableId<"AgentId">;

export type U64Counter<Kind extends string> = number & {
  readonly [counterBrand]: Kind;
};

export type DomainEpoch = U64Counter<"DomainEpoch">;
export type NamespaceKeyGeneration = U64Counter<"NamespaceKeyGeneration">;
export type AccessRevision = U64Counter<"AccessRevision">;
export type AuthorizationRevision = U64Counter<"AuthorizationRevision">;
export type AgentRuntimeGeneration = U64Counter<"AgentRuntimeGeneration">;
export type UnixTimestamp = U64Counter<"UnixTimestamp">;

export class V2ValidationError extends RangeError {
  override readonly name = "V2ValidationError";
}

export function assertPortableId(
  label: string,
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > V2_LIMITS.idBytes ||
    !PORTABLE_ID_PATTERN.test(value)
  ) {
    throw new V2ValidationError(
      `${label} must be 1-${V2_LIMITS.idBytes} ASCII bytes using the portable identifier grammar`,
    );
  }
}

export function portableIdIsValid(value: unknown): value is string {
  try {
    assertPortableId("id", value);
    return true;
  } catch {
    return false;
  }
}

function brandedId<Kind extends string>(
  label: string,
  value: unknown,
): PortableId<Kind> {
  assertPortableId(label, value);
  return value as PortableId<Kind>;
}

export function humanId(value: unknown): HumanId {
  return brandedId("Human id", value);
}

export function cryptoDeviceId(value: unknown): CryptoDeviceId {
  return brandedId("Crypto device id", value);
}

export function cryptoDomainId(value: unknown): CryptoDomainId {
  return brandedId("Crypto Domain id", value);
}

export function namespaceId(value: unknown): NamespaceId {
  return brandedId("Namespace id", value);
}

export function objectId(value: unknown): ObjectId {
  return brandedId("Object id", value);
}

export function grantId(value: unknown): GrantId {
  return brandedId("Grant id", value);
}

export function agentId(value: unknown): AgentId {
  return brandedId("Agent id", value);
}

export function assertU64Counter(
  label: string,
  value: unknown,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0
  ) {
    throw new V2ValidationError(
      `${label} must be a non-negative safe integer`,
    );
  }
}

function brandedCounter<Kind extends string>(
  label: string,
  value: unknown,
): U64Counter<Kind> {
  assertU64Counter(label, value);
  return value as U64Counter<Kind>;
}

export function domainEpoch(value: unknown): DomainEpoch {
  return brandedCounter("Domain epoch", value);
}

export function namespaceGeneration(
  value: unknown,
): NamespaceKeyGeneration {
  return brandedCounter("Namespace generation", value);
}

export function accessRevision(value: unknown): AccessRevision {
  return brandedCounter("Access revision", value);
}

export function authorizationRevision(
  value: unknown,
): AuthorizationRevision {
  return brandedCounter("Authorization revision", value);
}

export function agentRuntimeGeneration(
  value: unknown,
): AgentRuntimeGeneration {
  return brandedCounter("Agent Runtime generation", value);
}

export function unixTimestamp(value: unknown): UnixTimestamp {
  return brandedCounter("Timestamp", value);
}
