import type { LatticeCrypto } from "../crypto/index.ts";
import {
  parseGrantV2,
  serializeGrantV2,
  type GrantOperationV2,
  type GrantV2,
} from "../format/grant-v2.ts";
import type {
  GrantWireRecordV2,
} from "../storage/v2-records.ts";
import type { V2Storage } from "../storage/v2-storage-contract.ts";
import {
  accessRevision,
  agentId,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
  type GrantId,
} from "../v2-types/ids.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  openGrantV2ForOperation,
  type GrantOperationAuthorizationV2,
  type OpenedGrantDomainV2,
} from "./authorization.ts";

declare const grantUsePreflightBrand: unique symbol;

export type GrantUseSingleUseStatusV2 =
  | "available"
  | "claimed-by-preflight"
  | "reusable";

export interface GrantUseAuthorizationContextV2 {
  readonly purpose: "authorize-grant-use";
  readonly preflightId: string;
  readonly phase: "before-claim" | "before-execute";
  readonly grantId: GrantId;
  readonly grantHash: Uint8Array;
  readonly grantBytes: Uint8Array;
  readonly issuingDeviceId: string;
  readonly issuingDeviceHumanId: string;
  readonly issuingDeviceSigningPublicKeyHash: Uint8Array;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly operation: GrantOperationV2;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly preflightTime: number;
  readonly requestedNamespaceHeads: readonly Readonly<{
    readonly namespaceId: string;
    readonly accessRevision: number;
    readonly participants: readonly string[];
  }>[];
  readonly requestedDomains: readonly Readonly<{
    readonly domainId: string;
    readonly domainEpoch: number;
    readonly agentAuthorizationRevision: number;
  }>[];
  readonly coveredDomains: readonly Readonly<{
    readonly domainId: string;
    readonly domainEpoch: number;
    readonly agentAuthorizationRevision: number;
  }>[];
  readonly singleUseStatus: GrantUseSingleUseStatusV2;
}

export interface GrantUseAuthorizationDecisionV2 {
  readonly context: GrantUseAuthorizationContextV2;
  readonly currentTime: number;
  readonly issuingDeviceActive: boolean;
  readonly recipientAgentAuthorized: boolean;
  readonly requestedNamespacesAuthorized: boolean;
  readonly requestedDomainsAuthorized: boolean;
  readonly hostAllowsOperation: boolean;
  readonly currentSingleUseStatus: GrantUseSingleUseStatusV2;
}

export type ResolveCurrentGrantUseAuthorizationV2 = (
  context: GrantUseAuthorizationContextV2,
) =>
  | GrantUseAuthorizationDecisionV2
  | null
  | Promise<GrantUseAuthorizationDecisionV2 | null>;

/**
 * One-shot, process-local evidence that a Grant passed possession preflight.
 * The root remains private in the WeakMap and is never lent without a fresh
 * exact authorization decision at the execution boundary.
 */
export type GrantUsePreflightV2 = Readonly<{
  readonly grantId: GrantId;
  readonly preflightId: string;
  readonly singleUse: boolean;
  readonly [grantUsePreflightBrand]: true;
}>;

export type GrantUseExecutionResultV2<Value> =
  | Readonly<{
    readonly status: "executed";
    readonly value: Value;
  }>
  | Readonly<{
    readonly status: "unavailable";
  }>;

interface GrantUseSecretState {
  used: boolean;
  readonly opened: OpenedGrantDomainV2;
  readonly grantWireBytes: Uint8Array;
  readonly baseContext: Omit<
    GrantUseAuthorizationContextV2,
    "phase" | "singleUseStatus"
  >;
  readonly singleUse: boolean;
}

const grantUseSecrets = new WeakMap<object, GrantUseSecretState>();

export class GrantClaimOutcomeUnknownV2 extends Error {
  override readonly name = "GrantClaimOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Single-use Grant claim outcome is ambiguous; retry is forbidden",
      { cause },
    );
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

