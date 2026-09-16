import {
  persistPreparedAgentObjectAccessManifestGenesis,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  persistPreparedObjectAccessManifestGenesis,
  verifyAgentObjectAccessManifest,
  type LatticeCrypto,
  type LatticeStorage,
  type ObjectAccessGenesisEnvelopeAuthorizationContext,
  type ResolveCurrentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV2,
  decodeObjectAccessManifestV2OrV3,
  objectAccessManifestSigningBytesV2,
} from "@nautilo/lattice-crypto/wire";
import {
  readPreparedConversationCryptoRevisionSnapshot,
  type PreparedConversationCryptoRevisionSnapshot,
} from "../../message/conversation-prepared-revision.ts";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
  type AtomicConversationCryptoCompletionPort,
  type ConversationMessageKeyClass,
  type PreparedConversationCryptoRevision,
  type VerifiedConversationCryptoRevision,
} from "../../message/conversation-repository.ts";
import {
  AgentRuntimeSignerHistoryInvalidError,
  authenticateHistoricalAgentRuntimeSignerPublication,
  type ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "./agent-runtime-signer-history.ts";
import {
  PostgresLatticeStorage,
  assertVerifiedCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "./postgres-lattice-storage.ts";

const DIFFERENT_OBJECT_PAYLOAD =
  "Encrypted object is already initialized with different payload bytes";

export interface HistoricalHumanObjectAccessGenesisSignerContext {
  readonly purpose: "verify-historical-human-object-access-genesis";
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly envelopes:
    readonly ObjectAccessGenesisEnvelopeAuthorizationContext[];
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
}

export interface HistoricalHumanObjectAccessGenesisSignerAuthority
  extends HistoricalHumanObjectAccessGenesisSignerContext {
  readonly committerSigningPublicKey: Uint8Array;
}

/**
 * Resolve a Human-v2 manifest signer from authenticated historical authority.
 * Later revocation or authorization changes must not remove a key that was
 * valid for the revision carried by an already committed manifest.
 */
export type ResolveHistoricalHumanObjectAccessGenesisSigner = (
  context: HistoricalHumanObjectAccessGenesisSignerContext,
) =>
  | HistoricalHumanObjectAccessGenesisSignerAuthority
  | null
  | Promise<HistoricalHumanObjectAccessGenesisSignerAuthority | null>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactFields(
  value: unknown,
  fields: readonly string[],
): boolean {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length
    && fields.every((field) => keys.includes(field));
}

async function authenticStoredGenesis(input: {
  readonly crypto: LatticeCrypto;
  readonly manifest: ReturnType<typeof decodeObjectAccessManifestV2>;
  readonly envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>;
  readonly envelopeBytes: Uint8Array;
  readonly resolveHistoricalSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner;
}): Promise<boolean> {
  const context = Object.freeze({
    purpose: "verify-historical-human-object-access-genesis" as const,
    objectId: input.manifest.objectId,
    payloadHash: input.manifest.payloadHash.slice(),
    envelopes: Object.freeze([Object.freeze({
      objectId: input.envelope.context.objectId,
      namespaceId: input.envelope.context.namespaceId,
      keyClass: input.envelope.context.keyClass,
      keyGeneration: input.envelope.context.keyGeneration,
      bindingRevisionAtWrap:
        input.envelope.context.bindingRevisionAtWrap,
      envelopeHash: input.crypto.hash(input.envelopeBytes),
    })]),
    committerDeviceId: input.manifest.committerDeviceId,
    hostAuthorizationRevision:
      input.manifest.hostAuthorizationRevision,
  });
  const resolved = await input.resolveHistoricalSigner(context);
  if (
    resolved === null
    || !exactFields(resolved, [
      "purpose",
      "objectId",
      "payloadHash",
      "envelopes",
      "committerDeviceId",
      "hostAuthorizationRevision",
      "committerSigningPublicKey",
    ])
    || !Array.isArray(resolved.envelopes)
    || resolved.envelopes.length !== 1
    || !(resolved.payloadHash instanceof Uint8Array)
    || !(resolved.committerSigningPublicKey instanceof Uint8Array)
    || resolved.purpose !== context.purpose
    || resolved.objectId !== context.objectId
    || !bytesEqual(resolved.payloadHash, context.payloadHash)
    || resolved.committerDeviceId !== context.committerDeviceId
    || resolved.hostAuthorizationRevision
      !== context.hostAuthorizationRevision
  ) return false;
  const resolvedEnvelope = (
    resolved.envelopes as
      readonly ObjectAccessGenesisEnvelopeAuthorizationContext[]
  )[0]!;
  const expectedEnvelope = context.envelopes[0]!;
  if (
    !exactFields(resolvedEnvelope, [
      "objectId",
      "namespaceId",
      "keyClass",
      "keyGeneration",
      "bindingRevisionAtWrap",
      "envelopeHash",
    ])
    || !(resolvedEnvelope.envelopeHash instanceof Uint8Array)
    || resolvedEnvelope.objectId !== expectedEnvelope.objectId
    || resolvedEnvelope.namespaceId !== expectedEnvelope.namespaceId
    || resolvedEnvelope.keyClass !== expectedEnvelope.keyClass
    || resolvedEnvelope.keyGeneration !== expectedEnvelope.keyGeneration
    || resolvedEnvelope.bindingRevisionAtWrap
      !== expectedEnvelope.bindingRevisionAtWrap
    || !bytesEqual(
      resolvedEnvelope.envelopeHash,
      expectedEnvelope.envelopeHash,
    )
    || !input.crypto.verify(
      resolved.committerSigningPublicKey,
      objectAccessManifestSigningBytesV2(input.manifest),
      input.manifest.signature,
    )
  ) return false;
  return true;
}

export class ConversationCryptoCompletionConflictError extends Error {
  readonly code = "conversation_crypto_completion_conflict";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConversationCryptoCompletionConflictError";
  }
}

function conflict(message: string, cause?: unknown): never {
  throw new ConversationCryptoCompletionConflictError(message, cause);
}

export interface VerifiedStoredConversationCryptoRead {
  readonly revision: VerifiedConversationCryptoRevision;
  readonly payloadBytes: Uint8Array;
  readonly objectAccessManifestBytes: Uint8Array;
  readonly namespaceEnvelopeBytes: Uint8Array;
}

export class ConversationCryptoReadUnavailableError extends Error {
  readonly code = "conversation_crypto_read_unavailable" as const;

  constructor(cause: unknown) {
    super("Conversation crypto storage is unavailable", { cause });
    this.name = "ConversationCryptoReadUnavailableError";
  }
}

/**
 * Read and authenticate one complete durable conversation crypto revision.
 *
 * The returned payload and Namespace envelope remain opaque ciphertext. A
 * caller still needs an independently authorized Namespace key to open them.
 * Current write authority is deliberately not consulted: retained Human or
 * Agent signer history is the authority for already-committed bytes.
 */
export async function readVerifiedStoredConversationCryptoRevision(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: LatticeStorage;
  readonly objectId: string;
  readonly resolveHistoricalSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner;
  readonly resolveHistoricalAgentSignerAuthority?:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority | undefined;
  readonly resolveLiveShadowAgentSigner?: ((principal: Readonly<{
    agentId: string;
    runtimeGeneration: number;
    signerKeyId: string;
  }>) => Uint8Array | null | Promise<Uint8Array | null>) | undefined;
}): Promise<VerifiedStoredConversationCryptoRead | null> {
  let object: Awaited<ReturnType<LatticeStorage["getObject"]>>;
  let access: Awaited<ReturnType<LatticeStorage["getObjectAccessState"]>>;
  try {
    [object, access] = await Promise.all([
      input.storage.getObject(input.objectId),
      input.storage.getObjectAccessState(input.objectId),
    ]);
  } catch (cause) {
    throw new ConversationCryptoReadUnavailableError(cause);
  }
  if (object === null || access === null) return null;

  const payload = decodeEncryptedPayloadV2(object.payloadBytes);
  const manifest = decodeObjectAccessManifestV2OrV3(
    access.head.manifestBytes,
  );
  if (access.namespaceEnvelopes.length !== 1) {
    throw new Error(
      "Conversation crypto revision must have exactly one Namespace envelope",
    );
  }
  const storedEnvelope = access.namespaceEnvelopes[0]!;
  const envelope = decodeNamespaceObjectEnvelopeV2(
    storedEnvelope.envelopeBytes,
  );
  const storedEnvelopeBytesHash =
    input.crypto.hash(storedEnvelope.envelopeBytes);
  if (
    object.objectId !== input.objectId
    || access.head.objectId !== input.objectId
    || payload.context.objectId !== input.objectId
    || manifest.objectId !== input.objectId
    || envelope.context.objectId !== input.objectId
    || envelope.context.namespaceId !== storedEnvelope.namespaceId
    || manifest.envelopeHashes.length !== 1
    || !bytesEqual(
      storedEnvelopeBytesHash,
      storedEnvelope.envelopeHash,
    )
    || !bytesEqual(
      storedEnvelopeBytesHash,
      manifest.envelopeHashes[0]!,
    )
    || !bytesEqual(
      input.crypto.hash(object.payloadBytes),
      manifest.payloadHash,
    )
  ) {
    throw new Error("Conversation crypto durable coordinates disagree");
  }
  if (payload.context.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE) {
    throw new Error("Conversation crypto durable object type is invalid");
  }
  if (
    payload.context.keyClass !== "ai"
    && payload.context.keyClass !== "human"
  ) {
    throw new Error("Conversation crypto durable key class is invalid");
  }
  if (envelope.context.keyClass !== payload.context.keyClass) {
    throw new Error(
      "Conversation crypto payload and envelope key class disagree",
    );
  }
  if (manifest.formatVersion === 2) {
    if (!await authenticStoredGenesis({
      crypto: input.crypto,
      manifest,
      envelope,
      envelopeBytes: storedEnvelope.envelopeBytes,
      resolveHistoricalSigner: input.resolveHistoricalSigner,
    })) return null;
  } else {
    const liveSigner = await input.resolveLiveShadowAgentSigner?.(
      manifest.signer,
    ) ?? null;
    if (liveSigner !== null) {
      try {
        verifyAgentObjectAccessManifest(input.crypto, {
          manifestBytes: access.head.manifestBytes,
          resolveSignerPublicKey: (principal) =>
            principal.agentId === manifest.signer.agentId
                && principal.runtimeGeneration
                  === manifest.signer.runtimeGeneration
                && principal.signerKeyId === manifest.signer.signerKeyId
              ? liveSigner
              : null,
        });
      } finally {
        liveSigner.fill(0);
      }
    } else {
    if (input.resolveHistoricalAgentSignerAuthority === undefined) {
      throw new AgentRuntimeSignerHistoryInvalidError(
        "Agent Runtime signer historical authority resolver is required",
      );
    }
    let publication: Awaited<
      ReturnType<LatticeStorage["getAgentRuntimeSignerPublication"]>
    >;
    try {
      publication = await input.storage.getAgentRuntimeSignerPublication(
        manifest.signer.agentId,
        manifest.signer.runtimeGeneration,
      );
    } catch (cause) {
      throw new ConversationCryptoReadUnavailableError(cause);
    }
    if (publication === null) {
      throw new AgentRuntimeSignerHistoryInvalidError(
        "Agent Runtime signer publication history is missing",
      );
    }
    const authenticated =
      await authenticateHistoricalAgentRuntimeSignerPublication({
        crypto: input.crypto,
        publication,
        resolveHistoricalManagerAuthority:
          input.resolveHistoricalAgentSignerAuthority,
      });
    if (
      authenticated.agentId !== manifest.signer.agentId
      || authenticated.runtimeGeneration
        !== manifest.signer.runtimeGeneration
      || authenticated.signerKeyId !== manifest.signer.signerKeyId
    ) {
      throw new AgentRuntimeSignerHistoryInvalidError(
        "Agent object manifest signer does not match authenticated history",
      );
    }
    try {
      verifyAgentObjectAccessManifest(input.crypto, {
        manifestBytes: access.head.manifestBytes,
        resolveSignerPublicKey: (principal) =>
          principal.agentId === authenticated.agentId
              && principal.runtimeGeneration
                === authenticated.runtimeGeneration
              && principal.signerKeyId === authenticated.signerKeyId
            ? authenticated.signerPublicKey
            : null,
      });
    } catch (cause) {
      throw new AgentRuntimeSignerHistoryInvalidError(
        "Agent object access manifest authentication failed",
        cause,
      );
    }
    }
  }

  return Object.freeze({
    revision: Object.freeze({
      objectId: input.objectId,
      namespaceId: envelope.context.namespaceId,
      objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
      payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
      keyClass: payload.context.keyClass as ConversationMessageKeyClass,
    }),
    payloadBytes: object.payloadBytes.slice(),
    objectAccessManifestBytes: access.head.manifestBytes.slice(),
    namespaceEnvelopeBytes: storedEnvelope.envelopeBytes.slice(),
  });
}

