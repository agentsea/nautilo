/**
 * Compile-only consumer contract for the supported package entry points.
 *
 * This deliberately imports through package specifiers, never source paths.
 * The mapped closure forces TypeScript to resolve every exported runtime
 * function and class signature from the perspective of an ordinary consumer.
 */
import * as lattice from "@nautilo/lattice-crypto";
import type {
  AgentRuntimeAuthorizationPlan,
  GroupKeyProvider,
  HumanRecoveryInventoryItem,
  HumanRecoveryKit,
  LatticeStorage,
  NamespaceObjectEnvelope,
  OpaqueAgentRuntimeConfigDek,
  PreparedDomainEpochAdvance,
  VerifiedRecoveryDeviceReadiness,
} from "@nautilo/lattice-crypto";
import * as wire from "@nautilo/lattice-crypto/wire";
import type {
  AgentManagerRecoveryPackageV2,
  AgentRuntimeDomainEnvelopeV1,
  EncryptedPayloadRecordV2,
  GrantV2,
  NamespaceBindingV2,
  NamespaceKeyringEnvelopeV2,
  ProviderPublicTransitionV2,
  ProviderRosterEntryV2,
  StorageAdapterSupportV2,
} from "@nautilo/lattice-crypto/wire";

type CallableClosure<T> = {
  [K in keyof T]: T[K] extends abstract new (...args: infer Arguments) =>
    infer Instance
    ? Readonly<{ arguments: Arguments; instance: Instance }>
    : T[K] extends (...args: infer Arguments) => infer Result
      ? Readonly<{ arguments: Arguments; result: Result }>
      : T[K];
};

type RootRuntimeClosure = CallableClosure<typeof lattice>;
type WireRuntimeClosure = CallableClosure<typeof wire>;

type RepresentativeRootTypes = [
  AgentRuntimeAuthorizationPlan,
  GroupKeyProvider,
  HumanRecoveryInventoryItem,
  HumanRecoveryKit,
  LatticeStorage,
  NamespaceObjectEnvelope,
  OpaqueAgentRuntimeConfigDek,
  PreparedDomainEpochAdvance,
  VerifiedRecoveryDeviceReadiness,
];

type RepresentativeWireTypes = [
  AgentManagerRecoveryPackageV2,
  AgentRuntimeDomainEnvelopeV1,
  EncryptedPayloadRecordV2,
  GrantV2,
  NamespaceBindingV2,
  NamespaceKeyringEnvelopeV2,
  ProviderPublicTransitionV2,
  ProviderRosterEntryV2,
  StorageAdapterSupportV2,
];

declare const rootRuntimeClosure: RootRuntimeClosure;
declare const wireRuntimeClosure: WireRuntimeClosure;
declare const representativeRootTypes: RepresentativeRootTypes;
declare const representativeWireTypes: RepresentativeWireTypes;

void rootRuntimeClosure;
void wireRuntimeClosure;
void representativeRootTypes;
void representativeWireTypes;

// @ts-expect-error implementation chronology is not a root API name
import type { V2Storage } from "@nautilo/lattice-crypto";
// @ts-expect-error wire records are not available from the clean root
import type { GrantV2 as RootGrantV2 } from "@nautilo/lattice-crypto";
// @ts-expect-error legacy characterization remains test-only
import type { Grant as LegacyGrant } from "@nautilo/lattice-crypto";
// @ts-expect-error opaque constructors are not a supported capability
import type { opaqueBytes } from "@nautilo/lattice-crypto";
// @ts-expect-error the former versioned public subpath does not exist
import type { V2GroupKeyProvider } from "@nautilo/lattice-crypto/public-v2";
// @ts-expect-error package source paths are not supported entry points
import type { V2GroupKeyProvider as InternalProvider } from "@nautilo/lattice-crypto/src/group/v2-provider.ts";

type ForbiddenImports = [
  V2Storage,
  RootGrantV2,
  LegacyGrant,
  opaqueBytes,
  V2GroupKeyProvider,
  InternalProvider,
];

declare const forbiddenImports: ForbiddenImports;
void forbiddenImports;
