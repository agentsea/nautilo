import {
  AgentRuntimeChallengeReservationOutcomeUnknown,
  AgentRuntimeRotationOutcomeUnknown,
  aggregateAgentRuntimeRotation,
  destroyAgentRuntimeRotationSourceLocal,
  persistAgentRuntimeRotation,
  prepareAgentRuntimeManagerHandoffChallenge,
  prepareAgentRuntimeManagerHandoffResponse,
  prepareAgentRuntimeManagerHandoffTarget,
  prepareAgentRuntimeRotationSource,
  reserveAgentRuntimeRotationChallenges,
  type AgentRuntimeAuthorizationPlan,
  type AgentRuntimeChallengeReservationStorage,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeRotationCasStorage,
  type AgentRuntimeRotationState,
  type LatticeCrypto,
  type ResolveCurrentAgentRuntimeChallengeReservationAuthorization,
  type ResolveCurrentAgentRuntimeManagerAuthority,
  type ResolveCurrentAgentRuntimeRotationPersistenceAuthorization,
} from "@nautilo/lattice-crypto";
import type {
  AgentRuntimeConfigObjectV2,
  AgentRuntimeManagerHandoffPlanV1,
  AgentRuntimeRotationPublicCandidateV2,
  PreparedAgentRuntimeHandoffChallengeV1,
  PreparedAgentRuntimeManagerHandoffTargetV1,
  ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1,
  ResolveCurrentAgentRuntimeManagerHandoffTargetV1,
} from "@nautilo/lattice-crypto/wire";

export interface ProtectedAgentRuntimeRotationSourcePort {
  readonly publicCandidate: AgentRuntimeRotationPublicCandidateV2;
  readonly respond: (
    challengeBytes: Uint8Array,
    expectedPlan: AgentRuntimeManagerHandoffPlanV1,
  ) => Promise<Uint8Array>;
  readonly close: () => void;
}

export interface ProtectedAgentRuntimeRotationTargetPort {
  readonly domainId: string;
  readonly challenge: (
    plan: AgentRuntimeManagerHandoffPlanV1,
  ) => Promise<PreparedAgentRuntimeHandoffChallengeV1>;
  readonly complete: (
    input: Readonly<{
      readonly plan: AgentRuntimeManagerHandoffPlanV1;
      readonly challenge:
        PreparedAgentRuntimeHandoffChallengeV1;
      readonly responseBytes: Uint8Array;
    }>,
  ) => Promise<PreparedAgentRuntimeManagerHandoffTargetV1>;
  readonly close: () => void;
}

export type ProtectedAgentRuntimeRotationResult =
  | Readonly<{
    readonly status: "completed";
    readonly persistence: "applied" | "duplicate";
  }>
  | Readonly<{
    readonly status: "pending";
    readonly reason:
      | "challenge_reservation_stale"
      | "rotation_persistence_stale"
      | "target_unavailable";
    readonly unavailableDomainIds: readonly string[];
  }>;

/**
 * Client/device-side source custody. Runtime and manager signing material stay
 * inside this closure and are wiped by `close`; the server coordinator sees
 * only the authenticated public candidate and sealed responses.
 */
