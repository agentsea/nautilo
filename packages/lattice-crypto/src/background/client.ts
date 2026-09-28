/**
 * Narrow, platform-neutral imports for background authorization device codecs
 * and responders, including current Domain-key grants. This leaf deliberately excludes the package
 * root and broad wire barrel.
 */
export type { LatticeCrypto } from "../crypto/index.ts";

export {
  assertPortableId,
  authorizationRevision,
} from "../v2-types/ids.ts";
export { V2_LIMITS } from "../v2-types/limits.ts";
export type {
  AccessRevision,
  AuthorizationRevision,
  CryptoDeviceId,
  CryptoDomainId,
  DomainEpoch,
  HumanId,
  NamespaceId,
} from "../v2-types/ids.ts";

export {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
  backgroundWorkDescriptorDigestV1,
  decodeBackgroundWorkDescriptorV1,
  encodeBackgroundWorkDescriptorV1,
} from "./work-descriptor-v1.ts";
export type { BackgroundWorkDescriptorV1 } from "./work-descriptor-v1.ts";

export {
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
  TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1,
  TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "./task-runtime-request-v1.ts";
export type {
  TaskRuntimeBackgroundAuthorizationRequestV1,
  TaskRuntimeBackgroundAuthorizationWorkV1,
} from "./task-runtime-request-v1.ts";

export {
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1,
  createBackgroundAuthorizationResponseV1,
  decodeBackgroundAuthorizationResponseV1,
} from "./background-authorization-response-v1.ts";
export type { CreatedBackgroundAuthorizationResponseV1 } from
  "./background-authorization-response-v1.ts";
export type { BackgroundAuthorizationResponseV1 } from
  "./background-authorization-response-v1.ts";

export {
  createProcessorCredentialV1,
} from "./processor-credential-v1.ts";
export type { CreatedProcessorCredentialV1 } from
  "./processor-credential-v1.ts";

export {
  createProcessorObjectSignerPublicV1,
} from "./processor-object-signer-v1.ts";
export type { ProcessorObjectSignerPublicV1 } from
  "./processor-object-signer-v1.ts";

export {
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  createProcessorSignerAuthorizationV1,
  decodeProcessorSignerAuthorizationV1,
} from "./processor-signer-authorization-v1.ts";
export type { CreatedProcessorSignerAuthorizationV1 } from
  "./processor-signer-authorization-v1.ts";
export type { ProcessorSignerAuthorizationV1 } from
  "./processor-signer-authorization-v1.ts";

export {
  decodeBackgroundProcessorWorkDescriptorV2, encodeBackgroundWorkDescriptorV2,
  backgroundWorkDescriptorDigestV2, MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2,
  STENOGRAPHER_BACKGROUND_MAX_PLAINTEXT_BYTES_V2,
  STENOGRAPHER_BACKGROUND_MAX_TTL_MS_V2,
} from "./work-descriptor-v2.ts";
export type { BackgroundProcessorWorkDescriptorV2, BackgroundNamespaceAuthorityV2 } from "./work-descriptor-v2.ts";
export {
  createBackgroundAuthorizationResponseV2, decodeBackgroundAuthorizationResponseV2,
  inspectBackgroundAuthorizationResponseV2,
  verifyBackgroundAuthorizationResponseV2, verifyProcessorSignerAuthorizationV2,
  verifyHistoricalProcessorSignerAuthorizationV2,
  readProcessorSignerAuthorizationVersion,
  destroyVerifiedProcessorSignerAuthorizationV2,
  withOpenedBackgroundAuthorizationV2, BackgroundAuthorizationErrorV2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2,
} from "./processor-authorization-v2.ts";
export type {
  BackgroundAuthorizationIssuerV2, BackgroundAuthorizationIssuerContextV2,
  ResolveCurrentBackgroundAuthorizationIssuerV2, VerifiedBackgroundAuthorizationV2,
  ResolveHistoricalBackgroundAuthorizationIssuerV2,
  ProcessorSignerAuthorizationCertificateV2, VerifiedProcessorSignerAuthorizationV2,
} from "./processor-authorization-v2.ts";

export type {ProcessorTransformRunInputV2, ProcessorTransformObjectPortV2, ProcessorReconciliationRunInputV2, ProcessorReconciliationObjectPortV2} from "./one-run-processor-transform-v2.ts";

export {ProcessorReconciliationIntegrityErrorV2, copyPublicationReconciliationBindingV2, publicationReconciliationFingerprintV2} from "./publication-reconciliation-v2.ts";
export type {ProcessorPublicationReconciliationBindingV2} from "./publication-reconciliation-v2.ts";

export {ProcessorOutputRepairIntegrityErrorV2, stenographerOrdinaryOutputFingerprint, outputRepairFingerprintV2, copyOutputRepairBindingV2} from "./output-repair-v2.ts";
export type {StenographerOrdinaryOutputProvenance, ProcessorOutputRepairBindingV2} from "./output-repair-v2.ts";
export type {ProcessorOutputRepairRunInputV2, ProcessorOutputRepairObjectPortV2, ProcessorOutputRepairOrdinaryOutputV2} from "./one-run-processor-transform-v2.ts";

export {decodeBackgroundAgentWorkDescriptorV2, decodeBackgroundWorkDescriptorV2} from "./work-descriptor-v2.ts";
export type {BackgroundAgentWorkDescriptorV2} from "./work-descriptor-v2.ts";

export {
  decodeAnyBackgroundProcessorWorkDescriptorV2,
  backgroundProcessorNamespaceRequirementsV2,
  backgroundProcessorDomainRequirementsV2,
  BACKGROUND_REFLECTION_MAX_NAMESPACES_V2,
  REFLECTION_BACKGROUND_MAX_DOMAINS_V2,
  REFLECTION_BACKGROUND_MAX_INPUTS_V2,
  REFLECTION_BACKGROUND_MAX_OUTPUT_NAMESPACES_V2,
  REFLECTION_BACKGROUND_MAX_PLAINTEXT_BYTES_V2,
  REFLECTION_BACKGROUND_MAX_CIPHERTEXT_BYTES_V2,
  REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2,
  REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2,
  REFLECTION_SEMANTIC_MAX_PLAINTEXT_BYTES_V2,
  REFLECTION_SEMANTIC_MAX_CIPHERTEXT_BYTES_V2,
  MAX_BACKGROUND_REFLECTION_SEMANTIC_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_REFLECTION_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
} from "./work-descriptor-v2.ts";
export type {
  AnyBackgroundProcessorWorkDescriptorV2,
  BackgroundReflectionWorkDescriptorV2,
  BackgroundReflectionMaintenanceWorkDescriptorV2,
  BackgroundReflectionSemanticWorkDescriptorV2,
  BackgroundReflectionSemanticInputBindingV2,
  BackgroundReflectionNamespaceRequirementV2,
  BackgroundProcessorDomainRequirementV2,
} from "./work-descriptor-v2.ts";

export {withOpenedReflectionBackgroundAuthorizationV2} from "./processor-authorization-v2.ts";
export type {BackgroundProcessorDomainKeyV2, CreateBackgroundAuthorizationResponseInputV2,
  VerifiedReflectionBackgroundAuthorizationV2, VerifiedStenographerBackgroundAuthorizationV2} from "./processor-authorization-v2.ts";

export {reflectionAuthorityReconciliationFingerprintV2, type ReflectionAuthorityObjectPortV2, type ReflectionAuthorityRunInputV2, type ReflectionAuthorityReconciliationBindingV2, type ReflectionSemanticReconciliationBindingV2, type ReflectionPublicationReconciliationBindingV2} from "./reflection-authority-reprojection-v2.ts";

export type {ReflectionSemanticRunInputV2, ReflectionSemanticObjectPortV2, ReflectionSemanticInputV2, ReflectionSemanticOutputV2} from "./reflection-authority-reprojection-v2.ts";
