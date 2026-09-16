import type {
  ProtectedArtifactAccessOperationV1,
  ProtectedArtifactAccessPlanResponseV1,
  ProtectedArtifactAccessUpdateResponseV1,
  ProtectedArtifactPreparedAccessRequestV1,
  ProtectedArtifactUnavailableResponseV1,
} from "@nautilo/api-client";

import type {
  AuthenticatedHumanArtifactExactAccessPrepared,
} from "./postgres-human-artifact-exact-access-crypto.ts";
import type {
  HumanArtifactExactAccessAuthority,
} from "./human-artifact-exact-access.ts";
import type {
  HumanArtifactExactAccessCommitResult,
  HumanArtifactExactAccessCryptoObservation,
  HumanArtifactExactAccessCryptoReceipt,
  HumanArtifactExactAccessPlan,
  HumanArtifactExactAccessPlanResult,
  HumanArtifactExactAccessReconcileResult,
  HumanArtifactExactAccessReplayLookup,
  HumanArtifactExactAccessTarget,
} from "./postgres-human-artifact-exact-access-product.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
type Unavailable = ProtectedArtifactUnavailableResponseV1;

export interface HumanArtifactExactAccessRoutePorts {
  planAccess(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    artifactId: string;
    operation: ProtectedArtifactAccessOperationV1;
  }>): Promise<ProtectedArtifactAccessPlanResponseV1 | Unavailable>;
  commitAccess(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    artifactId: string;
    prepared: ProtectedArtifactPreparedAccessRequestV1;
  }>): Promise<ProtectedArtifactAccessUpdateResponseV1 | Unavailable>;
}

export type HumanArtifactExactAccessProductRoutePort = Readonly<{
  resolveTarget(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    artifactId: string;
    operation: ProtectedArtifactAccessOperationV1;
  }>): Promise<HumanArtifactExactAccessTarget | Unavailable>;
  plan(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    operationId: string;
    artifactId: string;
    target: HumanArtifactExactAccessTarget;
  }>): Promise<HumanArtifactExactAccessPlanResult>;
  reserve(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    plan: HumanArtifactExactAccessPlan;
    signedRequestDigest: Uint8Array;
  }>): Promise<"reserved" | "replayed">;
  lookupReplay(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    operationId: string;
    artifactId: string;
    signedRequestDigest: Uint8Array;
  }>): Promise<HumanArtifactExactAccessReplayLookup>;
  commit(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    plan: HumanArtifactExactAccessPlan;
    receipt: HumanArtifactExactAccessCryptoReceipt;
  }>): Promise<HumanArtifactExactAccessCommitResult>;
  reconcile(input: Readonly<{
    authority: HumanArtifactExactAccessAuthority;
    operationId: string;
    artifactId: string;
    crypto: HumanArtifactExactAccessCryptoObservation;
  }>): Promise<HumanArtifactExactAccessReconcileResult>;
}>;

export type HumanArtifactExactAccessCryptoRoutePort = Readonly<{
  digestSignedRequest(prepared: ProtectedArtifactPreparedAccessRequestV1): Uint8Array;
  authenticate(input: Readonly<{
    plan: HumanArtifactExactAccessPlan;
    prepared: ProtectedArtifactPreparedAccessRequestV1;
    now: number;
  }>): Promise<Readonly<{
    handle: AuthenticatedHumanArtifactExactAccessPrepared;
    signedRequestDigest: Uint8Array;
  }>>;
  complete(
    handle: AuthenticatedHumanArtifactExactAccessPrepared,
  ): Promise<HumanArtifactExactAccessCryptoReceipt>;
  observe(cryptoObjectId: string): Promise<HumanArtifactExactAccessCryptoObservation>;
}>;

