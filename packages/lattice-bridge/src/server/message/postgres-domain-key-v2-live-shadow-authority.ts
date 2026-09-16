import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  type DomainForegroundAuthorizationCurrentAuthority,
  type DomainForegroundAuthorityEntry,
  type DomainForegroundSecretEntry,
  type DeviceWrappedDomainAgentGrantSecretEntry,
  type ForegroundSessionLiveShadowMessagePlan,
  type LatticeCrypto,
  type ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization,
  type ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization,
  type ResolveCurrentDomainCompressedHumanLiveShadowMessageAuthority,
  type ResolveCurrentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  encodeLiveShadowMessagePlanV4,
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";

import {
  PostgresDomainKeyAuthorityRepository,
  type DomainForegroundNamespaceAuthorityInspectionV2,
} from "../delivery/postgres-domain-key-authority.ts";
import {
  PostgresNamespaceProductAuthority,
} from "../delivery/postgres-namespace-product-authority.ts";
import type { ResolveLiveShadowReadableNamespaces } from
  "./postgres-live-shadow-turn-plan.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from
  "../../message/conversation-repository.ts";

type RoomAuthority = Omit<
  DomainForegroundNamespaceAuthorityInspectionV2,
  "status"
>;

type Current = Readonly<{
  causalHumanUserId: string;
  signingPublicKey: Uint8Array;
  readableNamespaceIds: readonly string[];
  domains: readonly DomainForegroundAuthorityEntry[];
  room: RoomAuthority;
  authorization: ReturnType<typeof parseDomainForegroundAuthorizationPlanV2>
    & object;
  authorizationDigest: Uint8Array;
  /** Digest of the admitted signed/sealed grant, not its public plan. */
  acceptedGrantDigest: Uint8Array | null;
}>;

export interface DomainKeyV2LiveShadowCurrentAuthority {
  readonly causalHumanUserId: string;
  readonly resolveCurrentHumanAuthority:
    ResolveCurrentDomainCompressedHumanLiveShadowMessageAuthority;
  readonly resolveCurrentForegroundAuthorization: () => Promise<
    | (Omit<
        DomainForegroundAuthorizationCurrentAuthority,
        "recipientEncryptionPrivateKey"
      > & Readonly<{
        issuedAt: number;
        deadlineAt: number;
        readableNamespaceIds: readonly string[];
      }>)
    | null
  >;
  readonly withCurrentRoomNamespaceKey: <Value>(input: Readonly<{
    domains: readonly DomainForegroundSecretEntry[]
      | readonly DeviceWrappedDomainAgentGrantSecretEntry[];
    use(key: Uint8Array): Promise<Value> | Value;
  }>) => Promise<Value | null>;
  readonly verifyCurrentPlan: () => Promise<boolean>;
  readonly resolveCurrentHumanObjectWrite:
    ResolveCurrentObjectAccessGenesisAuthorization;
  readonly resolveCurrentAgentObjectWrite:
    ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization;
  readonly resolveCurrentForegroundEntityObjectWrite:
    ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
  signingPublicKey(): Uint8Array | null;
  destroy(): void;
}

function one(rows: readonly PostgresJsBridgeRow[]): PostgresJsBridgeRow | null {
  return rows.length === 1 ? rows[0]! : null;
}

function text(row: PostgresJsBridgeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`V2 Domain live Shadow ${key} is invalid`);
  }
  return value;
}

function number(row: PostgresJsBridgeRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`V2 Domain live Shadow ${key} is invalid`);
  }
  return value as number;
}

function bytes(row: PostgresJsBridgeRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`V2 Domain live Shadow ${key} is invalid`);
  }
  return new Uint8Array(value);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalNamespaces(values: readonly string[]): readonly string[] {
  const canonical = [...new Set(values)].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  if (canonical.length < 1 || canonical.length !== values.length) {
    throw new TypeError("V2 foreground readable Namespace set is invalid");
  }
  return Object.freeze(canonical);
}

function sameDomain(
  left: DomainForegroundAuthorityEntry,
  right: DomainForegroundAuthorityEntry,
): boolean {
  return left.domainId === right.domainId
    && left.sourceNamespaceId === right.sourceNamespaceId
    && left.participantCount === right.participantCount
    && left.keyClass === right.keyClass
    && left.domainKeyGeneration === right.domainKeyGeneration
    && left.authorizationRevision === right.authorizationRevision
    && left.activeNamespaceBindingCount === right.activeNamespaceBindingCount
    && equal(left.participantDigest, right.participantDigest)
    && equal(left.headDigest, right.headDigest)
    && equal(
      left.activeNamespaceBindingSetDigest,
      right.activeNamespaceBindingSetDigest,
    );
}

