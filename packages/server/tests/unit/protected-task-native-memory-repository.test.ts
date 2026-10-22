import { describe, expect, test } from "bun:test";
import type {
  ProtectedTaskMemoryAccessHandoff,
  ProtectedTaskMemoryProjectionHandoff,
} from "@nautilo/agent";
import type {
  ProtectedAgentMemoryRepository,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import {
  bindEncryptionDataOperationOwner,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "@nautilo/lattice-bridge";
import type {
  ForegroundMemoryRepairSource,
  ProtectedTaskMemoryReadPort,
  TaskNamespaceMemoryRepairSource,
  TaskScopeMemoryRepairSource,
} from "@nautilo/lattice-bridge/server";

import {
  withProtectedTaskNativeMemoryRepository,
  type ProtectedTaskNativeMemoryRepositoryInput,
} from "../../src/routes/protected-task-native-memory-repository";
import {
  createProtectedTaskMemoryRepository,
} from "../../src/routes/protected-task-memory-composition";
import type {
  ProtectedTaskMemoryExactAccessInput,
} from "../../src/routes/protected-task-memory-exact-access";
import type {
  HeldProtectedTaskMemoryAuthority,
  ProtectedTaskMemoryAuthorityInput,
} from "../../src/routes/current-protected-task-memory-authority";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const NAMESPACE = "33333333-3333-4333-8333-333333333333";
const OTHER_NAMESPACE = "44444444-4444-4444-8444-444444444444";
const SCOPE = "55555555-5555-4555-8555-555555555555";
const MEMORY_ROOM = "66666666-6666-4666-8666-666666666666";
const MEMORY = "77777777-7777-4777-8777-777777777777";
const TARGET_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_ACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const authority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([NAMESPACE]),
  mutableNamespaceIds: Object.freeze([NAMESPACE]),
  writableNamespaceId: NAMESPACE,
}) satisfies ProtectedMemoryAuthority;

function fixture(
  mode: "shadow_encryption" | "encrypted_only" = "encrypted_only",
): ProtectedTaskNativeMemoryRepositoryInput<string> {
  const runner = Object.freeze({ role: "nautilo" });
  const evidence = Object.freeze({
    policyRevision: 7,
    namespaceRequirements: Object.freeze([Object.freeze({
      ordinal: 0,
      namespaceId: NAMESPACE,
      domainId: "domain-1",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 7,
      operations: Object.freeze(["decrypt" as const, "encrypt" as const]),
    })]),
    result: Object.freeze({ signerAgentId: AGENT }),
  });
  const current = {
    runner,
    restricted: Object.freeze({}),
    crypto: Object.freeze({}),
    serverScope: "https://nautilo.example",
    subject: Object.freeze({ userId: USER,
      humanActorId: "99999999-9999-4999-8999-999999999999" }),
    occurrence: Object.freeze({
      task: Object.freeze({
        id: "88888888-8888-4888-8888-888888888888",
        agentId: AGENT,
        contentNamespaceId: NAMESPACE,
      }),
      run: Object.freeze({
        id: "99999999-9999-4999-8999-999999999998",
        graphThreadId: "thread-1",
      }),
    }),
    evidence,
    signal: new AbortController().signal,
  } as unknown as ProtectedTaskMemoryAuthorityInput;
  return {
    authority,
    policy: Object.freeze({
      mode,
      shadowBehavior: mode === "shadow_encryption" ? "fallback" : "strict",
      revision: 7,
    }),
    current,
    domains: Object.freeze([]),
    signer: Object.freeze({
      agentAuthorizationRevision: 3,
      runtime: Object.freeze({ agentId: AGENT, generation: 1 }),
      signerPublication: Object.freeze({ agentId: AGENT,
        signerKeyId: "signer-1", signerPublicKey: new Uint8Array(32) }),
    }) as ProtectedTaskNativeMemoryRepositoryInput<string>["signer"],
    resolveHistoricalSignerPublicationManager: async () => null,
    product: Object.freeze({
      handle: Object.freeze({ role: "nautilo" }),
      canonicalRunner: runner,
    }) as ProtectedTaskNativeMemoryRepositoryInput<string>["product"],
    agentProduct: Object.freeze({
      handle: Object.freeze({ role: "nautilo_agent" }),
      canonicalRunner: Object.freeze({}),
    }) as ProtectedTaskNativeMemoryRepositoryInput<string>["agentProduct"],
    owner: Object.freeze({}),
    embedding: Object.freeze({}),
    execute: async () => "assembled",
  } as unknown as ProtectedTaskNativeMemoryRepositoryInput<string>;
}

type Overrides = NonNullable<Parameters<
  typeof withProtectedTaskNativeMemoryRepository
>[1]>;
type Dependency<Key extends keyof Overrides> = NonNullable<Overrides[Key]>;
type ProductHandle =
  ProtectedTaskNativeMemoryRepositoryInput<string>["product"]["handle"];
type ExactCrypto = ReturnType<Dependency<"createExactCrypto">>;
type ExactProduct = ReturnType<Dependency<"createExactProduct">>;

function held(
  input: ProtectedTaskNativeMemoryRepositoryInput<unknown>,
  revision = input.policy.revision,
): HeldProtectedTaskMemoryAuthority {
  return {
    policy: Object.freeze({ ...input.policy, revision }),
    assertCurrent: () => Promise.resolve(),
  } as unknown as HeldProtectedTaskMemoryAuthority;
}

function assemblyOverrides(
  input: ProtectedTaskNativeMemoryRepositoryInput<string>,
  events: string[],
  suppliedEntitySignal?: AbortSignal,
): Overrides {
  const repository = Object.freeze({}) as ProtectedAgentMemoryRepository;
  type Session = ReturnType<Dependency<"createSession">>;
  const session = Object.freeze({}) as Session["session"];
  const completion = Object.freeze({}) as Session["completion"];
  const readPreparedPayload = () => Object.freeze({
    formatVersion: 1 as const,
    content: "shadow",
    type: "fact",
  });
  const entitySignal = suppliedEntitySignal ?? new AbortController().signal;
  const projection = Object.freeze({}) as ProtectedTaskMemoryProjectionHandoff;
  const readPort: ProtectedTaskMemoryReadPort = Object.freeze({
    searchProtectedCandidates: async () => Object.freeze({
      status: "success" as const, value: Object.freeze([]),
    }),
    searchCandidates: async () => Object.freeze({
      status: "success" as const, value: Object.freeze([]),
    }),
    loadExactCandidates: async () => Object.freeze({
      status: "success" as const, value: Object.freeze([]),
    }),
    loadExactProtectedSources: async () => Object.freeze({
      status: "success" as const, value: Object.freeze([]),
    }),
    loadExactOrdinary: async () => Object.freeze({
      status: "success" as const, value: Object.freeze([]),
    }),
  });
  return {
    withCurrentAuthority: (async (_, use) => {
      events.push("authority");
      return use(held(input));
    }) as Dependency<"withCurrentAuthority">,
    withEntityCrypto: (async native => {
      events.push("entity-custody");
      await native.assertCurrentTaskAuthority();
      return native.execute(Object.freeze({ signal: entitySignal }) as never);
    }) as Dependency<"withEntityCrypto">,
    createFallback: () => async request => ({ status: "unavailable", reason: request.reason }),
    createSession: sessionInput => {
      events.push("session");
      expect(sessionInput.evidence).toBe(input.current.evidence);
      return Object.freeze({
        session,
        completion,
        readPreparedPayload,
        protectExactRepair: async () => Object.freeze({
          status: "failed" as const,
          reason: "test repair is unavailable",
        }),
      }) as Session;
    },
    createBoundaries: boundaryInput => {
      events.push("boundaries");
      expect(boundaryInput.current).not.toBe(input.current);
      expect(boundaryInput.current.signal).toBe(entitySignal);
      if (input.policy.mode === "shadow_encryption") {
        expect(boundaryInput.readPreparedPayload).toBe(readPreparedPayload);
      } else {
        expect(boundaryInput.readPreparedPayload).toBeUndefined();
      }
      return Object.freeze({
        authority,
        policy: input.policy,
        publication: Object.freeze({}),
        read: Object.freeze({}),
      }) as ReturnType<Dependency<"createBoundaries">>;
    },
    createProduct: productInput => {
      events.push("product");
      expect(productInput.cryptoCompletion).toBe(completion);
      return Object.freeze({}) as never;
    },
    createRepository: repositoryInput => {
      events.push("repository");
      expect(repositoryInput.crypto).toBe(session);
      expect(repositoryInput.read.handle).toBe(input.product.handle);
      expect(repositoryInput.reader).toBe(readPort);
      expect(repositoryInput.signal).toBe(entitySignal);
      return repository;
    },
    createReader: () => readPort,
    createProjection: projectionInput => {
      expect(projectionInput.current.signal).toBe(entitySignal);
      expect(projectionInput.sourceProduct).toBeDefined();
      return projection;
    },
    assertHeldAccessNamespace: () => Promise.resolve(true),
  } as Overrides;
}

