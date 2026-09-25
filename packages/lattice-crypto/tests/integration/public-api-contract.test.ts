import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as packageRoot from "@nautilo/lattice-crypto";
import * as packageWire from "@nautilo/lattice-crypto/wire";
import * as wireLimits from "@nautilo/lattice-crypto/wire-limits";
import type {
  GroupKeyProvider as PackageGroupKeyProvider,
  LatticeStorage as PackageLatticeStorage,
} from "@nautilo/lattice-crypto";
import type {
  AgentRuntimeObjectSignerPrincipalV1 as PackageAgentRuntimeObjectSignerPrincipalV1,
  GrantV2 as PackageGrantV2,
  NamespaceBindingV2 as PackageNamespaceBindingV2,
} from "@nautilo/lattice-crypto/wire";
import * as clean from "../../src/index.ts";
import * as wire from "../../src/wire.ts";
import {
  coordinateGrantUseV2,
} from "../../src/grant/storage-coordinator.ts";
import {
  NAMESPACE_BINDING_DOMAIN,
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  createObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  OpenMlsV2GroupProvider,
} from "../../src/group/v2-openmls.ts";
import type {
  V2GroupKeyProvider,
} from "../../src/group/v2-provider.ts";
import {
  LATTICE_LIMITS as canonicalLatticeLimits,
} from "../../src/limits.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import {
  prepareHumanNamespaceRebindV2,
} from "../../src/transition/namespace-rebind.ts";
import type {
  V2Storage,
} from "../../src/storage/v2-storage-contract.ts";

import type {
  GroupKeyProvider,
} from "../../src/index.ts";
import type {
  LatticeStorage,
} from "../../src/index.ts";
import {
  CLEAN_RUNTIME_EXPORTS,
  CLEAN_TYPE_EXPORTS,
  WIRE_RUNTIME_EXPORTS,
  WIRE_TYPE_EXPORTS,
} from "../fixtures/public-api-allowlists.ts";
import {
  fixtureV2Codecs,
} from "../helpers/v2-codec-fixtures.ts";

// @ts-expect-error implementation chronology is not a supported root name
import type { V2GroupKeyProvider as LeakedV2Provider } from "../../src/index.ts";
// @ts-expect-error version-bearing wire records live on the wire subpath
import type { GrantV2 as LeakedGrantWireRecord } from "../../src/index.ts";
// @ts-expect-error imported v1 characterization remains testing-only
import type { Grant as LeakedLegacyGrant } from "../../src/index.ts";

type CleanTypeAliases = [
  GroupKeyProvider extends V2GroupKeyProvider ? true : false,
  V2GroupKeyProvider extends GroupKeyProvider ? true : false,
  LatticeStorage extends V2Storage ? true : false,
  V2Storage extends LatticeStorage ? true : false,
  PackageGroupKeyProvider extends GroupKeyProvider ? true : false,
  PackageLatticeStorage extends LatticeStorage ? true : false,
  PackageGrantV2 extends import("../../src/format/grant-v2.ts").GrantV2
    ? true
    : false,
  PackageNamespaceBindingV2 extends
    import("../../src/namespace/types.ts").NamespaceBindingV2
    ? true
    : false,
  PackageAgentRuntimeObjectSignerPrincipalV1 extends
    import("../../src/agent-runtime/object-signer-v1.ts")
      .AgentRuntimeObjectSignerPrincipalV1
    ? true
    : false,
];

const cleanTypeAliases: CleanTypeAliases = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
const typeOnlyLeaks: [
  LeakedV2Provider,
  LeakedGrantWireRecord,
  LeakedLegacyGrant,
] | null = null;
const cleanRuntime: Readonly<Record<string, unknown>> = clean;

type ExportIdentity = Readonly<{
  imported: string;
  source: string;
}>;

type ExportDisposition = ExportIdentity & Readonly<{
  exported: string;
  typeOnly: boolean;
}>;

