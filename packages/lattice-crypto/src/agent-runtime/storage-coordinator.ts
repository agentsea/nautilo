import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  agentRuntimeDomainEnvelopeSigningBytes,
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../format/agent-runtime-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import type {
  AgentRuntimeAtomicStorageStateV2,
  AgentRuntimeAtomicStorageWireV2,
  AgentRuntimeChallengeReservationCasStatusV2,
  AgentRuntimeRotationCasStatusV2,
  AgentRuntimeRotationStorageExpectationV2,
  OpaqueAgentRuntimeConfigRecordV2,
  OpaqueAgentRuntimeDomainEnvelopeRecordV2,
} from "../storage/v2-records.ts";
import {
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  objectId,
} from "../v2-types/ids.ts";
import { assertV2Limit, V2_LIMITS } from "../v2-types/limits.ts";
import {
  authenticatedAgentRuntimeConfigDekV2,
  copyOwnedBytesV2,
  opaqueBytes,
} from "../v2-types/opaque.ts";
import type {
  AgentRuntimeAuthorizationDomainV2,
  AgentRuntimeRotationManagerV2,
  AgentRuntimeRotationStateV2,
  AtomicAgentRuntimeRotationCandidateV2,
} from "./runtime-rotation-v2.ts";
import {
  aggregateAgentRuntimeRotationV2,
  agentRuntimeConfigDekAadV2,
} from "./runtime-rotation-v2.ts";
import {
  sealAgentRuntimeToDomain,
} from "./domain-envelope.ts";
import {
  agentRuntimeInitializationSignerPublicationMatchesStateV1,
  agentRuntimeSignerPublicationMatchesRuntimeV1,
  createAgentRuntimeInitializationSignerPublicationV1,
  decodeAgentRuntimeSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
  verifyHistoricalAgentRuntimeSignerPublicationV1,
  type AgentRuntimeInitializationPublicStateV1,
  type AgentRuntimeSignerPublicationManagerV1,
  type AgentRuntimeSignerPublicationV1,
  type ResolveCurrentAgentRuntimeSignerPublicationManagerV1,
} from "./signer-publication-v1.ts";
import {
  authorizeAgentRuntimeInitializationWriteV2,
  type AuthorizedAgentRuntimeInitializationWriteV2,
} from "./initialization-authorized-write.ts";
import {
  authorizeAgentRuntimeChallengeReservationWriteV2,
  authorizeAgentRuntimeRotationWriteV2,
  type AuthorizedAgentRuntimeChallengeReservationWriteV2,
  type AuthorizedAgentRuntimeRotationWriteV2,
} from "./storage-authorized-write.ts";
import {
  AGENT_RUNTIME_KEY_BYTES,
  type AgentRuntimeDomainCommitterContextV1,
  type AgentRuntimeGenerationV2,
} from "./types.ts";

const HASH_BYTES = 32;
const CONFIG_INVENTORY_DOMAIN =
  "nautilo/lattice-crypto/agent-runtime-config-inventory/v1";

export interface AgentRuntimeRotationCasStorageV2 {
  getAgentRuntimeAtomicState(
    agentId: string,
  ): Promise<AgentRuntimeAtomicStorageWireV2 | null>;
  /**
   * A product adapter MUST compare `authorized.authorization` with current
   * manager and Agent/Domain-edge authority in the same transaction as CAS.
   */
  compareAndSwapAgentRuntimeRotation(
    authorized: AuthorizedAgentRuntimeRotationWriteV2,
  ): Promise<AgentRuntimeRotationCasStatusV2>;
}

export interface AgentRuntimeChallengeReservationStorageV2 {
  getAgentRuntimeAtomicState(
    agentId: string,
  ): Promise<AgentRuntimeAtomicStorageWireV2 | null>;
  /**
   * A product adapter MUST atomically compare the carried authorization
   * context with current manager and Agent/Domain-edge authority.
   */
  compareAndSwapAgentRuntimeChallengeReservations(
    authorized: AuthorizedAgentRuntimeChallengeReservationWriteV2,
  ): Promise<AgentRuntimeChallengeReservationCasStatusV2>;
}

export interface AgentRuntimeInitializationStorageV2 {
  getAgentRuntimeAtomicState(
    agentId: string,
  ): Promise<AgentRuntimeAtomicStorageWireV2 | null>;
  /**
   * Returns the exact append-only publication for one Runtime generation.
   * Missing history is distinct from an adapter/storage failure, which must
   * reject with a typed unavailable error.
   */
  getAgentRuntimeSignerPublication(
    agentId: string,
    runtimeGeneration: number,
  ): Promise<AgentRuntimeSignerPublicationV1 | null>;
  /**
   * A product adapter MUST atomically compare the carried authorization
   * context with current Agent/Domain-edge authority before inserting.
   */
  putAgentRuntimeAtomicStateIfAbsent(
    authorized: AuthorizedAgentRuntimeInitializationWriteV2,
  ): Promise<"inserted" | "existing" | "stale">;
}

export interface AgentRuntimeInitializationConfigV2 {
  readonly objectId: string;
  readonly configRevision: number;
  readonly plaintextDek: Uint8Array;
}

export interface AgentRuntimeInitializationDomainV2
  extends AgentRuntimeAuthorizationDomainV2 {
  readonly domainRoot: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export type ResolveCurrentAgentRuntimeInitializationDomainAuthorityV2 = (
  context: AgentRuntimeDomainCommitterContextV1,
) => Uint8Array | null | Promise<Uint8Array | null>;

export interface PreparedAgentRuntimeInitializationV2 {
  readonly runtime: AgentRuntimeGenerationV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
}

export interface AgentRuntimeInitializationAuthorizedDomainV2
  extends AgentRuntimeAuthorizationDomainV2 {
  readonly committerSigningPublicKey: Uint8Array;
}

export interface AgentRuntimeInitializationPersistenceAuthorizationV2 {
  readonly currentState: AgentRuntimeRotationStateV2;
  readonly currentManager: AgentRuntimeSignerPublicationManagerV1;
  readonly currentManagerSigningPublicKey: Uint8Array;
  readonly domains: readonly AgentRuntimeInitializationAuthorizedDomainV2[];
}

export interface AgentRuntimeInitializationPersistenceContextV2 {
  readonly purpose: "persist-agent-runtime-initialization";
  readonly operationId: string;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly expectedManager: AgentRuntimeSignerPublicationManagerV1;
  readonly configInventory: Readonly<{
    readonly objectCount: number;
    readonly digest: Uint8Array;
  }>;
  readonly expectedDomains: readonly AgentRuntimeAuthorizationDomainV2[];
}

export interface AgentRuntimeInitializationCasAuthorizationV2 {
  readonly context: AgentRuntimeInitializationPersistenceContextV2;
  readonly currentManager: AgentRuntimeSignerPublicationManagerV1;
  readonly currentManagerSigningPublicKey: Uint8Array;
  readonly authorizedDomains:
    readonly AgentRuntimeInitializationAuthorizedDomainV2[];
}

export type ResolveCurrentAgentRuntimeInitializationAuthorizationV2 = (
  context: AgentRuntimeInitializationPersistenceContextV2,
) =>
  | AgentRuntimeInitializationPersistenceAuthorizationV2
  | null
  | Promise<AgentRuntimeInitializationPersistenceAuthorizationV2 | null>;

export type AgentRuntimeInitializationStatusV2 =
  | "inserted"
  | "duplicate"
  | "stale";

/**
 * A fresh host result at the CAS boundary. The core does not infer the
 * authorization graph; it requires the exact live Runtime state and exact
 * remaining authorized Domain set.
 */
export interface AgentRuntimeRotationPersistenceAuthorizationV2 {
  readonly currentState: AgentRuntimeRotationStateV2;
  readonly currentManager: AgentRuntimeRotationManagerV2 | null;
  readonly currentManagerSigningPublicKey: Uint8Array;
  readonly remainingDomains:
    readonly AgentRuntimeRotationAuthorizedDomainV2[];
}

export interface AgentRuntimeRotationAuthorizedDomainV2
  extends AgentRuntimeAuthorizationDomainV2 {
  readonly committerSigningPublicKey: Uint8Array;
}

export interface AgentRuntimeRotationPersistenceContextV2 {
  readonly purpose: "persist-agent-runtime-rotation";
  readonly operationId: string;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly nextState: AgentRuntimeRotationStateV2;
  readonly expectedManager: AgentRuntimeRotationManagerV2;
}

export interface AgentRuntimeRotationCasAuthorizationV2 {
  readonly context: AgentRuntimeRotationPersistenceContextV2;
  readonly currentState: AgentRuntimeRotationStateV2;
  readonly currentManager: AgentRuntimeRotationManagerV2;
  readonly currentManagerSigningPublicKey: Uint8Array;
  readonly remainingDomains:
    readonly AgentRuntimeRotationAuthorizedDomainV2[];
}

export type ResolveCurrentAgentRuntimeRotationPersistenceAuthorizationV2 = (
  context: AgentRuntimeRotationPersistenceContextV2,
) =>
  | AgentRuntimeRotationPersistenceAuthorizationV2
  | null
  | Promise<AgentRuntimeRotationPersistenceAuthorizationV2 | null>;

export interface AgentRuntimeChallengeReservationRequestV2 {
  readonly operationId: string;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly currentManager: AgentRuntimeRotationManagerV2;
  readonly remainingDomains: readonly AgentRuntimeAuthorizationDomainV2[];
  readonly challengeHashes: readonly Uint8Array[];
}

export interface AgentRuntimeChallengeReservationAuthorizationContextV2 {
  readonly purpose: "reserve-agent-runtime-rotation-challenges";
  readonly operationId: string;
  readonly expectedState: AgentRuntimeRotationStateV2;
  readonly expectedManager: AgentRuntimeRotationManagerV2;
  readonly remainingDomains: readonly AgentRuntimeAuthorizationDomainV2[];
  readonly challengeHashes: readonly Uint8Array[];
}

export type ResolveCurrentAgentRuntimeChallengeReservationAuthorizationV2 = (
  context: AgentRuntimeChallengeReservationAuthorizationContextV2,
) =>
  | AgentRuntimeRotationPersistenceAuthorizationV2
  | null
  | Promise<AgentRuntimeRotationPersistenceAuthorizationV2 | null>;

export class AgentRuntimeRotationOutcomeUnknownV2 extends Error {
  override readonly name = "AgentRuntimeRotationOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Agent Runtime rotation storage outcome is ambiguous; retry must be explicit",
      { cause },
    );
  }
}

