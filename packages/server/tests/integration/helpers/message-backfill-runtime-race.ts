import {
  conversationShadowTurnAgentSigners,
  conversationShadowTurnOperations,
  createPostgresJsBridgeConnection,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
  type AgentRuntimeKeyGeneration,
  type LatticeCrypto,
  type ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization,
} from "@nautilo/lattice-crypto";
import { encodeLiveShadowMessagePlanV4 } from "@nautilo/lattice-crypto/wire";
import { createDormantConversationShadowRepository } from
  "@nautilo/lattice-bridge";
import {
  createForegroundMessageHistoryRepairer,
  createPostgresConversationCryptoCompletion,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  createPostgresForegroundAgentSignerResolver,
  loadPostgresForegroundMessageRepairSources,
  PostgresConversationProductStore,
  PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  verifyConversationProductPostgresHandle,
  type ForegroundMessageEntityCryptoInvocation,
  type ForegroundMessageHistoryResult,
} from "@nautilo/lattice-bridge/server";
import { eq } from "drizzle-orm";

import { createForegroundProductTransactionContext } from
  "../../../src/routes/foreground-message-product-store.ts";
import { getServerDirectDb } from "../../../src/lib/server-direct-db.ts";

const AGENT_AUTHORIZATION_REVISION = authorizationRevision(1);

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

export interface ForegroundRuntimeMessageRepairInput {
  readonly crypto: LatticeCrypto;
  readonly restricted: PostgresJsBridgeConnection;
  readonly userId: string;
  readonly humanActorId: string;
  readonly agentId: string;
  readonly namespaceId: string;
  readonly messageId: number;
  readonly policyRevision: number;
  readonly domain: Readonly<{
    id: string;
    generation: number;
    authorizationRevision: number;
    headDigest: Uint8Array;
  }>;
  readonly registerCleanup: (cleanup: () => Promise<void>) => void;
  readonly namespace: Readonly<{
    key: Uint8Array;
    accessRevision: number;
    keyGeneration: number;
    headDigest: Uint8Array;
    publicationDigest: Uint8Array;
    publicationSetDigest: Uint8Array;
    audienceFingerprint: Uint8Array;
  }>;
  readonly runtime: Readonly<{
    agentId: string;
    generation: number;
    /** Agent Runtime root key; the object signer is derived from this key. */
    runtimeKey: Uint8Array;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
  }>;
}

/**
 * Runs the production foreground Runtime repair path for one integration
 * Message. Current Namespace and Grant authority are retained fixture inputs;
 * product mutation, crypto storage, signer history and source loading are the
 * same PostgreSQL adapters used by the live foreground composition.
 */
