import {
  createPostgresJsBridgeConnection,
  getSharedDirectCryptoDb,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createHumanMemoryPreparedCreateRoutePort,
  createHumanMemoryPreparedUpdateRoutePort,
  HumanMemoryCryptoServiceUnavailableError,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  createPostgresHumanMemoryCryptoCompletion,
  createPostgresHumanMemoryNamespaceAuthorityResolver,
  createPostgresHumanMemoryProtectedProductRoutePort,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceSignerHistory,
  PostgresHumanMemoryAuthorityResolver,
  PostgresHumanMemoryProductUpdate,
  PostgresNamespaceProductAuthority,
  verifyCryptoPostgresHandle,
  type PostgresHumanMemoryCryptoCompletion,
} from "@nautilo/lattice-bridge/server";
import { isScopeMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { createHumanMemoryEmbeddingProcessor } from "./human-memory-embedding-processor";
import { createHumanMemoryPublicationAuthority } from "./human-memory-publication-authority";

export function humanMemoryCryptoServiceUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && (
    code.startsWith("08") || ["57P01", "57P02", "57P03", "ECONNREFUSED",
      "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code)
  );
}
import { createHumanMemoryReadObservationIssuer } from "./human-memory-read-observations";
import type { ProtectedMemoryRouteAuthority } from "./protected-memory-composition";

export type HumanMemoryRequestServices = Readonly<{
  context: Awaited<ReturnType<typeof createHumanProductTransactionContext>>;
  crypto: LatticeCrypto;
  cryptoHandle: Awaited<ReturnType<typeof verifyCryptoPostgresHandle>>;
  cryptoAuthority: PostgresHumanMemoryAuthorityResolver;
  domainKeys: PostgresDomainKeyAuthorityRepository;
  publication: ReturnType<typeof createHumanMemoryPublicationAuthority>;
  resolveHumanId: (userId: string) => Promise<string | null>;
  resolveNamespaceAuthority: ReturnType<typeof createPostgresHumanMemoryNamespaceAuthorityResolver>;
  embedding: ReturnType<typeof createHumanMemoryEmbeddingProcessor>;
  cryptoCompletion: PostgresHumanMemoryCryptoCompletion;
  resolveHistoricalAgentSignerAuthority:
    PostgresHumanDeviceSignerHistory["resolveAgentRuntimeSignerManager"];
  product: ReturnType<typeof createPostgresHumanMemoryProtectedProductRoutePort>;
  preparedCreate: ReturnType<typeof createHumanMemoryPreparedCreateRoutePort>;
  preparedUpdate: ReturnType<typeof createHumanMemoryPreparedUpdateRoutePort>;
}>;

/** Bind the existing Human producer/consumer to one current request. Nothing
 * here is cached across accounts, and no Agent grant is minted for the library.
 * Exact-access publication is assembled with these same services by the route
 * owner; this function does not register a partial route family. */
export async function createHumanMemoryRequestServices(input: Readonly<{
  authority: ProtectedMemoryRouteAuthority;
  envelope: MemoryAccessEnvelope;
  policy: Parameters<typeof createHumanMemoryPublicationAuthority>[0]["policy"];
  serverId: string;
}>): Promise<HumanMemoryRequestServices> {
  assertHumanMemoryRequestBinding(input);
  const crypto = new LatticeCrypto();
  const restrictedConnection = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
  const [context, cryptoHandle] = await Promise.all([
    createHumanProductTransactionContext(input.authority.userId),
    verifyCryptoPostgresHandle(restrictedConnection),
  ]);
  const cryptoAuthority = new PostgresHumanMemoryAuthorityResolver({ handle: cryptoHandle });
  const resolveHumanId = (userId: string) => userId === input.authority.userId
    ? cryptoAuthority.resolveHumanId(userId)
    : Promise.resolve(null);
  const publication = createHumanMemoryPublicationAuthority({
    envelope: input.envelope, policy: input.policy, cryptoAuthority,
  });
  const productAuthority = new PostgresNamespaceProductAuthority(
    createPostgresJsBridgeConnection(getServerDirectDb()),
  );
  const domainKeys = new PostgresDomainKeyAuthorityRepository(
    restrictedConnection, crypto, input.serverId,
  );
  const resolveNamespaceAuthority = createPostgresHumanMemoryNamespaceAuthorityResolver({
    product: context.handle, productAuthority, domainKeys,
  });
  const signerHistory = new PostgresHumanDeviceSignerHistory({ handle: cryptoHandle, crypto });
  const createCryptoCompletion = (
    resolveCurrentWriteAuthorization = cryptoAuthority.resolveCurrentWriteAuthorization,
  ) => {
    const completion = createPostgresHumanMemoryCryptoCompletion({
    handle: cryptoHandle,
    crypto,
    resolveCurrentWriteAuthorization,
    resolveStoredSignerAuthority: cryptoAuthority.resolveStoredSignerAuthority,
    resolveHistoricalAgentSignerAuthority: signerHistory.resolveAgentRuntimeSignerManager,
    // Agent-authored Memories are normal library rows. Their accepted execution
    // evidence is verified through the retained product receipt, not presented
    // as a Human-signed genesis or persisted into a device profile.
    resolveForegroundAgentAcceptedExecutionEvidence:
      createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
        product: context.handle, crypto,
      }),
    });
    return Object.freeze({ read: completion.read.bind(completion),
      verify: completion.verify.bind(completion),
      async complete(revision: Parameters<typeof completion.complete>[0]) {
        try {
          return await completion.complete(revision);
        } catch (error) {
          if (!humanMemoryCryptoServiceUnavailable(error)) throw error;
          throw new HumanMemoryCryptoServiceUnavailableError({ cause: error });
        }
      } });
  };
  const cryptoCompletion = createCryptoCompletion();
  const product = new PostgresHumanMemoryProductUpdate(context.handle, {
    canonicalRunner: context.canonicalRunner, publication,
  });
  const embedding = createHumanMemoryEmbeddingProcessor();
  const prepared = {
    crypto,
    now: Date.now,
    resolveHumanId,
    resolveHistoricalDeviceAuthority: cryptoAuthority.resolveHistoricalDeviceAuthority,
    resolveHistoricalOrdinaryDeviceAuthority:
      cryptoAuthority.resolveHistoricalOrdinaryDeviceAuthority,
    resolveCurrentWriteAuthorization: cryptoAuthority.resolveCurrentWriteAuthorization,
    foregroundEmbeddingProcessor: embedding.processor,
    product,
    createCryptoCompletion,
    resolveNamespaceAuthority,
    ...(publication.allowOrdinaryFallback ? {
      ordinaryFallbackAuthorization: { policyRevision: input.policy.revision },
    } : {}),
  };
  return Object.freeze({
    context,
    crypto,
    cryptoHandle,
    cryptoAuthority,
    domainKeys,
    publication,
    resolveHumanId,
    resolveNamespaceAuthority,
    embedding,
    cryptoCompletion,
    resolveHistoricalAgentSignerAuthority:
      signerHistory.resolveAgentRuntimeSignerManager,
    product: createPostgresHumanMemoryProtectedProductRoutePort({
      ...context, publication, cryptoCompletion, resolveHumanId, resolveNamespaceAuthority,
      issueReadObservation: createHumanMemoryReadObservationIssuer({ db: getServerDirectDb() }),
    }),
    preparedCreate: createHumanMemoryPreparedCreateRoutePort(prepared),
    preparedUpdate: createHumanMemoryPreparedUpdateRoutePort(prepared),
  });
}

