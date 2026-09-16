import {
  AgentRuntimeChallengeReservationOutcomeUnknown,
  coordinateAgentRuntimeAuthorizationTransition,
  destroyAgentRuntimeAuthorizationTransitionSourceLocal,
  prepareAgentRuntimeAuthorizationTransitionSource,
  prepareAgentRuntimeManagerHandoffResponse,
  reserveAgentRuntimeRotationChallenges,
  type AgentRuntimeAuthorizationTransitionPlan,
  type AgentRuntimeAuthorizationTransitionPublicCandidate,
  type AgentRuntimeChallengeReservationStorage,
  type AgentRuntimeAuthorizationTransitionStorage,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeRotationState,
  type LatticeCrypto,
  type ResolveCurrentAgentRuntimeAuthorizationTransitionManager,
  type ResolveCurrentAgentRuntimeAuthorizationTransitionPersistence,
  type ResolveCurrentAgentRuntimeChallengeReservationAuthorization,
} from "@nautilo/lattice-crypto";
import type {
  AgentRuntimeManagerHandoffPlanV1,
  ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1,
  ResolveCurrentAgentRuntimeManagerHandoffTargetV1,
} from "@nautilo/lattice-crypto/wire";
import type {
  ProtectedAgentRuntimeRotationTargetPort,
} from "./protected-agent-runtime-rotation.ts";

export interface ProtectedAgentRuntimeAuthorizationTransitionSourcePort {
  readonly publicCandidate:
    AgentRuntimeAuthorizationTransitionPublicCandidate;
  readonly respond: (
    challengeBytes: Uint8Array,
    expectedPlan: AgentRuntimeManagerHandoffPlanV1,
  ) => Promise<Uint8Array>;
  readonly close: () => void;
}

export type ProtectedAgentRuntimeAuthorizationTransitionResult =
  | Readonly<{
    readonly status: "completed";
    readonly persistence: "applied" | "duplicate";
  }>
  | Readonly<{
    readonly status: "pending";
    readonly reason:
      | "challenge_reservation_stale"
      | "transition_persistence_stale"
      | "target_unavailable";
    readonly unavailableDomainIds: readonly string[];
  }>;

/**
 * Device-side custody for a Runtime-preserving authorization transition.
 * The current Runtime and manager key remain closure-owned and are wiped on
 * every terminal path.
 */
export function createProtectedAgentRuntimeAuthorizationTransitionSourcePort(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly currentState: AgentRuntimeRotationState;
    readonly currentRuntime: AgentRuntimeKeyGeneration;
    readonly plan: AgentRuntimeAuthorizationTransitionPlan;
    readonly resolveCurrentManagerAuthority:
      ResolveCurrentAgentRuntimeAuthorizationTransitionManager;
    readonly resolveCurrentHandoffManagerAuthority:
      ResolveCurrentAgentRuntimeManagerHandoffAuthorityV1;
    readonly resolveCurrentTargetCommitter:
      ResolveCurrentAgentRuntimeManagerHandoffTargetV1;
    readonly managerSigningPrivateKey: Uint8Array;
  }>,
): ProtectedAgentRuntimeAuthorizationTransitionSourcePort {
  const prepared = prepareAgentRuntimeAuthorizationTransitionSource({
    crypto: input.crypto,
    currentState: input.currentState,
    currentRuntime: input.currentRuntime,
    plan: input.plan,
    resolveCurrentManagerAuthority:
      input.resolveCurrentManagerAuthority,
    managerSigningPrivateKey: input.managerSigningPrivateKey,
  });
  const managerPrivate = input.managerSigningPrivateKey.slice();
  let closed = false;
  return Object.freeze({
    publicCandidate: prepared.publicCandidate,
    respond: async (
      challengeBytes: Uint8Array,
      expectedPlan: AgentRuntimeManagerHandoffPlanV1,
    ) => {
      if (closed) {
        throw new Error(
          "Protected Runtime authorization transition source is closed",
        );
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
      destroyAgentRuntimeAuthorizationTransitionSourceLocal(
        prepared.sourceLocal,
      );
    },
  });
}

/**
 * Server-safe first/additional/last Domain-envelope transition. Only signed
 * public plans, opaque handoff material, and authorized storage capabilities
 * cross this coordinator.
 */
export async function coordinateProtectedAgentRuntimeAuthorizationTransition(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage:
      AgentRuntimeAuthorizationTransitionStorage
      & AgentRuntimeChallengeReservationStorage;
    readonly source:
      ProtectedAgentRuntimeAuthorizationTransitionSourcePort;
    readonly targets:
      readonly ProtectedAgentRuntimeRotationTargetPort[];
    readonly resolveChallengeReservationAuthorization:
      ResolveCurrentAgentRuntimeChallengeReservationAuthorization;
    readonly resolveTransitionPersistenceAuthorization:
      ResolveCurrentAgentRuntimeAuthorizationTransitionPersistence;
  }>,
): Promise<ProtectedAgentRuntimeAuthorizationTransitionResult> {
  try {
    const intents = input.source.publicCandidate.targetIntents;
    const intendedDomainIds =
      intents.map((intent) => String(intent.target.domainId));
    const intendedDomainIdSet = new Set(intendedDomainIds);
    const targetByDomain =
      new Map<string, ProtectedAgentRuntimeRotationTargetPort>();
    for (const target of input.targets) {
      if (
        targetByDomain.has(target.domainId)
        || !intendedDomainIdSet.has(target.domainId)
      ) {
        throw new TypeError(
          "Protected Runtime authorization transition targets must exactly match the candidate",
        );
      }
      targetByDomain.set(target.domainId, target);
    }
    const unavailableDomainIds =
      intendedDomainIds.filter((domainId) =>
        !targetByDomain.has(domainId)
      );
    if (unavailableDomainIds.length > 0) {
      return Object.freeze({
        status: "pending",
        reason: "target_unavailable",
        unavailableDomainIds: Object.freeze(unavailableDomainIds),
      });
    }
    const challenges = [];
    for (const intent of intents) {
      const target = targetByDomain.get(intent.target.domainId)!;
      challenges.push(Object.freeze({
        intent,
        target,
        challenge: await target.challenge(intent),
      }));
    }
    if (challenges.length > 0) {
      const reservationInput = {
        storage: input.storage,
        request: {
          operationId:
            input.source.publicCandidate.plan.operationId,
          expectedState:
            input.source.publicCandidate.expectedState,
          currentManager:
            input.source.publicCandidate.plan.currentManager,
          remainingDomains: intents.map((intent) => intent.target),
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
          !(error instanceof
            AgentRuntimeChallengeReservationOutcomeUnknown)
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
    }
    const completions = [];
    for (const entry of challenges) {
      const response = await input.source.respond(
        entry.challenge.challengeBytes,
        entry.intent,
      );
      try {
        completions.push(await entry.target.complete({
          plan: entry.intent,
          challenge: entry.challenge,
          responseBytes: response,
        }));
      } finally {
        response.fill(0);
      }
    }
    const persistence =
      await coordinateAgentRuntimeAuthorizationTransition({
        crypto: input.crypto,
        storage: input.storage,
        publicCandidate: input.source.publicCandidate,
        completedTargets: completions,
        resolveCurrentAuthorization:
          input.resolveTransitionPersistenceAuthorization,
      });
    if (persistence === "stale") {
      return Object.freeze({
        status: "pending",
        reason: "transition_persistence_stale",
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