type RepairExactCandidate = Parameters<
  Dependency<"createRepository">
>[0]["repairExactCandidate"];
type RepairRequest = Parameters<RepairExactCandidate>[0];
type RepairResult = Awaited<ReturnType<RepairExactCandidate>>;
type ProtectExactRepair = ReturnType<
  Dependency<"createSession">
>["protectExactRepair"];

const scopeAuthority = Object.freeze({
  mode: "scope" as const,
  subjectUserId: USER,
  agentId: AGENT,
  scopeId: SCOPE,
  originWritableNamespaceId: NAMESPACE,
});

function scopeFixture(
  mode: "shadow_encryption" | "encrypted_only",
): ProtectedTaskNativeMemoryRepositoryInput<string> {
  const base = fixture(mode);
  return {
    ...base,
    authority: scopeAuthority,
    current: {
      ...base.current,
      scopeMemory: {
        targetRoomId: MEMORY_ROOM,
        workIdentity: "bound work",
        binding: {
          scopeId: SCOPE,
          memoryRoomId: MEMORY_ROOM,
          originWritableNamespaceId: NAMESPACE,
          readableNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
        },
      },
    },
  };
}

function repairRequest(
  repairAuthority: ProtectedMemoryAuthority = scopeAuthority,
): RepairRequest {
  return {
    operationId: "task-scope-memory-repair",
    authority: repairAuthority,
    selection: {
      memoryId: MEMORY,
      contentRevision: 0,
      score: 0.95,
      repairRequired: true,
      repair: {
        id: MEMORY,
        type: null,
        importance: 0.8,
        tier: 1,
        createdAt: new Date(1_700_000_000_000),
        score: 0.95,
        representation: "structural",
      },
    },
  };
}

function reservedNamespaceRepairSource(): Readonly<{
  source: TaskNamespaceMemoryRepairSource;
  plaintextBytes: Uint8Array;
  requestCommitment: Uint8Array;
}> {
  const reserved = reservedRepairSource();
  return Object.freeze({
    source: Object.freeze({
      ...reserved.reservation.source,
      expectedEmbeddingRevision:
        reserved.reservation.source.expectedContentRevision,
    }),
    plaintextBytes: reserved.plaintextBytes,
    requestCommitment: reserved.requestCommitment,
  });
}

function reservedRepairSource(): Readonly<{
  reservation: TaskScopeMemoryRepairSource;
  plaintextBytes: Uint8Array;
  requestCommitment: Uint8Array;
}> {
  const plaintextBytes = new Uint8Array([11, 22, 33, 44]);
  const requestCommitment = new Uint8Array(32).fill(55);
  const source = Object.freeze({
    memory: Object.freeze({
      id: MEMORY,
      type: "fact",
      content: "a retained ordinary body",
      importance: 0.8,
      tier: 1,
      createdAt: new Date(1_700_000_000_000),
    }),
    representationMode: "ordinary-and-protected" as const,
    expectedContentRevision: 0,
    targetContentRevision: 2,
    existingObjectId: null,
    expectedAccessRevision: 0,
    accessNamespaceIds: Object.freeze([NAMESPACE]),
    createdAt: 1_700_000_000_000,
    plaintextBytes,
    requestCommitment,
  }) satisfies ForegroundMemoryRepairSource;
  return Object.freeze({
    reservation: Object.freeze({
      source,
      scopeId: SCOPE,
      expectedScopeOriginNamespaceId: NAMESPACE,
      expectedEmbeddingRevision: 0,
    }),
    plaintextBytes,
    requestCommitment,
  });
}

function accessOwner(
  policy: ProtectedTaskNativeMemoryRepositoryInput<unknown>["policy"],
) {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: async () => Object.freeze({
        policy: Object.freeze({ mode: policy.mode,
          shadowBehavior: policy.shadowBehavior }),
        revalidationToken: policy.revision,
      }),
      revalidate: async () => undefined,
    },
  });
}

function ordinaryAccessCandidate(contentRevision = 0) {
  return Object.freeze({
    memoryId: MEMORY,
    contentRevision,
    cryptoAccessRevision: 0,
    cryptoObjectId: null,
    readNamespaceId: NAMESPACE,
    requiredNamespaceIds: Object.freeze([NAMESPACE]),
    importance: 0.8,
    tier: 1,
    score: 0.95,
    createdAt: new Date(1_700_000_000_000),
    representation: "ordinary_only" as const,
  });
}

function protectedAccessCandidate(contentRevision = 2) {
  return Object.freeze({
    ...ordinaryAccessCandidate(contentRevision),
    cryptoAccessRevision: 1,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY,
      contentRevision,
    }),
    representation: "protected_only" as const,
  });
}

async function invokeScopeRepair(input: Readonly<{
  adopt: Dependency<"adoptScopeOrigin">;
  reserve: Dependency<"reserveScopeRepair">;
  protect: ProtectExactRepair;
  attach: Dependency<"attachScopeRepair">;
}>): Promise<Readonly<{ result: RepairResult; delegated: number }>> {
  const base = scopeFixture("shadow_encryption");
  let captured: RepairExactCandidate | undefined;
  let result: RepairResult | undefined;
  const repositoryInput = {
    ...base,
    execute: async () => {
      result = await captured!(repairRequest());
      return "assembled";
    },
  };
  const overrides = assemblyOverrides(repositoryInput, []);
  const createSession = overrides.createSession!;
  const createRepository = overrides.createRepository!;
  await withProtectedTaskNativeMemoryRepository(repositoryInput, {
    ...overrides,
    adoptScopeOrigin: input.adopt,
    reserveScopeRepair: input.reserve,
    attachScopeRepair: input.attach,
    createSession: request => ({
      ...createSession(request),
      protectExactRepair: input.protect,
    }),
    createRepository: request => {
      captured = request.repairExactCandidate;
      return createRepository(request);
    },
  });
  if (result === undefined) throw new Error("Scope repair was not invoked");
  return Object.freeze({ result, delegated: 0 });
}

