import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  decryptObjectThroughNamespace,
  humanAiReadableLiveShadowExecutionInputSetDigest,
  sharedAgentLiveShadowExecutionInputSetDigest,
  type ForegroundSessionLiveShadowMessagePlan,
  type LatticeCrypto,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  admitHumanAiReadableLiveShadowMessageExactReplay,
} from "../../message/human-ai-readable-live-shadow-message-admission.ts";
import {
  admitSharedAgentLiveShadowMessageExactReplay,
} from "../../message/shared-agent-live-shadow-message-admission.ts";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
} from "../../message/message-payload-v2.ts";

const MAXIMUM_INPUTS = 256;

export type SharedAgentProtectedInputOpenResult =
  | Readonly<{
      status: "verified";
      inputCount: number;
      /** Canonical content reconstructed only from the opened protected set. */
      mergedContent: string;
      /** Latest selected Human turn, used for the Agent output causal pair. */
      causalHumanTurnId: string;
    }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "execution_unavailable"
        | "input_set_changed"
        | "sender_authority_unavailable"
        | "protected_object_unavailable"
        | "protected_input_invalid"
        | "protected_input_parity_failed";
    }>;

function one(
  rows: readonly PostgresJsBridgeRow[],
): PostgresJsBridgeRow | null {
  return rows.length === 1 ? rows[0]! : null;
}

function text(row: PostgresJsBridgeRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Shared-Agent input ${field} is invalid`);
  }
  return value;
}

function nullableText(
  row: PostgresJsBridgeRow,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;
  return text(row, field);
}

function number(row: PostgresJsBridgeRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(?:0|[1-9]\d*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Shared-Agent input ${field} is invalid`);
  }
  return value as number;
}

function bytes(row: PostgresJsBridgeRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError(`Shared-Agent input ${field} is invalid`);
  }
  return value.slice();
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function rowBytesEqual(
  row: PostgresJsBridgeRow,
  field: string,
  expected: Uint8Array,
): boolean {
  const value = row[field];
  return value instanceof Uint8Array && equal(value, expected);
}

function unavailable(
  reason: Extract<SharedAgentProtectedInputOpenResult, {
    status: "unavailable";
  }>["reason"],
): SharedAgentProtectedInputOpenResult {
  return Object.freeze({ status: "unavailable" as const, reason });
}

/**
 * Open and byte-compare the exact Conductor-selected Human input set before
 * any model or tool work. The ordinary merged prompt is accepted only when it
 * is the canonical same-sender coalescing of the independently authenticated
 * protected rows.
 */
type ProtectedInputAuthority = Readonly<{
  policyRevision: number;
  sessionId: string;
  roomId: string;
  subjectHumanId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  namespaceHeadDigest: Uint8Array;
  namespacePublicationDigest: Uint8Array;
  namespacePublicationSetDigest: Uint8Array;
  namespaceAudienceFingerprint: Uint8Array;
  recipientAgentId: string | null;
}>;

