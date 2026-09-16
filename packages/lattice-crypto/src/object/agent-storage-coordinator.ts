import type { LatticeCrypto } from "../crypto/index.ts";
import {
  encodeObjectAccessManifestV3,
  verifyAgentObjectAccessManifestV3,
} from "../format/object-access-manifest-v3.ts";
import {
  encodeObjectAccessManifestV5,
  verifyObjectAccessManifestV5,
} from "../format/object-access-manifest-v5.ts";
import {
  encodeAgentRuntimeSignerPublicationV1,
  verifyHistoricalAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
} from "../agent-runtime/signer-publication-v1.ts";
import {
  authorizationRevision,
  agentId,
  agentRuntimeGeneration,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  assertAuthenticPreparedAgentObjectAccessManifestGenesisV3,
  type AgentObjectAccessGenesisAuthorityContextV3,
  assertAuthenticPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1,
  type DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
  type PreparedAgentObjectAccessManifestGenesisV3,
  type PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1,
} from "./agent-access-manifest.ts";
import {
  assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1,
  cloneDeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
  deviceWrappedAgentObjectAccessGenesisSetAuthorityContextsEqualV1,
  type DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
  type PreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1,
} from "./device-wrapped-agent-access-manifest-set-v1.ts";
import {
  authorizeObjectAccessWriteV2,
} from "./authorized-write.ts";
import {
  ObjectAccessPersistenceOutcomeUnknownV2,
  objectAccessStorageStateV2,
  type ObjectAccessStateCasStorageV2,
} from "./storage-coordinator.ts";
import type {
  AgentRuntimeRotationStateV2,
} from "../agent-runtime/runtime-rotation-v2.ts";

export interface AgentObjectAccessGenesisAuthorizationDecisionV3 {
  readonly context: AgentObjectAccessGenesisAuthorityContextV3;
  readonly grantAuthorized: boolean;
  readonly namespaceAuthorized: boolean;
  readonly domainAuthorized: boolean;
  readonly agentAuthorized: boolean;
  readonly hostAllowsOperation: boolean;
  readonly currentRuntime: AgentRuntimeRotationStateV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly currentManagerSigningPublicKey: Uint8Array;
}

export type ResolveCurrentAgentObjectAccessGenesisAuthorizationV3 = (
  context: AgentObjectAccessGenesisAuthorityContextV3,
) =>
  | AgentObjectAccessGenesisAuthorizationDecisionV3
  | null
  | Promise<AgentObjectAccessGenesisAuthorizationDecisionV3 | null>;

export interface DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorizationDecisionV1 {
  readonly context:
    DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1;
  readonly grantAuthorized: boolean;
  readonly namespaceAuthorized: boolean;
  readonly agentAuthorized: boolean;
  readonly hostAllowsOperation: boolean;
  readonly currentRuntime: AgentRuntimeRotationStateV2;
  readonly signerPublicKey: Uint8Array;
}

export type ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorizationV1 = (
  context: DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
) =>
  | DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorizationDecisionV1
  | null
  | Promise<
    DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorizationDecisionV1
      | null
  >;

export interface DeviceWrappedAgentObjectAccessGenesisSetAuthorizationDecisionV1 {
  readonly context:
    DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1;
  readonly grantAuthorized: boolean;
  readonly namespacesAuthorized: boolean;
  readonly agentAuthorized: boolean;
  readonly hostAllowsOperation: boolean;
  readonly currentRuntime: AgentRuntimeRotationStateV2;
  readonly signerPublicKey: Uint8Array;
}

export type ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorizationV1 = (
  context: DeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1,
) => DeviceWrappedAgentObjectAccessGenesisSetAuthorizationDecisionV1
  | null
  | Promise<
    DeviceWrappedAgentObjectAccessGenesisSetAuthorizationDecisionV1 | null
  >;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactFields(
  value: unknown,
  expected: readonly string[],
): boolean {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((field) => actual.includes(field));
}

function cloneContext(
  value: AgentObjectAccessGenesisAuthorityContextV3,
): AgentObjectAccessGenesisAuthorityContextV3 {
  return Object.freeze({
    ...value,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    envelope: Object.freeze({
      ...value.envelope,
      envelopeHash: copyOwnedBytesV2(value.envelope.envelopeHash),
    }),
    grantHash: copyOwnedBytesV2(value.grantHash),
    namespaceBindingHash:
      copyOwnedBytesV2(value.namespaceBindingHash),
  });
}

