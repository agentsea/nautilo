/**
 * Test-only bridge entry point.
 *
 * Synthetic composition and fake storage helpers live behind this export and
 * are never re-exported by the production package root.
 */
export {
  createFakeLatticeStorage,
  FakeLatticeCommitOutcomeUnknown,
  FakeLatticeStorageFaults,
} from "./fake-lattice-storage.ts";
export type {
  FakeLatticeStorageFault,
  FakeLatticeStorageFaultOutcome,
  FakeLatticeStorageOperation,
} from "./fake-lattice-storage.ts";
export {
  LATTICE_STORAGE_METHODS,
  runLatticeStorageContract,
} from "./lattice-storage-contract.ts";
export type {
  LatticeStorageContractReport,
} from "./lattice-storage-contract.ts";
export {
  runSyntheticSharedDomainScenario,
} from "./synthetic-composition.ts";
export type {
  SyntheticSharedDomainScenarioReport,
} from "./synthetic-composition.ts";
export {
  MemoryClientProfileVault,
  createMemoryClientProfileVault,
  runClientProfileVaultConformance,
} from "./client-profile-vault.ts";
export {
  __mintAuthorizedHumanMemoryTestAuthorityForTesting,
  type AuthorizedHumanMemoryTestAuthority,
} from "../client/memory/authorized-human-memory-client.ts";
export {
  __mintHumanMemoryProtectedRouteTestAuthorityForTesting,
} from "../server/memory/human-memory-protected-route-ports.ts";
export {
  readPreparedDeviceWrappedAgentObjectSnapshot,
} from "../object/device-wrapped-agent-object-crypto.ts";
export type {
  HumanMemoryProtectedRouteTestAuthority,
} from "../server/memory/human-memory-protected-route-ports.ts";
export type {
  ClientProfileVaultConformanceReport,
} from "./client-profile-vault.ts";
export {
  FakeAtomicConversationCryptoCompletion,
  FakeConversationProductStore,
  createFakeConversationShadowHarness,
} from "./fake-conversation-shadow-repository.ts";
export {
  createSyntheticProtectedAgentConversationCryptoHarness,
} from "./protected-agent-conversation.ts";
export type {
  SyntheticProtectedAgentConversationCryptoHarness,
} from "./protected-agent-conversation.ts";
export {
  executeProtectedSyntheticBackgroundWorkV2,
  protectedSyntheticBackgroundObjectAadV2,
} from "../invocation/protected-background-synthetic-v2.ts";
export type {
  ProtectedSyntheticBackgroundEncryptedOutputV2,
  ProtectedSyntheticBackgroundInputV2,
  ProtectedSyntheticBackgroundPlaintextInputV2,
  ProtectedSyntheticBackgroundPlaintextOutputV2,
} from "../invocation/protected-background-synthetic-v2.ts";
export {
  MemoryDeviceLifecycleRepository,
  createSyntheticInitialDeviceAuthorizer,
} from "./device-lifecycle.ts";
export {
  MemoryAdditionalDeviceEnrollmentRepository,
  createSyntheticAdditionalDeviceAuthorizer,
} from "./additional-device-lifecycle.ts";
