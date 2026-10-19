import { PROTECTED_TASK_CANCELLED_RESULT,
  type PostgresJsBridgeConnection } from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  encodeMessagePayloadV2,
  withProtectedTaskTerminalMessageSigner,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import {
  PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage,
  stageNativeTaskTerminalMessagePublication,
  verifyCryptoPostgresHandle,
  withNativeTaskTerminalMessageNamespaceSource,
  type CurrentTaskRuntimeAuthority,
  type NativeTaskTerminalMessageAuthority,
  type NativeTaskTerminalMessageCurrentAuthority,
  type NativeTaskTerminalMessageIntent as NativeCryptoIntent,
} from "@nautilo/lattice-bridge/server";
import {
  assertAuthenticTaskRuntimeTerminalMessageEvidence,
  hasTaskRuntimeTemporarySigner,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type TaskRuntimeTerminalMessageEvidence,
} from "@nautilo/lattice-crypto";
import {
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { ProtectedTaskTerminalMessageAuthorityPort } from
  "./protected-task-terminal-message-authority";
import { lockExactProtectedTaskTerminalMessageAllocation } from
  "./protected-task-terminal-message-allocation";
import type { ProtectedTaskTerminalMessagePlan } from
  "./protected-task-terminal-message-plan";
import { withProtectedTaskResultSignerHistory } from
  "./protected-task-result-signer-history";
import {
  acceptedTaskRuntimeRecord,
  destroyAcceptedTaskRuntimeRecord,
} from "./task-runtime-current-authority";

export type ProtectedTaskTerminalMessagePublication = (input: Readonly<{
  plan: ProtectedTaskTerminalMessagePlan;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  domains: readonly DomainForegroundSecretEntry[];
  evidence: TaskRuntimeTerminalMessageEvidence;
  signal: AbortSignal;
  assertCurrentClaim(): void | Promise<void>;
}>) => Promise<void>;

type StageInput = Readonly<{
  plan: ProtectedTaskTerminalMessagePlan;
  current: CurrentTaskRuntimeAuthority;
  restricted: PostgresJsBridgeConnection;
  domains: readonly DomainForegroundSecretEntry[];
  evidence: TaskRuntimeTerminalMessageEvidence;
  signal: AbortSignal;
  assertCurrentClaim(): void | Promise<void>;
  assertCurrentTaskAuthority(): Promise<void>;
}>;

export type ProtectedTaskTerminalMessageRecoveryPort = (
  plan: ProtectedTaskTerminalMessagePlan,
) => Promise<"mapped" | "pending">;

export type ProtectedTaskTerminalMessagePublicationDependencies = Readonly<{
  stage(input: StageInput): Promise<"staged" | "already_staged">;
  verifyAllocation(
    transaction: CanonicalTranscriptTx,
    plan: ProtectedTaskTerminalMessagePlan,
  ): Promise<boolean>;
}>;

function unavailable(message: string): never {
  throw new ClassifiedDataOperationError("authority", message);
}

function reconciliationRequired(): never {
  throw new ClassifiedDataOperationError(
    "stale",
    "Terminal Task Message requires publication reconciliation",
  );
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) wipe(child);
  }
}

function currentDeliveryAuthority(
  intent: NativeCryptoIntent,
  current: CurrentTaskRuntimeAuthority,
): NativeTaskTerminalMessageCurrentAuthority | null {
  const namespace = current.namespaceRequirements[0];
  if (current.namespaceRequirements.length !== 1 || namespace === undefined
    || namespace.namespaceId !== intent.namespaceId
    || namespace.domainId !== intent.domainId
    || namespace.operations.length !== 1
    || namespace.operations[0] !== "encrypt"
    || namespace.expectedPolicyRevision !== intent.publicationPolicyRevision
    || current.policyRevision < intent.publicationPolicyRevision) return null;
  return Object.freeze({
    taskId: intent.taskId,
    taskRunId: intent.taskRunId,
    bindingId: intent.bindingId,
    messageOperationId: intent.messageOperationId,
    sessionId: intent.sessionId,
    messageId: intent.messageId,
    revision: intent.revision,
    objectId: intent.objectId,
    roomId: intent.roomId,
    namespaceId: intent.namespaceId,
    domainId: intent.domainId,
    mode: intent.mode,
    acceptedPolicyRevision: intent.acceptedPolicyRevision,
    currentPolicyRevision: current.policyRevision,
    namespaceAccessRevision: namespace.expectedAccessRevision,
  });
}

