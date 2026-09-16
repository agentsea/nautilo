import { describe, expect, test } from "bun:test";
import {
  StrictShadowEnforcementError,
  type ProtectedAgentMemoryAccessPort,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedAgentMemoryRepository,
} from "@nautilo/lattice-bridge";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  resolveForegroundProtectedMemoryGraphDeps,
  resolveForegroundProtectedMemoryRepository,
} from "../../src/executors/langgraph-executor";

const namespaceEnvelope = Object.freeze({
  ownerId: "11111111-1111-4111-8111-111111111111",
  actorId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  roomId: "44444444-4444-4444-8444-444444444444",
  readableNamespaces: ["55555555-5555-4555-8555-555555555555"],
  mutableNamespaces: ["55555555-5555-4555-8555-555555555555"],
  writableNamespaces: ["55555555-5555-4555-8555-555555555555"],
  toolPolicy: {},
}) satisfies MemoryAccessEnvelope;

const repository = Object.freeze({}) as ProtectedAgentMemoryRepository;
const full = Object.freeze({
  mode: "encrypted_only" as const,
  shadowBehavior: "strict" as const,
  revision: 19,
});

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected rejection");
  } catch (error) {
    return error;
  }
}

describe("foreground protected Memory repository resolution", () => {
  test("creates one repository for a protected namespace foreground turn", async () => {
    let calls = 0;
    let received: MemoryAccessEnvelope | undefined;
    const result = await resolveForegroundProtectedMemoryRepository({
      envelope: namespaceEnvelope,
      policy: full,
      normalForeground: true,
      session: {
        createForegroundMemoryRepository: async (
          envelope: MemoryAccessEnvelope,
        ) => {
          calls += 1;
          received = envelope;
          return repository;
        },
      },
    });

    expect(result).toBe(repository);
    expect(calls).toBe(1);
    expect(received).toBe(namespaceEnvelope);
  });

  test("does not call the factory for plaintext, scope, or non-foreground work", async () => {
    let calls = 0;
    const session = {
      createForegroundMemoryRepository: async () => {
        calls += 1;
        return repository;
      },
    };
    const scopeEnvelope = {
      memoryMode: "scope" as const,
      ownerId: namespaceEnvelope.ownerId,
      actorId: namespaceEnvelope.actorId,
      agentId: namespaceEnvelope.agentId,
      roomId: namespaceEnvelope.roomId,
      scopeId: "66666666-6666-4666-8666-666666666666",
      toolPolicy: {},
    } satisfies MemoryAccessEnvelope;

    expect(await resolveForegroundProtectedMemoryRepository({
      envelope: namespaceEnvelope,
      policy: { ...full, mode: "plaintext_only" },
      normalForeground: true,
      session,
    })).toBeUndefined();
    expect(await resolveForegroundProtectedMemoryRepository({
      envelope: scopeEnvelope,
      policy: full,
      normalForeground: true,
      session,
    })).toBeUndefined();
    expect(await resolveForegroundProtectedMemoryRepository({
      envelope: namespaceEnvelope,
      policy: full,
      normalForeground: false,
      session,
    })).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("fails closed when Full or Strict Shadow has no repository factory", async () => {
    for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
      const result = resolveForegroundProtectedMemoryRepository({
        envelope: namespaceEnvelope,
        policy: { ...full, mode },
        normalForeground: true,
        session: {},
      });
      expect(await rejected(result)).toBeInstanceOf(StrictShadowEnforcementError);
    }
    expect(await resolveForegroundProtectedMemoryRepository({
      envelope: namespaceEnvelope,
      policy: { ...full, mode: "shadow_encryption", shadowBehavior: "fallback" },
      normalForeground: true,
      session: {},
    })).toBeUndefined();
  });

  test("preserves factory failures", async () => {
    const failure = new Error("factory failed");
    const result = resolveForegroundProtectedMemoryRepository({
      envelope: namespaceEnvelope,
      policy: full,
      normalForeground: true,
      session: {
        createForegroundMemoryRepository: async () => {
          throw failure;
        },
      },
    });
    expect(await rejected(result)).toBe(failure);
  });

  test("builds exact repository, access, and projection graph custody for one eligible invocation", async () => {
    const access = Object.freeze({}) as ProtectedAgentMemoryAccessPort;
    const projection = Object.freeze({}) as ProtectedAgentMemoryProjectionPort;
    const received: MemoryAccessEnvelope[] = [];
    const deps = await resolveForegroundProtectedMemoryGraphDeps({
      envelope: namespaceEnvelope,
      policy: full,
      normalForeground: true,
      session: {
        createForegroundMemoryRepository: async (envelope) => {
          received.push(envelope);
          return repository;
        },
        createForegroundMemoryAccessPort: async (envelope) => {
          received.push(envelope);
          return access;
        },
        createForegroundMemoryProjectionPort: async (envelope) => {
          received.push(envelope);
          return projection;
        },
      },
    });
    const eligible = {
      userId: namespaceEnvelope.ownerId,
      memoryAccessEnvelope: namespaceEnvelope,
      taskRun: false,
      subagentRun: false,
    } as never;

    expect(received).toEqual([
      namespaceEnvelope,
      namespaceEnvelope,
      namespaceEnvelope,
    ]);
    expect(deps.protectedMemoryRepositoryForState?.(eligible)).toBe(repository);
    expect(deps.protectedMemoryAccessPortForState?.(eligible)).toBe(access);
    expect(deps.protectedMemoryProjectionPortForState?.(eligible))
      .toBe(projection);
    expect(deps.fullEncryptionOnlyForState?.(eligible)).toBe(true);
  });

  test("fails closed for mismatched, task, subagent, and scope states", async () => {
    const access = Object.freeze({});
    const projection = Object.freeze({});
    const deps = await resolveForegroundProtectedMemoryGraphDeps({
      envelope: namespaceEnvelope,
      policy: full,
      normalForeground: true,
      session: {
        createForegroundMemoryRepository: async () => repository,
        createForegroundMemoryAccessPort: async () => access as never,
        createForegroundMemoryProjectionPort: async () => projection as never,
      },
    });
    const base = {
      userId: namespaceEnvelope.ownerId,
      memoryAccessEnvelope: namespaceEnvelope,
      taskRun: false,
      subagentRun: false,
    };
    const cases = [
      { ...base, userId: "wrong-owner" },
      { ...base, memoryAccessEnvelope: { ...namespaceEnvelope, actorId: "wrong-actor" } },
      { ...base, memoryAccessEnvelope: { ...namespaceEnvelope, agentId: "wrong-agent" } },
      { ...base, memoryAccessEnvelope: { ...namespaceEnvelope, roomId: "wrong-room" } },
      { ...base, taskRun: true },
      { ...base, subagentRun: true },
      { ...base, memoryAccessEnvelope: {
        memoryMode: "scope" as const,
        ownerId: namespaceEnvelope.ownerId,
        actorId: namespaceEnvelope.actorId,
        agentId: namespaceEnvelope.agentId,
        roomId: namespaceEnvelope.roomId,
        scopeId: "66666666-6666-4666-8666-666666666666",
        toolPolicy: {},
      } },
    ];

    for (const state of cases) {
      expect(() => deps.protectedMemoryRepositoryForState?.(state as never))
        .toThrow("Foreground Memory invocation authority changed");
      expect(() => deps.protectedMemoryAccessPortForState?.(state as never))
        .toThrow("Foreground Memory invocation authority changed");
      expect(() => deps.protectedMemoryProjectionPortForState?.(state as never))
        .toThrow("Foreground Memory invocation authority changed");
    }
  });

  test("keeps the Full predicate while non-foreground and missing-port paths stay inert", async () => {
    let repositoryCalls = 0;
    const nonForeground = await resolveForegroundProtectedMemoryGraphDeps({
      envelope: namespaceEnvelope,
      policy: full,
      normalForeground: false,
      session: {
        createForegroundMemoryRepository: async () => {
          repositoryCalls += 1;
          return repository;
        },
      },
    });
    expect(repositoryCalls).toBe(0);
    expect(nonForeground.protectedMemoryRepositoryForState).toBeUndefined();
    expect(nonForeground.protectedMemoryAccessPortForState).toBeUndefined();
    expect(nonForeground.protectedMemoryProjectionPortForState).toBeUndefined();
    expect(nonForeground.fullEncryptionOnlyForState?.({} as never)).toBe(true);

    const missingPorts = await resolveForegroundProtectedMemoryGraphDeps({
      envelope: namespaceEnvelope,
      policy: full,
      normalForeground: true,
      session: {
        createForegroundMemoryRepository: async () => repository,
      },
    });
    expect(missingPorts.protectedMemoryRepositoryForState).toBeDefined();
    expect(missingPorts.protectedMemoryAccessPortForState).toBeUndefined();
    expect(missingPorts.protectedMemoryProjectionPortForState).toBeUndefined();
    expect(missingPorts.fullEncryptionOnlyForState?.({} as never)).toBe(true);
  });
});