function contextsEqual(
  left: AgentObjectAccessGenesisAuthorityContextV3,
  right: AgentObjectAccessGenesisAuthorityContextV3,
): boolean {
  return left.purpose === right.purpose
    && left.objectId === right.objectId
    && bytesEqual(left.payloadHash, right.payloadHash)
    && left.envelope.objectId === right.envelope.objectId
    && left.envelope.namespaceId === right.envelope.namespaceId
    && left.envelope.keyClass === right.envelope.keyClass
    && left.envelope.keyGeneration === right.envelope.keyGeneration
    && left.envelope.bindingRevisionAtWrap
      === right.envelope.bindingRevisionAtWrap
    && bytesEqual(left.envelope.envelopeHash, right.envelope.envelopeHash)
    && left.grantId === right.grantId
    && bytesEqual(left.grantHash, right.grantHash)
    && left.grantUseStatus === right.grantUseStatus
    && left.namespaceId === right.namespaceId
    && left.namespaceAccessRevision === right.namespaceAccessRevision
    && bytesEqual(left.namespaceBindingHash, right.namespaceBindingHash)
    && left.domainId === right.domainId
    && left.domainEpoch === right.domainEpoch
    && left.agentAuthorizationRevision === right.agentAuthorizationRevision
    && left.agentId === right.agentId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.signerKeyId === right.signerKeyId;
}

function cloneDeviceWrappedContext(
  value: DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
): DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1 {
  return Object.freeze({
    ...value,
    payloadHash: copyOwnedBytesV2(value.payloadHash),
    envelope: Object.freeze({
      ...value.envelope,
      envelopeHash: copyOwnedBytesV2(value.envelope.envelopeHash),
    }),
    grantHash: copyOwnedBytesV2(value.grantHash),
    namespaceHeadDigest: copyOwnedBytesV2(value.namespaceHeadDigest),
    namespacePublicationDigest:
      copyOwnedBytesV2(value.namespacePublicationDigest),
    namespacePublicationSetDigest:
      copyOwnedBytesV2(value.namespacePublicationSetDigest),
    namespaceAudienceFingerprint:
      copyOwnedBytesV2(value.namespaceAudienceFingerprint),
  });
}

function deviceWrappedContextsEqual(
  left: DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
  right: DeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorityContextV1,
): boolean {
  return left.purpose === right.purpose
    && left.objectId === right.objectId
    && bytesEqual(left.payloadHash, right.payloadHash)
    && left.envelope.objectId === right.envelope.objectId
    && left.envelope.namespaceId === right.envelope.namespaceId
    && left.envelope.keyClass === right.envelope.keyClass
    && left.envelope.keyGeneration === right.envelope.keyGeneration
    && left.envelope.bindingRevisionAtWrap
      === right.envelope.bindingRevisionAtWrap
    && bytesEqual(left.envelope.envelopeHash, right.envelope.envelopeHash)
    && left.operationId === right.operationId
    && left.grantId === right.grantId
    && bytesEqual(left.grantHash, right.grantHash)
    && left.recipientKeyId === right.recipientKeyId
    && left.namespaceId === right.namespaceId
    && left.namespaceAccessRevision === right.namespaceAccessRevision
    && bytesEqual(left.namespaceHeadDigest, right.namespaceHeadDigest)
    && bytesEqual(
      left.namespacePublicationDigest,
      right.namespacePublicationDigest,
    )
    && bytesEqual(
      left.namespacePublicationSetDigest,
      right.namespacePublicationSetDigest,
    )
    && bytesEqual(
      left.namespaceAudienceFingerprint,
      right.namespaceAudienceFingerprint,
    )
    && left.agentAuthorizationRevision === right.agentAuthorizationRevision
    && left.agentId === right.agentId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.signerKeyId === right.signerKeyId;
}