async function openPostgresProtectedInputSet(input: Readonly<{
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  storage: LatticeStorage;
  crypto: LatticeCrypto;
  selector:
    | Readonly<{
        kind: "execution";
        plan: ForegroundSessionLiveShadowMessagePlan;
      }>
    | Readonly<{
        kind: "invocation";
        invocationId: string;
        operationIds: readonly string[];
        authority: ProtectedInputAuthority;
      }>;
  namespaceKey: Uint8Array;
  expectedMergedContent?: string;
}>): Promise<SharedAgentProtectedInputOpenResult> {
  let execution: PostgresJsBridgeRow | null;
  let rows: readonly PostgresJsBridgeRow[];
  let protectedOnlyRead = false;
  try {
    execution = input.selector.kind === "execution"
      ? one(await input.product.query(
      `/* m296_shared_agent_input_execution */
       SELECT execution_id, invocation_id, state, policy_revision,
              session_id::text,
              room_id::text, agent_id::text, invoking_human_id,
              invoking_device_id, input_count, input_set_digest
         FROM conversation_shared_agent_shadow_executions
        WHERE execution_id = $1 LIMIT 2`,
      [input.selector.plan.operationId],
    ))
      : one(await input.product.query(
        `/* m299_runtime_invocation_input */
         SELECT invocation_id AS execution_id, invocation_id,
                state, policy_revision, session_id::text,
                room_id::text, NULL::text AS agent_id,
                invoking_human_id, invoking_device_id,
                input_count, input_set_digest
           FROM conversation_shared_agent_shadow_invocations
          WHERE invocation_id = $1 LIMIT 2`,
        [input.selector.invocationId],
      ));
    if (execution === null) return unavailable("execution_unavailable");
    const origins = await input.product.query(
      input.selector.kind === "execution" ?
      `/* m318_shared_agent_input_representation_origins */
       SELECT revision.representation_mode,
              revision.publication_policy_revision,
              operation.policy_revision AS origin_policy_revision,
              policy.mode, policy.revision AS current_policy_revision
         FROM conversation_shared_agent_shadow_execution_inputs selected
         JOIN conversation_shared_agent_shadow_operations operation
           ON operation.operation_id = selected.human_operation_id
         JOIN session_message_crypto_revisions revision
           ON revision.shared_agent_shadow_operation_id = selected.human_operation_id
         JOIN encryption_transition_policy policy ON policy.id = 'server'
        WHERE selected.execution_id = $1
          AND revision.edit_revision = 0
        ORDER BY selected.input_ordinal`
      : `/* m318_runtime_invocation_input_representation_origins */
       SELECT revision.representation_mode,
              revision.publication_policy_revision,
              operation.policy_revision AS origin_policy_revision,
              policy.mode, policy.revision AS current_policy_revision
         FROM session_message_crypto_revisions revision
         JOIN conversation_shared_agent_shadow_operations operation
           ON operation.operation_id = revision.shared_agent_shadow_operation_id
         JOIN encryption_transition_policy policy ON policy.id = 'server'
        WHERE revision.shared_agent_shadow_operation_id = ANY($1::text[])
          AND revision.edit_revision = 0
        ORDER BY array_position($1::text[], revision.shared_agent_shadow_operation_id)`,
      [input.selector.kind === "execution"
        ? input.selector.plan.operationId
        : input.selector.operationIds],
    );
    if (origins.length !== number(execution, "input_count")) {
      return unavailable("input_set_changed");
    }
    const currentMode = text(origins[0]!, "mode");
    const currentRevision = number(origins[0]!, "current_policy_revision");
    protectedOnlyRead = currentMode === "encrypted_only";
    if (protectedOnlyRead
      ? input.expectedMergedContent !== undefined
      : input.expectedMergedContent === undefined) {
      return unavailable("protected_input_invalid");
    }
    if (
      (currentMode !== "shadow_encryption" && !protectedOnlyRead)
      || currentRevision !== number(execution, "policy_revision")
      || origins.some((origin) =>
        text(origin, "mode") !== currentMode
        || number(origin, "current_policy_revision") !== currentRevision
        || !["shadow_encryption", "full_encryption"].includes(
          text(origin, "representation_mode"),
        )
        || (text(origin, "representation_mode") === "full_encryption"
          ? number(origin, "publication_policy_revision")
            !== number(origin, "origin_policy_revision")
          : origin["publication_policy_revision"] !== null)
      )
    ) return unavailable("input_set_changed");
    rows = input.selector.kind === "execution"
      ? await input.product.query(
      `/* m296_shared_agent_protected_inputs */
       SELECT selected.input_ordinal, selected.human_operation_id,
              selected.message_id, operation.state AS operation_state,
              operation.conductor_state, operation.policy_revision,
              operation.room_id::text, operation.agent_id::text,
              operation.subject_human_id, operation.committer_device_id,
              operation.committer_device_signing_key_generation,
              operation.host_authorization_revision,
              operation.namespace_id::text,
              operation.namespace_access_revision,
              operation.namespace_key_generation,
              operation.namespace_head_digest,
              operation.namespace_publication_digest,
              operation.namespace_publication_set_digest,
              operation.namespace_audience_fingerprint,
              operation.crypto_object_id, operation.plan_bytes,
              operation.human_request_bytes,
              operation.human_request_digest,
              operation.protected_message_digest,
              ${protectedOnlyRead ? "" : "message.content,"}
              revision.crypto_object_id AS mapped_object_id,
              revision.shared_agent_shadow_operation_id AS mapped_operation_id,
              revision.completion AS crypto_completion,
              revision.disposition AS crypto_disposition,
              revision.parity_status, revision.key_class,
              revision.author_role, revision.object_id_scheme,
              revision.representation_mode,
              revision.publication_policy_revision
         FROM conversation_shared_agent_shadow_execution_inputs selected
         JOIN conversation_shared_agent_shadow_operations operation
           ON operation.operation_id = selected.human_operation_id
         JOIN session_messages message ON message.id = selected.message_id
         JOIN session_message_crypto_revisions revision
           ON revision.message_id = selected.message_id
          AND revision.edit_revision = 0
        WHERE selected.execution_id = $1
        ORDER BY selected.input_ordinal`,
      [input.selector.plan.operationId],
    )
      : await input.product.query(
        `/* m299_runtime_invocation_protected_inputs */
         SELECT array_position($1::text[], operation.operation_id)
                  AS input_ordinal,
                operation.operation_id AS human_operation_id,
                operation.human_message_id AS message_id,
                operation.state AS operation_state,
                operation.conductor_state, operation.policy_revision,
                operation.room_id::text, operation.agent_id::text,
                operation.subject_human_id, operation.committer_device_id,
                operation.committer_device_signing_key_generation,
                operation.host_authorization_revision,
                operation.namespace_id::text,
                operation.namespace_access_revision,
                operation.namespace_key_generation,
                operation.namespace_head_digest,
                operation.namespace_publication_digest,
                operation.namespace_publication_set_digest,
                operation.namespace_audience_fingerprint,
                operation.crypto_object_id, operation.plan_bytes,
                operation.human_request_bytes,
                operation.human_request_digest,
                operation.protected_message_digest,
                ${protectedOnlyRead ? "" : "message.content,"}
                revision.crypto_object_id AS mapped_object_id,
                revision.shared_agent_shadow_operation_id
                  AS mapped_operation_id,
                revision.completion AS crypto_completion,
                revision.disposition AS crypto_disposition,
                revision.parity_status, revision.key_class,
                revision.author_role, revision.object_id_scheme,
                revision.representation_mode,
                revision.publication_policy_revision
           FROM conversation_shared_agent_shadow_operations operation
           JOIN session_messages message
             ON message.id = operation.human_message_id
           JOIN session_message_crypto_revisions revision
             ON revision.message_id = operation.human_message_id
            AND revision.edit_revision = 0
          WHERE operation.operation_id = ANY($1::text[])
          ORDER BY array_position($1::text[], operation.operation_id)`,
        [input.selector.operationIds],
      );
  } catch {
    return unavailable("execution_unavailable");
  }
  const runtimeInvocation = input.selector.kind === "invocation"
    || (execution !== null
      && nullableText(execution, "invocation_id") !== null);
  const authority: ProtectedInputAuthority = input.selector.kind === "execution"
    ? Object.freeze({
        policyRevision: input.selector.plan.policyRevision,
        sessionId: input.selector.plan.sessionId,
        roomId: input.selector.plan.roomId,
        subjectHumanId: input.selector.plan.subjectHumanId,
        committerDeviceId: input.selector.plan.committerDeviceId,
        hostAuthorizationRevision:
          input.selector.plan.hostAuthorizationRevision,
        namespaceId: input.selector.plan.namespaceId,
        namespaceAccessRevision:
          input.selector.plan.namespaceAccessRevision,
        namespaceKeyGeneration:
          input.selector.plan.namespaceKeyGeneration,
        namespaceHeadDigest: input.selector.plan.namespaceHeadDigest,
        namespacePublicationDigest:
          input.selector.plan.namespacePublicationDigest,
        namespacePublicationSetDigest:
          input.selector.plan.namespacePublicationSetDigest,
        namespaceAudienceFingerprint:
          input.selector.plan.namespaceAudienceFingerprint,
        recipientAgentId: input.selector.plan.recipientAgentId,
      })
    : input.selector.authority;
  if (
    execution === null
    || !["authorized", "running"].includes(text(execution, "state"))
    || text(execution, "execution_id") !== (input.selector.kind === "execution"
      ? input.selector.plan.operationId
      : input.selector.invocationId)
    || number(execution, "policy_revision") !== authority.policyRevision
    || text(execution, "session_id") !== authority.sessionId
    || text(execution, "room_id") !== authority.roomId
    || (authority.recipientAgentId === null
      ? nullableText(execution, "agent_id") !== null
      : text(execution, "agent_id") !== authority.recipientAgentId)
    || text(execution, "invoking_human_id") !== authority.subjectHumanId
    || text(execution, "invoking_device_id") !== authority.committerDeviceId
    || rows.length < 1
    || rows.length > MAXIMUM_INPUTS
    || rows.length !== number(execution, "input_count")
  ) return unavailable("execution_unavailable");

  const coordinates = rows.map((row, index) => Object.freeze({
    operationId: text(row, "human_operation_id"),
    messageId: number(row, "message_id"),
    inputOrdinal: number(row, "input_ordinal"),
    expectedOrdinal: index + 1,
  }));
  const inputSetDigest = runtimeInvocation
    ? humanAiReadableLiveShadowExecutionInputSetDigest(
        input.crypto,
        coordinates,
      )
    : sharedAgentLiveShadowExecutionInputSetDigest(
        input.crypto,
        coordinates,
      );
  const storedInputSetDigest = bytes(execution, "input_set_digest");
  try {
    if (
      !equal(inputSetDigest, storedInputSetDigest)
      || coordinates.some((entry) =>
        entry.inputOrdinal !== entry.expectedOrdinal
      )
    ) return unavailable("input_set_changed");
  } finally {
    inputSetDigest.fill(0);
    storedInputSetDigest.fill(0);
  }

  const requestedDevices = rows.map((row) => Object.freeze({
    device_id: text(row, "committer_device_id"),
    device_generation: number(
      row,
      "committer_device_signing_key_generation",
    ),
  }));
  let deviceRows: readonly PostgresJsBridgeRow[];
  try {
    deviceRows = await input.restricted.query(
      `/* m296_shared_agent_input_signers */
       WITH requested AS (
         SELECT device_id, device_generation::int
           FROM jsonb_to_recordset($1::jsonb)
             AS evidence(device_id text, device_generation int)
       )
       SELECT device.device_id, device.device_generation::int,
              device.signing_public_key
         FROM human_crypto_devices device
         JOIN requested ON requested.device_id = device.device_id
          AND requested.device_generation = device.device_generation
        ORDER BY device.device_id, device.device_generation`,
      [JSON.stringify(requestedDevices)],
    );
  } catch {
    return unavailable("sender_authority_unavailable");
  }
  const signerKeys = new Map<string, Uint8Array>();
  for (const row of deviceRows) {
    const key = row["signing_public_key"];
    if (!(key instanceof Uint8Array) || key.length !== 32) continue;
    signerKeys.set(
      `${text(row, "device_id")}\0${number(row, "device_generation")}`,
      key.slice(),
    );
  }

  const openedContents: string[] = [];
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const fullOrigin = text(row, "representation_mode") === "full_encryption";
      const coordinate = coordinates[index]!;
      const deviceId = text(row, "committer_device_id");
      const deviceGeneration = number(
        row,
        "committer_device_signing_key_generation",
      );
      const signerKey = signerKeys.get(`${deviceId}\0${deviceGeneration}`);
      if (signerKey === undefined) {
        return unavailable("sender_authority_unavailable");
      }
      if (
        text(row, "operation_state") !== "published"
        || (input.selector.kind === "invocation"
          ? !["pending", "awaiting_user", "selected"].includes(
              text(row, "conductor_state"),
            )
          : text(row, "conductor_state") !== "selected")
        || text(row, "room_id") !== authority.roomId
        || (runtimeInvocation
          ? nullableText(row, "agent_id") !== null
          : text(row, "agent_id") !== authority.recipientAgentId)
        || text(row, "subject_human_id") !== authority.subjectHumanId
        || deviceId !== authority.committerDeviceId
        || number(row, "host_authorization_revision")
          !== authority.hostAuthorizationRevision
        || text(row, "namespace_id") !== authority.namespaceId
        || number(row, "namespace_access_revision")
          !== authority.namespaceAccessRevision
        || number(row, "namespace_key_generation")
          !== authority.namespaceKeyGeneration
        || !rowBytesEqual(row, "namespace_head_digest",
          authority.namespaceHeadDigest)
        || !rowBytesEqual(row, "namespace_publication_digest",
          authority.namespacePublicationDigest)
        || !rowBytesEqual(row, "namespace_publication_set_digest",
          authority.namespacePublicationSetDigest)
        || !rowBytesEqual(row, "namespace_audience_fingerprint",
          authority.namespaceAudienceFingerprint)
        || text(row, "mapped_object_id") !== text(row, "crypto_object_id")
        || text(row, "mapped_operation_id") !== coordinate.operationId
        || text(row, "crypto_completion") !== "complete"
        || text(row, "crypto_disposition") !== "mapped"
        || (!["shadow_encryption", "full_encryption"].includes(text(row, "representation_mode")))
        || (fullOrigin
          ? number(row, "publication_policy_revision") !== number(row, "policy_revision")
          : row["publication_policy_revision"] !== null)
        || text(row, "parity_status") !== (fullOrigin ? "client_authenticated" : "client_verified")
        || text(row, "key_class") !== "ai"
        || text(row, "author_role") !== "user"
        || text(row, "object_id_scheme") !== "live_shadow_v1"
      ) return unavailable("input_set_changed");

      const objectId = text(row, "crypto_object_id");
      let object: Awaited<ReturnType<LatticeStorage["getObject"]>>;
      let access: Awaited<ReturnType<LatticeStorage["getObjectAccessState"]>>;
      try {
        [object, access] = await Promise.all([
          input.storage.getObject(objectId),
          input.storage.getObjectAccessState(objectId),
        ]);
      } catch {
        return unavailable("protected_object_unavailable");
      }
      if (
        object === null
        || access === null
        || access.namespaceEnvelopes.length !== 1
      ) return unavailable("protected_object_unavailable");

      const planBytes = bytes(row, "plan_bytes");
      const requestBytes = bytes(row, "human_request_bytes");
      const requestDigest = bytes(row, "human_request_digest");
      const manifestBytes = access.head.manifestBytes.slice();
      const envelopeBytes = access.namespaceEnvelopes[0]!.envelopeBytes.slice();
      const encryptedPayloadBytes = object.payloadBytes.slice();
      let encrypted: ReturnType<typeof decodeEncryptedPayloadV2>;
      let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>;
      try {
        encrypted = decodeEncryptedPayloadV2(encryptedPayloadBytes);
        envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      } catch {
        planBytes.fill(0);
        requestBytes.fill(0);
        requestDigest.fill(0);
        manifestBytes.fill(0);
        envelopeBytes.fill(0);
        encryptedPayloadBytes.fill(0);
        object.payloadBytes.fill(0);
        return unavailable("protected_input_invalid");
      }
      let openedPayloadBytes: Uint8Array | null = null;
      try {
        openedPayloadBytes = decryptObjectThroughNamespace(
          input.crypto,
          input.namespaceKey,
          envelope,
          encrypted,
        );
      } catch {
        encrypted.ciphertext.fill(0);
        envelope.wrappedDek.fill(0);
        planBytes.fill(0);
        requestBytes.fill(0);
        requestDigest.fill(0);
        manifestBytes.fill(0);
        envelopeBytes.fill(0);
        encryptedPayloadBytes.fill(0);
        object.payloadBytes.fill(0);
        return unavailable("protected_input_invalid");
      }
      if (openedPayloadBytes === null) return unavailable("protected_input_invalid");
      let openedPayload;
      try {
        openedPayload = decodeMessagePayloadV2(openedPayloadBytes);
      } catch {
        openedPayloadBytes.fill(0);
        encrypted.ciphertext.fill(0);
        envelope.wrappedDek.fill(0);
        planBytes.fill(0);
        requestBytes.fill(0);
        requestDigest.fill(0);
        manifestBytes.fill(0);
        envelopeBytes.fill(0);
        encryptedPayloadBytes.fill(0);
        object.payloadBytes.fill(0);
        return unavailable("protected_input_invalid");
      }
      if (openedPayload.role !== "user") {
        openedPayloadBytes.fill(0);
        return unavailable("protected_input_invalid");
      }
      const useOpenedAsAuthority = protectedOnlyRead || fullOrigin;
      const ordinaryContent = useOpenedAsAuthority ? openedPayload.content : text(row, "content");
      const ordinaryPayloadBytes = useOpenedAsAuthority
        ? null
        : encodeMessagePayloadV2({ role: "user", content: ordinaryContent });
      let admitted: Awaited<ReturnType<
        typeof admitSharedAgentLiveShadowMessageExactReplay
      >> | Awaited<ReturnType<
        typeof admitHumanAiReadableLiveShadowMessageExactReplay
      >> | null = null;
      try {
        const commonAdmission = {
          crypto: input.crypto,
          expectedPlanBytes: planBytes,
          requestBytes,
          expectedRequestDigest: requestDigest,
          ...(ordinaryPayloadBytes === null
            ? { contentRepresentation: "full" as const }
            : { contentRepresentation: "shadow" as const, ordinaryPayloadBytes }),
          encryptedPayloadBytes,
          manifestBytes,
          envelopeBytes,
        };
        admitted = runtimeInvocation
          ? await admitHumanAiReadableLiveShadowMessageExactReplay({
              ...commonAdmission,
              resolveCurrentHumanAuthority: (context) =>
                context.subjectHumanId === authority.subjectHumanId
                    && context.operationId === coordinate.operationId
                    && context.committerDeviceId === deviceId
                    && context.committerDeviceSigningKeyGeneration
                      === deviceGeneration
                    && context.hostAuthorizationRevision
                      === number(row, "host_authorization_revision")
                  ? signerKey.slice()
                  : null,
            })
          : await admitSharedAgentLiveShadowMessageExactReplay({
              ...commonAdmission,
              resolveCurrentHumanAuthority: (context) =>
                context.subjectHumanId === authority.subjectHumanId
                    && context.recipientAgentId
                      === authority.recipientAgentId
                    && context.operationId === coordinate.operationId
                    && context.committerDeviceId === deviceId
                    && context.committerDeviceSigningKeyGeneration
                      === deviceGeneration
                    && context.hostAuthorizationRevision
                      === number(row, "host_authorization_revision")
                  ? signerKey.slice()
                  : null,
            });
        if (
          admitted.plan.namespaceId !== authority.namespaceId
          || admitted.plan.namespaceKeyGeneration
            !== authority.namespaceKeyGeneration
          || admitted.plan.namespaceAccessRevision
            !== authority.namespaceAccessRevision
          || !equal(admitted.plan.namespaceHeadDigest,
            authority.namespaceHeadDigest)
          || !equal(admitted.plan.namespacePublicationDigest,
            authority.namespacePublicationDigest)
          || !equal(admitted.plan.namespacePublicationSetDigest,
            authority.namespacePublicationSetDigest)
          || !equal(admitted.plan.namespaceAudienceFingerprint,
            authority.namespaceAudienceFingerprint)
          || (admitted.contentRepresentation === "shadow"
            && admitted.ordinaryContent !== ordinaryContent)
        ) return unavailable("protected_input_invalid");
        try {
          const openedDigest = input.crypto.hash(openedPayloadBytes);
          const commitmentMatches = equal(openedDigest, admitted.plaintextPayloadDigest);
          openedDigest.fill(0);
          if (!commitmentMatches) return unavailable("protected_input_invalid");
          if (ordinaryPayloadBytes !== null
            && !equal(openedPayloadBytes, ordinaryPayloadBytes)) {
            return unavailable("protected_input_parity_failed");
          }
          const payload = decodeMessagePayloadV2(openedPayloadBytes);
          if (payload.role !== "user" || payload.content !== ordinaryContent) {
            return unavailable("protected_input_parity_failed");
          }
          openedContents.push(payload.content);
        } finally {
          encrypted.ciphertext.fill(0);
          envelope.wrappedDek.fill(0);
        }
      } catch {
        return unavailable("protected_input_invalid");
      } finally {
        if (admitted !== null) {
          admitted.requestDigest.fill(0);
          admitted.plaintextPayloadDigest.fill(0);
          admitted.plan.namespaceHeadDigest.fill(0);
          admitted.plan.namespacePublicationDigest.fill(0);
          admitted.plan.namespacePublicationSetDigest.fill(0);
          admitted.plan.namespaceAudienceFingerprint.fill(0);
        }
        ordinaryPayloadBytes?.fill(0);
        openedPayloadBytes.fill(0);
        planBytes.fill(0);
        requestBytes.fill(0);
        requestDigest.fill(0);
        manifestBytes.fill(0);
        envelopeBytes.fill(0);
        encryptedPayloadBytes.fill(0);
        object.payloadBytes.fill(0);
        access.head.manifestBytes.fill(0);
        access.namespaceEnvelopes.forEach((entry) => {
          entry.envelopeBytes.fill(0);
          entry.envelopeHash.fill(0);
        });
      }
    }
    if (!protectedOnlyRead
      && openedContents.join("\n\n") !== input.expectedMergedContent) {
      return unavailable("protected_input_parity_failed");
    }
    const mergedContent = openedContents.join("\n\n");
    return Object.freeze({
      status: "verified" as const,
      inputCount: openedContents.length,
      mergedContent,
      causalHumanTurnId: coordinates[coordinates.length - 1]!.operationId,
    });
  } finally {
    signerKeys.forEach((value) => value.fill(0));
    signerKeys.clear();
    openedContents.fill("");
  }
}