function authorityMatchesPlan(
  authority: NativeTaskTerminalMessageAuthority,
  plan: ProtectedTaskTerminalMessagePlan,
  evidence: TaskRuntimeTerminalMessageEvidence,
  current: CurrentTaskRuntimeAuthority,
): boolean {
  const message = evidence.message;
  const delivery = currentDeliveryAuthority(
    Object.freeze({
      taskId: authority.taskId, taskRunId: authority.taskRunId,
      bindingId: authority.bindingId,
      messageOperationId: authority.messageOperationId,
      sessionId: authority.sessionId, messageId: authority.messageId,
      revision: authority.revision, objectId: authority.objectId,
      roomId: authority.roomId, namespaceId: authority.namespaceId,
      domainId: authority.domainId, mode: authority.mode,
      acceptedPolicyRevision: authority.acceptedPolicyRevision,
      publicationPolicyRevision: authority.publicationPolicyRevision,
      signerAgentId: authority.signerAgentId,
      payloadDigest: authority.payloadDigest, role: authority.role,
      createdAt: authority.createdAt, requestId: authority.requestId,
    }),
    current,
  );
  return delivery !== null
    && authority.taskId === plan.intent.taskId
    && authority.taskRunId === plan.intent.taskRunId
    && authority.bindingId === plan.intent.bindingId
    && authority.messageOperationId === plan.intent.messageOperationId
    && authority.sessionId === plan.allocation.sessionId
    && authority.messageId === plan.allocation.messageId
    && authority.revision === plan.allocation.revision
    && authority.objectId === plan.allocation.objectId
    && authority.roomId === plan.intent.destinationRoomId
    && authority.namespaceId === plan.intent.destinationNamespaceId
    && authority.domainId === message.domainId
    && authority.mode === (plan.intent.representation === "protected"
      ? "encrypted_only" : "shadow_encryption")
    && authority.acceptedPolicyRevision === plan.intent.acceptedPolicyRevision
    && authority.publicationPolicyRevision === plan.publicationPolicyRevision
    && authority.signerAgentId === plan.intent.agentId
    && authority.role === "assistant"
    && authority.createdAt === plan.allocation.createdAt
    && authority.requestId === evidence.requestId
    && authority.claimId === evidence.claimId
    && authority.recipientGeneration === evidence.recipientGeneration
    && authority.namespaceAccessRevision === delivery.namespaceAccessRevision;
}