function exactDecision(
  value: AgentObjectAccessGenesisAuthorizationDecisionV3,
): AgentObjectAccessGenesisAuthorizationDecisionV3 {
  if (!exactFields(value, [
    "context",
    "grantAuthorized",
    "namespaceAuthorized",
    "domainAuthorized",
    "agentAuthorized",
    "hostAllowsOperation",
    "currentRuntime",
    "signerPublication",
    "currentManagerSigningPublicKey",
  ])) {
    throw new TypeError(
      "Agent object access genesis authorization decision has an invalid field set",
    );
  }
  if (
    !exactFields(value.currentRuntime, [
      "agentId",
      "authorizationRevision",
      "runtimeGeneration",
    ])
    || !(value.currentManagerSigningPublicKey instanceof Uint8Array)
    || value.currentManagerSigningPublicKey.length
      !== V2_LIMITS.signingPublicKeyBytes
  ) {
    throw new TypeError(
      "Agent object access genesis authorization decision is invalid",
    );
  }
  return value;
}

export async function persistPreparedAgentObjectAccessManifestGenesisV3(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage: ObjectAccessStateCasStorageV2;
    readonly prepared: PreparedAgentObjectAccessManifestGenesisV3;
    readonly resolveCurrentAuthorization:
      ResolveCurrentAgentObjectAccessGenesisAuthorizationV3;
  }>,
): Promise<"applied" | "duplicate" | "stale"> {
  assertAuthenticPreparedAgentObjectAccessManifestGenesisV3(
    input.prepared,
  );
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current Agent object access genesis authorization resolver is required",
    );
  }
  const intended = objectAccessStorageStateV2(
    input.crypto,
    input.prepared.manifestBytes,
    input.prepared.envelopeBytes,
  );
  if (
    !bytesEqual(
      encodeObjectAccessManifestV3(input.prepared.manifest),
      input.prepared.manifestBytes,
    )
    || !bytesEqual(
      input.prepared.manifestHash,
      intended.head.manifestHash,
    )
  ) {
    throw new Error(
      "prepared Agent object access genesis does not match its canonical manifest",
    );
  }
  const context = cloneContext(input.prepared.authority);
  const persistedObject = await input.storage.getObject(context.objectId);
  if (persistedObject === null) return "stale";
  const persistedPayloadHash = input.crypto.hash(persistedObject.payloadBytes);
  const persistedPayloadMatches = bytesEqual(
    persistedPayloadHash,
    context.payloadHash,
  );
  persistedPayloadHash.fill(0);
  if (!persistedPayloadMatches) return "stale";

  const rawDecision = await input.resolveCurrentAuthorization(
    cloneContext(context),
  );
  if (rawDecision === null) return "stale";
  const decision = exactDecision(rawDecision);
  if (
    !contextsEqual(context, decision.context)
    || decision.grantAuthorized !== true
    || decision.namespaceAuthorized !== true
    || decision.domainAuthorized !== true
    || decision.agentAuthorized !== true
    || decision.hostAllowsOperation !== true
    || agentId(decision.currentRuntime.agentId) !== context.agentId
    || authorizationRevision(
      decision.currentRuntime.authorizationRevision,
    ) !== context.agentAuthorizationRevision
    || agentRuntimeGeneration(
      decision.currentRuntime.runtimeGeneration,
    ) !== context.runtimeGeneration
    || decision.signerPublication.agentId !== context.agentId
    || decision.signerPublication.authorizationRevision
      !== context.agentAuthorizationRevision
    || decision.signerPublication.runtimeGeneration
      !== context.runtimeGeneration
    || decision.signerPublication.signerKeyId !== context.signerKeyId
    || !verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: input.crypto,
      publication: decision.signerPublication,
      resolveHistoricalManagerAuthority: (publicationContext) =>
        publicationContext.managerHumanId
            === decision.signerPublication.managerHumanId
          && publicationContext.managerAuthorizationRevision
            === decision.signerPublication.managerAuthorizationRevision
          && publicationContext.managerDeviceId
            === decision.signerPublication.managerDeviceId
          ? decision.currentManagerSigningPublicKey
          : null,
    })
  ) return "stale";
  try {
    verifyAgentObjectAccessManifestV3(input.crypto, {
      manifestBytes: input.prepared.manifestBytes,
      resolveSignerPublicKey: (principal) =>
        principal.agentId === context.agentId
            && principal.runtimeGeneration === context.runtimeGeneration
            && principal.signerKeyId === context.signerKeyId
          ? decision.signerPublication.signerPublicKey
          : null,
    });
  } catch {
    return "stale";
  }

  let status: "applied" | "duplicate" | "stale";
  let publicationBytes: Uint8Array | null = null;
  try {
    publicationBytes = encodeAgentRuntimeSignerPublicationV1(
      decision.signerPublication,
    );
    status = await input.storage.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: null,
        intended,
        authorization: {
          kind: "agent-genesis",
          context,
          signerPublication: decision.signerPublication,
          signerPublicationHash: input.crypto.hash(publicationBytes),
          signerPublicKeyHash: input.crypto.hash(
            decision.signerPublication.signerPublicKey,
          ),
          managerSigningPublicKeyHash: input.crypto.hash(
            decision.currentManagerSigningPublicKey,
          ),
        },
      }),
    );
  } catch (cause) {
    throw new ObjectAccessPersistenceOutcomeUnknownV2(cause);
  } finally {
    publicationBytes?.fill(0);
  }
  if (
    status !== "applied"
    && status !== "duplicate"
    && status !== "stale"
  ) {
    throw new TypeError(
      "object access storage returned an invalid status",
    );
  }
  return status;
}