export function openPostgresSharedAgentProtectedInputSet(input: Readonly<{
  product: PostgresJsBridgeConnection;
  restricted: PostgresJsBridgeConnection;
  storage: LatticeStorage;
  crypto: LatticeCrypto;
  plan: ForegroundSessionLiveShadowMessagePlan;
  namespaceKey: Uint8Array;
  expectedMergedContent?: string;
}>): Promise<SharedAgentProtectedInputOpenResult> {
  return openPostgresProtectedInputSet({
    product: input.product,
    restricted: input.restricted,
    storage: input.storage,
    crypto: input.crypto,
    selector: Object.freeze({ kind: "execution", plan: input.plan }),
    namespaceKey: input.namespaceKey,
    ...(input.expectedMergedContent === undefined ? {} : {
      expectedMergedContent: input.expectedMergedContent,
    }),
  });
}

export function openPostgresRuntimeInvocationProtectedInputSet(
  input: Readonly<{
    product: PostgresJsBridgeConnection;
    restricted: PostgresJsBridgeConnection;
    storage: LatticeStorage;
    crypto: LatticeCrypto;
    invocationId: string;
    operationIds: readonly string[];
    authority: Omit<ProtectedInputAuthority, "recipientAgentId">;
    namespaceKey: Uint8Array;
    expectedMergedContent?: string;
  }>,
): Promise<SharedAgentProtectedInputOpenResult> {
  return openPostgresProtectedInputSet({
    product: input.product,
    restricted: input.restricted,
    storage: input.storage,
    crypto: input.crypto,
    selector: Object.freeze({
      kind: "invocation",
      invocationId: input.invocationId,
      operationIds: Object.freeze([...input.operationIds]),
      authority: Object.freeze({
        ...input.authority,
        recipientAgentId: null,
      }),
    }),
    namespaceKey: input.namespaceKey,
    ...(input.expectedMergedContent === undefined ? {} : {
      expectedMergedContent: input.expectedMergedContent,
    }),
  });
}