const ROOT_TYPE_CLOSURE_ADDITIONS: readonly ExportDisposition[] = [
  {
    source: "./background/task-runtime-recipient-registry-v1.ts",
    imported: "TaskRuntimeRecipientRegistryV1",
    exported: "TaskRuntimeRecipientRegistry",
    typeOnly: false,
  },
  ...([
    "TaskRuntimeRecipientAttempt",
    "TaskRuntimeRecipientCreationResult",
    "TaskRuntimeRecipientDeadlineHandle",
    "TaskRuntimeRecipientDeadlineScheduler",
    "TaskRuntimeRecipientOpenResult",
  ] as const).map((name) => ({
    source: "./background/task-runtime-recipient-registry-v1.ts",
    imported: `${name}V1`,
    exported: name,
    typeOnly: true,
  })),
  {
    source: "./format/domain-foreground-authorization-v2.ts",
    imported: "verifyDomainForegroundAuthorizationV2",
    exported: "verifyDomainForegroundAuthorizationV2",
    typeOnly: false,
  },
  ...([
    "DomainForegroundAuthorizationPublicCurrentAuthorityV2",
    "VerifyDomainForegroundAuthorizationResultV2",
  ] as const).map((name) => ({
    source: "./format/domain-foreground-authorization-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  // M327's clean reflection-authority workflow closes the registry method's
  // public input and port types. Its descriptor records remain versioned wire.
  ...([
    "ReflectionAuthorityObjectPortV2",
    "ReflectionAuthorityReconciliationBindingV2",
    "ReflectionAuthorityRunInputV2",
    "ReflectionPublicationReconciliationBindingV2",
    "ReflectionSemanticInputV2",
    "ReflectionSemanticObjectPortV2",
    "ReflectionSemanticOutputV2",
    "ReflectionSemanticReconciliationBindingV2",
    "ReflectionSemanticRunInputV2",
  ] as const).map((name) => ({
    source: "./background/reflection-authority-reprojection-v2.ts",
    imported: name,
    exported: name.replace(/V2$/u, ""),
    typeOnly: true,
  })),
  ...([
    "AnyBackgroundProcessorWorkDescriptorV2",
    "BackgroundReflectionWorkDescriptorV2",
    "BackgroundReflectionMaintenanceWorkDescriptorV2",
    "BackgroundReflectionSemanticWorkDescriptorV2",
    "BackgroundReflectionSemanticInputBindingV2",
    "BackgroundReflectionNamespaceRequirementV2",
    "BackgroundProcessorDomainRequirementV2",
  ] as const).map((name) => ({
    source: "./background/work-descriptor-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  // M313 exposes the exact existing-message request TTL and exact V2 object
  // wire maxima on the versioned wire surface.
  {
    source: "./message/existing-representation-publication-request-v1.ts",
    imported: "HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1",
    exported: "HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1",
    typeOnly: false,
  },
  ...([
    "MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2",
    "MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2",
  ] as const).map((name) => ({
    source: "./format/object-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  // M320's retained-generation bound and exact native Namespace authority
  // records belong only to the versioned wire surface, not the clean root.
  {
    source: "./v2-types/limits.ts",
    imported: "MAX_RETAINED_NAMESPACE_GENERATIONS_V2",
    exported: "MAX_RETAINED_NAMESPACE_GENERATIONS_V2",
    typeOnly: false,
  },
  ...[
    "MemoryNativeNamespaceAccessEntryV1",
    "MemoryNativeNamespaceAuthorityEntryV1",
  ].map((name) => ({
    source: "./memory/exact-access-request-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  // M318 Full edits expose their explicitly versioned wire protocol only;
  // no unversioned root workflow, key custody or storage owner is added.
  ...([
    "HUMAN_MESSAGE_EDIT_MAX_TTL_MS_V1",
    "HUMAN_MESSAGE_EDIT_OBJECT_ID_DOMAIN_V1",
    "HUMAN_MESSAGE_EDIT_PLAN_DOMAIN_V1",
    "HUMAN_MESSAGE_EDIT_PLAN_FORMAT_VERSION_V1",
    "HUMAN_MESSAGE_EDIT_PLAN_PURPOSE_V1",
    "HUMAN_MESSAGE_EDIT_REQUEST_DOMAIN_V1",
    "HUMAN_MESSAGE_EDIT_REQUEST_FORMAT_VERSION_V1",
    "HUMAN_MESSAGE_EDIT_REQUEST_PURPOSE_V1",
    "decodeHumanMessageEditPlanV1",
    "decodeHumanMessageEditRequestV1",
    "deriveHumanMessageEditCryptoObjectIdV1",
    "encodeHumanMessageEditPlanV1",
    "encodeHumanMessageEditRequestV1",
    "parseHumanMessageEditCryptoObjectIdV1",
    "prepareHumanMessageEditRequestV1",
    "verifyHumanMessageEditRequestV1",
  ] as const).map((name) => ({
    source: "./message/human-message-edit-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "HumanMessageEditAuthorizationSchemeV1",
    "HumanMessageEditObjectCoordinatesV1",
    "HumanMessageEditPlanV1",
    "HumanMessageEditPreparedTargetV1",
    "HumanMessageEditRequestUnsignedV1",
    "HumanMessageEditRequestV1",
    "HumanMessageEditTargetV1",
    "ResolveCurrentHumanMessageEditAuthorityV1",
  ] as const).map((name) => ({
    source: "./message/human-message-edit-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  // M311 exact-set genesis is a supported unversioned workflow. Its complete
  // typed authority closure is public, while mutable preparation internals
  // remain private. These reviewed entries are not derived from the barrel.
  {
    source: "./object/device-wrapped-agent-access-manifest-set-v1.ts",
    imported: "prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1",
    exported: "prepareDeviceWrappedAgentObjectAccessManifestGenesisSet",
    typeOnly: false,
  },
  ...([
    "DeviceWrappedAgentEnvelopeAuthority",
    "DeviceWrappedAgentNamespaceAuthority",
    "DeviceWrappedAgentObjectAccessGenesisSetAuthorityContext",
    "PreparedDeviceWrappedAgentObjectAccessManifestGenesisSet",
    "PrepareDeviceWrappedAgentObjectAccessManifestGenesisSetInput",
  ] as const).map((name) => ({
    source: "./object/device-wrapped-agent-access-manifest-set-v1.ts",
    imported: `${name}V1`,
    exported: name,
    typeOnly: true,
  })),
  {
    source: "./object/agent-storage-coordinator.ts",
    imported: "persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1",
    exported: "persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet",
    typeOnly: false,
  },
  ...([
    "DeviceWrappedAgentObjectAccessGenesisSetAuthorizationDecision",
    "ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization",
  ] as const).map((name) => ({
    source: "./object/agent-storage-coordinator.ts",
    imported: `${name}V1`,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "decodeHumanDeviceCredentialName",
    "decodeHumanDeviceGroupHead",
    "decodeHumanDeviceGroupJoinRequest",
    "decodeHumanDeviceGroupTransition",
    "decodeHumanDeviceRoster",
    "deriveHumanDeviceGroupId",
    "encodeHumanDeviceCredentialName",
    "encodeHumanDeviceGroupHead",
    "encodeHumanDeviceGroupJoinRequest",
    "encodeHumanDeviceGroupTransition",
    "HUMAN_DEVICE_GROUP_MAX_TRANSITION_BYTES",
    "HumanDeviceOpenMlsGroup",
    "humanDeviceGroupHeadDigest",
    "humanDeviceGroupTransitionDigest",
  ] as const).map((name) => ({
    source: "./group/human-device.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "HumanDeviceCredential",
    "HumanDeviceGroupCoordinates",
    "HumanDeviceGroupHead",
    "HumanDeviceGroupJoinRequest",
    "HumanDeviceGroupTransition",
    "HumanDeviceRosterEntry",
    "PreparedHumanDeviceGroupJoin",
    "PreparedHumanDeviceGroupTransition",
  ] as const).map((name) => ({
    source: "./group/human-device.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1",
    "HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1",
    "HUMAN_DEVICE_GROUP_MAX_ROSTER_BYTES_V1",
    "HUMAN_DEVICE_GROUP_MAX_TRANSITION_BYTES_V1",
    "HUMAN_DEVICE_GROUP_PROVIDER_ID_V1",
    "decodeHumanDeviceCredentialNameV1",
    "decodeHumanDeviceGroupHeadV1",
    "decodeHumanDeviceGroupJoinRequestV1",
    "decodeHumanDeviceGroupTransitionV1",
    "decodeHumanDeviceRosterV1",
    "deriveHumanDeviceGroupIdV1",
    "encodeHumanDeviceCredentialNameV1",
    "encodeHumanDeviceGroupHeadV1",
    "encodeHumanDeviceGroupJoinRequestV1",
    "encodeHumanDeviceGroupTransitionV1",
    "humanDeviceGroupHeadDigestV1",
    "humanDeviceGroupTransitionDigestV1",
  ] as const).map((name) => ({
    source: "./group/human-device-openmls-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "HumanDeviceCredentialV1",
    "HumanDeviceGroupCoordinatesV1",
    "HumanDeviceGroupHeadV1",
    "HumanDeviceGroupJoinRequestV1",
    "HumanDeviceGroupTransitionV1",
    "HumanDeviceRosterEntryV1",
  ] as const).map((name) => ({
    source: "./group/human-device-openmls-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "OpenMlsV2AuthenticatedRosterEntry",
    "OpenMlsV2IdentityCodec",
  ] as const).map((imported) => ({
    source: "./group/v2-openmls.ts",
    imported,
    exported: imported.replace(/^OpenMlsV2/u, "OpenMls"),
    typeOnly: true,
  })),
  ...([
    ["answerRecoveryDevicePossessionChallengeV2", "answerRecoveryDevicePossessionChallenge", false],
    ["prepareRecoveryDevicePossessionChallengeV2", "prepareRecoveryDevicePossessionChallenge", false],
    ["verifyRecoveryDevicePossessionProofV2", "verifyRecoveryDevicePossessionProof", false],
    ["RecoveryDeviceChallengePreparationInputV2", "RecoveryDeviceChallengePreparationInput", true],
    ["RecoveryDevicePossessionProofV2", "RecoveryDevicePossessionProof", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./recovery/device-transfer-v2.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    ["openDomainKeyRecipientEnvelopeV2", "openDomainKeyRecipientEnvelope", false],
    ["prepareDomainKeyHeadV2", "prepareDomainKeyHead", false],
    ["prepareDomainKeyRecipientAuthorizationV2", "prepareDomainKeyRecipientAuthorization", false],
    ["prepareDomainKeyRecipientEnvelopeV2", "prepareDomainKeyRecipientEnvelope", false],
    ["verifyDomainKeyHeadV2", "verifyDomainKeyHead", false],
    ["verifyDomainKeyRecipientAuthorizationExactReplayV2", "verifyDomainKeyRecipientAuthorizationExactReplay", false],
    ["verifyDomainKeyRecipientAuthorizationV2", "verifyDomainKeyRecipientAuthorization", false],
    ["verifyDomainKeyRecipientEnvelopeV2", "verifyDomainKeyRecipientEnvelope", false],
    ["DomainKeyHeadV2", "DomainKeyHead", true],
    ["DomainKeyRecipientAuthorizationV2", "DomainKeyRecipientAuthorization", true],
    ["DomainKeyRecipientEnvelopeV2", "DomainKeyRecipientEnvelope", true],
    ["DomainKeyRecipientInputV2", "DomainKeyRecipientInput", true],
    ["OpenedDomainKeyRecipientEnvelopeV2", "OpenedDomainKeyRecipientEnvelope", true],
    ["PreparedDomainKeyHeadV2", "PreparedDomainKeyHead", true],
    ["PreparedDomainKeyRecipientAuthorizationV2", "PreparedDomainKeyRecipientAuthorization", true],
    ["PreparedDomainKeyRecipientEnvelopeV2", "PreparedDomainKeyRecipientEnvelope", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/domain-key-authority-v2.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    ["DOMAIN_KEY_BYTES_V2", "DOMAIN_KEY_BYTES", false],
    ["destroyDomainKeyV2", "destroyDomainKey", false],
    ["domainKeyClassV2", "domainKeyClass", false],
    ["generateDomainKeyV2", "generateDomainKey", false],
    ["withDomainKeyV2", "withDomainKey", false],
    ["DomainKeyClassV2", "DomainKeyClass", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./domain/domain-keys-v2.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    ["prepareDomainKeyAccessRequestV2", "prepareDomainKeyAccessRequest", false],
    ["prepareDomainKeyAcknowledgementV2", "prepareDomainKeyAcknowledgement", false],
    ["verifyDomainKeyAccessRequestV2", "verifyDomainKeyAccessRequest", false],
    ["verifyDomainKeyAcknowledgementV2", "verifyDomainKeyAcknowledgement", false],
    ["DomainKeyAccessRequestV2", "DomainKeyAccessRequest", true],
    ["DomainKeyAcknowledgementV2", "DomainKeyAcknowledgement", true],
    ["PreparedDomainKeyDeliveryRecordV2", "PreparedDomainKeyDeliveryRecord", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/domain-key-delivery-v2.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    ["DOMAIN_NAMESPACE_GENERATION_KEY_BYTES_V2", "DOMAIN_NAMESPACE_GENERATION_KEY_BYTES", false],
    ["domainNamespaceGenerationHeadDigestV2", "domainNamespaceGenerationHeadDigest", false],
    ["domainNamespaceRetainedAuthoritySetDigestV2", "domainNamespaceRetainedAuthoritySetDigest", false],
    ["prepareDomainNamespaceBundleV2", "prepareDomainNamespaceBundle", false],
    ["withOpenedDomainNamespaceBundleV2", "withOpenedDomainNamespaceBundle", false],
    ["DomainNamespaceBundleBindingV2", "DomainNamespaceBundleBinding", true],
    ["DomainNamespaceBundleV2", "DomainNamespaceBundle", true],
    ["DomainNamespaceRetainedAuthorityV2", "DomainNamespaceRetainedAuthority", true],
    ["DomainNamespaceRetainedGenerationV2", "DomainNamespaceRetainedGeneration", true],
    ["OpenDomainNamespaceBundleResultV2", "OpenDomainNamespaceBundleResult", true],
    ["PreparedDomainNamespaceBundleV2", "PreparedDomainNamespaceBundle", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/domain-namespace-bundle-v2.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    ["createDomainForegroundAuthorizationPlanV2", "createDomainForegroundAuthorizationPlan", false],
    ["domainForegroundAuthoritySetDigestV2", "domainForegroundAuthoritySetDigest", false],
    ["domainForegroundNamespaceBindingSetDigestV2", "domainForegroundNamespaceBindingSetDigest", false],
    ["mintDomainForegroundAuthorizationV2", "mintDomainForegroundAuthorization", false],
    ["withOpenedDomainForegroundAuthorizationV2", "withOpenedDomainForegroundAuthorization", false],
    ["DomainForegroundAuthorityEntryV2", "DomainForegroundAuthorityEntry", true],
    ["DomainForegroundAuthorizationCurrentAuthorityV2", "DomainForegroundAuthorizationCurrentAuthority", true],
    ["DomainForegroundOperationV2", "DomainForegroundOperation", true],
    ["DomainForegroundNamespaceBindingV2", "DomainForegroundNamespaceBinding", true],
    ["DomainForegroundSecretEntryV2", "DomainForegroundSecretEntry", true],
    ["OpenDomainForegroundAuthorizationResultV2", "OpenDomainForegroundAuthorizationResult", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/domain-foreground-authorization-v2.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "DOMAIN_FOREGROUND_AUTHORIZATION_FORMAT_VERSION_V2",
    "DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2",
    "DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2",
    "DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2",
    "DOMAIN_FOREGROUND_AUTHORIZATION_PLAN_PURPOSE_V2",
    "DOMAIN_FOREGROUND_AUTHORIZATION_PURPOSE_V2",
    "DOMAIN_FOREGROUND_AUTHORIZATION_SCHEME_V2",
    "DOMAIN_FOREGROUND_AUTHORIZATION_SECRET_PURPOSE_V2",
    "destroyDomainForegroundAuthorizationPlanV2",
    "destroyDomainForegroundAuthorizationV2",
    "parseDomainForegroundAuthorizationPlanV2",
    "parseDomainForegroundAuthorizationV2",
    "serializeDomainForegroundAuthorizationPlanV2",
    "serializeDomainForegroundAuthorizationV2",
  ] as const).map((name) => ({
    source: "./format/domain-foreground-authorization-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "DomainForegroundAuthorizationPlanV2",
    "DomainForegroundAuthorizationV2",
    "DomainForegroundRecipientKindV2",
  ] as const).map((name) => ({
    source: "./format/domain-foreground-authorization-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2",
    "DOMAIN_KEY_AUTHORITY_MAX_TTL_MS_V2",
    "DOMAIN_KEY_HEAD_MAX_WIRE_BYTES_V2",
    "DOMAIN_KEY_HEAD_PURPOSE_V2",
    "DOMAIN_KEY_RECIPIENT_AUTHORIZATION_MAX_WIRE_BYTES_V2",
    "DOMAIN_KEY_RECIPIENT_AUTHORIZATION_PURPOSE_V2",
    "DOMAIN_KEY_RECIPIENT_ENVELOPE_MAX_WIRE_BYTES_V2",
    "DOMAIN_KEY_RECIPIENT_ENVELOPE_PURPOSE_V2",
    "DOMAIN_KEY_RECIPIENT_SECRET_PURPOSE_V2",
    "decodeDomainKeyHeadV2",
    "decodeDomainKeyRecipientAuthorizationV2",
    "decodeDomainKeyRecipientEnvelopeV2",
    "decodeDomainKeyRecipientSecretV2",
    "destroyDomainKeyHeadV2",
    "destroyDomainKeyRecipientAuthorizationV2",
    "destroyDomainKeyRecipientEnvelopeV2",
    "destroyDomainKeyRecipientSecretV2",
    "domainKeyHeadSigningBytesV2",
    "domainKeyRecipientAuthorizationSigningBytesV2",
    "domainKeyRecipientEnvelopeSigningBytesV2",
    "encodeDomainKeyHeadV2",
    "encodeDomainKeyRecipientAuthorizationV2",
    "encodeDomainKeyRecipientEnvelopeV2",
    "encodeDomainKeyRecipientSecretV2",
  ] as const).map((name) => ({
    source: "./format/domain-key-authority-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "DomainKeyHeadUnsignedV2",
    "DomainKeyRecipientAuthorizationReasonV2",
    "DomainKeyRecipientAuthorizationUnsignedV2",
    "DomainKeyRecipientEnvelopeUnsignedV2",
    "DomainKeyRecipientKindV2",
    "DomainKeyRecipientSecretV2",
    "DomainKeyRecipientV2",
  ] as const).map((name) => ({
    source: "./format/domain-key-authority-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2",
    "DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2",
    "DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2",
    "DOMAIN_KEY_DELIVERY_MAX_TTL_MS_V2",
    "DOMAIN_KEY_DELIVERY_MAX_WIRE_BYTES_V2",
    "decodeDomainKeyAccessRequestV2",
    "decodeDomainKeyAcknowledgementV2",
    "destroyDomainKeyAccessRequestV2",
    "destroyDomainKeyAcknowledgementV2",
    "domainKeyAccessRequestSigningBytesV2",
    "domainKeyAcknowledgementSigningBytesV2",
    "encodeDomainKeyAccessRequestV2",
    "encodeDomainKeyAcknowledgementV2",
  ] as const).map((name) => ({
    source: "./format/domain-key-delivery-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "DomainKeyAccessRequestUnsignedV2",
    "DomainKeyAcknowledgementUnsignedV2",
    "DomainKeyDeliveryCoordinatesV2",
  ] as const).map((name) => ({
    source: "./format/domain-key-delivery-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "DOMAIN_NAMESPACE_BUNDLE_BINDING_PURPOSE_V2",
    "DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2",
    "DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2",
    "DOMAIN_NAMESPACE_BUNDLE_MAX_INNER_BYTES_V2",
    "DOMAIN_NAMESPACE_BUNDLE_MAX_RETAINED_GENERATIONS_V2",
    "DOMAIN_NAMESPACE_BUNDLE_MAX_TTL_MS_V2",
    "DOMAIN_NAMESPACE_BUNDLE_MAX_WIRE_BYTES_V2",
    "decodeDomainNamespaceBundleBindingV2",
    "decodeDomainNamespaceBundleV2",
    "destroyDomainNamespaceBundleBindingV2",
    "destroyDomainNamespaceBundleV2",
    "encodeDomainNamespaceBundleBindingV2",
    "encodeDomainNamespaceBundleV2",
    "verifyDomainNamespaceBundleBindingV2",
  ] as const).map((name) => ({
    source: "./format/domain-namespace-bundle-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    ["createDeviceWrappedDomainAgentGrantPlanV1", "createDeviceWrappedDomainAgentGrantPlan", false],
    ["mintDeviceWrappedDomainAgentGrantV1", "mintDeviceWrappedDomainAgentGrant", false],
    ["withOpenedDeviceWrappedDomainAgentGrantV1", "withOpenedDeviceWrappedDomainAgentGrant", false],
    ["DeviceWrappedDomainAgentGrantAuthorityEntryV1", "DeviceWrappedDomainAgentGrantAuthorityEntry", true],
    ["DeviceWrappedDomainAgentGrantCurrentAuthorityV1", "DeviceWrappedDomainAgentGrantCurrentAuthority", true],
    ["DeviceWrappedDomainAgentGrantPlanV1", "DeviceWrappedDomainAgentGrantPlan", true],
    ["DeviceWrappedDomainAgentGrantSecretEntryV1", "DeviceWrappedDomainAgentGrantSecretEntry", true],
    ["DeviceWrappedDomainAgentGrantV1", "DeviceWrappedDomainAgentGrant", true],
    ["OpenDeviceWrappedDomainAgentGrantResultV1", "OpenDeviceWrappedDomainAgentGrantResult", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/device-wrapped-domain-agent-grant-v1.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_FORMAT_VERSION",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_DOMAINS",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_SECRET_BYTES",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_TTL_MS",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_MAX_WIRE_BYTES",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PLAN_PURPOSE",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_PURPOSE",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SCHEME",
    "DEVICE_WRAPPED_DOMAIN_AGENT_GRANT_V1_SECRET_PURPOSE",
    "destroyDeviceWrappedDomainAgentGrantPlanV1",
    "destroyDeviceWrappedDomainAgentGrantSecretV1",
    "destroyDeviceWrappedDomainAgentGrantV1",
    "deviceWrappedDomainAgentGrantAuthoritySetDigestV1",
    "parseDeviceWrappedDomainAgentGrantPlanV1",
    "parseDeviceWrappedDomainAgentGrantSecretV1",
    "parseDeviceWrappedDomainAgentGrantV1",
    "serializeDeviceWrappedDomainAgentGrantPlanV1",
    "serializeDeviceWrappedDomainAgentGrantSecretV1",
    "serializeDeviceWrappedDomainAgentGrantV1",
  ] as const).map((name) => ({
    source: "./format/device-wrapped-domain-agent-grant-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "DeviceWrappedDomainAgentGrantOperationV1",
    "DeviceWrappedDomainAgentGrantSecretV1",
  ] as const).map((name) => ({
    source: "./format/device-wrapped-domain-agent-grant-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    ["humanLiveShadowMessageRequestDigestV3", "domainCompressedHumanLiveShadowMessageRequestDigest", false],
    ["liveShadowMessagePlanDigestV3", "domainCompressedLiveShadowMessagePlanDigest", false],
    ["prepareHumanLiveShadowMessageRequestV3", "prepareDomainCompressedHumanLiveShadowMessageRequest", false],
    ["verifyHumanLiveShadowMessageRequestExactReplayV3", "verifyDomainCompressedHumanLiveShadowMessageRequestExactReplay", false],
    ["verifyHumanLiveShadowMessageRequestV3", "verifyDomainCompressedHumanLiveShadowMessageRequest", false],
    ["CreatedHumanLiveShadowMessageRequestV3", "CreatedDomainCompressedHumanLiveShadowMessageRequest", true],
    ["HumanLiveShadowMessageRequestV3", "DomainCompressedHumanLiveShadowMessageRequest", true],
    ["LiveShadowMessagePlanV3", "DomainCompressedLiveShadowMessagePlan", true],
    ["PrepareHumanLiveShadowMessageRequestInputV3", "PrepareDomainCompressedHumanLiveShadowMessageRequestInput", true],
    ["ResolveCurrentHumanLiveShadowMessageAuthorityV3", "ResolveCurrentDomainCompressedHumanLiveShadowMessageAuthority", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./message/live-shadow-message-request-v3.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V3",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V3",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V3",
    "LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V3",
    "LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V3",
    "LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V3",
    "LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V3",
    "LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V3",
    "MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V3",
    "MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V3",
    "decodeHumanLiveShadowMessageRequestV3",
    "decodeLiveShadowMessagePlanV3",
    "encodeHumanLiveShadowMessageRequestV3",
    "encodeLiveShadowMessagePlanV3",
    "humanLiveShadowMessageRequestSigningBytesV3",
  ] as const).map((name) => ({
    source: "./message/live-shadow-message-request-v3.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  {
    source: "./message/live-shadow-message-request-v3.ts",
    imported: "HumanLiveShadowMessageRequestUnsignedV3",
    exported: "HumanLiveShadowMessageRequestUnsignedV3",
    typeOnly: true,
  },
  {
    source: "./format/namespace-generation-v1.ts",
    imported: "NAMESPACE_GENERATION_KEY_COMMITMENT_DOMAIN_V1",
    exported: "NAMESPACE_GENERATION_KEY_COMMITMENT_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./format/namespace-generation-v1.ts",
    imported: "namespaceGenerationKeyCommitmentV1",
    exported: "namespaceGenerationKeyCommitmentV1",
    typeOnly: false,
  },
  {
    source: "./format/namespace-generation-v1.ts",
    imported: "NamespaceGenerationKeyCommitmentInputV1",
    exported: "NamespaceGenerationKeyCommitmentInputV1",
    typeOnly: true,
  },
  ...([
    ["openNamespaceRecipientAuthorizationV1", "openNamespaceRecipientAuthorization", false],
    ["openNamespaceRecipientAuthorizationExactReplayV1", "openNamespaceRecipientAuthorizationExactReplay", false],
    ["prepareNamespaceRecipientAuthorizationV1", "prepareNamespaceRecipientAuthorization", false],
    ["verifyNamespaceRecipientAuthorizationV1", "verifyNamespaceRecipientAuthorization", false],
    ["verifyNamespaceRecipientAuthorizationExactReplayV1", "verifyNamespaceRecipientAuthorizationExactReplay", false],
    ["OpenedNamespaceRecipientAuthorizationV1", "OpenedNamespaceRecipientAuthorization", true],
    ["OpenNamespaceRecipientAuthorizationInputV1", "OpenNamespaceRecipientAuthorizationInput", true],
    ["OpenNamespaceRecipientAuthorizationExactReplayInputV1", "OpenNamespaceRecipientAuthorizationExactReplayInput", true],
    ["PreparedNamespaceRecipientAuthorizationV1", "PreparedNamespaceRecipientAuthorization", true],
    ["PrepareNamespaceRecipientAuthorizationEntryV1", "PrepareNamespaceRecipientAuthorizationEntry", true],
    ["PrepareNamespaceRecipientAuthorizationInputV1", "PrepareNamespaceRecipientAuthorizationInput", true],
    ["VerifyNamespaceRecipientAuthorizationInputV1", "VerifyNamespaceRecipientAuthorizationInput", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/namespace-recipient-authorization-v1.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "decodeNamespaceRecipientAuthorizationV1",
    "destroyNamespaceRecipientAuthorizationV1",
    "encodeNamespaceRecipientAuthorizationV1",
    "MAX_NAMESPACE_RECIPIENT_AUTHORIZATION_WIRE_BYTES_V1",
    "NAMESPACE_RECIPIENT_AUTHORIZATION_DOMAIN_V1",
    "NAMESPACE_RECIPIENT_AUTHORIZATION_FORMAT_VERSION_V1",
    "NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_ENTRIES_V1",
    "NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_TTL_MS_V1",
    "NAMESPACE_RECIPIENT_AUTHORIZATION_SECRET_DOMAIN_V1",
    "namespaceRecipientAuthorizationDigestV1",
    "namespaceRecipientAuthorizationSigningBytesV1",
  ] as const).map((name) => ({
    source: "./format/namespace-recipient-authorization-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "NamespaceRecipientAuthorizationEnvelopeV1",
    "NamespaceRecipientAuthorizationGenerationV1",
    "NamespaceRecipientAuthorizationTargetV1",
    "NamespaceRecipientAuthorizationV1",
  ] as const).map((name) => ({
    source: "./format/namespace-recipient-authorization-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  {
    source: "./object/access-manifest.ts",
    imported: "authenticateObjectAccessManifestGenesisV2",
    exported: "authenticateObjectAccessManifestGenesis",
    typeOnly: false,
  },
  {
    source: "./object/access-manifest.ts",
    imported: "AuthenticateObjectAccessManifestGenesisInputV2",
    exported: "AuthenticateObjectAccessManifestGenesisInput",
    typeOnly: true,
  },
  ...([
    ["ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1", "ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES"],
    ["ARTIFACT_BLOB_DEK_BYTES_V1", "ARTIFACT_BLOB_DEK_BYTES"],
    ["ARTIFACT_BLOB_MAX_CHUNKS_V1", "ARTIFACT_BLOB_MAX_CHUNKS"],
    ["ARTIFACT_BLOB_MAX_FILE_BYTES_V1", "ARTIFACT_BLOB_MAX_FILE_BYTES"],
    ["ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1", "ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES"],
    ["artifactBlobSealedChunkBytesV1", "artifactBlobSealedChunkBytes"],
    ["deriveArtifactBlobChunkCountV1", "deriveArtifactBlobChunkCount"],
    ["generateArtifactBlobDekV1", "generateArtifactBlobDek"],
    ["openArtifactBlobChunkV1", "openArtifactBlobChunk"],
    ["openArtifactBlobRangeV1", "openArtifactBlobRange"],
    ["sealArtifactBlobChunkV1", "sealArtifactBlobChunk"],
    ["sealArtifactBlobV1", "sealArtifactBlob"],
  ] as const).map(([imported, exported]) => ({
    source: "./artifact/blob-v1.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  ...([
    ["ArtifactBlobHeaderV1", "ArtifactBlobHeader"],
    ["OpenArtifactBlobChunkInputV1", "OpenArtifactBlobChunkInput"],
    ["SealArtifactBlobChunkInputV1", "SealArtifactBlobChunkInput"],
  ] as const).map(([imported, exported]) => ({
    source: "./artifact/blob-v1.ts",
    imported,
    exported,
    typeOnly: true,
  })),
  ...([
    ["ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1", "ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES"],
    ["ARTIFACT_CONTROL_MAX_MIME_TYPE_BYTES_V1", "ARTIFACT_CONTROL_MAX_MIME_TYPE_BYTES"],
    ["wipeArtifactControlV1", "wipeArtifactControl"],
  ] as const).map(([imported, exported]) => ({
    source: "./artifact/control-v1.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  {
    source: "./artifact/control-v1.ts",
    imported: "ArtifactControlV1",
    exported: "ArtifactControl",
    typeOnly: true,
  },
  ...([
    ["prepareHumanTaskPublicationRequestV1", "prepareHumanTaskPublicationRequest"],
    ["verifyHumanTaskPublicationRequestV1", "verifyHumanTaskPublicationRequest"],
    ["verifyHumanTaskPublicationRequestExactReplayV1", "verifyHumanTaskPublicationRequestExactReplay"],
  ] as const).map(([imported, exported]) => ({
    source: "./task/publication-request-v1.ts", imported, exported, typeOnly: false,
  })),
  ...([
    ["HumanTaskPublicationRequestV1", "HumanTaskPublicationRequest"],
    ["PrepareHumanTaskPublicationRequestInputV1", "PrepareHumanTaskPublicationRequestInput"],
  ] as const).map(([imported, exported]) => ({
    source: "./task/publication-request-v1.ts", imported, exported, typeOnly: true,
  })),
  ...[
    "HUMAN_TASK_PUBLICATION_REQUEST_DOMAIN_V1",
    "HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1",
    "decodeHumanTaskPublicationRequestV1",
    "encodeHumanTaskPublicationRequestV1",
    "humanTaskPublicationRequestSigningBytesV1",
  ].map((exported) => ({
    source: "./task/publication-request-v1.ts", imported: exported, exported, typeOnly: false,
  })),
  {
    source: "./task/publication-request-v1.ts",
    imported: "HumanTaskPublicationRequestUnsignedV1",
    exported: "HumanTaskPublicationRequestUnsignedV1", typeOnly: true,
  },
  ...([
    ["prepareHumanArtifactPublicationRequestV1", "prepareHumanArtifactPublicationRequest"],
    ["verifyHumanArtifactPublicationRequestV1", "verifyHumanArtifactPublicationRequest"],
  ] as const).map(([imported, exported]) => ({
    source: "./artifact/publication-request-v1.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  ...([
    ["CreatedHumanArtifactPublicationRequestV1", "CreatedHumanArtifactPublicationRequest"],
    ["HumanArtifactPublicationAuthorityContextV1", "HumanArtifactPublicationAuthorityContext"],
    ["HumanArtifactMimeClassV1", "HumanArtifactMimeClass"],
    ["HumanArtifactPublicationLifecycleActionV1", "HumanArtifactPublicationLifecycleAction"],
    ["HumanArtifactPublicationOperationV1", "HumanArtifactPublicationOperation"],
    ["HumanArtifactPublicationRequestEntryV1", "HumanArtifactPublicationRequestEntry"],
    ["HumanArtifactPublicationRequestV1", "HumanArtifactPublicationRequest"],
    ["HumanArtifactSizeBucketV1", "HumanArtifactSizeBucket"],
    ["PrepareHumanArtifactPublicationRequestInputV1", "PrepareHumanArtifactPublicationRequestInput"],
    ["ResolveCurrentHumanArtifactPublicationAuthorityV1", "ResolveCurrentHumanArtifactPublicationAuthority"],
  ] as const).map(([imported, exported]) => ({
    source: "./artifact/publication-request-v1.ts",
    imported,
    exported,
    typeOnly: true,
  })),
  ...([
    ["fingerprintHumanArtifactAccessInventoryV1", "fingerprintHumanArtifactAccessInventory"],
    ["prepareHumanArtifactExactAccessRequestV1", "prepareHumanArtifactExactAccessRequest"],
    ["verifyHumanArtifactExactAccessRequestV1", "verifyHumanArtifactExactAccessRequest"],
  ] as const).map(([imported, exported]) => ({
    source: "./artifact/exact-access-request-v1.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  ...([
    ["HumanArtifactAccessInventoryEntryV1", "HumanArtifactAccessInventoryEntry"],
    ["HumanArtifactExactAccessRequestV1", "HumanArtifactExactAccessRequest"],
    ["PrepareHumanArtifactExactAccessRequestInputV1", "PrepareHumanArtifactExactAccessRequestInput"],
    ["ResolveCurrentHumanArtifactExactAccessAuthorityV1", "ResolveCurrentHumanArtifactExactAccessAuthority"],
  ] as const).map(([imported, exported]) => ({
    source: "./artifact/exact-access-request-v1.ts",
    imported,
    exported,
    typeOnly: true,
  })),
  ...[
    "ARTIFACT_BLOB_FORMAT_VERSION_V1",
    "decodeArtifactBlobHeaderV1",
    "encodeArtifactBlobChunkFrameV1",
    "encodeArtifactBlobHeaderV1",
  ].map((exported) => ({
    source: "./artifact/blob-v1.ts",
    imported: exported,
    exported,
    typeOnly: false,
  })),
  ...[
    "ARTIFACT_CONTROL_FORMAT_VERSION_V1",
    "decodeArtifactControlV1",
    "encodeArtifactControlV1",
  ].map((exported) => ({
    source: "./artifact/control-v1.ts",
    imported: exported,
    exported,
    typeOnly: false,
  })),
  ...[
    "HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V1",
    "HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V1",
    "HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_PURPOSE_V1",
    "MAX_HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_WIRE_BYTES_V1",
    "decodeHumanArtifactExactAccessRequestV1",
    "encodeHumanArtifactExactAccessRequestV1",
  ].map((exported) => ({
    source: "./artifact/exact-access-request-v1.ts",
    imported: exported,
    exported,
    typeOnly: false,
  })),
  ...[
    "HUMAN_ARTIFACT_PUBLICATION_REQUEST_DOMAIN_V1",
    "HUMAN_ARTIFACT_PUBLICATION_REQUEST_FORMAT_VERSION_V1",
    "HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_ENTRIES_V1",
    "HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_TTL_MS_V1",
    "HUMAN_ARTIFACT_PUBLICATION_REQUEST_PURPOSE_V1",
    "MAX_HUMAN_ARTIFACT_PUBLICATION_REQUEST_WIRE_BYTES_V1",
    "decodeHumanArtifactPublicationRequestV1",
    "encodeHumanArtifactPublicationRequestV1",
    "humanArtifactPublicationRequestSigningBytesV1",
  ].map((exported) => ({
    source: "./artifact/publication-request-v1.ts",
    imported: exported,
    exported,
    typeOnly: false,
  })),
  ...[
    "HumanArtifactPublicationRequestUnsignedV1",
  ].map((exported) => ({
    source: "./artifact/publication-request-v1.ts",
    imported: exported,
    exported,
    typeOnly: true,
  })),
  {
    source: "./device/v2-state-vault.ts",
    imported: "restoreSealedProviderStateV2",
    exported: "restoreSealedProviderState",
    typeOnly: false,
  },
  {
    source: "./transition/provider-candidate.ts",
    imported: "cloneProviderHeadV2",
    exported: "cloneProviderHead",
    typeOnly: false,
  },
  {
    source: "./transition/provider-candidate.ts",
    imported: "providerHeadsEqualV2",
    exported: "providerHeadsEqual",
    typeOnly: false,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1",
    exported: "PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS",
    typeOnly: false,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE_V1",
    exported: "PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE",
    typeOnly: false,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1",
    exported: "PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS",
    typeOnly: false,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformRecipientRegistryV1",
    exported: "ProcessorTransformRecipientRegistry",
    typeOnly: false,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "OneRunProcessorTransformResultV1",
    exported: "OneRunProcessorTransformResult",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorCredentialClaimPortV1",
    exported: "ProcessorCredentialClaimPort",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorCredentialClaimV1",
    exported: "ProcessorCredentialClaim",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformCapabilityV1",
    exported: "ProcessorTransformCapability",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformDeadlineHandleV1",
    exported: "ProcessorTransformDeadlineHandle",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformDeadlineSchedulerV1",
    exported: "ProcessorTransformDeadlineScheduler",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformInputV1",
    exported: "ProcessorTransformInput",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformObjectPortV1",
    exported: "ProcessorTransformObjectPort",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformOutputV1",
    exported: "ProcessorTransformOutput",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformRecipientAttemptV1",
    exported: "ProcessorTransformRecipientAttempt",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformRecipientCreationResultV1",
    exported: "ProcessorTransformRecipientCreationResult",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformRegistryRunResultV1",
    exported: "ProcessorTransformRegistryRunResult",
    typeOnly: true,
  },
  {
    source: "./background/one-run-processor-transform-v1.ts",
    imported: "ProcessorTransformRunInputV1",
    exported: "ProcessorTransformRunInput",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "agentRuntimeInitializationPublicStateCommitment",
    exported: "agentRuntimeInitializationPublicStateCommitment",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "agentRuntimeInitializationSignerPublicationMatchesState",
    exported: "agentRuntimeInitializationSignerPublicationMatchesState",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "agentRuntimeRotationSignerPublicationMatchesManifest",
    exported: "agentRuntimeRotationSignerPublicationMatchesManifest",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "agentRuntimeSignerPublicationMatchesRuntime",
    exported: "agentRuntimeSignerPublicationMatchesRuntime",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "verifyHistoricalAgentRuntimeSignerPublication",
    exported: "verifyHistoricalAgentRuntimeSignerPublication",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "AgentRuntimeSignerPublication",
    exported: "AgentRuntimeSignerPublication",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "AgentRuntimeSignerPublicationManager",
    exported: "AgentRuntimeSignerPublicationManager",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "CurrentAgentRuntimeSignerPublicationManagerContext",
    exported: "CurrentAgentRuntimeSignerPublicationManagerContext",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "HistoricalAgentRuntimeSignerPublicationManagerContext",
    exported: "HistoricalAgentRuntimeSignerPublicationManagerContext",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "ResolveCurrentAgentRuntimeSignerPublicationManager",
    exported: "ResolveCurrentAgentRuntimeSignerPublicationManager",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication.ts",
    imported: "ResolveHistoricalAgentRuntimeSignerPublicationManager",
    exported: "ResolveHistoricalAgentRuntimeSignerPublicationManager",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1",
    exported: "AGENT_RUNTIME_SIGNER_PUBLICATION_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1",
    exported: "AGENT_RUNTIME_SIGNER_PUBLICATION_FORMAT_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1",
    exported: "MAX_AGENT_RUNTIME_SIGNER_PUBLICATION_WIRE_BYTES_V1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "agentRuntimeInitializationPublicStateCommitmentV1",
    exported: "agentRuntimeInitializationPublicStateCommitmentV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "agentRuntimeInitializationSignerPublicationMatchesStateV1",
    exported: "agentRuntimeInitializationSignerPublicationMatchesStateV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "agentRuntimeRotationSignerPublicationMatchesManifestV1",
    exported: "agentRuntimeRotationSignerPublicationMatchesManifestV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "agentRuntimeSignerPublicationMatchesRuntimeV1",
    exported: "agentRuntimeSignerPublicationMatchesRuntimeV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "agentRuntimeSignerPublicationSigningBytesV1",
    exported: "agentRuntimeSignerPublicationSigningBytesV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "decodeAgentRuntimeSignerPublicationV1",
    exported: "decodeAgentRuntimeSignerPublicationV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "encodeAgentRuntimeSignerPublicationV1",
    exported: "encodeAgentRuntimeSignerPublicationV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "verifyHistoricalAgentRuntimeSignerPublicationV1",
    exported: "verifyHistoricalAgentRuntimeSignerPublicationV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AgentRuntimeInitializationPublicStateDomainV1",
    exported: "AgentRuntimeInitializationPublicStateDomainV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AgentRuntimeInitializationPublicStateV1",
    exported: "AgentRuntimeInitializationPublicStateV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AgentRuntimeSignerPublicationManagerV1",
    exported: "AgentRuntimeSignerPublicationManagerV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AgentRuntimeSignerPublicationTransitionKindV1",
    exported: "AgentRuntimeSignerPublicationTransitionKindV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AgentRuntimeSignerPublicationUnsignedV1",
    exported: "AgentRuntimeSignerPublicationUnsignedV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "AgentRuntimeSignerPublicationV1",
    exported: "AgentRuntimeSignerPublicationV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "CurrentAgentRuntimeSignerPublicationManagerContextV1",
    exported: "CurrentAgentRuntimeSignerPublicationManagerContextV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "HistoricalAgentRuntimeSignerPublicationManagerContextV1",
    exported: "HistoricalAgentRuntimeSignerPublicationManagerContextV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "ResolveCurrentAgentRuntimeSignerPublicationManagerV1",
    exported: "ResolveCurrentAgentRuntimeSignerPublicationManagerV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/signer-publication-v1.ts",
    imported: "ResolveHistoricalAgentRuntimeSignerPublicationManagerV1",
    exported: "ResolveHistoricalAgentRuntimeSignerPublicationManagerV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "deriveAgentRuntimeObjectSignerPublicV1",
    exported: "deriveAgentRuntimeObjectSignerPublic",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "signAgentRuntimeObjectBytesV1",
    exported: "signAgentRuntimeObjectBytes",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "AgentRuntimeObjectSignerPrincipalV1",
    exported: "AgentRuntimeObjectSignerPrincipalV1",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "AgentRuntimeObjectSignerPublicV1",
    exported: "AgentRuntimeObjectSignerPublic",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "createAgentObjectAccessManifestV3",
    exported: "createAgentObjectAccessManifest",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "verifyAgentObjectAccessManifestV3",
    exported: "verifyAgentObjectAccessManifest",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "CreatedAgentObjectAccessManifestV3",
    exported: "CreatedAgentObjectAccessManifest",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "ResolveAgentRuntimeSignerPublicKeyV3",
    exported: "ResolveAgentRuntimeSignerPublicKey",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "VerifiedAgentObjectAccessManifestV3",
    exported: "VerifiedAgentObjectAccessManifest",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_DOMAIN_V1",
    exported: "AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_VERSION_V1",
    exported: "AGENT_RUNTIME_OBJECT_SIGNER_DERIVATION_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "AGENT_RUNTIME_OBJECT_SIGNER_KEY_ID_PREFIX_V1",
    exported: "AGENT_RUNTIME_OBJECT_SIGNER_KEY_ID_PREFIX_V1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "agentRuntimeObjectSignerKeyIdV1",
    exported: "agentRuntimeObjectSignerKeyIdV1",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/object-signer-v1.ts",
    imported: "normalizeAgentRuntimeObjectSignerPrincipalV1",
    exported: "normalizeAgentRuntimeObjectSignerPrincipalV1",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "decodeObjectAccessManifestV3",
    exported: "decodeObjectAccessManifestV3",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "encodeObjectAccessManifestV3",
    exported: "encodeObjectAccessManifestV3",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3",
    exported: "MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V3",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "OBJECT_ACCESS_MANIFEST_DOMAIN_V3",
    exported: "OBJECT_ACCESS_MANIFEST_DOMAIN_V3",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3",
    exported: "OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V3",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "objectAccessManifestSigningBytesV3",
    exported: "objectAccessManifestSigningBytesV3",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "ObjectAccessManifestUnsignedV3",
    exported: "ObjectAccessManifestUnsignedV3",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v3.ts",
    imported: "ObjectAccessManifestV3",
    exported: "ObjectAccessManifestV3",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4",
    exported: "MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "OBJECT_ACCESS_MANIFEST_DOMAIN_V4",
    exported: "OBJECT_ACCESS_MANIFEST_DOMAIN_V4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4",
    exported: "OBJECT_ACCESS_MANIFEST_FORMAT_VERSION_V4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "createAgentObjectAccessManifestV4",
    exported: "createAgentObjectAccessManifestV4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "createProcessorObjectAccessManifestV4",
    exported: "createProcessorObjectAccessManifestV4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "decodeObjectAccessManifestV4",
    exported: "decodeObjectAccessManifestV4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "encodeObjectAccessManifestV4",
    exported: "encodeObjectAccessManifestV4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "objectAccessManifestSigningBytesV4",
    exported: "objectAccessManifestSigningBytesV4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "verifyObjectAccessManifestV4",
    exported: "verifyObjectAccessManifestV4",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "CreatedObjectAccessManifestV4",
    exported: "CreatedObjectAccessManifestV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "ObjectAccessManifestSignerV4",
    exported: "ObjectAccessManifestSignerV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "ObjectAccessManifestUnsignedV4",
    exported: "ObjectAccessManifestUnsignedV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "ObjectAccessManifestV4",
    exported: "ObjectAccessManifestV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "ProcessorSignerAuthorizationEvidenceV4",
    exported: "ProcessorSignerAuthorizationEvidenceV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "ResolveAgentRuntimeSignerPublicKeyV4",
    exported: "ResolveAgentRuntimeSignerPublicKeyV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "ResolveHistoricalProcessorIssuingDevicePublicKeyV4",
    exported: "ResolveHistoricalProcessorIssuingDevicePublicKeyV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "ResolveProcessorSignerAuthorizationBytesV4",
    exported: "ResolveProcessorSignerAuthorizationBytesV4",
    typeOnly: true,
  },
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "VerifiedObjectAccessManifestV4",
    exported: "VerifiedObjectAccessManifestV4",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionOutcomeUnknownV2",
    exported: "AgentRuntimeAuthorizationTransitionOutcomeUnknown",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "aggregateAgentRuntimeAuthorizationTransitionV2",
    exported: "aggregateAgentRuntimeAuthorizationTransition",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "coordinateAgentRuntimeAuthorizationTransitionV2",
    exported: "coordinateAgentRuntimeAuthorizationTransition",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported:
      "destroyAgentRuntimeAuthorizationTransitionSourceLocalV2",
    exported: "destroyAgentRuntimeAuthorizationTransitionSourceLocal",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "persistAgentRuntimeAuthorizationTransitionV2",
    exported: "persistAgentRuntimeAuthorizationTransition",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "prepareAgentRuntimeAuthorizationTransitionSourceV2",
    exported: "prepareAgentRuntimeAuthorizationTransitionSource",
    typeOnly: false,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionAuthorizedDomainV2",
    exported: "AgentRuntimeAuthorizationTransitionAuthorizedDomain",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionEnvelopeContextV2",
    exported: "AgentRuntimeAuthorizationTransitionEnvelopeContext",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionManagerContextV2",
    exported: "AgentRuntimeAuthorizationTransitionManagerContext",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported:
      "AgentRuntimeAuthorizationTransitionPersistenceAuthorizationV2",
    exported: "AgentRuntimeAuthorizationTransitionPersistenceAuthorization",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionPersistenceContextV2",
    exported: "AgentRuntimeAuthorizationTransitionPersistenceContext",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionPlanV2",
    exported: "AgentRuntimeAuthorizationTransitionPlan",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionPublicCandidateV2",
    exported: "AgentRuntimeAuthorizationTransitionPublicCandidate",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionSourceLocalV2",
    exported: "AgentRuntimeAuthorizationTransitionSourceLocal",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AgentRuntimeAuthorizationTransitionStorageV2",
    exported: "AgentRuntimeAuthorizationTransitionStorage",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "AtomicAgentRuntimeAuthorizationTransitionCandidateV2",
    exported: "AtomicAgentRuntimeAuthorizationTransitionCandidate",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported: "PreparedAgentRuntimeAuthorizationTransitionSourceV2",
    exported: "PreparedAgentRuntimeAuthorizationTransitionSource",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported:
      "ResolveCurrentAgentRuntimeAuthorizationTransitionEnvelopeV2",
    exported: "ResolveCurrentAgentRuntimeAuthorizationTransitionEnvelope",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported:
      "ResolveCurrentAgentRuntimeAuthorizationTransitionManagerV2",
    exported: "ResolveCurrentAgentRuntimeAuthorizationTransitionManager",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/authorization-transition-v2.ts",
    imported:
      "ResolveCurrentAgentRuntimeAuthorizationTransitionPersistenceV2",
    exported: "ResolveCurrentAgentRuntimeAuthorizationTransitionPersistence",
    typeOnly: true,
  },
  {
    source: "./crypto/index.ts",
    imported: "RecoveryKit",
    exported: "HumanRecoveryKit",
    typeOnly: true,
  },
  {
    source: "./agent-runtime/runtime-rotation-v2.ts",
    imported: "OpaqueAgentRuntimeConfigDekV2",
    exported: "OpaqueAgentRuntimeConfigDek",
    typeOnly: true,
  },
  {
    source: "./recovery/device-transfer-v2.ts",
    imported: "VerifiedRecoveryDeviceReadinessV2",
    exported: "VerifiedRecoveryDeviceReadiness",
    typeOnly: true,
  },
  {
    source: "./storage/v2-adapter-support.ts",
    imported: "storageAdapterSupportV2",
    exported: "storageAdapterSupportV2",
    typeOnly: false,
  },
  {
    source: "./storage/v2-adapter-support.ts",
    imported: "StorageAdapterSupportV2",
    exported: "StorageAdapterSupportV2",
    typeOnly: true,
  },
  {
    source: "./transition/provider-candidate.ts",
    imported: "decodeProviderRosterV2",
    exported: "decodeProviderRosterV2",
    typeOnly: false,
  },
  {
    source: "./transition/provider-candidate.ts",
    imported: "providerPublicTransitionDigestV2",
    exported: "providerPublicTransitionDigestV2",
    typeOnly: false,
  },
  {
    source: "./transition/provider-candidate.ts",
    imported: "ProviderRosterEntryV2",
    exported: "ProviderRosterEntryV2",
    typeOnly: true,
  },
  {
    source: "./transition/provider-candidate.ts",
    imported: "redactProviderWelcomeV2",
    exported: "redactProviderWelcomeV2",
    typeOnly: false,
  },
  {
    source: "./transition/provider-candidate.ts",
    imported: "validateProviderPublicTransitionV2",
    exported: "validateProviderPublicTransitionV2",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest.ts",
    imported: "decodeObjectAccessManifestV2OrV3",
    exported: "decodeObjectAccessManifestV2OrV3",
    typeOnly: false,
  },
  {
    source: "./format/object-access-manifest.ts",
    imported: "ObjectAccessManifestV2OrV3",
    exported: "ObjectAccessManifestV2OrV3",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1",
    exported: "BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1",
    exported: "BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1",
    exported: "MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "backgroundWorkDescriptorDigestV1",
    exported: "backgroundWorkDescriptorDigestV1",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "decodeBackgroundWorkDescriptorV1",
    exported: "decodeBackgroundWorkDescriptorV1",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "encodeBackgroundWorkDescriptorV1",
    exported: "encodeBackgroundWorkDescriptorV1",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundAgentSubjectV1",
    exported: "BackgroundAgentSubjectV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundJournalRangeSourceV1",
    exported: "BackgroundJournalRangeSourceV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundOutputObjectMetadataV1",
    exported: "BackgroundOutputObjectMetadataV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundProcessorSubjectV1",
    exported: "BackgroundProcessorSubjectV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundSyntheticPayloadSourceV1",
    exported: "BackgroundSyntheticPayloadSourceV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundWorkDescriptorV1",
    exported: "BackgroundWorkDescriptorV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundWorkKindV1",
    exported: "BackgroundWorkKindV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundWorkOperationV1",
    exported: "BackgroundWorkOperationV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundWorkPurposeV1",
    exported: "BackgroundWorkPurposeV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundWorkSourceV1",
    exported: "BackgroundWorkSourceV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v1.ts",
    imported: "BackgroundWorkSubjectV1",
    exported: "BackgroundWorkSubjectV1",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2",
    exported: "BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2",
    exported: "BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2",
    exported: "MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2",
    exported: "MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "backgroundWorkDescriptorDigestV2",
    exported: "backgroundWorkDescriptorDigestV2",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "decodeBackgroundAgentWorkDescriptorV2",
    exported: "decodeBackgroundAgentWorkDescriptorV2",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "encodeBackgroundWorkDescriptorV2",
    exported: "encodeBackgroundWorkDescriptorV2",
    typeOnly: false,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundAgentSubjectV2",
    exported: "BackgroundAgentSubjectV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMemoryAccessKindV2",
    exported: "BackgroundProtectedMemoryAccessKindV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMemoryInputRevisionV2",
    exported: "BackgroundProtectedMemoryInputRevisionV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMemoryOutputRevisionV2",
    exported: "BackgroundProtectedMemoryOutputRevisionV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMemoryProductAuthorityV2",
    exported: "BackgroundProtectedMemoryProductAuthorityV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMemoryProductInputRevisionV2",
    exported: "BackgroundProtectedMemoryProductInputRevisionV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMemoryTierMutationV2",
    exported: "BackgroundProtectedMemoryTierMutationV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMemoryWorkSourceV2",
    exported: "BackgroundProtectedMemoryWorkSourceV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundProtectedMessageInputRevisionV2",
    exported: "BackgroundProtectedMessageInputRevisionV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundDomainRequirementV2",
    exported: "BackgroundDomainRequirementV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundInputObjectBindingV2",
    exported: "BackgroundInputObjectBindingV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundNamespaceRequirementV2",
    exported: "BackgroundNamespaceRequirementV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundOutputObjectSlotV2",
    exported: "BackgroundOutputObjectSlotV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundSyntheticPayloadSourceV2",
    exported: "BackgroundSyntheticPayloadSourceV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundAgentWorkDescriptorV2",
    exported: "BackgroundAgentWorkDescriptorV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundWorkKindV2",
    exported: "BackgroundWorkKindV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundWorkOperationV2",
    exported: "BackgroundWorkOperationV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundWorkPurposeV2",
    exported: "BackgroundWorkPurposeV2",
    typeOnly: true,
  },
  {
    source: "./background/work-descriptor-v2.ts",
    imported: "BackgroundWorkSourceV2",
    exported: "BackgroundWorkSourceV2",
    typeOnly: true,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "PROCESSOR_OBJECT_SIGNER_DOMAIN_V1",
    exported: "PROCESSOR_OBJECT_SIGNER_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "PROCESSOR_OBJECT_SIGNER_FORMAT_VERSION_V1",
    exported: "PROCESSOR_OBJECT_SIGNER_FORMAT_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1",
    exported: "PROCESSOR_OBJECT_SIGNER_KEY_ID_PREFIX_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "createProcessorObjectSignerPublicV1",
    exported: "createProcessorObjectSignerPublicV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "normalizeProcessorObjectSignerPrincipalV1",
    exported: "normalizeProcessorObjectSignerPrincipalV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "processorObjectSignerKeyIdV1",
    exported: "processorObjectSignerKeyIdV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "processorObjectSignerSigningBytesV1",
    exported: "processorObjectSignerSigningBytesV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "signProcessorObjectBytesV1",
    exported: "signProcessorObjectBytesV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "verifyProcessorObjectBytesV1",
    exported: "verifyProcessorObjectBytesV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "ProcessorObjectSignerPrincipalV1",
    exported: "ProcessorObjectSignerPrincipalV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-object-signer-v1.ts",
    imported: "ProcessorObjectSignerPublicV1",
    exported: "ProcessorObjectSignerPublicV1",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V1",
    exported: "AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V1",
    exported: "AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V1",
    exported: "AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V1",
    exported: "MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "agentBackgroundGrantResponseSigningBytesV1",
    exported: "agentBackgroundGrantResponseSigningBytesV1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "createAgentBackgroundGrantResponseV1",
    exported: "createAgentBackgroundGrantResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "decodeAgentBackgroundGrantResponseV1",
    exported: "decodeAgentBackgroundGrantResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "encodeAgentBackgroundGrantResponseV1",
    exported: "encodeAgentBackgroundGrantResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "verifyCurrentAgentBackgroundGrantResponseV1",
    exported: "verifyCurrentAgentBackgroundGrantResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "verifyHistoricalAgentBackgroundGrantResponseV1",
    exported: "verifyHistoricalAgentBackgroundGrantResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "AgentBackgroundGrantIssuerContextV1",
    exported: "AgentBackgroundGrantIssuerContextV1",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "AgentBackgroundGrantResponseUnsignedV1",
    exported: "AgentBackgroundGrantResponseUnsignedV1",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "AgentBackgroundGrantResponseV1",
    exported: "AgentBackgroundGrantResponseV1",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "CreatedAgentBackgroundGrantResponseV1",
    exported: "CreatedAgentBackgroundGrantResponseV1",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "ResolveAgentBackgroundGrantIssuerPublicKeyV1",
    exported: "ResolveAgentBackgroundGrantIssuerPublicKeyV1",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v1.ts",
    imported: "VerifiedAgentBackgroundGrantResponseV1",
    exported: "VerifiedAgentBackgroundGrantResponseV1",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2",
    exported: "AGENT_BACKGROUND_GRANT_RESPONSE_DOMAIN_V2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2",
    exported: "AGENT_BACKGROUND_GRANT_RESPONSE_FORMAT_VERSION_V2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V2",
    exported: "AGENT_BACKGROUND_GRANT_RESPONSE_MAX_TTL_MS_V2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2",
    exported: "MAX_AGENT_BACKGROUND_GRANT_RESPONSE_WIRE_BYTES_V2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "agentBackgroundGrantResponseSigningBytesV2",
    exported: "agentBackgroundGrantResponseSigningBytesV2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "assertBoundAgentGrantV2",
    exported: "assertBoundAgentGrantV2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "createAgentBackgroundGrantResponseV2",
    exported: "createAgentBackgroundGrantResponseV2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "decodeAgentBackgroundGrantResponseV2",
    exported: "decodeAgentBackgroundGrantResponseV2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "encodeAgentBackgroundGrantResponseV2",
    exported: "encodeAgentBackgroundGrantResponseV2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "verifyCurrentAgentBackgroundGrantResponseV2",
    exported: "verifyCurrentAgentBackgroundGrantResponseV2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "verifyHistoricalAgentBackgroundGrantResponseV2",
    exported: "verifyHistoricalAgentBackgroundGrantResponseV2",
    typeOnly: false,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "AgentBackgroundGrantIssuerContextV2",
    exported: "AgentBackgroundGrantIssuerContextV2",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "AgentBackgroundGrantResponseUnsignedV2",
    exported: "AgentBackgroundGrantResponseUnsignedV2",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "AgentBackgroundGrantResponseV2",
    exported: "AgentBackgroundGrantResponseV2",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "CreatedAgentBackgroundGrantResponseV2",
    exported: "CreatedAgentBackgroundGrantResponseV2",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "ResolveAgentBackgroundGrantIssuerPublicKeyV2",
    exported: "ResolveAgentBackgroundGrantIssuerPublicKeyV2",
    typeOnly: true,
  },
  {
    source: "./background/agent-background-grant-response-v2.ts",
    imported: "VerifiedAgentBackgroundGrantResponseV2",
    exported: "VerifiedAgentBackgroundGrantResponseV2",
    typeOnly: true,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1",
    exported: "BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1",
    exported: "BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1",
    exported: "BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1",
    exported: "MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "backgroundAuthorizationResponseSigningBytesV1",
    exported: "backgroundAuthorizationResponseSigningBytesV1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "createBackgroundAuthorizationResponseV1",
    exported: "createBackgroundAuthorizationResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "decodeBackgroundAuthorizationResponseV1",
    exported: "decodeBackgroundAuthorizationResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "encodeBackgroundAuthorizationResponseV1",
    exported: "encodeBackgroundAuthorizationResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "verifyCurrentBackgroundAuthorizationResponseV1",
    exported: "verifyCurrentBackgroundAuthorizationResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "verifyHistoricalBackgroundAuthorizationResponseV1",
    exported: "verifyHistoricalBackgroundAuthorizationResponseV1",
    typeOnly: false,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "BackgroundAuthorizationResponseIssuerContextV1",
    exported: "BackgroundAuthorizationResponseIssuerContextV1",
    typeOnly: true,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "BackgroundAuthorizationResponseUnsignedV1",
    exported: "BackgroundAuthorizationResponseUnsignedV1",
    typeOnly: true,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "BackgroundAuthorizationResponseV1",
    exported: "BackgroundAuthorizationResponseV1",
    typeOnly: true,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "CreatedBackgroundAuthorizationResponseV1",
    exported: "CreatedBackgroundAuthorizationResponseV1",
    typeOnly: true,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "ResolveBackgroundAuthorizationResponseIssuerPublicKeyV1",
    exported: "ResolveBackgroundAuthorizationResponseIssuerPublicKeyV1",
    typeOnly: true,
  },
  {
    source: "./background/background-authorization-response-v1.ts",
    imported: "VerifiedBackgroundAuthorizationResponseV1",
    exported: "VerifiedBackgroundAuthorizationResponseV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1",
    exported: "MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "PROCESSOR_CREDENTIAL_DOMAIN_V1",
    exported: "PROCESSOR_CREDENTIAL_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1",
    exported: "PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1",
    exported: "PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1",
    exported: "PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "createProcessorCredentialV1",
    exported: "createProcessorCredentialV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "decodeProcessorCredentialV1",
    exported: "decodeProcessorCredentialV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "encodeProcessorCredentialV1",
    exported: "encodeProcessorCredentialV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "processorCredentialSigningBytesV1",
    exported: "processorCredentialSigningBytesV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "verifyProcessorCredentialV1",
    exported: "verifyProcessorCredentialV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "CreatedProcessorCredentialV1",
    exported: "CreatedProcessorCredentialV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "ProcessorCredentialIssuerAuthorityContextV1",
    exported: "ProcessorCredentialIssuerAuthorityContextV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "ProcessorCredentialUnsignedV1",
    exported: "ProcessorCredentialUnsignedV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "ProcessorCredentialV1",
    exported: "ProcessorCredentialV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "ResolveCurrentProcessorCredentialIssuerPublicKeyV1",
    exported: "ResolveCurrentProcessorCredentialIssuerPublicKeyV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-credential-v1.ts",
    imported: "VerifiedProcessorCredentialV1",
    exported: "VerifiedProcessorCredentialV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1",
    exported: "MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1",
    exported: "PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1",
    exported: "PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "PROCESSOR_SIGNER_AUTHORIZATION_MAX_TTL_MS_V1",
    exported: "PROCESSOR_SIGNER_AUTHORIZATION_MAX_TTL_MS_V1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "createProcessorSignerAuthorizationV1",
    exported: "createProcessorSignerAuthorizationV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "decodeProcessorSignerAuthorizationV1",
    exported: "decodeProcessorSignerAuthorizationV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "encodeProcessorSignerAuthorizationV1",
    exported: "encodeProcessorSignerAuthorizationV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "processorSignerAuthorizationSigningBytesV1",
    exported: "processorSignerAuthorizationSigningBytesV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported:
      "verifyCurrentProcessorSignerAuthorizationForCredentialV1",
    exported:
      "verifyCurrentProcessorSignerAuthorizationForCredentialV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "verifyCurrentProcessorSignerAuthorizationV1",
    exported: "verifyCurrentProcessorSignerAuthorizationV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "verifyHistoricalProcessorSignerAuthorizationV1",
    exported: "verifyHistoricalProcessorSignerAuthorizationV1",
    typeOnly: false,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "CreatedProcessorSignerAuthorizationV1",
    exported: "CreatedProcessorSignerAuthorizationV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "ProcessorSignerAuthorizationAuthorityContextV1",
    exported: "ProcessorSignerAuthorizationAuthorityContextV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "ProcessorSignerAuthorizationUnsignedV1",
    exported: "ProcessorSignerAuthorizationUnsignedV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "ProcessorSignerAuthorizationV1",
    exported: "ProcessorSignerAuthorizationV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1",
    exported: "ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "ResolveHistoricalProcessorSignerIssuingDevicePublicKeyV1",
    exported: "ResolveHistoricalProcessorSignerIssuingDevicePublicKeyV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "VerifiedProcessorSignerAuthorizationForCredentialV1",
    exported: "VerifiedProcessorSignerAuthorizationForCredentialV1",
    typeOnly: true,
  },
  {
    source: "./background/processor-signer-authorization-v1.ts",
    imported: "VerifiedProcessorSignerAuthorizationV1",
    exported: "VerifiedProcessorSignerAuthorizationV1",
    typeOnly: true,
  },
  {
    source: "./object/human-access-manifest-set-v1.ts",
    imported: "assertAuthenticPreparedHumanObjectAccessManifestUpdateSetV1",
    exported: "assertAuthenticPreparedHumanObjectAccessManifestUpdateSet",
    typeOnly: false,
  },
  {
    source: "./object/human-access-manifest-set-v1.ts",
    imported: "prepareHumanObjectAccessManifestUpdateSetV1",
    exported: "prepareHumanObjectAccessManifestUpdateSet",
    typeOnly: false,
  },
  {
    source: "./object/human-access-manifest-set-v1.ts",
    imported: "HumanObjectAccessEnvelopeContextV1",
    exported: "HumanObjectAccessEnvelopeContext",
    typeOnly: true,
  },
  {
    source: "./object/human-access-manifest-set-v1.ts",
    imported: "HumanObjectAccessNamespaceBindingV1",
    exported: "HumanObjectAccessNamespaceBinding",
    typeOnly: true,
  },
  {
    source: "./object/human-access-manifest-set-v1.ts",
    imported: "HumanObjectAccessUpdateAuthorityContextV1",
    exported: "HumanObjectAccessUpdateAuthorityContext",
    typeOnly: true,
  },
  {
    source: "./object/human-access-manifest-set-v1.ts",
    imported: "PreparedHumanObjectAccessManifestUpdateSetV1",
    exported: "PreparedHumanObjectAccessManifestUpdateSet",
    typeOnly: true,
  },
  {
    source: "./object/human-access-manifest-set-v1.ts",
    imported: "PrepareHumanObjectAccessManifestUpdateSetInputV1",
    exported: "PrepareHumanObjectAccessManifestUpdateSetInput",
    typeOnly: true,
  },
  {
    source: "./memory/exact-access-request-v1.ts",
    imported: "prepareHumanMemoryExactAccessRequestV2",
    exported: "prepareHumanMemoryExactAccessRequest",
    typeOnly: false,
  },
  {
    source: "./memory/exact-access-request-v1.ts",
    imported: "verifyHumanMemoryExactAccessRequestV2",
    exported: "verifyHumanMemoryExactAccessRequest",
    typeOnly: false,
  },
  ...[
    ["CreatedHumanMemoryExactAccessRequestV2", "CreatedHumanMemoryExactAccessRequest"],
    ["HumanMemoryExactAccessAuthorityContextV2", "HumanMemoryExactAccessAuthorityContext"],
    ["HumanMemoryExactAccessRequestEntryV2", "HumanMemoryExactAccessRequestEntry"],
    ["HumanMemoryExactAccessRequestV2", "HumanMemoryExactAccessRequest"],
    ["PrepareHumanMemoryExactAccessRequestInputV2", "PrepareHumanMemoryExactAccessRequestInput"],
    ["ResolveCurrentHumanMemoryExactAccessAuthorityV2", "ResolveCurrentHumanMemoryExactAccessAuthority"],
  ].map(([imported, exported]) => ({
    source: "./memory/exact-access-request-v1.ts",
    imported: imported!,
    exported: exported!,
    typeOnly: true,
  })),
  ...[
    "HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2",
    "HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2",
    "HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2",
    "HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2",
    "HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2",
    "MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2",
    "decodeHumanMemoryExactAccessRequestV2",
    "encodeHumanMemoryExactAccessRequestV2",
    "humanMemoryExactAccessRequestSigningBytesV2",
  ].map((name) => ({
    source: "./memory/exact-access-request-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...[
    "HumanMemoryExactAccessRequestUnsignedV2",
  ].map((name) => ({
    source: "./memory/exact-access-request-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...[
    ["humanLiveShadowMessageRequestDigestV1", "humanLiveShadowMessageRequestDigest"],
    ["liveShadowMessagePlanDigestV1", "liveShadowMessagePlanDigest"],
    ["prepareHumanLiveShadowMessageRequestV1", "prepareHumanLiveShadowMessageRequest"],
    ["verifyHumanLiveShadowMessageRequestV1", "verifyHumanLiveShadowMessageRequest"],
    [
      "verifyHumanLiveShadowMessageRequestExactReplayV1",
      "verifyHumanLiveShadowMessageRequestExactReplay",
    ],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-message-request-v1.ts",
    imported: imported!,
    exported: exported!,
    typeOnly: false,
  })),
  ...[
    ["CreatedHumanLiveShadowMessageRequestV1", "CreatedHumanLiveShadowMessageRequest"],
    ["HumanLiveShadowMessageRequestV1", "HumanLiveShadowMessageRequest"],
    ["LiveShadowMessagePlanV1", "LiveShadowMessagePlan"],
    [
      "PrepareHumanLiveShadowMessageRequestInputV1",
      "PrepareHumanLiveShadowMessageRequestInput",
    ],
    [
      "ResolveCurrentHumanLiveShadowMessageAuthorityV1",
      "ResolveCurrentHumanLiveShadowMessageAuthority",
    ],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-message-request-v1.ts",
    imported: imported!,
    exported: exported!,
    typeOnly: true,
  })),
  ...[
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V1",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V1",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V1",
    "LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V1",
    "LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V1",
    "LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V1",
    "LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V1",
    "LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V1",
    "MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V1",
    "MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V1",
    "decodeHumanLiveShadowMessageRequestV1",
    "decodeLiveShadowMessagePlanV1",
    "encodeHumanLiveShadowMessageRequestV1",
    "encodeLiveShadowMessagePlanV1",
    "humanLiveShadowMessageRequestSigningBytesV1",
  ].map((name) => ({
    source: "./message/live-shadow-message-request-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  {
    source: "./message/live-shadow-message-request-v1.ts",
    imported: "HumanLiveShadowMessageRequestUnsignedV1",
    exported: "HumanLiveShadowMessageRequestUnsignedV1",
    typeOnly: true,
  },
  ...[
    [
      "humanLiveShadowMessageRequestDigestV2",
      "deviceWrappedHumanLiveShadowMessageRequestDigest",
    ],
    ["liveShadowMessagePlanDigestV2", "deviceWrappedLiveShadowMessagePlanDigest"],
    [
      "prepareHumanLiveShadowMessageRequestV2",
      "prepareDeviceWrappedHumanLiveShadowMessageRequest",
    ],
    [
      "verifyHumanLiveShadowMessageRequestV2",
      "verifyDeviceWrappedHumanLiveShadowMessageRequest",
    ],
    [
      "verifyHumanLiveShadowMessageRequestExactReplayV2",
      "verifyDeviceWrappedHumanLiveShadowMessageRequestExactReplay",
    ],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-message-request-v2.ts",
    imported: imported!,
    exported: exported!,
    typeOnly: false,
  })),
  ...[
    [
      "CreatedHumanLiveShadowMessageRequestV2",
      "CreatedDeviceWrappedHumanLiveShadowMessageRequest",
    ],
    [
      "HumanLiveShadowMessageRequestV2",
      "DeviceWrappedHumanLiveShadowMessageRequest",
    ],
    ["LiveShadowMessagePlanV2", "DeviceWrappedLiveShadowMessagePlan"],
    [
      "PrepareHumanLiveShadowMessageRequestInputV2",
      "PrepareDeviceWrappedHumanLiveShadowMessageRequestInput",
    ],
    [
      "ResolveCurrentHumanLiveShadowMessageAuthorityV2",
      "ResolveCurrentDeviceWrappedHumanLiveShadowMessageAuthority",
    ],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-message-request-v2.ts",
    imported: imported!,
    exported: exported!,
    typeOnly: true,
  })),
  ...[
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V2",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V2",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V2",
    "LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V2",
    "LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V2",
    "LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V2",
    "LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V2",
    "LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V2",
    "MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V2",
    "MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V2",
    "decodeHumanLiveShadowMessageRequestV2",
    "decodeLiveShadowMessagePlanV2",
    "encodeHumanLiveShadowMessageRequestV2",
    "encodeLiveShadowMessagePlanV2",
    "humanLiveShadowMessageRequestSigningBytesV2",
  ].map((name) => ({
    source: "./message/live-shadow-message-request-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  {
    source: "./message/live-shadow-message-request-v2.ts",
    imported: "HumanLiveShadowMessageRequestUnsignedV2",
    exported: "HumanLiveShadowMessageRequestUnsignedV2",
    typeOnly: true,
  },
  ...[
    ["openAgentLiveShadowStreamFrameV1", "openAgentLiveShadowStreamFrame"],
    ["prepareAgentLiveShadowStreamStartV1", "prepareAgentLiveShadowStreamStart"],
    ["sealAgentLiveShadowStreamFrameV1", "sealAgentLiveShadowStreamFrame"],
    ["verifyAgentLiveShadowStreamStartV1", "verifyAgentLiveShadowStreamStart"],
    ["verifyAgentLiveShadowStreamTerminalV1", "verifyAgentLiveShadowStreamTerminal"],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-stream-v1.ts",
    imported: imported!, exported: exported!, typeOnly: false,
  })),
  ...[
    ["AgentLiveShadowStreamFrameV1", "AgentLiveShadowStreamFrame"],
    ["AgentLiveShadowStreamStartV1", "AgentLiveShadowStreamStart"],
    ["CreatedAgentLiveShadowStreamStartV1", "CreatedAgentLiveShadowStreamStart"],
    ["ResolveAgentLiveShadowStreamSignerV1", "ResolveAgentLiveShadowStreamSigner"],
    ["SealAgentLiveShadowStreamFrameInputV1", "SealAgentLiveShadowStreamFrameInput"],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-stream-v1.ts",
    imported: imported!, exported: exported!, typeOnly: true,
  })),
  ...[
    "AGENT_LIVE_SHADOW_STREAM_FRAME_DOMAIN_V1",
    "AGENT_LIVE_SHADOW_STREAM_FRAME_FORMAT_VERSION_V1",
    "AGENT_LIVE_SHADOW_STREAM_FRAME_PURPOSE_V1",
    "AGENT_LIVE_SHADOW_STREAM_KEY_DOMAIN_V1",
    "AGENT_LIVE_SHADOW_STREAM_MAX_FRAMES_V1",
    "AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1",
    "AGENT_LIVE_SHADOW_STREAM_MAX_PLAINTEXT_BYTES_V1",
    "AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V1",
    "AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V1",
    "AGENT_LIVE_SHADOW_STREAM_START_FORMAT_VERSION_V1",
    "AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V1",
    "MAX_AGENT_LIVE_SHADOW_STREAM_FRAME_WIRE_BYTES_V1",
    "MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V1",
    "agentLiveShadowStreamStartSigningBytesV1",
    "decodeAgentLiveShadowStreamFrameV1",
    "decodeAgentLiveShadowStreamStartV1",
    "encodeAgentLiveShadowStreamFrameV1",
    "encodeAgentLiveShadowStreamStartV1",
  ].map((name) => ({
    source: "./message/live-shadow-stream-v1.ts",
    imported: name, exported: name, typeOnly: false,
  })),
  {
    source: "./message/live-shadow-stream-v1.ts",
    imported: "AgentLiveShadowStreamStartUnsignedV1",
    exported: "AgentLiveShadowStreamStartUnsignedV1",
    typeOnly: true,
  },
  ...[
    [
      "openAgentLiveShadowStreamFrameV2",
      "openDeviceWrappedAgentLiveShadowStreamFrame",
    ],
    [
      "prepareAgentLiveShadowStreamStartV2",
      "prepareDeviceWrappedAgentLiveShadowStreamStart",
    ],
    [
      "sealAgentLiveShadowStreamFrameV2",
      "sealDeviceWrappedAgentLiveShadowStreamFrame",
    ],
    [
      "verifyAgentLiveShadowStreamStartV2",
      "verifyDeviceWrappedAgentLiveShadowStreamStart",
    ],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-stream-v2.ts",
    imported: imported!,
    exported: exported!,
    typeOnly: false,
  })),
  ...[
    [
      "AgentLiveShadowStreamStartV2",
      "DeviceWrappedAgentLiveShadowStreamStart",
    ],
    [
      "CreatedAgentLiveShadowStreamStartV2",
      "CreatedDeviceWrappedAgentLiveShadowStreamStart",
    ],
    [
      "ResolveAgentLiveShadowStreamSignerV2",
      "ResolveDeviceWrappedAgentLiveShadowStreamSigner",
    ],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-stream-v2.ts",
    imported: imported!,
    exported: exported!,
    typeOnly: true,
  })),
  ...[
    "AGENT_LIVE_SHADOW_STREAM_KEY_DOMAIN_V2",
    "AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V2",
    "AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V2",
    "AGENT_LIVE_SHADOW_STREAM_START_FORMAT_VERSION_V2",
    "AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V2",
    "MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V2",
    "agentLiveShadowStreamStartSigningBytesV2",
    "decodeAgentLiveShadowStreamStartV2",
    "encodeAgentLiveShadowStreamStartV2",
  ].map((name) => ({
    source: "./message/live-shadow-stream-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  {
    source: "./message/live-shadow-stream-v2.ts",
    imported: "AgentLiveShadowStreamStartUnsignedV2",
    exported: "AgentLiveShadowStreamStartUnsignedV2",
    typeOnly: true,
  },
  ...[
    ["humanLiveShadowClientVerificationDigestV1", "humanLiveShadowClientVerificationDigest"],
    ["prepareHumanLiveShadowClientVerificationV1", "prepareHumanLiveShadowClientVerification"],
    ["verifyHumanLiveShadowClientVerificationV1", "verifyHumanLiveShadowClientVerification"],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-client-verification-v1.ts",
    imported: imported!, exported: exported!, typeOnly: false,
  })),
  ...[
    ["CreatedHumanLiveShadowClientVerificationV1", "CreatedHumanLiveShadowClientVerification"],
    ["HumanLiveShadowClientVerificationReasonV1", "HumanLiveShadowClientVerificationReason"],
    ["HumanLiveShadowClientVerificationStageV1", "HumanLiveShadowClientVerificationStage"],
    ["HumanLiveShadowClientVerificationStatusV1", "HumanLiveShadowClientVerificationStatus"],
    ["HumanLiveShadowClientVerificationV1", "HumanLiveShadowClientVerification"],
    ["HumanLiveShadowStreamTerminalVerificationEntryV1", "HumanLiveShadowStreamTerminalVerificationEntry"],
    ["HumanLiveShadowTranscriptVerificationEntryV1", "HumanLiveShadowTranscriptVerificationEntry"],
    [
      "ResolveCurrentHumanLiveShadowClientVerificationAuthorityV1",
      "ResolveCurrentHumanLiveShadowClientVerificationAuthority",
    ],
  ].map(([imported, exported]) => ({
    source: "./message/live-shadow-client-verification-v1.ts",
    imported: imported!, exported: exported!, typeOnly: true,
  })),
  ...[
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_DOMAIN_V1",
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_FORMAT_VERSION_V1",
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_ENTRIES_V1",
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_TTL_MS_V1",
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_PURPOSE_V1",
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_REASONS_V1",
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STAGES_V1",
    "HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STATUSES_V1",
    "MAX_HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_WIRE_BYTES_V1",
    "decodeHumanLiveShadowClientVerificationV1",
    "encodeHumanLiveShadowClientVerificationV1",
    "humanLiveShadowClientVerificationSigningBytesV1",
  ].map((name) => ({
    source: "./message/live-shadow-client-verification-v1.ts",
    imported: name, exported: name, typeOnly: false,
  })),
  {
    source: "./message/live-shadow-client-verification-v1.ts",
    imported: "HumanLiveShadowClientVerificationUnsignedV1",
    exported: "HumanLiveShadowClientVerificationUnsignedV1",
    typeOnly: true,
  },
  ...([
    ["namespaceGenerationAudienceFingerprintV1", "fingerprintNamespaceGenerationAudience"],
    ["openNamespaceGenerationPublicationSetV1", "openNamespaceGenerationPublicationSet"],
    ["openNamespaceGenerationPublicationSetExactReplayV1", "openNamespaceGenerationPublicationSetExactReplay"],
    ["prepareNamespaceGenerationPublicationSetV1", "prepareNamespaceGenerationPublicationSet"],
    ["withVerifiedNamespaceGenerationPublicationSetV1", "withVerifiedNamespaceGenerationPublicationSet"],
    ["withVerifiedNamespaceGenerationPublicationSetExactReplayV1", "withVerifiedNamespaceGenerationPublicationSetExactReplay"],
  ] as const).map(([imported, exported]) => ({
    source: "./format/namespace-generation-v1.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  ...([
    ["OpenedNamespaceGenerationPublicationSetV1", "OpenedNamespaceGenerationPublicationSet"],
    ["OpenNamespaceGenerationPublicationSetInputV1", "OpenNamespaceGenerationPublicationSetInput"],
    ["OpenNamespaceGenerationPublicationSetExactReplayInputV1", "OpenNamespaceGenerationPublicationSetExactReplayInput"],
    ["PreparedNamespaceGenerationPublicationSetV1", "PreparedNamespaceGenerationPublicationSet"],
    ["PrepareNamespaceGenerationPublicationSetInputV1", "PrepareNamespaceGenerationPublicationSetInput"],
    ["VerifiedNamespaceGenerationPublicationSetV1", "VerifiedNamespaceGenerationPublicationSet"],
    ["WithVerifiedNamespaceGenerationPublicationSetInputV1", "WithVerifiedNamespaceGenerationPublicationSetInput"],
    ["WithVerifiedNamespaceGenerationPublicationSetExactReplayInputV1", "WithVerifiedNamespaceGenerationPublicationSetExactReplayInput"],
  ] as const).map(([imported, exported]) => ({
    source: "./format/namespace-generation-v1.ts",
    imported,
    exported,
    typeOnly: true,
  })),
  ...([
    ["prepareNamespaceGenerationAcknowledgementV1", "prepareNamespaceGenerationAcknowledgement"],
    ["prepareNamespaceGenerationFetchProofV1", "prepareNamespaceGenerationFetchProof"],
    ["verifyNamespaceGenerationAcknowledgementV1", "verifyNamespaceGenerationAcknowledgement"],
    ["verifyNamespaceGenerationFetchProofV1", "verifyNamespaceGenerationFetchProof"],
  ] as const).map(([imported, exported]) => ({
    source: "./format/namespace-delivery-v1.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  ...([
    ["NamespaceGenerationAcknowledgementV1", "NamespaceGenerationAcknowledgement"],
    ["NamespaceGenerationFetchProofV1", "NamespaceGenerationFetchProof"],
    ["PreparedNamespaceDeliveryRecordV1", "PreparedNamespaceDeliveryRecord"],
  ] as const).map(([imported, exported]) => ({
    source: "./format/namespace-delivery-v1.ts",
    imported,
    exported,
    typeOnly: true,
  })),
  ...([
    ["createNamespaceAgentGrantPlanV1", "createNamespaceAgentGrantPlan"],
    ["mintNamespaceAgentGrantV1", "mintNamespaceAgentGrant"],
    ["withOpenedNamespaceAgentGrantV1", "withOpenedNamespaceAgentGrant"],
  ] as const).map(([imported, exported]) => ({
    source: "./format/namespace-agent-grant-v1.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  ...([
    ["NamespaceAgentGrantAuthorityEntryV1", "NamespaceAgentGrantAuthorityEntry"],
    ["NamespaceAgentGrantCurrentAuthorityV1", "NamespaceAgentGrantCurrentAuthority"],
    ["NamespaceAgentGrantPlanV1", "NamespaceAgentGrantPlan"],
    ["NamespaceAgentGrantRetainedGenerationV1", "NamespaceAgentGrantRetainedGeneration"],
    ["NamespaceAgentGrantSecretEntryV1", "NamespaceAgentGrantSecretEntry"],
    ["NamespaceAgentGrantV1", "NamespaceAgentGrant"],
    ["OpenNamespaceAgentGrantResultV1", "OpenNamespaceAgentGrantResult"],
  ] as const).map(([imported, exported]) => ({
    source: "./format/namespace-agent-grant-v1.ts",
    imported,
    exported,
    typeOnly: true,
  })),
  ...[
    "decodeNamespaceGenerationHeadV1",
    "decodeNamespaceGenerationPublicationSetV1",
    "decodeNamespaceGenerationPublicationV1",
    "decodeNamespaceGenerationReceiptV1",
    "decodeNamespaceGenerationRecipientEnvelopeV1",
    "decodeNamespaceGenerationSecretV1",
    "encodeNamespaceGenerationHeadV1",
    "encodeNamespaceGenerationPublicationSetV1",
    "encodeNamespaceGenerationPublicationV1",
    "encodeNamespaceGenerationReceiptV1",
    "encodeNamespaceGenerationRecipientEnvelopeV1",
    "encodeNamespaceGenerationSecretV1",
    "MAX_NAMESPACE_GENERATION_ENVELOPE_WIRE_BYTES_V1",
    "MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1",
    "MAX_NAMESPACE_GENERATION_SECRET_WIRE_BYTES_V1",
    "NAMESPACE_GENERATION_AUDIENCE_DOMAIN_V1",
    "NAMESPACE_GENERATION_ENVELOPE_DOMAIN_V1",
    "NAMESPACE_GENERATION_FORMAT_VERSION_V1",
    "NAMESPACE_GENERATION_HEAD_DOMAIN_V1",
    "NAMESPACE_GENERATION_MAX_RECIPIENTS_V1",
    "NAMESPACE_GENERATION_MAX_TTL_MS_V1",
    "NAMESPACE_GENERATION_PUBLICATION_DOMAIN_V1",
    "NAMESPACE_GENERATION_PUBLICATION_SET_DOMAIN_V1",
    "NAMESPACE_GENERATION_RECEIPT_DOMAIN_V1",
    "NAMESPACE_GENERATION_SECRET_DOMAIN_V1",
    "namespaceGenerationHeadDigestV1",
    "namespaceGenerationPublicationDigestV1",
    "namespaceGenerationPublicationSetDigestV1",
    "namespaceGenerationPublicationSetSigningBytesV1",
    "namespaceGenerationPublicationSigningBytesV1",
    "namespaceGenerationRecipientSetDigestV1",
    "openNamespaceGenerationEnvelopeV1",
    "prepareNamespaceGenerationPublicationV1",
  ].map((name) => ({
    source: "./format/namespace-generation-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...[
    "OpenedNamespaceGenerationV1",
    "OpenNamespaceGenerationEnvelopeInputV1",
    "PreparedNamespaceGenerationPublicationV1",
    "PrepareNamespaceGenerationPublicationInputV1",
    "PrepareNamespaceGenerationPublicationSetClassV1",
    "NamespaceGenerationHeadV1",
    "NamespaceGenerationPublicationSetEntryV1",
    "NamespaceGenerationPublicationSetV1",
    "NamespaceGenerationPublicationV1",
    "NamespaceGenerationReceiptV1",
    "NamespaceGenerationRecipientEnvelopeV1",
    "NamespaceGenerationRecipientInputV1",
    "NamespaceGenerationRecipientKindV1",
    "NamespaceGenerationRecipientV1",
    "NamespaceGenerationSecretV1",
  ].map((name) => ({
    source: "./format/namespace-generation-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...[
    "decodeNamespaceGenerationAcknowledgementV1",
    "decodeNamespaceGenerationFetchProofV1",
    "encodeNamespaceGenerationAcknowledgementV1",
    "encodeNamespaceGenerationFetchProofV1",
    "MAX_NAMESPACE_DELIVERY_WIRE_BYTES_V1",
    "NAMESPACE_DELIVERY_FORMAT_VERSION_V1",
    "NAMESPACE_DELIVERY_MAX_TTL_MS_V1",
    "NAMESPACE_GENERATION_ACKNOWLEDGEMENT_DOMAIN_V1",
    "NAMESPACE_GENERATION_FETCH_PROOF_DOMAIN_V1",
    "namespaceGenerationAcknowledgementSigningBytesV1",
    "namespaceGenerationFetchProofSigningBytesV1",
  ].map((name) => ({
    source: "./format/namespace-delivery-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...[
    "NamespaceGenerationAcknowledgementUnsignedV1",
    "NamespaceGenerationFetchProofUnsignedV1",
  ].map((name) => ({
    source: "./format/namespace-delivery-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...[
    "destroyNamespaceAgentGrantPlanV1",
    "destroyNamespaceAgentGrantSecretV1",
    "destroyNamespaceAgentGrantV1",
    "NAMESPACE_AGENT_GRANT_V1_FORMAT_VERSION",
    "NAMESPACE_AGENT_GRANT_V1_MAX_NAMESPACES",
    "NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_BYTES",
    "NAMESPACE_AGENT_GRANT_V1_MAX_SECRET_ENTRIES",
    "NAMESPACE_AGENT_GRANT_V1_MAX_TTL_MS",
    "NAMESPACE_AGENT_GRANT_V1_MAX_WIRE_BYTES",
    "NAMESPACE_AGENT_GRANT_V1_PLAN_PURPOSE",
    "NAMESPACE_AGENT_GRANT_V1_PURPOSE",
    "NAMESPACE_AGENT_GRANT_V1_SCHEME",
    "NAMESPACE_AGENT_GRANT_V1_SECRET_PURPOSE",
    "namespaceAgentGrantAuthoritySetDigestV1",
    "namespaceAgentGrantSigningBytesV1",
    "parseNamespaceAgentGrantPlanV1",
    "parseNamespaceAgentGrantSecretV1",
    "parseNamespaceAgentGrantV1",
    "serializeNamespaceAgentGrantPlanV1",
    "serializeNamespaceAgentGrantSecretV1",
    "serializeNamespaceAgentGrantV1",
  ].map((name) => ({
    source: "./format/namespace-agent-grant-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...[
    "NamespaceAgentGrantOperationV1",
    "NamespaceAgentGrantSecretV1",
  ].map((name) => ({
    source: "./format/namespace-agent-grant-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    ["humanHistoryReadResultSetDigestV1", "humanHistoryReadResultSetDigest", false],
    ["humanHistoryReadSelectedCoordinateDigestV1", "humanHistoryReadSelectedCoordinateDigest", false],
    ["prepareHumanHistoryReadAcknowledgementV1", "prepareHumanHistoryReadAcknowledgement", false],
    ["verifyHumanHistoryReadAcknowledgementV1", "verifyHumanHistoryReadAcknowledgement", false],
    ["CreatedHumanHistoryReadAcknowledgementV1", "CreatedHumanHistoryReadAcknowledgement", true],
    ["HumanHistoryReadAcknowledgementV1", "HumanHistoryReadAcknowledgement", true],
    ["HumanHistoryReadResultCountsV1", "HumanHistoryReadResultCounts", true],
    ["HumanHistoryReadResultDigestEntryV1", "HumanHistoryReadResultDigestEntry", true],
    ["HumanHistoryReadResultOutcomeV1", "HumanHistoryReadResultOutcome", true],
    ["HumanHistoryReadResultReasonV1", "HumanHistoryReadResultReason", true],
    ["HumanHistoryReadSelectedCoordinateV1", "HumanHistoryReadSelectedCoordinate", true],
    ["ResolvePlannedHumanHistoryReadAuthorityV1", "ResolvePlannedHumanHistoryReadAuthority", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./message/history-read-acknowledgement-v1.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_DOMAIN_V1",
    "HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_FORMAT_VERSION_V1",
    "HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1",
    "HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1",
    "HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_PURPOSE_V1",
    "HUMAN_HISTORY_READ_RESULT_OUTCOMES_V1",
    "HUMAN_HISTORY_READ_RESULT_REASONS_V1",
    "MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1",
    "decodeHumanHistoryReadAcknowledgementV1",
    "encodeHumanHistoryReadAcknowledgementV1",
    "humanHistoryReadAcknowledgementSigningBytesV1",
  ] as const).map((name) => ({
    source: "./message/history-read-acknowledgement-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  {
    source: "./message/history-read-acknowledgement-v1.ts",
    imported: "HumanHistoryReadAcknowledgementUnsignedV1",
    exported: "HumanHistoryReadAcknowledgementUnsignedV1",
    typeOnly: true,
  },
  ...([
    ["createDeviceWrappedDomainAgentForegroundAuthorizationPlanV1", "createDeviceWrappedDomainAgentForegroundAuthorizationPlan", false],
    ["mintDeviceWrappedDomainAgentForegroundAuthorizationV1", "mintDeviceWrappedDomainAgentForegroundAuthorization", false],
    ["withOpenedDeviceWrappedDomainAgentForegroundAuthorizationV1", "withOpenedDeviceWrappedDomainAgentForegroundAuthorization", false],
    ["DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntryV1", "DeviceWrappedDomainAgentForegroundAuthorizationAuthorityEntry", true],
    ["DeviceWrappedDomainAgentForegroundAuthorizationCurrentAuthorityV1", "DeviceWrappedDomainAgentForegroundAuthorizationCurrentAuthority", true],
    ["DeviceWrappedDomainAgentForegroundAuthorizationPlanV1", "DeviceWrappedDomainAgentForegroundAuthorizationPlan", true],
    ["DeviceWrappedDomainAgentForegroundAuthorizationSecretEntryV1", "DeviceWrappedDomainAgentForegroundAuthorizationSecretEntry", true],
    ["DeviceWrappedDomainAgentForegroundAuthorizationV1", "DeviceWrappedDomainAgentForegroundAuthorization", true],
    ["OpenDeviceWrappedDomainAgentForegroundAuthorizationResultV1", "OpenDeviceWrappedDomainAgentForegroundAuthorizationResult", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/device-wrapped-domain-agent-foreground-authorization-v1.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_PURPOSE",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SCHEME",
    "DEVICE_WRAPPED_DOMAIN_AGENT_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE",
    "destroyDeviceWrappedDomainAgentForegroundAuthorizationPlanV1",
    "destroyDeviceWrappedDomainAgentForegroundAuthorizationSecretV1",
    "destroyDeviceWrappedDomainAgentForegroundAuthorizationV1",
    "parseDeviceWrappedDomainAgentForegroundAuthorizationPlanV1",
    "parseDeviceWrappedDomainAgentForegroundAuthorizationSecretV1",
    "parseDeviceWrappedDomainAgentForegroundAuthorizationV1",
    "serializeDeviceWrappedDomainAgentForegroundAuthorizationPlanV1",
    "serializeDeviceWrappedDomainAgentForegroundAuthorizationSecretV1",
    "serializeDeviceWrappedDomainAgentForegroundAuthorizationV1",
  ] as const).map((name) => ({
    source: "./format/device-wrapped-domain-agent-foreground-authorization-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "DeviceWrappedDomainAgentForegroundAuthorizationOperationV1",
    "DeviceWrappedDomainAgentForegroundAuthorizationSecretV1",
  ] as const).map((name) => ({
    source: "./format/device-wrapped-domain-agent-foreground-authorization-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    ["humanLiveShadowMessageRequestDigestV4", "foregroundSessionHumanLiveShadowMessageRequestDigest", false],
    ["liveShadowMessagePlanDigestV4", "foregroundSessionLiveShadowMessagePlanDigest", false],
    ["prepareHumanLiveShadowMessageRequestV4", "prepareForegroundSessionHumanLiveShadowMessageRequest", false],
    ["verifyHumanLiveShadowMessageRequestExactReplayV4", "verifyForegroundSessionHumanLiveShadowMessageRequestExactReplay", false],
    ["verifyHumanLiveShadowMessageRequestV4", "verifyForegroundSessionHumanLiveShadowMessageRequest", false],
    ["CreatedHumanLiveShadowMessageRequestV4", "CreatedForegroundSessionHumanLiveShadowMessageRequest", true],
    ["HumanLiveShadowAuthorizationProofV4", "ForegroundSessionHumanLiveShadowAuthorizationProof", true],
    ["HumanLiveShadowMessageRequestV4", "ForegroundSessionHumanLiveShadowMessageRequest", true],
    ["LiveShadowAuthorizationPlanV4", "ForegroundSessionLiveShadowAuthorizationPlan", true],
    ["LiveShadowMessagePlanV4", "ForegroundSessionLiveShadowMessagePlan", true],
    ["PrepareHumanLiveShadowMessageRequestInputV4", "PrepareForegroundSessionHumanLiveShadowMessageRequestInput", true],
    ["ResolveCurrentHumanLiveShadowMessageAuthorityV4", "ResolveCurrentForegroundSessionHumanLiveShadowMessageAuthority", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./message/live-shadow-message-request-v4.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_DOMAIN_V4",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_FORMAT_VERSION_V4",
    "HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_PURPOSE_V4",
    "LIVE_SHADOW_MESSAGE_NORMALIZATION_VERSION_V4",
    "LIVE_SHADOW_MESSAGE_PLAN_DOMAIN_V4",
    "LIVE_SHADOW_MESSAGE_PLAN_FORMAT_VERSION_V4",
    "LIVE_SHADOW_MESSAGE_PLAN_PURPOSE_V4",
    "LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4",
    "MAX_HUMAN_LIVE_SHADOW_MESSAGE_REQUEST_WIRE_BYTES_V4",
    "MAX_LIVE_SHADOW_MESSAGE_PLAN_WIRE_BYTES_V4",
    "decodeHumanLiveShadowMessageRequestV4",
    "decodeLiveShadowMessagePlanV4",
    "encodeHumanLiveShadowMessageRequestV4",
    "encodeLiveShadowMessagePlanV4",
    "humanLiveShadowMessageRequestSigningBytesV4",
  ] as const).map((name) => ({
    source: "./message/live-shadow-message-request-v4.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "HumanLiveShadowAuthorizationEstablishV4",
    "HumanLiveShadowAuthorizationReuseV4",
    "HumanLiveShadowMessageRequestUnsignedV4",
    "LiveShadowAuthorizationRequiredV4",
    "LiveShadowAuthorizationReusableV4",
  ] as const).map((name) => ({
    source: "./message/live-shadow-message-request-v4.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    ["humanPeerLiveShadowAcknowledgementDigestV1", "humanPeerLiveShadowAcknowledgementDigest", false],
    ["humanPeerLiveShadowMessagePlanDigestV1", "humanPeerLiveShadowMessagePlanDigest", false],
    ["humanPeerLiveShadowMessageRequestDigestV1", "humanPeerLiveShadowMessageRequestDigest", false],
    ["prepareHumanPeerLiveShadowAcknowledgementV1", "prepareHumanPeerLiveShadowAcknowledgement", false],
    ["prepareHumanPeerLiveShadowMessageRequestV1", "prepareHumanPeerLiveShadowMessageRequest", false],
    ["verifyHumanPeerLiveShadowAcknowledgementV1", "verifyHumanPeerLiveShadowAcknowledgement", false],
    ["verifyHumanPeerLiveShadowMessageRequestExactReplayV1", "verifyHumanPeerLiveShadowMessageRequestExactReplay", false],
    ["verifyHumanPeerLiveShadowMessageRequestV1", "verifyHumanPeerLiveShadowMessageRequest", false],
    ["HumanPeerLiveShadowAcknowledgementReasonV1", "HumanPeerLiveShadowAcknowledgementReason", true],
    ["HumanPeerLiveShadowAcknowledgementStatusV1", "HumanPeerLiveShadowAcknowledgementStatus", true],
    ["HumanPeerLiveShadowAcknowledgementV1", "HumanPeerLiveShadowAcknowledgement", true],
    ["HumanPeerLiveShadowMessagePlanV1", "HumanPeerLiveShadowMessagePlan", true],
    ["HumanPeerLiveShadowMessageRequestV1", "HumanPeerLiveShadowMessageRequest", true],
    ["ResolveCurrentHumanPeerDeviceAuthorityV1", "ResolveCurrentHumanPeerDeviceAuthority", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./message/human-peer-live-shadow-v1.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "HUMAN_PEER_LIVE_SHADOW_ACK_DOMAIN_V1",
    "HUMAN_PEER_LIVE_SHADOW_ACK_PURPOSE_V1",
    "HUMAN_PEER_LIVE_SHADOW_FORMAT_VERSION_V1",
    "HUMAN_PEER_LIVE_SHADOW_MAX_TTL_MS_V1",
    "HUMAN_PEER_LIVE_SHADOW_NORMALIZATION_VERSION_V1",
    "HUMAN_PEER_LIVE_SHADOW_PLAN_DOMAIN_V1",
    "HUMAN_PEER_LIVE_SHADOW_PLAN_PURPOSE_V1",
    "HUMAN_PEER_LIVE_SHADOW_REQUEST_DOMAIN_V1",
    "HUMAN_PEER_LIVE_SHADOW_REQUEST_PURPOSE_V1",
    "MAX_HUMAN_PEER_LIVE_SHADOW_ACK_WIRE_BYTES_V1",
    "MAX_HUMAN_PEER_LIVE_SHADOW_PLAN_WIRE_BYTES_V1",
    "MAX_HUMAN_PEER_LIVE_SHADOW_REQUEST_WIRE_BYTES_V1",
    "decodeHumanPeerLiveShadowAcknowledgementV1",
    "decodeHumanPeerLiveShadowMessagePlanV1",
    "decodeHumanPeerLiveShadowMessageRequestV1",
    "encodeHumanPeerLiveShadowAcknowledgementV1",
    "encodeHumanPeerLiveShadowMessagePlanV1",
    "encodeHumanPeerLiveShadowMessageRequestV1",
    "humanPeerLiveShadowAcknowledgementSigningBytesV1",
    "humanPeerLiveShadowMessageRequestSigningBytesV1",
  ] as const).map((name) => ({
    source: "./message/human-peer-live-shadow-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "HumanPeerLiveShadowAcknowledgementUnsignedV1",
    "HumanPeerLiveShadowMessageRequestUnsignedV1",
  ] as const).map((name) => ({
    source: "./message/human-peer-live-shadow-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    ["sharedAgentLiveShadowAcknowledgementDigestV1", "sharedAgentLiveShadowAcknowledgementDigest", false],
    ["sharedAgentLiveShadowExecutionInputSetDigestV1", "sharedAgentLiveShadowExecutionInputSetDigest", false],
    ["sharedAgentLiveShadowMessagePlanDigestV1", "sharedAgentLiveShadowMessagePlanDigest", false],
    ["sharedAgentLiveShadowMessageRequestDigestV1", "sharedAgentLiveShadowMessageRequestDigest", false],
    ["prepareSharedAgentLiveShadowAcknowledgementV1", "prepareSharedAgentLiveShadowAcknowledgement", false],
    ["prepareSharedAgentLiveShadowMessageRequestV1", "prepareSharedAgentLiveShadowMessageRequest", false],
    ["verifySharedAgentLiveShadowAcknowledgementV1", "verifySharedAgentLiveShadowAcknowledgement", false],
    ["verifySharedAgentLiveShadowMessageRequestExactReplayV1", "verifySharedAgentLiveShadowMessageRequestExactReplay", false],
    ["verifySharedAgentLiveShadowMessageRequestV1", "verifySharedAgentLiveShadowMessageRequest", false],
    ["SharedAgentLiveShadowAcknowledgementReasonV1", "SharedAgentLiveShadowAcknowledgementReason", true],
    ["SharedAgentLiveShadowAcknowledgementStatusV1", "SharedAgentLiveShadowAcknowledgementStatus", true],
    ["SharedAgentLiveShadowAcknowledgementV1", "SharedAgentLiveShadowAcknowledgement", true],
    ["SharedAgentLiveShadowExecutionInputV1", "SharedAgentLiveShadowExecutionInput", true],
    ["SharedAgentLiveShadowMessagePlanV1", "SharedAgentLiveShadowMessagePlan", true],
    ["SharedAgentLiveShadowMessageRequestV1", "SharedAgentLiveShadowMessageRequest", true],
    ["ResolveCurrentSharedAgentDeviceAuthorityV1", "ResolveCurrentSharedAgentDeviceAuthority", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./message/shared-agent-live-shadow-v1.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "SHARED_AGENT_LIVE_SHADOW_ACK_DOMAIN_V1",
    "SHARED_AGENT_LIVE_SHADOW_ACK_PURPOSE_V1",
    "SHARED_AGENT_LIVE_SHADOW_FORMAT_VERSION_V1",
    "SHARED_AGENT_LIVE_SHADOW_MAX_TTL_MS_V1",
    "SHARED_AGENT_LIVE_SHADOW_NORMALIZATION_VERSION_V1",
    "SHARED_AGENT_LIVE_SHADOW_PLAN_DOMAIN_V1",
    "SHARED_AGENT_LIVE_SHADOW_PLAN_PURPOSE_V1",
    "SHARED_AGENT_LIVE_SHADOW_REQUEST_DOMAIN_V1",
    "SHARED_AGENT_LIVE_SHADOW_REQUEST_PURPOSE_V1",
    "MAX_SHARED_AGENT_LIVE_SHADOW_ACK_WIRE_BYTES_V1",
    "MAX_SHARED_AGENT_LIVE_SHADOW_PLAN_WIRE_BYTES_V1",
    "MAX_SHARED_AGENT_LIVE_SHADOW_REQUEST_WIRE_BYTES_V1",
    "decodeSharedAgentLiveShadowAcknowledgementV1",
    "decodeSharedAgentLiveShadowMessagePlanV1",
    "decodeSharedAgentLiveShadowMessageRequestV1",
    "encodeSharedAgentLiveShadowAcknowledgementV1",
    "encodeSharedAgentLiveShadowMessagePlanV1",
    "encodeSharedAgentLiveShadowMessageRequestV1",
    "sharedAgentLiveShadowAcknowledgementSigningBytesV1",
    "sharedAgentLiveShadowMessageRequestSigningBytesV1",
  ] as const).map((name) => ({
    source: "./message/shared-agent-live-shadow-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "SharedAgentLiveShadowAcknowledgementUnsignedV1",
    "SharedAgentLiveShadowMessageRequestUnsignedV1",
  ] as const).map((name) => ({
    source: "./message/shared-agent-live-shadow-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    ["humanAiReadableLiveShadowAcknowledgementDigestV1", "humanAiReadableLiveShadowAcknowledgementDigest", false],
    ["humanAiReadableLiveShadowExecutionInputSetDigestV1", "humanAiReadableLiveShadowExecutionInputSetDigest", false],
    ["humanAiReadableLiveShadowMessagePlanDigest", "humanAiReadableLiveShadowMessagePlanDigest", false],
    ["humanAiReadableLiveShadowMessageRequestDigest", "humanAiReadableLiveShadowMessageRequestDigest", false],
    ["prepareHumanAiReadableLiveShadowAcknowledgementV1", "prepareHumanAiReadableLiveShadowAcknowledgement", false],
    ["prepareHumanAiReadableLiveShadowMessageRequest", "prepareHumanAiReadableLiveShadowMessageRequest", false],
    ["verifyHumanAiReadableLiveShadowAcknowledgementV1", "verifyHumanAiReadableLiveShadowAcknowledgement", false],
    ["verifyHumanAiReadableLiveShadowMessageRequestExactReplay", "verifyHumanAiReadableLiveShadowMessageRequestExactReplay", false],
    ["verifyHumanAiReadableLiveShadowMessageRequest", "verifyHumanAiReadableLiveShadowMessageRequest", false],
    ["decodeHumanAiReadableLiveShadowMessagePlan", "decodeHumanAiReadableLiveShadowMessagePlan", false],
    ["decodeHumanAiReadableLiveShadowMessageRequest", "decodeHumanAiReadableLiveShadowMessageRequest", false],
    ["encodeHumanAiReadableLiveShadowMessagePlan", "encodeHumanAiReadableLiveShadowMessagePlan", false],
    ["encodeHumanAiReadableLiveShadowMessageRequest", "encodeHumanAiReadableLiveShadowMessageRequest", false],
    ["humanAiReadableLiveShadowMessageRequestSigningBytes", "humanAiReadableLiveShadowMessageRequestSigningBytes", false],
    ["HumanAiReadableLiveShadowAcknowledgementReasonV1", "HumanAiReadableLiveShadowAcknowledgementReason", true],
    ["HumanAiReadableLiveShadowAcknowledgementStatusV1", "HumanAiReadableLiveShadowAcknowledgementStatus", true],
    ["HumanAiReadableLiveShadowAcknowledgementV1", "HumanAiReadableLiveShadowAcknowledgement", true],
    ["HumanAiReadableLiveShadowExecutionInputV1", "HumanAiReadableLiveShadowExecutionInput", true],
    ["HumanAiReadableLiveShadowMessagePlan", "HumanAiReadableLiveShadowMessagePlan", true],
    ["HumanAiReadableLiveShadowMessageRequest", "HumanAiReadableLiveShadowMessageRequest", true],
    ["HumanAiReadableLiveShadowMessageRequestUnsigned", "HumanAiReadableLiveShadowMessageRequestUnsigned", true],
    ["ResolveCurrentHumanAiReadableDeviceAuthorityV1", "ResolveCurrentHumanAiReadableDeviceAuthority", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./message/human-ai-readable-live-shadow-core.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "HUMAN_AI_READABLE_LIVE_SHADOW_ACK_DOMAIN_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_ACK_PURPOSE_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_FORMAT_VERSION_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_NORMALIZATION_VERSION_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_DOMAIN_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_PURPOSE_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_DOMAIN_V1",
    "HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_PURPOSE_V1",
    "MAX_HUMAN_AI_READABLE_LIVE_SHADOW_ACK_WIRE_BYTES_V1",
    "MAX_HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_WIRE_BYTES_V1",
    "MAX_HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_WIRE_BYTES_V1",
    "decodeHumanAiReadableLiveShadowAcknowledgementV1",
    "decodeHumanAiReadableLiveShadowMessagePlanV1",
    "decodeHumanAiReadableLiveShadowMessageRequestV1",
    "encodeHumanAiReadableLiveShadowAcknowledgementV1",
    "encodeHumanAiReadableLiveShadowMessagePlanV1",
    "encodeHumanAiReadableLiveShadowMessageRequestV1",
    "humanAiReadableLiveShadowAcknowledgementSigningBytesV1",
    "humanAiReadableLiveShadowMessageRequestSigningBytesV1",
  ] as const).map((name) => ({
    source: "./message/human-ai-readable-live-shadow-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "HumanAiReadableLiveShadowAcknowledgementUnsignedV1",
    "HumanAiReadableLiveShadowMessageRequestUnsignedV1",
  ] as const).map((name) => ({
    source: "./message/human-ai-readable-live-shadow-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V2",
    "HUMAN_AI_READABLE_LIVE_SHADOW_PLAN_DOMAIN_V2",
    "HUMAN_AI_READABLE_LIVE_SHADOW_REQUEST_DOMAIN_V2",
    "decodeHumanAiReadableLiveShadowMessagePlanV2",
    "decodeHumanAiReadableLiveShadowMessageRequestV2",
    "encodeHumanAiReadableLiveShadowMessagePlanV2",
    "encodeHumanAiReadableLiveShadowMessageRequestV2",
    "humanAiReadableLiveShadowMessagePlanDigestV2",
    "humanAiReadableLiveShadowMessageRequestDigestV2",
    "humanAiReadableLiveShadowMessageRequestSigningBytesV2",
    "prepareHumanAiReadableLiveShadowMessageRequestV2",
    "verifyHumanAiReadableLiveShadowMessageRequestExactReplayV2",
    "verifyHumanAiReadableLiveShadowMessageRequestV2",
  ] as const).map((name) => ({
    source: "./message/human-ai-readable-live-shadow-v2.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "HumanAiReadableLiveShadowMessagePlanV2",
    "HumanAiReadableLiveShadowMessageRequestUnsignedV2",
    "HumanAiReadableLiveShadowMessageRequestV2",
  ] as const).map((name) => ({
    source: "./message/human-ai-readable-live-shadow-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    ["createDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1", "createDeviceWrappedDomainRuntimeForegroundAuthorizationPlan", false],
    ["mintDeviceWrappedDomainRuntimeForegroundAuthorizationV1", "mintDeviceWrappedDomainRuntimeForegroundAuthorization", false],
    ["withOpenedDeviceWrappedDomainRuntimeForegroundAuthorizationV1", "withOpenedDeviceWrappedDomainRuntimeForegroundAuthorization", false],
    ["DeviceWrappedDomainRuntimeForegroundAuthorizationAuthorityEntryV1", "DeviceWrappedDomainRuntimeForegroundAuthorizationAuthorityEntry", true],
    ["DeviceWrappedDomainRuntimeForegroundAuthorizationCurrentAuthorityV1", "DeviceWrappedDomainRuntimeForegroundAuthorizationCurrentAuthority", true],
    ["DeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1", "DeviceWrappedDomainRuntimeForegroundAuthorizationPlan", true],
    ["DeviceWrappedDomainRuntimeForegroundAuthorizationSecretEntryV1", "DeviceWrappedDomainRuntimeForegroundAuthorizationSecretEntry", true],
    ["DeviceWrappedDomainRuntimeForegroundAuthorizationV1", "DeviceWrappedDomainRuntimeForegroundAuthorization", true],
    ["OpenDeviceWrappedDomainRuntimeForegroundAuthorizationResultV1", "OpenDeviceWrappedDomainRuntimeForegroundAuthorizationResult", true],
  ] as const).map(([imported, exported, typeOnly]) => ({
    source: "./format/device-wrapped-domain-runtime-foreground-authorization-v1.ts",
    imported,
    exported,
    typeOnly,
  })),
  ...([
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_FORMAT_VERSION",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_MAX_DOMAINS",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_MAX_SECRET_BYTES",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_MAX_TTL_MS",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_MAX_WIRE_BYTES",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_PLAN_PURPOSE",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_PURPOSE",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_RECIPIENT_KIND",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_SCHEME",
    "DEVICE_WRAPPED_DOMAIN_RUNTIME_FOREGROUND_AUTHORIZATION_V1_SECRET_PURPOSE",
    "destroyDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1",
    "destroyDeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1",
    "destroyDeviceWrappedDomainRuntimeForegroundAuthorizationV1",
    "parseDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1",
    "parseDeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1",
    "parseDeviceWrappedDomainRuntimeForegroundAuthorizationV1",
    "serializeDeviceWrappedDomainRuntimeForegroundAuthorizationPlanV1",
    "serializeDeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1",
    "serializeDeviceWrappedDomainRuntimeForegroundAuthorizationV1",
  ] as const).map((name) => ({
    source: "./format/device-wrapped-domain-runtime-foreground-authorization-v1.ts",
    imported: name,
    exported: name,
    typeOnly: false,
  })),
  ...([
    "DeviceWrappedDomainRuntimeForegroundAuthorizationOperationV1",
    "DeviceWrappedDomainRuntimeForegroundAuthorizationSecretV1",
  ] as const).map((name) => ({
    source: "./format/device-wrapped-domain-runtime-foreground-authorization-v1.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  // M317 keeps current processor operations on the dedicated background
  // surface. Only the clean common-manifest aliases and the versioned types
  // reachable through ProcessorTransformRecipientRegistry are public here.
  {
    source: "./format/object-access-manifest-v5.ts",
    imported: "createCurrentProcessorObjectAccessManifestV5",
    exported: "createCurrentCommonProcessorObjectAccessManifest",
    typeOnly: false,
  },
  ...([
    ["ResolveHistoricalBackgroundAuthorizationIssuerV2", "ResolveHistoricalCurrentProcessorIssuer"],
    ["VerifiedProcessorSignerAuthorizationV2", "VerifiedCurrentProcessorSignerAuthorization"],
  ] as const).map(([imported, exported]) => ({
    source: "./background/processor-authorization-v2.ts",
    imported,
    exported,
    typeOnly: true,
  })),
  {
    source: "./format/object-access-manifest-v4.ts",
    imported: "createCurrentProcessorObjectAccessManifestV4",
    exported: "createCurrentProcessorObjectAccessManifestV4",
    typeOnly: false,
  },
  ...([
    ["decodeBackgroundWorkDescriptorV2", "decodeBackgroundWorkDescriptorV2"],
    ["destroyVerifiedProcessorSignerAuthorizationV2", "destroyVerifiedProcessorSignerAuthorizationV2"],
    ["readProcessorSignerAuthorizationVersion", "readProcessorSignerAuthorizationVersionV2"],
    ["verifyHistoricalProcessorSignerAuthorizationV2", "verifyHistoricalProcessorSignerAuthorizationV2"],
  ] as const).map(([imported, exported]) => ({
    source: imported === "decodeBackgroundWorkDescriptorV2"
      ? "./background/work-descriptor-v2.ts"
      : "./background/processor-authorization-v2.ts",
    imported,
    exported,
    typeOnly: false,
  })),
  ...([
    "BackgroundAuthorizationIssuerV2",
    "BackgroundAuthorizationIssuerContextV2",
    "ResolveCurrentBackgroundAuthorizationIssuerV2",
    "ProcessorSignerAuthorizationCertificateV2",
  ] as const).map((name) => ({
    source: "./background/processor-authorization-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "ProcessorOutputRepairBindingV2",
  ] as const).map((name) => ({
    source: "./background/output-repair-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "ProcessorPublicationReconciliationBindingV2",
  ] as const).map((name) => ({
    source: "./background/publication-reconciliation-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "ProcessorOutputRepairRunInputV2",
    "ProcessorOutputRepairObjectPortV2",
    "ProcessorOutputRepairOrdinaryOutputV2",
    "ProcessorReconciliationObjectPortV2",
    "ProcessorReconciliationRunInputV2",
    "ProcessorTransformObjectPortV2",
    "ProcessorTransformRunContextV2",
    "ProcessorTransformRunInputV2",
  ] as const).map((name) => ({
    source: "./background/one-run-processor-transform-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
  ...([
    "BackgroundNamespaceAuthorityV2",
    "BackgroundProcessorWorkDescriptorV2",
    "BackgroundWorkDescriptorV2",
  ] as const).map((name) => ({
    source: "./background/work-descriptor-v2.ts",
    imported: name,
    exported: name,
    typeOnly: true,
  })),
];

type WireRoundTrip = (bytes: Uint8Array) => Uint8Array | null;

function canonicalSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function sourceTypeDeclaration(
  symbol: ts.Symbol | undefined,
  sourceRoot: string,
): ts.Declaration | undefined {
  return symbol?.declarations?.find((declaration) => {
    const sourcePath = resolve(declaration.getSourceFile().fileName);
    return (
      sourcePath.startsWith(`${sourceRoot}${sep}`)
      && (
        ts.isTypeAliasDeclaration(declaration)
        || ts.isInterfaceDeclaration(declaration)
        || ts.isClassDeclaration(declaration)
        || ts.isEnumDeclaration(declaration)
      )
    );
  });
}

function isPrivateOrProtected(declaration: ts.Declaration): boolean {
  const modifiers = ts.getCombinedModifierFlags(declaration);
  const name = (declaration as ts.NamedDeclaration).name;
  return (
    Boolean(
      modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected),
    )
    || (name !== undefined && ts.isPrivateIdentifier(name))
  );
}

function unreachableRootTypeSymbols(): readonly string[] {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const configPath = `${packageRoot}/tsconfig.json`;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new TypeError(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    { noEmit: true },
    configPath,
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const sourceRoot = resolve(packageRoot, "src");

  const moduleExports = (filename: string): readonly ts.Symbol[] => {
    const sourceFile = program.getSourceFile(resolve(sourceRoot, filename));
    if (sourceFile === undefined) {
      throw new TypeError(`TypeScript program omitted ${filename}`);
    }
    const module = checker.getSymbolAtLocation(sourceFile);
    if (module === undefined) {
      throw new TypeError(`TypeScript did not resolve ${filename}`);
    }
    return checker.getExportsOfModule(module);
  };

  const rootExports = moduleExports("index.ts");
  const wireExports = moduleExports("wire.ts");
  const supportedSymbols = new Set(
    [...rootExports, ...wireExports].map((symbol) =>
      canonicalSymbol(checker, symbol)
    ),
  );
  const visited = new Set<ts.Type>();
  const leaks = new Set<string>();

  const visit = (type: ts.Type | undefined, via: string): void => {
    if (type === undefined || visited.has(type)) return;
    visited.add(type);

    for (const candidate of [type.aliasSymbol, type.getSymbol()]) {
      const symbol = candidate === undefined
        ? undefined
        : canonicalSymbol(checker, candidate);
      const declaration = sourceTypeDeclaration(symbol, sourceRoot);
      if (
        symbol !== undefined
        && declaration !== undefined
        && !supportedSymbols.has(symbol)
      ) {
        const sourceFile = declaration.getSourceFile();
        const location = sourceFile.getLineAndCharacterOfPosition(
          declaration.getStart(),
        );
        leaks.add(
          `${symbol.getName()} at ${
            relative(packageRoot, sourceFile.fileName)
          }:${location.line + 1} via ${via}`,
        );
      }
    }

    if (type.isUnionOrIntersection()) {
      type.types.forEach((member) => visit(member, via));
    }
    if (
      type.flags & ts.TypeFlags.Object
      && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
    ) {
      checker.getTypeArguments(type as ts.TypeReference)
        .forEach((argument) => visit(argument, via));
    }
    for (
      const signature of [
        ...type.getCallSignatures(),
        ...type.getConstructSignatures(),
      ]
    ) {
      for (const parameter of signature.getParameters()) {
        const declaration = parameter.valueDeclaration
          ?? parameter.declarations?.[0];
        if (declaration !== undefined) {
          visit(checker.getTypeOfSymbolAtLocation(parameter, declaration), via);
        }
      }
      visit(checker.getReturnTypeOfSignature(signature), via);
      for (const parameter of signature.getTypeParameters() ?? []) {
        visit(checker.getBaseConstraintOfType(parameter), via);
        visit(checker.getDefaultFromTypeParameter(parameter), via);
      }
    }
    type.getBaseTypes()?.forEach((base) => visit(base, via));

    const rawSymbol = type.getSymbol();
    const symbol = rawSymbol === undefined
      ? undefined
      : canonicalSymbol(checker, rawSymbol);
    const declaration = sourceTypeDeclaration(symbol, sourceRoot);
    const isAnonymous = Boolean(
      type.flags & ts.TypeFlags.Object
      && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous,
    );
    if (declaration !== undefined && ts.isClassDeclaration(declaration)) {
      for (const member of declaration.members) {
        if (
          ts.isConstructorDeclaration(member)
          || isPrivateOrProtected(member)
          || member.name === undefined
        ) {
          continue;
        }
        const memberSymbol = checker.getSymbolAtLocation(member.name);
        const memberDeclaration = memberSymbol?.valueDeclaration
          ?? memberSymbol?.declarations?.[0];
        if (memberSymbol !== undefined && memberDeclaration !== undefined) {
          visit(
            checker.getTypeOfSymbolAtLocation(
              memberSymbol,
              memberDeclaration,
            ),
            via,
          );
        }
      }
    } else if (declaration !== undefined || isAnonymous) {
      for (const property of checker.getPropertiesOfType(type)) {
        const propertyDeclaration = property.valueDeclaration
          ?? property.declarations?.[0];
        if (
          propertyDeclaration !== undefined
          && !isPrivateOrProtected(propertyDeclaration)
        ) {
          visit(
            checker.getTypeOfSymbolAtLocation(property, propertyDeclaration),
            via,
          );
        }
      }
    }
  };

  for (const exported of rootExports) {
    const symbol = canonicalSymbol(checker, exported);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (symbol.flags & ts.SymbolFlags.Value && declaration !== undefined) {
      visit(
        checker.getTypeOfSymbolAtLocation(symbol, declaration),
        exported.getName(),
      );
    }
    if (symbol.flags & ts.SymbolFlags.Type) {
      visit(checker.getDeclaredTypeOfSymbol(symbol), exported.getName());
    }
  }

  return [...leaks].sort();
}

function explicitExports(path: string): readonly ExportDisposition[] {
  const sourceText = readFileSync(path, "utf8");
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const exports: ExportDisposition[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (
      statement.moduleSpecifier === undefined
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || statement.exportClause === undefined
      || !ts.isNamedExports(statement.exportClause)
    ) {
      throw new TypeError(`${path} contains a non-explicit export`);
    }
    for (const specifier of statement.exportClause.elements) {
      exports.push({
        source: statement.moduleSpecifier.text,
        imported: specifier.propertyName?.text ?? specifier.name.text,
        exported: specifier.name.text,
        typeOnly: statement.isTypeOnly || specifier.isTypeOnly,
      });
    }
  }
  return exports;
}

function identity(entry: ExportIdentity): string {
  return `${entry.source}\u0000${entry.imported}`;
}

function classificationErrors(
  previous: readonly ExportDisposition[],
  root: readonly ExportDisposition[],
  versionedWire: readonly ExportDisposition[],
): readonly string[] {
  const errors: string[] = [];
  const classified = [...root, ...versionedWire];
  const previousIdentities = new Set(previous.map(identity));
  const classifiedIdentities = classified.map(identity);
  const classifiedIdentitySet = new Set(classifiedIdentities);

  for (const entry of previous) {
    if (!classifiedIdentitySet.has(identity(entry))) {
      errors.push(`unclassified: ${entry.imported} from ${entry.source}`);
    }
  }
  for (const entry of classified) {
    if (!previousIdentities.has(identity(entry))) {
      errors.push(`unknown target: ${entry.imported} from ${entry.source}`);
    }
  }
  for (const value of new Set(classifiedIdentities)) {
    if (classifiedIdentities.filter((entry) => entry === value).length > 1) {
      errors.push(`duplicate classification: ${value}`);
    }
  }
  for (const entry of root) {
    if (/V\d+/u.test(entry.exported)) {
      errors.push(`versioned root name: ${entry.exported}`);
    }
  }
  for (const entry of versionedWire) {
    if (!/V\d+/u.test(entry.exported)) {
      errors.push(`unversioned wire name: ${entry.exported}`);
    }
  }
  return errors;
}

async function expectDirectRuntimeAliases(
  surface: Readonly<Record<string, unknown>>,
  entries: readonly ExportDisposition[],
): Promise<void> {
  const sourceRoot = new URL("../../src/", import.meta.url);
  for (const entry of entries.filter((candidate) => !candidate.typeOnly)) {
    const target = await import(
      new URL(entry.source.slice(2), sourceRoot).href
    ) as Readonly<Record<string, unknown>>;
    expect(surface[entry.exported]).toBe(target[entry.imported]);
  }
}

describe("M226 clean supported package API", () => {
  test("exposes unversioned workflows as direct aliases", () => {
    expect(cleanRuntime["coordinateGrantUse"]).toBe(coordinateGrantUseV2);
    expect(cleanRuntime["prepareHumanNamespaceRebind"]).toBe(
      prepareHumanNamespaceRebindV2,
    );
    expect(cleanRuntime["createObjectAccessManifest"]).toBe(
      createObjectAccessManifestV2,
    );
    expect(cleanRuntime["OpenMlsGroupProvider"]).toBe(OpenMlsV2GroupProvider);
    expect(cleanTypeAliases).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(typeOnlyLeaks).toBeNull();
    expect(packageRoot.coordinateGrantUse).toBe(clean.coordinateGrantUse);
  });

  test("keeps version-bearing codecs and records on the wire surface", () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const packageJson = JSON.parse(
      readFileSync(`${packageRoot}/package.json`, "utf8"),
    ) as { exports?: Record<string, string> };
    expect(packageJson.exports?.["./wire"]).toBe("./src/wire.ts");
    expect(existsSync(`${packageRoot}/src/wire.ts`)).toBe(true);
    expect(wire.serializeNamespaceBindingV2).toBe(
      serializeNamespaceBinding,
    );
    expect(wire.NAMESPACE_BINDING_DOMAIN_V2).toBe(
      NAMESPACE_BINDING_DOMAIN,
    );
    expect(packageWire.serializeNamespaceBindingV2).toBe(
      wire.serializeNamespaceBindingV2,
    );
  });

  test("contains no protocol-version suffix in the clean runtime surface", () => {
    expect(Object.keys(cleanRuntime).sort()).toEqual([...CLEAN_RUNTIME_EXPORTS]);
    expect(
      Object.keys(cleanRuntime).filter((name) => /V\d+$/u.test(name)),
    ).toEqual([]);
  });

  test("data-only wire limits are exact codec-owned aliases", () => {
    const versionedNames = [
      "DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2",
      "HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2",
      "MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2",
      "MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1",
      "MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1",
      "MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2",
      "MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2",
      "MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2",
      "MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5",
      "MAX_RETAINED_NAMESPACE_GENERATIONS_V2",
    ] as const;
    expect(Object.keys(wireLimits).sort()).toEqual([
      "DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2",
      "HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2",
      "LATTICE_LIMITS",
      "MAX_AGENT_GRANT_DOMAINS_V2",
      "MAX_AGENT_GRANT_NAMESPACES_V2",
      "MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2",
      "MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1",
      "MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1",
      "MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2",
      "MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2",
      "MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2",
      "MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5",
      "MAX_RETAINED_NAMESPACE_GENERATIONS_V2",
    ]);
    for (const name of versionedNames) {
      expect(wireLimits[name]).toBe(wire[name]);
    }
    expect(wireLimits.MAX_AGENT_GRANT_DOMAINS_V2).toBe(V2_LIMITS.agentGrantDomains);
    expect(wireLimits.MAX_AGENT_GRANT_NAMESPACES_V2).toBe(V2_LIMITS.agentGrantNamespaces);
    expect(wireLimits.LATTICE_LIMITS).toBe(canonicalLatticeLimits);
  });

  test("keeps every wire runtime name explicitly versioned", () => {
    expect(Object.keys(wire).sort()).toEqual([...WIRE_RUNTIME_EXPORTS]);
    expect(
      Object.keys(wire).filter((name) => !/V\d+/u.test(name)),
    ).toEqual([]);
  });

  test("classifies the former root and required closure types exactly once", () => {
    const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const previous = explicitExports(`${sourceRoot}/internal-v2.ts`);
    const inventory = [...previous, ...ROOT_TYPE_CLOSURE_ADDITIONS];
    const root = explicitExports(`${sourceRoot}/index.ts`);
    const versionedWire = explicitExports(`${sourceRoot}/wire.ts`);
    const classified = [...root, ...versionedWire];

    expect(previous).toHaveLength(626);
    expect(classified).toHaveLength(inventory.length);
    expect(classificationErrors(inventory, root, versionedWire)).toEqual([]);
    expect(
      root.filter((entry) => entry.typeOnly).map((entry) => entry.exported)
        .sort(),
    ).toEqual([...CLEAN_TYPE_EXPORTS]);
    expect(
      versionedWire.filter((entry) => entry.typeOnly)
        .map((entry) => entry.exported)
        .sort(),
    ).toEqual([...WIRE_TYPE_EXPORTS]);
    expect(new Set(classified.map(identity)).size).toBe(classified.length);
    expect(classified.map(identity).sort()).toEqual(
      inventory.map(identity).sort(),
    );
    expect(root.filter((entry) => /V\d+/u.test(entry.exported))).toEqual([]);
    expect(
      versionedWire.filter((entry) => !/V\d+/u.test(entry.exported)),
    ).toEqual([]);
  });

  test("rejects an intentionally unclassified or mislayered export", () => {
    const base: ExportDisposition = {
      source: "./codec.ts",
      imported: "parseRecordV2",
      exported: "parseRecordV2",
      typeOnly: false,
    };
    expect(classificationErrors([base], [], [])).toContain(
      "unclassified: parseRecordV2 from ./codec.ts",
    );
    expect(classificationErrors([base], [base], [base])).toContain(
      `duplicate classification: ${identity(base)}`,
    );
    expect(classificationErrors(
      [base],
      [{ ...base, exported: "parseRecord" }],
      [],
    )).toEqual([]);
    expect(classificationErrors(
      [base],
      [],
      [{ ...base, exported: "parseRecord" }],
    )).toContain("unversioned wire name: parseRecord");
    expect(classificationErrors(
      [base],
      [{ ...base, exported: "parseRecordV2" }],
      [],
    )).toContain("versioned root name: parseRecordV2");
  });

  test("uses direct runtime aliases for every root and wire value", async () => {
    const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));
    await expectDirectRuntimeAliases(
      cleanRuntime,
      explicitExports(`${sourceRoot}/index.ts`),
    );
    await expectDirectRuntimeAliases(
      wire,
      explicitExports(`${sourceRoot}/wire.ts`),
    );
  });

  test("keeps the complete root type closure on supported entry points", () => {
    expect(unreachableRootTypeSymbols()).toEqual([]);
  });

  test("preserves every supported codec family's exact M225 bytes", () => {
    const roundTrips = new Map<string, WireRoundTrip>([
      [
        "Agent Runtime generation",
        (bytes) =>
          wire.encodeAgentRuntimeGenerationV1(
            wire.decodeAgentRuntimeGenerationV1(bytes),
          ),
      ],
      [
        "Agent Runtime Domain envelope",
        (bytes) =>
          wire.serializeAgentRuntimeDomainEnvelopeV1(
            wire.parseAgentRuntimeDomainEnvelopeV1(bytes),
          ),
      ],
      [
        "grant",
        (bytes) => {
          const decoded = wire.parseGrantV2(bytes);
          return decoded === null ? null : wire.serializeGrantV2(decoded);
        },
      ],
      [
        "Namespace binding",
        (bytes) =>
          wire.serializeNamespaceBindingV2(
            wire.parseNamespaceBindingV2(bytes),
          ),
      ],
      [
        "Namespace keyring",
        (bytes) =>
          wire.encodeNamespaceKeyringV2(wire.decodeNamespaceKeyringV2(bytes)),
      ],
      [
        "Namespace keyring envelope",
        (bytes) =>
          wire.serializeNamespaceKeyringEnvelopeV2(
            wire.parseNamespaceKeyringEnvelopeV2(bytes),
          ),
      ],
      [
        "object access manifest",
        (bytes) =>
          wire.encodeObjectAccessManifestV2(
            wire.decodeObjectAccessManifestV2(bytes),
          ),
      ],
      [
        "encrypted object payload",
        (bytes) =>
          wire.encodeEncryptedPayloadV2(
            wire.decodeEncryptedPayloadV2(bytes),
          ),
      ],
      [
        "Namespace object envelope",
        (bytes) =>
          wire.encodeNamespaceObjectEnvelopeV2(
            wire.decodeNamespaceObjectEnvelopeV2(bytes),
          ),
      ],
      [
        "Namespace recovery package",
        (bytes) =>
          wire.serializeNamespaceRecoveryPackageV2(
            wire.decodeNamespaceRecoveryPackageV2(bytes),
          ),
      ],
      [
        "Human recovery archive",
        (bytes) =>
          wire.serializeHumanRecoveryArchiveV2(
            wire.decodeHumanRecoveryArchiveV2(bytes),
          ),
      ],
      [
        "Agent manager keyring",
        (bytes) =>
          wire.encodeAgentManagerKeyringV2(
            wire.decodeAgentManagerKeyringV2(bytes),
          ),
      ],
      [
        "Agent manager recovery package",
        (bytes) =>
          wire.serializeAgentManagerRecoveryPackageV2(
            wire.decodeAgentManagerRecoveryPackageV2(bytes),
          ),
      ],
      [
        "device transfer approval and nested package",
        (bytes) =>
          wire.serializeDeviceTransferApprovalV2(
            wire.decodeDeviceTransferApprovalV2(bytes),
          ),
      ],
      [
        "recovery-device activation challenge",
        (bytes) =>
          wire.serializeRecoveryDeviceActivationChallengeV2(
            wire.decodeRecoveryDeviceActivationChallengeV2(bytes),
          ),
      ],
      [
        "recovery-device activation proof",
        (bytes) =>
          wire.serializeRecoveryDeviceActivationProofV2(
            wire.decodeRecoveryDeviceActivationProofV2(bytes),
          ),
      ],
    ]);
    const supportedFixtures = fixtureV2Codecs(0).filter(
      (fixture) => fixture.name !== "grant secret",
    );

    expect([...roundTrips.keys()]).toEqual(
      supportedFixtures.map((fixture) => fixture.name),
    );
    for (const fixture of supportedFixtures) {
      expect(roundTrips.get(fixture.name)!(fixture.canonical)).toEqual(
        fixture.canonical,
      );
    }
    expect(wire.V2_PROVIDER_STATE_FORMAT_VERSION).toBe(2);
    expect(wire.V2_PROVIDER_TRANSITION_FORMAT_VERSION).toBe(2);
  });
});
