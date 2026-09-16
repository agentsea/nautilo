import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  deriveMemoryCryptoObjectIdV1,
} from "@nautilo/lattice-bridge";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";

import {
  DARK_BACKGROUND_ENTRYPOINT_INVENTORY,
  InMemoryBackgroundAuthorizationRepository,
  ProtectedAgentMemoryBackgroundCoordinator,
  ProtectedAgentMemoryBackgroundRecipientRegistry,
  createBackgroundAuthorizationRequestV2,
  planProtectedAgentMemoryBackgroundDescriptor,
} from "../../src/protected-execution/background-authorization";
import type {
  BackgroundAuthorizationRecord,
  BackgroundAuthorizationRepository,
  BackgroundAuthorizationVerifiedDeviceResponse,
  ProtectedAgentMemoryBackgroundDescriptorFacts,
} from "../../src/protected-execution/background-authorization";
import {
  __mintProtectedAgentMemoryBackgroundEntrypointTestAuthority,
  createProtectedAgentMemoryBackgroundEntrypointTestComposition,
  enqueueProtectedAgentMemoryBackgroundEntrypoint,
  enqueueProtectedAgentMemoryExitFlush,
} from "../../src/protected-execution/background-authorization/protected-agent-memory-background-entrypoints";

const NOW = 1_800_000_000_000;

function initialRecord(
  workKind: "memory.review" | "memory.exit_flush" = "memory.review",
): BackgroundAuthorizationRecord {
  return {
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId: "request-1",
      workId: "work-1",
      namespaceId: "namespace-a",
      credentialSubject: {
        kind: "agent",
        agentId: "agent-a",
        runtimeGeneration: 1,
        authorizationRevision: 2,
      },
      now: NOW,
    }),
    workIdentityHash: new Uint8Array(32).fill(1),
    idempotencyKey: "attempt-1",
    workKind,
    purpose: workKind,
    domainId: "domain-a",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 5,
    expectedNamespaceAccessRevision: 3,
    expectedPolicyRevision: 4,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: "namespace-a",
        domainId: "domain-a",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 3,
        expectedPolicyRevision: 4,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "domain-a",
        expectedEpoch: 5,
        expectedAgentAuthorizationRevision: 6,
      }],
    },
  };
}

function verifiedResponse(
  record: BackgroundAuthorizationRecord,
): BackgroundAuthorizationVerifiedDeviceResponse {
  if (
    record.descriptorBytes === null
    || record.snapshot.recipient === null
    || record.snapshot.descriptorDigest === null
  ) throw new Error("prepared record required");
  const descriptor = planProtectedAgentMemoryBackgroundDescriptor({
    facts: facts(),
    recipientKeyId: record.snapshot.recipient.recipientKeyId,
    recipientPublicKey: Uint8Array.from(Buffer.from(
      record.snapshot.recipient.recipientPublicKey,
      "base64url",
    )),
  }).descriptor;
  const responseBytes = new Uint8Array([1, 2, 3]);
  return {
    formatVersion: 2,
    kind: "agent",
    requestId: record.snapshot.requestId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: descriptor.recipientKeyId,
    recipientPublicKey: descriptor.recipientPublicKey.slice(),
    descriptorHash: Uint8Array.from(Buffer.from(record.snapshot.descriptorDigest, "hex")),
    workId: descriptor.workId,
    workKind: descriptor.workKind,
    purpose: descriptor.purpose,
    responseHash: createHash("sha256").update(responseBytes).digest(),
    responseBytes,
    credentialId: "grant-1",
    credentialHash: new Uint8Array(32).fill(3),
    issuingHumanId: "human-a",
    issuingDeviceId: "device-a",
    issuingDeviceAuthorizationRevision: authorizationRevision(7),
    issuerSigningPublicKeyHash: new Uint8Array(32).fill(4),
    anchorNamespaceId: descriptor.anchorNamespaceId,
    anchorDomainId: descriptor.anchorDomainId,
    grantScope: descriptor.grantScope,
    inputBindings: descriptor.inputBindings,
    outputSlots: descriptor.outputSlots,
    namespaceRequirements: descriptor.namespaceRequirements,
    domainRequirements: descriptor.domainRequirements,
    issuedAt: descriptor.issuedAt,
    notBefore: descriptor.notBefore,
    expiresAt: descriptor.expiresAt,
    subject: descriptor.subject,
  };
}

