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
  rooms,
  sql,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  agentRuntimeObjectSignerKeyIdV1,
  destroyDomainForegroundAuthorizationPlanV2,
  decodeLiveShadowMessagePlanV4,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";

import type {
  ResolveLiveShadowAgentObjectSigner,
  ResolveTaskDefinitionForegroundAuthorization,
} from
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
  /** Authenticated retained grant facts. Absent evidence cannot authorize a
   * definition written by an Agent other than the Task executor. */
  acceptedAuthority?: Readonly<{
    subjectHumanId: string;
    authorizedNamespaces: readonly Readonly<{
      namespaceId: string;
      domainId: string;
    }>[];
    grantLifetime?: Readonly<{
      issuedAt: number;
      deadlineAt: number;
    }>;
  }>;
}>;

export type ResolveForegroundAgentAcceptedExecutionEvidence = (
  principal: Parameters<ResolveLiveShadowAgentObjectSigner>[0],
  selection?: Readonly<{ parentOperationHash: Uint8Array }>,
) => Promise<ForegroundAgentAcceptedExecutionEvidence | null>;

type DefinitionAuthorPrincipal = Parameters<
  ResolveForegroundAgentAcceptedExecutionEvidence
>[0];

function principalKey(principal: DefinitionAuthorPrincipal): string {
  return `${principal.agentId}\0${principal.runtimeGeneration}\0${principal.signerKeyId}`;
}

/** Capture only the exact accepted foreground principal whose retained grant
 * covered the Task definition's Human and Domain. */
export function captureForegroundTaskDefinitionAuthor(input: Readonly<{
  resolveEvidence?: ResolveForegroundAgentAcceptedExecutionEvidence | undefined;
  resolveTaskDefinitionForegroundAuthorization?:
    ResolveTaskDefinitionForegroundAuthorization | undefined;
  subjectHumanId: string;
  namespaceId: string;
  domainId: string | null;
}>) {
  const accepted = new Set<string>();
  return Object.freeze({
    resolveEvidence: async (principal: DefinitionAuthorPrincipal) => {
      const evidence = await input.resolveEvidence?.(principal) ?? null;
      const authority = evidence?.acceptedAuthority;
      if (authority !== undefined && input.domainId !== null
        && authority.subjectHumanId === input.subjectHumanId
        && authority.authorizedNamespaces.some(namespace =>
          namespace.namespaceId === input.namespaceId
          && namespace.domainId === input.domainId)) {
        accepted.add(principalKey(principal));
      }
      return evidence;
    },
    resolveTaskDefinitionForegroundAuthorization: async (
      evidence: Parameters<ResolveTaskDefinitionForegroundAuthorization>[0],
    ) => {
      const signerPublicKey = await input
        .resolveTaskDefinitionForegroundAuthorization?.(evidence) ?? null;
      if (signerPublicKey !== null) {
        accepted.add(principalKey(evidence.principal));
      }
      return signerPublicKey;
    },
    authorizes: (principal: DefinitionAuthorPrincipal) =>
      accepted.has(principalKey(principal)),
  });
}

