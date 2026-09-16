import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  and,
  eq,
  namespaceDomainKeyHeads,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  HUMAN_MESSAGE_EDIT_MAX_TTL_MS_V1,
  decodeEncryptedPayloadV2,
  decodeHumanMessageEditPlanV1,
  decodeNamespaceObjectEnvelopeV2,
  deriveHumanMessageEditCryptoObjectIdV1,
  encodeHumanMessageEditPlanV1,
  verifyHumanMessageEditRequestV1,
  type HumanMessageEditPlanV1,
} from "@nautilo/lattice-crypto/wire";
import {
  authenticateObjectAccessManifestGenesis,
  authorizationRevision,
  encryptedObjectWriteRecord,
} from "@nautilo/lattice-crypto";
import { createPreparedConversationCryptoRevision } from "../../message/conversation-prepared-revision.ts";
import { parseProtectedMessageDtoV2, type ProtectedMessageDtoV2 } from "@nautilo/types";
import { CONVERSATION_MESSAGE_OBJECT_TYPE } from "../../message/conversation-repository.ts";
import type { ConversationProductEditResult, ConversationProductStorePort, PreparedConversationCryptoRevision } from "../../message/conversation-repository.ts";
import { PostgresDomainKeyAuthorityRepository } from "../delivery/postgres-domain-key-authority.ts";
import { PostgresNamespaceProductAuthority } from "../delivery/postgres-namespace-product-authority.ts";
import { cryptoTypedDb, executeTypedCryptoQuery } from "../storage/postgres-lattice-storage.ts";
import {
  withCurrentHumanDeviceSigningAuthority,
  withCurrentHumanDeviceSigningAuthorityExecutor,
} from "../device/postgres-current-human-device-signing-authority.ts";

export type HumanMessageEditPlanResult =
  | Readonly<{ status: "planned"; plan: HumanMessageEditPlanV1; planBytes: Uint8Array }>
  | Readonly<{ status: "unavailable"; reason: "policy_unavailable" | "authority_unavailable" | "message_unavailable" | "revision_conflict" }>;

export type HumanMessageEditPublishResult = Readonly<{
  product: ConversationProductEditResult;
  protectedMessages: readonly ProtectedMessageDtoV2[];
}>;

export class PostgresHumanMessageEditPlanner {
  readonly #productAuthority: PostgresNamespaceProductAuthority;
  readonly #domainAuthority: PostgresDomainKeyAuthorityRepository;

