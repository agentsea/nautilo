import {
  accessRevision,
  agentRuntimeSignerPublicationMatchesRuntime,
  authorizationRevision,
  createCommonAgentObjectAccessManifest,
  createTaskRuntimeCommonObjectAccessManifest,
  deriveAgentRuntimeObjectSignerPublic,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  verifyHistoricalAgentRuntimeSignerPublication,
  withOpenedDomainNamespaceBundle,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type ResolveHistoricalAgentRuntimeSignerPublicationManager,
  type TaskRuntimeTemporarySigner,
} from "@nautilo/lattice-crypto";
import {
  agentRuntimeObjectSignerKeyIdV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import { CONVERSATION_MESSAGE_OBJECT_TYPE } from
  "../../message/conversation-repository.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type { NativeTaskNamespaceSource } from
  "./native-task-message-preparation.ts";

export type NativeTaskAssistantMessageEncryptionResult = Readonly<{
  object: ReturnType<typeof encryptedObjectWriteRecord>;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly [Uint8Array];
  signerEvidenceBytes?: Uint8Array;
}>;

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** Shared native encryption core. Product authority stays with each caller. */
export async function encryptNativeTaskAssistantMessage(input: Readonly<{
  crypto: LatticeCrypto;
  payload: MessagePayloadV2;
  expectedPayloadDigest: Uint8Array;
  objectId: string;
  createdAt: number;
  namespaceId: string;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  namespace: NativeTaskNamespaceSource;
  signerAgentId: string;
  runtime: AgentRuntimeKeyGeneration;
  signerPublication: AgentRuntimeSignerPublication | null;
  temporarySigner?: TaskRuntimeTemporarySigner;
  agentAuthorizationRevision: number;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManager;
  assertActive(): void;
}>): Promise<NativeTaskAssistantMessageEncryptionResult> {
  input.assertActive();
  const plaintext = encodeMessagePayloadV2(input.payload);
  const payloadDigest = input.crypto.hash(plaintext);
  const owned: Uint8Array[] = [plaintext, payloadDigest];
  const copy = (bytes: Uint8Array): Uint8Array => {
    const result = bytes.slice();
    owned.push(result);
    return result;
  };
  try {
    const temporary = input.temporarySigner;
    if ((input.signerPublication === null) === (temporary === undefined)) {
      throw new TypeError("Native Task assistant Message requires one signer authority");
    }
    const derivedTemporary = temporary === undefined
      ? null : deriveAgentRuntimeObjectSignerPublic(input.crypto, input.runtime);
    if (derivedTemporary !== null) owned.push(derivedTemporary.publicKey);
    const signerKeyId = temporary === undefined
      ? input.signerPublication!.signerKeyId
      : agentRuntimeObjectSignerKeyIdV1(input.crypto, temporary.signerPublicKey);
    if (input.payload.role !== "assistant"
      || !equal(payloadDigest, input.expectedPayloadDigest)
      || input.namespace.current.namespaceId !== input.namespaceId
      || input.namespace.current.namespaceAccessRevision
        !== input.namespaceAccessRevision
      || input.namespace.current.namespaceCurrentGeneration
        !== input.namespaceKeyGeneration
      || input.namespace.current.keyClass !== "ai"
      || input.runtime.agentId !== input.signerAgentId
      || (temporary === undefined
        ? input.signerPublication!.agentId !== input.signerAgentId
          || input.signerPublication!.authorizationRevision
            !== authorizationRevision(input.agentAuthorizationRevision)
          || !agentRuntimeSignerPublicationMatchesRuntime(
            input.crypto, input.runtime, input.signerPublication!)
          || !verifyHistoricalAgentRuntimeSignerPublication({
            crypto: input.crypto,
            publication: input.signerPublication!,
            resolveHistoricalManagerAuthority:
              input.resolveHistoricalSignerPublicationManager,
          })
        : input.agentAuthorizationRevision !== 0
          || temporary.runtime.agentId !== input.runtime.agentId
          || temporary.runtime.generation !== input.runtime.generation
          || !equal(temporary.runtime.key, input.runtime.key)
          || derivedTemporary === null
          || derivedTemporary.principal.signerKeyId !== signerKeyId
          || !equal(derivedTemporary.publicKey, temporary.signerPublicKey))) {
      throw new TypeError("Native Task assistant Message authority disagrees");
    }
    const runtime = Object.freeze({
      ...input.runtime,
      key: temporary === undefined ? copy(input.runtime.key) : input.runtime.key,
    });
    const certified = temporary === undefined ? undefined : Object.freeze({
      certificateBytes: copy(temporary.certificateBytes),
      issuerSigningPublicKey: copy(temporary.issuerSigningPublicKey),
      requestHash: copy(temporary.requestHash),
      authorizationHash: copy(temporary.authorizationHash),
      securityRevision: temporary.issuer.securityRevision,
    });
    const source = input.namespace;
    const namespace: NativeTaskNamespaceSource = {
      bindingBytes: copy(source.bindingBytes),
      expectedBindingDigest: copy(source.expectedBindingDigest),
      issuerSigningPublicKey: copy(source.issuerSigningPublicKey),
      domainKey: copy(source.domainKey),
      current: {
        ...source.current,
        participantDigest: copy(source.current.participantDigest),
        domainHeadDigest: copy(source.current.domainHeadDigest),
        retainedAuthoritySetDigest:
          copy(source.current.retainedAuthoritySetDigest),
      },
    };
    input.assertActive();
    const opened = await withOpenedDomainNamespaceBundle(input.crypto, {
      ...namespace,
      operation: retained => {
        input.assertActive();
        const keys = retained.filter(entry =>
          entry.generation === input.namespaceKeyGeneration
          && entry.accessRevision === input.namespaceAccessRevision);
        if (keys.length !== 1) {
          throw new TypeError(
            "Native Task assistant Message Namespace generation is unavailable",
          );
        }
        const encrypted = encryptObjectPayload(input.crypto, {
          objectId: objectId(input.objectId),
          keyClass: "ai",
          objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
          createdAt: unixTimestamp(input.createdAt),
        }, plaintext);
        try {
          const envelope = wrapObjectDekForNamespace(
            input.crypto,
            keys[0]!.generationKey,
            {
              objectId: objectId(input.objectId),
              namespaceId: namespaceId(input.namespaceId),
              keyClass: "ai",
              keyGeneration: namespaceGeneration(input.namespaceKeyGeneration),
              bindingRevisionAtWrap:
                accessRevision(input.namespaceAccessRevision),
            },
            encrypted.dek,
          );
          try {
            const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
            const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
            const unsigned = {
              objectId: objectId(input.objectId),
              payloadHash: input.crypto.hash(payloadBytes),
              accessRevision: accessRevision(0),
              previousManifestHash: null,
              envelopeHashes: [input.crypto.hash(envelopeBytes)],
              signer: {
                kind: "agent_runtime" as const,
                agentId: runtime.agentId,
                runtimeGeneration: runtime.generation,
                signerKeyId,
              },
              signerAuthorizationHash: certified === undefined
                ? null : input.crypto.hash(certified.certificateBytes),
              hostAuthorizationRevision:
                authorizationRevision(certified === undefined
                  ? input.agentAuthorizationRevision
                  : certified.securityRevision),
            };
            const genesis = certified === undefined
              ? createCommonAgentObjectAccessManifest(input.crypto, unsigned, runtime)
              : createTaskRuntimeCommonObjectAccessManifest(input.crypto, unsigned, {
                runtime,
                certificateBytes: certified.certificateBytes,
                issuerSigningPublicKey: certified.issuerSigningPublicKey,
                expectedRequestHash: certified.requestHash,
                expectedAuthorizationHash: certified.authorizationHash,
                now: input.crypto.clock.now(),
              });
            return Object.freeze({
              object: encryptedObjectWriteRecord(payloadBytes),
              manifestBytes: genesis.bytes,
              manifestHash: genesis.hash,
              envelopeBytes: Object.freeze([envelopeBytes] as const),
              ...(certified === undefined ? {} : {
                signerEvidenceBytes: certified.certificateBytes.slice(),
              }),
            });
          } finally {
            envelope.wrappedDek.fill(0);
          }
        } finally {
          encrypted.dek.fill(0);
          encrypted.payload.ciphertext.fill(0);
        }
      },
    });
    input.assertActive();
    if (opened.status !== "opened") {
      throw new TypeError(
        "Native Task assistant Message Namespace bundle is unavailable",
      );
    }
    return opened.value;
  } finally {
    for (const bytes of owned) bytes.fill(0);
  }
}