/** Validate before acquiring any database handle. Surrounding Agent context
 * does not change who is acting, and a different request cannot reuse it. */
export function assertHumanMemoryRequestBinding(input: Readonly<{
  authority: ProtectedMemoryRouteAuthority;
  envelope: MemoryAccessEnvelope;
  policy: Parameters<typeof createHumanMemoryPublicationAuthority>[0]["policy"];
  serverId: string;
}>): void {
  const { authority, envelope } = input;
  const same = (left: readonly string[], right: readonly string[]) => {
    const sorted = [...right].sort();
    return new Set(left).size === left.length
      && left.length === sorted.length
      && [...left].sort().every((id, i) => id === sorted[i]);
  };
  if (input.serverId.trim().length === 0
    || input.policy.mode === "plaintext_only"
    || isScopeMemoryEnvelope(envelope)
    || authority.memoryMode !== "namespace"
    || authority.agentId !== null
    || authority.userId !== envelope.ownerId
    || authority.actorId !== envelope.actorId
    || authority.sourceRoomId !== envelope.roomId
    || authority.scopeId !== null
    || authority.originWritableNamespaceId !== null
    || !same(authority.readableNamespaceIds, envelope.readableNamespaces)
    || !same(authority.mutableNamespaceIds, envelope.mutableNamespaces)
    || !same(authority.writableNamespaceIds, envelope.writableNamespaces)) {
    throw new TypeError("Human Memory composition requires the exact current library authority");
  }
}