export function createPostgresForegroundAgentAcceptedExecutionEvidenceResolver(input: Readonly<{
  product: ConversationProductPostgresHandle;
  crypto: LatticeCrypto;
  /** A selected malformed receipt must not fall back to another signer family. */
  rejectInvalidSelectedEvidence?: boolean;
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
      let acceptedAuthority: ForegroundAgentAcceptedExecutionEvidence[
        "acceptedAuthority"
      ];
      const authorizationPlanBytes = invocationBacked
        ? row["invocation_authorization_plan_bytes"]
        : shared
          ? row["execution_authorization_plan_bytes"]
          : row["agent_grant_plan_bytes"];
      const authorizationPlanDigest = invocationBacked
        ? row["invocation_authorization_plan_digest"]
        : shared
          ? row["execution_authorization_plan_digest"]
          : row["agent_grant_plan_digest"];
      const recipientKeyId = invocationBacked
        ? row["invocation_recipient_key_id"]
        : shared
          ? row["execution_recipient_key_id"]
          : row["recipient_key_id"];
      const authorizationDisposition = invocationBacked
        ? row["invocation_authorization_disposition"]
        : shared ? row["execution_authorization_disposition"] : null;
      const authorizationSessionReference = invocationBacked
        ? row["invocation_authorization_session_reference"]
        : shared ? row["execution_authorization_session_reference"] : null;
      const authorityRoomId = shared
        ? row["source_room_parent_id"] ?? row["source_room_id"]
        : plan.roomId;
      if (authorizationPlanBytes instanceof Uint8Array
        && authorizationPlanDigest instanceof Uint8Array
        && authorizationPlanDigest.length === 32
        && typeof recipientKeyId === "string") {
        let authorization: ReturnType<
          typeof parseDomainForegroundAuthorizationPlanV2
        > = null;
        try {
          authorization = parseDomainForegroundAuthorizationPlanV2(
            authorizationPlanBytes,
          );
        } catch {
          // The retained execution remains valid signer evidence. A malformed
          // retained grant simply cannot authorize a cross-Agent definition.
        }
        const actual = input.crypto.hash(authorizationPlanBytes);
        try {
          const sharedRecipient = authorization?.recipientKind === "runtime"
            && authorization.recipientPrincipalId === "nautilo_foreground_runtime"
            && authorization.recipientAuthorizationRevision === 0
            && authorization.recipientRuntimeGeneration === 0;
          const agentRecipient = authorization?.recipientKind === "agent"
            && authorization.recipientPrincipalId === principal.agentId
            && authorization.recipientAuthorizationRevision
              === plan.agentAuthorizationRevision
            && authorization.recipientRuntimeGeneration
              === principal.runtimeGeneration;
          const requiredPlanMatches =
            plan.authorization.disposition === "authorization_required"
            && authorization !== null
            && authorization.authorizationId
              === plan.authorization.authorizationId
            && equal(authorizationPlanBytes,
              plan.authorization.authorizationPlanBytes)
            && equal(authorizationPlanDigest,
              plan.authorization.authorizationPlanDigest);
          const invocationEstablishmentMatches = invocationBacked
            && plan.authorization.disposition === "authorization_reusable"
            && authorization !== null
            && plan.authorization.sessionReference
              === `pending:${authorization.authorizationId}`
            && equal(plan.authorization.authorizationDigest,
              authorizationPlanDigest);
          const acceptedSessionMatches =
            plan.authorization.disposition === "authorization_reusable"
            && authorizationSessionReference
              === plan.authorization.sessionReference
            && equal(acceptedDigest,
              plan.authorization.authorizationDigest);
          const dispositionMatches = !shared
            ? plan.authorization.disposition === "authorization_reusable"
              || requiredPlanMatches
            : authorizationDisposition === "establish"
              ? requiredPlanMatches || invocationEstablishmentMatches
                || invocationBacked && acceptedSessionMatches
              : authorizationDisposition === "reuse"
                && acceptedSessionMatches;
          if (authorization !== null
            && equal(actual, authorizationPlanDigest)
            && authorization.subjectHumanId === plan.subjectHumanId
            && authorization.committerDeviceId === plan.committerDeviceId
            && authorization.committerDeviceSigningGeneration
              === plan.committerDeviceSigningKeyGeneration
            && authorization.hostAuthorizationRevision
              === plan.hostAuthorizationRevision
            && authorization.sessionId === (shared
              ? row["client_action_session_id"]
              : plan.sessionId)
            && authorization.roomId === authorityRoomId
            && authorization.policyRevision === plan.policyRevision
            && authorization.recipientKeyId === recipientKeyId
            && (shared ? sharedRecipient : agentRecipient)
            && authorization.operations.includes("encrypt")
            && dispositionMatches) {
            acceptedAuthority = Object.freeze({
              subjectHumanId: authorization.subjectHumanId,
              authorizedNamespaces: Object.freeze(
                authorization.domains.map(domain => Object.freeze({
                  namespaceId: domain.sourceNamespaceId,
                  domainId: domain.domainId,
                })),
              ),
              grantLifetime: Object.freeze({
                issuedAt: authorization.issuedAt,
                deadlineAt: authorization.deadlineAt,
              }),
            });
          }
        } finally {
          actual.fill(0);
          if (authorization !== null) {
            destroyDomainForegroundAuthorizationPlanV2(authorization);
          }
        }
      }
      return Object.freeze({
        // postgres-js bytea values can be Buffers: Buffer.slice() aliases the
        // row, so later evidence cleanup would also erase the returned signer.
        signerPublicKey: Uint8Array.from(publicKey),
        planBytes: Uint8Array.from(planBytes),
        planDigest: Uint8Array.from(planDigest),
        ...(acceptedAuthority === undefined ? {} : { acceptedAuthority }),
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
  return async (principal, selection) => {
    const parentOperationHash = selection === undefined ? undefined
      : Uint8Array.from(selection.parentOperationHash);
    if (parentOperationHash !== undefined && parentOperationHash.length !== 32) {
      parentOperationHash.fill(0);
      throw new TypeError("Foreground parent operation hash is invalid");
    }
    try {
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
        invocation_authorization_plan_bytes:
          sql<Uint8Array | null>`${invocations.authorizationPlanBytes}`
            .as("invocation_authorization_plan_bytes"),
        invocation_authorization_plan_digest:
          sql<Uint8Array | null>`${invocations.authorizationPlanDigest}`
            .as("invocation_authorization_plan_digest"),
        invocation_recipient_key_id:
          sql<string | null>`${invocations.recipientKeyId}`
            .as("invocation_recipient_key_id"),
        invocation_authorization_disposition:
          sql<string | null>`${invocations.authorizationDisposition}`
            .as("invocation_authorization_disposition"),
        invocation_authorization_session_reference:
          sql<string | null>`${invocations.authorizationSessionReference}`
            .as("invocation_authorization_session_reference"),
        execution_authorization_plan_bytes:
          sql<Uint8Array | null>`${executions.authorizationPlanBytes}`
            .as("execution_authorization_plan_bytes"),
        execution_authorization_plan_digest:
          sql<Uint8Array | null>`${executions.authorizationPlanDigest}`
            .as("execution_authorization_plan_digest"),
        execution_recipient_key_id:
          sql<string | null>`${executions.recipientKeyId}`
            .as("execution_recipient_key_id"),
        execution_authorization_disposition:
          sql<string | null>`${executions.authorizationDisposition}`
            .as("execution_authorization_disposition"),
        execution_authorization_session_reference:
          sql<string | null>`${executions.authorizationSessionReference}`
            .as("execution_authorization_session_reference"),
        source_room_id: sql<string | null>`${rooms.id}`
          .as("source_room_id"),
        source_room_parent_id: sql<string | null>`${rooms.parentRoomId}`
          .as("source_room_parent_id"),
      }).from(executions).leftJoin(invocations,
        eq(invocations.invocationId, executions.invocationId),
      ).leftJoin(rooms, eq(rooms.id, executions.roomId)).where(and(
        eq(executions.agentId, principal.agentId),
        eq(executions.agentRuntimeGeneration, principal.runtimeGeneration),
        eq(executions.agentSignerKeyId, principal.signerKeyId),
        ...(parentOperationHash === undefined ? [] : [eq(
          sql<Uint8Array>`sha256(convert_to(${
            "nautilo/task-definition-parent-operation/v1\n"
          } || ${executions.executionId}::text, 'UTF8'))`,
          parentOperationHash,
        )]),
        isNotNull(executions.authorizedAt),
        or(isNotNull(invocations.authorizationDigest),
          isNotNull(executions.authorizationDigest)),
      )).orderBy(desc(executions.sequence)).limit(1));
    // Select one deterministic accepted record; this does not claim to audit
    // all historical duplicates. Never skip a selected inconsistent record.
    if (shared.length !== 0) {
      const evidence = shared.length === 1 ? authenticate(shared[0]!, principal, true) : null;
      if (evidence === null && input.rejectInvalidSelectedEvidence === true) {
        throw new TypeError("Selected foreground Agent execution evidence is invalid");
      }
      return evidence;
    }
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
        authorizationPlanBytes: turns.agentGrantPlanBytes,
        authorizationPlanDigest: turns.agentGrantPlanDigest,
        recipientKeyId: turns.recipientKeyId,
      }).from(signers).innerJoin(turns,
        eq(turns.operationId, signers.operationId),
      ).where(and(
        eq(signers.agentSignerKeyId, principal.signerKeyId),
        eq(signers.agentRuntimeGeneration, principal.runtimeGeneration),
        eq(turns.agentId, principal.agentId),
        ...(parentOperationHash === undefined ? [] : [eq(
          sql<Uint8Array>`sha256(convert_to(${
            "nautilo/task-definition-parent-operation/v1\n"
          } || ${turns.operationId}::text, 'UTF8'))`,
          parentOperationHash,
        )]),
        isNotNull(turns.grantDigest),
        isNotNull(turns.humanRequestDigest),
      )).orderBy(desc(signers.createdAt), desc(signers.operationId)).limit(1));
    const evidence = single.length === 1 ? authenticate(single[0]!, principal, false) : null;
    if (single.length !== 0 && evidence === null && input.rejectInvalidSelectedEvidence === true) {
      throw new TypeError("Selected foreground Agent execution evidence is invalid");
    }
    return evidence;
    } finally {
      parentOperationHash?.fill(0);
    }
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

