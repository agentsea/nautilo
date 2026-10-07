import { describe, expect, test } from "bun:test";
import type {
  ProtectedAgentMemoryRepository,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import { deriveMemoryCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type {
  ForegroundMemoryRepairSource,
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
      expect(repositoryInput.signal).toBe(entitySignal);
      return repository;
    },
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

function repairRequest(): RepairRequest {
  return {
    operationId: "task-scope-memory-repair",
    authority: scopeAuthority,
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

async function invokeScopeRepair(input: Readonly<{
  adopt: Dependency<"adoptScopeOrigin">;
  reserve: Dependency<"reserveScopeRepair">;
  protect: ProtectExactRepair;
  attach: Dependency<"attachScopeRepair">;
}>): Promise<Readonly<{ result: RepairResult; delegated: number }>> {
  const base = scopeFixture("shadow_encryption");
  let captured: RepairExactCandidate | undefined;
  let result: RepairResult | undefined;
  let delegated = 0;
  const repositoryInput = {
    ...base,
    repairExactCandidate: async () => {
      delegated += 1;
      return Object.freeze({
        status: "unavailable" as const,
        reason: "integrity_failure" as const,
      });
    },
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
  return Object.freeze({ result, delegated });
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

  test("keeps Namespace repair delegated to the supplied callback", async () => {
    const base = fixture("shadow_encryption");
    let delegated = 0;
    let captured: RepairExactCandidate | undefined;
    const input = {
      ...base,
      repairExactCandidate: async () => {
        delegated += 1;
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({ memoryId: MEMORY, contentRevision: 2 }),
        });
      },
      execute: async () => {
        const result = await captured!(repairRequest());
        expect(result).toMatchObject({ status: "success" });
        return "assembled";
      },
    };
    const overrides = assemblyOverrides(input, []);
    const repository = overrides.createRepository!;
    await withProtectedTaskNativeMemoryRepository(input, {
      ...overrides,
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
    expect(delegated).toBe(1);
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
