import {
  authenticateHumanMemoryExactAccessPrepared,
  HumanMemoryCryptoServiceUnavailableError,
  PostgresHumanMemoryExactAccessCryptoCompletion,
  PostgresHumanMemoryExactAccessProduct,
  createPostgresForegroundAgentSignerResolver,
  readAuthenticatedHumanMemoryExactAccessAuthority,
  type HumanMemoryProtectedExactAccessCryptoPort,
  type HumanMemoryProtectedExactAccessProductPort,
} from "@nautilo/lattice-bridge/server";
import {
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2,
  decodeHumanMemoryExactAccessRequestV2,
} from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";

import { createM173HumanMemoryExactAccessTargetResolver } from
  "./protected-memory-exact-access-target";
import type { HumanMemoryRequestServices } from "./human-memory-request-services";
import { humanMemoryCryptoServiceUnavailable } from "./human-memory-request-services";
import type { ProtectedMemoryRouteAuthority } from "./protected-memory-composition";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

export function createHumanMemoryExactAccessServices(input: Readonly<{
  services: HumanMemoryRequestServices;
  authority: ProtectedMemoryRouteAuthority;
  envelope: MemoryAccessEnvelope;
  policy: Readonly<{ revision: number }>;
}>): Readonly<{
  exactAccessProduct: HumanMemoryProtectedExactAccessProductPort;
  exactAccessCrypto: HumanMemoryProtectedExactAccessCryptoPort;
  accessDeadlineAt: () => number;
}> {
  if (input.authority.agentId !== null || input.envelope.agentId === null) {
    throw new TypeError("Human Memory exact access requires a contextual Agent destination");
  }
  const product = new PostgresHumanMemoryExactAccessProduct(
    input.services.context.handle,
    {
      canonicalRunner: input.services.context.canonicalRunner,
      publication: {
        allowOrdinaryFallback: input.services.publication.allowOrdinaryFallback,
        fence: ({ transaction, authority }) =>
          input.services.publication.fence({ transaction, authority, mutation: true }),
        withLocks: ({ authority, preparedAuthority }, publish) =>
          input.services.cryptoAuthority.withCurrentAccessAuthority({
            subjectUserId: authority.userId,
            humanActorId: input.envelope.actorId,
            context: preparedAuthority,
          }, publish),
      },
    },
  );
  const completion = new PostgresHumanMemoryExactAccessCryptoCompletion({
    handle: input.services.cryptoHandle,
    crypto: input.services.crypto,
    resolveHistoricalAgentSignerAuthority:
      input.services.resolveHistoricalAgentSignerAuthority,
    resolveLiveShadowAgentSigner: createPostgresForegroundAgentSignerResolver({
      product: input.services.context.handle,
      crypto: input.services.crypto,
    }),
  });
  const resolveTarget = createM173HumanMemoryExactAccessTargetResolver({
    agentId: input.envelope.agentId,
  });
  const exactAccessCrypto: HumanMemoryProtectedExactAccessCryptoPort = Object.freeze({
      digestSignedRequest(prepared) {
        return sha256(Buffer.from(
          prepared.signedAccessRequestBytesBase64url,
          "base64url",
        ));
      },
      async authenticate({ plan, prepared, replayAdmission }) {
        const signedRequestBytes = Buffer.from(
          prepared.signedAccessRequestBytesBase64url,
          "base64url",
        );
        const signed = decodeHumanMemoryExactAccessRequestV2(signedRequestBytes);
        const key = await input.services.cryptoAuthority.resolveCurrentAccessSigningKey({
          purpose: "human-memory-exact-access-verify",
          subjectHumanId: signed.subjectHumanId,
          operationId: signed.operationId,
          committerDeviceId: signed.committerDeviceId,
          hostAuthorizationRevision: signed.hostAuthorizationRevision,
        });
        try {
          const handle = authenticateHumanMemoryExactAccessPrepared({
            crypto: input.services.crypto,
            plan,
            signedRequestBytes,
            manifestBytes: Buffer.from(prepared.accessManifestBytesBase64url, "base64url"),
            envelopeBytes: prepared.namespaceEnvelopes.map((entry) =>
              Buffer.from(entry.envelopeBytesBase64url, "base64url")),
            now: Date.now(),
            resolveCurrentAuthority: () => key?.slice() ?? null,
            ...(replayAdmission === undefined ? {} : { replayAdmission }),
          });
          return Object.freeze({ handle, signedRequestDigest: sha256(signedRequestBytes),
            publicationAuthority: readAuthenticatedHumanMemoryExactAccessAuthority(handle) });
        } finally {
          key?.fill(0);
          signedRequestBytes.fill(0);
        }
      },
      async complete(handle) {
        try {
          return await completion.complete(handle);
        } catch (error) {
          if (!humanMemoryCryptoServiceUnavailable(error)) throw error;
          throw new HumanMemoryCryptoServiceUnavailableError({ cause: error });
        }
      },
      observe: completion.observe.bind(completion),
    });
  return Object.freeze({
    exactAccessProduct: Object.freeze({
      resolveTarget,
      plan: product.plan.bind(product),
      reserve: product.reserve.bind(product),
      lookupReplay: product.lookupReplay.bind(product),
      commit: product.commit.bind(product),
      commitOrdinaryFallback: product.commitOrdinaryFallback.bind(product),
      reconcile: product.reconcile.bind(product),
    }),
    exactAccessCrypto,
    accessDeadlineAt: () => Date.now()
      + HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2,
  });
}
