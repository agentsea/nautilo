import { describe, expect, mock, test } from "bun:test";
import type { ProtectedTaskWakeAdditionalProjectionAuthority } from
  "../../src/routes/protected-task-wake-foreground-publication";
import {
  PUBLICATION_NAMESPACE,
  withPublicationSigner,
} from "../../../lattice-crypto/tests/fixtures/task-publication-signer.ts";

const realBridgeServer = await import("@nautilo/lattice-bridge/server");
const realBridge = await import("@nautilo/lattice-bridge");
const realRuntime = await import("@nautilo/runtime");
const realAgent = await import("@nautilo/agent");
const realMemory = await import(
  "../../src/routes/foreground-memory-repository"
);

const ownerInputs: unknown[] = [];
const repairs: string[] = [];
const committedRoot = { role: "nautilo_crypto", query: () => Promise.resolve([]) };
const completionHandles: unknown[] = [];
const completionExpectedAgents: Array<string | undefined> = [];
const cryptoOperations: string[] = [];
const verifiedProductHandles: unknown[] = [];
const retainedSignerProducts: unknown[] = [];
const retainedSignerPrincipals: unknown[] = [];
const observedReadSignerKeys: Array<Uint8Array | null> = [];
const historicalSignerKey = new Uint8Array(32).fill(9);
type AgentSignerPrincipal = Readonly<{
  agentId: string;
  runtimeGeneration: number;
  signerKeyId: string;
}>;
const historicalPrincipal: AgentSignerPrincipal = Object.freeze({
  agentId: "agent",
  runtimeGeneration: 2,
  signerKeyId: "historical",
});
let exerciseRepairReadSigner = false;
const memoryEnvelope = Object.freeze({
  ownerId: "human", actorId: "actor", agentId: "agent", roomId: "room",
  readableNamespaces: Object.freeze(["00000000-0000-4000-8000-000000000001"]),
  mutableNamespaces: Object.freeze(["00000000-0000-4000-8000-000000000001"]),
  writableNamespaces: Object.freeze(["00000000-0000-4000-8000-000000000001"]),
  toolPolicy: Object.freeze({}),
});

mock.module("@nautilo/lattice-bridge", () => ({
  ...realBridge,
  createDormantConversationShadowRepository: () => ({}),
}));

mock.module("@nautilo/lattice-bridge/server", () => ({
  ...realBridgeServer,
  verifyConversationProductPostgresHandle: async (value: unknown) => {
    verifiedProductHandles.push(value);
    return value;
  },
  verifyCryptoPostgresHandle: async (value: unknown) => value,
  bindConversationProductCanonicalTransactionRunner: () => ({
    role: "nautilo_agent",
    transaction: async () => undefined,
  }),
  PostgresHumanDeviceSignerHistory: class {
    resolveHistoricalObjectSigner = () => null;
    resolveAgentRuntimeSignerManager = () => null;
  },
  PostgresDomainKeyAuthorityRepository: class {},
  PostgresLatticeStorage: class {},
  createPostgresConversationCryptoCompletion: (input: { handle: unknown; commonManifestExpectedAgentId?: string }) => {
    completionHandles.push(input.handle);
    completionExpectedAgents.push(input.commonManifestExpectedAgentId);
    return {};
  },
  createPostgresForegroundAgentSignerResolver: (input: { product: unknown }) => {
    retainedSignerProducts.push(input.product);
    return async (principal: AgentSignerPrincipal) => {
      retainedSignerPrincipals.push(principal);
      return principal.agentId === historicalPrincipal.agentId
          && principal.runtimeGeneration === historicalPrincipal.runtimeGeneration
          && principal.signerKeyId === historicalPrincipal.signerKeyId
        ? historicalSignerKey.slice()
        : null;
    };
  },
  createPostgresForegroundJournalSelectionPort: () => ({}),
  persistDeviceWrappedAgentObject: async (input: { handle: unknown }) => {
    expect(input.handle).toBe(committedRoot);
    cryptoOperations.push("persist");
    return "created";
  },
  readVerifiedDeviceWrappedAgentObject: async (input: {
    resolveLiveShadowAgentSigner(principal: AgentSignerPrincipal):
      Promise<Uint8Array | null> | Uint8Array | null;
  }) => {
    cryptoOperations.push("read");
    if (exerciseRepairReadSigner) {
      observedReadSignerKeys.push(
        await input.resolveLiveShadowAgentSigner(historicalPrincipal),
      );
    }
    return null;
  },
  createForegroundMessageHistoryRepairer: (input: {
    resolveLiveShadowAgentSigner(principal: AgentSignerPrincipal):
      Promise<Uint8Array | null> | Uint8Array | null;
  }) => ({
    protect: async () => {
      repairs.push("history");
      if (exerciseRepairReadSigner) {
        observedReadSignerKeys.push(
          await input.resolveLiveShadowAgentSigner(historicalPrincipal),
        );
      }
      return { status: "verified" };
    },
  }),
}));