function facts(): ProtectedAgentMemoryBackgroundDescriptorFacts {
  const inputMemoryId = "00000000-0000-4000-8000-000000000001";
  const outputMemoryId = "00000000-0000-4000-8000-000000000002";
  const inputObjectId = objectId(deriveMemoryCryptoObjectIdV1({
    memoryId: inputMemoryId,
    contentRevision: 1,
  }));
  const outputObjectId = objectId(deriveMemoryCryptoObjectIdV1({
    memoryId: outputMemoryId,
    contentRevision: 1,
  }));
  return {
    requestId: "request-1",
    recipientGeneration: 0,
    workKind: "memory.review" as const,
    workId: "work-1",
    anchorNamespaceId: namespaceId("namespace-a"),
    anchorDomainId: cryptoDomainId("domain-a"),
    subject: {
      kind: "agent" as const,
      agentId: agentId("agent-a"),
      runtimeGeneration: agentRuntimeGeneration(1),
      authorizationRevision: authorizationRevision(2),
    },
    purpose: "memory.review" as const,
    operations: ["decrypt", "encrypt"] as const,
    source: {
      kind: "protected_memory_work" as const,
      sourceVersion: 1 as const,
      productAuthority: { mode: "namespace" as const },
      inputRevisions: [{
        productKind: "memory" as const,
        productId: inputMemoryId,
        productRevision: 1,
        cryptoAccessRevision: 0,
        accessKind: "namespace" as const,
        objectId: inputObjectId,
      }],
      outputRevisions: [{
        action: "create" as const,
        memoryId: outputMemoryId,
        expectedContentRevision: 0,
        expectedCryptoAccessRevision: 0,
        nextContentRevision: 1,
        objectId: outputObjectId,
        publicationIdempotencyId: "publish-1",
      }],
      tierMutations: [],
    },
    grantScope: [humanId("human-a")],
    inputBindings: [{
      objectId: inputObjectId,
      namespaceId: namespaceId("namespace-a"),
    }],
    outputSlots: [{
      objectId: outputObjectId,
      objectType: "memory.revision",
      createdAt: unixTimestamp(NOW),
      namespaceIds: [namespaceId("namespace-a")],
    }],
    namespaceRequirements: [{
      namespaceId: namespaceId("namespace-a"),
      domainId: cryptoDomainId("domain-a"),
      operations: ["decrypt", "encrypt"] as const,
      expectedAccessRevision: accessRevision(3),
      expectedPolicyRevision: authorizationRevision(4),
    }],
    domainRequirements: [{
      domainId: cryptoDomainId("domain-a"),
      expectedEpoch: domainEpoch(5),
      expectedAgentAuthorizationRevision: authorizationRevision(6),
    }],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 4096,
    maximumCiphertextBytes: 8192,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 60_000,
    idempotencyId: "attempt-1",
  };
}

function coordinator(input: Readonly<{
  repository: BackgroundAuthorizationRepository;
  recipients: ProtectedAgentMemoryBackgroundRecipientRegistry;
  now: () => number;
  descriptorFacts?: (
    record: BackgroundAuthorizationRecord,
  ) => ProtectedAgentMemoryBackgroundDescriptorFacts | null;
  terminal?: ConstructorParameters<typeof ProtectedAgentMemoryBackgroundCoordinator>[0]["terminal"];
  capability?: ConstructorParameters<typeof ProtectedAgentMemoryBackgroundCoordinator>[0]["capability"];
  reconcilePublication?: ConstructorParameters<typeof ProtectedAgentMemoryBackgroundCoordinator>[0]["reconcilePublication"];
}>) {
  return new ProtectedAgentMemoryBackgroundCoordinator({
    repository: input.repository,
    recipients: input.recipients,
    capability: input.capability ?? { open: async () => null },
    terminal: input.terminal ?? {
      execute: async () => ({
        status: "unavailable",
        reason: "authorization_unavailable",
      }),
    },
    reconcilePublication: input.reconcilePublication
      ?? (() => Promise.resolve("not_started")),
    nextAttemptAt: (_record, now) => now + 1_000,
    descriptorFacts: async (record) => input.descriptorFacts === undefined
      ? {
        ...facts(),
        recipientGeneration: record.snapshot.recipientGeneration,
      }
      : input.descriptorFacts(record),
    review: () => ({
      embedding: {} as never,
      modelId: "model",
      roomId: "room-a",
      maximumIterations: 1,
    }),
    now: input.now,
    recipientKeyId: () => "recipient-1",
    claimId: () => "claim-1",
  });
}

