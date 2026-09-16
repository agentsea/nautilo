import {
  and,
  conversationSharedAgentShadowExecutions as executions,
  conversationSharedAgentShadowInvocations as invocations,
  conversationShadowTurnAgentSigners as signers,
  conversationShadowTurnOperations as turns,
  desc,
  eq,
  isNotNull,
  or,
  sql,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  agentRuntimeObjectSignerKeyIdV1,
  decodeLiveShadowMessagePlanV4,
} from "@nautilo/lattice-crypto/wire";

import type { ResolveLiveShadowAgentObjectSigner } from
  "../storage/postgres-object-access-manifest-v5.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
} from "./postgres-conversation-product-store.ts";

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Server-retained accepted execution authority, not portable signed evidence.
 * Historical acceptance outlives a turn's deadline, terminal state, and process.
 * Current content access must still be checked by the foreground entity gateway.
 */
export type ForegroundAgentAcceptedExecutionEvidence = Readonly<{
  signerPublicKey: Uint8Array;
  planBytes: Uint8Array;
  planDigest: Uint8Array;
}>;

export type ResolveForegroundAgentAcceptedExecutionEvidence = (
  principal: Parameters<ResolveLiveShadowAgentObjectSigner>[0],
) => Promise<ForegroundAgentAcceptedExecutionEvidence | null>;