function unavailable(reason: Unavailable["reason"]): Unavailable {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameAuthority(
  left: HumanArtifactExactAccessAuthority,
  right: HumanArtifactExactAccessAuthority,
): boolean {
  return left.userId === right.userId
    && left.subjectHumanId === right.subjectHumanId
    && left.actorId === right.actorId
    && left.agentId === null && right.agentId === null
    && sameIds(left.readableNamespaceIds, right.readableNamespaceIds)
    && sameIds(left.mutableNamespaceIds, right.mutableNamespaceIds)
    && sameIds(left.writableNamespaceIds, right.writableNamespaceIds);
}

function exactPlan(
  plan: HumanArtifactExactAccessPlan,
  prepared: ProtectedArtifactPreparedAccessRequestV1,
): boolean {
  return plan.operationId === prepared.operationId
    && plan.artifactId === prepared.artifactId
    && plan.artifactRevision === prepared.artifactRevision
    && plan.cryptoObjectId === prepared.cryptoObjectId
    && plan.blobId === prepared.blobId
    && plan.blobGeneration === prepared.blobGeneration
    && plan.expectedCryptoAccessRevision === prepared.expectedCryptoAccessRevision
    && plan.nextCryptoAccessRevision === prepared.nextCryptoAccessRevision
    && sameIds(plan.currentNamespaceIds, prepared.currentNamespaceIds)
    && sameIds(plan.targetNamespaceIds, prepared.targetNamespaceIds);
}

function planResponse(
  plan: HumanArtifactExactAccessPlan,
  deadlineAt: number,
): ProtectedArtifactAccessPlanResponseV1 {
  const binding = (value: HumanArtifactExactAccessPlan["currentBindings"][number]) => ({
    namespaceId: value.namespaceId,
    domainId: value.domainId,
    expectedAccessRevision: value.expectedAccessRevision,
    expectedPolicyRevision: value.expectedPolicyRevision,
    bindingHashBase64url: Buffer.from(value.bindingHash).toString("base64url"),
  });
  return Object.freeze({
    dtoVersion: 1, status: "planned", planVersion: 1,
    operationId: plan.operationId, artifactId: plan.artifactId,
    artifactRevision: plan.artifactRevision,
    expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
    nextCryptoAccessRevision: plan.nextCryptoAccessRevision,
    cryptoObjectId: plan.cryptoObjectId, blobId: plan.blobId,
    blobGeneration: plan.blobGeneration,
    currentNamespaceIds: [...plan.currentNamespaceIds],
    targetNamespaceIds: [...plan.targetNamespaceIds],
    addedNamespaceIds: [...plan.addedNamespaceIds],
    removedNamespaceIds: [...plan.removedNamespaceIds],
    currentBindings: plan.currentBindings.map(binding),
    targetBindings: plan.targetBindings.map(binding),
    sourceAuthorized: true, targetAuthorized: true, deadlineAt,
  });
}

export function createHumanArtifactExactAccessRoutePorts(input: Readonly<{
  target: HumanArtifactExactAccessAuthority;
  now(): number;
  deadlineAt(): number;
  createOperationId(): string;
  product: HumanArtifactExactAccessProductRoutePort;
  crypto: HumanArtifactExactAccessCryptoRoutePort;
}>): HumanArtifactExactAccessRoutePorts {
  const target = Object.freeze({ ...input.target,
    readableNamespaceIds: Object.freeze([...input.target.readableNamespaceIds]),
    mutableNamespaceIds: Object.freeze([...input.target.mutableNamespaceIds]),
    writableNamespaceIds: Object.freeze([...input.target.writableNamespaceIds]) });
  const authorized = (authority: HumanArtifactExactAccessAuthority) =>
    sameAuthority(authority, target);
  return Object.freeze({
    async planAccess(operation: Parameters<
      HumanArtifactExactAccessRoutePorts["planAccess"]
    >[0]) {
      if (!authorized(operation.authority) || !UUID.test(operation.artifactId)) {
        return unavailable("authorization_required");
      }
      const operationId = input.createOperationId();
      if (!PORTABLE_ID.test(operationId)) return unavailable("integrity_failure");
      const resolved = await input.product.resolveTarget({
        authority: target, artifactId: operation.artifactId,
        operation: operation.operation,
      });
      if ("dtoVersion" in resolved) return resolved;
      const plan = await input.product.plan({ authority: target, operationId,
        artifactId: operation.artifactId, target: resolved });
      if (plan.status === "unavailable") return unavailable(plan.reason);
      if (plan.status === "unchanged") return Object.freeze({
        dtoVersion: 1, status: "unchanged", artifactId: plan.artifactId,
        cryptoAccessRevision: plan.cryptoAccessRevision,
        requiredNamespaceIds: [...plan.requiredNamespaceIds],
      });
      return planResponse(plan, input.deadlineAt());
    },
    async commitAccess(operation: Parameters<
      HumanArtifactExactAccessRoutePorts["commitAccess"]
    >[0]) {
      if (!authorized(operation.authority)
        || operation.artifactId !== operation.prepared.artifactId) {
        return unavailable("authorization_required");
      }
      const digest = input.crypto.digestSignedRequest(operation.prepared);
      try {
        if (digest.length !== 32) return unavailable("integrity_failure");
        const replay = await input.product.lookupReplay({ authority: target,
          operationId: operation.prepared.operationId,
          artifactId: operation.artifactId, signedRequestDigest: digest });
        if (replay.status === "conflict") return unavailable("integrity_failure");
        if (replay.status === "completed") return Object.freeze({
          dtoVersion: 1, status: "replayed", operationId: operation.prepared.operationId,
          artifactId: operation.artifactId,
          cryptoAccessRevision: replay.cryptoAccessRevision,
          requiredNamespaceIds: [...replay.requiredNamespaceIds],
        });
        if (replay.status === "pending") {
          const reconciled = await input.product.reconcile({ authority: target,
            operationId: operation.prepared.operationId,
            artifactId: operation.artifactId,
            crypto: await input.crypto.observe(replay.cryptoObjectId) });
          return reconciled.status === "completed"
            ? Object.freeze({ dtoVersion: 1 as const, status: "replayed" as const,
                operationId: operation.prepared.operationId,
                artifactId: operation.artifactId,
                cryptoAccessRevision: reconciled.cryptoAccessRevision,
                requiredNamespaceIds: [...reconciled.requiredNamespaceIds] })
            : unavailable(reconciled.status === "pending" ? "encryption_pending"
              : reconciled.status === "stale" ? "stale_revision"
              : reconciled.status === "denied" ? "authorization_required"
              : "integrity_failure");
        }
        const plan = await input.product.plan({ authority: target,
          operationId: operation.prepared.operationId,
          artifactId: operation.artifactId,
          target: { kind: "replace_exact",
            namespaceIds: operation.prepared.targetNamespaceIds } });
        if (plan.status !== "prepared" || !exactPlan(plan, operation.prepared)) {
          return unavailable("stale_revision");
        }
        let admission: Awaited<ReturnType<typeof input.crypto.authenticate>>;
        try {
          admission = await input.crypto.authenticate({ plan,
            prepared: operation.prepared, now: input.now() });
        } catch {
          return unavailable("integrity_failure");
        }
        try {
          if (!equalDigest(digest, admission.signedRequestDigest)) {
            return unavailable("integrity_failure");
          }
          await input.product.reserve({ authority: target, plan,
            signedRequestDigest: admission.signedRequestDigest });
          const receipt = await input.crypto.complete(admission.handle);
          const committed = await input.product.commit({ authority: target,
            plan, receipt });
          return Object.freeze({ dtoVersion: 1, ...committed,
            requiredNamespaceIds: [...committed.requiredNamespaceIds] });
        } finally {
          admission.signedRequestDigest.fill(0);
        }
      } finally {
        digest.fill(0);
      }
    },
  });
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}
