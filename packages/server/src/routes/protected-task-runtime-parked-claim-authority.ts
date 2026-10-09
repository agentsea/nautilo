import type { DirectDatabase, PersistJobPayload, PostgresJsBridgeConnection } from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  verifyCryptoPostgresHandle,
  withCurrentAcceptedParkedTaskRuntimeAuthority,
  type CurrentTaskRuntimeAuthority,
  type ParkedTaskRuntimeCurrentRoutingFacts,
} from "@nautilo/lattice-bridge/server";
import {
  BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  PostgresBackgroundAuthorizationRepository,
  sameBackgroundAuthorizationRecord,
  sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type ParkedTaskRuntimeClaimAuthorityPort,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  createParkedTaskRuntimeAuthorizationRecord,
  type createParkedTaskRuntimeAuthorizationPlanResolver,
  type ParkedTaskRuntimeAuthorizationPlan,
} from "./protected-task-runtime-parked-plan";
import {
  acceptedTaskRuntimeRecord,
  copyProtectedTaskRuntimeAuthority,
  destroyAcceptedTaskRuntimeRecord,
  destroyProtectedTaskRuntimeAuthority,
} from "./task-runtime-current-authority";

type Repository = BackgroundAuthorizationTaskRuntimeReplacementRepository;
type HeldPlan = Readonly<{
  resolved: ParkedTaskRuntimeAuthorizationPlan;
  canonical: ReturnType<typeof createParkedTaskRuntimeAuthorizationRecord>;
  current: CurrentTaskRuntimeAuthority;
  repository: Repository;
  persistJob(payload: PersistJobPayload): Promise<string>;
}>;

type Operation = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
}>;

type Dependencies = Readonly<{
  productContext: typeof createHumanProductTransactionContext;
  withAuthority: typeof withCurrentAcceptedParkedTaskRuntimeAuthority;
  repository(restricted: PostgresJsBridgeConnection): Promise<Repository>;
}>;

