import { describe, expect, test } from "bun:test";
import type {
  ProtectedAgentMemoryRepository,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";

import {
  withProtectedTaskNativeMemoryRepository,
  type ProtectedTaskNativeMemoryRepositoryInput,
} from "../../src/routes/protected-task-native-memory-repository";
import {
  createProtectedTaskMemoryRepository,
} from "../../src/routes/protected-task-memory-composition";
import type {
  HeldProtectedTaskMemoryAuthority,
  ProtectedTaskMemoryAuthorityInput,
} from "../../src/routes/current-protected-task-memory-authority";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const NAMESPACE = "33333333-3333-4333-8333-333333333333";
const OTHER_NAMESPACE = "44444444-4444-4444-8444-444444444444";

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
    result: Object.freeze({ signerAgentId: AGENT }),
  });
  const current = {
    runner,
    restricted: Object.freeze({}),
    crypto: Object.freeze({}),
    serverScope: "https://nautilo.example",
    subject: Object.freeze({ userId: USER }),
    occurrence: Object.freeze({ task: Object.freeze({ agentId: AGENT }) }),
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
      runtime: Object.freeze({ agentId: AGENT }),
      signerPublication: Object.freeze({ agentId: AGENT }),
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
    repairExactCandidate: async () => Object.freeze({
      status: "unavailable" as const,
      reason: "authorization_required" as const,
    }),
    fallbackOrdinary: Object.freeze({}),
    execute: async () => "assembled",
  } as unknown as ProtectedTaskNativeMemoryRepositoryInput<string>;
}

type Overrides = NonNullable<Parameters<
  typeof withProtectedTaskNativeMemoryRepository
>[1]>;
type Dependency<Key extends keyof Overrides> = NonNullable<Overrides[Key]>;

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
    createSession: sessionInput => {
      events.push("session");
      expect(sessionInput.evidence).toBe(input.current.evidence);
      return Object.freeze({
        session,
        completion,
        readPreparedPayload,
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
      expect(repositoryInput.signal).toBe(entitySignal);
      return repository;
    },
  } as Overrides;
}

describe("protected native Task Memory repository", () => {
  for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
    test(`assembles one callback-scoped ${mode} repository`, async () => {
      const fixtureInput = fixture(mode);
      const events: string[] = [];
      const input = {
        ...fixtureInput,
        execute: async (repository: ProtectedAgentMemoryRepository) => {
          events.push("execute");
          expect(repository).toBeDefined();
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
    const base = fixture(mode);
    const scopeId = "55555555-5555-4555-8555-555555555555";
    const memoryRoomId = "66666666-6666-4666-8666-666666666666";
    const readable = [NAMESPACE, OTHER_NAMESPACE];
    const scopeAuthority = { mode: "scope" as const, subjectUserId: USER,
      agentId: AGENT, scopeId, originWritableNamespaceId: NAMESPACE };
    let repairRequest: Parameters<Dependency<"createRepository">>[0]["repairExactCandidate"] | undefined;
    let adopted: "adopted" | "stale" = "stale";
    let repaired = 0;
    let adoptions = 0;
    const input = { ...base, authority: scopeAuthority,
      repairExactCandidate: async () => { repaired++; return { status: "success" as const, value: { memoryId: "77777777-7777-4777-8777-777777777777", contentRevision: 1 } }; },
      execute: async () => {
        const request = { operationId: "repair", authority: scopeAuthority,
          selection: { memoryId: "77777777-7777-4777-8777-777777777777" },
        } as Parameters<NonNullable<typeof repairRequest>>[0];
        expect((await repairRequest!(request)).status).toBe("unavailable");
        expect(repaired).toBe(0);
        if (mode === "encrypted_only") {
          expect(adoptions).toBe(0);
          return "assembled";
        }
        adopted = "adopted";
        expect((await repairRequest!(request)).status).toBe("success");
        expect(repaired).toBe(1);
        return "assembled";
      },
      current: { ...base.current, scopeMemory: { targetRoomId: memoryRoomId, workIdentity: "bound work",
        binding: { scopeId, memoryRoomId, originWritableNamespaceId: NAMESPACE,
          readableNamespaceIds: readable } } } };
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
      adoptScopeOrigin: async () => { adoptions++; return adopted; },
      createSession: request => {
        expect(request.scopeBinding).toEqual({ scopeId,
          originWritableNamespaceId: NAMESPACE,
          readableNamespaceIds: [NAMESPACE, OTHER_NAMESPACE] });
        return session(request);
      },
      createBoundaries: request => ({ authority: request.authority,
        policy: input.policy, publication: {}, read: {},
      }) as ReturnType<Dependency<"createBoundaries">>,
      createProduct: request => {
        expect(request.readableNamespaceIds).toEqual([NAMESPACE, OTHER_NAMESPACE]);
        return product(request);
      },
      createRepository: request => {
        repairRequest = request.repairExactCandidate;
        expect(request.read.binding).toEqual({ mode: "scope", authority: scopeAuthority,
          readableNamespaceIds: [NAMESPACE, OTHER_NAMESPACE], coordinates: {
            taskId: input.current.occurrence.task.id, requesterUserId: USER,
            agentId: AGENT, scopeId, memoryRoomId,
            originWritableNamespaceId: NAMESPACE,
          } });
        return repository(request);
      },
    });
    expect(result).toBe("assembled");
    let rejected = false;
    try { await withProtectedTaskNativeMemoryRepository({ ...input,
      current: base.current }, overrides); } catch { rejected = true; }
    expect(rejected).toBeTrue();
  });
  }

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
});
