import { describe, expect, test } from "bun:test";
import {
  PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
  type ProtectedTaskProjectionAuthorityPlan,
} from "@nautilo/agent";
import type {
  ProtectedAgentMemoryProjectionReference,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import type {
  ConversationProductCanonicalTransactionConnection,
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresExecutor,
  PostgresAgentMemoryProductPort,
} from "@nautilo/lattice-bridge/server";
import {
  memories,
  memoryNamespaces,
  protectedTaskSemanticAuthorityRequirementsDigest,
} from "@nautilo/db";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  createProtectedTaskMemoryProjection,
} from "../../src/routes/protected-task-memory-projection";
import type {
  HeldProtectedTaskMemoryAuthority,
  ProtectedTaskMemoryAuthorityInput,
} from "../../src/routes/current-protected-task-memory-authority";

const USER = "11111111-1111-4111-8111-111111111111";
const HUMAN = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const DESTINATION = "77777777-7777-4777-8777-777777777777";
const ROOM = "88888888-8888-4888-8888-888888888888";
const MEMORY = "99999999-9999-4999-8999-999999999999";
const PROJECTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type PublicationObservation = {
  planRequests: unknown[];
  prepareRequests: unknown[];
  authorizeRequests: unknown[];
  publishRequests: unknown[];
  representations: string[];
  ordinaryReaders: boolean[];
  effectUses: number;
  committed: boolean;
};

const authority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([SOURCE]),
  mutableNamespaceIds: Object.freeze([SOURCE]),
  writableNamespaceId: SOURCE,
}) satisfies ProtectedMemoryAuthority;

function current(
  includeDestination: boolean,
  crypto: unknown = Object.freeze({}),
  contentRepresentation: "dual" | "protected" = "protected",
): ProtectedTaskMemoryAuthorityInput {
  const requirements = [
    Object.freeze({
      ordinal: 0,
      namespaceId: SOURCE,
      domainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 7,
      operations: Object.freeze(["decrypt" as const, "encrypt" as const]),
    }),
    ...(includeDestination ? [Object.freeze({
      ordinal: 1,
      namespaceId: DESTINATION,
      domainId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 7,
      operations: Object.freeze(["encrypt" as const]),
    })] : []),
  ];
  return {
    subject: Object.freeze({ userId: USER, humanActorId: HUMAN, deviceId: "device" }),
    occurrence: Object.freeze({
      task: Object.freeze({
        id: TASK,
        requestorId: USER,
        agentId: AGENT,
        contentNamespaceId: SOURCE,
        contentRepresentation,
      }),
      run: Object.freeze({ id: RUN, graphThreadId: "thread-1" }),
    }),
    evidence: Object.freeze({
      policyRevision: 7,
      namespaceRequirements: Object.freeze(requirements),
      result: Object.freeze({ signerAgentId: AGENT }),
    }),
    crypto,
    signal: new AbortController().signal,
  } as unknown as ProtectedTaskMemoryAuthorityInput;
}

