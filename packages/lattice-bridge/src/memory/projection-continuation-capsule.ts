import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import type {
  ProtectedAgentMemoryProjectionReference,
} from "./active-memory-repository.ts";
import type {
  AgentEntityCryptoInvocation,
  AgentEntityNamespaceAuthority,
} from "../object/agent-entity-crypto.ts";

const FOREGROUND_DOMAIN = "nautilo/foreground-memory-projection/v1";
const PROTECTED_TASK_DOMAIN =
  "nautilo/protected-task-memory-projection/v1";
const CAPSULE_KEY_BYTES = 32;

export type AgentMemoryProjectionContinuationIdentityV1 =
  | Readonly<{
      kind: "foreground_v1";
      ownerId: string;
      actorId: string;
      agentId: string;
      roomId: string;
      readableNamespaceIds: readonly string[];
      mutableNamespaceIds: readonly string[];
      writableNamespaceIds: readonly string[];
      policyRevision: number;
      agentAuthorizationRevision: number;
    }>
  | Readonly<{
      kind: "protected_task_v1";
      taskId: string;
      taskRunId: string;
      graphThreadId: string;
      subjectUserId: string;
      humanActorId: string;
      agentId: string;
      contentNamespaceId: string;
      policyRevision: number;
      agentAuthorizationRevision: number;
    }>;

export type AgentMemoryProjectionContinuationCapsule = Readonly<{
  seal(
    reference: ProtectedAgentMemoryProjectionReference,
    value: unknown,
  ): Promise<string>;
  open(reference: ProtectedAgentMemoryProjectionReference): Promise<unknown>;
}>;

type ProjectionEntityInvocation = Pick<
  AgentEntityCryptoInvocation,
  "signal" | "use" | "useCurrentSet"
>;

function domainFor(
  identity: AgentMemoryProjectionContinuationIdentityV1,
): string {
  return identity.kind === "foreground_v1"
    ? FOREGROUND_DOMAIN
    : PROTECTED_TASK_DOMAIN;
}

function snapshotIdentity(
  identity: AgentMemoryProjectionContinuationIdentityV1,
): AgentMemoryProjectionContinuationIdentityV1 {
  return identity.kind === "foreground_v1"
    ? Object.freeze({
        ...identity,
        readableNamespaceIds: Object.freeze([
          ...identity.readableNamespaceIds,
        ]),
        mutableNamespaceIds: Object.freeze([
          ...identity.mutableNamespaceIds,
        ]),
        writableNamespaceIds: Object.freeze([
          ...identity.writableNamespaceIds,
        ]),
      })
    : Object.freeze({ ...identity });
}

function identityAad(
  identity: AgentMemoryProjectionContinuationIdentityV1,
): readonly unknown[] {
  return identity.kind === "foreground_v1"
    ? [
        identity.ownerId,
        identity.actorId,
        identity.agentId,
        identity.roomId,
        [...identity.readableNamespaceIds].sort(),
        [...identity.mutableNamespaceIds].sort(),
        [...identity.writableNamespaceIds].sort(),
        identity.policyRevision,
        identity.agentAuthorizationRevision,
      ]
    : [
        identity.taskId,
        identity.taskRunId,
        identity.graphThreadId,
        identity.subjectUserId,
        identity.humanActorId,
        identity.agentId,
        identity.contentNamespaceId,
        identity.policyRevision,
        identity.agentAuthorizationRevision,
      ];
}

function aad(
  domain: string,
  identity: AgentMemoryProjectionContinuationIdentityV1,
  reference: ProtectedAgentMemoryProjectionReference,
  authority: AgentEntityNamespaceAuthority,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    domain,
    reference.referenceVersion,
    reference.referenceId,
    reference.toolCallId,
    reference.requesterUserId,
    reference.requesterActorId,
    reference.agentId,
    reference.createdAt,
    reference.expiresAt,
    ...identityAad(identity),
    authority.namespaceId,
    authority.namespaceKeyGeneration,
    authority.namespaceAccessRevision,
    authority.domainId,
    authority.domainKeyGeneration,
    authority.domainAuthorizationRevision,
    Array.from(authority.namespaceHeadDigest),
    Array.from(authority.namespaceAudienceFingerprint),
  ]));
}