async function verifyStoredConversationRevision(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: LatticeStorage;
  readonly objectId: string;
  readonly expected?: PreparedConversationCryptoRevisionSnapshot;
  readonly resolveHistoricalSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner;
  readonly resolveHistoricalAgentSignerAuthority?:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority | undefined;
  readonly resolveLiveShadowAgentSigner?: ((principal: Readonly<{
    agentId: string;
    runtimeGeneration: number;
    signerKeyId: string;
  }>) => Uint8Array | null | Promise<Uint8Array | null>) | undefined;
}): Promise<VerifiedConversationCryptoRevision | null> {
  const liveExpected =
      input.expected?.kind === "agent-v3-device-wrapped-live-shadow"
    ? input.expected.value
    : null;
  const verified = await readVerifiedStoredConversationCryptoRevision({
    ...input,
    resolveLiveShadowAgentSigner: liveExpected === null
      ? input.resolveLiveShadowAgentSigner
      : (principal) => {
        const manifest = decodeObjectAccessManifestV2OrV3(
          liveExpected.access.manifestBytes,
        );
        return manifest.formatVersion === 3
            && principal.agentId === manifest.signer.agentId
            && principal.runtimeGeneration
              === manifest.signer.runtimeGeneration
            && principal.signerKeyId === manifest.signer.signerKeyId
          ? liveExpected.signerPublicKey.slice()
          : null;
      },
  });
  if (verified === null) return null;
  if (input.expected !== undefined) {
    const expected = input.expected.value;
    if (
      expected.objectId !== input.objectId
      || expected.namespaceId !== verified.revision.namespaceId
      || !bytesEqual(
        expected.object.payloadBytes.ciphertext,
        verified.payloadBytes,
      )
      || !bytesEqual(
        expected.access.manifestBytes,
        verified.objectAccessManifestBytes,
      )
      || expected.access.envelopeBytes.length !== 1
      || !bytesEqual(
        expected.access.envelopeBytes[0],
        verified.namespaceEnvelopeBytes,
      )
    ) {
      conflict(
        "Conversation crypto completion conflicts with durable object/access bytes",
      );
    }
  }
  return verified.revision;
}