mock.module("@nautilo/runtime", () => ({
  ...realRuntime,
  createForegroundJournalHistoryRepairer: (input: { read(value: unknown): Promise<unknown> }) => ({
    protect: async () => {
      repairs.push("journal");
      if (exerciseRepairReadSigner) await input.read({});
      return { status: "verified" };
    },
  }),
  createForegroundRecordHistoryRepairer: (input: { read(value: unknown): Promise<unknown> }) => ({
    protect: async () => {
      repairs.push("records");
      if (exerciseRepairReadSigner) await input.read({});
      return { status: "verified" };
    },
  }),
  createForegroundMemoryHistoryRepairer: (input: { read(value: unknown): Promise<unknown> }) => ({
    protect: async () => {
      repairs.push("memories");
      if (exerciseRepairReadSigner) await input.read({});
      return { status: "verified" };
    },
  }),
}));

const projectionStub: Awaited<ReturnType<typeof realMemory.createForegroundMemoryProjectionPort>> = Object.freeze({
  prepare: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
  publish: async () => ({ status: "unavailable" as const, reason: "authorization_required" as const }),
});
const projectionHandoff = Object.freeze({ kind: "protected-handoff" });
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  createProtectedTaskMemoryProjectionPort: (handoff: unknown) => {
    expect(handoff).toBe(projectionHandoff);
    return projectionStub;
  },
}));
mock.module("../../src/routes/foreground-memory-repository", () => ({
  ...realMemory,
  createForegroundMemoryRepository: async (input: unknown) => {
    ownerInputs.push(input);
    return { kind: "repository" };
  },
  createForegroundMemoryAccessPort: async (input: unknown) => {
    ownerInputs.push(input);
    return { kind: "access" };
  },
  createForegroundProtectedTaskMemoryProjection: async (input: unknown) => {
    ownerInputs.push(input);
    return projectionHandoff;
  },
}));

mock.module("../../src/routes/foreground-message-product-store", () => ({
  createForegroundProductTransactionContext: async () => ({
    handle: { role: "nautilo_agent" },
    canonicalRunner: {},
  }),
}));

const { createProtectedTaskWakeForegroundServices } = await import(
  "../../src/routes/protected-task-wake-foreground-services"
);

