import type { AgentRuntimeKeyGeneration, LatticeCrypto } from "@nautilo/lattice-crypto";
import type { ForegroundAgentEntityCryptoInvocation } from "../../object/foreground-agent-entity-crypto.ts";
import { prepareDeviceWrappedAgentObject } from "../../object/device-wrapped-agent-object-crypto.ts";
import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import { createPreparedForegroundTaskDefinitionCryptoRevisionV1 } from "../../task/task-content-prepared-revision.ts";
import { deriveTaskContentCryptoObjectIdV1, taskContentObjectTypeV1,
  type PreparedTaskContentCryptoRevisionV1 } from "../../task/task-content-repository.ts";
import { encodeTaskDefinitionContent, type TaskDefinitionContent } from "../../task/task-payload-v1.ts";

export type PrepareNativeTaskDefinitionCryptoRevisionInput = Readonly<{
  crypto: LatticeCrypto;
  taskId: string;
  /** Defaults to the creation revision so existing callers retain identical bytes. */
  contentRevision?: number;
  payload: TaskDefinitionContent;
  createdAt: number;
  authority: TaskContentAuthorityV1;
  entities: ForegroundAgentEntityCryptoInvocation;
  publication: Readonly<{
    operationId: string;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    runtime: AgentRuntimeKeyGeneration;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
    agentAuthorizationRevision: number;
    policyRevision: number;
    taskDefinitionForegroundAuthorizationBytes?: Uint8Array | undefined;
  }>;
}>;

/**
 * One native definition under an already admitted foreground Namespace. The
 * caller owns genuine Agent-turn admission; completion independently validates
 * the actual device-wrapped foreground grant before persisting these bytes.
 */
export async function prepareNativeTaskDefinitionCryptoRevision(
  input: PrepareNativeTaskDefinitionCryptoRevisionInput,
): Promise<PreparedTaskContentCryptoRevisionV1 | null> {
  input.entities.signal.throwIfAborted();
  if (input.publication.policyRevision !== input.authority.expectedPolicyRevision) {
    throw new TypeError("Foreground Task publication policy changed");
  }
  const contentRevision = input.contentRevision ?? 1;
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 1) {
    throw new TypeError("Foreground Task definition revision is invalid");
  }
  const coordinate = Object.freeze({ kind: "definition" as const,
    taskId: input.taskId, contentRevision });
  const authority = Object.freeze({ ...input.authority });
  const objectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  const plaintext = encodeTaskDefinitionContent(input.payload);
  try {
    const result = await input.entities.useCurrentSet({
      operations: ["encrypt"], namespaceIds: [authority.namespaceId],
      execute: items => {
        input.entities.signal.throwIfAborted();
        const item = items[0];
        if (items.length !== 1 || item === undefined
          || item.authority.namespaceId !== authority.namespaceId
          || item.authority.domainId !== authority.domainId
          || item.authority.namespaceAccessRevision !== authority.expectedAccessRevision) {
          throw new TypeError("Foreground Task private Namespace authority changed");
        }
        const current = item.authority;
        const prepared = prepareDeviceWrappedAgentObject({
          crypto: input.crypto, objectId, objectType: taskContentObjectTypeV1(coordinate),
          plaintextBytes: plaintext, createdAt: input.createdAt,
          namespaceSet: [{ namespaceId: current.namespaceId,
            accessRevision: current.namespaceAccessRevision,
            keyGeneration: current.namespaceKeyGeneration, domainId: current.domainId,
            domainKeyGeneration: current.domainKeyGeneration,
            domainAuthorizationRevision: current.domainAuthorizationRevision,
            domainHeadDigest: current.domainHeadDigest, headDigest: current.namespaceHeadDigest,
            publicationDigest: current.namespacePublicationDigest,
            publicationSetDigest: current.namespacePublicationSetDigest,
            audienceFingerprint: current.namespaceAudienceFingerprint, key: item.namespaceKey }],
          operationId: input.publication.operationId,
          grant: { grantId: input.publication.grantId,
            grantHash: input.publication.grantDigest,
            recipientKeyId: input.publication.recipientKeyId },
          runtime: input.publication.runtime, signerKeyId: input.publication.signerKeyId,
          signerPublicKey: input.publication.signerPublicKey,
          agentAuthorizationRevision: input.publication.agentAuthorizationRevision,
          ...(input.publication.taskDefinitionForegroundAuthorizationBytes === undefined
            ? {} : { taskDefinitionForegroundAuthorizationBytes:
              input.publication.taskDefinitionForegroundAuthorizationBytes }),
        });
        return createPreparedForegroundTaskDefinitionCryptoRevisionV1({ coordinate, authority, prepared });
      },
    });
    input.entities.signal.throwIfAborted();
    return result.status === "executed" ? result.value : null;
  } finally { plaintext.fill(0); }
}