export function createPostgresConversationCryptoCompletion(input: {
  readonly handle: CryptoPostgresHandle;
  readonly crypto: LatticeCrypto;
  readonly resolveCurrentWriteAuthorization:
    ResolveCurrentObjectAccessGenesisAuthorization;
  readonly resolveHistoricalSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner;
  readonly resolveHistoricalAgentSignerAuthority?:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority | undefined;
  readonly resolveLiveShadowAgentSigner?: ((principal: Readonly<{
    agentId: string;
    runtimeGeneration: number;
    signerKeyId: string;
  }>) => Uint8Array | null | Promise<Uint8Array | null>) | undefined;
}): AtomicConversationCryptoCompletionPort {
  assertVerifiedCryptoPostgresHandle(input.handle);
  if (typeof input.resolveCurrentWriteAuthorization !== "function") {
    throw new TypeError(
      "Conversation crypto completion current-write authorization resolver is required",
    );
  }
  if (typeof input.resolveHistoricalSigner !== "function") {
    throw new TypeError(
      "Conversation crypto completion historical signer resolver is required",
    );
  }

  return Object.freeze({
    async complete(
      revision: PreparedConversationCryptoRevision,
    ): Promise<"created" | "duplicate"> {
      const snapshot =
        readPreparedConversationCryptoRevisionSnapshot(revision);
      const value = snapshot.value;
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        async (scopedHandle) => {
          const storage = new PostgresLatticeStorage(scopedHandle);
          const replay = await verifyStoredConversationRevision({
            crypto: input.crypto,
            storage,
            objectId: value.objectId,
            expected: snapshot,
            resolveHistoricalSigner: input.resolveHistoricalSigner,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          if (replay !== null) return "duplicate";
          try {
            await storage.putObject(value.object);
          } catch (cause) {
            if (
              cause instanceof Error
              && cause.message === DIFFERENT_OBJECT_PAYLOAD
            ) {
              conflict(
                "Conversation crypto completion conflicts with durable payload bytes",
                cause,
              );
            }
            throw cause;
          }
          const status = snapshot.kind === "human-v2"
            ? await persistPreparedObjectAccessManifestGenesis({
              crypto: input.crypto,
              storage,
              prepared: snapshot.value.access,
              resolveCurrentAuthorization:
                input.resolveCurrentWriteAuthorization,
            })
            : snapshot.kind === "agent-v3"
            ? await persistPreparedAgentObjectAccessManifestGenesis({
              crypto: input.crypto,
              storage,
              prepared: snapshot.value.access,
              resolveCurrentAuthorization:
                snapshot.value.resolveCurrentAuthorization,
            })
            : await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({
              crypto: input.crypto,
              storage,
              prepared: snapshot.value.access,
              resolveCurrentAuthorization:
                snapshot.value.resolveCurrentAuthorization,
            });
          if (status === "stale") {
            conflict(
              "Conversation crypto completion conflicts with durable access state",
            );
          }
          const verified = await verifyStoredConversationRevision({
            crypto: input.crypto,
            storage,
            objectId: value.objectId,
            expected: snapshot,
            resolveHistoricalSigner: input.resolveHistoricalSigner,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
          });
          if (verified === null) {
            throw new Error(
              "Conversation crypto transaction did not persist a complete object/access set",
            );
          }
          return status === "duplicate" ? "duplicate" : "created";
        },
      );
    },

    verify(
      objectId: string,
    ): Promise<VerifiedConversationCryptoRevision | null> {
      return withVerifiedCryptoPostgresTransaction(
        input.handle,
        (scopedHandle) =>
          verifyStoredConversationRevision({
            crypto: input.crypto,
            storage: new PostgresLatticeStorage(scopedHandle),
            objectId,
            resolveHistoricalSigner: input.resolveHistoricalSigner,
            resolveHistoricalAgentSignerAuthority:
              input.resolveHistoricalAgentSignerAuthority,
            resolveLiveShadowAgentSigner:
              input.resolveLiveShadowAgentSigner,
          }),
      );
    },
  });
}
