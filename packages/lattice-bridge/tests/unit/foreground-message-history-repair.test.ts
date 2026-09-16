import { describe, expect, test } from "bun:test";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  deriveAgentRuntimeObjectSignerPublic,
  InMemoryLatticeStore,
  LatticeCrypto,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  persistPreparedObjectAccessManifestGenesis,
  type AgentRuntimeKeyGeneration,
} from "@nautilo/lattice-crypto";

import {
  createForegroundMessageHistoryRepairer,
  createForegroundExistingMessageWriteAuthorization,
  type ForegroundMessageEntityCryptoInvocation,
} from "../../src/server/message/foreground-message-history-repair.ts";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../src/message/conversation-prepared-revision.ts";
import {
  prepareHumanExistingMessageRepresentationCryptoRevision,
} from "../../src/message/human-existing-message-representation-crypto.ts";
import { recoverReservedMessageBackfillPublication } from "../../src/server/message/message-backfill-authority.ts";
import { encodeMessagePayloadV2 } from "../../src/message/message-payload-v2.ts";
import { deriveMessageCryptoObjectIdV2 } from "../../src/message/conversation-repository.ts";
import type {
  ConversationOrdinaryRepairInput,
  ConversationRepository,
} from "../../src/message/conversation-repository.ts";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000003";
const AGENT_ID = "10000000-0000-4000-8000-000000000004";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

function repairer(input: Readonly<{
  entities: ForegroundMessageEntityCryptoInvocation;
  sourceRepresentationMode?: "ordinary-and-protected" | "protected-only";
  loadSources: Parameters<
    typeof createForegroundMessageHistoryRepairer
  >[0]["loadSources"];
}>) {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x311) },
    { now: () => 1_800_000_000_000 },
  );
  return createForegroundMessageHistoryRepairer({
    crypto,
    storage: new InMemoryLatticeStore(),
    entities: input.entities,
    product: Object.freeze({}) as never,
    conversation: Object.freeze({}) as never,
    cryptoCompletion: Object.freeze({}) as never,
    contextNamespaceId: NAMESPACE_ID,
    ...(input.sourceRepresentationMode === undefined
      ? {}
      : { sourceRepresentationMode: input.sourceRepresentationMode }),
    publication: {
      operationId: "foreground-operation",
      policyRevision: 1,
      grantId: "foreground-grant",
      grantDigest: new Uint8Array(32).fill(0x31),
      recipientKeyId: "foreground-recipient",
      agentAuthorizationRevision: 1,
      signerKeyId: "foreground-signer",
      signerPublicKey: new Uint8Array(32).fill(0x32),
      runtime: Object.freeze({
        agentId: AGENT_ID,
        generation: 1,
        key: new Uint8Array(32).fill(0x33),
      }) as AgentRuntimeKeyGeneration,
      withCurrentPublication: async () => null,
    },
    loadSources: input.loadSources,
    resolveHistoricalHumanSigner: () => null,
    resolveHistoricalAgentSignerAuthority: () => null,
  });
}

