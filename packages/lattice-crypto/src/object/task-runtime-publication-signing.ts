import type { AgentRuntimeGenerationV2 } from "../agent-runtime/types.ts";
import {
  assertAuthenticTaskRuntimeWakeForegroundEvidenceV1,
  type TaskRuntimeWakeForegroundEvidenceV1,
} from "../background/task-runtime-wake-foreground-evidence-v1.ts";
import type { TaskRuntimeTemporarySignerV1 } from "../background/task-runtime-recipient-registry-v1.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import { assertTaskRuntimeTemporarySignerForPreparationV1 } from "./task-runtime-result-preparation-v1.ts";

/** An active loan, forwarded through the existing wake publication owners. */
export type TaskRuntimePublicationSigning = Readonly<{
  evidence: TaskRuntimeWakeForegroundEvidenceV1;
  signer: TaskRuntimeTemporarySignerV1;
}>;

/** Public proof only; never retain the loan's private Runtime key in a preparation. */
export type TaskRuntimePublicationSignerEvidence = Readonly<{
  certificateBytes: Uint8Array;
  issuerSigningPublicKey: Uint8Array;
  hostAuthorizationRevision: number;
}>;

export function prepareTaskRuntimePublicationSigning(
  crypto: LatticeCrypto,
  signing: TaskRuntimePublicationSigning,
  runtime: AgentRuntimeGenerationV2,
  expected: Readonly<{
    operationId: string;
    grant: Readonly<{ grantId: string; grantHash: Uint8Array; recipientKeyId: string }>;
    namespaceIds: readonly string[];
  }>,
): Readonly<{
  signerKeyId: string;
  certificateHash: Uint8Array;
  hostAuthorizationRevision: number;
  signerEvidence: TaskRuntimePublicationSignerEvidence;
}> {
  const { evidence, signer } = signing;
  assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence);
  if (evidence.invocation.operationId !== expected.operationId
    || evidence.requestId !== expected.grant.grantId
    || evidence.recipientKeyId !== expected.grant.recipientKeyId
    || !equal(evidence.authorizationDigest, expected.grant.grantHash)
    || expected.namespaceIds.length === 0
    || expected.namespaceIds.some(namespaceId =>
      !evidence.namespaceRequirements.some(requirement =>
        requirement.namespaceId === namespaceId && requirement.operations.includes("encrypt"))
      && (evidence.additionalMutationDestination?.namespace.namespaceId !== namespaceId
        || !evidence.additionalMutationDestination.namespace.operations.includes("encrypt")))) {
    throw new TypeError("Task publication signing coordinate is not exact");
  }
  const verified = assertTaskRuntimeTemporarySignerForPreparationV1(crypto, evidence, runtime, signer);
  return Object.freeze({
    ...verified,
    signerEvidence: Object.freeze({
      certificateBytes: signer.certificateBytes.slice(),
      issuerSigningPublicKey: signer.issuerSigningPublicKey.slice(),
      hostAuthorizationRevision: verified.hostAuthorizationRevision,
    }),
  });
}

export function copyTaskRuntimePublicationSignerEvidence(
  value: TaskRuntimePublicationSignerEvidence,
): TaskRuntimePublicationSignerEvidence {
  return Object.freeze({ hostAuthorizationRevision: value.hostAuthorizationRevision, certificateBytes: value.certificateBytes.slice(),
    issuerSigningPublicKey: value.issuerSigningPublicKey.slice() });
}

export function equalTaskRuntimePublicationSignerEvidence(
  left: TaskRuntimePublicationSignerEvidence | undefined,
  right: TaskRuntimePublicationSignerEvidence | undefined,
): boolean {
  return left === undefined ? right === undefined
    : right !== undefined && left.hostAuthorizationRevision === right.hostAuthorizationRevision
      && equal(left.certificateBytes, right.certificateBytes)
      && equal(left.issuerSigningPublicKey, right.issuerSigningPublicKey);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
