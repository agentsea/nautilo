import {
  encodeAgentRuntimeSignerPublicationV1,
  verifyHistoricalAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
} from "../agent-runtime/signer-publication-v1.ts";
import type {
  AgentRuntimeRotationStateV2,
} from "../agent-runtime/runtime-rotation-v2.ts";
import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../background/task-runtime-execution-evidence-v1.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  encodeObjectAccessManifestV5,
  verifyObjectAccessManifestV5,
} from "../format/object-access-manifest-v5.ts";
import type {
  ObjectAccessStateCasStatusV2,
} from "../storage/v2-records.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { authorizeObjectAccessWriteV2 } from "./authorized-write.ts";
import {
  ObjectAccessPersistenceOutcomeUnknownV2,
  objectAccessStorageStateV2,
  type ObjectAccessStateCasStorageV2,
} from "./storage-coordinator.ts";
import {
  assertAuthenticPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  assertPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetUsesEvidenceV1,
  cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
  taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1,
  type PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  type TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
} from "./task-runtime-agent-access-manifest-set-v1.ts";

export interface CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1 {
  /** Transaction-bound storage supplied by the current-authority owner. */
  readonly storage: ObjectAccessStateCasStorageV2;
  readonly currentRuntime: AgentRuntimeRotationStateV2;
  readonly signerPublication: AgentRuntimeSignerPublicationV1;
  readonly currentManagerSigningPublicKey: Uint8Array;
}

/**
 * Hold current product and crypto authority around the supplied callback.
 * Returning `null` without invoking `use` means authority is unavailable.
 *
 * This is a trusted transaction-owner boundary. The owner must await `use`,
 * keep every authority lock held until it settles, recheck its own grant expiry
 * before commit, and roll back when `use` rejects. The one-use and lifetime
 * guards detect owner misuse; they cannot roll back a transaction that an owner
 * has already committed or released early.
 */
export type WithCurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1 = (
  context: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
  use: (
    current: CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1,
  ) => Promise<ObjectAccessStateCasStatusV2>,
) => Promise<ObjectAccessStateCasStatusV2 | null>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactFields(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((field) => actual.includes(field));
}

function validStatus(value: unknown): value is ObjectAccessStateCasStatusV2 {
  return value === "applied" || value === "duplicate" || value === "stale";
}

function assertActiveEvidence(
  evidence: TaskRuntimeExecutionEvidenceV1,
  context: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
): void {
  assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
  if (!taskRuntimeAgentObjectAccessGenesisSetAuthorityMatchesEvidenceV1(
    context,
    evidence,
  )) throw new TypeError(
    "Task Runtime Agent object authority disagrees with active evidence",
  );
}

function currentSignerIsExact(
  crypto: LatticeCrypto,
  context: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
  current: CurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1,
): boolean {
  return agentId(current.currentRuntime.agentId) === context.agentId
    && authorizationRevision(current.currentRuntime.authorizationRevision)
      === context.agentAuthorizationRevision
    && agentRuntimeGeneration(current.currentRuntime.runtimeGeneration)
      === context.runtimeGeneration
    && current.signerPublication.agentId === context.agentId
    && current.signerPublication.authorizationRevision
      === context.agentAuthorizationRevision
    && current.signerPublication.runtimeGeneration === context.runtimeGeneration
    && current.signerPublication.signerKeyId === context.signerKeyId
    && current.currentManagerSigningPublicKey instanceof Uint8Array
    && current.currentManagerSigningPublicKey.length
      === V2_LIMITS.signingPublicKeyBytes
    && verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto,
      publication: current.signerPublication,
      resolveHistoricalManagerAuthority: (publicationContext) =>
        publicationContext.managerHumanId
            === current.signerPublication.managerHumanId
          && publicationContext.managerAuthorizationRevision
            === current.signerPublication.managerAuthorizationRevision
          && publicationContext.managerDeviceId
            === current.signerPublication.managerDeviceId
          ? current.currentManagerSigningPublicKey
          : null,
    });
}