export function createPostgresForegroundAgentAcceptedExecutionEvidenceResolver(input: Readonly<{
  product: ConversationProductPostgresHandle;
  crypto: LatticeCrypto;
}>): ResolveForegroundAgentAcceptedExecutionEvidence {
  assertVerifiedConversationProductPostgresHandle(input.product);
  const authenticate = (
    row: ConversationProductDatabaseRow,
    principal: Parameters<ResolveLiveShadowAgentObjectSigner>[0],
    shared: boolean,
  ): ForegroundAgentAcceptedExecutionEvidence | null => {
    const planBytes = row["plan_bytes"];
    const planDigest = row["plan_digest"];
    const publicKey = row["agent_signer_public_key"];
    const invocationBacked = shared && row["invocation_id"] != null;
    const acceptedDigest = shared
      ? invocationBacked ? row["invocation_authorization_digest"] : row["authorization_digest"]
      : row["grant_digest"];
    if (
      !(planBytes instanceof Uint8Array)
      || !(planDigest instanceof Uint8Array)
      || !(publicKey instanceof Uint8Array)
      || !(acceptedDigest instanceof Uint8Array)
      || acceptedDigest.length !== 32
      || (shared && row["authorized_at"] == null)
      || (!shared && (
        !(row["human_request_digest"] instanceof Uint8Array)
        || row["human_request_digest"].length !== 32
      ))
    ) return null;
    if (invocationBacked) {
      const executionInput = row["input_set_digest"];
      const invocationInput = row["invocation_input_set_digest"];
      const inputCount = row["input_count"];
      if (
        typeof row["invocation_id"] !== "string"
        || row["invocation_id"].length === 0
        || row["joined_invocation_id"] !== row["invocation_id"]
        || row["invocation_authorized_at"] == null
        || (row["execution_kind"] !== "turn" && row["execution_kind"] !== "resume")
        || typeof row["invocation_session_id"] !== "string"
        || row["invocation_session_id"].length === 0
        || (row["execution_kind"] === "resume"
          && row["invocation_session_id"] !== row["session_id"])
        || row["invocation_room_id"] !== row["room_id"]
        || row["invocation_invoking_human_id"] !== row["invoking_human_id"]
        || row["invocation_invoking_device_id"] !== row["invoking_device_id"]
        || row["invocation_authorization_device_id"] !== row["authorization_device_id"]
        || row["invocation_client_action_session_id"] !== row["client_action_session_id"]
        || row["invocation_policy_revision"] !== row["policy_revision"]
        || typeof inputCount !== "number" || !Number.isSafeInteger(inputCount) || inputCount < 1
        || row["invocation_input_count"] !== inputCount
        || !(executionInput instanceof Uint8Array) || executionInput.length !== 32
        || !(invocationInput instanceof Uint8Array) || !equal(executionInput, invocationInput)
      ) return null;
    }
    let digest: Uint8Array | undefined;
    let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4> | undefined;
    try {
      digest = input.crypto.hash(planBytes);
      if (!equal(digest, planDigest)) return null;
      plan = decodeLiveShadowMessagePlanV4(planBytes);
      if (
        plan.operationId !== row[shared ? "execution_id" : "operation_id"]
        || plan.sessionId !== row["session_id"]
        || plan.roomId !== row["room_id"]
        || plan.recipientAgentId !== principal.agentId
        || row["agent_id"] !== principal.agentId
        || plan.agentRuntimeGeneration !== principal.runtimeGeneration
        || Number(row["agent_runtime_generation"]) !== principal.runtimeGeneration
        || plan.agentSignerKeyId !== principal.signerKeyId
        || row["agent_signer_key_id"] !== principal.signerKeyId
        || !equal(plan.agentSignerPublicKey, publicKey)
        || agentRuntimeObjectSignerKeyIdV1(input.crypto, publicKey)
          !== principal.signerKeyId
        || (invocationBacked && (
          plan.subjectHumanId !== row["invoking_human_id"]
          || plan.committerDeviceId !== row["authorization_device_id"]
          || plan.policyRevision !== row["policy_revision"]
        ))
        // Invocation-backed V4 plans are server work descriptors, not the
        // separately accepted Runtime grant. Bind that grant to its exact
        // execution inputs above; only legacy plans share its digest.
        || (!invocationBacked && plan.authorization.disposition === "authorization_reusable"
          && !equal(plan.authorization.authorizationDigest, acceptedDigest))
      ) return null;
      return Object.freeze({
        // postgres-js bytea values can be Buffers: Buffer.slice() aliases the
        // row, so later evidence cleanup would also erase the returned signer.
        signerPublicKey: Uint8Array.from(publicKey),
        planBytes: Uint8Array.from(planBytes),
        planDigest: Uint8Array.from(planDigest),
      });
    } catch {
      return null;
    } finally {
      digest?.fill(0);
      if (plan !== undefined) {
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
        } else plan.authorization.authorizationDigest.fill(0);
      }
    }
  };
  return async (principal) => {
    const shared = await executeTypedConversationProductQuery(input.product,
      conversationProductTypedDb.select({
        operationId: executions.executionId,
        sessionId: executions.sessionId,
        roomId: executions.roomId,
        agentId: executions.agentId,
        agentRuntimeGeneration: executions.agentRuntimeGeneration,
        agentSignerKeyId: executions.agentSignerKeyId,
        agentSignerPublicKey: executions.agentSignerPublicKey,
        planBytes: executions.planBytes,
        planDigest: executions.planDigest,
        authorizedAt: executions.authorizedAt,
        authorizationDigest: executions.authorizationDigest,
        invocationId: executions.invocationId,
        executionKind: executions.executionKind,
        invokingHumanId: executions.invokingHumanId,
        invokingDeviceId: executions.invokingDeviceId,
        authorizationDeviceId: executions.authorizationDeviceId,
        clientActionSessionId: executions.clientActionSessionId,
        policyRevision: executions.policyRevision,
        inputCount: executions.inputCount,
        inputSetDigest: executions.inputSetDigest,
        joined_invocation_id: sql`${invocations.invocationId}`.as("joined_invocation_id"),
        invocation_session_id: sql`${invocations.sessionId}`.as("invocation_session_id"),
        invocation_room_id: sql`${invocations.roomId}`.as("invocation_room_id"),
        invocation_invoking_human_id: sql`${invocations.invokingHumanId}`.as("invocation_invoking_human_id"),
        invocation_invoking_device_id: sql`${invocations.invokingDeviceId}`.as("invocation_invoking_device_id"),
        invocation_authorization_device_id: sql`${invocations.authorizationDeviceId}`.as("invocation_authorization_device_id"),
        invocation_client_action_session_id: sql`${invocations.clientActionSessionId}`.as("invocation_client_action_session_id"),
        invocation_policy_revision: sql`${invocations.policyRevision}`.as("invocation_policy_revision"),
        invocation_input_count: sql`${invocations.inputCount}`.as("invocation_input_count"),
        invocation_input_set_digest: sql`${invocations.inputSetDigest}`.as("invocation_input_set_digest"),
        invocation_authorized_at: sql`${invocations.authorizedAt}`.as("invocation_authorized_at"),
        invocation_authorization_digest:
          sql<Uint8Array | null>`${invocations.authorizationDigest}`
            .as("invocation_authorization_digest"),
      }).from(executions).leftJoin(invocations,
        eq(invocations.invocationId, executions.invocationId),
      ).where(and(
        eq(executions.agentId, principal.agentId),
        eq(executions.agentRuntimeGeneration, principal.runtimeGeneration),
        eq(executions.agentSignerKeyId, principal.signerKeyId),
        isNotNull(executions.authorizedAt),
        or(isNotNull(invocations.authorizationDigest),
          isNotNull(executions.authorizationDigest)),
      )).orderBy(desc(executions.sequence)).limit(1));
    // Select one deterministic accepted record; this does not claim to audit
    // all historical duplicates. Never skip a selected inconsistent record.
    if (shared.length !== 0) return shared.length === 1
      ? authenticate(shared[0]!, principal, true) : null;
    const single = await executeTypedConversationProductQuery(input.product,
      conversationProductTypedDb.select({
        operationId: turns.operationId,
        sessionId: turns.sessionId,
        roomId: turns.roomId,
        agentId: turns.agentId,
        agentRuntimeGeneration: signers.agentRuntimeGeneration,
        agentSignerKeyId: signers.agentSignerKeyId,
        agentSignerPublicKey: signers.agentSignerPublicKey,
        planBytes: turns.planBytes,
        planDigest: turns.planDigest,
        grantDigest: turns.grantDigest,
        humanRequestDigest: turns.humanRequestDigest,
      }).from(signers).innerJoin(turns,
        eq(turns.operationId, signers.operationId),
      ).where(and(
        eq(signers.agentSignerKeyId, principal.signerKeyId),
        eq(signers.agentRuntimeGeneration, principal.runtimeGeneration),
        eq(turns.agentId, principal.agentId),
        isNotNull(turns.grantDigest),
        isNotNull(turns.humanRequestDigest),
      )).orderBy(desc(signers.createdAt), desc(signers.operationId)).limit(1));
    return single.length === 1
      ? authenticate(single[0]!, principal, false) : null;
  };
}

export function createPostgresForegroundAgentSignerResolver(input: Readonly<{
  product: ConversationProductPostgresHandle;
  crypto: LatticeCrypto;
}>): ResolveLiveShadowAgentObjectSigner {
  const resolveEvidence =
    createPostgresForegroundAgentAcceptedExecutionEvidenceResolver(input);
  return async (principal) => {
    const evidence = await resolveEvidence(principal);
    if (evidence === null) return null;
    try {
      return evidence.signerPublicKey.slice();
    } finally {
      evidence.signerPublicKey.fill(0);
      evidence.planBytes.fill(0);
      evidence.planDigest.fill(0);
    }
  };
}