  constructor(
    productConnection: PostgresJsBridgeConnection,
    private readonly restrictedConnection: PostgresJsBridgeConnection,
    private readonly product: ConversationProductStorePort,
    private readonly crypto: LatticeCrypto,
    serverId: string,
    private readonly readPolicy: () => Promise<Readonly<{ mode: string; revision: number }> | null>,
    private readonly completeRevision?: (input: Readonly<{
      revision: PreparedConversationCryptoRevision;
      plan: HumanMessageEditPlanV1;
      signingPublicKey: Uint8Array;
    }>) => Promise<"created" | "duplicate">,
    private readonly now: () => number = Date.now,
  ) {
    this.#productAuthority = new PostgresNamespaceProductAuthority(productConnection);
    this.#domainAuthority = new PostgresDomainKeyAuthorityRepository(
      restrictedConnection,
      crypto,
      serverId,
    );
  }

  async publish(input: Readonly<{
    roomId: string;
    messageId: number;
    subjectUserId: string;
    subjectHumanId: string;
    planBytes: Uint8Array;
    requestBytes: Uint8Array;
    preparedTargets: readonly Readonly<{
      sessionId: string;
      messageId: number;
      encryptedPayloadBytes: Uint8Array;
      manifestBytes: Uint8Array;
      envelopeBytes: Uint8Array;
    }>[];
  }>): Promise<HumanMessageEditPublishResult> {
    if (this.completeRevision === undefined) {
      throw new Error("Protected edit crypto completion is unavailable");
    }
    const plan = decodeHumanMessageEditPlanV1(input.planBytes);
    const routedTarget = plan.targets.find((target) => target.messageId === input.messageId);
    if (
      plan.roomId !== input.roomId
      || plan.subjectHumanId !== input.subjectHumanId
      || routedTarget === undefined
    ) throw new TypeError("Protected edit route and plan coordinates disagree");
    const requestDigest = this.crypto.hash(input.requestBytes);
    const replay = await this.product.inspectProtectedEditReplay({
      messageId: input.messageId,
      operationId: plan.operationId,
      expectedRevision: routedTarget.expectedRevision,
      requestDigest,
    });
    if (replay !== null) {
      if (replay.status !== "replayed") return { product: replay, protectedMessages: [] };
      return this.#projectCommittedEdit(plan, input, replay);
    }
    const source = await this.product.inspectProtectedEditPlanSource(
      input.messageId,
      routedTarget.expectedRevision,
    );
    if (
      source === null
      || source.roomId !== input.roomId
      || source.subjectUserId !== input.subjectUserId
      || source.authorHumanId !== input.subjectHumanId
      || source.authorizationScheme !== plan.authorizationScheme
      || source.targets.length !== plan.targets.length
    ) throw new TypeError("Protected edit current product authority is stale");
    const sourceByCoordinate = new Map(source.targets.map((target) => [
      `${target.sessionId}:${target.messageId}`,
      target,
    ]));
    for (const target of plan.targets) {
      const current = sourceByCoordinate.get(`${target.sessionId}:${target.messageId}`);
      if (
        current === undefined
        || current.expectedRevision !== target.expectedRevision
        || current.createdAt !== target.createdAt
        || current.namespaceId !== target.namespaceId
        || current.keyClass !== target.keyClass
        || target.nextRevision !== target.expectedRevision + 1
        || target.cryptoObjectId !== deriveHumanMessageEditCryptoObjectIdV1({
          operationId: plan.operationId,
          sessionId: target.sessionId,
          messageId: target.messageId,
          revision: target.nextRevision,
        })
      ) throw new TypeError("Protected edit exact target authority is stale");
    }
    const policy = await this.readPolicy();
    if (policy?.mode !== "encrypted_only" || policy.revision !== plan.policyRevision) {
      throw new TypeError("Protected edit policy is stale");
    }
    const preparedByCoordinate = new Map(input.preparedTargets.map((target) => [
      `${target.sessionId}:${target.messageId}`,
      target,
    ]));
    if (preparedByCoordinate.size !== plan.targets.length) {
      throw new TypeError("Protected edit prepared target set is incomplete");
    }
    const same = (left: Uint8Array, right: Uint8Array) =>
      left.length === right.length
      && left.every((byte, offset) => byte === right[offset]);
    for (const target of plan.targets) {
      const current = await this.#domainAuthority.inspectForegroundNamespaceAuthority({
        namespaceId: target.namespaceId,
        keyClass: target.keyClass,
      });
      if (
        current.status !== "ready"
        || current.namespaceAccessRevision !== target.namespaceAccessRevision
        || current.namespaceKeyGeneration !== target.namespaceKeyGeneration
        || !same(current.namespaceHeadDigest, target.namespaceHeadDigest)
        || !same(current.namespacePublicationDigest, target.namespacePublicationDigest)
        || !same(current.namespacePublicationSetDigest, target.namespacePublicationSetDigest)
        || !same(current.namespaceAudienceFingerprint, target.namespaceAudienceFingerprint)
      ) throw new TypeError("Protected edit Namespace authority is stale");
    }
    const result = await withCurrentHumanDeviceSigningAuthority(this.restrictedConnection, {
      subjectUserId: input.subjectUserId,
      subjectHumanId: input.subjectHumanId,
      humanActorId: input.subjectHumanId,
      deviceId: plan.committerDeviceId,
      deviceSigningKeyGeneration: plan.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: plan.hostAuthorizationRevision,
    }, async (signingPublicKey) => {
      const request = verifyHumanMessageEditRequestV1(this.crypto, {
        planBytes: input.planBytes,
        requestBytes: input.requestBytes,
        now: this.now(),
        resolveCurrentAuthority: (context) =>
          context.subjectHumanId === input.subjectHumanId
              && context.committerDeviceId === plan.committerDeviceId
              && context.committerDeviceSigningKeyGeneration === plan.committerDeviceSigningKeyGeneration
              && context.hostAuthorizationRevision === plan.hostAuthorizationRevision
            ? signingPublicKey
            : null,
      });
      const prepared = [];
      for (const [index, target] of plan.targets.entries()) {
        const bytes = preparedByCoordinate.get(`${target.sessionId}:${target.messageId}`);
        const signed = request.targets[index];
        if (bytes === undefined || signed === undefined) {
          throw new TypeError("Protected edit target bytes are missing");
        }
        const payload = decodeEncryptedPayloadV2(bytes.encryptedPayloadBytes);
        const envelope = decodeNamespaceObjectEnvelopeV2(bytes.envelopeBytes);
        if (
          !same(this.crypto.hash(bytes.encryptedPayloadBytes), signed.encryptedPayloadDigest)
          || !same(this.crypto.hash(bytes.manifestBytes), signed.manifestDigest)
          || !same(this.crypto.hash(bytes.envelopeBytes), signed.envelopeDigest)
          || payload.context.objectId !== target.cryptoObjectId
          || payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
          || payload.context.keyClass !== target.keyClass
          || payload.context.createdAt !== target.createdAt
          || envelope.context.objectId !== target.cryptoObjectId
          || envelope.context.namespaceId !== target.namespaceId
          || envelope.context.keyClass !== target.keyClass
          || envelope.context.keyGeneration !== target.namespaceKeyGeneration
          || envelope.context.bindingRevisionAtWrap !== target.namespaceAccessRevision
        ) throw new TypeError("Protected edit signed storage bytes disagree");
        const access = await authenticateObjectAccessManifestGenesis({
          crypto: this.crypto,
          payloadBytes: bytes.encryptedPayloadBytes,
          manifestBytes: bytes.manifestBytes,
          envelopeBytes: [bytes.envelopeBytes],
          resolveCurrentAuthorization: (context) => ({
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: authorizationRevision(plan.hostAuthorizationRevision),
            committerSigningPublicKey: signingPublicKey,
          }),
        });
        if (
          access.manifest.committerDeviceId !== plan.committerDeviceId
          || access.manifest.hostAuthorizationRevision
            !== plan.hostAuthorizationRevision
        ) throw new TypeError("Protected edit manifest signer disagrees");
        prepared.push(createPreparedConversationCryptoRevision({
          objectId: target.cryptoObjectId,
          namespaceId: target.namespaceId,
          object: encryptedObjectWriteRecord(bytes.encryptedPayloadBytes),
          access,
          resolveCurrentAuthorization: (context) => Promise.resolve({
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision: authorizationRevision(plan.hostAuthorizationRevision),
            committerSigningPublicKey: signingPublicKey,
          }),
        }));
      }
      for (const revision of prepared) await this.completeRevision!({
        revision,
        plan,
        signingPublicKey,
      });
      const productTargets = plan.targets.map((target) => ({
          sessionId: target.sessionId,
          messageId: target.messageId,
          namespaceId: target.namespaceId,
          cryptoObjectId: target.cryptoObjectId,
          keyClass: target.keyClass,
          namespaceAccessRevision: target.namespaceAccessRevision,
          namespaceKeyGeneration: target.namespaceKeyGeneration,
          namespaceAudienceFingerprint: target.namespaceAudienceFingerprint,
        }));
      return this.restrictedConnection.transactionOnce(async (restrictedTx) =>
        this.product.publishProtectedEdit({
          messageId: input.messageId,
          operationId: plan.operationId,
          expectedRevision: routedTarget.expectedRevision,
          requestDigest,
          policyRevision: plan.policyRevision,
          targets: productTargets,
          lockCryptoAuthority: async () => {
            const held = await withCurrentHumanDeviceSigningAuthorityExecutor(
              restrictedTx,
              {
                subjectUserId: input.subjectUserId,
                subjectHumanId: input.subjectHumanId,
                humanActorId: input.subjectHumanId,
                deviceId: plan.committerDeviceId,
                deviceSigningKeyGeneration: plan.committerDeviceSigningKeyGeneration,
                hostAuthorizationRevision: plan.hostAuthorizationRevision,
              },
              async (currentSigningKey) => {
                if (!same(currentSigningKey, signingPublicKey)) {
                  throw new TypeError("Protected edit device authority drifted");
                }
                for (const target of plan.targets) {
                  const rows = await executeTypedCryptoQuery(
                    restrictedTx,
                    cryptoTypedDb.select({
                      namespace_access_revision:
                        namespaceDomainKeyHeads.namespaceAccessRevision,
                      namespace_current_generation:
                        namespaceDomainKeyHeads.namespaceCurrentGeneration,
                    }).from(namespaceDomainKeyHeads).where(and(
                      eq(namespaceDomainKeyHeads.namespaceId, target.namespaceId),
                      eq(namespaceDomainKeyHeads.keyClass, target.keyClass),
                    )).for("share"),
                  );
                  const head = rows[0];
                  if (
                    rows.length !== 1
                    || Number(head?.["namespace_access_revision"]) !== target.namespaceAccessRevision
                    || Number(head?.["namespace_current_generation"]) !== target.namespaceKeyGeneration
                  ) throw new TypeError("Protected edit Namespace authority drifted");
                }
              },
            );
            if (held === null) throw new TypeError("Protected edit device authority drifted");
          },
        }), { isolationLevel: "read committed" });
    });
    if (result === null) throw new TypeError("Protected edit device authority is stale");
    return this.#projectCommittedEdit(plan, input, result);
  }

  #projectCommittedEdit(
    plan: HumanMessageEditPlanV1,
    input: Readonly<{
      messageId: number;
      roomId: string;
      subjectUserId: string;
      preparedTargets: readonly Readonly<{
        sessionId: string;
        messageId: number;
        encryptedPayloadBytes: Uint8Array;
        manifestBytes: Uint8Array;
        envelopeBytes: Uint8Array;
      }>[];
    }>,
    product: ConversationProductEditResult,
  ): HumanMessageEditPublishResult {
    if (product.status !== "allocated" && product.status !== "replayed") {
      return { product, protectedMessages: [] };
    }
    if (product.committedProjection === undefined) {
      throw new Error("Committed protected edit lost its structural projection");
    }
    const bytesByCoordinate = new Map(input.preparedTargets.map((target) => [
      `${target.sessionId}:${target.messageId}`,
      target,
    ]));
    const protectedMessages = plan.targets.map((target) => {
      const bytes = bytesByCoordinate.get(`${target.sessionId}:${target.messageId}`);
      if (bytes === undefined) {
        throw new Error("Committed protected edit lost its exact target bytes");
      }
      return parseProtectedMessageDtoV2({
        dtoVersion: 2,
        projection: {
          messageId: String(target.messageId),
          logicalMessageKey: product.committedProjection!.logicalMessageKey,
          sessionId: target.sessionId,
          roomId: input.roomId,
          namespaceId: target.namespaceId,
          role: "user",
          createdAt: new Date(target.createdAt).toISOString(),
          editedAt: product.committedProjection!.editedAt.toISOString(),
          editRevision: target.nextRevision,
          sourceUserId: input.subjectUserId,
        },
        protectedPayload: {
          status: "encrypted",
          cryptoObjectId: target.cryptoObjectId,
          payloadVersion: 2,
          keyClass: target.keyClass,
          encryptedPayloadBytesBase64url: Buffer.from(bytes.encryptedPayloadBytes).toString("base64url"),
          accessManifestBytesBase64url: Buffer.from(bytes.manifestBytes).toString("base64url"),
          namespaceEnvelopeBytesBase64url: Buffer.from(bytes.envelopeBytes).toString("base64url"),
        },
      });
    });
    return { product, protectedMessages: Object.freeze(protectedMessages) };
  }

  async plan(input: Readonly<{
    roomId: string;
    messageId: number;
    expectedRevision: number;
    subjectUserId: string;
    subjectHumanId: string;
    clientDeviceId: string;
    clientIdempotencyKey: string;
  }>): Promise<HumanMessageEditPlanResult> {
    const policy = await this.readPolicy();
    if (policy === null || policy.mode !== "encrypted_only") {
      return { status: "unavailable", reason: "policy_unavailable" };
    }
    const source = await this.product.inspectProtectedEditPlanSource(
      input.messageId,
      input.expectedRevision,
    );
    if (source === null) {
      return { status: "unavailable", reason: "message_unavailable" };
    }
    if (
      source.roomId !== input.roomId
      || source.subjectUserId !== input.subjectUserId
      || source.authorHumanId !== input.subjectHumanId
    ) return { status: "unavailable", reason: "authority_unavailable" };
    const namespaceIds = [...new Set(source.targets.map((target) => target.namespaceId))].sort();
    const inspect = async () => {
      const foreground = await this.#domainAuthority.inspectForegroundAuthority({
        namespaceIds,
        keyClass: source.targets[0]!.keyClass,
        subjectHumanId: input.subjectHumanId,
        deviceId: input.clientDeviceId,
      });
      if (foreground.status !== "ready") return null;
      const namespaces = await Promise.all(source.targets.map((target) =>
        this.#domainAuthority.inspectForegroundNamespaceAuthority({
          namespaceId: target.namespaceId,
          keyClass: target.keyClass,
        })
      ));
      if (namespaces.some((entry) => entry.status !== "ready")) return null;
      return { foreground, namespaces };
    };
    const roomInput = {
      subjectUserId: input.subjectUserId,
      subjectHumanId: input.subjectHumanId,
      roomId: input.roomId,
      namespaceId: namespaceIds[0]!,
      use: inspect,
    };
    const authority = source.authorizationScheme === "foreground_session_v1"
      ? await this.#productAuthority.withCurrentPrivateRoom(roomInput)
      : source.authorizationScheme === "human_peer_v1"
        ? await this.#productAuthority.withCurrentHumanOnlyRoom(roomInput)
        : await this.#productAuthority.withCurrentHumanAiReadableRoom(roomInput);
    if (authority === null) {
      return { status: "unavailable", reason: "authority_unavailable" };
    }
    const issuedAt = this.now();
    const operationId = `human-edit:v1:${randomUUID()}`;
    const plan: HumanMessageEditPlanV1 = {
      formatVersion: 1,
      purpose: "message.human_edit_plan",
      operationId,
      clientIdempotencyKey: input.clientIdempotencyKey,
      authorizationScheme: source.authorizationScheme,
      policyRevision: policy.revision,
      roomId: input.roomId,
      subjectHumanId: input.subjectHumanId,
      committerDeviceId: authority.foreground.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        authority.foreground.committerDeviceSigningGeneration,
      hostAuthorizationRevision: authority.foreground.hostAuthorizationRevision,
      targets: source.targets.map((target, index) => {
        const current = authority.namespaces[index]!;
        if (current.status !== "ready") throw new Error("Namespace authority disappeared");
        return {
          sessionId: target.sessionId,
          messageId: target.messageId,
          expectedRevision: target.expectedRevision,
          nextRevision: target.expectedRevision + 1,
          createdAt: target.createdAt,
          namespaceId: target.namespaceId,
          keyClass: target.keyClass,
          namespaceAccessRevision: current.namespaceAccessRevision,
          namespaceKeyGeneration: current.namespaceKeyGeneration,
          namespaceHeadDigest: current.namespaceHeadDigest,
          namespacePublicationDigest: current.namespacePublicationDigest,
          namespacePublicationSetDigest: current.namespacePublicationSetDigest,
          namespaceAudienceFingerprint: current.namespaceAudienceFingerprint,
          cryptoObjectId: deriveHumanMessageEditCryptoObjectIdV1({
            operationId,
            sessionId: target.sessionId,
            messageId: target.messageId,
            revision: target.expectedRevision + 1,
          }),
        };
      }),
      issuedAt,
      deadlineAt: issuedAt + HUMAN_MESSAGE_EDIT_MAX_TTL_MS_V1,
    };
    const planBytes = encodeHumanMessageEditPlanV1(plan);
    return { status: "planned", plan, planBytes };
  }
}