function manifestUsesCurrentSigner(
  crypto: LatticeCrypto,
  context: TaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1,
  prepared: PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1,
  signerPublication: AgentRuntimeSignerPublicationV1,
): boolean {
  try {
    verifyObjectAccessManifestV5(crypto, {
      manifestBytes: prepared.manifestBytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: (principal) =>
        principal.agentId === context.agentId
          && principal.runtimeGeneration === context.runtimeGeneration
          && principal.signerKeyId === context.signerKeyId
          ? signerPublication.signerPublicKey
          : null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist one native V5 Agent object while the server owner holds the exact
 * Task, grant, Namespace, Runtime, and signer authority around `use`.
 */
export async function persistPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly prepared:
      PreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1;
    readonly evidence: TaskRuntimeExecutionEvidenceV1;
    readonly withCurrentAuthorization:
      WithCurrentTaskRuntimeAgentObjectAccessGenesisSetAuthorizationV1;
  }>,
): Promise<ObjectAccessStateCasStatusV2> {
  assertAuthenticPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetV1(
    input.prepared,
  );
  assertPreparedTaskRuntimeAgentObjectAccessManifestGenesisSetUsesEvidenceV1(
    input.prepared,
    input.evidence,
  );
  if (typeof input.withCurrentAuthorization !== "function") {
    throw new TypeError(
      "Current Task Runtime Agent set authorization owner is required",
    );
  }
  const context =
    cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1(
      input.prepared.authority,
    );
  assertActiveEvidence(input.evidence, context);
  const intended = objectAccessStorageStateV2(
    input.crypto,
    input.prepared.manifestBytes,
    input.prepared.envelopeBytes,
  );
  if (
    !equalBytes(
      encodeObjectAccessManifestV5(input.prepared.manifest),
      input.prepared.manifestBytes,
    )
    || !equalBytes(input.prepared.manifestHash, intended.head.manifestHash)
  ) throw new Error(
    "prepared Task Runtime Agent set does not match its canonical manifest",
  );

  let providerOpen = true;
  let useCalls = 0;
  let completedResult: ObjectAccessStateCasStatusV2 | null = null;
  let providerResult: ObjectAccessStateCasStatusV2 | null;
  try {
    providerResult = await input.withCurrentAuthorization(
      cloneTaskRuntimeAgentObjectAccessGenesisSetAuthorityContextV1(context),
      async current => {
        useCalls += 1;
        if (useCalls !== 1 || !providerOpen) {
          throw new TypeError(
            "Current Task Runtime Agent authorization callback is one-use",
          );
        }
        const stale = (): ObjectAccessStateCasStatusV2 => {
          completedResult = "stale";
          return completedResult;
        };
        if (
          !exactFields(current, [
            "storage",
            "currentRuntime",
            "signerPublication",
            "currentManagerSigningPublicKey",
          ])
          || typeof current.storage?.getObject !== "function"
          || typeof current.storage?.compareAndSwapObjectAccessState
            !== "function"
        ) return stale();

        assertActiveEvidence(input.evidence, context);
        const persistedObject = await current.storage.getObject(
          context.objectId,
        );
        if (!providerOpen) {
          throw new TypeError(
            "Current Task Runtime Agent authorization callback escaped its owner",
          );
        }
        assertActiveEvidence(input.evidence, context);
        if (persistedObject === null) return stale();
        const payloadHash = input.crypto.hash(persistedObject.payloadBytes);
        const payloadMatches = equalBytes(payloadHash, context.payloadHash);
        payloadHash.fill(0);
        if (
          !payloadMatches
          || !currentSignerIsExact(input.crypto, context, current)
          || !manifestUsesCurrentSigner(
            input.crypto,
            context,
            input.prepared,
            current.signerPublication,
          )
        ) return stale();

        let publicationBytes: Uint8Array | null = null;
        try {
          assertActiveEvidence(input.evidence, context);
          publicationBytes = encodeAgentRuntimeSignerPublicationV1(
            current.signerPublication,
          );
          const status = await current.storage.compareAndSwapObjectAccessState(
            authorizeObjectAccessWriteV2({
              expected: null,
              intended,
              authorization: {
                kind: "task-runtime-agent-genesis-set",
                context,
                signerPublication: current.signerPublication,
                signerPublicationHash: input.crypto.hash(publicationBytes),
                signerPublicKeyHash: input.crypto.hash(
                  current.signerPublication.signerPublicKey,
                ),
                managerSigningPublicKeyHash: input.crypto.hash(
                  current.currentManagerSigningPublicKey,
                ),
              },
            }),
          );
          if (!providerOpen) {
            throw new TypeError(
              "Current Task Runtime Agent authorization callback escaped its owner",
            );
          }
          // This runs before `use` returns, while the authority owner's
          // transaction is still open and can roll back an expired write.
          assertActiveEvidence(input.evidence, context);
          if (!validStatus(status)) {
            throw new TypeError(
              "object access storage returned an invalid status",
            );
          }
          completedResult = status;
          return status;
        } catch (cause) {
          throw new ObjectAccessPersistenceOutcomeUnknownV2(cause);
        } finally {
          publicationBytes?.fill(0);
        }
      },
    );
  } finally {
    providerOpen = false;
  }

  assertActiveEvidence(input.evidence, context);
  if (useCalls === 0 && providerResult === null) return "stale";
  if (
    useCalls !== 1
    || completedResult === null
    || providerResult !== completedResult
  ) throw new TypeError(
    "Current Task Runtime Agent authorization owner returned a manufactured result",
  );
  return completedResult;
}
