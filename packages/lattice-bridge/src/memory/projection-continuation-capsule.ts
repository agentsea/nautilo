import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import type {
  ProtectedAgentMemoryProjectionReference,
  ProtectedAgentMemoryAccessApprovalReference,
} from "./active-memory-repository.ts";
import type {
  AgentEntityCryptoInvocation,
  AgentEntityNamespaceAuthority,
} from "../object/agent-entity-crypto.ts";

const FOREGROUND_DOMAIN = "nautilo/foreground-memory-projection/v1";
const PROTECTED_TASK_DOMAIN =
  "nautilo/protected-task-memory-projection/v1";
const PROTECTED_TASK_ACCESS_DOMAIN = "nautilo/protected-task-memory-access/v1";
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

export type ProtectedTaskMemoryAccessContinuationIdentityV1 = Readonly<
  Omit<Extract<AgentMemoryProjectionContinuationIdentityV1,
    { kind: "protected_task_v1" }>, "kind"> & {
    kind: "protected_task_access_v1";
  }
>;

type ContinuationIdentity = AgentMemoryProjectionContinuationIdentityV1
  | ProtectedTaskMemoryAccessContinuationIdentityV1;
type ContinuationReference = ProtectedAgentMemoryProjectionReference
  | ProtectedAgentMemoryAccessApprovalReference;
type ContinuationCapsule<Reference extends ContinuationReference> = Readonly<{
  seal(reference: Reference, value: unknown): Promise<string>;
  open(reference: Reference): Promise<unknown>;
}>;
export type ProtectedTaskMemoryAccessContinuationCapsule =
  ContinuationCapsule<ProtectedAgentMemoryAccessApprovalReference>;

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
  identity: ContinuationIdentity,
): string {
  return identity.kind === "foreground_v1"
    ? FOREGROUND_DOMAIN
    : identity.kind === "protected_task_v1"
      ? PROTECTED_TASK_DOMAIN
      : PROTECTED_TASK_ACCESS_DOMAIN;
}

function snapshotIdentity(
  identity: ContinuationIdentity,
): ContinuationIdentity {
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
  identity: ContinuationIdentity,
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
  identity: ContinuationIdentity,
  reference: ContinuationReference,
  authority: AgentEntityNamespaceAuthority,
): Uint8Array {
  let referenceFields: readonly unknown[];
  if (identity.kind === "protected_task_access_v1") {
    if (!("taskContinuation" in reference)
      || reference.taskContinuation?.kind !== "protected_task_v1") {
      throw new TypeError("Task Memory access custody is unavailable");
    }
    referenceFields = [
      reference.referenceVersion, reference.referenceId, reference.toolCallId,
      reference.requesterUserId, reference.taskContinuation.requesterActorId,
      reference.agentId, reference.taskContinuation.createdAt,
    ];
  } else {
    if (!("requesterActorId" in reference)) {
      throw new TypeError("Projection custody unavailable");
    }
    // Preserve the existing foreground and Task projection wire/AAD order.
    referenceFields = [
      reference.referenceVersion, reference.referenceId, reference.toolCallId,
      reference.requesterUserId, reference.requesterActorId, reference.agentId,
      reference.createdAt, reference.expiresAt,
    ];
  }
  return new TextEncoder().encode(JSON.stringify([
    domain,
    ...referenceFields,
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

function sealedPreparation(
  identity: ContinuationIdentity,
  reference: ContinuationReference,
): string | undefined {
  if (identity.kind === "protected_task_access_v1") {
    return "taskContinuation" in reference
      ? reference.taskContinuation?.sealedPreparation : undefined;
  }
  return "sealedPreparation" in reference ? reference.sealedPreparation : undefined;
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
  return createMemoryContinuationCapsule<ProtectedAgentMemoryProjectionReference>(input);
}

/** Task access custody uses a separate closed KDF/AAD domain and no approval TTL. */
export function createProtectedTaskMemoryAccessContinuationCapsule(input: Readonly<{
  crypto: LatticeCrypto;
  entities: ProjectionEntityInvocation;
  namespaceId: string;
  identity: ProtectedTaskMemoryAccessContinuationIdentityV1;
}>): ProtectedTaskMemoryAccessContinuationCapsule {
  return createMemoryContinuationCapsule<ProtectedAgentMemoryAccessApprovalReference>(input);
}

function createMemoryContinuationCapsule<Reference extends ContinuationReference>(input: Readonly<{
  crypto: LatticeCrypto;
  entities: ProjectionEntityInvocation;
  namespaceId: string;
  identity: ContinuationIdentity;
}>): ContinuationCapsule<Reference> {
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
        const serialized = sealedPreparation(identity, reference);
        if (typeof serialized !== "string") return null;
        const cell = parseCell(serialized);
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