function copyDomain(
  value: DomainForegroundAuthorityEntry,
): DomainForegroundAuthorityEntry {
  return Object.freeze({
    ...value,
    participantDigest: value.participantDigest.slice(),
    headDigest: value.headDigest.slice(),
    activeNamespaceBindingSetDigest:
      value.activeNamespaceBindingSetDigest.slice(),
  });
}

function destroyDomains(values: readonly DomainForegroundAuthorityEntry[]) {
  values.forEach((value) => {
    value.participantDigest.fill(0);
    value.headDigest.fill(0);
    value.activeNamespaceBindingSetDigest.fill(0);
  });
}

function destroyRoom(value: RoomAuthority): void {
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
  value.domainHeadDigest.fill(0);
  value.bundleDigest.fill(0);
}

function copyRoom(value: RoomAuthority): RoomAuthority {
  return Object.freeze({
    ...value,
    namespaceHeadDigest: value.namespaceHeadDigest.slice(),
    namespacePublicationDigest: value.namespacePublicationDigest.slice(),
    namespacePublicationSetDigest:
      value.namespacePublicationSetDigest.slice(),
    namespaceAudienceFingerprint:
      value.namespaceAudienceFingerprint.slice(),
    domainHeadDigest: value.domainHeadDigest.slice(),
    bundleDigest: value.bundleDigest.slice(),
  });
}