function assertExactFields(
  label: string,
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }
  const fields = Object.keys(value);
  if (
    expected.some((field) => !Object.hasOwn(value, field))
    || fields.some((field) => !expected.includes(field))
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function wipeGrantUseState(state: GrantUseSecretState): void {
  state.opened.aiRoot.fill(0);
  state.grantWireBytes.fill(0);
}

function exactClaimMatches(
  expected: GrantUseSecretState,
  claimed: GrantWireRecordV2,
): boolean {
  if (
    typeof claimed !== "object"
    || Object.keys(claimed).some((field) =>
      !["grantId", "grantBytes", "consumed"].includes(field)
    )
  ) {
    throw new TypeError("Claimed Grant wire record is malformed");
  }
  if (
    typeof claimed.grantId !== "string"
    || !(claimed.grantBytes instanceof Uint8Array)
    || typeof claimed.consumed !== "boolean"
  ) {
    throw new TypeError("Claimed Grant wire record is malformed");
  }
  const parsed = parseGrantV2(claimed.grantBytes);
  if (
    parsed === null
    || parsed.id !== claimed.grantId
  ) {
    throw new Error("Claimed Grant wire record is noncanonical");
  }
  return (
    claimed.consumed === true
    && equalBytes(
      claimed.grantBytes,
      expected.grantWireBytes,
    )
  );
}

function cloneNamespaceHeads(
  values: GrantUseAuthorizationContextV2["requestedNamespaceHeads"],
): GrantUseAuthorizationContextV2["requestedNamespaceHeads"] {
  if (!Array.isArray(values as unknown)) {
    throw new TypeError("Requested Grant Namespace heads must be an array");
  }
  return Object.freeze(values.map((value) => {
    assertExactFields("Requested Grant Namespace head", value, [
      "namespaceId",
      "accessRevision",
      "participants",
    ]);
    if (!Array.isArray(value.participants as unknown)) {
      throw new TypeError(
        "Requested Grant Namespace participants must be an array",
      );
    }
    return Object.freeze({
      namespaceId: namespaceId(value.namespaceId),
      accessRevision: accessRevision(value.accessRevision),
      participants: Object.freeze(value.participants.map(humanId)),
    });
  }));
}

function cloneDomains(
  label: string,
  values:
    | GrantUseAuthorizationContextV2["requestedDomains"]
    | GrantUseAuthorizationContextV2["coveredDomains"],
): GrantUseAuthorizationContextV2["requestedDomains"] {
  if (!Array.isArray(values as unknown)) {
    throw new TypeError(`${label} must be an array`);
  }
  return Object.freeze(values.map((value) => {
    assertExactFields(label.slice(0, -1), value, [
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
    ]);
    return Object.freeze({
      domainId: cryptoDomainId(value.domainId),
      domainEpoch: domainEpoch(value.domainEpoch),
      agentAuthorizationRevision:
        authorizationRevision(value.agentAuthorizationRevision),
    });
  }));
}

function cloneContext(
  context: GrantUseAuthorizationContextV2,
): GrantUseAuthorizationContextV2 {
  assertExactFields("Grant use authorization context", context, [
    "purpose",
    "preflightId",
    "phase",
    "grantId",
    "grantHash",
    "grantBytes",
    "issuingDeviceId",
    "issuingDeviceHumanId",
    "issuingDeviceSigningPublicKeyHash",
    "recipientAgentId",
    "recipientKeyId",
    "operation",
    "issuedAt",
    "expiresAt",
    "preflightTime",
    "requestedNamespaceHeads",
    "requestedDomains",
    "coveredDomains",
    "singleUseStatus",
  ]);
  if (
    context.purpose !== "authorize-grant-use"
    || (
      context.phase !== "before-claim"
      && context.phase !== "before-execute"
    )
    || (
      context.singleUseStatus !== "available"
      && context.singleUseStatus !== "claimed-by-preflight"
      && context.singleUseStatus !== "reusable"
    )
    || !(context.grantHash instanceof Uint8Array)
    || context.grantHash.length !== 32
    || !(context.grantBytes instanceof Uint8Array)
    || !(context.issuingDeviceSigningPublicKeyHash instanceof Uint8Array)
    || context.issuingDeviceSigningPublicKeyHash.length !== 32
    || !Number.isSafeInteger(context.issuedAt)
    || !Number.isSafeInteger(context.expiresAt)
    || !Number.isSafeInteger(context.preflightTime)
  ) {
    throw new TypeError("Grant use authorization context is invalid");
  }
  assertPortableId("Grant preflight id", context.preflightId);
  return Object.freeze({
    purpose: "authorize-grant-use",
    preflightId: context.preflightId,
    phase: context.phase,
    grantId: grantId(context.grantId),
    grantHash: copyOwnedBytesV2(context.grantHash),
    grantBytes: copyOwnedBytesV2(context.grantBytes),
    issuingDeviceId: cryptoDeviceId(context.issuingDeviceId),
    issuingDeviceHumanId: humanId(context.issuingDeviceHumanId),
    issuingDeviceSigningPublicKeyHash:
      copyOwnedBytesV2(
        context.issuingDeviceSigningPublicKeyHash,
      ),
    recipientAgentId: agentId(context.recipientAgentId),
    recipientKeyId: context.recipientKeyId,
    operation: context.operation,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    preflightTime: context.preflightTime,
    requestedNamespaceHeads:
      cloneNamespaceHeads(context.requestedNamespaceHeads),
    requestedDomains:
      cloneDomains("Requested Grant Domains", context.requestedDomains),
    coveredDomains:
      cloneDomains("Covered Grant Domains", context.coveredDomains),
    singleUseStatus: context.singleUseStatus,
  });
}

function contextFingerprint(
  context: GrantUseAuthorizationContextV2,
): string {
  return JSON.stringify([
    context.purpose,
    context.preflightId,
    context.phase,
    context.grantId,
    bytesToHex(context.grantHash),
    bytesToHex(context.grantBytes),
    context.issuingDeviceId,
    context.issuingDeviceHumanId,
    bytesToHex(context.issuingDeviceSigningPublicKeyHash),
    context.recipientAgentId,
    context.recipientKeyId,
    context.operation,
    context.issuedAt,
    context.expiresAt,
    context.preflightTime,
    context.requestedNamespaceHeads,
    context.requestedDomains,
    context.coveredDomains,
    context.singleUseStatus,
  ]);
}

function exactDecision(
  value: GrantUseAuthorizationDecisionV2,
): GrantUseAuthorizationDecisionV2 {
  assertExactFields("Grant use authorization decision", value, [
    "context",
    "currentTime",
    "issuingDeviceActive",
    "recipientAgentAuthorized",
    "requestedNamespacesAuthorized",
    "requestedDomainsAuthorized",
    "hostAllowsOperation",
    "currentSingleUseStatus",
  ]);
  if (
    !Number.isSafeInteger(value.currentTime)
    || typeof value.issuingDeviceActive !== "boolean"
    || typeof value.recipientAgentAuthorized !== "boolean"
    || typeof value.requestedNamespacesAuthorized !== "boolean"
    || typeof value.requestedDomainsAuthorized !== "boolean"
    || typeof value.hostAllowsOperation !== "boolean"
    || (
      value.currentSingleUseStatus !== "available"
      && value.currentSingleUseStatus !== "claimed-by-preflight"
      && value.currentSingleUseStatus !== "reusable"
    )
  ) {
    throw new TypeError("Grant use authorization decision is invalid");
  }
  return Object.freeze({
    context: cloneContext(value.context),
    currentTime: value.currentTime,
    issuingDeviceActive: value.issuingDeviceActive,
    recipientAgentAuthorized: value.recipientAgentAuthorized,
    requestedNamespacesAuthorized: value.requestedNamespacesAuthorized,
    requestedDomainsAuthorized: value.requestedDomainsAuthorized,
    hostAllowsOperation: value.hostAllowsOperation,
    currentSingleUseStatus: value.currentSingleUseStatus,
  });
}

async function hasFreshAuthorization(
  state: GrantUseSecretState,
  resolve: ResolveCurrentGrantUseAuthorizationV2,
  phase: GrantUseAuthorizationContextV2["phase"],
  singleUseStatus: GrantUseSingleUseStatusV2,
): Promise<boolean> {
  const pristine = cloneContext(Object.freeze({
    ...state.baseContext,
    phase,
    singleUseStatus,
  }));
  const raw = await resolve(cloneContext(pristine));
  if (raw === null) return false;
  const decision = exactDecision(raw);
  return (
    contextFingerprint(decision.context) === contextFingerprint(pristine)
    && decision.currentTime >= pristine.preflightTime
    && decision.currentTime < pristine.expiresAt
    && decision.issuingDeviceActive
    && decision.recipientAgentAuthorized
    && decision.requestedNamespacesAuthorized
    && decision.requestedDomainsAuthorized
    && decision.hostAllowsOperation
    && decision.currentSingleUseStatus === pristine.singleUseStatus
  );
}

function baseContext(
  crypto: LatticeCrypto,
  grant: GrantV2,
  grantWireBytes: Uint8Array,
  authorization: GrantOperationAuthorizationV2,
  preflightId: string,
): GrantUseSecretState["baseContext"] {
  const namespaceParticipants = authorization.namespaceParticipants.map(
    humanId,
  );
  return Object.freeze({
    purpose: "authorize-grant-use" as const,
    preflightId,
    grantId: grantId(grant.id),
    grantHash: copyOwnedBytesV2(crypto.hash(grantWireBytes)),
    grantBytes: grantWireBytes,
    issuingDeviceId: cryptoDeviceId(grant.issuingDeviceId),
    issuingDeviceHumanId: humanId(authorization.issuingDeviceHumanId),
    issuingDeviceSigningPublicKeyHash:
      copyOwnedBytesV2(
        crypto.hash(authorization.issuingDeviceSigningPublicKey),
      ),
    recipientAgentId: agentId(grant.recipientAgentId),
    recipientKeyId: grant.recipientKeyId,
    operation: authorization.operation,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    preflightTime: authorization.now,
    requestedNamespaceHeads: Object.freeze([Object.freeze({
      namespaceId: namespaceId(authorization.namespaceId),
      accessRevision:
        accessRevision(authorization.namespaceAccessRevision),
      participants: Object.freeze(namespaceParticipants),
    })]),
    requestedDomains: Object.freeze([Object.freeze({
      domainId: cryptoDomainId(authorization.domainId),
      domainEpoch: domainEpoch(authorization.domainEpoch),
      agentAuthorizationRevision:
        authorizationRevision(authorization.agentAuthorizationRevision),
    })]),
    coveredDomains: Object.freeze(grant.coveredDomains.map((domain) =>
      Object.freeze({
        domainId: cryptoDomainId(domain.domainId),
        domainEpoch: domainEpoch(domain.domainEpoch),
        agentAuthorizationRevision:
          authorizationRevision(domain.agentAuthorizationRevision),
      })
    )),
  });
}

/**
 * Verify possession and snapshot every operation coordinate. The resulting
 * capability remains one-shot, but the cached root is not authorization:
 * execution must obtain a fresh exact host decision.
 */
export async function preflightGrantUseV2(
  crypto: LatticeCrypto,
  grant: GrantV2,
  authorization: GrantOperationAuthorizationV2,
): Promise<GrantUsePreflightV2 | null> {
  let grantWireBytes: Uint8Array | null = null;
  let opened: OpenedGrantDomainV2 | null = null;
  try {
    grantWireBytes = serializeGrantV2(grant);
    const grantSnapshot = parseGrantV2(grantWireBytes)!;
    const randomId = crypto.randomBytes(16);
    const preflightId = `grant-use-${bytesToHex(randomId)}`;
    let context: GrantUseSecretState["baseContext"];
    try {
      context = baseContext(
        crypto,
        grantSnapshot,
        grantWireBytes,
        authorization,
        preflightId,
      );
    } catch {
      return null;
    }
    opened = await openGrantV2ForOperation(
      crypto,
      grantSnapshot,
      authorization,
    );
    if (opened === null) return null;

    const capability = Object.freeze({
      grantId: opened.grantId,
      preflightId,
      singleUse: grantSnapshot.singleUse,
    }) as GrantUsePreflightV2;
    grantUseSecrets.set(capability, {
      used: false,
      opened,
      grantWireBytes,
      baseContext: context,
      singleUse: grantSnapshot.singleUse,
    });
    opened = null;
    grantWireBytes = null;
    return capability;
  } finally {
    opened?.aiRoot.fill(0);
    grantWireBytes?.fill(0);
  }
}

/**
 * Consume and wipe a preflight that the caller will not execute.
 *
 * Preflight opens the Domain root before any storage claim. Callers therefore
 * must explicitly abort abandoned work instead of leaving that root retained
 * in the process-local capability state.
 */
export function abortGrantUseV2(preflight: GrantUsePreflightV2): void {
  const state = grantUseSecrets.get(preflight);
  if (state === undefined) {
    throw new Error("Grant use preflight is untrusted");
  }
  if (state.used) {
    throw new Error("Grant use preflight was already used");
  }
  state.used = true;
  wipeGrantUseState(state);
}

/**
 * Claim and execute one Grant use with fresh authorization on both sides of
 * the single-use storage await. Reusable Grants resolve once immediately
 * before execute. Every result consumes the preflight and wipes its root.
 */
export async function coordinateGrantUseV2<Value>(input: {
  readonly preflight: GrantUsePreflightV2;
  readonly storage: Pick<V2Storage, "consumeGrant">;
  readonly resolveCurrentAuthorization:
    ResolveCurrentGrantUseAuthorizationV2;
  readonly execute: (
    opened: OpenedGrantDomainV2,
  ) => Value | PromiseLike<Value>;
}): Promise<GrantUseExecutionResultV2<Value>> {
  const state = grantUseSecrets.get(input.preflight);
  if (state === undefined) {
    throw new Error("Grant use preflight is untrusted");
  }
  if (state.used) {
    throw new Error("Grant use preflight was already used");
  }
  state.used = true;

  try {
    if (typeof input.resolveCurrentAuthorization !== "function") {
      throw new TypeError(
        "Current Grant use authorization resolver is required",
      );
    }
    if (state.singleUse) {
      if (!await hasFreshAuthorization(
        state,
        input.resolveCurrentAuthorization,
        "before-claim",
        "available",
      )) {
        return Object.freeze({ status: "unavailable" as const });
      }
      let claimed: GrantWireRecordV2 | null;
      try {
        claimed = await input.storage.consumeGrant(state.opened.grantId);
      } catch (cause) {
        throw new GrantClaimOutcomeUnknownV2(cause);
      }
      if (claimed === null) {
        return Object.freeze({ status: "unavailable" as const });
      }
      if (!exactClaimMatches(state, claimed)) {
        throw new Error(
          "Claimed Grant record does not match preflight",
        );
      }
      if (!await hasFreshAuthorization(
        state,
        input.resolveCurrentAuthorization,
        "before-execute",
        "claimed-by-preflight",
      )) {
        return Object.freeze({ status: "unavailable" as const });
      }
    } else if (!await hasFreshAuthorization(
      state,
      input.resolveCurrentAuthorization,
      "before-execute",
      "reusable",
    )) {
      return Object.freeze({ status: "unavailable" as const });
    }

    const value = await input.execute(state.opened);
    return Object.freeze({
      status: "executed" as const,
      value,
    });
  } finally {
    wipeGrantUseState(state);
  }
}
