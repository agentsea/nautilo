import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  decodeObjectAccessManifestV5,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  encodeLiveShadowMessagePlanV4,
  parseDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationV2,
  verifyHistoricalDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";

import {
  deriveTaskDefinitionForegroundRecipientKeyIdV1,
  parseTaskDefinitionForegroundAuthorizationIdV1,
} from "../../task/task-definition-foreground-authorization-id-v1.ts";
import { foregroundAgentSignerPrincipalKeyV1 } from
  "../foreground-agent-accepted-execution.ts";

const MAX_EVIDENCE_BYTES = 3_675;

type AcceptedExecutionEvidence = Readonly<{
  kind: "foreground_agent_accepted_execution";
  planBytesBase64url: string;
  planDigestBase64url: string;
}>;

type TaskAuthorizationEvidence = Readonly<{
  kind: "task_definition_foreground_authorization";
  evidenceBytesBase64url: string;
}>;

export function exactTaskDefinitionForegroundAgentSignerKeysV1(input: Readonly<{
  crypto: LatticeCrypto;
  evidence: readonly unknown[];
  genesisManifestBytes: Uint8Array;
  taskId: string;
  contentRevision: number;
  namespaceId: string;
  domainId: string;
  privateRoomId: string;
  expectedHumanId: string;
  resolveHistoricalDeviceSigningPublicKey(input: Readonly<{
    humanId: string;
    deviceId: string;
    deviceGeneration: number;
    hostAuthorizationRevision: number;
  }>): Uint8Array | null;
}>): Map<string, Uint8Array> {
  const taskEvidence = input.evidence.filter((candidate): candidate is
    TaskAuthorizationEvidence => typeof candidate === "object"
      && candidate !== null && !Array.isArray(candidate)
      && (candidate as { kind?: unknown }).kind
        === "task_definition_foreground_authorization");
  const parentEvidence = input.evidence.filter((candidate): candidate is
    AcceptedExecutionEvidence => typeof candidate === "object"
      && candidate !== null && !Array.isArray(candidate)
      && (candidate as { kind?: unknown }).kind
        === "foreground_agent_accepted_execution");
  if (taskEvidence.length !== 1 || parentEvidence.length !== 1) {
    throw new TypeError("Task definition authorization evidence is inexact");
  }
  assertFields(taskEvidence[0]!, ["evidenceBytesBase64url", "kind"]);
  assertFields(parentEvidence[0]!, [
    "kind", "planBytesBase64url", "planDigestBase64url",
  ]);
  const authorizationBytes = fromBase64url(
    "Task definition authorization",
    taskEvidence[0]!.evidenceBytesBase64url,
  );
  const parentBytes = fromBase64url(
    "Task definition parent plan",
    parentEvidence[0]!.planBytesBase64url,
  );
  const parentDigest = fromBase64url(
    "Task definition parent plan digest",
    parentEvidence[0]!.planDigestBase64url,
  );
  let manifest: ReturnType<typeof decodeObjectAccessManifestV5> | null = null;
  let authorization: ReturnType<
    typeof parseDomainForegroundAuthorizationV2
  > = null;
  let parent: ReturnType<typeof decodeLiveShadowMessagePlanV4> | null = null;
  let plan: ReturnType<typeof parseDomainForegroundAuthorizationPlanV2> = null;
  let coordinates: ReturnType<
    typeof parseTaskDefinitionForegroundAuthorizationIdV1
  > = null;
  let actualParentDigest: Uint8Array | undefined;
  let canonicalParent: Uint8Array | undefined;
  let authorizationHash: Uint8Array | undefined;
  const keys = new Map<string, Uint8Array>();
  try {
    manifest = decodeObjectAccessManifestV5(input.genesisManifestBytes);
    authorization = parseDomainForegroundAuthorizationV2(
      authorizationBytes,
    );
    parent = decodeLiveShadowMessagePlanV4(parentBytes);
    if (authorization === null
      || authorizationBytes.length > MAX_EVIDENCE_BYTES
      || manifest.signer.kind !== "agent_runtime"
      || manifest.signerAuthorizationHash === null) {
      throw new TypeError("Task definition authorization evidence is invalid");
    }
    plan = parseDomainForegroundAuthorizationPlanV2(authorization.planBytes);
    coordinates = parseTaskDefinitionForegroundAuthorizationIdV1(
      authorization.authorizationId,
    );
    actualParentDigest = input.crypto.hash(parentBytes);
    canonicalParent = encodeLiveShadowMessagePlanV4(parent);
    authorizationHash = input.crypto.hash(authorizationBytes);
    const domain = plan?.domains[0];
    if (plan === null || coordinates === null || domain === undefined
      || parentDigest.length !== 32
      || !same(actualParentDigest, parentDigest)
      || !same(canonicalParent, parentBytes)
      || !same(authorizationHash, manifest.signerAuthorizationHash)
      || authorization.authorizationId !== plan.authorizationId
      || coordinates.taskId !== input.taskId
      || coordinates.operation !== (input.contentRevision === 1
        ? "create" : "update")
      || coordinates.targetContentRevision !== input.contentRevision
      || !matchesParentOperation(input.crypto, coordinates.parentOperationHash,
        parent.operationId)
      || parent.subjectHumanId !== input.expectedHumanId
      || parent.recipientAgentId !== manifest.signer.agentId
      || parent.agentRuntimeGeneration !== manifest.signer.runtimeGeneration
      || parent.agentSignerKeyId !== manifest.signer.signerKeyId
      || plan.policyRevision !== parent.policyRevision
      || plan.sessionId !== parent.sessionId
      || plan.subjectHumanId !== parent.subjectHumanId
      || plan.committerDeviceId !== parent.committerDeviceId
      || plan.committerDeviceSigningGeneration
        !== parent.committerDeviceSigningKeyGeneration
      || plan.hostAuthorizationRevision !== parent.hostAuthorizationRevision
      || plan.recipientKeyId
        !== deriveTaskDefinitionForegroundRecipientKeyIdV1(input.crypto, {
          authorizationId: authorization.authorizationId,
          parentAgentSignerPublicKey: parent.agentSignerPublicKey,
        })
      || plan.issuedAt < parent.issuedAt
      // The Device-signed Task plan owns this historical grant's lifetime.
      // The unsigned V4 deadline only admitted the parent Message request;
      // publication checks containment in the accepted grant on the server.
      || plan.roomId !== input.privateRoomId
      || plan.recipientKind !== "runtime"
      || plan.recipientPrincipalId !== "nautilo_foreground_runtime"
      || plan.recipientAuthorizationRevision !== 0
      || plan.recipientRuntimeGeneration !== 0
      || plan.operations.length !== 2
      || plan.operations[0] !== "decrypt"
      || plan.operations[1] !== "encrypt"
      || plan.domains.length !== 1
      || domain.sourceNamespaceId !== input.namespaceId
      || domain.domainId !== input.domainId) {
      throw new TypeError("Task definition authorization binding is invalid");
    }
    const deviceKey = input.resolveHistoricalDeviceSigningPublicKey({
      humanId: input.expectedHumanId,
      deviceId: plan.committerDeviceId,
      deviceGeneration: plan.committerDeviceSigningGeneration,
      hostAuthorizationRevision: plan.hostAuthorizationRevision,
    });
    if (deviceKey === null || verifyHistoricalDomainForegroundAuthorizationV2(
      input.crypto,
      {
        authorizationBytes,
        expectedPlanBytes: authorization.planBytes,
        committerDeviceSigningPublicKey: deviceKey,
      },
    ).status !== "verified") {
      throw new TypeError("Task definition Device signature is invalid");
    }
    keys.set(foregroundAgentSignerPrincipalKeyV1(manifest.signer),
      parent.agentSignerPublicKey.slice());
    return keys;
  } catch (error) {
    keys.forEach(key => key.fill(0));
    throw error;
  } finally {
    authorizationBytes.fill(0);
    parentBytes.fill(0);
    parentDigest.fill(0);
    actualParentDigest?.fill(0);
    canonicalParent?.fill(0);
    authorizationHash?.fill(0);
    coordinates?.parentOperationHash.fill(0);
    coordinates?.workDescriptorDigest.fill(0);
    if (manifest !== null) wipeManifest(manifest);
    if (parent !== null) wipeParent(parent);
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    if (authorization !== null) destroyDomainForegroundAuthorizationV2(authorization);
  }
}

