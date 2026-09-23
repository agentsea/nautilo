import type {
  DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry,
} from "@nautilo/lattice-crypto";

declare const domainCompressedLiveShadowSessionCapabilityBrand: unique symbol;

export type DomainCompressedLiveShadowSessionCapability = Readonly<{
  readonly authorizationId: string;
  readonly expiresAt: number;
  readonly [domainCompressedLiveShadowSessionCapabilityBrand]: true;
}>;

export type LegacyDomainCompressedLiveShadowSessionCapabilityDescription = Readonly<{
  readonly authorizationId: string;
  readonly subjectHumanId: string;
  readonly issuingDeviceId: string;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly policyRevision: number;
  readonly hostAuthorizationRevision: number;
  readonly agentAuthorizationRevision: number;
  readonly agentRuntimeGeneration: number;
  readonly namespaceIds: readonly string[];
  readonly grantDomainIds: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly authorizationDigest: Uint8Array;
}>;

export type RuntimeDomainCompressedLiveShadowSessionCapabilityDescription =
  Readonly<{
    readonly authorizationId: string;
    readonly subjectHumanId: string;
    readonly issuingDeviceId: string;
    readonly recipientKind: "nautilo_foreground_runtime";
    readonly browserSessionId: string;
    readonly topLevelRoomId: string;
    readonly recipientKeyId: string;
    readonly policyRevision: number;
    readonly hostAuthorizationRevision: number;
    readonly namespaceIds: readonly string[];
    readonly grantDomainIds: readonly string[];
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly authorizationDigest: Uint8Array;
  }>;

export type TaskRuntimeDomainCompressedLiveShadowSessionCapabilityDescription =
  Readonly<{
    readonly authorizationId: string;
    readonly subjectHumanId: string;
    readonly issuingDeviceId: string;
    readonly recipientKind: "nautilo_task_runtime";
    readonly taskRunId: string;
    readonly authorizationEpisodeId: string;
    readonly sourceRoomId: string;
    readonly recipientKeyId: string;
    readonly policyRevision: number;
    readonly hostAuthorizationRevision: number;
    readonly namespaceIds: readonly string[];
    readonly grantDomainIds: readonly string[];
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly authorizationDigest: Uint8Array;
  }>;

export type DomainCompressedLiveShadowSessionCapabilityDescription =
  | LegacyDomainCompressedLiveShadowSessionCapabilityDescription
  | RuntimeDomainCompressedLiveShadowSessionCapabilityDescription;

type AnyDomainCompressedLiveShadowSessionCapabilityDescription =
  | DomainCompressedLiveShadowSessionCapabilityDescription
  | TaskRuntimeDomainCompressedLiveShadowSessionCapabilityDescription;

type State = Readonly<{
  readonly description: AnyDomainCompressedLiveShadowSessionCapabilityDescription;
  readonly entries:
    readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry[];
}>;

const states = new WeakMap<object, State>();

function portableIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).length <= 256;
}

function canonicalIds(values: readonly string[]): readonly string[] {
  if (
    values.length < 1
    || values.some((value) => value.length < 1 || value.length > 256)
    || values.some((value, index) =>
      index > 0 && values[index - 1]! >= value
    )
  ) throw new TypeError("Foreground session authority IDs are not canonical");
  return Object.freeze([...values]);
}

function copyEntries(
  entries: readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry[],
): readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    participantDigest: entry.participantDigest.slice(),
    headDigest: entry.headDigest.slice(),
    domainAiGrantKey: entry.domainAiGrantKey.slice(),
  })));
}

function destroyEntries(
  entries: readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry[],
): void {
  entries.forEach((entry) => {
    entry.participantDigest.fill(0);
    entry.headDigest.fill(0);
    entry.domainAiGrantKey.fill(0);
  });
}