describe("protected Task wake foreground services", () => {
  test("does not assemble protected services for a Plain policy", () => {
    expect(() => createProtectedTaskWakeForegroundServices({
      context: { enforcementPolicy: { mode: "plaintext_only" },
        memoryAccessEnvelope: { ownerId: "human", agentId: "agent" } },
      lifecycle: { scheduling: { requestorId: "human", agentId: "agent" } },
      publication: { wakeEvidence: {} },
    } as never)).toThrow("Wake foreground service identity changed");
  });

  test("retains a positive authenticated capsule revision with a certified signer", async () => {
    await withPublicationSigner(async ({ crypto, evidence, signer }) => {
      const common = {
        crypto, restricted: committedRoot, serverScope: "server",
        wakeEffectRecovery() {},
        lifecycle: { scheduling: {
          taskId: evidence.invocation.reference.taskId,
          taskRunId: evidence.invocation.reference.taskRunId,
          graphThreadId: "thread", namespaceId: PUBLICATION_NAMESPACE,
          roomId: evidence.sourceRoomId, agentId: evidence.signerAgentId,
          requestorId: "human",
        } },
        publication: {
          plan: { intent: { contentNamespaceId: PUBLICATION_NAMESPACE },
            foregroundNamespaceIds: [PUBLICATION_NAMESPACE] },
          wakeEvidence: evidence,
        },
        entities: {},
        signer: { agentAuthorizationRevision: 0, runtime: signer.runtime,
          signerPublication: null, temporarySigner: signer },
        resolveHistoricalSignerPublicationManager: () => null,
      };
      const context = {
        enforcementPolicy: { mode: "encrypted_only" as const,
          shadowBehavior: "strict" as const, revision: 7 },
        memoryAccessEnvelope: { ownerId: "human",
          actorId: evidence.requesterHumanId, agentId: evidence.signerAgentId,
          roomId: evidence.sourceRoomId,
          readableNamespaces: [PUBLICATION_NAMESPACE],
          mutableNamespaces: [PUBLICATION_NAMESPACE],
          writableNamespaces: [PUBLICATION_NAMESPACE], toolPolicy: {} },
        checkpointBinding: { retainedSourceNamespaceIds: [PUBLICATION_NAMESPACE],
          sourceEnvelopeDigest: new Uint8Array(32), initialPolicyRevision: 7,
          initialAgentAuthorizationRevision: 11 },
        continuation: { segment: 1, checkpointThreadId: "wake:thread",
          resume: { interruptId: "projection:interrupt",
            authorizationRequestId: "projection:authorization",
            effectDisposition: "not_started_v1" as const,
            operationId: "projection:operation",
            requestDigest: new Uint8Array(32).fill(7),
            requiredAuthorityDigest: new Uint8Array(32).fill(8) } },
      };
      expect(Object.keys(await createProtectedTaskWakeForegroundServices({
        ...common, context,
      } as never))).toHaveLength(7);
      expect(() => createProtectedTaskWakeForegroundServices({
        ...common,
        context: { ...context, continuation: undefined },
      } as never)).toThrow("Wake foreground checkpoint binding changed");
    }, { recipientGeneration: 1 });
  });

  test("rejects substituted or ordinary-listed additional destination authority", () => {
    const foreground = "00000000-0000-4000-8000-000000000001";
    const additional = "00000000-0000-4000-8000-000000000002";
    const base = {
      crypto: {}, restricted: committedRoot, serverScope: "server",
      wakeEffectRecovery() {},
      lifecycle: { scheduling: { taskId: "task", taskRunId: "run",
        graphThreadId: "thread", namespaceId: foreground, roomId: "room",
        agentId: "agent", requestorId: "human" } },
      context: { enforcementPolicy: { mode: "encrypted_only",
        shadowBehavior: "strict", revision: 4 }, memoryAccessEnvelope: memoryEnvelope,
        checkpointBinding: { retainedSourceNamespaceIds: [foreground],
          sourceEnvelopeDigest: new Uint8Array(32), initialPolicyRevision: 4,
          initialAgentAuthorizationRevision: 2 } },
      publication: { plan: { foregroundNamespaceIds: [foreground],
        additionalMutationDestination: { roomId: "additional-room",
          namespaceId: additional, semanticDigest: "ab".repeat(32) } },
        wakeEvidence: { policyRevision: 4,
          namespaceRequirements: [{ namespaceId: foreground,
            expectedPolicyRevision: 4, operations: ["decrypt", "encrypt"] }],
          additionalMutationDestination: { roomId: "additional-room",
            semanticDigest: "ab".repeat(32), namespace: { namespaceId: additional,
              expectedPolicyRevision: 4, operations: ["encrypt"] } } } },
      entities: {}, signer: {},
      resolveHistoricalSignerPublicationManager: () => null,
    };
    const changes = [
      { roomId: "changed-room" },
      { namespaceId: "00000000-0000-4000-8000-000000000003" },
      { semanticDigest: "cd".repeat(32) },
    ];
    for (const change of changes) {
      expect(() => createProtectedTaskWakeForegroundServices({ ...base,
        publication: { ...base.publication, plan: { ...base.publication.plan,
          additionalMutationDestination: {
            ...base.publication.plan.additionalMutationDestination, ...change,
          } } } } as never)).toThrow(
        "Wake projection destination authority changed",
      );
    }
    expect(() => createProtectedTaskWakeForegroundServices({ ...base,
      publication: { ...base.publication, wakeEvidence: {
        ...base.publication.wakeEvidence,
        namespaceRequirements: [
          ...base.publication.wakeEvidence.namespaceRequirements,
          { namespaceId: additional, expectedPolicyRevision: 4,
            operations: ["decrypt", "encrypt"] },
        ],
      } } } as never)).toThrow("Wake projection destination authority changed");
    expect(() => createProtectedTaskWakeForegroundServices({ ...base,
      publication: { ...base.publication, wakeEvidence: {
        ...base.publication.wakeEvidence,
        namespaceRequirements: [
          ...base.publication.wakeEvidence.namespaceRequirements,
          ...base.publication.wakeEvidence.namespaceRequirements,
        ],
      } } } as never)).toThrow(
        "Protected Task semantic authority requirements are malformed",
      );
  });

  test.each([
    "00000000-0000-4000-8000-000000000000",
    "00000000-0000-4000-8000-000000000002",
  ])("builds scoped ports with additional destination %s before or after sources", async additional => {
    ownerInputs.length = 0;
    repairs.length = 0;
    cryptoOperations.length = 0;
    verifiedProductHandles.length = 0;
    retainedSignerProducts.length = 0;
    retainedSignerPrincipals.length = 0;
    let current = true;
    let writerLoans = 0;
    let currentAssertions = 0;
    const projectionDestinations: unknown[] = [];
    const plannedProjectionDestinations: unknown[] = [];
    const additionalCaptures: unknown[] = [];
    const lifecycle = {
      scheduling: {
        taskId: "task",
        taskRunId: "run",
        graphThreadId: "thread",
        namespaceId: "00000000-0000-4000-8000-000000000001",
        roomId: "room",
        agentId: "agent",
        requestorId: "human",
      },
      withProjectionDestination: async ({ destination }: { destination: unknown }) => ({
        destinationAuthorityDigest: (plannedProjectionDestinations.push(destination),
          new Uint8Array(32)),
      }),
      withCurrentWriter: async ({ use, projectionDestination }: {
        use(value: unknown): Promise<unknown>;
        projectionDestination?: unknown;
      }) => {
        if (!current) return null;
        writerLoans += 1;
        if (projectionDestination !== undefined) {
          projectionDestinations.push(projectionDestination);
        }
        return use({
          productStore: {},
          product: { role: "nautilo_agent", generation: writerLoans,
            query: () => Promise.resolve([]) },
          restricted: { role: "nautilo_crypto", generation: writerLoans,
            query: () => Promise.resolve([]) },
          transaction: {},
          assertCurrent: () => {
            currentAssertions += 1;
            return Promise.resolve();
          },
          resolveCurrentAgentObjectWrite: () => Promise.resolve(null),
          resolveCurrentForegroundEntityObjectWrite: () => Promise.resolve(null),
        });
      },
    };
    const services = await createProtectedTaskWakeForegroundServices({
      crypto: {},
      restricted: committedRoot,
      serverScope: "server",
      wakeEffectRecovery() {},
      lifecycle,
      context: {
        enforcementPolicy: { mode: "encrypted_only", shadowBehavior: "strict",
          revision: 4 },
        memoryAccessEnvelope: memoryEnvelope,
        checkpointBinding: {
          retainedSourceNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
          sourceEnvelopeDigest: new Uint8Array(32),
          initialPolicyRevision: 4,
          initialAgentAuthorizationRevision: 2,
        },
        continuation: { segment: 2, checkpointThreadId: "wake:thread",
          resume: { interruptId: "projection:interrupt",
            authorizationRequestId: "projection:authorization",
            effectDisposition: "not_started_v1", operationId: "projection:operation",
            requestDigest: new Uint8Array(32).fill(7),
            requiredAuthorityDigest: new Uint8Array(32).fill(8) } },
      },
      publication: {
        plan: { intent: { contentNamespaceId:
          "00000000-0000-4000-8000-000000000003" }, foregroundNamespaceIds: [
          "00000000-0000-4000-8000-000000000001",
        ], additionalMutationDestination: {
          roomId: "additional-room",
          namespaceId: additional,
          semanticDigest: "ab".repeat(32),
        } },
        wakeEvidence: {
          invocation: { operationId: "operation" },
          requestId: "request",
          authorizationDigest: new Uint8Array(32),
          recipientKeyId: "recipient",
          policyRevision: 4,
          signerAgentId: "agent",
          additionalMutationDestination: {
            roomId: "additional-room",
            semanticDigest: "ab".repeat(32),
            namespace: {
              ordinal: 1,
              namespaceId: additional,
              domainId: "additional-domain",
              expectedAccessRevision: 3,
              expectedPolicyRevision: 4,
              operations: ["encrypt"],
            },
          },
          namespaceRequirements: [{
            namespaceId: "00000000-0000-4000-8000-000000000001",
            expectedPolicyRevision: 4,
            operations: ["decrypt", "encrypt"],
          }],
        },
      },
      entities: {},
      signer: {
        agentAuthorizationRevision: 2,
        runtime: { generation: 3 },
        signerPublication: { signerKeyId: "signer",
          signerPublicKey: new Uint8Array(32) },
      },
      resolveHistoricalSignerPublicationManager: () => null,
      onAdditionalProjectionAuthority: (capture: ProtectedTaskWakeAdditionalProjectionAuthority) => {
        additionalCaptures.push(capture);
      },
    } as never);

    expect(Object.keys(services).sort()).toEqual([
      "createForegroundMemoryAccessPort",
      "createForegroundMemoryProjectionPort",
      "createForegroundMemoryRepository",
      "protectForegroundHistory",
      "protectForegroundJournal",
      "protectForegroundMemories",
      "protectForegroundRecords",
    ]);
    await services.createForegroundMemoryRepository({} as never);
    await services.createForegroundMemoryAccessPort({} as never);
    const projection = await services.createForegroundMemoryProjectionPort(
      {} as never,
    );
    expect(ownerInputs).toHaveLength(3);
    const repositoryInput = ownerInputs[0] as {
      domain: {
        persist(prepared: unknown): Promise<unknown>;
        read(request: unknown): Promise<unknown>;
      };
      withCurrentPublication(input: Readonly<{
        authority: unknown;
        mutation: boolean;
        use(assertCurrent: () => Promise<void>): Promise<unknown>;
      }>): Promise<unknown>;
    };
    expect(Object.hasOwn(repositoryInput, "withCurrentProduct")).toBeFalse();
    expect(await repositoryInput.withCurrentPublication({
      authority: {
        mode: "namespace", subjectUserId: "human", agentId: "agent",
        readableNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
        mutableNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
        writableNamespaceId: "00000000-0000-4000-8000-000000000001",
      },
      mutation: true,
      use: async assertCurrent => {
        await assertCurrent();
        return { receipt: true };
      },
    })).toEqual({ receipt: true });
    expect(currentAssertions).toBe(3);
    expect(await repositoryInput.domain.persist({})).toBe("created");
    expect(await repositoryInput.domain.read({})).toBeNull();
    expect(cryptoOperations).toEqual(["persist", "read"]);
    expect(repositoryInput.withCurrentPublication({
      authority: {
        mode: "namespace", subjectUserId: "human", agentId: "other-agent",
        readableNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
        mutableNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
        writableNamespaceId: "00000000-0000-4000-8000-000000000001",
      },
      mutation: false,
      use: async () => ({ escaped: true }),
    })).rejects.toThrow("Wake Memory product authority changed");
    const accessInput = ownerInputs[1] as {
      domain: { persist(prepared: unknown): Promise<unknown> };
      withCurrentExactAccess(
        use: (current: unknown) => Promise<unknown>,
      ): Promise<unknown>;
    };
    const accessOwner = accessInput.withCurrentExactAccess;
    expect(await accessOwner(async value => {
      const current = value as {
        productContext: { handle: { role: string } };
        assertCurrentAuthority(): Promise<void>;
        exact: {
          resolveLiveShadowAgentSigner(principal: AgentSignerPrincipal):
            Promise<Uint8Array | null> | Uint8Array | null;
          resolveCurrentAgentSigner(principal: AgentSignerPrincipal):
            Promise<Uint8Array | null> | Uint8Array | null;
        };
      };
      await current.assertCurrentAuthority();
      expect(await accessInput.domain.persist({})).toBe("created");
      const currentPrincipal = {
        agentId: "agent",
        runtimeGeneration: 3,
        signerKeyId: "signer",
      };
      const fallbackCalls = retainedSignerPrincipals.length;
      expect(await current.exact.resolveLiveShadowAgentSigner(currentPrincipal))
        .toEqual(new Uint8Array(32));
      expect(retainedSignerPrincipals).toHaveLength(fallbackCalls);
      expect(await current.exact.resolveLiveShadowAgentSigner(historicalPrincipal))
        .toEqual(historicalSignerKey);
      expect(await current.exact.resolveLiveShadowAgentSigner({
        ...historicalPrincipal,
        signerKeyId: "unknown",
      })).toBeNull();
      expect(await current.exact.resolveCurrentAgentSigner(currentPrincipal))
        .toEqual(new Uint8Array(32));
      expect(await current.exact.resolveCurrentAgentSigner(historicalPrincipal))
        .toBeNull();
      return current.productContext.handle.role;
    })).toBe("nautilo_agent");
    expect(retainedSignerProducts.length).toBeGreaterThanOrEqual(2);
    for (const product of retainedSignerProducts) {
      expect(verifiedProductHandles).toContain(product);
    }
    expect(cryptoOperations).toEqual(["persist", "read", "persist"]);
    expect(currentAssertions).toBe(6);
    expect(projection).toBe(projectionStub);
    const projectionInput = ownerInputs[2] as {
      domain: { persist(prepared: unknown): Promise<unknown> };
      task: unknown;
      originalCapsuleBinding: unknown;
      continuedAdditionalAuthority: unknown;
      currentSemanticAuthorityRequirements: unknown;
      withCurrentSource(
        use: (assertCurrent: () => Promise<void>) => Promise<unknown>,
      ): Promise<unknown>;
      planDestination(input: Readonly<{
        destination: unknown;
        targetAuthority: unknown;
      }>): Promise<unknown>;
      onAdditionalAuthority(
        plan: unknown,
        destination: unknown,
      ): void;
      withCurrentProjection(input: Readonly<{
        destination: unknown;
        targetAuthority: unknown;
        mutation: boolean;
        use(assertCurrent: () => Promise<void>): Promise<unknown>;
      }>): Promise<unknown>;
    };
    expect(projectionInput.task).toEqual({ taskId: "task", taskRunId: "run",
      graphThreadId: "thread" });
    expect(projectionInput.originalCapsuleBinding).toEqual({
      policyRevision: 4, agentAuthorizationRevision: 2,
    });
    expect(projectionInput.continuedAdditionalAuthority).toEqual({
      authorizationRequestId: "projection:authorization",
      effectDisposition: "not_started_v1",
      operationId: "projection:operation",
      requestDigest: new Uint8Array(32).fill(7),
      requiredAuthorityDigest: new Uint8Array(32).fill(8),
    });
    expect(projectionInput.currentSemanticAuthorityRequirements).toEqual([{
      namespaceId: "00000000-0000-4000-8000-000000000001",
      operations: ["decrypt", "encrypt"],
    }, {
      namespaceId: additional,
      operations: ["encrypt"],
    }].sort((left, right) => left.namespaceId < right.namespaceId ? -1 : 1));
    const destination = { roomId: "other-room", namespaceId: "00000000-0000-4000-8000-000000000001",
      label: "Other room", kind: "group", memberCount: 2,
      audienceFingerprint: "audience" } as const;
    const targetAuthority = { mode: "namespace", subjectUserId: "human",
      agentId: "agent", readableNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
      mutableNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
      writableNamespaceId: "00000000-0000-4000-8000-000000000001" } as const;
    let escapedProjectionAssertion: (() => Promise<void>) | undefined;
    expect(await projectionInput.withCurrentProjection({ destination,
      targetAuthority, mutation: true, use: async assertCurrent => {
        escapedProjectionAssertion = assertCurrent;
        await assertCurrent();
        expect(await projectionInput.domain.persist({})).toBe("created");
        return { current: true };
      } })).toEqual({ current: true });
    expect(projectionDestinations).toEqual([destination]);
    expect(escapedProjectionAssertion!()).rejects.toThrow(
      "Wake projection writer authority escaped",
    );
    expect(currentAssertions).toBe(11);
    expect(cryptoOperations).toEqual(["persist", "read", "persist", "persist"]);
    expect(await projectionInput.withCurrentProjection({
      destination: { ...destination, namespaceId: "outside-grant" },
      targetAuthority: { ...targetAuthority,
        readableNamespaceIds: ["outside-grant"],
        mutableNamespaceIds: ["outside-grant"],
        writableNamespaceId: "outside-grant" },
      mutation: false,
      use: async () => ({ escaped: true }),
    })).toBeNull();
    const additionalDestination = { roomId: "additional-room",
      namespaceId: additional,
      label: "Additional room", kind: "group", memberCount: 2,
      audienceFingerprint: "additional-audience" } as const;
    const additionalAuthority = { ...targetAuthority,
      readableNamespaceIds: [additional],
      mutableNamespaceIds: [additional],
      writableNamespaceId: additional } as const;
    expect(await projectionInput.withCurrentProjection({
      destination: additionalDestination, targetAuthority: additionalAuthority,
      mutation: true, use: async assertCurrent => {
        await assertCurrent();
        return "additional";
      },
    })).toBe("additional");
    expect(await projectionInput.planDestination({ destination: additionalDestination,
      targetAuthority: additionalAuthority })).toEqual({
        destinationAuthorityDigest: new Uint8Array(32),
      });
    expect(plannedProjectionDestinations).toEqual([additionalDestination]);
    const requestDigest = new Uint8Array(32).fill(7);
    const destinationAuthorityDigest = new Uint8Array(32).fill(9);
    projectionInput.onAdditionalAuthority({
      kind: "additional_authority_v1", requestDigest,
      semanticAuthorityRequirements: [{
        namespaceId: additional,
        operations: ["encrypt"],
      }],
    }, { destinationRoomId: "additional-room",
      namespaceId: additional,
      destinationAuthorityDigest });
    requestDigest.fill(0);
    destinationAuthorityDigest.fill(0);
    expect(additionalCaptures).toHaveLength(1);
    expect(additionalCaptures[0]).toMatchObject({
      plan: { kind: "additional_authority_v1" },
      destination: { destinationRoomId: "additional-room" },
      checkpointBinding: { initialPolicyRevision: 4,
        initialAgentAuthorizationRevision: 2 },
    });
    expect((additionalCaptures[0] as { plan: { requestDigest: Uint8Array } })
      .plan.requestDigest).toEqual(new Uint8Array(32).fill(7));
    expect((additionalCaptures[0] as { destination: {
      destinationAuthorityDigest: Uint8Array } }).destination
      .destinationAuthorityDigest).toEqual(new Uint8Array(32).fill(9));
    expect(writerLoans).toBe(6);
    current = false;
    expect(accessOwner(async () => "escaped")).rejects.toThrow(
      "Wake foreground writer authority changed",
    );
    expect(writerLoans).toBe(6);
  });

  test("keeps each repair inside one nonescaping current-writer callback", async () => {
    repairs.length = 0;
    completionHandles.length = 0;
    completionExpectedAgents.length = 0;
    retainedSignerPrincipals.length = 0;
    observedReadSignerKeys.length = 0;
    exerciseRepairReadSigner = true;
    let loans = 0;
    let open = false;
    const services = await createProtectedTaskWakeForegroundServices({
      crypto: {}, restricted: committedRoot, serverScope: "server", wakeEffectRecovery() {},
      lifecycle: {
        scheduling: { taskId: "task", taskRunId: "run", graphThreadId: "thread",
          namespaceId: "00000000-0000-4000-8000-000000000001", roomId: "room",
          agentId: "agent", requestorId: "human" },
        withProjectionDestination: async () => ({
          destinationAuthorityDigest: new Uint8Array(32),
        }),
        withCurrentWriter: async ({ use }: { use(value: unknown): Promise<unknown> }) => {
          loans += 1;
          open = true;
          try {
            return await use({ productStore: {},
              product: { role: "nautilo_agent", query: () => Promise.resolve([]) },
              restricted: { role: "nautilo_crypto", query: () => Promise.resolve([]) },
              transaction: {},
              assertCurrent: () => Promise.resolve(),
              resolveCurrentAgentObjectWrite: () => Promise.resolve(null),
              resolveCurrentForegroundEntityObjectWrite: () => Promise.resolve(null) });
          } finally { open = false; }
        },
      },
      context: { enforcementPolicy: { mode: "encrypted_only",
        shadowBehavior: "strict", revision: 4 },
        memoryAccessEnvelope: memoryEnvelope,
        checkpointBinding: { retainedSourceNamespaceIds: ["00000000-0000-4000-8000-000000000001"],
          sourceEnvelopeDigest: new Uint8Array(32), initialPolicyRevision: 4,
          initialAgentAuthorizationRevision: 2 } },
      publication: { plan: { foregroundNamespaceIds: [
        "00000000-0000-4000-8000-000000000001",
      ] }, wakeEvidence: { invocation: { operationId: "operation" },
        requestId: "request", authorizationDigest: new Uint8Array(32),
        recipientKeyId: "recipient", policyRevision: 4,
        signerAgentId: "agent", namespaceRequirements: [{
          namespaceId: "00000000-0000-4000-8000-000000000001",
          expectedPolicyRevision: 4, operations: ["decrypt", "encrypt"],
        }] } },
      entities: {},
      signer: { agentAuthorizationRevision: 2, runtime: { generation: 3 },
        signerPublication: { signerKeyId: "signer",
          signerPublicKey: new Uint8Array(32) } },
      resolveHistoricalSignerPublicationManager: () => null,
    } as never);
    const expected = ["history", "journal", "records", "memories"];
    try {
      for (const [index, repair] of [services.protectForegroundHistory,
        services.protectForegroundJournal, services.protectForegroundRecords,
        services.protectForegroundMemories].entries()) {
        expect(open).toBeFalse();
        await repair({} as never);
        expect(repairs[index]).toBe(expected[index]);
        expect(open).toBeFalse();
      }
    } finally {
      exerciseRepairReadSigner = false;
    }
    expect(loans).toBe(4);
    expect(completionHandles).toEqual([committedRoot]);
    expect(completionExpectedAgents).toEqual(["agent"]);
    expect(observedReadSignerKeys).toEqual([
      historicalSignerKey,
      historicalSignerKey,
      historicalSignerKey,
      historicalSignerKey,
    ]);
    expect(retainedSignerPrincipals).toEqual([
      historicalPrincipal,
      historicalPrincipal,
      historicalPrincipal,
      historicalPrincipal,
    ]);
  });
});
