import { describe, expect, test } from "bun:test";
import type {
  ProtectedAgentMemoryProjectionReference,
  ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import {
  createResumableProtectedAgentMemoryProjectionPort,
  type ResumableProtectedAgentMemoryProjectionPortInput,
} from "../../src/tools/memory/protected-memory-ports";

type State = Readonly<{ destinationId: string; sourceRevision: number }>;

const authority: ProtectedMemoryAuthority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: "user-1",
  agentId: "agent-1",
  readableNamespaceIds: Object.freeze(["namespace-1"]),
  mutableNamespaceIds: Object.freeze(["namespace-1"]),
  writableNamespaceId: "namespace-1",
});

const request = Object.freeze({
  operationId: "operation-1",
  toolCallId: "call-1",
  authority,
  requesterActorId: "actor-1",
  sourceMemoryIds: Object.freeze(["memory-1"]),
  proposedContent: "Exact private projection",
  targetRoomName: "Destination",
});

function harness(overrides: Partial<
  ResumableProtectedAgentMemoryProjectionPortInput<State>
> = {}) {
  let now = 100;
  const capsules = new Map<string, Readonly<{
    prepared: typeof request;
    state: State;
  }>>();
  let published = 0;
  const input: ResumableProtectedAgentMemoryProjectionPortInput<State> = {
    now: () => now,
    createReferenceId: () => "reference-1",
    ttlMs: 50,
    requesterUserId: "user-1",
    requesterActorId: "actor-1",
    agentId: "agent-1",
    prepare: async () => ({
      status: "success",
      value: {
        kind: "prepared",
        preview: {
          proposedContent: request.proposedContent,
          roomLabel: request.targetRoomName,
          roomKind: "private",
          memberCount: 2,
        },
        state: { destinationId: "room-1", sourceRevision: 4 },
      },
    }),
    seal: async ({ reference, prepared, state }) => {
      const capsule = `sealed:${reference.referenceId}`;
      capsules.set(capsule, { prepared: prepared as typeof request, state });
      return capsule;
    },
    open: async (reference) =>
      capsules.get(reference.sealedPreparation ?? "") ?? null,
    validate: async () => ({
      status: "success",
      value: {
        proposedContent: request.proposedContent,
        roomLabel: request.targetRoomName,
        roomKind: "private",
        memberCount: 2,
      },
    }),
    publish: async () => {
      published += 1;
      return {
        status: "success",
        value: {
          status: "created",
          memoryId: "projection-1",
          roomLabel: "Destination",
        },
      };
    },
    ...overrides,
  };
  return {
    input,
    port: createResumableProtectedAgentMemoryProjectionPort(input),
    advance: (value: number) => { now = value; },
    published: () => published,
  };
}

async function prepareReference(
  port: ReturnType<typeof createResumableProtectedAgentMemoryProjectionPort<State>>,
): Promise<ProtectedAgentMemoryProjectionReference> {
  const result = await port.prepare(request);
  if (result.status !== "success" || result.value.kind !== "prepared") {
    throw new Error("projection preparation failed");
  }
  return result.value.reference;
}