export function createDomainCompressedLiveShadowSessionCapability(
  input: Readonly<{
    description: AnyDomainCompressedLiveShadowSessionCapabilityDescription;
    entries:
      readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry[];
  }>,
): DomainCompressedLiveShadowSessionCapability {
  const namespaceIds = canonicalIds(input.description.namespaceIds);
  const grantDomainIds = canonicalIds(input.description.grantDomainIds);
  if (
    input.description.authorizationDigest.length !== 32
    || input.description.issuedAt < 0
    || input.description.expiresAt <= input.description.issuedAt
    || input.entries.length !== grantDomainIds.length
    || input.entries.some((entry, index) =>
      entry.grantDomainId !== grantDomainIds[index]
    )
  ) throw new TypeError("Domain-compressed foreground session is invalid");
  if (
    "recipientKind" in input.description
    && input.description.recipientKind === "nautilo_task_runtime"
    && (
      !portableIdentity(input.description.authorizationId)
      || !portableIdentity(input.description.subjectHumanId)
      || !portableIdentity(input.description.issuingDeviceId)
      || !portableIdentity(input.description.taskRunId)
      || !portableIdentity(input.description.authorizationEpisodeId)
      || !portableIdentity(input.description.sourceRoomId)
      || !portableIdentity(input.description.recipientKeyId)
    )
  ) throw new TypeError("Domain-compressed Task Runtime session is invalid");
  const capability = Object.freeze({
    authorizationId: input.description.authorizationId,
    expiresAt: input.description.expiresAt,
  }) as DomainCompressedLiveShadowSessionCapability;
  states.set(capability, Object.freeze({
    description: Object.freeze({
      ...input.description,
      namespaceIds,
      grantDomainIds,
      authorizationDigest: input.description.authorizationDigest.slice(),
    }),
    entries: copyEntries(input.entries),
  }));
  return capability;
}

export function inspectDomainCompressedLiveShadowSessionCapability(
  capability: DomainCompressedLiveShadowSessionCapability,
): DomainCompressedLiveShadowSessionCapabilityDescription | null {
  const state = states.get(capability);
  if (
    state === undefined
    || (
      "recipientKind" in state.description
      && state.description.recipientKind === "nautilo_task_runtime"
    )
  ) return null;
  return Object.freeze({
    ...state.description,
    namespaceIds: Object.freeze([...state.description.namespaceIds]),
    grantDomainIds: Object.freeze([...state.description.grantDomainIds]),
    authorizationDigest: state.description.authorizationDigest.slice(),
  });
}

export function inspectTaskRuntimeDomainCompressedLiveShadowSessionCapability(
  capability: DomainCompressedLiveShadowSessionCapability,
): TaskRuntimeDomainCompressedLiveShadowSessionCapabilityDescription | null {
  const state = states.get(capability);
  if (
    state === undefined
    || !("recipientKind" in state.description)
    || state.description.recipientKind !== "nautilo_task_runtime"
  ) return null;
  return Object.freeze({
    ...state.description,
    namespaceIds: Object.freeze([...state.description.namespaceIds]),
    grantDomainIds: Object.freeze([...state.description.grantDomainIds]),
    authorizationDigest: state.description.authorizationDigest.slice(),
  });
}

export async function withDomainCompressedLiveShadowSessionCapabilityEntries<
  Value,
>(
  capability: DomainCompressedLiveShadowSessionCapability,
  use: (
    entries:
      readonly DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry[],
  ) => Promise<Value> | Value,
): Promise<Value | null> {
  const state = states.get(capability);
  if (state === undefined) return null;
  const entries = copyEntries(state.entries);
  try {
    return await use(entries);
  } finally {
    destroyEntries(entries);
  }
}

export function destroyDomainCompressedLiveShadowSessionCapability(
  capability: DomainCompressedLiveShadowSessionCapability,
): void {
  const state = states.get(capability);
  if (state === undefined) return;
  states.delete(capability);
  state.description.authorizationDigest.fill(0);
  destroyEntries(state.entries);
}