function fixture(input: Readonly<{
  current: ProtectedTaskMemoryAuthorityInput;
  sealed?: Map<string, unknown>;
  embeddingUses?: { value: number };
  entityKey?: Uint8Array;
  policyMode?: "shadow_encryption" | "encrypted_only";
  publication?: PublicationObservation;
}>) {
  const sealed = input.sealed ?? new Map<string, unknown>();
  const embeddingUses = input.embeddingUses ?? { value: 0 };
  const sourceOpenUses = { value: 0 };
  const sourceProduct = Object.freeze({
    loadExactProjectionSources: async () => Object.freeze({
      status: "success" as const,
      value: Object.freeze([Object.freeze({
        memoryId: MEMORY,
        contentRevision: 2,
        cryptoAccessRevision: 3,
        cryptoObjectId: "memory-object",
        requiredNamespaceIds: Object.freeze([SOURCE]),
      })]),
    }),
  });
  const publication = input.publication;
  const policyMode = input.policyMode ?? "encrypted_only";
  const preparedProjection = Object.freeze({ kind: "prepared-projection" });
  const session = Object.freeze({
    session: Object.freeze({
      openMany: async () => {
        sourceOpenUses.value += 1;
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze([Object.freeze({
            memoryId: MEMORY,
            contentRevision: 2,
            type: "fact",
            content: "source plaintext",
          })]),
        });
      },
      prepare: async (request: unknown) => {
        publication?.prepareRequests.push(request);
        return Object.freeze({
          status: "success" as const,
          value: preparedProjection,
        });
      },
      authorizeCommit: async (request: Readonly<{
        commit(): Promise<unknown>;
      }>) => {
        publication?.authorizeRequests.push(request);
        return request.commit();
      },
    }),
    completion: Object.freeze({ complete: async () => undefined }),
    readPreparedPayload: () => ({
      formatVersion: 1 as const,
      type: "fact",
      content: "prepared",
    }),
  });
  const entityAuthority = Object.freeze({
    namespaceId: SOURCE,
    namespaceKeyGeneration: 2,
    namespaceAccessRevision: 3,
    domainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    domainKeyGeneration: 4,
    domainAuthorizationRevision: 5,
    namespaceHeadDigest: new Uint8Array(32).fill(6),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(7),
  });
  const entities = input.entityKey === undefined
    ? Object.freeze({ signal: input.current.signal }) as never
    : Object.freeze({
        signal: input.current.signal,
        useCurrentSet: async (request: Readonly<{
          execute(items: readonly Readonly<{
            namespaceKey: Uint8Array;
            authority: typeof entityAuthority;
          }>[]): unknown;
        }>) => Object.freeze({
          status: "executed" as const,
          value: request.execute([Object.freeze({
            namespaceKey: input.entityKey!.slice(),
            authority: entityAuthority,
          })]),
        }),
        use: async (request: Readonly<{
          execute(item: Readonly<{
            namespaceKey: Uint8Array;
            authority: typeof entityAuthority;
          }>): unknown;
        }>) => Object.freeze({
          status: "executed" as const,
          value: request.execute(Object.freeze({
            namespaceKey: input.entityKey!.slice(),
            authority: entityAuthority,
          })),
        }),
      }) as never;
  const projection = createProtectedTaskMemoryProjection({
    authority,
    policy: Object.freeze({
      mode: policyMode,
      shadowBehavior: "strict" as const,
      revision: 7,
    }),
    current: input.current,
    agentAuthorizationRevision: 4,
    entities,
    session: session as never,
    sourceProduct: sourceProduct as never,
    product: Object.freeze({
      handle: Object.freeze({ role: "nautilo_agent" }),
      canonicalRunner: Object.freeze({
        role: "nautilo_agent",
        transaction: async <Result>(use: (
          transaction: CanonicalTranscriptTx,
          executor: ConversationProductPostgresExecutor,
        ) => Promise<Result>) => use(
          Object.freeze({
            select: (selection: Record<string, unknown>) => Object.freeze({
              from: (table: unknown) => Object.freeze({
                where: () => Object.freeze({
                  orderBy: () => Object.freeze({
                    for: async () => table === memories
                      ? [Object.freeze({
                          id: MEMORY,
                          contentRevision: 2,
                          cryptoAccessRevision: 3,
                          cryptoObjectId: "memory-object",
                        })]
                      : table === memoryNamespaces
                        ? [Object.freeze({ memoryId: MEMORY, namespaceId: SOURCE })]
                        : Object.keys(selection).includes("contentRevision")
                          ? [Object.freeze({
                              id: MEMORY,
                              contentRevision: 2,
                              cryptoAccessRevision: 3,
                              cryptoObjectId: "memory-object",
                            })]
                          : [Object.freeze({ memoryId: MEMORY, namespaceId: SOURCE })],
                  }),
                }),
              }),
            }),
          }) as unknown as CanonicalTranscriptTx,
          Object.freeze({}) as ConversationProductPostgresExecutor,
        ),
      }),
    }) as never,
    embedding: Object.freeze({
      embed: async () => {
        embeddingUses.value += 1;
        return Object.freeze({ status: "success" as const, value: Object.freeze({
          vector: Object.freeze(Array.from({ length: 1536 }, () => 0)),
          provider: "openai",
          canonicalModel: "model",
          dimensions: 1536 as const,
          contractVersion: 1,
        }) });
      },
    }),
  }, {
    now: () => 100,
    createReferenceId: () => "reference-1",
    ...(input.entityKey === undefined ? { createCapsule: () => Object.freeze({
      async seal(reference: ProtectedAgentMemoryProjectionReference, value: unknown) {
        sealed.set(reference.referenceId, structuredClone(value));
        return reference.referenceId;
      },
      async open(reference: ProtectedAgentMemoryProjectionReference) {
        return structuredClone(sealed.get(reference.sealedPreparation ?? "") ?? null);
      },
    }) } : {}),
    resolveRoom: (async () => Object.freeze({
      status: "resolved" as const,
      destination: Object.freeze({
        roomId: ROOM,
        namespaceId: DESTINATION,
        label: "Destination",
        kind: "group" as const,
        memberCount: 2,
        audienceFingerprint: "audience",
      }),
    })) as never,
    findRoomCandidates: (async () => []) as never,
    hasCapability: (async () => true) as never,
    lockDestination: (async () => null) as never,
    withCurrentAuthority: (async (
      _current: ProtectedTaskMemoryAuthorityInput,
      use: (held: HeldProtectedTaskMemoryAuthority) => Promise<unknown>,
    ) => use(Object.freeze({
      policy: Object.freeze({
        mode: policyMode,
        shadowBehavior: "strict" as const,
        revision: 7,
      }),
      assertCurrent: async () => undefined,
    }) as HeldProtectedTaskMemoryAuthority)) as never,
    bindProductRunner: (
      _handle,
      connection: ConversationProductCanonicalTransactionConnection,
    ) => Object.freeze({
      role: "nautilo_agent" as const,
      transaction: connection.transaction.bind(connection),
    }) as ConversationProductCanonicalTransactionRunner,
    createProduct: ((productInput: Readonly<{ publication: Readonly<{
      representation: string;
      readPreparedPayload?: unknown;
    }> }>) => {
      publication?.representations.push(productInput.publication.representation);
      publication?.ordinaryReaders.push(
        typeof productInput.publication.readPreparedPayload === "function",
      );
      return Object.freeze({
        planProjectionCreate: async (request: unknown) => {
          publication?.planRequests.push(request);
          if (publication === undefined) return Object.freeze({
            status: "unavailable" as const,
            reason: "stale_revision" as const,
          });
          return Object.freeze({
            status: "success" as const,
            value: Object.freeze({
              operationId: "operation-1",
              memoryId: PROJECTED,
            }),
          });
        },
        publishPrepared: async (request: unknown) => {
          publication?.publishRequests.push(request);
          if (publication === undefined) return Object.freeze({
            status: "unavailable" as const,
            reason: "stale_revision" as const,
          });
          const value = publication.committed ? "replayed" as const : "created" as const;
          if (!publication.committed) {
            publication.committed = true;
            publication.effectUses += 1;
          }
          return Object.freeze({ status: "success" as const, value });
        },
      }) as unknown as PostgresAgentMemoryProductPort;
    }) as never,
  });
  return { projection, sealed, embeddingUses, sourceOpenUses };
}