/** Persist current Agent output from native V2 Domain/Namespace authority. */
export async function persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage: ObjectAccessStateCasStorageV2;
    readonly prepared:
      PreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1;
    readonly resolveCurrentAuthorization:
      ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorizationV1;
  }>,
): Promise<"applied" | "duplicate" | "stale"> {
  assertAuthenticPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(
    input.prepared,
  );
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current device-wrapped live Shadow Agent authorization resolver is required",
    );
  }
  const intended = objectAccessStorageStateV2(
    input.crypto,
    input.prepared.manifestBytes,
    input.prepared.envelopeBytes,
  );
  if (
    !bytesEqual(
      encodeObjectAccessManifestV3(input.prepared.manifest),
      input.prepared.manifestBytes,
    )
    || !bytesEqual(input.prepared.manifestHash, intended.head.manifestHash)
  ) {
    throw new Error(
      "prepared device-wrapped Agent access does not match its canonical manifest",
    );
  }
  const context = cloneDeviceWrappedContext(input.prepared.authority);
  const persistedObject = await input.storage.getObject(context.objectId);
  if (persistedObject === null) return "stale";
  const persistedPayloadHash = input.crypto.hash(persistedObject.payloadBytes);
  const persistedPayloadMatches = bytesEqual(
    persistedPayloadHash,
    context.payloadHash,
  );
  persistedPayloadHash.fill(0);
  if (!persistedPayloadMatches) return "stale";
  const decision = await input.resolveCurrentAuthorization(
    cloneDeviceWrappedContext(context),
  );
  if (
    decision === null
    || !exactFields(decision, [
      "context",
      "grantAuthorized",
      "namespaceAuthorized",
      "agentAuthorized",
      "hostAllowsOperation",
      "currentRuntime",
      "signerPublicKey",
    ])
    || !deviceWrappedContextsEqual(context, decision.context)
    || decision.grantAuthorized !== true
    || decision.namespaceAuthorized !== true
    || decision.agentAuthorized !== true
    || decision.hostAllowsOperation !== true
    || agentId(decision.currentRuntime.agentId) !== context.agentId
    || authorizationRevision(
      decision.currentRuntime.authorizationRevision,
    ) !== context.agentAuthorizationRevision
    || agentRuntimeGeneration(
      decision.currentRuntime.runtimeGeneration,
    ) !== context.runtimeGeneration
    || !(decision.signerPublicKey instanceof Uint8Array)
    || decision.signerPublicKey.length !== V2_LIMITS.signingPublicKeyBytes
  ) return "stale";
  try {
    verifyAgentObjectAccessManifestV3(input.crypto, {
      manifestBytes: input.prepared.manifestBytes,
      resolveSignerPublicKey: (principal) =>
        principal.agentId === context.agentId
          && principal.runtimeGeneration === context.runtimeGeneration
          && principal.signerKeyId === context.signerKeyId
          ? decision.signerPublicKey
          : null,
    });
  } catch {
    return "stale";
  }
  try {
    const status = await input.storage.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: null,
        intended,
        authorization: {
          kind: "device-wrapped-live-shadow-agent-genesis",
          context,
          signerPublicKey: decision.signerPublicKey,
          signerPublicKeyHash: input.crypto.hash(decision.signerPublicKey),
        },
      }),
    );
    if (
      status !== "applied"
      && status !== "duplicate"
      && status !== "stale"
    ) {
      throw new TypeError("object access storage returned an invalid status");
    }
    return status;
  } catch (cause) {
    throw new ObjectAccessPersistenceOutcomeUnknownV2(cause);
  }
}