function matchesParentOperation(
  crypto: Pick<LatticeCrypto, "hash">,
  expected: Uint8Array,
  operationId: string,
): boolean {
  const material = new TextEncoder().encode(
    `nautilo/task-definition-parent-operation/v1\n${operationId}`,
  );
  const actual = crypto.hash(material);
  try { return same(actual, expected); }
  finally { material.fill(0); actual.fill(0); }
}

function assertFields(value: object, expected: readonly string[]): void {
  const fields = Object.keys(value).sort();
  if (fields.length !== expected.length
    || fields.some((field, index) => field !== expected[index])) {
    throw new TypeError("Task definition authorization evidence fields are inexact");
  }
}

function fromBase64url(label: string, value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)
    || value.length % 4 === 1) throw new TypeError(`${label} is invalid`);
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+")
    .replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)),
  character => character.charCodeAt(0));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "") !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is invalid`);
  }
  return bytes;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function wipeManifest(
  manifest: ReturnType<typeof decodeObjectAccessManifestV5>,
): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach(hash => hash.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  manifest.signature.fill(0);
}

function wipeParent(
  plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>,
): void {
  plan.agentSignerPublicKey.fill(0);
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
  plan.grantDomainParticipantDigest.fill(0);
  plan.grantDomainHeadDigest.fill(0);
  plan.grantDomainPublicationDigest.fill(0);
  plan.namespaceBundleDigest.fill(0);
  if (plan.authorization.disposition === "authorization_required") {
    plan.authorization.authorizationPlanBytes.fill(0);
    plan.authorization.authorizationPlanDigest.fill(0);
    plan.authorization.recipientPublicKey.fill(0);
  } else {
    plan.authorization.authorizationDigest.fill(0);
  }
}
