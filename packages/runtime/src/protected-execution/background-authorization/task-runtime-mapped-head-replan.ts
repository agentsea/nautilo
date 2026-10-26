import {
  isVerifiedMappedTaskContentMetadataProof,
  readVerifiedForegroundTaskDefinitionAccessRevision,
  readVerifiedTaskDefinitionAccessLineage,
  type VerifiedTaskDefinitionAccessLineage,
} from "@nautilo/lattice-bridge/server";
import type { TaskContentAuthorityV1, TaskContentRevisionLifecycleV1,
  VerifiedForegroundTaskDefinitionPublication } from "@nautilo/lattice-bridge";
import { taskRuntimeStableIdempotencyKey, type TaskRuntimeGrantStableIdentity } from "./task-runtime-grant-claim";
import type { BackgroundAuthorizationTaskRuntimeRecordV3 } from "./repository";

export type TaskRuntimeMappedHeadReplacementInput = Readonly<{
  expected: BackgroundAuthorizationTaskRuntimeRecordV3;
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3;
  now: number;
  /** Fresh current product/routing facts, retaining the same execution segment. */
  stableIdentity: TaskRuntimeGrantStableIdentity;
  /** Callback-live current Human metadata authority; detached lineage alone cannot mutate. */
  proof: VerifiedForegroundTaskDefinitionPublication;
  lineage: VerifiedTaskDefinitionAccessLineage;
  lifecycle: TaskContentRevisionLifecycleV1;
  currentAuthority: TaskContentAuthorityV1;
}>;

/** The sole admitted identity change is a verified descendant of the immutable definition. */
export function assertTaskRuntimeMappedHeadReplacement(input: TaskRuntimeMappedHeadReplacementInput): void {
  const { expected, replacement, stableIdentity: identity, lifecycle, currentAuthority } = input;
  if (!isVerifiedMappedTaskContentMetadataProof(input.proof)
    || lifecycle.coordinate.kind !== "definition"
    || lifecycle.coordinate.taskId !== identity.taskId
    || lifecycle.coordinate.contentRevision !== identity.contentRevision
    || lifecycle.cryptoObjectId !== identity.contentObjectId
    || lifecycle.namespaceId !== identity.contentNamespaceId
    || lifecycle.representation !== identity.contentRepresentation
    || Buffer.from(lifecycle.requiredNamespaceFingerprint).toString("base64url") !== identity.requiredNamespaceFingerprint
    || expected.snapshot.workId !== identity.taskRunId
    || replacement.snapshot.workId !== identity.taskRunId
    || replacement.snapshot.namespaceId !== identity.contentNamespaceId
    || replacement.domainId !== currentAuthority.domainId
    || replacement.expectedPolicyRevision !== currentAuthority.expectedPolicyRevision
    || replacement.expectedNamespaceAccessRevision !== currentAuthority.expectedAccessRevision
    || expected.expectedPolicyRevision > replacement.expectedPolicyRevision
    || !["awaiting_recipient", "awaiting_device"].includes(expected.snapshot.state)
    || expected.snapshot.acceptedResponse !== null || expected.acceptedMaterial !== null
    || expected.snapshot.claimId !== null || expected.snapshot.claimExpiresAt !== null
    || expected.finishedAt !== null) throw new TypeError("Task mapped-head replacement lacks current unclaimed authority");
  const head = readVerifiedForegroundTaskDefinitionAccessRevision(input.proof, { lifecycle, currentAuthority });
  if (head !== identity.contentAccessRevision || replacement.idempotencyKey !== taskRuntimeStableIdempotencyKey(identity)) {
    throw new TypeError("Task mapped-head replacement changed its fresh stable identity");
  }
  const revisions = readVerifiedTaskDefinitionAccessLineage(input.lineage, identity);
  const matches = revisions.filter(contentAccessRevision => contentAccessRevision < head
    && taskRuntimeStableIdempotencyKey({ ...identity, contentAccessRevision }) === expected.idempotencyKey);
  if (matches.length !== 1) throw new TypeError("Task mapped-head replacement has no unique immutable predecessor");
}