/** Rebuild the parked plan under the same locks that authorize its grant CAS. */
export function createProtectedTaskRuntimeParkedClaimAuthority(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  resolvePlan: ReturnType<typeof createParkedTaskRuntimeAuthorizationPlanResolver>;
  now(): number;
}>, overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    productContext: createHumanProductTransactionContext,
    withAuthority: withCurrentAcceptedParkedTaskRuntimeAuthority,
    repository: async restricted => new PostgresBackgroundAuthorizationRepository(
      await verifyCryptoPostgresHandle(restricted),
    ),
    ...overrides,
  };
  const withPlan = async <Value>(
    operation: Operation,
    use: (held: HeldPlan) => Promise<Value>,
  ): Promise<Value | null> => {
    const occurrence = structuredClone(operation.occurrence);
    const selected = structuredClone(operation.record);
    if (occurrence.run.jobId === null
      || !["grant_ready", "claimed"].includes(selected.snapshot.state)) return null;
    const accepted = acceptedTaskRuntimeRecord(selected);
    if (accepted === null) return null;
    const plan = parseDomainForegroundAuthorizationPlanV2(
      operation.request.authorizationPlanBytes,
    );
    let requestBytes: Uint8Array | null = null;
    try {
      requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(operation.request);
      if (plan === null || selected.descriptorBytes === null
        || !Buffer.from(requestBytes).equals(Buffer.from(selected.descriptorBytes))) return null;
      const resolved = await input.resolvePlan({
        taskRunId: occurrence.run.id,
        authorizationRequestId: selected.snapshot.requestId,
        occurrence,
      });
      if (resolved === null
        || plan.subjectHumanId !== resolved.memory.routing.requesterHumanId
        || selected.expectedPolicyRevision !== resolved.policy.revision) return null;
      const product = await dependencies.productContext(occurrence.task.requestorId, input.db);
      let routing: ParkedTaskRuntimeCurrentRoutingFacts | null = null;
      return await dependencies.withAuthority({
        runner: product.canonicalRunner,
        restricted: input.restricted,
        crypto: input.crypto,
        serverScope: input.serverScope,
        subject: { userId: occurrence.task.requestorId,
          humanActorId: plan.subjectHumanId, deviceId: plan.committerDeviceId },
        accepted,
        now: input.now,
        expected: resolved.expected,
        targetRoomId: resolved.memory.routing.targetRoomId,
        ...(resolved.memory.scopeMemory === undefined ? {} : {
          scopeMemory: resolved.memory.scopeMemory,
        }),
        ...(resolved.memory.expectedNamespaceParticipants === undefined ? {} : {
          expectedNamespaceParticipants: resolved.memory.expectedNamespaceParticipants,
        }),
        validateCurrentRouting: facts => {
          if (!resolved.validateCurrentRouting(facts)) return false;
          routing = structuredClone(facts);
          return true;
        },
        use: async (current, restricted, persistence) => {
          if (routing === null) return null;
          const facts = current.namespaceRequirements.map(namespace => {
            const domain = current.domains.find(value => value.domainId === namespace.domainId);
            if (domain === undefined) throw new TypeError("Parked Task current Domain is missing");
            return { namespaceId: namespace.namespaceId, domainId: namespace.domainId,
              expectedAccessRevision: namespace.expectedAccessRevision,
              expectedPolicyRevision: current.policyRevision,
              expectedDomainEpoch: domain.domainKeyGeneration,
              expectedAuthorizationRevision: domain.authorizationRevision };
          });
          const canonical = createParkedTaskRuntimeAuthorizationRecord(
            resolved, routing, facts, input.now(),
          );
          if (selected.idempotencyKey !== canonical.initialRecord.idempotencyKey
            || !sameTaskRuntimeAuthorityPlan(selected, canonical.initialRecord)) return null;
          const repository = await dependencies.repository(restricted);
          const stored = await repository.get(selected.snapshot.requestId);
          if (stored === null || !sameBackgroundAuthorizationRecord(stored, selected)) return null;
          const before = input.now();
          if (!Number.isSafeInteger(before)
            || (selected.snapshot.state === "claimed"
              && (selected.snapshot.claimExpiresAt === null
                || before >= selected.snapshot.claimExpiresAt))) return null;
          const value = await use({ resolved, canonical, current, repository,
            persistJob: persistence.persistJob });
          // The Lattice owner checks signed authority expiry at commit. A claim
          // lease can be shorter, so its own fence must survive this callback.
          const after = input.now();
          if (!Number.isSafeInteger(after)
            || (selected.snapshot.state === "claimed"
              && (selected.snapshot.claimExpiresAt === null
                || after >= selected.snapshot.claimExpiresAt))) {
            throw new Error("Parked Task claim lease expired before commit");
          }
          return value;
        },
      });
    } finally {
      requestBytes?.fill(0);
      if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
      destroyAcceptedTaskRuntimeRecord(accepted);
    }
  };

  const claim: ParkedTaskRuntimeClaimAuthorityPort = async supplied => {
    const operation = { ...structuredClone({ occurrence: supplied.occurrence,
      record: supplied.record, request: supplied.request }),
      now: supplied.now, use: supplied.use };
    try {
    if (operation.record.snapshot.state !== "grant_ready") return null;
    return await withPlan(operation, async held => {
      const now = operation.now();
      const recipient = operation.record.snapshot.recipient;
      const material = operation.record.acceptedMaterial;
      if (!Number.isSafeInteger(now) || now < operation.request.issuedAt
        || recipient === null || material === null) return null;
      const expiresAt = Math.min(operation.request.deadlineAt, recipient.expiresAt,
        material.authorizationExpiresAt, now + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS);
      if (now >= expiresAt) return null;
      const publicAuthority = copyProtectedTaskRuntimeAuthority(held.current, false);
      try {
        const value = await operation.use(publicAuthority, held.repository, now, expiresAt);
        const finishedAt = operation.now();
        if (!Number.isSafeInteger(finishedAt) || finishedAt >= expiresAt) {
          throw new Error("Parked Task claim authority expired before commit");
        }
        return value;
      } finally {
        destroyProtectedTaskRuntimeAuthority(publicAuthority);
      }
    });
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(operation.request);
    }
  };
  return Object.freeze({ withPlan, claim });
}