/** Stage immutable terminal Message bytes, then delegate product reconciliation. */
export function createProtectedTaskTerminalMessagePublication(
  input: Readonly<{
    restricted: PostgresJsBridgeConnection;
    crypto: LatticeCrypto;
    owner: EncryptionDataOperationOwner;
    serverScope: string;
    authority: ProtectedTaskTerminalMessageAuthorityPort;
    recover: ProtectedTaskTerminalMessageRecoveryPort;
  }>,
  overrides: Partial<ProtectedTaskTerminalMessagePublicationDependencies> = {},
): ProtectedTaskTerminalMessagePublication {
  const stage = overrides.stage ?? (async (value: StageInput) => {
    const handle = await verifyCryptoPostgresHandle(value.restricted);
    const storage = new PostgresLatticeStorage(handle);
    const signerHistory = new PostgresHumanDeviceSignerHistory({
      handle,
      crypto: input.crypto,
    });
    const domain = value.domains[0];
    if (value.domains.length !== 1 || domain === undefined
      || domain.domainId !== value.evidence.message.domainId
      || domain.keyClass !== "ai") {
      return unavailable("Terminal Task Message Domain is unavailable");
    }
    const publish = async (
      history: Parameters<Parameters<
        typeof withProtectedTaskResultSignerHistory
      >[0]["use"]>[0],
      agentAuthorizationRevision: number,
    ) => {
        const signed = await withProtectedTaskTerminalMessageSigner({
          crypto: input.crypto,
          storage,
          evidence: value.evidence,
          domain,
          expectedAgentAuthorizationRevision: agentAuthorizationRevision,
          resolveHistoricalRuntimeCommitter:
            history.resolveHistoricalRuntimeCommitter,
          resolveHistoricalSignerPublicationManager:
            history.resolveHistoricalSignerPublicationManager,
          execute: signer => withNativeTaskTerminalMessageNamespaceSource({
            restricted: value.restricted,
            crypto: input.crypto,
            serverScope: input.serverScope,
            evidence: value.evidence,
            domains: value.domains,
            signal: value.signal,
            assertCurrentTaskAuthority: value.assertCurrentTaskAuthority,
          }, namespace => stageNativeTaskTerminalMessagePublication({
            restricted: value.restricted,
            resolveHistoricalAgentSignerAuthority:
              signerHistory.resolveAgentRuntimeSignerManager,
            assertCurrentClaim: value.assertCurrentClaim,
            resolveCurrentDeliveryAuthority: async expected => {
              await value.assertCurrentTaskAuthority();
              const actual = currentDeliveryAuthority(expected, value.current);
              return actual !== null ? actual : null;
            },
            preparation: {
              crypto: input.crypto,
              evidence: value.evidence,
              payload: {
                role: "assistant",
                content: PROTECTED_TASK_CANCELLED_RESULT,
              },
              createdAt: value.plan.allocation.createdAt,
              namespace,
              runtime: signer.runtime,
              signerPublication: signer.signerPublication,
              ...(signer.temporarySigner === undefined ? {} : {
                temporarySigner: signer.temporarySigner,
              }),
              agentAuthorizationRevision: signer.agentAuthorizationRevision,
              resolveHistoricalSignerPublicationManager:
                history.resolveHistoricalSignerPublicationManager,
              signal: value.signal,
              resolveCurrentAuthority: async expected => {
                await value.assertCurrentTaskAuthority();
                return authorityMatchesPlan(
                  expected, value.plan, value.evidence, value.current,
                ) ? Object.freeze({ ...expected }) : null;
              },
            },
          })),
        });
        if (signed.status !== "executed") {
          return unavailable("Terminal Task Message signer is unavailable");
        }
        return signed.value;
    };
    if (hasTaskRuntimeTemporarySigner(value.evidence)) {
      return publish({
        resolveHistoricalRuntimeCommitter: () => null,
        resolveHistoricalSignerPublicationManager: () => null,
      }, 0);
    }
    const state = await storage.getAgentRuntimeAtomicState(
      value.plan.intent.agentId,
    );
    let agentAuthorizationRevision: number;
    let runtimeGeneration: number;
    try {
      if (state === null
        || state.runtime.agentId !== value.plan.intent.agentId) {
        return unavailable("Terminal Task Message Runtime is unavailable");
      }
      agentAuthorizationRevision = state.runtime.authorizationRevision;
      runtimeGeneration = state.runtime.runtimeGeneration;
    } finally {
      wipe(state);
    }
    return withProtectedTaskResultSignerHistory({
      handle,
      crypto: input.crypto,
      agentId: value.plan.intent.agentId,
      domainId: domain.domainId,
      domainEpoch: domain.domainKeyGeneration,
      expectedAgentAuthorizationRevision: agentAuthorizationRevision,
      expectedRuntimeGeneration: runtimeGeneration,
      use: history => publish(history, agentAuthorizationRevision),
    });
  });
  const verifyAllocation = overrides.verifyAllocation ?? (async (
    transaction: CanonicalTranscriptTx,
    plan: ProtectedTaskTerminalMessagePlan,
  ) => {
    const encoded = encodeMessagePayloadV2({
      role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
    });
    const digest = input.crypto.hash(encoded);
    try {
      return await lockExactProtectedTaskTerminalMessageAllocation({
        transaction, intent: plan.intent,
        sessionId: plan.allocation.sessionId,
        expectedPayloadDigest: digest,
        phase: "pristine",
        expected: {
          messageId: plan.allocation.messageId,
          revision: plan.allocation.revision,
          objectId: plan.allocation.objectId,
          createdAt: plan.allocation.createdAt,
          publicationPolicyRevision: plan.publicationPolicyRevision,
        },
      }) !== null;
    } finally {
      encoded.fill(0);
      digest.fill(0);
    }
  });

  return async publication => {
    const plan = publication.plan;
    const intent = plan.intent;
    const { evidence, signal } = publication;
    const record = parseBackgroundAuthorizationRecord(publication.record);
    const assertLive = async (): Promise<void> => {
      signal.throwIfAborted();
      assertAuthenticTaskRuntimeTerminalMessageEvidence(evidence);
      await publication.assertCurrentClaim();
      signal.throwIfAborted();
      assertAuthenticTaskRuntimeTerminalMessageEvidence(evidence);
    };
    await assertLive();
    if (record.snapshot.formatVersion !== 3
      || record.snapshot.credentialSubject.kind !== "runtime"
      || record.snapshot.credentialSubject.runtimeKind !== "task"
      || record.snapshot.credentialSubject.runtimeVersion !== 1
      || record.workKind !== "task.deliver_message"
      || record.purpose !== "task.deliver_message") {
      return unavailable("Terminal Task Message record is unavailable");
    }
    const accepted = acceptedTaskRuntimeRecord(
      record as BackgroundAuthorizationTaskRuntimeRecordV3,
    );
    if (accepted === null) {
      return unavailable("Terminal Task Message grant is unavailable");
    }
    const encodedPayload = encodeMessagePayloadV2({
      role: "assistant",
      content: PROTECTED_TASK_CANCELLED_RESULT,
    });
    const payloadDigest = input.crypto.hash(encodedPayload);
    try {
      const message = evidence.message;
      const mode = intent.representation === "protected"
        ? "encrypted_only" : "shadow_encryption";
      if (record.snapshot.state !== "running"
        || record.snapshot.requestId !== plan.initialRecord.snapshot.requestId
        || record.snapshot.workId !== intent.taskRunId
        || record.snapshot.claimId !== evidence.claimId
        || record.snapshot.recipientGeneration !== evidence.recipientGeneration
        || record.expectedPolicyRevision !== plan.publicationPolicyRevision
        || evidence.requestId !== record.snapshot.requestId
        || evidence.workId !== intent.taskRunId
        || evidence.policyRevision !== plan.publicationPolicyRevision
        || evidence.sourceRoomId !== intent.destinationRoomId
        || message.taskId !== intent.taskId
        || message.taskRunId !== intent.taskRunId
        || message.bindingId !== intent.bindingId
        || message.messageOperationId !== intent.messageOperationId
        || message.sessionId !== plan.allocation.sessionId
        || message.messageId !== plan.allocation.messageId
        || message.revision !== plan.allocation.revision
        || message.objectId !== plan.allocation.objectId
        || message.roomId !== intent.destinationRoomId
        || message.namespaceId !== intent.destinationNamespaceId
        || message.mode !== mode
        || message.acceptedPolicyRevision !== intent.acceptedPolicyRevision
        || message.publicationPolicyRevision !== plan.publicationPolicyRevision
        || message.signerAgentId !== intent.agentId
        || !equal(message.payloadDigest, payloadDigest)) {
        return unavailable("Terminal Task Message proof disagrees");
      }
      const subject = Object.freeze({
        userId: intent.requesterUserId,
        humanActorId: accepted.issuingHumanId,
        deviceId: accepted.issuingDeviceId,
      });
      const publish = async (representation: "protected" | "dual") => {
        if (representation !== intent.representation) {
          return unavailable("Terminal Task Message representation changed");
        }
        const staged = await input.authority.withAccepted({
          intent,
          publicationPolicyRevision: plan.publicationPolicyRevision,
          subject,
          accepted,
          signal,
          restricted: input.restricted,
          validateBeforeCommit: assertLive,
          use: async (current, _product, restricted, transaction) => {
            if (!await verifyAllocation(transaction, plan)) {
              return unavailable("Terminal Task Message allocation changed");
            }
            const staged = await stage({
              plan, current, restricted,
              domains: publication.domains,
              evidence, signal,
              assertCurrentClaim: publication.assertCurrentClaim,
              assertCurrentTaskAuthority: assertLive,
            });
            if (!await verifyAllocation(transaction, plan)) {
              return unavailable(
                "Terminal Task Message allocation changed after staging",
              );
            }
            return staged;
          },
        });
        if (staged === null) {
          return unavailable("Terminal Task Message authority is unavailable");
        }
        if (await input.recover(plan) !== "mapped") reconciliationRequired();
      };
      await input.owner.runMutation({
        protected: () => publish("protected"),
        dual: () => publish("dual"),
      });
    } finally {
      encodedPayload.fill(0);
      payloadDigest.fill(0);
      destroyAcceptedTaskRuntimeRecord(accepted);
    }
  };
}