describe("resumable protected Memory projection custody", () => {
  test("restores and publishes from a cloned checkpoint reference in a fresh factory", async () => {
    const first = harness();
    const reference = structuredClone(await prepareReference(first.port));
    const fresh = createResumableProtectedAgentMemoryProjectionPort(first.input);

    expect(await fresh.restore?.({ authority, reference })).toEqual({
      status: "success",
      value: {
        proposedContent: "Exact private projection",
        roomLabel: "Destination",
        roomKind: "private",
        memberCount: 2,
      },
    });
    expect(await fresh.publish({ authority, reference })).toMatchObject({
      status: "success",
      value: { memoryId: "projection-1" },
    });
    expect(first.published()).toBe(1);
  });

  test("rejects old, missing, tampered, expired, and wrong-principal references", async () => {
    const run = harness();
    const reference = await prepareReference(run.port);
    const unavailable = {
      status: "unavailable" as const,
      reason: "authorization_required" as const,
    };
    const {
      sealedPreparation: _sealedPreparation,
      ...legacyReference
    } = reference;

    expect(await run.port.restore?.({
      authority,
      reference: legacyReference,
    })).toEqual(unavailable);
    expect(await run.port.restore?.({
      authority,
      reference: { ...reference, toolCallId: "tampered" },
    })).toEqual(unavailable);
    expect(await run.port.restore?.({
      authority: { ...authority, subjectUserId: "user-2" },
      reference,
    })).toEqual(unavailable);
    run.advance(reference.expiresAt);
    expect(await run.port.publish({ authority, reference })).toEqual(unavailable);
    expect(run.published()).toBe(0);
  });

  test("fails closed when capsule opening or fresh validation fails", async () => {
    const missing = harness({ open: async () => null });
    const missingReference = await prepareReference(missing.port);
    expect(await missing.port.publish({ authority, reference: missingReference }))
      .toEqual({ status: "unavailable", reason: "authorization_required" });

    const stale = harness({
      validate: async () => ({
        status: "unavailable",
        reason: "stale_revision",
      }),
    });
    const staleReference = await prepareReference(stale.port);
    expect(await stale.port.restore?.({ authority, reference: staleReference }))
      .toEqual({ status: "unavailable", reason: "stale_revision" });
    expect(await stale.port.publish({ authority, reference: staleReference }))
      .toEqual({ status: "unavailable", reason: "stale_revision" });
    expect(stale.published()).toBe(0);
  });

  test("rejects recovered plaintext whose exact tool or principal binding changed", async () => {
    const wrong = harness({
      open: async () => ({
        prepared: {
          ...request,
          toolCallId: "other-call",
        },
        state: { destinationId: "room-1", sourceRevision: 4 },
      }),
    });
    const reference = await prepareReference(wrong.port);
    expect(await wrong.port.publish({ authority, reference })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(wrong.published()).toBe(0);
  });

  test("rejects a mode or exact Namespace-authority change on resume", async () => {
    const run = harness();
    const reference = await prepareReference(run.port);
    expect(await run.port.publish({
      authority: {
        ...authority,
        readableNamespaceIds: ["namespace-1", "namespace-2"],
      },
      reference,
    })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(await run.port.publish({
      authority: {
        mode: "scope",
        subjectUserId: "user-1",
        agentId: "agent-1",
        scopeId: "scope-1",
        originWritableNamespaceId: "namespace-1",
      },
      reference,
    })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(run.published()).toBe(0);
  });

  test("rechecks expiry after asynchronous open and validation", async () => {
    let expireDuringOpen = () => {};
    const duringOpen = harness({
      open: async () => {
        expireDuringOpen();
        return {
          prepared: request,
          state: { destinationId: "room-1", sourceRevision: 4 },
        };
      },
    });
    expireDuringOpen = () => duringOpen.advance(150);
    const openReference = await prepareReference(duringOpen.port);
    expect(await duringOpen.port.restore?.({
      authority,
      reference: openReference,
    })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });

    let expireDuringValidation = () => {};
    const duringValidation = harness({
      validate: async () => {
        expireDuringValidation();
        return {
          status: "success",
          value: {
            proposedContent: request.proposedContent,
            roomLabel: request.targetRoomName,
            roomKind: "private",
            memberCount: 2,
          },
        };
      },
    });
    expireDuringValidation = () => duringValidation.advance(150);
    const validationReference = await prepareReference(duringValidation.port);
    expect(await duringValidation.port.publish({
      authority,
      reference: validationReference,
    })).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(duringValidation.published()).toBe(0);
  });

  test("does not issue a reference that expires while sealing", async () => {
    let expireDuringSeal = () => {};
    const run = harness({
      seal: async () => {
        expireDuringSeal();
        return "sealed:late";
      },
    });
    expireDuringSeal = () => run.advance(150);
    expect(await run.port.prepare(request)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
  });
});