export async function runForegroundRuntimeMessageRepair(
  input: Readonly<ForegroundRuntimeMessageRepairInput>,
): Promise<ForegroundMessageHistoryResult> {
  if (input.agentId !== input.runtime.agentId) {
    throw new TypeError("Foreground Runtime repair Agent does not match");
  }
  if (!Number.isSafeInteger(input.messageId) || input.messageId < 1) {
    throw new TypeError("Foreground Runtime repair Message ID is invalid");
  }
  if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) {
    throw new TypeError("Foreground Runtime repair policy revision is invalid");
  }

  const runtime: AgentRuntimeKeyGeneration = Object.freeze({
    agentId: agentId(input.runtime.agentId),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(input.runtime.generation),
    key: input.runtime.runtimeKey.slice(),
  });
  const derivedSigner = deriveAgentRuntimeObjectSignerPublic(
    input.crypto,
    runtime,
  );
  if (
    derivedSigner.principal.signerKeyId !== input.runtime.signerKeyId
    || !equalBytes(derivedSigner.publicKey, input.runtime.signerPublicKey)
  ) {
    runtime.key.fill(0);
    derivedSigner.publicKey.fill(0);
    throw new TypeError("Foreground Runtime repair signer does not match Runtime key");
  }

  const operationId = `m313-runtime-repair-${input.messageId}`;
  const grantId = `m313-runtime-grant-${input.messageId}`;
  const recipientKeyId = `m313-runtime-recipient-${input.messageId}`;
  const grantDigest = input.crypto.hash(
    new TextEncoder().encode(`${grantId}:${input.namespaceId}`),
  );
  const domainHeadDigest = input.domain.headDigest.slice();
  const grantDomainParticipantDigest = input.crypto.hash(
    new TextEncoder().encode(`m313-runtime-participant:${input.agentId}`),
  );
  const grantDomainPublicationDigest = input.crypto.hash(
    new TextEncoder().encode(`m313-runtime-domain-publication:${input.namespaceId}`),
  );
  const namespaceBundleDigest = input.crypto.hash(
    new TextEncoder().encode(`m313-runtime-bundle:${input.namespaceId}`),
  );
  const agentGrantPlanBytes = new TextEncoder().encode(
    `m313-runtime-agent-grant:${input.messageId}`,
  );
  const agentGrantPlanDigest = input.crypto.hash(agentGrantPlanBytes);
  const humanRequestBytes = new TextEncoder().encode(
    `m313-runtime-human-request:${input.messageId}`,
  );
  const humanRequestDigest = input.crypto.hash(humanRequestBytes);

  const authority = () => Object.freeze({
    namespaceId: input.namespaceId,
    namespaceAccessRevision: input.namespace.accessRevision,
    namespaceKeyGeneration: input.namespace.keyGeneration,
    domainId: input.domain.id,
    domainKeyGeneration: input.domain.generation,
    domainAuthorizationRevision: input.domain.authorizationRevision,
    domainHeadDigest: domainHeadDigest.slice(),
    namespaceHeadDigest: input.namespace.headDigest.slice(),
    namespacePublicationDigest: input.namespace.publicationDigest.slice(),
    namespacePublicationSetDigest:
      input.namespace.publicationSetDigest.slice(),
    namespaceAudienceFingerprint:
      input.namespace.audienceFingerprint.slice(),
  });
  const wipeAuthority = (value: ReturnType<typeof authority>): void => {
    value.domainHeadDigest.fill(0);
    value.namespaceHeadDigest.fill(0);
    value.namespacePublicationDigest.fill(0);
    value.namespacePublicationSetDigest.fill(0);
    value.namespaceAudienceFingerprint.fill(0);
  };
  const use: ForegroundMessageEntityCryptoInvocation["use"] =
    async (request) => {
      if (
        request.entity.namespaceId !== input.namespaceId
        || request.entity.keyGeneration !== input.namespace.keyGeneration
        || request.entity.accessRevision !== input.namespace.accessRevision
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_unavailable" as const,
      });
      const namespaceKey = input.namespace.key.slice();
      const currentAuthority = authority();
      try {
        return Object.freeze({
          status: "executed" as const,
          value: await request.execute({
            namespaceKey,
            authority: currentAuthority,
          }),
        });
      } finally {
        namespaceKey.fill(0);
        wipeAuthority(currentAuthority);
      }
    };
  const useCurrentSet:
    ForegroundMessageEntityCryptoInvocation["useCurrentSet"] =
    async (request) => {
      if (
        request.namespaceIds.length !== 1
        || request.namespaceIds[0] !== input.namespaceId
      ) return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_unavailable" as const,
      });
      const namespaceKey = input.namespace.key.slice();
      const currentAuthority = authority();
      try {
        return Object.freeze({
          status: "executed" as const,
          value: await request.execute(Object.freeze([Object.freeze({
            namespaceKey,
            authority: currentAuthority,
          })])),
        });
      } finally {
        namespaceKey.fill(0);
        wipeAuthority(currentAuthority);
      }
    };

  const resolveCurrentAuthorization:
    ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization =
    (context) => {
      const namespace = context.namespaces[0];
      if (
        context.operationId !== operationId
        || context.grantId !== grantId
        || !equalBytes(context.grantHash, grantDigest)
        || context.recipientKeyId !== recipientKeyId
        || context.agentId !== input.runtime.agentId
        || context.agentAuthorizationRevision !== AGENT_AUTHORIZATION_REVISION
        || context.runtimeGeneration !== input.runtime.generation
        || context.signerKeyId !== input.runtime.signerKeyId
        || context.namespaces.length !== 1
        || namespace === undefined
        || namespace.namespaceId !== input.namespaceId
        || namespace.accessRevision !== input.namespace.accessRevision
        || namespace.keyGeneration !== input.namespace.keyGeneration
        || namespace.domainId !== input.domain.id
        || namespace.domainKeyGeneration !== input.domain.generation
        || namespace.domainAuthorizationRevision !== input.domain.authorizationRevision
        || !equalBytes(namespace.domainHeadDigest, domainHeadDigest)
        || !equalBytes(namespace.headDigest, input.namespace.headDigest)
        || !equalBytes(
          namespace.publicationDigest,
          input.namespace.publicationDigest,
        )
        || !equalBytes(
          namespace.publicationSetDigest,
          input.namespace.publicationSetDigest,
        )
        || !equalBytes(
          namespace.audienceFingerprint,
          input.namespace.audienceFingerprint,
        )
      ) return null;
      return Object.freeze({
        context,
        grantAuthorized: true as const,
        namespacesAuthorized: true as const,
        agentAuthorized: true as const,
        hostAllowsOperation: true as const,
        currentRuntime: Object.freeze({
          agentId: runtime.agentId,
          authorizationRevision: AGENT_AUTHORIZATION_REVISION,
          runtimeGeneration: runtime.generation,
        }),
        signerPublicKey: input.runtime.signerPublicKey.slice(),
      });
    };

  try {
    const [{ handle, canonicalRunner }, cryptoHandle, evidenceHandle] = await Promise.all([
      createForegroundProductTransactionContext({
        userId: input.userId,
        agentId: input.agentId,
      }),
      verifyCryptoPostgresHandle(input.restricted),
      // The live foreground composition reads server-retained execution evidence
      // through the server product role; Message mutations stay on the Agent handle.
      verifyConversationProductPostgresHandle(createPostgresJsBridgeConnection(getServerDirectDb())),
    ]);
    const product = new PostgresConversationProductStore(
      handle,
      canonicalRunner,
    );
    const [source] = await loadPostgresForegroundMessageRepairSources({
      product: handle,
      readableNamespaceIds: [input.namespaceId],
      messageIds: [input.messageId],
      representationMode: "ordinary-and-protected",
    });
    if (source === undefined) {
      throw new Error("Foreground Runtime repair source is missing");
    }
    const issuedAt = source.createdAt;
    const deadlineAt = issuedAt + 30_000;
    const attemptCoordinate = `m313-runtime-attempt-${input.messageId}`;
    const planBytes = encodeLiveShadowMessagePlanV4({
      formatVersion: 4,
      purpose: "message.live_shadow_plan",
      operationId,
      policyRevision: input.policyRevision,
      sessionId: source.sessionId,
      roomId: source.roomId,
      humanMessageId: source.messageId,
      revision: 0,
      createdAt: unixTimestamp(issuedAt),
      subjectHumanId: humanId(input.humanActorId),
      committerDeviceId: cryptoDeviceId("m313-runtime-fixture-device"),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(1),
      recipientAgentId: runtime.agentId,
      agentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      agentRuntimeGeneration: runtime.generation,
      agentSignerKeyId: input.runtime.signerKeyId,
      agentSignerPublicKey: input.runtime.signerPublicKey,
      namespaceId: namespaceId(input.namespaceId),
      namespaceAccessRevision: accessRevision(input.namespace.accessRevision),
      namespaceKeyGeneration:
        namespaceGeneration(input.namespace.keyGeneration),
      namespaceHeadDigest: input.namespace.headDigest,
      namespacePublicationDigest: input.namespace.publicationDigest,
      namespacePublicationSetDigest: input.namespace.publicationSetDigest,
      namespaceAudienceFingerprint: input.namespace.audienceFingerprint,
      grantDomainId: input.domain.id,
      grantDomainParticipantDigest,
      grantDomainKeyGeneration: input.domain.generation,
      grantDomainHeadDigest: domainHeadDigest,
      grantDomainPublicationDigest,
      grantDomainAuthorizationRevision: authorizationRevision(input.domain.authorizationRevision),
      namespaceBundleGrantDomainAuthorizationRevision:
        authorizationRevision(input.domain.authorizationRevision),
      namespaceBundleRevision: 1,
      namespaceBundleDigest,
      authorization: Object.freeze({
        disposition: "authorization_reusable" as const,
        sessionReference: `m313-runtime-session-${input.messageId}`,
        authorizationDigest: grantDigest,
      }),
      attemptCoordinate,
      issuedAt: unixTimestamp(issuedAt),
      deadlineAt: unixTimestamp(deadlineAt),
    });
    const planDigest = input.crypto.hash(planBytes);
    const recipientPublicKey = new Uint8Array(65).fill(0x31);
    try {
      await getServerDirectDb().transaction(async (database) => {
        const inserted = await database.insert(conversationShadowTurnOperations).values({
          operationId,
          clientIdempotencyKey: `m313-runtime-client-${input.messageId}`,
          policyRevision: input.policyRevision,
          sessionId: source.sessionId,
          roomId: source.roomId,
          humanMessageId: source.messageId,
          humanMessageCreatedAt: new Date(source.createdAt),
          subjectHumanId: input.humanActorId,
          committerDeviceId: "m313-runtime-fixture-device",
          committerDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 1,
          agentId: input.agentId,
          agentAuthorizationRevision: 1,
          namespaceId: input.namespaceId,
          namespaceAccessRevision: input.namespace.accessRevision,
          namespaceKeyGeneration: input.namespace.keyGeneration,
          namespaceHeadDigest: input.namespace.headDigest,
          namespacePublicationDigest: input.namespace.publicationDigest,
          namespacePublicationSetDigest:
            input.namespace.publicationSetDigest,
          namespaceAudienceFingerprint:
            input.namespace.audienceFingerprint,
          grantDomainId: input.domain.id,
          grantDomainParticipantDigest,
          grantDomainKeyGeneration: input.domain.generation,
          grantDomainHeadDigest: domainHeadDigest,
          grantDomainPublicationDigest,
          grantDomainAuthorizationRevision: input.domain.authorizationRevision,
          namespaceBundleRevision: 1,
          namespaceBundleDigest,
          agentGrantPlanBytes,
          agentGrantPlanDigest,
          recipientId: input.agentId,
          recipientKeyId,
          recipientPublicKey,
          attemptCoordinate,
          planDigest,
          planBytes,
          humanRequestDigest,
          humanRequestBytes,
          grantDigest,
          state: "completed",
          deadlineAt: new Date(deadlineAt),
          terminalAt: new Date(issuedAt + 1),
          createdAt: new Date(issuedAt),
          updatedAt: new Date(issuedAt + 1),
        }).onConflictDoNothing().returning({
          operationId: conversationShadowTurnOperations.operationId,
        });
        if (inserted.length > 0) {
          input.registerCleanup(async () => {
            await getServerDirectDb().delete(conversationShadowTurnOperations)
              .where(eq(conversationShadowTurnOperations.operationId, operationId));
          });
        }
        await database.insert(conversationShadowTurnAgentSigners).values({
          operationId,
          agentRuntimeGeneration: input.runtime.generation,
          agentSignerKeyId: input.runtime.signerKeyId,
          agentSignerPublicKey: input.runtime.signerPublicKey,
        }).onConflictDoNothing();
      });
      const accepted = await
        createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
          product: evidenceHandle,
          crypto: input.crypto,
        })(derivedSigner.principal);
      if (accepted === null) {
        throw new Error(
          "Foreground Runtime accepted execution evidence is unreadable",
        );
      }
      try {
        if (
          !equalBytes(accepted.signerPublicKey, input.runtime.signerPublicKey)
          || !equalBytes(accepted.planDigest, planDigest)
        ) {
          throw new Error(
            "Foreground Runtime accepted execution evidence is unreadable",
          );
        }
      } finally {
        accepted.signerPublicKey.fill(0);
        accepted.planBytes.fill(0);
        accepted.planDigest.fill(0);
      }
    } finally {
      planBytes.fill(0);
      planDigest.fill(0);
      recipientPublicKey.fill(0);
    }
    const storage = new PostgresLatticeStorage(cryptoHandle);
    const signerHistory = new PostgresHumanDeviceSignerHistory({
      handle: cryptoHandle,
      crypto: input.crypto,
    });
    const resolveForegroundSigner =
      createPostgresForegroundAgentSignerResolver({
        product: evidenceHandle,
        crypto: input.crypto,
      });
    const completion = createPostgresConversationCryptoCompletion({
      handle: cryptoHandle,
      crypto: input.crypto,
      resolveCurrentWriteAuthorization: () => null,
      resolveHistoricalSigner: signerHistory.resolveHistoricalObjectSigner,
      resolveHistoricalAgentSignerAuthority:
        signerHistory.resolveAgentRuntimeSignerManager,
      resolveLiveShadowAgentSigner: (principal) =>
        principal.agentId === input.runtime.agentId
            && principal.runtimeGeneration === input.runtime.generation
            && principal.signerKeyId === input.runtime.signerKeyId
          ? input.runtime.signerPublicKey.slice()
          : resolveForegroundSigner(principal),
    });
    const repairer = createForegroundMessageHistoryRepairer({
      crypto: input.crypto,
      storage,
      entities: Object.freeze({ use, useCurrentSet }),
      product,
      conversation: createDormantConversationShadowRepository({
        product,
        crypto: completion,
      }),
      cryptoCompletion: completion,
      contextNamespaceId: input.namespaceId,
      publication: Object.freeze({
        operationId,
        policyRevision: input.policyRevision,
        grantId,
        grantDigest,
        recipientKeyId,
        agentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        signerKeyId: input.runtime.signerKeyId,
        signerPublicKey: input.runtime.signerPublicKey,
        runtime,
        withCurrentPublication: (request) => product.withAuthorizedExistingRepresentationPublication({
          ...request,
          // This fixture supplies its synthetic signer authority directly;
          // production binds the V2 loader to the supplied transaction.
          prepareAuthority: () => Promise.resolve(resolveCurrentAuthorization),
          use: (scopedProduct, scopedAuthority) => request.use({
            product: scopedProduct, resolveCurrentAuthorization: scopedAuthority,
          }),
          disposeAuthority: () => {},
        }),
      }),
      loadSources: (selection) =>
        loadPostgresForegroundMessageRepairSources({
          product: handle,
          ...selection,
        }),
      resolveHistoricalHumanSigner:
        signerHistory.resolveHistoricalObjectSigner,
      resolveLiveShadowAgentSigner: resolveForegroundSigner,
      resolveHistoricalAgentSignerAuthority:
        signerHistory.resolveAgentRuntimeSignerManager,
    });
    return await repairer.protect({ messageIds: [input.messageId] });
  } finally {
    runtime.key.fill(0);
    derivedSigner.publicKey.fill(0);
    grantDigest.fill(0);
    domainHeadDigest.fill(0);
    grantDomainParticipantDigest.fill(0);
    grantDomainPublicationDigest.fill(0);
    namespaceBundleDigest.fill(0);
    agentGrantPlanBytes.fill(0);
    agentGrantPlanDigest.fill(0);
    humanRequestBytes.fill(0);
    humanRequestDigest.fill(0);
  }
}