export type RuntimeInvocationProtectedHistoryHit = Readonly<{
  messageId: number;
  ts: Date;
  role?: "user" | "assistant" | "tool" | "system";
  authorDisplayName: string;
  handle: string;
  authorActorId: string;
  snippet: string;
  reactions?: { emoji: string; count: number }[];
}>;

const HISTORY_SNIPPET_MAX = 280;

function historySnippet(content: string): string {
  const trimmed = content.trim();
  return trimmed.length > HISTORY_SNIPPET_MAX
    ? `${trimmed.slice(0, HISTORY_SNIPPET_MAX - 1)}…`
    : trimmed;
}

/**
 * Open every plaintext-selected FTS candidate before its text enters the
 * protected Conductor. Selection metadata is retained, but snippets are
 * reconstructed exclusively from the protected payloads.
 */
export async function openPostgresRuntimeInvocationProtectedHistoryHits(
  input: Readonly<{
    product: PostgresJsBridgeConnection;
    storage: LatticeStorage;
    crypto: LatticeCrypto;
    roomId: string;
    namespaceId: string;
    namespaceAccessRevision: number;
    namespaceKeyGeneration: number;
    namespaceKey: Uint8Array;
    candidates: readonly RuntimeInvocationProtectedHistoryHit[];
  }>,
): Promise<readonly RuntimeInvocationProtectedHistoryHit[] | null> {
  if (input.candidates.length === 0) return Object.freeze([]);
  if (
    input.candidates.length > 50
    || new Set(input.candidates.map((entry) => entry.messageId)).size
      !== input.candidates.length
  ) return null;
  let rows: readonly PostgresJsBridgeRow[];
  try {
    rows = await input.product.query(
      `/* m299_runtime_conductor_history_candidates */
       SELECT message.id AS message_id, message.role, message.content,
              session.room_id::text AS room_id,
              room.namespace_id::text AS namespace_id,
              revision.crypto_object_id AS lifecycle_object_id,
              message.crypto_object_id AS mapped_object_id,
              revision.payload_version, revision.key_class,
              revision.completion, revision.disposition,
              revision.parity_status
         FROM session_messages message
         JOIN sessions session ON session.id = message.session_id
         JOIN rooms room ON room.id = session.room_id
         JOIN session_message_crypto_revisions revision
           ON revision.session_id = message.session_id
          AND revision.message_id = message.id
          AND revision.edit_revision = message.edit_revision
        WHERE message.id::text = ANY($1::text[])
          AND session.room_id = $2::uuid`,
      [input.candidates.map((entry) => String(entry.messageId)), input.roomId],
    );
  } catch {
    return null;
  }
  if (rows.length !== input.candidates.length) return null;
  const byId = new Map(rows.map((row) => [number(row, "message_id"), row]));
  const opened: RuntimeInvocationProtectedHistoryHit[] = [];
  for (const candidate of input.candidates) {
    const row = byId.get(candidate.messageId);
    if (row === undefined) return null;
    const role = text(row, "role");
    const parity = text(row, "parity_status");
    if (
      !["user", "assistant", "tool"].includes(role)
      || text(row, "room_id") !== input.roomId
      || text(row, "namespace_id") !== input.namespaceId
      || text(row, "lifecycle_object_id")
        !== text(row, "mapped_object_id")
      || number(row, "payload_version") !== 2
      || text(row, "key_class") !== "ai"
      || text(row, "completion") !== "complete"
      || text(row, "disposition") !== "mapped"
      || (role === "user"
        ? parity !== "client_verified"
        : !["server_verified", "client_verified"].includes(parity))
      || (candidate.role !== undefined && candidate.role !== role)
    ) return null;
    const objectId = text(row, "lifecycle_object_id");
    let object: Awaited<ReturnType<LatticeStorage["getObject"]>>;
    let access: Awaited<ReturnType<LatticeStorage["getObjectAccessState"]>>;
    try {
      [object, access] = await Promise.all([
        input.storage.getObject(objectId),
        input.storage.getObjectAccessState(objectId),
      ]);
    } catch {
      return null;
    }
    if (
      object === null
      || access === null
      || object.objectId !== objectId
      || access.head.objectId !== objectId
    ) return null;
    const envelopes = access.namespaceEnvelopes.filter((entry) =>
      entry.namespaceId === input.namespaceId
    );
    if (envelopes.length !== 1) return null;
    const encrypted = decodeEncryptedPayloadV2(object.payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(
      envelopes[0]!.envelopeBytes,
    );
    let plaintext: Uint8Array | null = null;
    try {
      if (
        envelope.context.namespaceId !== input.namespaceId
        || envelope.context.keyGeneration !== input.namespaceKeyGeneration
        || envelope.context.bindingRevisionAtWrap
          !== input.namespaceAccessRevision
      ) return null;
      plaintext = decryptObjectThroughNamespace(
        input.crypto,
        input.namespaceKey,
        envelope,
        encrypted,
      );
      if (plaintext === null) return null;
      const payload = decodeMessagePayloadV2(plaintext);
      if (
        payload.role !== role
        || payload.content !== text(row, "content")
      ) return null;
      opened.push(Object.freeze({
        ...candidate,
        snippet: historySnippet(payload.content),
      }));
    } catch {
      return null;
    } finally {
      plaintext?.fill(0);
      encrypted.ciphertext.fill(0);
      envelope.wrappedDek.fill(0);
      object.payloadBytes.fill(0);
      access.head.manifestBytes.fill(0);
      access.namespaceEnvelopes.forEach((entry) => {
        entry.envelopeBytes.fill(0);
        entry.envelopeHash.fill(0);
      });
    }
  }
  return Object.freeze(opened);
}