function parseCell(value: string): Readonly<{
  keyGeneration: number;
  accessRevision: number;
  ciphertext: Uint8Array;
}> | null {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const cell = parsed as Record<string, unknown>;
  if (Object.keys(cell).sort().join(",")
      !== "accessRevision,ciphertext,keyGeneration,version"
    || cell["version"] !== 1
    || !Number.isSafeInteger(cell["keyGeneration"])
    || (cell["keyGeneration"] as number) < 0
    || !Number.isSafeInteger(cell["accessRevision"])
    || (cell["accessRevision"] as number) < 0
    || typeof cell["ciphertext"] !== "string") return null;
  const ciphertext = Buffer.from(cell["ciphertext"], "base64");
  if (ciphertext.toString("base64") !== cell["ciphertext"]) {
    ciphertext.fill(0);
    return null;
  }
  return Object.freeze({
    keyGeneration: cell["keyGeneration"] as number,
    accessRevision: cell["accessRevision"] as number,
    ciphertext,
  });
}

/**
 * Bridge-owned authenticated custody for one protected Memory projection
 * continuation. Callers select a closed product identity; KDF domains, AAD,
 * envelope encoding and key wiping remain inside this owner.
 */
export function createAgentMemoryProjectionContinuationCapsule(input: Readonly<{
  crypto: LatticeCrypto;
  entities: ProjectionEntityInvocation;
  namespaceId: string;
  identity: AgentMemoryProjectionContinuationIdentityV1;
}>): AgentMemoryProjectionContinuationCapsule {
  const identity = snapshotIdentity(input.identity);
  const domain = domainFor(identity);
  const active = () => {
    if (input.entities.signal.aborted) {
      throw new Error("Projection custody unavailable");
    }
  };

  return Object.freeze({
    async seal(reference, value) {
      active();
      const plaintext = new TextEncoder().encode(JSON.stringify(value));
      try {
        const result = await input.entities.useCurrentSet({
          operations: ["encrypt"],
          namespaceIds: [input.namespaceId],
          execute: items => {
            const item = items[0];
            if (items.length !== 1
              || item?.authority.namespaceId !== input.namespaceId) {
              throw new Error(
                "Projection custody unavailable",
              );
            }
            const key = input.crypto.deriveKey(
              item.namespaceKey,
              domain,
              CAPSULE_KEY_BYTES,
            );
            const binding = aad(domain, identity, reference, item.authority);
            try {
              const ciphertext = input.crypto.aeadSeal(key, plaintext, binding);
              try {
                active();
                return JSON.stringify({
                  version: 1,
                  keyGeneration: item.authority.namespaceKeyGeneration,
                  accessRevision: item.authority.namespaceAccessRevision,
                  ciphertext: Buffer.from(ciphertext).toString("base64"),
                });
              } finally {
                ciphertext.fill(0);
              }
            } finally {
              key.fill(0);
              binding.fill(0);
            }
          },
        });
        active();
        if (result.status !== "executed") {
          throw new Error(
            "Projection custody unavailable",
          );
        }
        return result.value;
      } finally {
        plaintext.fill(0);
      }
    },

    async open(reference) {
      let ciphertext: Uint8Array | null = null;
      try {
        active();
        if (typeof reference.sealedPreparation !== "string") return null;
        const cell = parseCell(reference.sealedPreparation);
        if (cell === null) return null;
        ciphertext = cell.ciphertext;
        const result = await input.entities.use({
          operations: ["decrypt"],
          entity: {
            namespaceId: input.namespaceId,
            keyGeneration: cell.keyGeneration,
            accessRevision: cell.accessRevision,
          },
          execute: ({ namespaceKey, authority }) => {
            if (authority.namespaceId !== input.namespaceId
              || authority.namespaceKeyGeneration !== cell.keyGeneration
              || authority.namespaceAccessRevision !== cell.accessRevision) {
              return null;
            }
            const key = input.crypto.deriveKey(
              namespaceKey,
              domain,
              CAPSULE_KEY_BYTES,
            );
            const binding = aad(domain, identity, reference, authority);
            try {
              const plaintext = input.crypto.aeadOpen(
                key,
                cell.ciphertext,
                binding,
              );
              if (plaintext === null) return null;
              try {
                active();
                return JSON.parse(new TextDecoder("utf-8", { fatal: true })
                  .decode(plaintext)) as unknown;
              } finally {
                plaintext.fill(0);
              }
            } finally {
              key.fill(0);
              binding.fill(0);
            }
          },
        });
        active();
        return result.status === "executed" ? result.value : null;
      } catch {
        return null;
      } finally {
        ciphertext?.fill(0);
      }
    },
  });
}
