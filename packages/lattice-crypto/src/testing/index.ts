export { World } from "./world.ts";
export type { WorldConfig, AgentGrant, ReadOutcome } from "./world.ts";
export { matrix } from "./matrix.ts";
export { v2ProviderMatrix } from "./v2-matrix.ts";
export type {
  V2ProviderFixture,
  V2ProviderMatrixRow,
} from "./v2-matrix.ts";
export {
  authorizeAgentRuntimeInitializationWriteV2
    as authorizeAgentRuntimeInitializationWriteForTesting,
} from "../agent-runtime/initialization-authorized-write.ts";
export {
  authorizeAgentRuntimeAuthorizationTransitionWriteV2
    as authorizeAgentRuntimeAuthorizationTransitionWriteForTesting,
  authorizeAgentRuntimeChallengeReservationWriteV2
    as authorizeAgentRuntimeChallengeReservationWriteForTesting,
  authorizeAgentRuntimeRotationWriteV2
    as authorizeAgentRuntimeRotationWriteForTesting,
} from "../agent-runtime/storage-authorized-write.ts";
export {
  authorizeNamespaceBindingWriteV2
    as authorizeNamespaceBindingWriteForTesting,
} from "../namespace/authorized-write.ts";
export {
  authorizeObjectAccessWriteV2
    as authorizeObjectAccessWriteForTesting,
} from "../object/authorized-write.ts";
export {
  authorizeProviderHeadWriteV2
    as authorizeProviderHeadWriteForTesting,
} from "../transition/provider-authorized-write.ts";
export * from "./v1-compat.ts";
export {
  agentRuntimeSignerPublicationForTesting,
} from "./agent-runtime-signer-publication.ts";