/** Persist one current device-approved Runtime object for an exact Namespace set. */
export async function persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage: ObjectAccessStateCasStorageV2;
    readonly prepared:
      PreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1;
    readonly resolveCurrentAuthorization:
      ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorizationV1;
  }>,
): Promise<"applied" | "duplicate" | "stale"> {
  assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1(
    input.prepared,
  );
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current device-wrapped Agent set authorization resolver is required",
    );
  }
  const intended = objectAccessStorageStateV2(
    input.crypto,
    input.prepared.manifestBytes,
    input.prepared.envelopeBytes,
  );
  if (
    !bytesEqual(
      encodeObjectAccessManifestV5(input.prepared.manifest),
      input.prepared.manifestBytes,
    )
    || !bytesEqual(input.prepared.manifestHash, intended.head.manifestHash)
  ) {
    throw new Error(
      "prepared device-wrapped Agent set does not match its canonical manifest",
    );
  }
  const context =
    cloneDeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1(
      input.prepared.authority,
    );
  const persistedObject = await input.storage.getObject(context.objectId);
  if (persistedObject === null) return "stale";
  const payloadHash = input.crypto.hash(persistedObject.payloadBytes);
  const payloadMatches = bytesEqual(payloadHash, context.payloadHash);
  payloadHash.fill(0);
  if (!payloadMatches) return "stale";
  const decision = await input.resolveCurrentAuthorization(
    cloneDeviceWrappedAgentObjectAccessGenesisSetAuthorityContextV1(context),
  );
  if (
    decision === null
    || !exactFields(decision, [
      "context",
      "grantAuthorized",
      "namespacesAuthorized",
      "agentAuthorized",
      "hostAllowsOperation",
      "currentRuntime",
      "signerPublicKey",
    ])
    || !deviceWrappedAgentObjectAccessGenesisSetAuthorityContextsEqualV1(
      context,
      decision.context,
    )
    || decision.grantAuthorized !== true
    || decision.namespacesAuthorized !== true
    || decision.agentAuthorized !== true
    || decision.hostAllowsOperation !== true
    || agentId(decision.currentRuntime.agentId) !== context.agentId
    || authorizationRevision(decision.currentRuntime.authorizationRevision)
      !== context.agentAuthorizationRevision
    || agentRuntimeGeneration(decision.currentRuntime.runtimeGeneration)
      !== context.runtimeGeneration
    || !(decision.signerPublicKey instanceof Uint8Array)
    || decision.signerPublicKey.length !== V2_LIMITS.signingPublicKeyBytes
  ) return "stale";
  try {
    verifyObjectAccessManifestV5(input.crypto, {
      manifestBytes: input.prepared.manifestBytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: (principal) =>
        principal.agentId === context.agentId
          && principal.runtimeGeneration === context.runtimeGeneration
          && principal.signerKeyId === context.signerKeyId
          ? decision.signerPublicKey
          : null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    });
  } catch {
    return "stale";
  }
  try {
    const status = await input.storage.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: null,
        intended,
        authorization: {
          kind: "device-wrapped-live-shadow-agent-genesis-set",
          context,
          signerPublicKey: decision.signerPublicKey,
          signerPublicKeyHash: input.crypto.hash(decision.signerPublicKey),
        },
      }),
    );
    if (
      status !== "applied"
      && status !== "duplicate"
      && status !== "stale"
    ) throw new TypeError("object access storage returned an invalid status");
    return status;
  } catch (cause) {
    throw new ObjectAccessPersistenceOutcomeUnknownV2(cause);
  }
}