function wrapRepository(
  inner: BackgroundAuthorizationRepository,
  stale: (next: BackgroundAuthorizationRecord) => boolean,
): BackgroundAuthorizationRepository {
  return {
    create: (record) => inner.create(record),
    get: (requestId) => inner.get(requestId),
    compareAndSwap: async (input) => stale(input.next)
      ? { status: "stale", current: await inner.get(input.next.snapshot.requestId) }
      : inner.compareAndSwap(input),
    acceptVerifiedResponse: (input) => inner.acceptVerifiedResponse(input),
    listEligible: (input) => inner.listEligible(input),
    listAwaitingDevicePage: (input) =>
      inner.listAwaitingDevicePage(input),
    pruneTerminal: (input) => inner.pruneTerminal(input),
  };
}

describe("protected Agent Memory background Runtime composition", () => {
  test("plans canonical durable descriptors containing only signed coordinates", () => {
    const recipientPublicKey = new Uint8Array(65).fill(7);
    const plan = planProtectedAgentMemoryBackgroundDescriptor({
      facts: facts(),
      recipientKeyId: "recipient-1",
      recipientPublicKey,
    });

    expect(plan.descriptor.source.kind).toBe("protected_memory_work");
    expect(plan.descriptorHash).toHaveLength(32);
    expect(plan.descriptorBytes).not.toContain(Buffer.from("candidate body"));
    expect(plan.descriptorBytes).not.toContain(Buffer.from("system prompt"));
    recipientPublicKey.fill(9);
    expect(plan.descriptor.recipientPublicKey.every((value) => value === 7))
      .toBeTrue();
  });

  test("rejects noncanonical or cross-product inventories before persistence", () => {
    const invalid = facts();
    expect(() => planProtectedAgentMemoryBackgroundDescriptor({
      facts: {
        ...invalid,
        namespaceRequirements: [...invalid.namespaceRequirements, ...invalid.namespaceRequirements],
      },
      recipientKeyId: "recipient-1",
      recipientPublicKey: new Uint8Array(65).fill(7),
    })).toThrow();
  });

  test("marks only Memory entrypoints as real protected adapters", () => {
    expect(DARK_BACKGROUND_ENTRYPOINT_INVENTORY
      .filter((entry) => entry.entrypointId.startsWith("memory."))
      .map((entry) => entry.adapterStatus))
      .toEqual(["protected_adapter", "protected_adapter", "protected_adapter"]);
    expect(DARK_BACKGROUND_ENTRYPOINT_INVENTORY
      .filter((entry) => entry.entrypointId.startsWith("task."))
      .filter((entry) => entry.adapterStatus !== "inventory_only")
      .every((entry) => entry.adapterStatus === "synthetic_adapter"))
      .toBeTrue();
  });

  test("keeps recipient custody process-local and advances generation after restart", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(initialRecord());
    let now = NOW;
    const createCoordinator = (
      recipients: ProtectedAgentMemoryBackgroundRecipientRegistry,
      descriptorFacts?: () => ProtectedAgentMemoryBackgroundDescriptorFacts | null,
    ) => coordinator({
      repository,
      recipients,
      ...(descriptorFacts === undefined
        ? {}
        : { descriptorFacts: () => descriptorFacts() }),
      now: () => now,
    });
    const firstRegistry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    const planned = await createCoordinator(firstRegistry).prepare("request-1");
    expect(planned.status).toBe("authorization_required");
    expect((await repository.get("request-1"))?.snapshot.state)
      .toBe("awaiting_device");

    now += 1;
    const restarted = await createCoordinator(
      new ProtectedAgentMemoryBackgroundRecipientRegistry(new LatticeCrypto()),
    ).prepare("request-1");
    expect(restarted.status).toBe("pending");
    const durable = await repository.get("request-1");
    expect(durable?.snapshot.state).toBe("awaiting_recipient");
    expect(durable?.snapshot.recipientGeneration).toBe(1);
    expect(durable?.descriptorBytes).toBeNull();
    expect(durable?.acceptedMaterial).toBeNull();

    const retryRegistry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    expect((await createCoordinator(retryRegistry, () => null).prepare("request-1")).status)
      .toBe("stale");
    expect((await createCoordinator(retryRegistry).prepare("request-1")).status)
      .toBe("authorization_required");

    now += 5 * 60_000 + 1;
    expect((await createCoordinator(retryRegistry).prepare("request-1")).status)
      .toBe("pending");
    expect((await repository.get("request-1"))?.snapshot.recipientGeneration)
      .toBe(2);
    firstRegistry.clear();
    retryRegistry.clear();
  });

  test("bounds recipient custody at 256 and permits reuse only after deletion", async () => {
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    for (let index = 0; index < 256; index += 1) {
      await registry.create({
        requestId: `request-${index}`,
        recipientGeneration: 0,
        agentId: "agent-a",
        recipientKeyId: `recipient-${index}`,
        expiresAt: NOW + 60_000,
        now: NOW,
      });
    }
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun promise matcher
    await expect(registry.create({
      requestId: "request-overflow",
      recipientGeneration: 0,
      agentId: "agent-a",
      recipientKeyId: "recipient-overflow",
      expiresAt: NOW + 60_000,
      now: NOW,
    })).rejects.toThrow("capacity");
    registry.delete("request-0", 0);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun promise matcher
    await expect(registry.create({
      requestId: "request-reused",
      recipientGeneration: 0,
      agentId: "agent-a",
      recipientKeyId: "recipient-reused",
      expiresAt: NOW + 60_000,
      now: NOW,
    })).resolves.toBeDefined();
    registry.clear();
  });

  test("cleans recipient attempts when inventory is null, throws, or prepare CAS loses", async () => {
    for (const mode of ["null", "throw", "stale"] as const) {
      const inner = new InMemoryBackgroundAuthorizationRepository();
      await inner.create(initialRecord());
      let staleOnce = mode === "stale";
      const repository = mode === "stale"
        ? wrapRepository(inner, () => {
          if (!staleOnce) return false;
          staleOnce = false;
          return true;
        })
        : inner;
      const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
        new LatticeCrypto(),
      );
      const first = coordinator({
        repository,
        recipients: registry,
        now: () => NOW,
        descriptorFacts: mode === "null"
          ? () => null
          : mode === "throw"
          ? () => {
            throw new Error("inventory failed");
          }
          : facts,
      });
      if (mode === "throw") {
        // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun promise matcher
        await expect(first.prepare("request-1")).rejects.toThrow(
          "inventory failed",
        );
      } else {
        expect((await first.prepare("request-1")).status).toBe("stale");
      }
      const retried = await coordinator({
        repository,
        recipients: registry,
        now: () => NOW,
      }).prepare("request-1");
      expect(`${mode}:${retried.status}`).toBe(`${mode}:authorization_required`);
      registry.clear();
    }
  });

  test("rotates an awaiting-device attempt exactly at its recipient TTL", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(initialRecord());
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    let now = NOW;
    const runtime = coordinator({ repository, recipients: registry, now: () => now });
    expect((await runtime.prepare("request-1")).status)
      .toBe("authorization_required");
    now += 60_000;
    expect((await runtime.prepare("request-1")).status).toBe("pending");
    expect((await repository.get("request-1"))?.snapshot.recipientGeneration)
      .toBe(1);
    registry.clear();
  });

  test("accepts an exact durable Agent response and cleans custody when running CAS loses", async () => {
    const inner = new InMemoryBackgroundAuthorizationRepository();
    await inner.create(initialRecord());
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    let staleRunning = true;
    const repository = wrapRepository(inner, (next) => {
      if (next.snapshot.state !== "running" || !staleRunning) return false;
      staleRunning = false;
      return true;
    });
    const runtime = coordinator({
      repository,
      recipients: registry,
      now: () => NOW + 1,
      capability: { open: async () => ({}) as never },
    });
    expect((await runtime.prepare("request-1")).status)
      .toBe("authorization_required");
    const prepared = await repository.get("request-1");
    if (prepared === null) throw new Error("prepared record missing");
    expect(await runtime.acceptVerifiedResponse(verifiedResponse(prepared)))
      .toBe("accepted");
    expect((await runtime.run("request-1")).status).toBe("stale");
    expect(registry.get("request-1", 0, NOW + 1)).toBeNull();
  });

  test("keeps terminal authorization, content, integrity, provider, and thrown failures typed", async () => {
    const cases = [
      {
        expected: { status: "failed", reason: "authorization" },
        expectedState: "awaiting_recipient",
        execute: async () => ({ status: "unavailable", reason: "authorization_unavailable" } as const),
      },
      {
        expected: { status: "pending", reason: "provider_failure" },
        expectedState: "awaiting_recipient",
        execute: async () => ({ status: "executed", value: { status: "unavailable", reason: "transform_unavailable" } } as const),
      },
      {
        expected: { status: "failed", reason: "content" },
        expectedState: "terminal_failure",
        execute: async () => ({ status: "executed", value: { status: "unavailable", reason: "content_unavailable" } } as const),
      },
      {
        expected: { status: "failed", reason: "integrity" },
        expectedState: "terminal_failure",
        execute: async () => ({ status: "executed", value: { status: "unavailable", reason: "descriptor_invalid" } } as const),
      },
      {
        expected: { status: "failed", reason: "execution" },
        expectedState: "terminal_failure",
        execute: async (): Promise<never> => {
          throw new Error("storage failed");
        },
      },
    ] as const;
    for (const testCase of cases) {
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(initialRecord());
      const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
        new LatticeCrypto(),
      );
      const runtime = coordinator({
        repository,
        recipients: registry,
        now: () => NOW + 1,
        capability: { open: async () => ({}) as never },
        terminal: { execute: testCase.execute },
      });
      await runtime.prepare("request-1");
      const prepared = await repository.get("request-1");
      if (prepared === null) throw new Error("prepared record missing");
      await runtime.acceptVerifiedResponse(verifiedResponse(prepared));
      expect(await runtime.run("request-1")).toEqual(testCase.expected);
      expect((await repository.get("request-1"))?.snapshot.state)
        .toBe(testCase.expectedState);
      registry.clear();
    }
  });

  test("recovers publication reconciliation through durable product receipts", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(initialRecord());
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    let reconciliation: "pending" | "completed" = "pending";
    let now = NOW + 1;
    const runtime = coordinator({
      repository,
      recipients: registry,
      now: () => now,
      capability: { open: async () => ({}) as never },
      terminal: {
        execute: async () => ({
          status: "executed",
          value: { status: "publication_pending", publications: [] },
        }),
      },
      reconcilePublication: async () => reconciliation,
    });
    await runtime.prepare("request-1");
    const prepared = await repository.get("request-1");
    if (prepared === null) throw new Error("prepared record missing");
    await runtime.acceptVerifiedResponse(verifiedResponse(prepared));

    expect(await runtime.run("request-1"))
      .toEqual({ status: "publication_pending" });
    expect((await repository.get("request-1"))?.snapshot.state)
      .toBe("publication_reconciliation");
    expect(await runtime.run("request-1"))
      .toEqual({ status: "publication_pending" });
    expect((await repository.get("request-1"))?.snapshot.nextAttemptAt)
      .toBe(now + 1_000);

    now += 1_000;
    reconciliation = "completed";
    expect(await runtime.run("request-1")).toEqual({ status: "completed" });
    expect((await repository.get("request-1"))?.snapshot.state)
      .toBe("completed");
    registry.clear();
  });

  test("does not strand a claimed request when capability opening throws", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(initialRecord());
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    const runtime = coordinator({
      repository,
      recipients: registry,
      now: () => NOW + 1,
      capability: { open: async () => { throw new Error("open failed"); } },
    });
    await runtime.prepare("request-1");
    const prepared = await repository.get("request-1");
    if (prepared === null) throw new Error("prepared record missing");
    await runtime.acceptVerifiedResponse(verifiedResponse(prepared));

    expect(await runtime.run("request-1"))
      .toEqual({ status: "pending", reason: "recipient_lost" });
    expect((await repository.get("request-1"))?.snapshot.state)
      .toBe("awaiting_recipient");
    expect(registry.get("request-1", 0, NOW + 1)).toBeNull();
  });

  test("completes from durable publication evidence after the terminal call throws", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(initialRecord());
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    const runtime = coordinator({
      repository,
      recipients: registry,
      now: () => NOW + 1,
      capability: { open: async () => ({}) as never },
      terminal: {
        execute: async (): Promise<never> => {
          throw new Error("response lost after publication");
        },
      },
      reconcilePublication: () => Promise.resolve("completed"),
    });
    await runtime.prepare("request-1");
    const prepared = await repository.get("request-1");
    if (prepared === null) throw new Error("prepared record missing");
    await runtime.acceptVerifiedResponse(verifiedResponse(prepared));

    expect(await runtime.run("request-1")).toEqual({ status: "completed" });
    expect((await repository.get("request-1"))?.snapshot.state)
      .toBe("completed");
    expect(registry.get("request-1", 0, NOW + 1)).toBeNull();
  });

  test("queues a real content-free main entrypoint only through process-local test authority", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    const runtime = coordinator({
      repository,
      recipients: registry,
      now: () => NOW,
    });
    let plannerInput: Readonly<Record<string, unknown>> | null = null;
    const composition = createProtectedAgentMemoryBackgroundEntrypointTestComposition({
      authority: __mintProtectedAgentMemoryBackgroundEntrypointTestAuthority(),
      repository,
      coordinator: runtime,
      planner: {
        plan: (input) => {
          plannerInput = input;
          return Promise.resolve(initialRecord());
        },
      },
    });

    const result = await enqueueProtectedAgentMemoryBackgroundEntrypoint(
      composition,
      {
        entrypointId: "memory.review.main",
        transcriptThreadId: "thread-1",
        roomId: "room-1",
        agentId: "agent-a",
      },
    );

    expect(result.status).toBe("authorization_required");
    expect(Object.keys(plannerInput ?? {}).sort()).toEqual([
      "agentId",
      "entrypointId",
      "roomId",
      "transcriptThreadId",
    ]);
    expect((await repository.get("request-1"))?.snapshot.state)
      .toBe("awaiting_device");
    expect(() => enqueueProtectedAgentMemoryBackgroundEntrypoint(
      { enqueue: composition.enqueue } as never,
      {
        entrypointId: "memory.review.main",
        transcriptThreadId: "thread-1",
        roomId: "room-1",
        agentId: "agent-a",
      },
    )).toThrow("recognized");
    registry.clear();
  });

  test("explicit protected test composition admits metadata without conversation plaintext", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    const runtime = coordinator({
      repository,
      recipients: registry,
      now: () => NOW,
    });
    let resolvePlanned: (() => void) | undefined;
    const planned = new Promise<void>((resolve) => {
      resolvePlanned = resolve;
    });
    let plannerInput: unknown;
    const composition = createProtectedAgentMemoryBackgroundEntrypointTestComposition({
      authority: __mintProtectedAgentMemoryBackgroundEntrypointTestAuthority(),
      repository,
      coordinator: runtime,
      planner: {
        plan: (input) => {
          plannerInput = input;
          resolvePlanned?.();
          return Promise.resolve(initialRecord());
        },
      },
    });

    await enqueueProtectedAgentMemoryBackgroundEntrypoint(composition, {
      entrypointId: "memory.review.main",
      transcriptThreadId: "thread-1",
      roomId: "room-1",
      agentId: "agent-a",
    });
    await planned;

    expect(JSON.stringify(plannerInput)).not.toContain("unique plaintext canary");
    expect(JSON.stringify(plannerInput)).not.toContain("private soul canary");
    expect(plannerInput).toEqual({
      entrypointId: "memory.review.main",
      transcriptThreadId: "thread-1",
      roomId: "room-1",
      agentId: "agent-a",
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    registry.clear();
  });

  test("exposes a separate content-free protected exit-flush entrypoint", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const registry = new ProtectedAgentMemoryBackgroundRecipientRegistry(
      new LatticeCrypto(),
    );
    const runtime = coordinator({
      repository,
      recipients: registry,
      now: () => NOW,
      descriptorFacts: () => ({
        ...facts(),
        workKind: "memory.exit_flush" as const,
        purpose: "memory.exit_flush" as const,
      }),
    });
    const composition = createProtectedAgentMemoryBackgroundEntrypointTestComposition({
      authority: __mintProtectedAgentMemoryBackgroundEntrypointTestAuthority(),
      repository,
      coordinator: runtime,
      planner: {
        plan: () => Promise.resolve(initialRecord("memory.exit_flush")),
      },
    });

    expect(await enqueueProtectedAgentMemoryExitFlush(composition, {
      transcriptThreadId: "thread-1",
      roomId: "room-1",
      agentId: "agent-a",
    })).toMatchObject({
      status: "authorization_required",
      requestId: "request-1",
    });
    expect((await repository.get("request-1"))?.workKind)
      .toBe("memory.exit_flush");
    registry.clear();
  });
});