export function createProtectedAgentRuntimeRotationSourcePort(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly currentState: AgentRuntimeRotationState;
    readonly currentRuntime: AgentRuntimeKeyGeneration;
    readonly plan: AgentRuntimeAuthorizationPlan;
    readonly activeConfigObjects: readonly AgentRuntimeConfigObjectV2[];
    readonly resolveCurrentManagerAuthority:
      ResolveCurrentAgentRuntimeManagerAuthority;
    readonly resolveCurrentHandoffManagerAuthority:
      ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1;
    readonly resolveCurrentTargetCommitter:
      ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
    readonly managerSigningPrivateKey: Uint8Array;
  }>,
): ProtectedAgentRuntimeRotationSourcePort {
  const prepared = prepareAgentRuntimeRotationSource({
    crypto: input.crypto,
    currentState: input.currentState,
    currentRuntime: input.currentRuntime,
    plan: input.plan,
    activeConfigObjects: input.activeConfigObjects,
    resolveCurrentManagerAuthority:
      input.resolveCurrentManagerAuthority,
    managerSigningPrivateKey: input.managerSigningPrivateKey,
  });
  if (prepared.kind !== "rotated") {
    throw new Error(
      "Protected Runtime rotation source requires a rotation plan",
    );
  }
  const managerPrivate = input.managerSigningPrivateKey.slice();
  let closed = false;
  return Object.freeze({
    publicCandidate: prepared.publicCandidate,
    respond: async (
      challengeBytes: Uint8Array,
      expectedPlan: AgentRuntimeManagerHandoffPlanV1,
    ) => {
      if (closed) {
        throw new Error("Protected Runtime rotation source is closed");
      }
      return prepareAgentRuntimeManagerHandoffResponse({
        crypto: input.crypto,
        challengeBytes,
        expectedPlan,
        freshRuntime: prepared.sourceLocal.runtime,
        managerSigningPrivateKey: managerPrivate,
        resolveCurrentManagerAuthority:
          input.resolveCurrentHandoffManagerAuthority,
        resolveCurrentTargetCommitter:
          input.resolveCurrentTargetCommitter,
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      managerPrivate.fill(0);
      destroyAgentRuntimeRotationSourceLocal(prepared.sourceLocal);
    },
  });
}

/**
 * Client/device-side target custody. The ephemeral recipient key, Domain root,
 * and committer signing key never become coordinator fields or return values.
 */
export async function createProtectedAgentRuntimeRotationTargetPort(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly domainId: string;
    readonly targetDomainRoot: Uint8Array;
    readonly targetCommitterSigningPrivateKey: Uint8Array;
    readonly resolveCurrentManagerAuthority:
      ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1;
    readonly resolveCurrentTargetCommitter:
      ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
    readonly ttlMs: number;
  }>,
): Promise<ProtectedAgentRuntimeRotationTargetPort> {
  const ephemeral = await input.crypto.generateEncryptionKeyPair();
  const ephemeralPrivate = ephemeral.privateKey.slice();
  const domainRoot = input.targetDomainRoot.slice();
  const committerPrivate =
    input.targetCommitterSigningPrivateKey.slice();
  ephemeral.privateKey.fill(0);
  let activeChallenge:
    PreparedAgentRuntimeHandoffChallengeV1 | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    activeChallenge?.challengeBytes.fill(0);
    activeChallenge?.challengeHash.fill(0);
    activeChallenge = null;
    ephemeralPrivate.fill(0);
    domainRoot.fill(0);
    committerPrivate.fill(0);
  };
  return Object.freeze({
    domainId: input.domainId,
    challenge: (plan: AgentRuntimeManagerHandoffPlanV1) => {
      if (closed || activeChallenge !== null) {
        throw new Error("Protected Runtime rotation target is unavailable");
      }
      if (plan.target.domainId !== input.domainId) {
        throw new Error("Protected Runtime rotation target Domain mismatch");
      }
      activeChallenge = prepareAgentRuntimeManagerHandoffChallenge({
        crypto: input.crypto,
        plan,
        targetEphemeralPublicKey: ephemeral.publicKey,
        targetCommitterSigningPrivateKey: committerPrivate,
        resolveCurrentTargetCommitter:
          input.resolveCurrentTargetCommitter,
        ttlMs: input.ttlMs,
      });
      return Promise.resolve(Object.freeze({
        challengeBytes: activeChallenge.challengeBytes.slice(),
        challengeHash: activeChallenge.challengeHash.slice(),
      }));
    },
    complete: async ({
      plan,
      challenge,
      responseBytes,
    }: Readonly<{
      readonly plan: AgentRuntimeManagerHandoffPlanV1;
      readonly challenge: PreparedAgentRuntimeHandoffChallengeV1;
      readonly responseBytes: Uint8Array;
    }>) => {
      if (
        closed
        || activeChallenge === null
        || plan.target.domainId !== input.domainId
        || !equalBytes(
          challenge.challengeHash,
          activeChallenge.challengeHash,
        )
      ) {
        throw new Error("Protected Runtime rotation target is unavailable");
      }
      return prepareAgentRuntimeManagerHandoffTarget({
        crypto: input.crypto,
        challengeBytes: activeChallenge.challengeBytes,
        responseBytes,
        expectedPlan: plan,
        trustedChallengeState: {
          challengeHash: activeChallenge.challengeHash,
          consumed: false,
        },
        targetEphemeralPrivateKey: ephemeralPrivate,
        targetDomainRoot: domainRoot,
        targetCommitterSigningPrivateKey: committerPrivate,
        resolveCurrentManagerAuthority:
          input.resolveCurrentManagerAuthority,
        resolveCurrentTargetCommitter:
          input.resolveCurrentTargetCommitter,
      });
    },
    close,
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Server-safe public orchestration. Every secret-bearing operation is invoked
 * through a source/target port; only opaque challenges, responses, completed
 * envelopes, and the core-authenticated atomic candidate cross this function.
 */
export async function coordinateProtectedAgentRuntimeRotation(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage:
      AgentRuntimeRotationCasStorage
      & AgentRuntimeChallengeReservationStorage;
    readonly source: ProtectedAgentRuntimeRotationSourcePort;
    readonly targets:
      readonly ProtectedAgentRuntimeRotationTargetPort[];
    readonly resolveChallengeReservationAuthorization:
      ResolveCurrentAgentRuntimeChallengeReservationAuthorization;
    readonly resolveRotationPersistenceAuthorization:
      ResolveCurrentAgentRuntimeRotationPersistenceAuthorization;
    readonly resolveCurrentRotationManagerAuthority:
      ResolveCurrentAgentRuntimeManagerAuthority;
    readonly resolveCurrentTargetCommitter:
      ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
  }>,
): Promise<ProtectedAgentRuntimeRotationResult> {
  try {
    const intendedDomainIds =
      input.source.publicCandidate.targetIntents
        .map((intent) => String(intent.target.domainId));
    const intendedDomainIdSet = new Set<string>(intendedDomainIds);
    const targetByDomain =
      new Map<string, ProtectedAgentRuntimeRotationTargetPort>();
    for (const target of input.targets) {
      if (
        targetByDomain.has(target.domainId)
        || !intendedDomainIdSet.has(target.domainId)
      ) {
        throw new TypeError(
          "Protected Runtime rotation targets must exactly match the candidate",
        );
      }
      targetByDomain.set(target.domainId, target);
    }
    const unavailableDomainIds =
      intendedDomainIds
        .filter((domainId) => !targetByDomain.has(domainId));
    if (unavailableDomainIds.length > 0) {
      return Object.freeze({
        status: "pending",
        reason: "target_unavailable",
        unavailableDomainIds: Object.freeze(unavailableDomainIds),
      });
    }
    const challenges = [];
    for (const intent of input.source.publicCandidate.targetIntents) {
      const target = targetByDomain.get(intent.target.domainId)!;
      challenges.push(Object.freeze({
        intent,
        target,
        challenge: await target.challenge(intent),
      }));
    }
    const reservationInput = {
        storage: input.storage,
        request: {
          operationId: input.source.publicCandidate.plan.operationId,
          expectedState: input.source.publicCandidate.expectedState,
          currentManager:
            input.source.publicCandidate.plan.currentManager!,
          remainingDomains:
            input.source.publicCandidate.plan.remainingDomains,
          challengeHashes:
            challenges.map((entry) => entry.challenge.challengeHash),
        },
        resolveCurrentAuthorization:
          input.resolveChallengeReservationAuthorization,
      } as const;
    let reservation: Awaited<
      ReturnType<typeof reserveAgentRuntimeRotationChallenges>
    >;
    try {
      reservation =
        await reserveAgentRuntimeRotationChallenges(reservationInput);
    } catch (error) {
      if (
        !(error instanceof AgentRuntimeChallengeReservationOutcomeUnknown)
      ) {
        throw error;
      }
      reservation =
        await reserveAgentRuntimeRotationChallenges(reservationInput);
    }
    if (reservation === "stale") {
      return Object.freeze({
        status: "pending",
        reason: "challenge_reservation_stale",
        unavailableDomainIds: Object.freeze([]),
      });
    }

    const completed = [];
    for (const entry of challenges) {
      const responseBytes = await input.source.respond(
        entry.challenge.challengeBytes,
        entry.intent,
      );
      try {
        completed.push(await entry.target.complete({
          plan: entry.intent,
          challenge: entry.challenge,
          responseBytes,
        }));
      } finally {
        responseBytes.fill(0);
      }
    }
    const candidate = aggregateAgentRuntimeRotation({
      crypto: input.crypto,
      publicCandidate: input.source.publicCandidate,
      completedTargets: completed,
      resolveCurrentManagerAuthority:
        input.resolveCurrentRotationManagerAuthority,
      resolveCurrentTargetCommitter:
        input.resolveCurrentTargetCommitter,
    });
    const persistenceInput = {
      crypto: input.crypto,
      storage: input.storage,
      candidate,
      resolveCurrentAuthorization:
        input.resolveRotationPersistenceAuthorization,
    } as const;
    let persistence: Awaited<
      ReturnType<typeof persistAgentRuntimeRotation>
    >;
    try {
      persistence =
        await persistAgentRuntimeRotation(persistenceInput);
    } catch (error) {
      if (!(error instanceof AgentRuntimeRotationOutcomeUnknown)) {
        throw error;
      }
      persistence =
        await persistAgentRuntimeRotation(persistenceInput);
    }
    if (persistence === "stale") {
      return Object.freeze({
        status: "pending",
        reason: "rotation_persistence_stale",
        unavailableDomainIds: Object.freeze([]),
      });
    }
    return Object.freeze({
      status: "completed",
      persistence,
    });
  } finally {
    input.source.close();
    for (const target of input.targets) target.close();
  }
}
