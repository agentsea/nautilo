import {
  decryptObjectThroughNamespace,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import type {
  AgentEntityCryptoInvocation,
  AgentEntityNamespaceAuthority,
} from "./agent-entity-crypto.ts";

export type AgentObjectProtectionSource = Readonly<{
  objectId: string;
  objectType: string;
  existingObjectId: string | null;
  expectedAccessRevision?: number;
  createdAt: number;
  namespaceIds: readonly string[];
  plaintextBytes: Uint8Array | null;
}>;

export type AgentObjectPreparationSource = Readonly<
  Omit<AgentObjectProtectionSource, "existingObjectId" | "plaintextBytes">
  & {
    existingObjectId: null;
    plaintextBytes: Uint8Array;
  }
>;

export type AgentObjectProtectionResult<Value> =
  | Readonly<{
      status: "verified";
      objectId: string;
      provenance: "existing" | "repaired";
      verification: "authenticated" | "independent_parity";
      value: Value;
    }>
  | Readonly<{
      status: "waiting_for_authority" | "failed";
      reason: string;
    }>;

export type VerifiedAgentObject = Readonly<{
  objectId: string;
  accessRevision: number;
  payloadBytes: Uint8Array;
  namespaceEnvelopes: readonly Readonly<{
    namespaceId: string;
    keyGeneration: number;
    bindingRevisionAtWrap: number;
    envelopeBytes: Uint8Array;
  }>[];
}>;

export interface AgentObjectProtector {
  protect<Value>(request: Readonly<{
    operationId: string;
    source: AgentObjectProtectionSource;
    decode(plaintextBytes: Uint8Array): Value;
  }>): Promise<AgentObjectProtectionResult<Value>>;
}

export type AgentObjectProtectionNamespace = Readonly<{
  namespaceKey: Uint8Array;
  authority: AgentEntityNamespaceAuthority;
}>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function unavailable(reason: string): AgentObjectProtectionResult<never> {
  return Object.freeze({ status: "waiting_for_authority" as const, reason });
}

/**
 * Family-neutral Agent object publication and authenticated reopen primitive.
 * The caller owns the authenticated preparation family for the supplied
 * operation and exact live Namespace set.
 */
export function createAgentObjectProtector(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<AgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
  prepareAndPersist(request: Readonly<{
    operationId: string;
    source: AgentObjectPreparationSource;
    opened: readonly AgentObjectProtectionNamespace[];
  }>): Promise<"created" | "duplicate" | "stale">;
  read(request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<VerifiedAgentObject | null>;
}>): AgentObjectProtector {
  return Object.freeze({
    protect: async <Value>(request: Readonly<{
      operationId: string;
      source: AgentObjectProtectionSource;
      decode(plaintextBytes: Uint8Array): Value;
    }>): Promise<AgentObjectProtectionResult<Value>> => {
      const source = request.source;
      if (input.entities.signal.aborted) {
        return unavailable("authorization_cancelled");
      }
      if (
        source.namespaceIds.length < 1
        || source.namespaceIds.some((namespaceId, index) =>
          index > 0 && source.namespaceIds[index - 1]! >= namespaceId
        )
      ) return Object.freeze({
        status: "failed" as const,
        reason: "entity_namespace_set_invalid",
      });
      const targetObjectId = source.existingObjectId ?? source.objectId;
      const read = (expectedAccessRevision?: number) => input.read({
        objectId: targetObjectId,
        expectedObjectType: source.objectType,
        ...(expectedAccessRevision === undefined
          ? {}
          : { expectedAccessRevision }),
        expectedNamespaceIds: source.namespaceIds,
      });
      try {
        let durable = await read(source.expectedAccessRevision);
        if (input.entities.signal.aborted) {
          return unavailable("authorization_cancelled");
        }
        let provenance: "existing" | "repaired" = "existing";
        if (durable === null) {
          if (source.existingObjectId !== null) return Object.freeze({
            status: "failed" as const,
            reason: "mapped_entity_crypto_incomplete",
          });
          const plaintextBytes = source.plaintextBytes;
          if (plaintextBytes === null) return Object.freeze({
            status: "failed" as const,
            reason: "protected_representation_missing",
          });
          const preparationSource: AgentObjectPreparationSource = Object.freeze({
            ...source,
            objectId: targetObjectId,
            existingObjectId: null,
            plaintextBytes,
          });
          provenance = "repaired";
          try {
            const published = await input.entities.useCurrentSet({
              operations: ["encrypt"],
              namespaceIds: source.namespaceIds,
              execute: (opened) => input.prepareAndPersist({
                operationId: request.operationId,
                source: preparationSource,
                opened,
              }),
            });
            if (published.status !== "executed") {
              return unavailable("entity_namespace_authority_unavailable");
            }
            if (input.entities.signal.aborted) {
              return unavailable("authorization_cancelled");
            }
            durable = await read(0);
            if (published.value === "stale" && durable === null) {
              return unavailable("entity_namespace_authority_unavailable");
            }
          } catch (error) {
            durable = await read(0);
            if (durable === null) throw error;
          }
          if (durable === null) return Object.freeze({
            status: "failed" as const,
            reason: "entity_crypto_publication_incomplete",
          });
        }
        if (input.entities.signal.aborted) {
          return unavailable("authorization_cancelled");
        }
        const currentDurable = durable;
        try {
          const payload = decodeEncryptedPayloadV2(currentDurable.payloadBytes);
          let plaintext: Uint8Array | null = null;
          let openedVisibleNamespace = false;
          try {
            for (const stored of currentDurable.namespaceEnvelopes) {
              const opened = await input.entities.use({
                operations: ["decrypt"],
                entity: {
                  namespaceId: stored.namespaceId,
                  keyGeneration: stored.keyGeneration,
                  accessRevision: stored.bindingRevisionAtWrap,
                },
                execute: ({ namespaceKey }) => {
                  const envelope = decodeNamespaceObjectEnvelopeV2(
                    stored.envelopeBytes,
                  );
                  try {
                    return decryptObjectThroughNamespace(
                      input.crypto,
                      namespaceKey,
                      envelope,
                      payload,
                    );
                  } finally {
                    envelope.wrappedDek.fill(0);
                  }
                },
              });
              if (opened.status !== "executed") continue;
              openedVisibleNamespace = true;
              if (opened.value !== null) {
                plaintext = opened.value;
                break;
              }
            }
          } finally {
            payload.ciphertext.fill(0);
          }
          if (!openedVisibleNamespace) {
            return unavailable("entity_namespace_authority_unavailable");
          }
          if (plaintext === null) return Object.freeze({
            status: "failed" as const,
            reason: "entity_decryption_failed",
          });
          try {
            if (
              source.plaintextBytes !== null
              && !equalBytes(plaintext, source.plaintextBytes)
            ) return Object.freeze({
              status: "failed" as const,
              reason: "entity_parity_mismatch",
            });
            return Object.freeze({
              status: "verified" as const,
              objectId: targetObjectId,
              provenance,
              verification: source.plaintextBytes === null || provenance === "repaired"
                ? "authenticated" as const
                : "independent_parity" as const,
              value: request.decode(plaintext),
            });
          } finally {
            plaintext.fill(0);
          }
        } finally {
          currentDurable.payloadBytes.fill(0);
          currentDurable.namespaceEnvelopes.forEach((entry) =>
            entry.envelopeBytes.fill(0)
          );
        }
      } catch {
        return Object.freeze({
          status: "failed" as const,
          reason: "entity_repair_failed",
        });
      }
    },
  });
}