async function prepare(
  projection: ReturnType<typeof fixture>["projection"],
) {
  const prepared = await projection.prepare({
    operationId: "operation-1",
    toolCallId: "tool-1",
    authority,
    requesterActorId: HUMAN,
    sourceMemoryIds: [MEMORY],
    proposedContent: "projected fact",
    targetRoomName: "Destination",
  });
  expect(prepared.status).toBe("success");
  if (prepared.status !== "success" || prepared.value.kind !== "prepared") {
    throw new Error("projection was not prepared");
  }
  return prepared.value.reference;
}

describe("protected Task Memory projection", () => {
  test("authenticates the sealed Task capsule with real crypto", async () => {
    const crypto = new LatticeCrypto();
    const key = crypto.randomBytes(32);
    try {
      const { projection } = fixture({
        current: current(false, crypto),
        entityKey: key,
      });
      const reference = await prepare(projection);
      const planned = await projection.planPublication({ authority, reference });
      expect(planned.status).toBe("success");
      const cell = JSON.parse(reference.sealedPreparation!) as {
        ciphertext: string;
      };
      cell.ciphertext = `${cell.ciphertext.slice(0, -2)}AA`;
      const tampered = Object.freeze({
        ...reference,
        sealedPreparation: JSON.stringify(cell),
      });
      expect(await projection.planPublication({ authority, reference: tampered }))
        .toEqual({
          status: "unavailable",
          reason: "authorization_required",
        });
    } finally {
      key.fill(0);
    }
  });

  test("seals an immutable additional-authority decision with exact source and destination operations", async () => {
    const { projection } = fixture({ current: current(false) });
    const reference = await prepare(projection);
    const planned = await projection.planPublication({ authority, reference });
    expect(planned.status).toBe("success");
    if (planned.status !== "success") return;
    expect(planned.value).toMatchObject({
      planVersion: 1,
      kind: "additional_authority_v1",
      operationId: "operation-1",
      effectDisposition: "not_started_v1",
      semanticAuthorityRequirements: [
        { namespaceId: SOURCE, operations: ["decrypt"] },
        { namespaceId: DESTINATION, operations: ["encrypt"] },
      ],
    });
    expect(planned.value.requestDigest).toHaveLength(32);
  });

  test("retains the sealed additional decision after a fresh grant gains destination encrypt", async () => {
    const original = fixture({ current: current(false) });
    const reference = await prepare(original.projection);
    const resumed = fixture({
      current: current(true),
      sealed: original.sealed,
    });
    const planned = await resumed.projection.planPublication({ authority, reference });
    expect(planned.status).toBe("success");
    if (planned.status !== "success") return;
    expect(planned.value.kind).toBe("additional_authority_v1");
  });

  test("rederives and rejects a sealed plan that does not match its exact capsule facts", async () => {
    const prepared = fixture({ current: current(false) });
    const reference = await prepare(prepared.projection);
    const stored = prepared.sealed.get(reference.referenceId) as {
      state: { publicationAuthority: { requestDigest: string } };
    };
    stored.state.publicationAuthority.requestDigest = "00".repeat(32);
    const planned = await prepared.projection.planPublication({ authority, reference });
    expect(planned).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
  });

  test("rejects substituted acknowledgement before embedding or product effects", async () => {
    const original = fixture({ current: current(false) });
    const reference = await prepare(original.projection);
    const embeddingUses = { value: 0 };
    const resumed = fixture({
      current: current(true),
      sealed: original.sealed,
      embeddingUses,
    });
    const planned = await resumed.projection.planPublication({ authority, reference });
    if (planned.status !== "success"
      || planned.value.kind !== "additional_authority_v1") {
      throw new Error("additional-authority plan was unavailable");
    }
    const plan = planned.value;
    const sourceOpenUses = resumed.sourceOpenUses.value;
    const result = await resumed.projection.publishAuthorized({
      authority,
      reference,
      authorization: Object.freeze({
        kind: "additional_authority_v1" as const,
        plan,
        acknowledgement: Object.freeze({
          type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
          authorizationRequestId: plan.authorizationRequestId,
          effectDisposition: "not_started_v1" as const,
          operationId: plan.operationId,
          requestDigest: plan.requestDigest.slice(),
          requiredAuthorityDigest: new Uint8Array(32),
        }),
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(embeddingUses.value).toBe(0);
    expect(resumed.sourceOpenUses.value).toBe(sourceOpenUses);
  });

  test("requires the fresh destination evidence before embedding an acknowledged plan", async () => {
    const embeddingUses = { value: 0 };
    const { projection } = fixture({
      current: current(false),
      embeddingUses,
    });
    const reference = await prepare(projection);
    const planned = await projection.planPublication({ authority, reference });
    if (planned.status !== "success"
      || planned.value.kind !== "additional_authority_v1") {
      throw new Error("additional-authority plan was unavailable");
    }
    const plan = planned.value;
    const result = await projection.publishAuthorized({
      authority,
      reference,
      authorization: Object.freeze({
        kind: "additional_authority_v1" as const,
        plan,
        acknowledgement: Object.freeze({
          type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
          authorizationRequestId: plan.authorizationRequestId,
          effectDisposition: "not_started_v1" as const,
          operationId: plan.operationId,
          requestDigest: plan.requestDigest.slice(),
          requiredAuthorityDigest:
            protectedTaskSemanticAuthorityRequirementsDigest(
              plan.semanticAuthorityRequirements,
            ),
        }),
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(embeddingUses.value).toBe(0);
  });

  test("accepts the exact acknowledgement only after fresh evidence and reaches the product plan", async () => {
    const original = fixture({ current: current(false) });
    const reference = await prepare(original.projection);
    const embeddingUses = { value: 0 };
    const resumed = fixture({
      current: current(true),
      sealed: original.sealed,
      embeddingUses,
    });
    const planned = await resumed.projection.planPublication({ authority, reference });
    if (planned.status !== "success"
      || planned.value.kind !== "additional_authority_v1") {
      throw new Error("additional-authority plan was unavailable");
    }
    const plan = planned.value;
    const result = await resumed.projection.publishAuthorized({
      authority,
      reference,
      authorization: Object.freeze({
        kind: "additional_authority_v1" as const,
        plan,
        acknowledgement: Object.freeze({
          type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
          authorizationRequestId: plan.authorizationRequestId,
          effectDisposition: "not_started_v1" as const,
          operationId: plan.operationId,
          requestDigest: plan.requestDigest.slice(),
          requiredAuthorityDigest:
            protectedTaskSemanticAuthorityRequirementsDigest(
              plan.semanticAuthorityRequirements,
            ),
        }),
      }),
    });
    expect(result).toEqual({ status: "unavailable", reason: "stale_revision" });
    expect(embeddingUses.value).toBe(1);
  });

  for (const policyMode of ["encrypted_only", "shadow_encryption"] as const) {
    test(`publishes and exactly replays an authorized ${policyMode} projection`, async () => {
      const contentRepresentation = policyMode === "shadow_encryption"
        ? "dual" as const
        : "protected" as const;
      const original = fixture({
        current: current(false, Object.freeze({}), contentRepresentation),
        policyMode,
      });
      const reference = await prepare(original.projection);
      const publication: PublicationObservation = {
        planRequests: [],
        prepareRequests: [],
        authorizeRequests: [],
        publishRequests: [],
        representations: [],
        ordinaryReaders: [],
        effectUses: 0,
        committed: false,
      };
      const resumed = fixture({
        current: current(true, Object.freeze({}), contentRepresentation),
        sealed: original.sealed,
        policyMode,
        publication,
      });
      const planned = await resumed.projection.planPublication({ authority, reference });
      if (planned.status !== "success"
        || planned.value.kind !== "additional_authority_v1") {
        throw new Error("additional-authority plan was unavailable");
      }
      const plan = planned.value;
      const authorization = Object.freeze({
        kind: "additional_authority_v1" as const,
        plan,
        acknowledgement: Object.freeze({
          type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
          authorizationRequestId: plan.authorizationRequestId,
          effectDisposition: "not_started_v1" as const,
          operationId: plan.operationId,
          requestDigest: plan.requestDigest.slice(),
          requiredAuthorityDigest:
            protectedTaskSemanticAuthorityRequirementsDigest(
              plan.semanticAuthorityRequirements,
            ),
        }),
      });

      expect(await resumed.projection.publishAuthorized({
        authority,
        reference,
        authorization,
      })).toEqual({
        status: "success",
        value: { status: "created", memoryId: PROJECTED, roomLabel: "Destination" },
      });
      expect(await resumed.projection.publishAuthorized({
        authority,
        reference,
        authorization,
      })).toEqual({
        status: "success",
        value: { status: "replayed", memoryId: PROJECTED, roomLabel: "Destination" },
      });

      expect(publication.effectUses).toBe(1);
      expect(publication.planRequests).toHaveLength(2);
      expect(publication.prepareRequests).toHaveLength(2);
      expect(publication.authorizeRequests).toHaveLength(2);
      expect(publication.publishRequests).toHaveLength(2);
      expect(publication.representations).toEqual([
        policyMode === "encrypted_only"
          ? "protected_only"
          : "ordinary_and_protected",
        policyMode === "encrypted_only"
          ? "protected_only"
          : "ordinary_and_protected",
      ]);
      expect(publication.ordinaryReaders).toEqual([
        policyMode === "shadow_encryption",
        policyMode === "shadow_encryption",
      ]);

      const target = {
        mode: "namespace",
        subjectUserId: USER,
        agentId: AGENT,
        readableNamespaceIds: [DESTINATION],
        mutableNamespaceIds: [DESTINATION],
        writableNamespaceId: DESTINATION,
      };
      for (const request of publication.planRequests as Array<Record<string, unknown>>) {
        expect(request["operationId"]).toBe("operation-1");
        expect(request["authority"]).toEqual(target);
      }
      for (const request of publication.prepareRequests as Array<Record<string, unknown>>) {
        expect(request["agentId"]).toBe(AGENT);
        expect(request["authority"]).toEqual(target);
        expect(request["plan"]).toMatchObject({
          operationId: "operation-1",
          memoryId: PROJECTED,
        });
        expect(request["content"]).toEqual({
          kind: "complete",
          payload: {
            formatVersion: 1,
            type: "fact",
            content: "projected fact",
          },
        });
      }
      for (const request of publication.authorizeRequests as Array<Record<string, unknown>>) {
        expect(request["agentId"]).toBe(AGENT);
        expect(request["authority"]).toEqual(target);
        expect(request["target"]).toMatchObject({
          operationId: "operation-1",
          memoryId: PROJECTED,
        });
        expect(request["operation"]).toBe("publish");
      }
      for (const request of publication.publishRequests as Array<Record<string, unknown>>) {
        expect(request["authority"]).toEqual(target);
        expect(request["plan"]).toMatchObject({
          operationId: "operation-1",
          memoryId: PROJECTED,
        });
        expect(request["prepared"]).toEqual({ kind: "prepared-projection" });
      }
    });
  }

  test("rejects a substituted sealed plan before embedding", async () => {
    const embeddingUses = { value: 0 };
    const { projection } = fixture({ current: current(true), embeddingUses });
    const reference = await prepare(projection);
    const planned = await projection.planPublication({ authority, reference });
    if (planned.status !== "success" || planned.value.kind !== "current_v1") {
      throw new Error("current plan was unavailable");
    }
    const substituted: ProtectedTaskProjectionAuthorityPlan = Object.freeze({
      ...planned.value,
      requestDigest: new Uint8Array(32),
    });
    const result = await projection.publishAuthorized({
      authority,
      reference,
      authorization: Object.freeze({
        kind: "current_v1" as const,
        plan: substituted,
      }),
    });
    expect(result.status).toBe("unavailable");
    expect(embeddingUses.value).toBe(0);
  });
});