/** Adapt retained accepted execution evidence without lending any signing key custody. */
export function foregroundAgentAcceptedExecutionSigner(input: Readonly<{
  crypto: LatticeCrypto;
  resolveEvidence?: ResolveForegroundAgentAcceptedExecutionEvidence | undefined;
}>): ResolveLiveShadowAgentObjectSigner {
  return async principal => {
    const evidence = await input.resolveEvidence?.(principal) ?? null;
    if (evidence === null) return null;
    try {
      const plan = decodeLiveShadowMessagePlanV4(evidence.planBytes);
      if (!equal(input.crypto.hash(evidence.planBytes), evidence.planDigest)
        || plan.recipientAgentId !== principal.agentId
        || plan.agentRuntimeGeneration !== principal.runtimeGeneration
        || plan.agentSignerKeyId !== principal.signerKeyId
        || !equal(plan.agentSignerPublicKey, evidence.signerPublicKey)
        || agentRuntimeObjectSignerKeyIdV1(input.crypto, evidence.signerPublicKey) !== principal.signerKeyId) {
        throw new TypeError("Foreground Agent execution signer evidence was substituted");
      }
      return Uint8Array.from(evidence.signerPublicKey);
    } finally {
      evidence.signerPublicKey.fill(0);
      evidence.planBytes.fill(0);
      evidence.planDigest.fill(0);
    }
  };
}