export class AgentRuntimeChallengeReservationOutcomeUnknownV2 extends Error {
  override readonly name = "AgentRuntimeChallengeReservationOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Agent Runtime challenge reservation storage outcome is ambiguous; retry must be explicit",
      { cause },
    );
  }
}

export class AgentRuntimeInitializationOutcomeUnknownV2 extends Error {
  override readonly name = "AgentRuntimeInitializationOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Agent Runtime initialization storage outcome is ambiguous; retry must be explicit",
      { cause },
    );
  }
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
    fields.length !== expected.length
    || fields.some((field) => !expected.includes(field))
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function assertHash(label: string, value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new RangeError(`${label} must contain exactly ${HASH_BYTES} bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

function canonicalPlainValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return ["bytes", ...value];
  if (Array.isArray(value)) return value.map(canonicalPlainValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      canonicalPlainValue((value as Record<string, unknown>)[key]),
    ]),
  );
}

function exactStructuredValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalPlainValue(left))
    === JSON.stringify(canonicalPlainValue(right));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function comparePortableIds(left: string, right: string): number {
  return compareBytes(utf8V2(left), utf8V2(right));
}

function cloneState(
  state: AgentRuntimeRotationStateV2,
): AgentRuntimeRotationStateV2 {
  assertExactFields("Agent Runtime rotation state", state, [
    "agentId",
    "authorizationRevision",
    "runtimeGeneration",
  ]);
  return Object.freeze({
    agentId: agentId(state.agentId),
    authorizationRevision:
      authorizationRevision(state.authorizationRevision),
    runtimeGeneration: agentRuntimeGeneration(state.runtimeGeneration),
  });
}

function cloneDomain(
  domain: AgentRuntimeAuthorizationDomainV2,
): AgentRuntimeAuthorizationDomainV2 {
  assertExactFields("Agent Runtime authorization Domain", domain, [
    "domainId",
    "domainEpoch",
    "agentAuthorizationRevision",
    "committerDeviceId",
  ]);
  return Object.freeze({
    domainId: cryptoDomainId(domain.domainId),
    domainEpoch: domainEpoch(domain.domainEpoch),
    agentAuthorizationRevision:
      authorizationRevision(domain.agentAuthorizationRevision),
    committerDeviceId: cryptoDeviceId(domain.committerDeviceId),
  });
}

function configInventoryDigest(
  crypto: LatticeCrypto,
  entries: readonly Readonly<{
    readonly agentId: string;
    readonly objectId: string;
    readonly configRevision: number;
    readonly runtimeGeneration: number;
    readonly wrappedDekHash: Uint8Array;
  }>[],
): Uint8Array {
  return copyOwnedBytesV2(
    crypto.hash(concatV2(
      frameText(CONFIG_INVENTORY_DOMAIN),
      encodeU32(1),
      encodeU32(entries.length),
      ...entries.map((entry) =>
        concatV2(
          frameText(entry.agentId),
          frameText(entry.objectId),
          encodeU64(entry.configRevision),
          encodeU64(entry.runtimeGeneration),
          frame(entry.wrappedDekHash),
        )
      ),
    )),
  );
}

function preflightAndCloneCandidate(
  candidate: AtomicAgentRuntimeRotationCandidateV2,
): AtomicAgentRuntimeRotationCandidateV2 {
  assertExactFields("Atomic Agent Runtime rotation candidate", candidate, [
    "publicCandidate",
    "completedTargets",
    "operationId",
    "currentManager",
    "expectedState",
    "nextState",
    "expectedConfigInventory",
    "configRewraps",
    "domainEnvelopes",
  ]);
  if (
    !Array.isArray(candidate.completedTargets as unknown)
    || !Array.isArray(candidate.configRewraps as unknown)
    || !Array.isArray(candidate.domainEnvelopes as unknown)
  ) {
    throw new TypeError(
      "Atomic Agent Runtime rotation candidate inventories must be arrays",
    );
  }
  assertV2Limit(
    "Atomic Agent Runtime rotation completed target count",
    candidate.completedTargets.length,
    V2_LIMITS.agentGrantDomains,
  );
  assertV2Limit(
    "Atomic Agent Runtime rotation config rewrap count",
    candidate.configRewraps.length,
    V2_LIMITS.batchItems,
  );
  assertV2Limit(
    "Atomic Agent Runtime rotation Domain envelope count",
    candidate.domainEnvelopes.length,
    V2_LIMITS.agentGrantDomains,
  );
  assertExactFields(
    "Atomic Agent Runtime rotation current manager",
    candidate.currentManager,
    [
      "managerHumanId",
      "managerAuthorizationRevision",
      "managerDeviceId",
    ],
  );
  const currentManager = Object.freeze({
    managerHumanId: humanId(candidate.currentManager.managerHumanId),
    managerAuthorizationRevision:
      authorizationRevision(
        candidate.currentManager.managerAuthorizationRevision,
      ),
    managerDeviceId: cryptoDeviceId(candidate.currentManager.managerDeviceId),
  });
  const expectedState = cloneState(candidate.expectedState);
  const nextState = cloneState(candidate.nextState);
  assertExactFields(
    "Atomic Agent Runtime rotation expected config inventory",
    candidate.expectedConfigInventory,
    ["objectCount", "digest"],
  );
  assertHash(
    "Atomic Agent Runtime rotation expected config inventory digest",
    candidate.expectedConfigInventory.digest,
  );
  const configRewraps = candidate.configRewraps.map((rewrap) => {
    assertExactFields(
      "Atomic Agent Runtime rotation config rewrap",
      rewrap,
      ["expected", "nextWrappedDek"],
    );
    assertExactFields(
      "Atomic Agent Runtime rotation expected config rewrap",
      rewrap.expected,
      [
        "agentId",
        "objectId",
        "configRevision",
        "runtimeGeneration",
        "wrappedDekHash",
      ],
    );
    assertExactFields(
      "Atomic Agent Runtime rotation wrapped DEK",
      rewrap.nextWrappedDek,
      ["classification", "kind", "ciphertext"],
    );
    assertHash(
      "Atomic Agent Runtime rotation expected wrapped-DEK hash",
      rewrap.expected.wrappedDekHash,
    );
    if (
      rewrap.nextWrappedDek.classification !== "opaque-ciphertext"
      || rewrap.nextWrappedDek.kind !== "agent-runtime-config-dek"
      || !(rewrap.nextWrappedDek.ciphertext instanceof Uint8Array)
    ) {
      throw new TypeError(
        "Atomic Agent Runtime rotation wrapped DEK must be opaque ciphertext",
      );
    }
    assertV2Limit(
      "Atomic Agent Runtime rotation wrapped DEK bytes",
      rewrap.nextWrappedDek.ciphertext.length,
      V2_LIMITS.wrappedDekBytes,
    );
    return Object.freeze({
      expected: Object.freeze({
        agentId: agentId(rewrap.expected.agentId),
        objectId: objectId(rewrap.expected.objectId),
        configRevision:
          authorizationRevision(rewrap.expected.configRevision),
        runtimeGeneration:
          agentRuntimeGeneration(rewrap.expected.runtimeGeneration),
        wrappedDekHash: copyOwnedBytesV2(
          rewrap.expected.wrappedDekHash,
        ),
      }),
      nextWrappedDek: opaqueBytes(
        "agent-runtime-config-dek",
        rewrap.nextWrappedDek.ciphertext,
      ),
    });
  });
  const domainEnvelopes = candidate.domainEnvelopes.map((entry) => {
    assertExactFields(
      "Atomic Agent Runtime rotation Domain envelope entry",
      entry,
      ["expectedDomain", "envelopeBytes", "challengeConsumption"],
    );
    assertExactFields(
      "Atomic Agent Runtime rotation Domain envelope",
      entry.envelopeBytes,
      ["classification", "kind", "ciphertext"],
    );
    assertExactFields(
      "Atomic Agent Runtime rotation challenge consumption",
      entry.challengeConsumption,
      ["challengeHash", "expectedConsumed", "intendedConsumed"],
    );
    if (
      entry.envelopeBytes.classification !== "opaque-ciphertext"
      || entry.envelopeBytes.kind !== "agent-runtime-domain-envelope"
      || !(entry.envelopeBytes.ciphertext instanceof Uint8Array)
    ) {
      throw new TypeError(
        "Atomic Agent Runtime rotation Domain envelope must be opaque ciphertext",
      );
    }
    assertV2Limit(
      "Atomic Agent Runtime rotation Domain envelope bytes",
      entry.envelopeBytes.ciphertext.length,
      V2_LIMITS.ciphertextBytes,
    );
    assertHash(
      "Atomic Agent Runtime rotation challenge hash",
      entry.challengeConsumption.challengeHash,
    );
    if (
      entry.challengeConsumption.expectedConsumed !== false
      || entry.challengeConsumption.intendedConsumed !== true
    ) {
      throw new Error(
        "Atomic Agent Runtime rotation challenge consumption intent is invalid",
      );
    }
    return Object.freeze({
      expectedDomain: cloneDomain(entry.expectedDomain),
      envelopeBytes: opaqueBytes(
        "agent-runtime-domain-envelope",
        entry.envelopeBytes.ciphertext,
      ),
      challengeConsumption: Object.freeze({
        challengeHash: copyOwnedBytesV2(
          entry.challengeConsumption.challengeHash,
        ),
        expectedConsumed: false as const,
        intendedConsumed: true as const,
      }),
    });
  });
  return Object.freeze({
    publicCandidate: structuredClone(candidate.publicCandidate),
    completedTargets: Object.freeze(
      structuredClone(candidate.completedTargets),
    ),
    operationId: candidate.operationId,
    currentManager,
    expectedState,
    nextState,
    expectedConfigInventory: Object.freeze({
      objectCount: candidate.expectedConfigInventory.objectCount,
      digest: copyOwnedBytesV2(
        candidate.expectedConfigInventory.digest,
      ),
    }),
    configRewraps: Object.freeze(configRewraps),
    domainEnvelopes: Object.freeze(domainEnvelopes),
  });
}

function preflightAndCloneAuthorization(
  authorization: AgentRuntimeRotationPersistenceAuthorizationV2,
): AgentRuntimeRotationPersistenceAuthorizationV2 {
  assertExactFields(
    "Agent Runtime rotation persistence authorization",
    authorization,
    [
      "currentState",
      "currentManager",
      "currentManagerSigningPublicKey",
      "remainingDomains",
    ],
  );
  if (!Array.isArray(authorization.remainingDomains as unknown)) {
    throw new TypeError(
      "Agent Runtime remaining authorization Domains must be an array",
    );
  }
  assertV2Limit(
    "Agent Runtime remaining authorization Domain count",
    authorization.remainingDomains.length,
    V2_LIMITS.agentGrantDomains,
  );
  if (authorization.currentManager !== null) {
    assertExactFields(
      "Agent Runtime rotation persistence manager",
      authorization.currentManager,
      [
        "managerHumanId",
        "managerAuthorizationRevision",
        "managerDeviceId",
      ],
    );
  }
  return Object.freeze({
    currentState: cloneState(authorization.currentState),
    currentManager: authorization.currentManager === null
      ? null
      : Object.freeze({
        managerHumanId: humanId(
          authorization.currentManager.managerHumanId,
        ),
        managerAuthorizationRevision: authorizationRevision(
          authorization.currentManager.managerAuthorizationRevision,
        ),
        managerDeviceId: cryptoDeviceId(
          authorization.currentManager.managerDeviceId,
        ),
      }),
    currentManagerSigningPublicKey: exactSecretBytes(
      "Current Agent Runtime manager signing public key",
      authorization.currentManagerSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    ),
    remainingDomains: Object.freeze(
      authorization.remainingDomains.map((domain) => {
        assertExactFields(
          "Agent Runtime rotation authorized Domain",
          domain,
          [
            "domainId",
            "domainEpoch",
            "agentAuthorizationRevision",
            "committerDeviceId",
            "committerSigningPublicKey",
          ],
        );
        return Object.freeze({
          ...cloneDomain({
            domainId: domain.domainId,
            domainEpoch: domain.domainEpoch,
            agentAuthorizationRevision:
              domain.agentAuthorizationRevision,
            committerDeviceId: domain.committerDeviceId,
          }),
          committerSigningPublicKey: exactSecretBytes(
            "Current Agent Runtime Domain committer signing public key",
            domain.committerSigningPublicKey,
            V2_LIMITS.signingPublicKeyBytes,
          ),
        });
      }),
    ),
  });
}

function equalManager(
  left: AgentRuntimeRotationManagerV2 | null,
  right: AgentRuntimeRotationManagerV2,
): boolean {
  return (
    left !== null
    && left.managerHumanId === right.managerHumanId
    && left.managerAuthorizationRevision
      === right.managerAuthorizationRevision
    && left.managerDeviceId === right.managerDeviceId
  );
}

function cloneAtomicStorageState(
  state: AgentRuntimeAtomicStorageWireV2,
): AgentRuntimeAtomicStorageStateV2 {
  assertExactFields("Stored Agent Runtime atomic state", state, [
    "runtime",
    "configInventory",
    "configObjects",
    "domainEnvelopes",
    "challengeConsumptions",
  ]);
  if (
    !Array.isArray(state.configObjects as unknown)
    || !Array.isArray(state.domainEnvelopes as unknown)
    || !Array.isArray(state.challengeConsumptions as unknown)
  ) {
    throw new TypeError("Stored Agent Runtime inventories must be arrays");
  }
  assertV2Limit(
    "Stored Agent Runtime config count",
    state.configObjects.length,
    V2_LIMITS.batchItems,
  );
  assertV2Limit(
    "Stored Agent Runtime Domain envelope count",
    state.domainEnvelopes.length,
    V2_LIMITS.agentGrantDomains,
  );
  assertV2Limit(
    "Stored Agent Runtime challenge count",
    state.challengeConsumptions.length,
    V2_LIMITS.agentGrantDomains,
  );
  assertExactFields("Stored Agent Runtime config inventory", state.configInventory, [
    "objectCount",
    "digest",
  ]);
  assertHash(
    "Stored Agent Runtime config inventory digest",
    state.configInventory.digest,
  );
  assertV2Limit(
    "Stored Agent Runtime config inventory count",
    state.configInventory.objectCount,
    V2_LIMITS.batchItems,
  );
  const runtime = cloneState(state.runtime);
  const configObjects = state.configObjects.map((object) => {
    assertExactFields("Stored Agent Runtime config object", object, [
      "agentId",
      "objectId",
      "configRevision",
      "runtimeGeneration",
      "wrappedDekHash",
      "wrappedDekBytes",
    ]);
    if (
      !(object.wrappedDekBytes instanceof Uint8Array)
      || object.wrappedDekBytes.length < 40
      || object.wrappedDekBytes.length > V2_LIMITS.wrappedDekBytes
    ) {
      throw new TypeError(
        "Stored Agent Runtime wrapped DEK must be bounded opaque ciphertext",
      );
    }
    assertHash("Stored Agent Runtime wrapped-DEK hash", object.wrappedDekHash);
    const normalized = Object.freeze({
      agentId: agentId(object.agentId),
      objectId: objectId(object.objectId),
      configRevision: authorizationRevision(object.configRevision),
      runtimeGeneration:
        agentRuntimeGeneration(object.runtimeGeneration),
      wrappedDekHash: copyOwnedBytesV2(object.wrappedDekHash),
      wrappedDek:
        authenticatedAgentRuntimeConfigDekV2(object.wrappedDekBytes),
    });
    if (
      normalized.agentId !== runtime.agentId
      || normalized.runtimeGeneration !== runtime.runtimeGeneration
      || !equalBytes(
        sha256(normalized.wrappedDek.ciphertext),
        normalized.wrappedDekHash,
      )
    ) {
      throw new Error(
        "Stored Agent Runtime config object is inconsistent",
      );
    }
    return normalized;
  });
  if (state.configInventory.objectCount !== configObjects.length) {
    throw new Error(
      "Stored Agent Runtime config inventory count is inconsistent",
    );
  }
  for (let index = 1; index < configObjects.length; index += 1) {
    if (
      comparePortableIds(
        configObjects[index - 1]!.objectId,
        configObjects[index]!.objectId,
      ) >= 0
    ) {
      throw new Error(
        "Stored Agent Runtime config objects must be sorted and unique",
      );
    }
  }
  if (
    !equalBytes(
      sha256(concatV2(
        frameText(CONFIG_INVENTORY_DOMAIN),
        encodeU32(1),
        encodeU32(configObjects.length),
        ...configObjects.map((object) =>
          concatV2(
            frameText(object.agentId),
            frameText(object.objectId),
            encodeU64(object.configRevision),
            encodeU64(object.runtimeGeneration),
            frame(object.wrappedDekHash),
          )
        ),
      )),
      state.configInventory.digest,
    )
  ) {
    throw new Error(
      "Stored Agent Runtime config inventory digest is inconsistent",
    );
  }
  let domainBytes = 0;
  const domainEnvelopes = state.domainEnvelopes.map((envelope) => {
    assertExactFields("Stored Agent Runtime Domain envelope", envelope, [
      "agentId",
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
      "runtimeGeneration",
      "committerDeviceId",
      "envelopeHash",
      "envelopeBytes",
    ]);
    if (!(envelope.envelopeBytes instanceof Uint8Array)) {
      throw new TypeError(
        "Stored Agent Runtime Domain envelope must be opaque ciphertext",
      );
    }
    assertV2Limit(
      "Stored Agent Runtime Domain envelope bytes",
      envelope.envelopeBytes.length,
      V2_LIMITS.ciphertextBytes,
    );
    domainBytes += envelope.envelopeBytes.length;
    assertV2Limit(
      "Stored Agent Runtime aggregate Domain envelope bytes",
      domainBytes,
      V2_LIMITS.manifestEnvelopeBytes,
    );
    assertHash("Stored Agent Runtime Domain envelope hash", envelope.envelopeHash);
    const decoded = parseAgentRuntimeDomainEnvelope(envelope.envelopeBytes);
    const normalized = Object.freeze({
      agentId: agentId(envelope.agentId),
      domainId: cryptoDomainId(envelope.domainId),
      domainEpoch: domainEpoch(envelope.domainEpoch),
      agentAuthorizationRevision:
        authorizationRevision(envelope.agentAuthorizationRevision),
      runtimeGeneration:
        agentRuntimeGeneration(envelope.runtimeGeneration),
      committerDeviceId: cryptoDeviceId(envelope.committerDeviceId),
      envelopeHash: copyOwnedBytesV2(envelope.envelopeHash),
      envelopeBytes: opaqueBytes(
        "agent-runtime-domain-envelope",
        envelope.envelopeBytes,
      ),
    });
    if (
      normalized.agentId !== runtime.agentId
      || normalized.runtimeGeneration !== runtime.runtimeGeneration
      || !equalBytes(
        sha256(normalized.envelopeBytes.ciphertext),
        normalized.envelopeHash,
      )
      || !equalBytes(
        serializeAgentRuntimeDomainEnvelope(decoded),
        normalized.envelopeBytes.ciphertext,
      )
      || decoded.agentId !== normalized.agentId
      || decoded.domainId !== normalized.domainId
      || decoded.domainEpoch !== normalized.domainEpoch
      || decoded.agentAuthorizationRevision
        !== normalized.agentAuthorizationRevision
      || decoded.runtimeGeneration !== normalized.runtimeGeneration
      || decoded.committerDeviceId !== normalized.committerDeviceId
    ) {
      throw new Error(
        "Stored Agent Runtime Domain envelope is noncanonical or inconsistent",
      );
    }
    return normalized;
  });
  for (let index = 1; index < domainEnvelopes.length; index += 1) {
    if (
      comparePortableIds(
        domainEnvelopes[index - 1]!.domainId,
        domainEnvelopes[index]!.domainId,
      ) >= 0
    ) {
      throw new Error(
        "Stored Agent Runtime Domain envelopes must be sorted and unique",
      );
    }
  }
  let priorChallenge: Uint8Array | undefined;
  const challengeConsumptions = state.challengeConsumptions.map(
    (challenge) => {
    assertExactFields("Stored Agent Runtime challenge", challenge, [
      "challengeHash",
      "consumed",
    ]);
    assertHash("Stored Agent Runtime challenge hash", challenge.challengeHash);
    if (typeof challenge.consumed !== "boolean") {
      throw new TypeError(
        "Stored Agent Runtime challenge consumed state must be boolean",
      );
    }
    if (
      priorChallenge !== undefined
      && compareBytes(priorChallenge, challenge.challengeHash) >= 0
    ) {
      throw new Error(
        "Stored Agent Runtime challenges must be sorted and unique",
      );
    }
    priorChallenge = challenge.challengeHash;
    return Object.freeze({
      challengeHash: copyOwnedBytesV2(challenge.challengeHash),
      consumed: challenge.consumed,
    });
    },
  );
  return Object.freeze({
    runtime,
    configInventory: Object.freeze({
      objectCount: state.configInventory.objectCount,
      digest: copyOwnedBytesV2(state.configInventory.digest),
    }),
    configObjects: Object.freeze(configObjects),
    domainEnvelopes: Object.freeze(domainEnvelopes),
    challengeConsumptions: Object.freeze(challengeConsumptions),
  });
}

function exactSecretBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must contain exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function cloneInitializationWriteState(
  state: AgentRuntimeAtomicStorageStateV2,
): AgentRuntimeAtomicStorageStateV2 {
  return Object.freeze({
    runtime: Object.freeze({ ...state.runtime }),
    configInventory: Object.freeze({
      objectCount: state.configInventory.objectCount,
      digest: copyOwnedBytesV2(state.configInventory.digest),
    }),
    configObjects: Object.freeze(state.configObjects.map((entry) =>
      Object.freeze({
        agentId: entry.agentId,
        objectId: entry.objectId,
        configRevision: entry.configRevision,
        runtimeGeneration: entry.runtimeGeneration,
        wrappedDekHash: copyOwnedBytesV2(entry.wrappedDekHash),
        wrappedDek:
          authenticatedAgentRuntimeConfigDekV2(
            entry.wrappedDek.ciphertext,
          ),
      })
    )),
    domainEnvelopes: Object.freeze(state.domainEnvelopes.map((entry) =>
      Object.freeze({
        agentId: entry.agentId,
        domainId: entry.domainId,
        domainEpoch: entry.domainEpoch,
        agentAuthorizationRevision: entry.agentAuthorizationRevision,
        runtimeGeneration: entry.runtimeGeneration,
        committerDeviceId: entry.committerDeviceId,
        envelopeHash: copyOwnedBytesV2(entry.envelopeHash),
        envelopeBytes: opaqueBytes(
          "agent-runtime-domain-envelope",
          entry.envelopeBytes.ciphertext,
        ),
      })
    )),
    challengeConsumptions: Object.freeze([]),
  });
}

function validatePreparedAgentRuntimeInitialization(
  crypto: LatticeCrypto,
  prepared: PreparedAgentRuntimeInitializationV2,
): AgentRuntimeAtomicStorageStateV2 {
  assertExactFields("Agent Runtime initialization preparation", prepared, [
    "runtime",
    "intended",
    "signerPublication",
  ]);
  assertExactFields("Agent Runtime initialization local Runtime", prepared.runtime, [
    "agentId",
    "keyClass",
    "generation",
    "key",
  ]);
  if (
    prepared.runtime.keyClass !== "runtime"
    || !(prepared.runtime.key instanceof Uint8Array)
    || prepared.runtime.key.length !== AGENT_RUNTIME_KEY_BYTES
  ) {
    throw new Error(
      "Agent Runtime initialization preparation is malformed",
    );
  }
  assertExactFields("Agent Runtime initialization intended state", prepared.intended, [
    "runtime",
    "configInventory",
    "configObjects",
    "domainEnvelopes",
    "challengeConsumptions",
  ]);
  if (
    !Array.isArray(prepared.intended.configObjects as unknown)
    || !Array.isArray(prepared.intended.domainEnvelopes as unknown)
    || !Array.isArray(prepared.intended.challengeConsumptions as unknown)
  ) {
    throw new TypeError(
      "Agent Runtime initialization intended inventories must be arrays",
    );
  }
  const intended = cloneAtomicStorageState({
    runtime: prepared.intended.runtime,
    configInventory: prepared.intended.configInventory,
    configObjects: prepared.intended.configObjects.map((entry) => ({
      agentId: entry.agentId,
      objectId: entry.objectId,
      configRevision: entry.configRevision,
      runtimeGeneration: entry.runtimeGeneration,
      wrappedDekHash: entry.wrappedDekHash,
      wrappedDekBytes: entry.wrappedDek.ciphertext,
    })),
    domainEnvelopes: prepared.intended.domainEnvelopes.map((entry) => ({
      agentId: entry.agentId,
      domainId: entry.domainId,
      domainEpoch: entry.domainEpoch,
      agentAuthorizationRevision: entry.agentAuthorizationRevision,
      runtimeGeneration: entry.runtimeGeneration,
      committerDeviceId: entry.committerDeviceId,
      envelopeHash: entry.envelopeHash,
      envelopeBytes: entry.envelopeBytes.ciphertext,
    })),
    challengeConsumptions: prepared.intended.challengeConsumptions,
  });
  if (
    agentId(prepared.runtime.agentId) !== intended.runtime.agentId
    || agentRuntimeGeneration(prepared.runtime.generation)
      !== intended.runtime.runtimeGeneration
    || intended.runtime.runtimeGeneration !== 0
    || intended.challengeConsumptions.length !== 0
  ) {
    throw new Error(
      "Agent Runtime initialization preparation coordinates are inconsistent",
    );
  }
  if (
    !agentRuntimeInitializationSignerPublicationMatchesStateV1(
      crypto,
      prepared.signerPublication,
      initializationPublicState(intended),
    )
    || !agentRuntimeSignerPublicationMatchesRuntimeV1(
      crypto,
      prepared.runtime,
      prepared.signerPublication,
    )
  ) {
    throw new Error(
      "Agent Runtime initialization signer publication does not match its intended atomic state",
    );
  }
  for (const record of intended.configObjects) {
    const plaintext = crypto.aeadOpen(
      prepared.runtime.key,
      record.wrappedDek.ciphertext,
      agentRuntimeConfigDekAadV2({
        agentId: agentId(record.agentId),
        objectId: objectId(record.objectId),
        configRevision: authorizationRevision(record.configRevision),
        runtimeGeneration:
          agentRuntimeGeneration(record.runtimeGeneration),
      }),
    );
    if (plaintext === null) {
      throw new Error(
        "Agent Runtime initialization wrapped config DEK is invalid",
      );
    }
    try {
      if (plaintext.length !== 32) {
        throw new Error(
          "Agent Runtime initialization wrapped config DEK is invalid",
        );
      }
    } finally {
      plaintext.fill(0);
    }
  }
  return intended;
}

function initializationPublicState(
  intended: AgentRuntimeAtomicStorageStateV2,
): AgentRuntimeInitializationPublicStateV1 {
  return Object.freeze({
    agentId: agentId(intended.runtime.agentId),
    authorizationRevision:
      authorizationRevision(intended.runtime.authorizationRevision),
    runtimeGeneration:
      agentRuntimeGeneration(intended.runtime.runtimeGeneration),
    configInventory: Object.freeze({
      objectCount: intended.configInventory.objectCount,
      digest: intended.configInventory.digest,
    }),
    domainEnvelopes: Object.freeze(
      intended.domainEnvelopes.map((entry) => Object.freeze({
        agentId: agentId(entry.agentId),
        domainId: cryptoDomainId(entry.domainId),
        domainEpoch: domainEpoch(entry.domainEpoch),
        agentAuthorizationRevision:
          authorizationRevision(entry.agentAuthorizationRevision),
        runtimeGeneration:
          agentRuntimeGeneration(entry.runtimeGeneration),
        committerDeviceId: cryptoDeviceId(entry.committerDeviceId),
        envelopeHash: entry.envelopeHash,
      })),
    ),
  });
}

/**
 * Produce the only supported initial Runtime write. At least one config DEK
 * is required so a detached preparation can prove that its Runtime key still
 * opens the committed write set after restart. Plaintext
 * config DEKs, Domain roots, and committer private keys are copied before the
 * first await and wiped after their authenticated ciphertexts are built.
 */
export async function prepareAgentRuntimeInitializationV2(input: {
  readonly crypto: LatticeCrypto;
  readonly operationId: string;
  readonly agentId: string;
  readonly authorizationRevision: number;
  readonly configObjects: readonly AgentRuntimeInitializationConfigV2[];
  readonly domains: readonly AgentRuntimeInitializationDomainV2[];
  readonly resolveCurrentDomainCommitterAuthority:
    ResolveCurrentAgentRuntimeInitializationDomainAuthorityV2;
  readonly manager: AgentRuntimeSignerPublicationManagerV1;
  readonly managerSigningPrivateKey: Uint8Array;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentRuntimeSignerPublicationManagerV1;
}): Promise<PreparedAgentRuntimeInitializationV2> {
  assertExactFields("Agent Runtime initialization input", input, [
    "crypto",
    "operationId",
    "agentId",
    "authorizationRevision",
    "configObjects",
    "domains",
    "resolveCurrentDomainCommitterAuthority",
    "manager",
    "managerSigningPrivateKey",
    "resolveCurrentManagerAuthority",
  ]);
  assertPortableId(
    "Agent Runtime initialization operation id",
    input.operationId,
  );
  const targetAgentId = agentId(input.agentId);
  const targetAuthorizationRevision =
    authorizationRevision(input.authorizationRevision);
  const targetRuntimeGeneration = agentRuntimeGeneration(0);
  if (!Array.isArray(input.configObjects as unknown)) {
    throw new TypeError(
      "Agent Runtime initialization config objects must be an array",
    );
  }
  if (!Array.isArray(input.domains as unknown)) {
    throw new TypeError(
      "Agent Runtime initialization Domains must be an array",
    );
  }
  if (input.configObjects.length === 0) {
    throw new Error(
      "Agent Runtime initialization must contain at least one config object",
    );
  }
  assertV2Limit(
    "Agent Runtime initialization config count",
    input.configObjects.length,
    V2_LIMITS.batchItems,
  );
  assertV2Limit(
    "Agent Runtime initialization Domain count",
    input.domains.length,
    V2_LIMITS.agentGrantDomains,
  );
  if (
    typeof input.resolveCurrentDomainCommitterAuthority !== "function"
  ) {
    throw new TypeError(
      "Current Agent Runtime initialization Domain authority resolver is required",
    );
  }
  if (typeof input.resolveCurrentManagerAuthority !== "function") {
    throw new TypeError(
      "Current Agent Runtime initialization manager authority resolver is required",
    );
  }
  assertExactFields("Agent Runtime initialization manager", input.manager, [
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
  ]);
  const signerManager = Object.freeze({
    managerHumanId: humanId(input.manager.managerHumanId),
    managerAuthorizationRevision:
      authorizationRevision(input.manager.managerAuthorizationRevision),
    managerDeviceId: cryptoDeviceId(input.manager.managerDeviceId),
  });
  const managerSigningPrivateKey = exactSecretBytes(
    "Agent Runtime initialization manager signing private key",
    input.managerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );

  const configSecrets: Array<{
    readonly objectId: ReturnType<typeof objectId>;
    readonly configRevision: ReturnType<typeof authorizationRevision>;
    readonly plaintextDek: Uint8Array;
  }> = [];
  const domainSecrets: Array<{
    readonly authorization: AgentRuntimeAuthorizationDomainV2;
    readonly domainRoot: Uint8Array;
    readonly committerSigningPrivateKey: Uint8Array;
  }> = [];
  let runtimeKey: Uint8Array | null = null;
  let publishedRuntimeKey: Uint8Array | null = null;
  try {
    for (const config of input.configObjects) {
      assertExactFields("Agent Runtime initialization config object", config, [
        "objectId",
        "configRevision",
        "plaintextDek",
      ]);
      configSecrets.push({
        objectId: objectId(config.objectId),
        configRevision: authorizationRevision(config.configRevision),
        plaintextDek: exactSecretBytes(
          "Agent Runtime initialization config plaintext DEK",
          config.plaintextDek,
          32,
        ),
      });
    }
    for (let index = 1; index < configSecrets.length; index += 1) {
      if (
        comparePortableIds(
          configSecrets[index - 1]!.objectId,
          configSecrets[index]!.objectId,
        ) >= 0
      ) {
        throw new Error(
          "Agent Runtime initialization config objects must be sorted and unique",
        );
      }
    }
    for (const domain of input.domains) {
      assertExactFields("Agent Runtime initialization Domain", domain, [
        "domainId",
        "domainEpoch",
        "agentAuthorizationRevision",
        "committerDeviceId",
        "domainRoot",
        "committerSigningPrivateKey",
      ]);
      domainSecrets.push({
        authorization: Object.freeze({
          domainId: cryptoDomainId(domain.domainId),
          domainEpoch: domainEpoch(domain.domainEpoch),
          agentAuthorizationRevision:
            authorizationRevision(domain.agentAuthorizationRevision),
          committerDeviceId: cryptoDeviceId(domain.committerDeviceId),
        }),
        domainRoot: exactSecretBytes(
          "Agent Runtime initialization Domain root",
          domain.domainRoot,
          AGENT_RUNTIME_KEY_BYTES,
        ),
        committerSigningPrivateKey: exactSecretBytes(
          "Agent Runtime initialization committer signing private key",
          domain.committerSigningPrivateKey,
          V2_LIMITS.signingPrivateKeyBytes,
        ),
      });
    }
    for (let index = 1; index < domainSecrets.length; index += 1) {
      if (
        comparePortableIds(
          domainSecrets[index - 1]!.authorization.domainId,
          domainSecrets[index]!.authorization.domainId,
        ) >= 0
      ) {
        throw new Error(
          "Agent Runtime initialization Domains must be sorted and unique",
        );
      }
    }

    const authorities: Uint8Array[] = [];
    for (const domain of domainSecrets) {
      const context = Object.freeze({
        purpose: "agent-runtime-domain-envelope" as const,
        agentId: targetAgentId,
        ...domain.authorization,
        runtimeGeneration: targetRuntimeGeneration,
      });
      const resolved = await input.resolveCurrentDomainCommitterAuthority(
        context,
      );
      if (resolved === null) {
        throw new Error(
          "Agent Runtime initialization Domain committer is not currently authorized",
        );
      }
      authorities.push(exactSecretBytes(
        "Current Agent Runtime Domain committer signing public key",
        resolved,
        V2_LIMITS.signingPublicKeyBytes,
      ));
    }

    const generatedRuntimeKey =
      input.crypto.randomBytes(AGENT_RUNTIME_KEY_BYTES);
    try {
      runtimeKey = exactSecretBytes(
        "Random Agent Runtime initialization key",
        generatedRuntimeKey,
        AGENT_RUNTIME_KEY_BYTES,
      );
    } finally {
      generatedRuntimeKey.fill(0);
    }
    publishedRuntimeKey = copyOwnedBytesV2(runtimeKey);
    const runtime: AgentRuntimeGenerationV2 = Object.freeze({
      agentId: targetAgentId,
      keyClass: "runtime",
      generation: targetRuntimeGeneration,
      key: runtimeKey,
    });
    const runtimeState = Object.freeze({
      agentId: targetAgentId,
      authorizationRevision: targetAuthorizationRevision,
      runtimeGeneration: targetRuntimeGeneration,
    });
    const configRecords: OpaqueAgentRuntimeConfigRecordV2[] = [];
    for (const config of configSecrets) {
      const context = Object.freeze({
        agentId: targetAgentId,
        objectId: config.objectId,
        configRevision: config.configRevision,
        runtimeGeneration: targetRuntimeGeneration,
      });
      const ciphertext = input.crypto.aeadSeal(
        runtimeKey,
        config.plaintextDek,
        agentRuntimeConfigDekAadV2(context),
      );
      try {
        assertV2Limit(
          "Agent Runtime initialization wrapped DEK bytes",
          ciphertext.length,
          V2_LIMITS.wrappedDekBytes,
        );
        configRecords.push(Object.freeze({
          ...context,
          wrappedDekHash: copyOwnedBytesV2(
            input.crypto.hash(ciphertext),
          ),
          wrappedDek: authenticatedAgentRuntimeConfigDekV2(ciphertext),
        }));
      } finally {
        ciphertext.fill(0);
      }
    }
    const domainRecords: OpaqueAgentRuntimeDomainEnvelopeRecordV2[] = [];
    for (const [index, domain] of domainSecrets.entries()) {
      const envelope = sealAgentRuntimeToDomain({
        crypto: input.crypto,
        domainRoot: domain.domainRoot,
        runtime,
        context: domain.authorization,
        committerSigningPrivateKey: domain.committerSigningPrivateKey,
        currentCommitterAuthorized: (context) =>
          context.agentId === targetAgentId
          && context.runtimeGeneration === targetRuntimeGeneration
          && context.domainId === domain.authorization.domainId
          && context.domainEpoch === domain.authorization.domainEpoch
          && context.agentAuthorizationRevision
            === domain.authorization.agentAuthorizationRevision
          && context.committerDeviceId
            === domain.authorization.committerDeviceId,
      });
      try {
        if (
          !input.crypto.verify(
            authorities[index]!,
            agentRuntimeDomainEnvelopeSigningBytes(envelope),
            envelope.signature,
          )
        ) {
          throw new Error(
            "Agent Runtime initialization committer private key does not match current authority",
          );
        }
        const envelopeBytes = serializeAgentRuntimeDomainEnvelope(envelope);
        try {
          domainRecords.push(Object.freeze({
            agentId: targetAgentId,
            ...domain.authorization,
            runtimeGeneration: targetRuntimeGeneration,
            envelopeHash: copyOwnedBytesV2(
              input.crypto.hash(envelopeBytes),
            ),
            envelopeBytes: opaqueBytes(
              "agent-runtime-domain-envelope",
              envelopeBytes,
            ),
          }));
        } finally {
          envelopeBytes.fill(0);
        }
      } finally {
        envelope.ciphertext.fill(0);
        envelope.signature.fill(0);
      }
    }
    const intended: AgentRuntimeAtomicStorageStateV2 = Object.freeze({
      runtime: runtimeState,
      configInventory: Object.freeze({
        objectCount: configRecords.length,
        digest: configInventoryDigest(input.crypto, configRecords),
      }),
      configObjects: Object.freeze(configRecords),
      domainEnvelopes: Object.freeze(domainRecords),
      challengeConsumptions: Object.freeze([]),
    });
    const signerPublication =
      createAgentRuntimeInitializationSignerPublicationV1({
        crypto: input.crypto,
        operationId: input.operationId,
        publicState: initializationPublicState(intended),
        runtime,
        manager: signerManager,
        managerSigningPrivateKey,
        resolveCurrentManagerAuthority:
          input.resolveCurrentManagerAuthority,
      });
    const prepared = Object.freeze({
      runtime: Object.freeze({
        agentId: targetAgentId,
        keyClass: "runtime" as const,
        generation: targetRuntimeGeneration,
        key: publishedRuntimeKey,
      }),
      intended: cloneInitializationWriteState(intended),
      signerPublication,
    });
    publishedRuntimeKey = null;
    return prepared;
  } finally {
    configSecrets.forEach((config) => config.plaintextDek.fill(0));
    domainSecrets.forEach((domain) => {
      domain.domainRoot.fill(0);
      domain.committerSigningPrivateKey.fill(0);
    });
    runtimeKey?.fill(0);
    publishedRuntimeKey?.fill(0);
    managerSigningPrivateKey.fill(0);
  }
}

/**
 * Persist a process-authentic initialization exactly once. A pre-existing raw
 * row is canonicalized before exact replay/fork classification. A thrown
 * put result is never retried internally.
 */
export async function persistAgentRuntimeInitializationV2(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: AgentRuntimeInitializationStorageV2;
  readonly prepared: PreparedAgentRuntimeInitializationV2;
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentRuntimeInitializationAuthorizationV2;
}): Promise<AgentRuntimeInitializationStatusV2> {
  assertExactFields("Agent Runtime initialization persistence input", input, [
    "crypto",
    "storage",
    "prepared",
    "resolveCurrentAuthorization",
  ]);
  const intended = validatePreparedAgentRuntimeInitialization(
    input.crypto,
    input.prepared,
  );
  const signerPublication = decodeAgentRuntimeSignerPublicationV1(
    encodeAgentRuntimeSignerPublicationV1(
      input.prepared.signerPublication,
    ),
  );
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current Agent Runtime initialization authorization resolver is required",
    );
  }
  const currentWire = await input.storage.getAgentRuntimeAtomicState(
    intended.runtime.agentId,
  );
  const current = currentWire === null
    ? null
    : cloneAtomicStorageState(currentWire);
  const authorizationContext = Object.freeze({
    purpose: "persist-agent-runtime-initialization",
    operationId: signerPublication.operationId,
    expectedState: Object.freeze({ ...intended.runtime }),
    expectedManager: Object.freeze({
      managerHumanId: signerPublication.managerHumanId,
      managerAuthorizationRevision:
        signerPublication.managerAuthorizationRevision,
      managerDeviceId: signerPublication.managerDeviceId,
    }),
    configInventory: Object.freeze({
      objectCount: intended.configInventory.objectCount,
      digest: copyOwnedBytesV2(intended.configInventory.digest),
    }),
    expectedDomains: Object.freeze(
      intended.domainEnvelopes.map((domain) => cloneDomain({
        domainId: cryptoDomainId(domain.domainId),
        domainEpoch: domainEpoch(domain.domainEpoch),
        agentAuthorizationRevision:
          authorizationRevision(domain.agentAuthorizationRevision),
        committerDeviceId: cryptoDeviceId(domain.committerDeviceId),
      })),
    ),
  });
  const resolved = await input.resolveCurrentAuthorization(
    authorizationContext,
  );
  if (resolved === null) return "stale";
  assertExactFields(
    "Agent Runtime initialization persistence authorization",
    resolved,
    [
      "currentState",
      "currentManager",
      "currentManagerSigningPublicKey",
      "domains",
    ],
  );
  if (!Array.isArray(resolved.domains as unknown)) {
    throw new TypeError(
      "Agent Runtime initialization authorized Domains must be an array",
    );
  }
  assertV2Limit(
    "Agent Runtime initialization authorized Domain count",
    resolved.domains.length,
    V2_LIMITS.agentGrantDomains,
  );
  const currentState = cloneState(resolved.currentState);
  const currentManager = Object.freeze({
    managerHumanId: humanId(resolved.currentManager.managerHumanId),
    managerAuthorizationRevision:
      authorizationRevision(
        resolved.currentManager.managerAuthorizationRevision,
      ),
    managerDeviceId: cryptoDeviceId(resolved.currentManager.managerDeviceId),
  });
  const currentManagerSigningPublicKey = exactSecretBytes(
    "Current Agent Runtime initialization manager signing public key",
    resolved.currentManagerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const domains = resolved.domains.map((domain) => {
    assertExactFields(
      "Agent Runtime initialization authorized Domain",
      domain,
      [
        "domainId",
        "domainEpoch",
        "agentAuthorizationRevision",
        "committerDeviceId",
        "committerSigningPublicKey",
      ],
    );
    const coordinates = cloneDomain({
      domainId: domain.domainId,
      domainEpoch: domain.domainEpoch,
      agentAuthorizationRevision: domain.agentAuthorizationRevision,
      committerDeviceId: domain.committerDeviceId,
    });
    return Object.freeze({
      ...coordinates,
      committerSigningPublicKey: exactSecretBytes(
        "Current Agent Runtime initialization Domain committer signing public key",
        domain.committerSigningPublicKey,
        V2_LIMITS.signingPublicKeyBytes,
      ),
    });
  });
  for (let index = 1; index < domains.length; index += 1) {
    if (
      comparePortableIds(
        domains[index - 1]!.domainId,
        domains[index]!.domainId,
      ) >= 0
    ) {
      throw new Error(
        "Agent Runtime initialization authorized Domains must be sorted and unique",
      );
    }
  }
  if (
    !equalState(currentState, intended.runtime)
    || !equalManager(
      currentManager,
      authorizationContext.expectedManager,
    )
    || !verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto: input.crypto,
      publication: signerPublication,
      resolveHistoricalManagerAuthority: (context) =>
        context.managerHumanId === currentManager.managerHumanId
            && context.managerAuthorizationRevision
              === currentManager.managerAuthorizationRevision
            && context.managerDeviceId === currentManager.managerDeviceId
          ? currentManagerSigningPublicKey
          : null,
    })
    || domains.length !== intended.domainEnvelopes.length
    || domains.some((domain, index) => {
      const expected = intended.domainEnvelopes[index]!;
      return !equalDomain(domain, cloneDomain({
        domainId: cryptoDomainId(expected.domainId),
        domainEpoch: domainEpoch(expected.domainEpoch),
        agentAuthorizationRevision:
          authorizationRevision(expected.agentAuthorizationRevision),
        committerDeviceId: cryptoDeviceId(expected.committerDeviceId),
      }));
    })
  ) {
    return "stale";
  }
  for (const [index, record] of intended.domainEnvelopes.entries()) {
    const envelope = parseAgentRuntimeDomainEnvelope(
      record.envelopeBytes.ciphertext,
    );
    if (
      !input.crypto.verify(
        domains[index]!.committerSigningPublicKey,
        agentRuntimeDomainEnvelopeSigningBytes(envelope),
        envelope.signature,
      )
    ) {
      return "stale";
    }
  }
  if (current !== null) {
    if (!currentMatchesIntended(current, intended)) return "stale";
    const persistedSignerPublication =
      await input.storage.getAgentRuntimeSignerPublication(
        intended.runtime.agentId,
        intended.runtime.runtimeGeneration,
      );
    return persistedSignerPublication !== null
        && equalBytes(
          encodeAgentRuntimeSignerPublicationV1(persistedSignerPublication),
          encodeAgentRuntimeSignerPublicationV1(signerPublication),
        )
      ? "duplicate"
      : "stale";
  }
  let status: "inserted" | "existing" | "stale";
  try {
    status = await input.storage.putAgentRuntimeAtomicStateIfAbsent(
      authorizeAgentRuntimeInitializationWriteV2(
        {
          state: cloneInitializationWriteState(intended),
          authorization: Object.freeze({
            context: authorizationContext,
            currentManager,
            currentManagerSigningPublicKey,
            authorizedDomains: Object.freeze(domains),
          }),
          signerPublication,
        },
      ),
    );
  } catch (cause) {
    throw new AgentRuntimeInitializationOutcomeUnknownV2(cause);
  }
  if (status === "inserted") return "inserted";
  if (status === "stale") return "stale";
  if (status !== "existing") {
    throw new TypeError(
      "Agent Runtime initialization storage returned an invalid status",
    );
  }
  let concurrentWire: AgentRuntimeAtomicStorageWireV2 | null;
  try {
    concurrentWire = await input.storage.getAgentRuntimeAtomicState(
      intended.runtime.agentId,
    );
  } catch (cause) {
    throw new AgentRuntimeInitializationOutcomeUnknownV2(cause);
  }
  if (concurrentWire === null) {
    throw new AgentRuntimeInitializationOutcomeUnknownV2(
      new Error("Agent Runtime initialization row disappeared"),
    );
  }
  const concurrent = cloneAtomicStorageState(concurrentWire);
  if (!currentMatchesIntended(concurrent, intended)) return "stale";
  const concurrentSignerPublication =
    await input.storage.getAgentRuntimeSignerPublication(
      intended.runtime.agentId,
      intended.runtime.runtimeGeneration,
    );
  return concurrentSignerPublication !== null
      && equalBytes(
        encodeAgentRuntimeSignerPublicationV1(concurrentSignerPublication),
        encodeAgentRuntimeSignerPublicationV1(signerPublication),
      )
    ? "duplicate"
    : "stale";
}

function cloneChallengeReservationRequest(
  request: AgentRuntimeChallengeReservationRequestV2,
): AgentRuntimeChallengeReservationRequestV2 {
  assertExactFields("Agent Runtime challenge reservation request", request, [
    "operationId",
    "expectedState",
    "currentManager",
    "remainingDomains",
    "challengeHashes",
  ]);
  assertPortableId("Agent Runtime challenge reservation operation ID", request.operationId);
  assertExactFields("Agent Runtime challenge reservation manager", request.currentManager, [
    "managerHumanId",
    "managerAuthorizationRevision",
    "managerDeviceId",
  ]);
  if (!Array.isArray(request.remainingDomains as unknown)) {
    throw new TypeError(
      "Agent Runtime challenge reservation Domains must be an array",
    );
  }
  if (!Array.isArray(request.challengeHashes as unknown)) {
    throw new TypeError(
      "Agent Runtime challenge reservation hashes must be an array",
    );
  }
  assertV2Limit(
    "Agent Runtime challenge reservation Domain count",
    request.remainingDomains.length,
    V2_LIMITS.agentGrantDomains,
  );
  assertV2Limit(
    "Agent Runtime challenge reservation hash count",
    request.challengeHashes.length,
    V2_LIMITS.agentGrantDomains,
  );
  if (
    request.challengeHashes.length === 0
    || request.challengeHashes.length !== request.remainingDomains.length
  ) {
    throw new Error(
      "Agent Runtime challenge reservation must exactly cover remaining Domains",
    );
  }
  const domains = request.remainingDomains.map(cloneDomain);
  for (let index = 1; index < domains.length; index += 1) {
    if (
      comparePortableIds(
        domains[index - 1]!.domainId,
        domains[index]!.domainId,
      ) >= 0
    ) {
      throw new Error(
        "Agent Runtime challenge reservation Domains must be sorted and unique",
      );
    }
  }
  const challengeHashes = request.challengeHashes.map((hash) => {
    assertHash("Agent Runtime challenge reservation hash", hash);
    return copyOwnedBytesV2(hash);
  }).sort(compareBytes);
  for (let index = 1; index < challengeHashes.length; index += 1) {
    if (equalBytes(challengeHashes[index - 1]!, challengeHashes[index]!)) {
      throw new Error(
        "Agent Runtime challenge reservation hashes must be unique",
      );
    }
  }
  return Object.freeze({
    operationId: request.operationId,
    expectedState: cloneState(request.expectedState),
    currentManager: Object.freeze({
      managerHumanId: humanId(request.currentManager.managerHumanId),
      managerAuthorizationRevision: authorizationRevision(
        request.currentManager.managerAuthorizationRevision,
      ),
      managerDeviceId: cryptoDeviceId(
        request.currentManager.managerDeviceId,
      ),
    }),
    remainingDomains: Object.freeze(domains),
    challengeHashes: Object.freeze(challengeHashes),
  });
}

/**
 * Atomically reserve newly issued handoff challenges before any target uses
 * them. Existing unrelated pending reservations survive. Consumed entries may
 * be compacted by the store because their old operation/Runtime coordinates
 * are independently stale.
 */
export async function reserveAgentRuntimeRotationChallengesV2(input: {
  readonly storage: AgentRuntimeChallengeReservationStorageV2;
  readonly request: AgentRuntimeChallengeReservationRequestV2;
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentRuntimeChallengeReservationAuthorizationV2;
}): Promise<AgentRuntimeChallengeReservationCasStatusV2> {
  const request = cloneChallengeReservationRequest(input.request);
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current Agent Runtime challenge reservation authorization resolver is required",
    );
  }
  const read = await input.storage.getAgentRuntimeAtomicState(
    request.expectedState.agentId,
  );
  const current = read === null ? null : cloneAtomicStorageState(read);
  if (current === null || !equalState(current.runtime, request.expectedState)) {
    return "stale";
  }
  const authorizationContext = Object.freeze({
    purpose: "reserve-agent-runtime-rotation-challenges",
    operationId: request.operationId,
    expectedState: cloneState(request.expectedState),
    expectedManager: Object.freeze({ ...request.currentManager }),
    remainingDomains: Object.freeze(request.remainingDomains.map(cloneDomain)),
    challengeHashes: Object.freeze(
      request.challengeHashes.map(copyOwnedBytesV2),
    ),
  });
  const resolved = await input.resolveCurrentAuthorization(
    Object.freeze({
      purpose: authorizationContext.purpose,
      operationId: authorizationContext.operationId,
      expectedState: cloneState(authorizationContext.expectedState),
      expectedManager: Object.freeze({
        ...authorizationContext.expectedManager,
      }),
      remainingDomains: Object.freeze(
        authorizationContext.remainingDomains.map(cloneDomain),
      ),
      challengeHashes: Object.freeze(
        authorizationContext.challengeHashes.map(copyOwnedBytesV2),
      ),
    }),
  );
  if (resolved === null) return "stale";
  const authorization = preflightAndCloneAuthorization(resolved);
  if (
    !equalState(authorization.currentState, request.expectedState)
    || !equalManager(authorization.currentManager, request.currentManager)
    || authorization.remainingDomains.length
      !== request.remainingDomains.length
    || authorization.remainingDomains.some((domain, index) =>
      !equalDomain(domain, request.remainingDomains[index]!)
    )
  ) {
    return "stale";
  }
  const expected = Object.freeze({
    runtime: cloneState(current.runtime),
    challengeConsumptions: Object.freeze(
      current.challengeConsumptions.map((challenge) =>
        Object.freeze({
          challengeHash: challenge.challengeHash,
          consumed: challenge.consumed,
        })
      ),
    ),
  });
  const additions = Object.freeze(request.challengeHashes.map((hash) =>
    Object.freeze({
      challengeHash: copyOwnedBytesV2(hash),
      consumed: false,
    })
  ));
  let status: AgentRuntimeChallengeReservationCasStatusV2;
  try {
    status = await input.storage
      .compareAndSwapAgentRuntimeChallengeReservations(
        authorizeAgentRuntimeChallengeReservationWriteV2({
          expected,
          additions,
          authorization: authorizationContext,
        }),
      );
  } catch (cause) {
    throw new AgentRuntimeChallengeReservationOutcomeUnknownV2(cause);
  }
  if (
    status !== "applied"
    && status !== "duplicate"
    && status !== "stale"
  ) {
    throw new TypeError(
      "Agent Runtime challenge reservation storage returned an invalid CAS status",
    );
  }
  return status;
}

function equalState(
  left: AgentRuntimeRotationStateV2,
  right: AgentRuntimeRotationStateV2,
): boolean {
  return JSON.stringify([
    left.agentId,
    left.authorizationRevision,
    left.runtimeGeneration,
  ]) === JSON.stringify([
    right.agentId,
    right.authorizationRevision,
    right.runtimeGeneration,
  ]);
}

function equalDomain(
  left: AgentRuntimeAuthorizationDomainV2,
  right: AgentRuntimeAuthorizationDomainV2,
): boolean {
  return JSON.stringify([
    left.domainId,
    left.domainEpoch,
    left.agentAuthorizationRevision,
    left.committerDeviceId,
  ]) === JSON.stringify([
    right.domainId,
    right.domainEpoch,
    right.agentAuthorizationRevision,
    right.committerDeviceId,
  ]);
}

function currentMatchesExpectation(
  current: AgentRuntimeAtomicStorageStateV2,
  expected: AgentRuntimeRotationStorageExpectationV2,
): boolean {
  const fingerprint = (
    value: AgentRuntimeRotationStorageExpectationV2,
  ) => JSON.stringify([
    value.runtime.agentId,
    value.runtime.authorizationRevision,
    value.runtime.runtimeGeneration,
    value.configInventory.objectCount,
    bytesToHex(value.configInventory.digest),
    value.configObjects.map((object) => [
      object.agentId,
      object.objectId,
      object.configRevision,
      object.runtimeGeneration,
      bytesToHex(object.wrappedDekHash),
    ]),
  ]);
  return fingerprint(current) === fingerprint(expected);
}

function currentMatchesIntended(
  current: AgentRuntimeAtomicStorageStateV2,
  intended: AgentRuntimeAtomicStorageStateV2,
): boolean {
  const fingerprint = (
    value: AgentRuntimeAtomicStorageStateV2,
  ) => JSON.stringify([
    value.runtime.agentId,
    value.runtime.authorizationRevision,
    value.runtime.runtimeGeneration,
    value.configInventory.objectCount,
    bytesToHex(value.configInventory.digest),
    value.configObjects.map((object) => [
      object.agentId,
      object.objectId,
      object.configRevision,
      object.runtimeGeneration,
      bytesToHex(object.wrappedDekHash),
      bytesToHex(object.wrappedDek.ciphertext),
    ]),
    value.domainEnvelopes.map((envelope) => [
      envelope.agentId,
      envelope.domainId,
      envelope.domainEpoch,
      envelope.agentAuthorizationRevision,
      envelope.runtimeGeneration,
      envelope.committerDeviceId,
      bytesToHex(envelope.envelopeHash),
      bytesToHex(envelope.envelopeBytes.ciphertext),
    ]),
  ]);
  return fingerprint(current) === fingerprint(intended);
}

function hydrateChallengeWriteSet(
  writeSet: Readonly<{
    readonly expected: Omit<
      AgentRuntimeRotationStorageExpectationV2,
      "challengeConsumptions"
    >;
    readonly intended: Omit<
      AgentRuntimeAtomicStorageStateV2,
      "challengeConsumptions"
    >;
    readonly challengeHashes: readonly Uint8Array[];
  }>,
  current: AgentRuntimeAtomicStorageStateV2,
  duplicate: boolean,
): Readonly<{
  readonly expected: AgentRuntimeRotationStorageExpectationV2;
  readonly intended: AgentRuntimeAtomicStorageStateV2;
}> | null {
  const exactHashes = writeSet.challengeHashes;
  for (const hash of exactHashes) {
    const active = current.challengeConsumptions.find((entry) =>
      equalBytes(entry.challengeHash, hash)
    );
    if (active === undefined || active.consumed !== duplicate) return null;
  }
  const expectedChallenges = current.challengeConsumptions.map((entry) =>
    Object.freeze({
      challengeHash: entry.challengeHash,
      consumed: entry.consumed,
    })
  );
  const intendedChallenges = expectedChallenges.map((entry) =>
    Object.freeze({
      challengeHash: entry.challengeHash,
      consumed: exactHashes.some((hash) =>
        equalBytes(hash, entry.challengeHash)
      )
        ? true
        : entry.consumed,
    })
  );
  return Object.freeze({
    expected: Object.freeze({
      ...writeSet.expected,
      challengeConsumptions: Object.freeze(expectedChallenges),
    }),
    intended: Object.freeze({
      ...writeSet.intended,
      challengeConsumptions: Object.freeze(intendedChallenges),
    }),
  });
}

function validateCandidate(
  crypto: LatticeCrypto,
  candidate: AtomicAgentRuntimeRotationCandidateV2,
  authorization: AgentRuntimeRotationPersistenceAuthorizationV2,
): Readonly<{
  readonly expected: Omit<
    AgentRuntimeRotationStorageExpectationV2,
    "challengeConsumptions"
  >;
  readonly intended: Omit<
    AgentRuntimeAtomicStorageStateV2,
    "challengeConsumptions"
  >;
  readonly challengeHashes: readonly Uint8Array[];
}> {
  if (
    authorization.remainingDomains.length
      !== candidate.domainEnvelopes.length
  ) {
    throw new Error(
      "Agent Runtime remaining Domain envelope coverage is incomplete",
    );
  }

  const expectedEntries = candidate.configRewraps.map((rewrap) => ({
    ...rewrap.expected,
    wrappedDekHash: rewrap.expected.wrappedDekHash,
  }));

  const domainRecords: OpaqueAgentRuntimeDomainEnvelopeRecordV2[] = [];
  const challengeHashes: Uint8Array[] = [];
  for (let index = 0; index < candidate.domainEnvelopes.length; index += 1) {
    const entry = candidate.domainEnvelopes[index]!;
    const liveDomain = authorization.remainingDomains[index]!;
    if (!equalDomain(entry.expectedDomain, liveDomain)) {
      throw new Error(
        "Agent Runtime Domain envelope does not match live authorization",
      );
    }
    domainRecords.push({
      agentId: candidate.nextState.agentId,
      domainId: liveDomain.domainId,
      domainEpoch: liveDomain.domainEpoch,
      agentAuthorizationRevision: liveDomain.agentAuthorizationRevision,
      runtimeGeneration: candidate.nextState.runtimeGeneration,
      committerDeviceId: liveDomain.committerDeviceId,
      envelopeHash: crypto.hash(entry.envelopeBytes.ciphertext),
      envelopeBytes: opaqueBytes(
        "agent-runtime-domain-envelope",
        entry.envelopeBytes.ciphertext,
      ),
    });
    challengeHashes.push(entry.challengeConsumption.challengeHash);
  }
  const intendedConfigObjects: OpaqueAgentRuntimeConfigRecordV2[] =
    candidate.configRewraps.map((rewrap) => ({
      agentId: candidate.nextState.agentId,
      objectId: rewrap.expected.objectId,
      configRevision: rewrap.expected.configRevision,
      runtimeGeneration: candidate.nextState.runtimeGeneration,
      wrappedDekHash: crypto.hash(rewrap.nextWrappedDek.ciphertext),
      wrappedDek: authenticatedAgentRuntimeConfigDekV2(
        rewrap.nextWrappedDek.ciphertext,
      ),
    }));
  const intendedInventory = Object.freeze({
    objectCount: intendedConfigObjects.length,
    digest: configInventoryDigest(crypto, intendedConfigObjects),
  });
  const expected = Object.freeze({
    runtime: cloneState(candidate.expectedState),
    configInventory: Object.freeze({
      objectCount: candidate.expectedConfigInventory.objectCount,
      digest: candidate.expectedConfigInventory.digest,
    }),
    configObjects: Object.freeze(expectedEntries),
  });
  const intended = Object.freeze({
    runtime: cloneState(candidate.nextState),
    configInventory: intendedInventory,
    configObjects: Object.freeze(intendedConfigObjects),
    domainEnvelopes: Object.freeze(domainRecords),
  });
  return Object.freeze({
    expected,
    intended,
    challengeHashes: Object.freeze(challengeHashes),
  });
}

/**
 * Persist one authenticated global Runtime rotation as one storage CAS.
 *
 * There is intentionally no internal retry. A thrown adapter result may have
 * happened before or after commit; the host must explicitly retry the same
 * candidate, which resolves to `duplicate` after a committed first delivery.
 */
export async function persistAgentRuntimeRotationV2(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: AgentRuntimeRotationCasStorageV2;
  readonly candidate: AtomicAgentRuntimeRotationCandidateV2;
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentRuntimeRotationPersistenceAuthorizationV2;
}): Promise<AgentRuntimeRotationCasStatusV2> {
  assertExactFields("Agent Runtime rotation persistence input", input, [
    "crypto",
    "storage",
    "candidate",
    "resolveCurrentAuthorization",
  ]);
  // Detach all caller-owned bytes and enforce every allocation bound before
  // the first storage call/await.
  const candidate = preflightAndCloneCandidate(input.candidate);
  if (typeof input.resolveCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current Agent Runtime persistence authorization resolver is required",
    );
  }
  const read = await input.storage.getAgentRuntimeAtomicState(
    candidate.expectedState.agentId,
  );
  const current = read === null ? null : cloneAtomicStorageState(read);
  if (current === null) return "stale";
  const authorizationContext = Object.freeze({
    purpose: "persist-agent-runtime-rotation",
    operationId: candidate.operationId,
    expectedState: cloneState(candidate.expectedState),
    nextState: cloneState(candidate.nextState),
    expectedManager: Object.freeze({ ...candidate.currentManager }),
  });
  const resolved = await input.resolveCurrentAuthorization(
    authorizationContext,
  );
  if (resolved === null) return "stale";
  const authorization = preflightAndCloneAuthorization(resolved);
  if (
    !equalManager(authorization.currentManager, candidate.currentManager)
    || (
      !equalState(authorization.currentState, candidate.expectedState)
      && !equalState(authorization.currentState, candidate.nextState)
    )
  ) {
    return "stale";
  }
  const reconstructed = aggregateAgentRuntimeRotationV2({
    crypto: input.crypto,
    publicCandidate: candidate.publicCandidate,
    completedTargets: candidate.completedTargets,
    resolveCurrentManagerAuthority: () =>
      authorization.currentManagerSigningPublicKey,
    resolveCurrentTargetCommitter: ({ target }) => {
      const domain = authorization.remainingDomains.find((entry) =>
        equalDomain(entry, target)
      );
      return domain?.committerSigningPublicKey ?? null;
    },
  });
  if (!exactStructuredValueEqual(candidate, reconstructed)) {
    throw new Error(
      "Atomic Agent Runtime rotation candidate proof does not match its derived write set",
    );
  }
  const candidateWriteSet = validateCandidate(
    input.crypto,
    reconstructed,
    authorization,
  );
  const duplicate = equalState(
    authorization.currentState,
    reconstructed.nextState,
  );
  const writeSet = hydrateChallengeWriteSet(
    candidateWriteSet,
    current,
    duplicate,
  );
  if (writeSet === null) return "stale";
  if (
    !duplicate
      ? !currentMatchesExpectation(current, writeSet.expected)
      : !currentMatchesIntended(current, writeSet.intended)
  ) {
    return "stale";
  }
  let status: AgentRuntimeRotationCasStatusV2;
  try {
    status = await input.storage.compareAndSwapAgentRuntimeRotation(
      authorizeAgentRuntimeRotationWriteV2({
        expected: writeSet.expected,
        intended: writeSet.intended,
        authorization: Object.freeze({
          context: authorizationContext,
          currentState: authorization.currentState,
          currentManager: authorization.currentManager!,
          currentManagerSigningPublicKey:
            authorization.currentManagerSigningPublicKey,
          remainingDomains: authorization.remainingDomains,
        }),
        signerPublication:
          candidate.publicCandidate.signerPublication,
      }),
    );
  } catch (cause) {
    throw new AgentRuntimeRotationOutcomeUnknownV2(cause);
  }
  if (
    status !== "applied"
    && status !== "duplicate"
    && status !== "stale"
  ) {
    throw new TypeError(
      "Agent Runtime rotation storage returned an invalid CAS status",
    );
  }
  return status;
}