describe("foreground Message history repair", () => {
  test("opens an already-mapped Human-v2 Message without an ordinary sibling", async () => {
    const crypto = new LatticeCrypto(
      { bytes: seededRng(0x310) },
      { now: () => 1_800_000_000_000 },
    );
    const storage = new InMemoryLatticeStore();
    const namespaceKey = new Uint8Array(32).fill(0x40);
    const signing = crypto.generateSigningKeyPair();
    const deviceId = "device:m311:browser";
    const protectedPayload = Object.freeze({
      role: "user" as const,
      content: "Browser encrypted Human message",
    });
    const source = Object.freeze({
      messageId: 40,
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      revision: 0,
      createdAt: 1_800_000_000_000,
      authorRole: "user" as const,
      authorHumanTurnId: "turn-40",
      sessionAgentId: AGENT_ID,
      mappedCryptoObjectId: "message:v2:human-mapped-40",
      payload: null,
    });
    const prepared = prepareHumanExistingMessageRepresentationCryptoRevision({
      crypto,
      objectId: source.mappedCryptoObjectId,
      payload: protectedPayload,
      createdAt: source.createdAt,
      namespace: {
        namespaceId: source.namespaceId,
        accessRevision: 1,
        keyGeneration: 1,
        aiKey: namespaceKey,
      },
      device: {
        deviceId,
        hostAuthorizationRevision: 1,
        signingPrivateKey: signing.privateKey,
      },
      resolveCurrentAuthorization: () => null,
    });
    const snapshot = readPreparedConversationCryptoRevisionSnapshot(prepared);
    expect(snapshot.kind).toBe("human-v2");
    if (snapshot.kind !== "human-v2") throw new Error("expected Human v2");
    await storage.putObject(snapshot.value.object);
    expect(await persistPreparedObjectAccessManifestGenesis({
      crypto,
      storage,
      prepared: snapshot.value.access,
      resolveCurrentAuthorization: (context) => Object.freeze({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: 1,
        committerSigningPublicKey: signing.publicKey,
      }),
    })).toBe("applied");

    let ordinaryRevisionReads = 0;
    const namespaceAuthority = Object.freeze({
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 1,
      namespaceKeyGeneration: 1,
    }) as never;
    let fullRestoreCalls = 0;
    const serviceInput: Parameters<
      typeof createForegroundMessageHistoryRepairer
    >[0] = {
      crypto,
      storage,
      entities: Object.freeze({
        use: async (request) => Object.freeze({
          status: "executed" as const,
          value: await request.execute({
            namespaceKey,
            authority: namespaceAuthority,
          }),
        }),
        useCurrentSet: () =>
          Promise.reject(new Error("mapped history must not be repaired")),
      }),
      product: Object.freeze({
        getRevision: () => {
          ordinaryRevisionReads += 1;
          return Promise.reject(new Error("protected-only must not load ordinary revision"));
        },
        getRevisionMapping: () => Promise.resolve(Object.freeze({
          lifecycle: Object.freeze({
            disposition: "mapped" as const,
            completion: "complete" as const,
            cryptoObjectId: source.mappedCryptoObjectId,
          }),
          message: Object.freeze({
            sessionId: source.sessionId,
            messageId: source.messageId,
            revision: source.revision,
            authorRole: source.authorRole,
            cryptoObjectId: source.mappedCryptoObjectId,
          }),
        })),
        restoreOrdinaryExistingRepresentation: () => {
          fullRestoreCalls += 1;
          throw new Error("Full history must never publish ordinary content");
        },
      }) as never,
      conversation: Object.freeze({}) as never,
    cryptoCompletion: Object.freeze({}) as never,
      contextNamespaceId: NAMESPACE_ID,
      sourceRepresentationMode: "protected-only",
      publication: {
        operationId: "foreground-operation",
        policyRevision: 1,
        grantId: "foreground-grant",
        grantDigest: new Uint8Array(32).fill(0x31),
        recipientKeyId: "foreground-recipient",
        agentAuthorizationRevision: 1,
        signerKeyId: "foreground-signer",
        signerPublicKey: new Uint8Array(32).fill(0x32),
        runtime: Object.freeze({
          agentId: AGENT_ID,
          generation: 1,
          key: new Uint8Array(32).fill(0x33),
        }) as AgentRuntimeKeyGeneration,
        withCurrentPublication: async () => null,
      },
      loadSources: (selection) => {
        expect(selection.representationMode).toBe("protected-only");
        return Promise.resolve([source]);
      },
      resolveHistoricalHumanSigner: (context) => Object.freeze({
        ...context,
        committerSigningPublicKey: signing.publicKey,
      }),
      resolveHistoricalAgentSignerAuthority: () => null,
    };
    const service = createForegroundMessageHistoryRepairer(serviceInput);

    expect(await service.protect({ messageIds: [source.messageId] })).toEqual({
      status: "verified",
      messages: [{
        messageId: source.messageId,
        payload: protectedPayload,
        provenance: "existing",
      }],
    });
    expect(ordinaryRevisionReads).toBe(0);
    expect(fullRestoreCalls).toBe(0);

    const mappedObjectId = source.mappedCryptoObjectId;
    if (mappedObjectId === null) throw new Error("mapped object missing");
    const storedAccess = await storage.getObjectAccessState(mappedObjectId);
    if (storedAccess === null) throw new Error("stored access missing");
    const expectedAttestationDigest = crypto.hash(
      storedAccess.head.manifestBytes,
    );
    let restored: ConversationOrdinaryRepairInput | undefined;
    let exactAttestationObserved = false;
    const shadow = createForegroundMessageHistoryRepairer({
      ...serviceInput,
      sourceRepresentationMode: "ordinary-and-protected",
      product: Object.freeze({
        ...serviceInput.product,
        getRevision: () => {
          ordinaryRevisionReads += 1;
          return Promise.reject(new Error(
            "protected-only origin must not enter the ordinary revision loader",
          ));
        },
        getRevisionMapping: () => Promise.resolve(Object.freeze({
          lifecycle: Object.freeze({
            disposition: "mapped" as const,
            completion: "complete" as const,
            cryptoObjectId: source.mappedCryptoObjectId,
          }),
          message: Object.freeze({
            sessionId: source.sessionId,
            messageId: source.messageId,
            revision: source.revision,
            authorRole: source.authorRole,
            cryptoObjectId: source.mappedCryptoObjectId,
          }),
        })),
        restoreOrdinaryExistingRepresentation: (
          repair: ConversationOrdinaryRepairInput,
        ) => {
          exactAttestationObserved = repair.attestationDigest.every(
            (value, index) => value === expectedAttestationDigest[index],
          );
          restored = repair;
          return Promise.resolve("applied" as const);
        },
      }) as never,
      loadSources: (selection) => {
        expect(selection.representationMode).toBe("ordinary-and-protected");
        return Promise.resolve([source]);
      },
    });
    expect(await shadow.protect({ messageIds: [source.messageId] })).toEqual({
      status: "verified",
      messages: [{
        messageId: source.messageId,
        payload: protectedPayload,
        provenance: "repaired",
      }],
    });
    expect(ordinaryRevisionReads).toBe(0);
    expect(exactAttestationObserved).toBe(true);
    expect(restored).toMatchObject({
      sessionId: source.sessionId,
      messageId: source.messageId,
      revision: source.revision,
      cryptoObjectId: source.mappedCryptoObjectId,
      expectedNamespaceAccessRevision: 1,
      expectedNamespaceKeyGeneration: 1,
      content: protectedPayload.content,
      toolCalls: null,
      toolName: null,
      authorityActorId: AGENT_ID,
      publisher: { kind: "authenticated_runtime", id: "foreground-signer" },
      publicationPolicy: {
        expectedRevision: 1,
        representation: "ordinary_and_protected",
      },
    });

    const wrongRole = createForegroundMessageHistoryRepairer({
      ...serviceInput,
      loadSources: () => Promise.resolve([Object.freeze({
        ...source,
        authorRole: "assistant" as const,
      })]),
    });
    expect(await wrongRole.protect({ messageIds: [source.messageId] })).toEqual({
      status: "failed",
      reason: "message_author_role_mismatch",
    });

    const wrongKey = createForegroundMessageHistoryRepairer({
      ...serviceInput,
      entities: Object.freeze({
        ...serviceInput.entities,
        use: async (request) => Object.freeze({
          status: "executed" as const,
          value: await request.execute({
            namespaceKey: new Uint8Array(32).fill(0x7f),
            authority: namespaceAuthority,
          }),
        }),
      }),
    });
    expect(await wrongKey.protect({ messageIds: [source.messageId] })).toEqual({
      status: "failed",
      reason: "message_decryption_failed",
    });

    const parityMismatch = createForegroundMessageHistoryRepairer({
      ...serviceInput,
      sourceRepresentationMode: "ordinary-and-protected",
      loadSources: () => Promise.resolve([Object.freeze({
        ...source,
        payload: Object.freeze({
          role: "user" as const,
          content: "substituted ordinary sibling",
        }),
      })]),
    });
    expect(await parityMismatch.protect({ messageIds: [source.messageId] }))
      .toEqual({ status: "failed", reason: "message_parity_mismatch" });
  });

  test("does not attempt forward repair without an ordinary source", async () => {
    let encryptions = 0;
    const service = repairer({
      entities: Object.freeze({
        use: () => Promise.reject(new Error("must not decrypt")),
        useCurrentSet: () => {
          encryptions += 1;
          return Promise.reject(new Error("must not encrypt"));
        },
      }),
      loadSources: () => Promise.resolve([Object.freeze({
        messageId: 41,
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        revision: 0,
        createdAt: 1_800_000_000_000,
        authorRole: "user" as const,
        authorHumanTurnId: "turn-41",
        sessionAgentId: AGENT_ID,
        mappedCryptoObjectId: null,
        payload: null,
      })]),
    });

    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "failed",
      reason: "protected_representation_missing",
    });
    expect(encryptions).toBe(0);
  });

  test("does not synthesize a missing protected Tool identity from ordinary bytes", async () => {
    let encryptions = 0;
    const service = repairer({
      entities: Object.freeze({
        use: () => Promise.reject(new Error("must not decrypt")),
        useCurrentSet: () => {
          encryptions += 1;
          return Promise.reject(new Error("must not encrypt"));
        },
      }),
      loadSources: () => Promise.resolve([Object.freeze({
        messageId: 42,
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        revision: 0,
        createdAt: 1_800_000_000_000,
        authorRole: "tool" as const,
        authorHumanTurnId: null,
        sessionAgentId: AGENT_ID,
        mappedCryptoObjectId: null,
        payload: Object.freeze({
          role: "tool" as const,
          content: "ordinary result",
          toolName: "share_memory",
        }),
        ordinaryComparison: "tool_result_protected_identity" as const,
      })]),
    });

    expect(await service.protect({ messageIds: [42] })).toEqual({
      status: "failed",
      reason: "protected_tool_identity_missing",
    });
    expect(encryptions).toBe(0);
  });

  test("rejects ordinary bytes from a protected-only source loader before crypto", async () => {
    let cryptoUses = 0;
    const service = repairer({
      sourceRepresentationMode: "protected-only",
      entities: Object.freeze({
        use: () => {
          cryptoUses += 1;
          return Promise.reject(new Error("must not decrypt"));
        },
        useCurrentSet: () => {
          cryptoUses += 1;
          return Promise.reject(new Error("must not encrypt"));
        },
      }),
      loadSources: () => Promise.resolve([Object.freeze({
        messageId: 41,
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        revision: 0,
        createdAt: 1_800_000_000_000,
        authorRole: "user" as const,
        authorHumanTurnId: "turn-41",
        sessionAgentId: AGENT_ID,
        mappedCryptoObjectId: "message:v2:must-not-open",
        payload: Object.freeze({
          role: "user" as const,
          content: "ordinary bytes returned by incorrect loader wiring",
        }),
      })]),
    });

    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "failed",
      reason: "ordinary_source_forbidden",
    });
    expect(cryptoUses).toBe(0);
  });

  test.each(["user", "assistant", "tool"] as const)("resumes a durable %s repair and reopens it under a later execution signer", async (role) => {
    const crypto = new LatticeCrypto(
      { bytes: seededRng(0x312) },
      { now: () => 1_800_000_000_000 },
    );
    class InterruptedReadStore extends InMemoryLatticeStore {
      failNextObjectRead = false;

      override getObject(objectId: string) {
        if (this.failNextObjectRead) {
          this.failNextObjectRead = false;
          return Promise.reject(new Error("simulated process interruption"));
        }
        return super.getObject(objectId);
      }
    }
    const storage = new InterruptedReadStore();
    const namespaceKey = new Uint8Array(32).fill(0x41);
    const runtime = Object.freeze({
      agentId: agentId(AGENT_ID),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x42),
    }) as AgentRuntimeKeyGeneration;
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const authority = Object.freeze({
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 1,
      namespaceKeyGeneration: 1,
      domainId: "domain-foreground-message-history",
      domainKeyGeneration: 1,
      domainAuthorizationRevision: 1,
      domainHeadDigest: new Uint8Array(32).fill(0x42),
      namespaceHeadDigest: new Uint8Array(32).fill(0x43),
      namespacePublicationDigest: new Uint8Array(32).fill(0x44),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x45),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x46),
    });
    const source = Object.freeze({
      messageId: 41,
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      revision: 0,
      createdAt: 1_800_000_000_000,
      authorRole: role,
      authorHumanTurnId: role === "user" ? "turn-41" : null,
      sessionAgentId: AGENT_ID,
      mappedCryptoObjectId: null as string | null,
      payload: Object.freeze({
        role,
        content: "Existing Human history",
        ...(role === "tool"
          ? {
              toolName: "search",
              sensitiveMetadata: Object.freeze({ toolCallId: "call-41" }),
            }
          : {}),
      }),
    });
    const cryptoObjectId = deriveMessageCryptoObjectIdV2({sessionId: SESSION_ID, messageId: 41, revision: 0});
    const lifecycle = {sessionId: SESSION_ID, roomId: ROOM_ID, messageId: 41, revision: 0, keyClass: "ai", authorRole: role,
      sequence: 1, appendIdempotencyKey: "repair-41", terminalOperationId: null, terminalOperationType: null,
      terminalExpectedRevision: null, terminalRequestDigest: null, objectIdScheme: "message_v2", shadowOperationId: null,
      humanPeerShadowOperationId: null, sharedAgentShadowOperationId: null, sharedAgentShadowExecutionId: null,
      shadowTranscriptOrdinal: null, cryptoObjectId, namespaceIdAtAllocation: NAMESPACE_ID, completion: "pending", disposition: "active",
      parityStatus: "pending", failureCode: null, attemptCount: 0, nextAttemptAt: new Date(), leaseToken: null,
      leaseExpiresAt: null, allocationRequestDigest: new Uint8Array(32), repairIdentityDigest: new Uint8Array(32),
      repairPublisherKind: null as string | null, repairPublisherId: null as string | null,
      repairAttestationDigest: null as Uint8Array | null, representationMode: "shadow_encryption", publicationPolicyRevision: 1};
    let mapped = false;
    let allocations = 0;
    let publicationActive = false;
    let scopedAuthorizationCalls = 0;
    const publicationStages: string[] = [];
    let repairPublication: Parameters<
      ConversationRepository["completeRevision"]
    >[0]["repairPublication"];
    const resolveCurrentAuthorization: Parameters<typeof createForegroundExistingMessageWriteAuthorization>[0]["resolveCurrentAuthorization"] = (context) => {
      expect(context.purpose).toBe("persist-device-wrapped-live-shadow-agent-object-access-genesis-set");
      expect(context.namespaces).toEqual([{
        namespaceId: NAMESPACE_ID,
        accessRevision: authority.namespaceAccessRevision,
        keyGeneration: authority.namespaceKeyGeneration,
        domainId: authority.domainId,
        domainKeyGeneration: authority.domainKeyGeneration,
        domainAuthorizationRevision: authority.domainAuthorizationRevision,
        domainHeadDigest: authority.domainHeadDigest,
        headDigest: authority.namespaceHeadDigest,
        publicationDigest: authority.namespacePublicationDigest,
        publicationSetDigest: authority.namespacePublicationSetDigest,
        audienceFingerprint: authority.namespaceAudienceFingerprint,
      }]);
      return Object.freeze({
        context,
        grantAuthorized: true as const,
        namespacesAuthorized: true as const,
        agentAuthorized: true as const,
        hostAllowsOperation: true as const,
        currentRuntime: Object.freeze({
          agentId: runtime.agentId,
          authorizationRevision: authorizationRevision(1),
          runtimeGeneration: runtime.generation,
        }),
        signerPublicKey: signer.publicKey.slice(),
      });
    };
    const useEntity: ForegroundMessageEntityCryptoInvocation["use"] =
      async (request) => Object.freeze({
        status: "executed" as const,
        value: await request.execute({ namespaceKey, authority }),
      });
    const useCurrentSet:
      ForegroundMessageEntityCryptoInvocation["useCurrentSet"] =
      async (request) => Object.freeze({
        status: "executed" as const,
        value: await request.execute([{ namespaceKey, authority }]),
      });
    const serviceInput: Parameters<typeof createForegroundMessageHistoryRepairer>[0] = {
      crypto,
      storage,
      entities: Object.freeze({ use: useEntity, useCurrentSet }),
      product: Object.freeze({
        roomNamespaceInvariant: "immutable-session-room-namespace-v1" as const,
        allocateExistingRepresentation: (input: {requestDigest: Uint8Array}) => {
          lifecycle.allocationRequestDigest = input.requestDigest.slice();
          allocations += 1;
          return Promise.resolve(Object.freeze({
            status: allocations === 1 ? "allocated" as const : "replayed" as const,
            lifecycle,
          }));
        },
        withExistingRepresentationPublication: () => { throw new Error("Unscoped publication must not run"); },
        reserveExistingRepresentationPublication: (input: {repairPublication: {publisherKind: string; publisherId: string; attestationDigest: Uint8Array}}) => {
          lifecycle.repairPublisherKind = input.repairPublication.publisherKind;
          lifecycle.repairPublisherId = input.repairPublication.publisherId;
          lifecycle.repairAttestationDigest = input.repairPublication.attestationDigest.slice();
          return Promise.resolve("reserved");
        },
        resolveCurrentNamespace: () => Promise.resolve(NAMESPACE_ID),
        getRevision: () => Promise.resolve(Object.freeze({
          lifecycle: Object.freeze({...lifecycle,
            disposition: mapped ? "mapped" : "active", completion: mapped ? "complete" : "pending",
            nextAttemptAt: mapped ? null : lifecycle.nextAttemptAt,
          }),
          message: mapped ? Object.freeze({ cryptoObjectId }) : null,
        })),
        markCryptoComplete: (input: Readonly<{
          repairPublication?: typeof repairPublication;
        }>) => {
          repairPublication = input.repairPublication;
          return Promise.resolve("applied" as const);
        },
        compareAndSwapCryptoMapping: () => {
          mapped = true;
          return Promise.resolve("applied" as const);
        },
      }) as never,
      conversation: Object.freeze({}) as never,
      cryptoCompletion: Object.freeze({
        complete: async (prepared: Parameters<NonNullable<Parameters<typeof createForegroundMessageHistoryRepairer>[0]["cryptoCompletion"]>["complete"]>[0]) => {
          expect(publicationActive).toBe(true);
          expect(publicationStages.slice(0, 3)).toEqual(["begin", "commit", "begin"]);
          const snapshot = readPreparedConversationCryptoRevisionSnapshot(prepared);
          expect(snapshot.kind).toBe(
            "agent-v3-device-wrapped-live-shadow",
          );
          await storage.putObject(snapshot.value.object);
          if (snapshot.kind !== "agent-v3-device-wrapped-live-shadow") {
            throw new Error("expected live Runtime repair snapshot");
          }
          const mismatchedAuthority = createForegroundExistingMessageWriteAuthorization({
            authority,
            resolveCurrentAuthorization: async (context) => ({
              ...(await resolveCurrentAuthorization(context))!,
              context: { ...context, objectId: "message:v2:substituted" },
            }),
          });
          expect(await mismatchedAuthority(snapshot.value.access.authority)).toBeNull();
          expect(
            await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({
              crypto,
              storage,
              prepared: snapshot.value.access,
              resolveCurrentAuthorization:
                snapshot.value.resolveCurrentAuthorization,
            }),
          ).toBe("applied");
          storage.failNextObjectRead = true;
          throw new Error("simulated interruption before product mapping");
        },
      }) as never,
      contextNamespaceId: NAMESPACE_ID,
      publication: {
        operationId: "foreground-operation",
        policyRevision: 1,
        grantId: "foreground-grant",
        grantDigest: new Uint8Array(32).fill(0x47),
        recipientKeyId: "foreground-recipient",
        agentAuthorizationRevision: 1,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
        runtime,
        withCurrentPublication: async (request) => {
          expect(publicationActive).toBe(false);
          publicationActive = true;
          publicationStages.push("begin");
          try {
            return await request.use({
              product: Object.freeze({...serviceInput.product}),
              resolveCurrentAuthorization: (context) => {
                expect(publicationActive).toBe(true);
                scopedAuthorizationCalls++;
                return resolveCurrentAuthorization(context);
              },
            });
          } finally {
            publicationActive = false;
            publicationStages.push("commit");
          }
        },
      },
      loadSources: () => Promise.resolve([Object.freeze({
        ...source,
        mappedCryptoObjectId: mapped ? cryptoObjectId : null,
      })]),
      resolveHistoricalHumanSigner: () => null,
      resolveHistoricalAgentSignerAuthority: () => null,
    };
    const service = createForegroundMessageHistoryRepairer(serviceInput);

    const cancelled = new AbortController();
    const cancelledService = createForegroundMessageHistoryRepairer({
      ...serviceInput,
      publication: {
        ...serviceInput.publication,
        withCurrentPublication: async (request) => {
          const result = await serviceInput.publication.withCurrentPublication(request);
          cancelled.abort();
          return result;
        },
      },
    });
    expect(await cancelledService.protect({ messageIds: [41], signal: cancelled.signal })).toEqual({
      status: "waiting_for_authority", reason: "cancelled",
    });
    expect(await storage.getObject(cryptoObjectId)).toBeNull();
    expect(mapped).toBe(false);
    expect(scopedAuthorizationCalls).toBe(0);
    expect(publicationStages).toEqual(["begin", "commit"]);
    // Reset only the synthetic interrupted reservation before the independent
    // durable-winner scenario below; production retains this for recovery.
    allocations = 0;
    lifecycle.repairPublisherKind = null;
    lifecycle.repairPublisherId = null;
    lifecycle.repairAttestationDigest = null;
    publicationStages.length = 0;

    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "failed",
      reason: "message_forward_repair_failed",
    });
    expect(mapped).toBe(false);
    expect(scopedAuthorizationCalls).toBeGreaterThan(0);
    expect(publicationActive).toBe(false);
    const deviceRecovery = role === "assistant";
    if (deviceRecovery) {
      const sourceBytes = encodeMessagePayloadV2(source.payload);
      const recovered = await recoverReservedMessageBackfillPublication({
        product: serviceInput.product as never, productExecutor: {} as never, restricted: {} as never,
        crypto, storage, serverId: "retired-runtime-server", authority: {} as never,
        claim: {coordinate: {sessionId: SESSION_ID, messageId: 41, revision: 0, namespaceId: NAMESPACE_ID},
          cryptoObjectId, keyClass: "ai", createdAt: source.createdAt, policyRevision: 1,
          expiresAt: Date.now() + 10_000} as never,
        sourceDigest: crypto.hash(sourceBytes), resolveHistoricalSigner: () => null,
        resolveLiveShadowAgentSigner: principal => principal.signerKeyId === signer.principal.signerKeyId
          ? signer.publicKey.slice() : null,
      });
      sourceBytes.fill(0);
      expect(recovered).toBe("replayed");
      expect(mapped).toBe(true);
    }
    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "verified",
      messages: [{
        messageId: 41,
        payload: source.payload,
        provenance: deviceRecovery ? "existing" : "repaired",
      }],
    });
    expect(repairPublication?.publisherKind).toBe("foreground_runtime");
    expect(repairPublication?.publisherId).toBe(signer.principal.signerKeyId);
    expect(allocations).toBe(deviceRecovery ? 1 : 2);

    const laterRuntime = Object.freeze({
      ...runtime,
      key: new Uint8Array(32).fill(0x52),
    });
    const laterSigner = deriveAgentRuntimeObjectSignerPublic(crypto, laterRuntime);
    expect(laterSigner.principal.signerKeyId).not.toBe(signer.principal.signerKeyId);
    for (const retained of ["accepted", "missing", "wrong"] as const) {
      const requestedPrincipals: unknown[] = [];
      let decryptions = 0;
      const laterService = createForegroundMessageHistoryRepairer({
        ...serviceInput,
        entities: {
          use: (request) => {
            decryptions += 1;
            return useEntity(request);
          },
          useCurrentSet: () => Promise.reject(new Error("mapped history must not be repaired")),
        },
        publication: {
          ...serviceInput.publication,
          operationId: "later-foreground-operation",
          runtime: laterRuntime,
          signerKeyId: laterSigner.principal.signerKeyId,
          signerPublicKey: laterSigner.publicKey,
        },
        resolveLiveShadowAgentSigner: async (principal) => {
          requestedPrincipals.push(principal);
          return retained === "accepted"
            ? signer.publicKey.slice()
            : retained === "wrong" ? laterSigner.publicKey.slice() : null;
        },
      });
      const result = await laterService.protect({ messageIds: [41] });
      expect(result).toEqual(retained === "accepted" ? {
        status: "verified",
        messages: [{ messageId: 41, payload: source.payload, provenance: "existing" }],
      } : { status: "failed", reason: "message_stored_open_failed" });
      expect(requestedPrincipals).toEqual([signer.principal]);
      expect(decryptions).toBe(retained === "accepted" ? 1 : 0);
      expect(allocations).toBe(deviceRecovery ? 1 : 2);
    }
    if (role === "tool") {
      let restoreCalls = 0;
      const partialSource = Object.freeze({
        ...source,
        mappedCryptoObjectId: cryptoObjectId,
        payload: Object.freeze({
          role: "tool" as const,
          content: source.payload.content,
          toolName: "search",
        }),
        ordinaryComparison: "tool_result_protected_identity" as const,
      });
      const partialService = (ordinaryContent: string, toolName: string) =>
        createForegroundMessageHistoryRepairer({
          ...serviceInput,
          entities: {
            use: useEntity,
            useCurrentSet: () => Promise.reject(new Error(
              "existing ordinary representation must not be repaired",
            )),
          },
          product: Object.freeze({
            ...serviceInput.product,
            restoreOrdinaryExistingRepresentation: () => {
              restoreCalls += 1;
              return Promise.resolve("conflict" as const);
            },
          }) as never,
          loadSources: () => Promise.resolve([Object.freeze({
            ...partialSource,
            payload: Object.freeze({
              ...partialSource.payload,
              content: ordinaryContent,
              toolName,
            }),
          })]),
          resolveLiveShadowAgentSigner: () => Promise.resolve(
            signer.publicKey.slice(),
          ),
        });
      expect(await partialService(source.payload.content, "search")
        .protect({ messageIds: [41] })).toEqual({
        status: "verified",
        messages: [{
          messageId: 41,
          payload: source.payload,
          provenance: "existing",
        }],
      });
      expect(await partialService("substituted body", "search")
        .protect({ messageIds: [41] })).toEqual({
        status: "failed",
        reason: "message_parity_mismatch",
      });
      expect(await partialService(source.payload.content, "substituted-name")
        .protect({ messageIds: [41] })).toEqual({
        status: "failed",
        reason: "message_parity_mismatch",
      });
      expect(restoreCalls).toBe(0);
    }
    // A Runtime can finish the exact previously admitted device winner even
    // when that device is no longer the active publisher.
    const deviceSigning = crypto.generateSigningKeyPair(), humanStorage = new InMemoryLatticeStore();
    const devicePrepared = prepareHumanExistingMessageRepresentationCryptoRevision({crypto, objectId: cryptoObjectId,
      payload: source.payload, createdAt: source.createdAt,
      namespace: {namespaceId: NAMESPACE_ID, accessRevision: 1, keyGeneration: 1, aiKey: namespaceKey},
      device: {deviceId: "retired-device", hostAuthorizationRevision: 1, signingPrivateKey: deviceSigning.privateKey},
      resolveCurrentAuthorization: () => null});
    const deviceSnapshot = readPreparedConversationCryptoRevisionSnapshot(devicePrepared);
    if (deviceSnapshot.kind !== "human-v2") throw new Error("Expected device snapshot");
    await humanStorage.putObject(deviceSnapshot.value.object);
    expect(await persistPreparedObjectAccessManifestGenesis({crypto, storage: humanStorage, prepared: deviceSnapshot.value.access,
      resolveCurrentAuthorization: context => ({...context, sourceAuthorized: true, targetAuthorized: true,
        currentHostAuthorizationRevision: 1, committerSigningPublicKey: deviceSigning.publicKey})})).toBe("applied");
    Object.assign(lifecycle, {repairPublisherKind: "human_device", repairPublisherId: "retired-device",
      repairPublisherHumanId: AGENT_ID, repairAttestationDigest: crypto.hash(deviceSnapshot.value.access.manifestBytes)});
    mapped = false;
    const fromDevice = createForegroundMessageHistoryRepairer({...serviceInput, storage: humanStorage,
      resolveHistoricalHumanSigner: context => ({...context, committerSigningPublicKey: deviceSigning.publicKey})});
    expect(await fromDevice.protect({messageIds: [41]})).toMatchObject({status: "verified"});
    expect(mapped).toBe(true);
    expect(repairPublication).toMatchObject({publisherKind: "human_device", publisherId: "retired-device", publisherHumanId: AGENT_ID});
  });

  test("classifies missing Namespace key authority as waiting", async () => {
    const service = repairer({
      entities: Object.freeze({
        use: () => Promise.resolve(Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        })),
        useCurrentSet: () => Promise.resolve(Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        })),
      }),
      loadSources: () => Promise.resolve(Object.freeze([Object.freeze({
        messageId: 41,
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        revision: 0,
        createdAt: 1_800_000_000_000,
        authorRole: "user" as const,
        authorHumanTurnId: "turn-41",
        sessionAgentId: AGENT_ID,
        mappedCryptoObjectId: null,
        payload: { role: "user" as const, content: "ordinary" },
      })])),
    });
    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "waiting_for_authority",
      reason: "message_namespace_authority_unavailable",
    });
  });

  test("rejects duplicate selected coordinates before product access", async () => {
    let loads = 0;
    const service = repairer({
      entities: Object.freeze({
        use: () => Promise.reject(new Error("must not open authority")),
        useCurrentSet: () =>
          Promise.reject(new Error("must not open authority")),
      }),
      loadSources: () => {
        loads += 1;
        return Promise.resolve([]);
      },
    });
    expect(await service.protect({ messageIds: [41, 41] })).toEqual({
      status: "failed",
      reason: "invalid_selected_history",
    });
    expect(loads).toBe(0);
  });

  test("retries when an edited or deleted Message leaves the selected page incomplete", async () => {
    let authorityUses = 0;
    const service = repairer({
      entities: Object.freeze({
        use: () => {
          authorityUses += 1;
          return Promise.reject(new Error("must not open authority"));
        },
        useCurrentSet: () => {
          authorityUses += 1;
          return Promise.reject(new Error("must not open authority"));
        },
      }),
      loadSources: () => Promise.resolve([]),
    });

    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "waiting_for_authority",
      reason: "message_product_revision_changed",
    });
    expect(authorityUses).toBe(0);
  });

  test("accepts parent-Subthread history in the same Namespace", async () => {
    let authorityUses = 0;
    const service = repairer({
      entities: Object.freeze({
        use: () => {
          authorityUses += 1;
          return Promise.reject(new Error("must not open authority"));
        },
        useCurrentSet: () => {
          authorityUses += 1;
          return Promise.resolve(Object.freeze({
            status: "unavailable" as const,
            reason: "content_unavailable" as const,
          }));
        },
      }),
      loadSources: (selection) => {
        expect(selection.readableNamespaceIds).toEqual([NAMESPACE_ID]);
        return Promise.resolve([Object.freeze({
          messageId: 41,
          sessionId: SESSION_ID,
          roomId: "10000000-0000-4000-8000-000000000099",
          namespaceId: NAMESPACE_ID,
          revision: 0,
          createdAt: 1_800_000_000_000,
          authorRole: "user" as const,
          authorHumanTurnId: "turn-41",
          sessionAgentId: AGENT_ID,
          mappedCryptoObjectId: null,
          payload: { role: "user" as const, content: "parent Room" },
        })]);
      },
    });

    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "waiting_for_authority",
      reason: "message_namespace_authority_unavailable",
    });
    expect(authorityUses).toBe(1);
  });

  test("rejects a selected Message outside the invocation Namespace", async () => {
    let authorityUses = 0;
    const service = repairer({
      entities: Object.freeze({
        use: () => {
          authorityUses += 1;
          return Promise.reject(new Error("must not open authority"));
        },
        useCurrentSet: () => {
          authorityUses += 1;
          return Promise.reject(new Error("must not open authority"));
        },
      }),
      loadSources: () => Promise.resolve([Object.freeze({
        messageId: 41,
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: "10000000-0000-4000-8000-000000000099",
        revision: 0,
        createdAt: 1_800_000_000_000,
        authorRole: "user" as const,
        authorHumanTurnId: "turn-41",
        sessionAgentId: AGENT_ID,
        mappedCryptoObjectId: null,
        payload: { role: "user" as const, content: "foreign Namespace" },
      })]),
    });

    expect(await service.protect({ messageIds: [41] })).toEqual({
      status: "failed",
      reason: "message_authority_scope_mismatch",
    });
    expect(authorityUses).toBe(0);
  });
});