export async function createPostgresDomainKeyV2LiveShadowCurrentAuthority(
  input: Readonly<{
    product: PostgresJsBridgeConnection;
    restricted: PostgresJsBridgeConnection;
    crypto: LatticeCrypto;
    serverId: string;
    plan: ForegroundSessionLiveShadowMessagePlan;
    representationMode: "shadow_encryption" | "full_encryption";
    resolveReadableNamespaces: ResolveLiveShadowReadableNamespaces;
    source?: "turn" | "shared_execution" | "shared_resume";
    onDiagnostic?: (stage: string) => void;
    now?: () => number;
  }>,
): Promise<DomainKeyV2LiveShadowCurrentAuthority | null> {
  const productAuthority = new PostgresNamespaceProductAuthority(
    input.product,
  );
  const repository = new PostgresDomainKeyAuthorityRepository(
    input.restricted,
    input.crypto,
    input.serverId,
  );
  const sharedExecution = input.source === "shared_execution"
    || input.source === "shared_resume";
  const now = input.now ?? Date.now;
  const reject = (stage: string): null => {
    input.onDiagnostic?.(stage);
    return null;
  };
  const load = async (): Promise<Current | null> => {
    const row = one(await input.product.query(
      sharedExecution
        ? `/* m301_v2_shared_agent_current_product_authority */
       SELECT policy.mode, policy.revision AS policy_revision, execution.state,
              execution.session_id, execution.room_id,
              execution.client_action_session_id,
              latest.message_id AS human_message_id,
              execution.invoking_human_id AS subject_human_id,
              actor.owner_id::text AS subject_user_id,
              execution.authorization_device_id AS committer_device_id,
              operation.committer_device_signing_key_generation,
              operation.host_authorization_revision,
              execution.agent_id, 0::bigint AS agent_authorization_revision,
              operation.namespace_id, operation.namespace_access_revision,
              operation.namespace_key_generation,
              operation.namespace_head_digest,
              operation.namespace_publication_digest,
              operation.namespace_publication_set_digest,
              operation.namespace_audience_fingerprint,
              COALESCE(invocation.authorization_plan_bytes,
                execution.authorization_plan_bytes) AS agent_grant_plan_bytes,
              COALESCE(invocation.authorization_plan_digest,
                execution.authorization_plan_digest) AS agent_grant_plan_digest,
              COALESCE(invocation.authorization_digest,
                execution.authorization_digest) AS accepted_grant_digest,
              COALESCE(invocation.recipient_key_id,
                execution.recipient_key_id) AS recipient_key_id,
              execution.agent_runtime_generation,
              execution.agent_signer_key_id,
              execution.agent_signer_public_key,
              execution.plan_bytes, execution.plan_digest,
              authority_room.id::text AS top_level_room_id,
              EXISTS (
                SELECT 1 FROM room_members member
                JOIN actors agent_actor ON agent_actor.id = member.actor_id
                WHERE member.room_id = authority_room.id
                  AND agent_actor.kind = 'agent'
                  AND agent_actor.agent_id = execution.agent_id
              ) AS agent_current
         FROM conversation_shared_agent_shadow_executions execution
         JOIN LATERAL (
           SELECT input.message_id, input.human_operation_id
             FROM conversation_shared_agent_shadow_execution_inputs input
            WHERE input.execution_id = execution.execution_id
            ORDER BY input.input_ordinal DESC LIMIT 1
         ) latest ON true
         JOIN conversation_shared_agent_shadow_operations operation
           ON operation.operation_id = latest.human_operation_id
         LEFT JOIN conversation_shared_agent_shadow_invocations invocation
           ON invocation.invocation_id = execution.invocation_id
         JOIN rooms room ON room.id = execution.room_id
         JOIN rooms authority_room
           ON authority_room.id = COALESCE(room.parent_room_id, room.id)
          AND authority_room.namespace_id = room.namespace_id
         JOIN actors actor ON actor.id::text = execution.invoking_human_id
          AND actor.kind = 'user'
         JOIN encryption_transition_policy policy ON policy.id = 'server'
        WHERE execution.execution_id = $1
          AND execution.plan_bytes IS NOT NULL
        LIMIT 2`
        : `/* m301_v2_live_shadow_current_product_authority */
       SELECT policy.mode, policy.revision AS policy_revision, turn.state,
              turn.session_id, turn.room_id, turn.human_message_id,
              turn.subject_human_id, actor.owner_id::text AS subject_user_id,
              turn.committer_device_id,
              turn.committer_device_signing_key_generation,
              turn.host_authorization_revision, turn.agent_id,
              turn.agent_authorization_revision, turn.namespace_id,
              turn.namespace_access_revision, turn.namespace_key_generation,
              turn.namespace_head_digest, turn.namespace_publication_digest,
              turn.namespace_publication_set_digest,
              turn.namespace_audience_fingerprint, turn.grant_domain_id,
              turn.grant_domain_participant_digest,
              turn.grant_domain_key_generation,
              turn.grant_domain_head_digest,
              turn.grant_domain_publication_digest,
              turn.grant_domain_authorization_revision,
              turn.namespace_bundle_revision, turn.namespace_bundle_digest,
              turn.agent_grant_plan_bytes, turn.agent_grant_plan_digest,
              turn.grant_digest AS accepted_grant_digest,
              turn.recipient_key_id,
              signer.agent_runtime_generation, signer.agent_signer_key_id,
              signer.agent_signer_public_key,
              EXISTS (
                SELECT 1 FROM room_members member
                JOIN actors agent_actor ON agent_actor.id = member.actor_id
                WHERE member.room_id = turn.room_id
                  AND agent_actor.kind = 'agent'
                  AND agent_actor.agent_id = turn.agent_id
              ) AS agent_current
         FROM conversation_shadow_turn_operations turn
         JOIN conversation_shadow_turn_agent_signers signer
           ON signer.operation_id = turn.operation_id
         JOIN actors actor ON actor.id::text = turn.subject_human_id
          AND actor.kind = 'user'
         JOIN encryption_transition_policy policy ON policy.id = 'server'
        WHERE turn.operation_id = $1
          AND turn.namespace_authority_scheme = 'domain_key_v2'
        LIMIT 2`,
      [input.plan.operationId],
    ));
    if (row === null) return reject("product_authority_absent");
    const exact = [
      ["namespace_head_digest", input.plan.namespaceHeadDigest],
      ["namespace_publication_digest", input.plan.namespacePublicationDigest],
      [
        "namespace_publication_set_digest",
        input.plan.namespacePublicationSetDigest,
      ],
      ["namespace_audience_fingerprint", input.plan.namespaceAudienceFingerprint],
      ["agent_signer_public_key", input.plan.agentSignerPublicKey],
      ...(!sharedExecution
        ? [
            ["grant_domain_participant_digest",
              input.plan.grantDomainParticipantDigest],
            ["grant_domain_head_digest", input.plan.grantDomainHeadDigest],
            ["grant_domain_publication_digest",
              input.plan.grantDomainPublicationDigest],
            ["namespace_bundle_digest", input.plan.namespaceBundleDigest],
          ] as const
        : []),
    ] as const;
    const copies = exact.map(([key]) => bytes(row, key));
    let storedPlanBytes: Uint8Array | null = null;
    let storedPlanDigest: Uint8Array | null = null;
    try {
      if (sharedExecution) {
        storedPlanBytes = bytes(row, "plan_bytes");
        storedPlanDigest = bytes(row, "plan_digest");
        const canonical = encodeLiveShadowMessagePlanV4(input.plan);
        const digest = input.crypto.hash(canonical);
        try {
          if (
            !equal(storedPlanBytes, canonical)
            || !equal(storedPlanDigest, digest)
          ) return reject("shared_plan_stale");
        } finally {
          canonical.fill(0);
          digest.fill(0);
        }
      }
      const expectedPolicyMode = input.representationMode === "full_encryption"
        ? "encrypted_only"
        : "shadow_encryption";
      if (
        text(row, "mode") !== expectedPolicyMode
        || number(row, "policy_revision") !== input.plan.policyRevision
        || !(sharedExecution
          ? ["awaiting_authorization", "authorized", "running"].includes(
              text(row, "state"),
            )
          : ["planned", "human_verified", "running"].includes(
              text(row, "state"),
            ))
        || text(row, "session_id") !== input.plan.sessionId
        || text(row, "room_id") !== input.plan.roomId
        || number(row, "human_message_id") !== input.plan.humanMessageId
        || text(row, "subject_human_id") !== input.plan.subjectHumanId
        || text(row, "committer_device_id") !== input.plan.committerDeviceId
        || number(row, "committer_device_signing_key_generation")
          !== input.plan.committerDeviceSigningKeyGeneration
        || number(row, "host_authorization_revision")
          !== input.plan.hostAuthorizationRevision
        || text(row, "agent_id") !== input.plan.recipientAgentId
        || number(row, "agent_authorization_revision")
          !== input.plan.agentAuthorizationRevision
        || text(row, "namespace_id") !== input.plan.namespaceId
        || number(row, "namespace_access_revision")
          !== input.plan.namespaceAccessRevision
        || number(row, "namespace_key_generation")
          !== input.plan.namespaceKeyGeneration
        || (!sharedExecution && (
          text(row, "grant_domain_id") !== input.plan.grantDomainId
          || number(row, "grant_domain_key_generation")
            !== input.plan.grantDomainKeyGeneration
          || number(row, "grant_domain_authorization_revision")
            !== input.plan.grantDomainAuthorizationRevision
          || number(row, "namespace_bundle_revision")
            !== input.plan.namespaceBundleRevision
        ))
        || text(row, "recipient_key_id")
          !== (input.plan.authorization.disposition === "authorization_required"
            ? input.plan.authorization.recipientKeyId
            : text(row, "recipient_key_id"))
        || number(row, "agent_runtime_generation")
          !== input.plan.agentRuntimeGeneration
        || text(row, "agent_signer_key_id") !== input.plan.agentSignerKeyId
        || copies.some((copy, index) => !equal(copy, exact[index]![1]))
        || row["agent_current"] !== true
      ) return reject("product_authority_stale");
    } finally {
      copies.forEach((value) => value.fill(0));
      storedPlanBytes?.fill(0);
      storedPlanDigest?.fill(0);
    }
    const device = one(await input.restricted.query(
      `/* m301_v2_live_shadow_current_device */
       SELECT device.user_id, device.human_id, device.device_id,
              device.device_generation, device.revision,
              device.signing_public_key, device.state,
              custody.state AS custody_state
         FROM human_crypto_devices device
         JOIN human_crypto_custodies custody
           ON custody.human_id = device.human_id
        WHERE device.device_id = $1 LIMIT 2`,
      [input.plan.committerDeviceId],
    ));
    if (
      device === null
      || text(device, "user_id") !== text(row, "subject_user_id")
      || text(device, "human_id") !== input.plan.subjectHumanId
      || number(device, "device_generation")
        !== input.plan.committerDeviceSigningKeyGeneration
      || number(device, "revision") !== input.plan.hostAuthorizationRevision
      || device["state"] !== "active"
      || device["custody_state"] !== "active"
    ) return reject("device_authority_stale");
    const authorityRoomId = sharedExecution
      ? text(row, "top_level_room_id")
      : input.plan.roomId;
    let readable: readonly string[];
    try {
      readable = canonicalNamespaces(await input.resolveReadableNamespaces({
        humanActorId: input.plan.subjectHumanId,
        roomId: authorityRoomId,
        agentId: input.plan.recipientAgentId,
      }));
    } catch {
      return reject("readable_namespace_resolution_failed");
    }
    if (!readable.includes(input.plan.namespaceId)) {
      return reject("room_namespace_unreadable");
    }
    const inspected = await productAuthority.withCurrentReadableNamespaceSet({
      subjectUserId: text(row, "subject_user_id"),
      subjectHumanId: input.plan.subjectHumanId,
      sourceRoomId: authorityRoomId,
      namespaceIds: readable,
      use: async (entries) => {
        if (!entries.some((entry) => entry.namespaceId === input.plan.namespaceId)) {
          return null;
        }
        const [domains, room] = await Promise.all([
          repository.inspectForegroundAuthority({
            namespaceIds: readable,
            keyClass: "ai",
            subjectHumanId: input.plan.subjectHumanId,
            deviceId: input.plan.committerDeviceId,
          }),
          repository.inspectForegroundNamespaceAuthority({
            namespaceId: input.plan.namespaceId,
            keyClass: "ai",
          }),
        ]);
        return domains.status === "ready" && room.status === "ready"
          ? Object.freeze({ domains, room })
          : null;
      },
    });
    if (inspected === null) return reject("domain_authority_unavailable");
    const authorizationBytes = bytes(row, "agent_grant_plan_bytes");
    const authorizationDigest = bytes(row, "agent_grant_plan_digest");
    const authorization = parseDomainForegroundAuthorizationPlanV2(
      authorizationBytes,
    );
    try {
      const digest = input.crypto.hash(authorizationBytes);
      try {
        const roomDomain = inspected.domains.domains.find((entry) =>
          entry.domainId === inspected.room.domainId
        );
        if (
        authorization === null
        || now() >= authorization.deadlineAt
        || !equal(digest, authorizationDigest)
        || authorization.policyRevision !== input.plan.policyRevision
        || authorization.sessionId !== (sharedExecution
          ? text(row, "client_action_session_id")
          : input.plan.sessionId)
        || authorization.roomId !== authorityRoomId
        || authorization.subjectHumanId !== input.plan.subjectHumanId
        || authorization.committerDeviceId !== input.plan.committerDeviceId
        || authorization.committerDeviceSigningGeneration
          !== input.plan.committerDeviceSigningKeyGeneration
        || authorization.hostAuthorizationRevision
          !== input.plan.hostAuthorizationRevision
        || (sharedExecution
          ? authorization.recipientKind !== "runtime"
            || authorization.recipientPrincipalId
              !== "nautilo_foreground_runtime"
            || authorization.recipientAuthorizationRevision !== 0
            || authorization.recipientRuntimeGeneration !== 0
          : authorization.recipientKind !== "agent"
            || authorization.recipientPrincipalId
              !== input.plan.recipientAgentId
            || authorization.recipientAuthorizationRevision
              !== input.plan.agentAuthorizationRevision
            || authorization.recipientRuntimeGeneration
              !== input.plan.agentRuntimeGeneration)
        || authorization.recipientKeyId !== text(row, "recipient_key_id")
        || authorization.domains.length !== inspected.domains.domains.length
        || !authorization.domains.every((entry, index) =>
          inspected.domains.domains[index] !== undefined
          && sameDomain(entry, inspected.domains.domains[index])
        )
        || roomDomain === undefined
        || roomDomain.domainId !== input.plan.grantDomainId
        || !equal(
          roomDomain.participantDigest,
          input.plan.grantDomainParticipantDigest,
        )
        || roomDomain.domainKeyGeneration
          !== input.plan.grantDomainKeyGeneration
        || !equal(roomDomain.headDigest, input.plan.grantDomainHeadDigest)
        || !equal(
          roomDomain.activeNamespaceBindingSetDigest,
          input.plan.grantDomainPublicationDigest,
        )
        || roomDomain.authorizationRevision
          !== input.plan.grantDomainAuthorizationRevision
        || inspected.room.bundleRevision !== input.plan.namespaceBundleRevision
        || !equal(inspected.room.bundleDigest, input.plan.namespaceBundleDigest)
        || (input.plan.authorization.disposition === "authorization_required"
          && (
            authorization.authorizationId
              !== input.plan.authorization.authorizationId
            || !equal(
              authorizationBytes,
              input.plan.authorization.authorizationPlanBytes,
            )
            || !equal(
              authorizationDigest,
              input.plan.authorization.authorizationPlanDigest,
            )
          ))
        ) {
          if (authorization !== null) {
            destroyDomainForegroundAuthorizationPlanV2(authorization);
          }
          return reject("foreground_authorization_stale");
        }
        return Object.freeze({
          causalHumanUserId: text(row, "subject_user_id"),
          signingPublicKey: bytes(device, "signing_public_key"),
          readableNamespaceIds: readable,
          domains: Object.freeze(inspected.domains.domains.map(copyDomain)),
          room: copyRoom(inspected.room),
          authorization,
          authorizationDigest: authorizationDigest.slice(),
          acceptedGrantDigest: row["accepted_grant_digest"] == null
            ? null
            : bytes(row, "accepted_grant_digest"),
        });
      } finally {
        digest.fill(0);
      }
    } finally {
      authorizationBytes.fill(0);
      authorizationDigest.fill(0);
      destroyDomains(inspected.domains.domains);
      destroyRoom(inspected.room);
    }
  };

  const initial = await load();
  if (initial === null) return null;
  let destroyed = false;
  const authority: DomainKeyV2LiveShadowCurrentAuthority = Object.freeze({
    causalHumanUserId: initial.causalHumanUserId,
    resolveCurrentHumanAuthority: (
      context: Parameters<
        ResolveCurrentDomainCompressedHumanLiveShadowMessageAuthority
      >[0],
    ) => destroyed
        || context.subjectHumanId !== input.plan.subjectHumanId
        || context.operationId !== input.plan.operationId
        || context.committerDeviceId !== input.plan.committerDeviceId
        || context.committerDeviceSigningKeyGeneration
          !== input.plan.committerDeviceSigningKeyGeneration
        || context.hostAuthorizationRevision
          !== input.plan.hostAuthorizationRevision
      ? null
      : initial.signingPublicKey.slice(),
    resolveCurrentForegroundAuthorization: async () => {
      if (destroyed) return null;
      const current = await load();
      if (current === null) return null;
      const result = Object.freeze({
        authorizationId: current.authorization.authorizationId,
        policyRevision: input.plan.policyRevision,
        sessionId: current.authorization.sessionId,
        roomId: current.authorization.roomId,
        subjectHumanId: humanId(input.plan.subjectHumanId),
        committerDeviceId: cryptoDeviceId(input.plan.committerDeviceId),
        committerDeviceSigningGeneration:
          input.plan.committerDeviceSigningKeyGeneration,
        committerDeviceSigningPublicKey: current.signingPublicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: authorizationRevision(
          input.plan.hostAuthorizationRevision,
        ),
        recipientKind: current.authorization.recipientKind,
        recipientPrincipalId: current.authorization.recipientPrincipalId,
        recipientAuthorizationRevision:
          current.authorization.recipientAuthorizationRevision,
        recipientRuntimeGeneration:
          current.authorization.recipientRuntimeGeneration,
        recipientKeyId: current.authorization.recipientKeyId,
        recipientAuthorized: true,
        issuedAt: current.authorization.issuedAt,
        deadlineAt: current.authorization.deadlineAt,
        readableNamespaceIds: current.readableNamespaceIds,
        domains: current.domains,
      });
      destroyRoom(current.room);
      current.authorizationDigest.fill(0);
      current.acceptedGrantDigest?.fill(0);
      destroyDomainForegroundAuthorizationPlanV2(current.authorization);
      return result;
    },
    withCurrentRoomNamespaceKey: async <Value>({ domains, use }: Readonly<{
      domains: readonly DomainForegroundSecretEntry[]
        | readonly DeviceWrappedDomainAgentGrantSecretEntry[];
      use(key: Uint8Array): Promise<Value> | Value;
    }>) => {
      if (destroyed) return null;
      const current = await load();
      if (current === null) return null;
      try {
        const selected = domains.find((entry) =>
          ("domainId" in entry ? entry.domainId : entry.grantDomainId)
            === current.room.domainId
          && entry.domainKeyGeneration === current.room.domainKeyGeneration
          && entry.authorizationRevision
            === current.room.domainAuthorizationRevision
          && equal(entry.headDigest, current.room.domainHeadDigest)
        );
        if (selected === undefined) return null;
        return await repository.withOpenedForegroundNamespaceKey({
          authority: current.room,
          domainKey: "domainKey" in selected
            ? selected.domainKey
            : selected.domainAiGrantKey,
          use,
          onDiagnostic: (stage) => input.onDiagnostic?.(
            `room_namespace_${stage}`,
          ),
        });
      } finally {
        current.signingPublicKey.fill(0);
        destroyDomains(current.domains);
        destroyRoom(current.room);
        current.authorizationDigest.fill(0);
        current.acceptedGrantDigest?.fill(0);
        destroyDomainForegroundAuthorizationPlanV2(current.authorization);
      }
    },
    verifyCurrentPlan: async () => {
      if (destroyed) return false;
      const current = await load();
      if (current === null) return false;
      current.signingPublicKey.fill(0);
      destroyDomains(current.domains);
      destroyRoom(current.room);
      current.authorizationDigest.fill(0);
      current.acceptedGrantDigest?.fill(0);
      destroyDomainForegroundAuthorizationPlanV2(current.authorization);
      return true;
    },
    resolveCurrentHumanObjectWrite: async (
      context: Parameters<ResolveCurrentObjectAccessGenesisAuthorization>[0],
    ) => {
      if (destroyed) return null;
      const current = await load();
      if (current === null) return null;
      let transferred = false;
      try {
        const envelope = context.envelopes[0];
        const expectedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
          operationId: input.plan.operationId,
          sessionId: input.plan.sessionId,
          messageId: input.plan.humanMessageId,
          revision: 0,
          transcriptOrdinal: 1,
          authorRole: "user",
        });
        if (
          context.objectId !== expectedObjectId
          || context.committerDeviceId !== input.plan.committerDeviceId
          || context.hostAuthorizationRevision
            !== input.plan.hostAuthorizationRevision
          || context.envelopes.length !== 1
          || envelope?.namespaceId !== input.plan.namespaceId
          || envelope.keyClass !== "ai"
          || envelope.keyGeneration !== input.plan.namespaceKeyGeneration
          || envelope.bindingRevisionAtWrap
            !== input.plan.namespaceAccessRevision
        ) return null;
        transferred = true;
        return Object.freeze({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision:
            input.plan.hostAuthorizationRevision,
          committerSigningPublicKey: current.signingPublicKey,
        });
      } finally {
        if (!transferred) current.signingPublicKey.fill(0);
        destroyDomains(current.domains);
        destroyRoom(current.room);
        current.authorizationDigest.fill(0);
        current.acceptedGrantDigest?.fill(0);
        destroyDomainForegroundAuthorizationPlanV2(current.authorization);
      }
    },
    resolveCurrentAgentObjectWrite: async (
      context: Parameters<
        ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization
      >[0],
    ) => {
      if (destroyed) return null;
      const current = await load();
      if (current === null) return null;
      try {
        const lifecycle = one(await input.product.query(
          `/* m301_v2_live_shadow_current_agent_object */
           SELECT crypto_object_id, author_role, namespace_id_at_allocation,
                  object_id_scheme, shadow_operation_id,
                  shared_agent_shadow_execution_id
             FROM session_message_crypto_revisions
            WHERE crypto_object_id = $1
              AND (shadow_operation_id = $2
                OR shared_agent_shadow_execution_id = $2)
              AND edit_revision = 0 LIMIT 2`,
          [context.objectId, input.plan.operationId],
        ));
        if (
          lifecycle === null
          || text(lifecycle, "crypto_object_id") !== context.objectId
          || !["assistant", "tool"].includes(text(lifecycle, "author_role"))
          || text(lifecycle, "namespace_id_at_allocation")
            !== input.plan.namespaceId
          || text(lifecycle, "object_id_scheme") !== "live_shadow_v1"
          || !(
            lifecycle["shadow_operation_id"] === input.plan.operationId
            && lifecycle["shared_agent_shadow_execution_id"] === null
            || lifecycle["shared_agent_shadow_execution_id"]
                === input.plan.operationId
              && lifecycle["shadow_operation_id"] === null
          )
          || context.operationId !== input.plan.operationId
          || context.recipientKeyId !== current.authorization.recipientKeyId
          || context.namespaceId !== input.plan.namespaceId
          || context.namespaceAccessRevision
            !== input.plan.namespaceAccessRevision
          || !equal(context.namespaceHeadDigest, input.plan.namespaceHeadDigest)
          || !equal(
            context.namespacePublicationDigest,
            input.plan.namespacePublicationDigest,
          )
          || !equal(
            context.namespacePublicationSetDigest,
            input.plan.namespacePublicationSetDigest,
          )
          || !equal(
            context.namespaceAudienceFingerprint,
            input.plan.namespaceAudienceFingerprint,
          )
          || context.envelope.namespaceId !== input.plan.namespaceId
          || context.envelope.keyClass !== "ai"
          || context.envelope.keyGeneration !== input.plan.namespaceKeyGeneration
          || context.envelope.bindingRevisionAtWrap
            !== input.plan.namespaceAccessRevision
          || context.agentId !== input.plan.recipientAgentId
          || context.agentAuthorizationRevision
            !== input.plan.agentAuthorizationRevision
          || context.runtimeGeneration !== input.plan.agentRuntimeGeneration
          || context.signerKeyId !== input.plan.agentSignerKeyId
        ) return null;
        return Object.freeze({
          context,
          grantAuthorized: true,
          namespaceAuthorized: true,
          agentAuthorized: true,
          hostAllowsOperation: true,
          currentRuntime: Object.freeze({
            agentId: agentId(input.plan.recipientAgentId),
            authorizationRevision: authorizationRevision(
              input.plan.agentAuthorizationRevision,
            ),
            runtimeGeneration: agentRuntimeGeneration(
              input.plan.agentRuntimeGeneration,
            ),
          }),
          signerPublicKey: input.plan.agentSignerPublicKey.slice(),
        });
      } finally {
        current.signingPublicKey.fill(0);
        destroyDomains(current.domains);
        destroyRoom(current.room);
        current.authorizationDigest.fill(0);
        current.acceptedGrantDigest?.fill(0);
        destroyDomainForegroundAuthorizationPlanV2(current.authorization);
      }
    },
    resolveCurrentForegroundEntityObjectWrite: async (
      context: Parameters<
        ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization
      >[0],
    ) => {
      if (destroyed) return null;
      const current = await load();
      if (current === null) return null;
      try {
        if (
          context.operationId !== input.plan.operationId
          || context.grantId !== current.authorization.authorizationId
          || current.acceptedGrantDigest === null
          || !equal(context.grantHash, current.acceptedGrantDigest)
          || context.recipientKeyId !== current.authorization.recipientKeyId
          || context.agentId !== input.plan.recipientAgentId
          || context.agentAuthorizationRevision
            !== input.plan.agentAuthorizationRevision
          || context.runtimeGeneration !== input.plan.agentRuntimeGeneration
          || context.signerKeyId !== input.plan.agentSignerKeyId
          || context.namespaces.length !== context.envelopes.length
          || context.namespaces.some((entry, index) =>
            index > 0
            && context.namespaces[index - 1]!.namespaceId >= entry.namespaceId
          )
          || context.namespaces.some((entry) =>
            !current.readableNamespaceIds.includes(entry.namespaceId)
          )
        ) return null;
        for (const namespace of context.namespaces) {
          const inspected = await repository.inspectForegroundNamespaceAuthority({
            namespaceId: namespace.namespaceId,
            keyClass: "ai",
          });
          if (inspected.status !== "ready") return null;
          try {
            const domain = current.domains.find((entry) =>
              entry.domainId === inspected.domainId
            );
            const envelope = context.envelopes.find((entry) =>
              entry.namespaceId === namespace.namespaceId
            );
            if (
              domain === undefined
              || envelope === undefined
              || namespace.accessRevision
                !== inspected.namespaceAccessRevision
              || namespace.keyGeneration
                !== inspected.namespaceKeyGeneration
              || namespace.domainId !== inspected.domainId
              || namespace.domainKeyGeneration
                !== inspected.domainKeyGeneration
              || namespace.domainAuthorizationRevision
                !== inspected.domainAuthorizationRevision
              || !equal(
                namespace.domainHeadDigest,
                inspected.domainHeadDigest,
              )
              || !equal(namespace.headDigest, inspected.namespaceHeadDigest)
              || !equal(
                namespace.publicationDigest,
                inspected.namespacePublicationDigest,
              )
              || !equal(
                namespace.publicationSetDigest,
                inspected.namespacePublicationSetDigest,
              )
              || !equal(
                namespace.audienceFingerprint,
                inspected.namespaceAudienceFingerprint,
              )
              || envelope.keyClass !== "ai"
              || envelope.keyGeneration !== namespace.keyGeneration
              || envelope.bindingRevisionAtWrap !== namespace.accessRevision
              || domain.domainKeyGeneration
                !== inspected.domainKeyGeneration
              || domain.authorizationRevision
                !== inspected.domainAuthorizationRevision
              || !equal(domain.headDigest, inspected.domainHeadDigest)
            ) return null;
          } finally {
            destroyRoom(inspected);
          }
        }
        if (now() >= current.authorization.deadlineAt) return null;
        return Object.freeze({
          context,
          grantAuthorized: true,
          namespacesAuthorized: true,
          agentAuthorized: true,
          hostAllowsOperation: true,
          currentRuntime: Object.freeze({
            agentId: agentId(input.plan.recipientAgentId),
            authorizationRevision: authorizationRevision(
              input.plan.agentAuthorizationRevision,
            ),
            runtimeGeneration: agentRuntimeGeneration(
              input.plan.agentRuntimeGeneration,
            ),
          }),
          signerPublicKey: input.plan.agentSignerPublicKey.slice(),
        });
      } finally {
        current.signingPublicKey.fill(0);
        destroyDomains(current.domains);
        destroyRoom(current.room);
        current.authorizationDigest.fill(0);
        current.acceptedGrantDigest?.fill(0);
        destroyDomainForegroundAuthorizationPlanV2(current.authorization);
      }
    },
    signingPublicKey: () => destroyed ? null : initial.signingPublicKey.slice(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      initial.signingPublicKey.fill(0);
      initial.authorizationDigest.fill(0);
      initial.acceptedGrantDigest?.fill(0);
      destroyDomains(initial.domains);
      destroyRoom(initial.room);
      destroyDomainForegroundAuthorizationPlanV2(initial.authorization);
    },
  });
  return authority;
}