describe("protected native Task Memory repository", () => {
  test("constructs ordinary fallback only for Fallback Shadow under the Task publication boundary", async () => {
    for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
      for (const shadowBehavior of ["strict", "fallback"] as const) {
        const base = fixture(mode);
        const input = { ...base, policy: { ...base.policy, shadowBehavior } };
        const overrides = assemblyOverrides(input, []);
        let factories = 0;
        await withProtectedTaskNativeMemoryRepository(input, {
          ...overrides,
          createFallback: fallbackInput => {
            factories += 1;
            expect(fallbackInput.current).toEqual(input.current);
            expect(fallbackInput.agentId).toBe(input.authority.agentId);
            expect(fallbackInput.policy.mode).toBe(mode);
            expect(fallbackInput.policy.shadowBehavior)
              .toBe(input.policy.shadowBehavior);
            expect(fallbackInput.policy.revision).toBe(input.policy.revision);
            return request => Promise.resolve({
              status: "unavailable",
              reason: request.reason,
            });
          },
        });
        expect(factories).toBe(mode === "shadow_encryption" && shadowBehavior === "fallback" ? 1 : 0);
      }
    }
  });

  for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
    test(`assembles one callback-scoped ${mode} repository`, async () => {
      const fixtureInput = fixture(mode);
      const events: string[] = [];
      const input = {
        ...fixtureInput,
        execute: async (
          repository: ProtectedAgentMemoryRepository,
          projection: ProtectedTaskMemoryProjectionHandoff,
          access: ProtectedTaskMemoryAccessHandoff,
        ) => {
          events.push("execute");
          expect(repository).toBeDefined();
          expect(projection).toBeDefined();
          expect(access).toBeDefined();
          return "assembled";
        },
      };
      const result = await withProtectedTaskNativeMemoryRepository(
        input,
        assemblyOverrides(input, events),
      );
      expect(result).toBe("assembled");
      expect(events).toEqual([
        "entity-custody",
        "authority",
        "session",
        "boundaries",
        "product",
        "repository",
        "execute",
      ]);
    });
  }

  for (const mode of ["shadow_encryption", "encrypted_only"] as const) {
    test(`assembles Scope ${mode} reads and crypto from the same copied inventory`, async () => {
      const base = scopeFixture(mode);
      const readable = [NAMESPACE, OTHER_NAMESPACE];
      const input = {
        ...base,
        current: {
          ...base.current,
          scopeMemory: {
            ...base.current.scopeMemory!,
            binding: {
              ...base.current.scopeMemory!.binding,
              readableNamespaceIds: readable,
            },
          },
        },
      };
      const events: string[] = [];
      const overrides = assemblyOverrides(input, events);
      const session = overrides.createSession!;
      const repository = overrides.createRepository!;
      const product = overrides.createProduct!;
      const result = await withProtectedTaskNativeMemoryRepository(input, {
        ...overrides,
        withCurrentAuthority: (async (_, use) => {
          readable.pop();
          return use(held(input));
        }) as Dependency<"withCurrentAuthority">,
        createSession: request => {
          expect(request.scopeBinding).toEqual({
            scopeId: SCOPE,
            originWritableNamespaceId: NAMESPACE,
            readableNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
          });
          return session(request);
        },
        createBoundaries: request => ({
          authority: request.authority,
          policy: input.policy,
          publication: {},
          read: {},
        }) as ReturnType<Dependency<"createBoundaries">>,
        createProduct: request => {
          expect(request.readableNamespaceIds).toEqual([
            NAMESPACE,
            OTHER_NAMESPACE,
          ]);
          return product(request);
        },
        createRepository: request => {
          expect(request.read.binding).toEqual({
            mode: "scope",
            authority: scopeAuthority,
            readableNamespaceIds: [NAMESPACE, OTHER_NAMESPACE],
            coordinates: {
              taskId: input.current.occurrence.task.id,
              requesterUserId: USER,
              agentId: AGENT,
              scopeId: SCOPE,
              memoryRoomId: MEMORY_ROOM,
              originWritableNamespaceId: NAMESPACE,
            },
          });
          return repository(request);
        },
      });
      expect(result).toBe("assembled");
      await Promise.resolve(expect(
        withProtectedTaskNativeMemoryRepository({
          ...input,
          current: fixture(mode).current,
        }, overrides),
      ).rejects.toThrow("Scope binding is unavailable"));
    });
  }

  test("opens foreground-signed protected candidates through retained accepted execution evidence", async () => {
    const base = fixture();
    type NativeRead = Parameters<Dependency<"createSession">>[0]["read"];
    let read: NativeRead | undefined;
    let signerFactoryCalls = 0;
    let signerAdapterCalls = 0;
    const signerPublicKey = new Uint8Array(32).fill(19);
    const objectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY,
      contentRevision: 2,
    });
    const openedNativeObject = Object.freeze({
      objectId,
      accessRevision: 1,
      payloadBytes: new Uint8Array([7]),
      payloadHash: new Uint8Array(32).fill(7),
      accessManifestBytes: new Uint8Array([9]),
      accessManifestHash: new Uint8Array(32).fill(9),
      namespaceEnvelopes: Object.freeze([Object.freeze({
        namespaceId: NAMESPACE,
        keyGeneration: 0,
        bindingRevisionAtWrap: 1,
        envelopeBytes: new Uint8Array([8]),
      })]),
    }) satisfies NonNullable<Awaited<ReturnType<Dependency<"readObject">>>>;
    const borrowedProductHandle = Object.freeze({
      role: "nautilo" as const,
      borrowed: true,
    }) as unknown as ProductHandle;
    const validPrincipal = Object.freeze({
      agentId: AGENT,
      runtimeGeneration: 4,
      signerKeyId: "foreground-signer",
    });
    const input = {
      ...base,
      execute: async () => {
        const nativeRead = read;
        if (nativeRead === undefined) throw new Error("native read was not assembled");
        expect(await nativeRead({
          objectId,
          expectedObjectType: "Memory",
          expectedAccessRevision: 1,
          expectedNamespaceIds: [NAMESPACE],
        })).toBe(openedNativeObject);
        return "assembled";
      },
    } satisfies ProtectedTaskNativeMemoryRepositoryInput<string>;
    const overrides = assemblyOverrides(input, []);
    const createSession = overrides.createSession!;
    await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
      createSession: request => {
        read = request.read;
        return createSession(request);
      },
      requireHeldWriterAuthority: () => Object.freeze({
        crypto: input.current.crypto,
        restricted: input.current.restricted,
        restrictedHandle: Object.freeze({}),
        productHandle: borrowedProductHandle,
        assertCurrent: () => Promise.resolve(),
      }) as never,
      createDomainKeys: () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as never,
      createForegroundAgentAcceptedExecutionEvidenceResolver: request => {
        signerFactoryCalls += 1;
        expect(request.product).toBe(borrowedProductHandle);
        expect(request.product).not.toBe(input.product.handle);
        expect(request.crypto).toBe(input.current.crypto);
        expect(request.rejectInvalidSelectedEvidence).toBe(true);
        return async principal => {
          if (principal.signerKeyId === "substituted-signer") {
            throw new TypeError(
              "Foreground Agent execution signer evidence was substituted",
            );
          }
          return principal.agentId === validPrincipal.agentId
              && principal.runtimeGeneration === validPrincipal.runtimeGeneration
              && principal.signerKeyId === validPrincipal.signerKeyId
            ? Object.freeze({
                signerPublicKey: signerPublicKey.slice(),
                planBytes: new Uint8Array([1]),
                planDigest: new Uint8Array(32).fill(2),
              })
            : null;
        };
      },
      foregroundAgentAcceptedExecutionSigner: request => {
        signerAdapterCalls += 1;
        expect(request.crypto).toBe(input.current.crypto);
        expect(request.resolveEvidence).toBeDefined();
        return async principal => {
          const evidence = await request.resolveEvidence?.(principal) ?? null;
          return evidence?.signerPublicKey.slice() ?? null;
        };
      },
      readObject: async request => {
        const resolve = request.resolveLiveShadowAgentSigner;
        if (resolve === undefined) {
          throw new Error("foreground signer resolver was not supplied");
        }
        expect(await resolve(validPrincipal)).toEqual(signerPublicKey);
        expect(await resolve({ ...validPrincipal,
          signerKeyId: "missing-signer" })).toBeNull();
        await Promise.resolve(expect(resolve({ ...validPrincipal,
          signerKeyId: "substituted-signer" })).rejects.toThrow(
          "signer evidence was substituted",
        ));
        return openedNativeObject;
      },
    });
    expect(signerFactoryCalls).toBe(1);
    expect(signerAdapterCalls).toBe(1);
  });

  for (const shadowBehavior of ["strict", "fallback"] as const) {
    test(`repairs and verifies an ordinary-only ${shadowBehavior} Shadow source before sealing access`, async () => {
      const base = fixture("shadow_encryption");
      const policy = Object.freeze({ ...base.policy, shadowBehavior });
      const reserved = reservedNamespaceRepairSource();
      let repaired = false;
      let loads = 0;
      let repairs = 0;
      let opens = 0;
      let seals = 0;
      const operationIds: string[] = [];
      const prepareResults: unknown[] = [];
      const readPort: ProtectedTaskMemoryReadPort = Object.freeze({
        searchProtectedCandidates: async () => Object.freeze({
          status: "success" as const, value: Object.freeze([]),
        }),
        searchCandidates: async () => Object.freeze({
          status: "success" as const, value: Object.freeze([]),
        }),
        loadExactCandidates: async () => {
          loads += 1;
          return Object.freeze({ status: "success" as const,
            value: Object.freeze([repaired
              ? protectedAccessCandidate()
              : ordinaryAccessCandidate()]) });
        },
        loadExactProtectedSources: async () => Object.freeze({
          status: "success" as const, value: Object.freeze([]),
        }),
        loadExactOrdinary: async () => Object.freeze({
          status: "success" as const, value: Object.freeze([]),
        }),
      });
      const input = {
        ...base,
        policy,
        owner: accessOwner(policy),
        execute: async (_repository: ProtectedAgentMemoryRepository,
          _projection: ProtectedTaskMemoryProjectionHandoff,
          access: ProtectedTaskMemoryAccessHandoff) => {
          for (const operationId of ["grant-first", "grant-replay"]) {
            prepareResults.push(await access.prepareApproval({
              operationId,
              toolCallId: `tool-${operationId}`,
              authority,
              memoryId: MEMORY,
              action: { kind: "grant_user", userHandle: "bob" },
            }));
          }
          return "assembled";
        },
      } satisfies ProtectedTaskNativeMemoryRepositoryInput<string>;
      const overrides = assemblyOverrides(input, []);
      const createSession = overrides.createSession!;
      await withProtectedTaskNativeMemoryRepository(input, {
        ...overrides,
        createReader: () => readPort,
        createRepository: () => Object.freeze({}) as ProtectedAgentMemoryRepository,
        createAccessCapsule: () => Object.freeze({
          seal: async () => {
            seals += 1;
            return "sealed-access";
          },
          open: async () => null,
        }) as never,
        findActorByHandle: async handle => handle === "bob"
          ? Object.freeze({ actorId: TARGET_ACTOR, kind: "user" as const,
              displayName: "Bob" })
          : null,
        findActorById: async actorId => actorId === TARGET_ACTOR
          ? Object.freeze({ id: TARGET_ACTOR, ownerId: TARGET_USER,
              kind: "user" as const, displayName: "Bob" }) as never
          : null,
        reserveNamespaceRepair: async () => reserved.source,
        attachNamespaceRepair: async () => {
          repaired = true;
          return "attached";
        },
        createSession: request => {
          const created = createSession(request);
          return Object.freeze({
            ...created,
            session: Object.freeze({
              openMany: async ({ candidates }: Readonly<{
                candidates: readonly ReturnType<
                  typeof protectedAccessCandidate
                >[];
              }>) => {
                opens += 1;
                expect(candidates).toEqual([protectedAccessCandidate()]);
                return Object.freeze({ status: "success" as const,
                  value: Object.freeze([Object.freeze({ memoryId: MEMORY,
                    contentRevision: 2, type: "fact",
                    content: "a retained ordinary body" })]) });
              },
            }) as never,
            protectExactRepair: async repair => {
              repairs += 1;
              operationIds.push(repair.operationId);
              return Object.freeze({ status: "verified" as const,
                objectId: protectedAccessCandidate().cryptoObjectId,
                provenance: "repaired" as const,
                verification: "authenticated" as const,
                value: Object.freeze({ formatVersion: 1 as const,
                  type: "fact", content: "a retained ordinary body" }) });
            },
          });
        },
      });
      expect(prepareResults).toHaveLength(2);
      expect(prepareResults[0]).toMatchObject({ status: "success" });
      expect(prepareResults[1]).toMatchObject({ status: "success" });
      expect(operationIds).toEqual([
        `task-memory-access-repair:${input.current.occurrence.run.id}:${
          MEMORY}:0`,
      ]);
      expect({ repairs, opens, seals }).toEqual({ repairs: 1, opens: 2,
        seals: 2 });
      expect(loads).toBe(4);
      expect(reserved.plaintextBytes).toEqual(new Uint8Array(4));
      expect(reserved.requestCommitment).toEqual(new Uint8Array(32));
    });
  }

  test("refuses an ordinary-only Full access source before repair or protected opening", async () => {
    const base = fixture("encrypted_only");
    let reserves = 0;
    let protects = 0;
    let opens = 0;
    let seals = 0;
    let result: unknown;
    const input = {
      ...base,
      owner: accessOwner(base.policy),
      execute: async (_repository: ProtectedAgentMemoryRepository,
        _projection: ProtectedTaskMemoryProjectionHandoff,
        access: ProtectedTaskMemoryAccessHandoff) => {
        result = await access.prepareApproval({ operationId: "grant-full",
          toolCallId: "tool-full", authority, memoryId: MEMORY,
          action: { kind: "grant_user", userHandle: "bob" } });
        return "assembled";
      },
    } satisfies ProtectedTaskNativeMemoryRepositoryInput<string>;
    const overrides = assemblyOverrides(input, []);
    const createSession = overrides.createSession!;
    await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
      createReader: () => Object.freeze({
        searchProtectedCandidates: async () => ({ status: "success" as const,
          value: [] }),
        searchCandidates: async () => ({ status: "success" as const,
          value: [] }),
        loadExactCandidates: async () => ({ status: "success" as const,
          value: [ordinaryAccessCandidate()] }),
        loadExactProtectedSources: async () => ({ status: "success" as const,
          value: [] }),
        loadExactOrdinary: async () => ({ status: "success" as const,
          value: [] }),
      }),
      createRepository: () => Object.freeze({}) as ProtectedAgentMemoryRepository,
      reserveNamespaceRepair: async () => {
        reserves += 1;
        return reservedNamespaceRepairSource().source;
      },
      createSession: request => ({
        ...createSession(request),
        session: Object.freeze({ openMany: async () => {
          opens += 1;
          return Object.freeze({ status: "success" as const, value: [] });
        } }) as never,
        protectExactRepair: async () => {
          protects += 1;
          return Object.freeze({ status: "failed" as const,
            reason: "must not protect" });
        },
      }),
      createAccessCapsule: () => Object.freeze({
        seal: async () => {
          seals += 1;
          return "must-not-seal";
        },
        open: async () => null,
      }) as never,
      findActorByHandle: async () => Object.freeze({ actorId: TARGET_ACTOR,
        kind: "user" as const, displayName: "Bob" }),
      findActorById: async () => Object.freeze({ ownerId: TARGET_USER }) as never,
    });
    expect(result).toEqual({ status: "unavailable",
      reason: "authorization_required" });
    expect({ reserves, protects, opens, seals }).toEqual({ reserves: 0,
      protects: 0, opens: 0, seals: 0 });
  });

  for (const failure of ["conflict", "aborted"] as const) {
    test(`does not seal ${failure} Shadow repair and wipes reserved bytes`, async () => {
      const base = fixture("shadow_encryption");
      const controller = new AbortController();
      const reserved = reservedNamespaceRepairSource();
      let attaches = 0;
      let opens = 0;
      let seals = 0;
      let result: unknown;
      const input = {
        ...base,
        owner: accessOwner(base.policy),
        execute: async (_repository: ProtectedAgentMemoryRepository,
          _projection: ProtectedTaskMemoryProjectionHandoff,
          access: ProtectedTaskMemoryAccessHandoff) => {
          result = await access.prepareApproval({ operationId: "grant-fail",
            toolCallId: "tool-fail", authority, memoryId: MEMORY,
            action: { kind: "grant_user", userHandle: "bob" } });
          return "assembled";
        },
      } satisfies ProtectedTaskNativeMemoryRepositoryInput<string>;
      const overrides = assemblyOverrides(input, [], controller.signal);
      const createSession = overrides.createSession!;
      await withProtectedTaskNativeMemoryRepository(input, {
        ...overrides,
        createReader: () => Object.freeze({
          searchProtectedCandidates: async () => ({ status: "success" as const,
            value: [] }),
          searchCandidates: async () => ({ status: "success" as const,
            value: [] }),
          loadExactCandidates: async () => ({ status: "success" as const,
            value: [ordinaryAccessCandidate()] }),
          loadExactProtectedSources: async () => ({ status: "success" as const,
            value: [] }),
          loadExactOrdinary: async () => ({ status: "success" as const,
            value: [] }),
        }),
        createRepository: () => Object.freeze({}) as ProtectedAgentMemoryRepository,
        reserveNamespaceRepair: async () => reserved.source,
        attachNamespaceRepair: async () => {
          attaches += 1;
          return "conflict";
        },
        createSession: request => ({
          ...createSession(request),
          session: Object.freeze({ openMany: async () => {
            opens += 1;
            return Object.freeze({ status: "success" as const, value: [] });
          } }) as never,
          protectExactRepair: async () => {
            if (failure === "aborted") {
              controller.abort();
              return Object.freeze({ status: "failed" as const,
                reason: "aborted" });
            }
            return Object.freeze({ status: "verified" as const,
              objectId: protectedAccessCandidate().cryptoObjectId,
              provenance: "repaired" as const,
              verification: "authenticated" as const,
              value: Object.freeze({ formatVersion: 1 as const,
                type: "fact", content: "a retained ordinary body" }) });
          },
        }),
        createAccessCapsule: () => Object.freeze({
          seal: async () => {
            seals += 1;
            return "must-not-seal";
          },
          open: async () => null,
        }) as never,
        findActorByHandle: async () => Object.freeze({ actorId: TARGET_ACTOR,
          kind: "user" as const, displayName: "Bob" }),
        findActorById: async () => Object.freeze({ ownerId: TARGET_USER }) as never,
      });
      expect(result).toEqual({ status: "unavailable",
        reason: "authorization_required" });
      expect({ attaches, opens, seals }).toEqual({ attaches:
        failure === "conflict" ? 1 : 0, opens: 0, seals: 0 });
      expect(reserved.plaintextBytes).toEqual(new Uint8Array(4));
      expect(reserved.requestCommitment).toEqual(new Uint8Array(32));
    });
  }

  test("repairs one Shadow Namespace source inside native custody", async () => {
    const base = fixture("shadow_encryption");
    const reserved = reservedNamespaceRepairSource();
    const originalPlaintext = reserved.plaintextBytes.slice();
    const originalCommitment = reserved.requestCommitment.slice();
    const order: string[] = [];
    let captured: RepairExactCandidate | undefined;
    const input = {
      ...base,
      execute: async () => {
        const result = await captured!(repairRequest(authority));
        expect(result).toEqual({
          status: "success",
          value: { memoryId: MEMORY, contentRevision: 2 },
        });
        return "assembled";
      },
    };
    const overrides = assemblyOverrides(input, []);
    const session = overrides.createSession!;
    const repository = overrides.createRepository!;
    await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
      reserveNamespaceRepair: async (_, repairAuthority, selection) => {
        order.push("reserve");
        expect(repairAuthority).toEqual(authority);
        expect(selection).toEqual(repairRequest(authority).selection);
        return reserved.source;
      },
      attachNamespaceRepair: async (_, repairAuthority, source, objectId) => {
        order.push("attach");
        expect(repairAuthority).toEqual(authority);
        expect(source).toBe(reserved.source);
        expect(objectId).toBe(deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY,
          contentRevision: 2,
        }));
        expect(reserved.plaintextBytes).toEqual(originalPlaintext);
        expect(reserved.requestCommitment).toEqual(originalCommitment);
        return "attached";
      },
      createSession: request => ({
        ...session(request),
        protectExactRepair: async repair => {
          order.push("protect");
          expect(repair.authority).toEqual(authority);
          expect(repair.source).toBe(reserved.source);
          return Object.freeze({
            status: "verified" as const,
            objectId: deriveMemoryCryptoObjectIdV1({
              memoryId: MEMORY,
              contentRevision: 2,
            }),
            provenance: "repaired" as const,
            verification: "authenticated" as const,
            value: Object.freeze({
              formatVersion: 1 as const,
              type: "fact",
              content: "a retained ordinary body",
            }),
          });
        },
      }),
      createRepository: request => {
        captured = request.repairExactCandidate;
        return repository(request);
      },
      adoptScopeOrigin: async () => {
        throw new Error("Namespace repair must not adopt a Scope origin");
      },
      reserveScopeRepair: async () => {
        throw new Error("Namespace repair must not reserve a Scope repair");
      },
      attachScopeRepair: async () => {
        throw new Error("Namespace repair must not attach a Scope repair");
      },
    });
    expect(order).toEqual(["reserve", "protect", "attach"]);
    expect(reserved.plaintextBytes).toEqual(new Uint8Array(4));
    expect(reserved.requestCommitment).toEqual(new Uint8Array(32));
  });

  test("blocks Full Scope repair before adoption, reservation, protection, or attachment", async () => {
    const base = scopeFixture("encrypted_only");
    const calls = { delegated: 0, adopt: 0, reserve: 0, protect: 0, attach: 0 };
    let captured: RepairExactCandidate | undefined;
    const input = {
      ...base,
      repairExactCandidate: async () => {
        calls.delegated += 1;
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({ memoryId: MEMORY, contentRevision: 2 }),
        });
      },
      execute: async () => {
        expect(await captured!(repairRequest())).toEqual({
          status: "unavailable",
          reason: "encryption_pending",
        });
        return "assembled";
      },
    };
    const overrides = assemblyOverrides(input, []);
    const createSession = overrides.createSession!;
    const createRepository = overrides.createRepository!;
    await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
      adoptScopeOrigin: async () => {
        calls.adopt += 1;
        return "adopted";
      },
      reserveScopeRepair: async () => {
        calls.reserve += 1;
        return reservedRepairSource().reservation;
      },
      attachScopeRepair: async () => {
        calls.attach += 1;
        return "attached";
      },
      createSession: request => ({
        ...createSession(request),
        protectExactRepair: async () => {
          calls.protect += 1;
          return Object.freeze({
            status: "failed" as const,
            reason: "must not protect",
          });
        },
      }),
      createRepository: request => {
        captured = request.repairExactCandidate;
        return createRepository(request);
      },
    });
    expect(calls).toEqual({
      delegated: 0,
      adopt: 0,
      reserve: 0,
      protect: 0,
      attach: 0,
    });
  });

  test("repairs one Shadow Scope source in order and wipes it only after attachment", async () => {
    const base = scopeFixture("shadow_encryption");
    const reserved = reservedRepairSource();
    const originalPlaintext = reserved.plaintextBytes.slice();
    const originalCommitment = reserved.requestCommitment.slice();
    const order: string[] = [];
    let delegated = 0;
    let captured: RepairExactCandidate | undefined;
    const input = {
      ...base,
      repairExactCandidate: async () => {
        delegated += 1;
        return Object.freeze({ status: "unavailable" as const,
          reason: "integrity_failure" as const });
      },
      execute: async () => {
        const result = await captured!(repairRequest());
        expect(result).toEqual({
          status: "success",
          value: { memoryId: MEMORY, contentRevision: 2 },
        });
        return "assembled";
      },
    };
    const overrides = assemblyOverrides(input, []);
    const createSession = overrides.createSession!;
    const createRepository = overrides.createRepository!;
    await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
      adoptScopeOrigin: async (_, memoryId) => {
        order.push("adopt");
        expect(memoryId).toBe(MEMORY);
        return "adopted";
      },
      reserveScopeRepair: async (_, selection) => {
        order.push("reserve");
        expect(selection).toEqual(repairRequest().selection);
        return reserved.reservation;
      },
      createSession: request => ({
        ...createSession(request),
        protectExactRepair: async repair => {
          order.push("protect");
          expect(repair.operationId).toBe("task-scope-memory-repair");
          expect(repair.source).toBe(reserved.reservation.source);
          expect(reserved.plaintextBytes).toEqual(originalPlaintext);
          expect(reserved.requestCommitment).toEqual(originalCommitment);
          return Object.freeze({
            status: "verified" as const,
            objectId: deriveMemoryCryptoObjectIdV1({
              memoryId: MEMORY,
              contentRevision: 2,
            }),
            provenance: "repaired" as const,
            verification: "authenticated" as const,
            value: Object.freeze({
              formatVersion: 1 as const,
              type: "fact",
              content: "a retained ordinary body",
            }),
          });
        },
      }),
      attachScopeRepair: async (_, source, objectId) => {
        order.push("attach");
        expect(source).toBe(reserved.reservation);
        expect(objectId).toBe(deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY,
          contentRevision: 2,
        }));
        expect(reserved.plaintextBytes).toEqual(originalPlaintext);
        expect(reserved.requestCommitment).toEqual(originalCommitment);
        return "attached";
      },
      createRepository: request => {
        captured = request.repairExactCandidate;
        return createRepository(request);
      },
    });
    expect(order).toEqual(["adopt", "reserve", "protect", "attach"]);
    expect(delegated).toBe(0);
    expect(reserved.plaintextBytes).toEqual(new Uint8Array(4));
    expect(reserved.requestCommitment).toEqual(new Uint8Array(32));
  });

  test("stops a stale Scope origin before reservation or crypto", async () => {
    const calls = { adopt: 0, reserve: 0, protect: 0, attach: 0 };
    const observed = await invokeScopeRepair({
      adopt: async () => {
        calls.adopt += 1;
        return "stale";
      },
      reserve: async () => {
        calls.reserve += 1;
        return reservedRepairSource().reservation;
      },
      protect: async () => {
        calls.protect += 1;
        return Object.freeze({
          status: "failed" as const,
          reason: "must not protect",
        });
      },
      attach: async () => {
        calls.attach += 1;
        return "attached";
      },
    });
    expect(observed.result).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(observed.delegated).toBe(0);
    expect(calls).toEqual({ adopt: 1, reserve: 0, protect: 0, attach: 0 });
  });

  test("stops a failed Scope reservation before crypto or attachment", async () => {
    const calls = { adopt: 0, reserve: 0, protect: 0, attach: 0 };
    const observed = await invokeScopeRepair({
      adopt: async () => {
        calls.adopt += 1;
        return "replayed";
      },
      reserve: async () => {
        calls.reserve += 1;
        return null;
      },
      protect: async () => {
        calls.protect += 1;
        return Object.freeze({
          status: "failed" as const,
          reason: "must not protect",
        });
      },
      attach: async () => {
        calls.attach += 1;
        return "attached";
      },
    });
    expect(observed.result).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(observed.delegated).toBe(0);
    expect(calls).toEqual({ adopt: 1, reserve: 1, protect: 0, attach: 0 });
  });

  for (const protection of [
    Object.freeze({
      status: "waiting_for_authority" as const,
      reason: "authorization_cancelled",
      expectedReason: "authorization_required" as const,
    }),
    Object.freeze({
      status: "failed" as const,
      reason: "invalid repair proof",
      expectedReason: "integrity_failure" as const,
    }),
  ]) {
    test(`wipes a Scope source after ${protection.status} without attachment`, async () => {
      const reserved = reservedRepairSource();
      const originalPlaintext = reserved.plaintextBytes.slice();
      const originalCommitment = reserved.requestCommitment.slice();
      const calls = { adopt: 0, reserve: 0, protect: 0, attach: 0 };
      const observed = await invokeScopeRepair({
        adopt: async () => {
          calls.adopt += 1;
          return "adopted";
        },
        reserve: async () => {
          calls.reserve += 1;
          return reserved.reservation;
        },
        protect: async () => {
          calls.protect += 1;
          expect(reserved.plaintextBytes).toEqual(originalPlaintext);
          expect(reserved.requestCommitment).toEqual(originalCommitment);
          return Object.freeze({
            status: protection.status,
            reason: protection.reason,
          });
        },
        attach: async () => {
          calls.attach += 1;
          return "attached";
        },
      });
      expect(observed.result).toEqual({
        status: "unavailable",
        reason: protection.expectedReason,
      });
      expect(observed.delegated).toBe(0);
      expect(calls).toEqual({ adopt: 1, reserve: 1, protect: 1, attach: 0 });
      expect(reserved.plaintextBytes).toEqual(new Uint8Array(4));
      expect(reserved.requestCommitment).toEqual(new Uint8Array(32));
    });
  }

  test("reports a conflicting Scope attachment without retrying and then wipes the source", async () => {
    const reserved = reservedRepairSource();
    const originalPlaintext = reserved.plaintextBytes.slice();
    const originalCommitment = reserved.requestCommitment.slice();
    const calls = { adopt: 0, reserve: 0, protect: 0, attach: 0 };
    const observed = await invokeScopeRepair({
      adopt: async () => {
        calls.adopt += 1;
        return "adopted";
      },
      reserve: async () => {
        calls.reserve += 1;
        return reserved.reservation;
      },
      protect: async () => {
        calls.protect += 1;
        expect(reserved.plaintextBytes).toEqual(originalPlaintext);
        expect(reserved.requestCommitment).toEqual(originalCommitment);
        return Object.freeze({
          status: "verified" as const,
          objectId: deriveMemoryCryptoObjectIdV1({
            memoryId: MEMORY,
            contentRevision: 2,
          }),
          provenance: "repaired" as const,
          verification: "authenticated" as const,
          value: Object.freeze({
            formatVersion: 1 as const,
            type: "fact",
            content: "a retained ordinary body",
          }),
        });
      },
      attach: async () => {
        calls.attach += 1;
        expect(reserved.plaintextBytes).toEqual(originalPlaintext);
        expect(reserved.requestCommitment).toEqual(originalCommitment);
        return "conflict";
      },
    });
    expect(observed.result).toEqual({
      status: "unavailable",
      reason: "stale_revision",
    });
    expect(observed.delegated).toBe(0);
    expect(calls).toEqual({ adopt: 1, reserve: 1, protect: 1, attach: 1 });
    expect(reserved.plaintextBytes).toEqual(new Uint8Array(4));
    expect(reserved.requestCommitment).toEqual(new Uint8Array(32));
  });

  test("rejects identity substitution before native custody", async () => {
    const input = fixture();
    let nativeUses = 0;
    await Promise.resolve(expect(
      withProtectedTaskNativeMemoryRepository({
        ...input,
        product: { ...input.product, canonicalRunner: Object.freeze({}) },
      } as typeof input, {
        withEntityCrypto: (async native => {
          nativeUses += 1;
          await native.assertCurrentTaskAuthority();
          return "wrong";
        }) as Dependency<"withEntityCrypto">,
      } as Overrides),
    ).rejects.toThrow("identity is unavailable"));
    expect(nativeUses).toBe(0);
  });

  test("rejects policy drift before repository assembly", async () => {
    const input = fixture();
    let nativeUses = 0;
    await Promise.resolve(expect(
      withProtectedTaskNativeMemoryRepository(input, {
        withCurrentAuthority: (async (_, use) => use(held(input, 8))) as
          Dependency<"withCurrentAuthority">,
        withEntityCrypto: (async native => {
          nativeUses += 1;
          await native.assertCurrentTaskAuthority();
          return "wrong";
        }) as Dependency<"withEntityCrypto">,
      } as Overrides),
    ).rejects.toThrow("authority is unavailable"));
    expect(nativeUses).toBe(1);
  });

  test("pins policy and Namespace authority before the first await", async () => {
    const base = fixture();
    const mutableReadable = [NAMESPACE];
    const mutableMutable = [NAMESPACE];
    const mutableAuthority = {
      ...authority,
      readableNamespaceIds: mutableReadable,
      mutableNamespaceIds: mutableMutable,
    };
    const mutablePolicy = {
      mode: "encrypted_only" as const,
      shadowBehavior: "strict" as const,
      revision: 7,
    };
    const input = {
      ...base,
      authority: mutableAuthority,
      policy: mutablePolicy,
    };
    const events: string[] = [];
    const entitySignal = new AbortController().signal;
    const overrides = assemblyOverrides(input, events, entitySignal);
    expect(await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
      withCurrentAuthority: (async (_, use) => use({
        ...held(input),
        policy: Object.freeze({
          mode: "encrypted_only" as const,
          shadowBehavior: "strict" as const,
          revision: 7,
        }),
      })) as Dependency<"withCurrentAuthority">,
      withEntityCrypto: (async native => {
        mutableReadable[0] = OTHER_NAMESPACE;
        mutableMutable[0] = OTHER_NAMESPACE;
        mutablePolicy.revision = 8;
        await native.assertCurrentTaskAuthority();
        return native.execute(Object.freeze({ signal: entitySignal }) as never);
      }) as Dependency<"withEntityCrypto">,
      createBoundaries: boundaryInput => {
        expect(boundaryInput.authority).toEqual(authority);
        expect(boundaryInput.policy).toEqual({
          mode: "encrypted_only",
          shadowBehavior: "strict",
          revision: 7,
        });
        return Object.freeze({
          authority,
          policy: boundaryInput.policy,
          publication: Object.freeze({}),
          read: Object.freeze({}),
        }) as ReturnType<Dependency<"createBoundaries">>;
      },
    })).toBe("assembled");
  });

  test("an escaped repository rejects after native custody closes before embedding", async () => {
    const base = fixture();
    let embeddingUses = 0;
    let escaped: ProtectedAgentMemoryRepository | null = null;
    const input = {
      ...base,
      embedding: {
        embed: async () => {
          embeddingUses += 1;
          throw new Error("embedding must not run after native custody closes");
        },
      },
      execute: async (repository: ProtectedAgentMemoryRepository) => {
        escaped = repository;
        return "assembled";
      },
    } as ProtectedTaskNativeMemoryRepositoryInput<string>;
    const events: string[] = [];
    const controller = new AbortController();
    const overrides = assemblyOverrides(input, events, controller.signal);
    await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
      withEntityCrypto: (async native => {
        await native.assertCurrentTaskAuthority();
        const result = await native.execute(Object.freeze({
          signal: controller.signal,
        }) as never);
        controller.abort();
        return result;
      }) as Dependency<"withEntityCrypto">,
      createRepository: repositoryInput =>
        createProtectedTaskMemoryRepository(repositoryInput, {
          createReader: () => Object.freeze({
            searchProtectedCandidates: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze([]),
            }),
            searchCandidates: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze([]),
            }),
            loadExactCandidates: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze([]),
            }),
            loadExactProtectedSources: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze([]),
            }),
            loadExactOrdinary: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze([]),
            }),
          }),
        }),
    });
    const closed = escaped as ProtectedAgentMemoryRepository | null;
    if (closed === null) throw new Error("repository was not exposed");
    expect(await closed.search({
      authority,
      query: "must remain closed",
      limit: 1,
      includeArchive: false,
      mode: "vector",
    })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(embeddingUses).toBe(0);
  });

  for (const recovery of [false, true]) {
    test(`holds current Task authority through exact access ${recovery
      ? "recovery" : "crypto and product commit"}`, async () => {
      const base = fixture();
      const events: string[] = [];
      let captured: ProtectedTaskMemoryExactAccessInput | null = null;
      let committing = false;
      let taskLocked = false;
      let entityAuthorized = false;
      let cancelled = false;
      const source = Object.freeze({
        memoryId: MEMORY,
        contentRevision: 2,
        cryptoAccessRevision: 4,
        cryptoObjectId: deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY,
          contentRevision: 2,
        }),
        requiredNamespaceIds: Object.freeze([NAMESPACE]),
        payloadDigest: "payload-digest",
      });
      const destination = Object.freeze({
        roomId: MEMORY_ROOM,
        namespaceId: OTHER_NAMESPACE,
        humanActorIds: Object.freeze([
          "99999999-9999-4999-8999-999999999999",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ]),
      });
      const targetNamespaceIds = Object.freeze([
        NAMESPACE,
        OTHER_NAMESPACE,
      ].sort());
      const plan = Object.freeze({
        operationId: "grant-user-stable-operation",
        memoryId: MEMORY,
        cryptoObjectId: source.cryptoObjectId,
        expectedContentRevision: source.contentRevision,
        expectedCryptoAccessRevision: source.cryptoAccessRevision,
        nextCryptoAccessRevision: source.cryptoAccessRevision + 1,
        anchorNamespaceId: NAMESPACE,
        currentNamespaceIds: source.requiredNamespaceIds,
        targetNamespaceIds,
        addedNamespaceIds: Object.freeze([OTHER_NAMESPACE]),
        removedNamespaceIds: Object.freeze([]),
        currentRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces(source.requiredNamespaceIds),
        targetRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces(targetNamespaceIds),
        productMutation: Object.freeze({
          kind: "grant_namespace" as const,
          namespaceId: OTHER_NAMESPACE,
        }),
      });
      const input = {
        ...base,
        execute: async () => {
          const access = captured;
          if (access === null) throw new Error("access was not assembled");
          committing = true;
          const result = await access.commit({
            request: {
              operationId: plan.operationId,
              authority,
              memoryId: MEMORY,
              action: { kind: "grant_user", userHandle: "target" },
            },
            source,
            destination,
            plan,
          });
          committing = false;
          expect(result).toEqual({ status: "success", value: {
            status: recovery ? "replayed" : "updated",
            memoryId: MEMORY,
          } });
          expect(cancelled).toBe(true);
          return "assembled";
        },
      } satisfies ProtectedTaskNativeMemoryRepositoryInput<string>;
      const overrides = assemblyOverrides(input, events);
      const currentHeld = held(input);
      const borrowedProductHandle = Object.freeze({
        role: "nautilo" as const,
        borrowed: true,
      }) as unknown as ProductHandle;
      expect(await withProtectedTaskNativeMemoryRepository(input, {
        ...overrides,
        withCurrentAuthority: (async (_, use) => {
          if (!committing) return use(currentHeld);
          expect(entityAuthorized).toBe(true);
          expect(taskLocked).toBe(false);
          events.push("task-lock");
          taskLocked = true;
          try {
            return await use(currentHeld);
          } finally {
            taskLocked = false;
            cancelled = true;
            events.push("task-unlock");
          }
        }) as Dependency<"withCurrentAuthority">,
        requireHeldWriterAuthority: current => {
          expect(current).toBe(currentHeld);
          return Object.freeze({
            crypto: Object.freeze({}),
            evidence: input.current.evidence,
            restricted: Object.freeze({}),
            restrictedHandle: Object.freeze({}),
            productHandle: borrowedProductHandle,
            assertCurrent: () => {
              expect(taskLocked).toBe(true);
              expect(cancelled).toBe(false);
              return Promise.resolve();
            },
          }) as never;
        },
        assertHeldAccessNamespace: async (current, audience, expected) => {
          expect(current).toBe(currentHeld);
          expect(taskLocked).toBe(true);
          expect(cancelled).toBe(false);
          expect(audience).toEqual({
            requesterUserId: USER,
            requesterActorId: "99999999-9999-4999-8999-999999999999",
            humanActorIds: destination.humanActorIds,
          });
          expect(expected).toBe(destination);
          events.push("recipient-fence");
          return true;
        },
        createAccessCapsule: () => Object.freeze({}) as never,
        createAccess: accessInput => {
          captured = accessInput;
          return Object.freeze({}) as ProtectedTaskMemoryAccessHandoff;
        },
        createExactCrypto: () => Object.freeze({
          prepare: async (request: Parameters<ExactCrypto["prepare"]>[0]) => recovery
            && request.expectedAccessRevision === source.cryptoAccessRevision
            ? null
            : Object.freeze({}) as never,
          authorizeCommit: async (
            request: Parameters<ExactCrypto["authorizeCommit"]>[0],
          ) => {
            expect(taskLocked).toBe(false);
            entityAuthorized = true;
            events.push("entity-authorize");
            try {
              return await request.commit(Object.freeze({}) as never);
            } finally {
              entityAuthorized = false;
            }
          },
          authorizeCurrentHead: async (
            request: Parameters<ExactCrypto["authorizeCurrentHead"]>[0],
          ) => {
            expect(taskLocked).toBe(false);
            entityAuthorized = true;
            events.push("entity-authorize");
            try {
              return await request.commit(Object.freeze({
                objectId: plan.cryptoObjectId,
                accessRevision: plan.nextCryptoAccessRevision,
                namespaceIds: plan.targetNamespaceIds,
                manifestHash: new Uint8Array(32),
              }));
            } finally {
              entityAuthorized = false;
            }
          },
        }) as never,
        createExactProduct: productInput => Object.freeze({
          commitNativePrepared: async (
            request: Parameters<ExactProduct["commitNativePrepared"]>[0],
          ) => {
            await productInput.assertCurrentAuthority?.();
            expect(entityAuthorized).toBe(true);
            expect(taskLocked).toBe(true);
            expect(cancelled).toBe(false);
            events.push("product-reserve");
            expect(await request.persist()).toBe("created");
            expect(taskLocked).toBe(true);
            expect(cancelled).toBe(false);
            events.push("product-commit");
            await productInput.assertCurrentAuthority?.();
            return Object.freeze({ status: "success" as const,
              value: Object.freeze({ status: "updated" as const,
                memoryId: MEMORY }) });
          },
          recoverNativeCommitted: async () => {
            await productInput.assertCurrentAuthority?.();
            expect(entityAuthorized).toBe(true);
            expect(taskLocked).toBe(true);
            expect(cancelled).toBe(false);
            events.push("product-recover");
            await productInput.assertCurrentAuthority?.();
            return Object.freeze({ status: "success" as const,
              value: Object.freeze({ status: "replayed" as const,
                memoryId: MEMORY }) });
          },
        }) as never,
        persistExact: async request => {
          expect(entityAuthorized).toBe(true);
          expect(taskLocked).toBe(true);
          expect(cancelled).toBe(false);
          expect(await request.resolveLiveShadowAgentSigner?.({
            agentId: AGENT,
            runtimeGeneration: 4,
            signerKeyId: "retained-foreground-signer",
          })).toEqual(new Uint8Array(32).fill(23));
          events.push("crypto-persist");
          return "created";
        },
        createForegroundAgentAcceptedExecutionEvidenceResolver: request => {
          expect(request.product).toBe(borrowedProductHandle);
          expect(request.product).not.toBe(input.product.handle);
          return async principal =>
          principal.agentId === AGENT
              && principal.runtimeGeneration === 4
              && principal.signerKeyId === "retained-foreground-signer"
            ? Object.freeze({
                signerPublicKey: new Uint8Array(32).fill(23),
                planBytes: new Uint8Array([1]),
                planDigest: new Uint8Array(32).fill(2),
              })
            : null;
        },
        foregroundAgentAcceptedExecutionSigner: request => async principal => {
          const evidence = await request.resolveEvidence?.(principal) ?? null;
          return evidence?.signerPublicKey.slice() ?? null;
        },
        createSignerHistory: () => Object.freeze({
          resolveAgentRuntimeSignerManager: async () => null,
        }) as never,
      })).toBe("assembled");
      expect(events.slice(-5)).toEqual(recovery
        ? ["entity-authorize", "task-lock", "recipient-fence",
            "product-recover", "task-unlock"]
        : ["recipient-fence", "product-reserve", "crypto-persist",
            "product-commit", "task-unlock"]);
    });
  }
});
