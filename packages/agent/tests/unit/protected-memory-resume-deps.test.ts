import { describe, expect, test } from "bun:test";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryProjectionReference,
} from
  "../../src/tools/memory/protected-memory-ports";
import type { NautiloGraphDeps } from "../../src/agent/graph";
import type { NautiloState } from "../../src/agent/state";
import {
  bindProtectedMemoryResumeDeps,
  identityEnrollmentToolCallIds,
} from
  "../../src/graph/protected-memory-resume-deps";
import {
  projectionApprovalPreview,
  type ProjectionSnapshot,
} from
  "../../src/tools/memory/projection-sharing";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const NAMESPACE = "33333333-3333-4333-8333-333333333333";
const MEMORY = "44444444-4444-4444-8444-444444444444";
const STATE = {} as NautiloState;

const projectionEnvelope = {
  memoryMode: "namespace" as const,
  ownerId: USER,
  actorId: "55555555-5555-4555-8555-555555555555",
  agentId: AGENT,
  roomId: "66666666-6666-4666-8666-666666666666",
  readableNamespaces: [NAMESPACE],
  mutableNamespaces: [NAMESPACE],
  writableNamespaces: [NAMESPACE],
};

const authority = {
  mode: "namespace" as const,
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: [NAMESPACE],
  mutableNamespaceIds: [NAMESPACE],
  writableNamespaceId: NAMESPACE,
};

function request(toolCallId: string) {
  return {
    operationId: `operation-${toolCallId}`,
    toolCallId,
    authority,
    memoryId: MEMORY,
    action: { kind: "grant_user" as const, userHandle: "bob" },
  };
}

function accessPort(
  referenceFor: (toolCallId: string) => Readonly<{
    referenceId: string;
    toolCallId?: string;
  }>,
): ProtectedAgentMemoryAccessPort {
  return {
    prepareApproval: async (input) => {
      const reference = referenceFor(input.toolCallId);
      return { status: "success", value: {
        reference: {
          referenceVersion: 1,
          referenceId: reference.referenceId,
          toolCallId: reference.toolCallId ?? input.toolCallId,
          requesterUserId: USER,
          agentId: AGENT,
        },
        preview: { type: "fact", content: "protected" },
      } };
    },
    change: async (input) => ({ status: "success", value: {
      status: "updated", memoryId: input.memoryId,
    } }),
  };
}

function shareTool(
  id: string,
  protectedApprovalDigest?: string,
  mode = "attach",
) {
  return {
    id,
    name: "share_memory",
    args: { mode, memory_id: MEMORY, target_handle: "@bob" },
    ...(protectedApprovalDigest === undefined ? {} : {
      shareMemoryPreview: { protectedApprovalDigest },
    }),
  };
}

function checkpoint(tools: readonly unknown[], type = "approval_ask") {
  return { tasks: [{ interrupts: [{ value: { type, tools } }] }] };
}

function protectedProjectionCheckpoint(
  reference: ProtectedAgentMemoryProjectionReference,
) {
  return {
    values: {
      userId: USER,
      memoryAccessEnvelope: projectionEnvelope,
      taskRun: false,
      subagentRun: false,
      projectionSnapshots: [{
        kind: "protected",
        toolCallId: reference.toolCallId,
        requesterUserId: USER,
        requesterActorId: projectionEnvelope.actorId,
        agentId: AGENT,
        reference,
      }],
    },
    tasks: [{ interrupts: [{ value: {
      type: "approval_ask",
      tools: [{
        id: reference.toolCallId,
        name: "share_memory",
        args: { mode: "project" },
      }],
    } }] }],
  };
}

function identityCheckpoint(
  tools: readonly unknown[],
  projectionSnapshots: readonly unknown[] = [],
  protectedMemoryTools: readonly Readonly<{
    toolCallId: string;
    mode: "attach" | "project";
  }>[] = [],
  enrollmentIds?: readonly string[],
) {
  const enrollmentToolCallIds = [...(enrollmentIds ?? tools.map((candidate) =>
    (candidate as { id: string }).id
  ))];
  return {
    values: {
      userId: USER,
      memoryAccessEnvelope: projectionEnvelope,
      taskRun: false,
      subagentRun: false,
      messages: [{ tool_calls: tools }],
      projectionSnapshots,
    },
    tasks: [{ interrupts: [{ value: {
      type: "identity_challenge",
      mode: "enrollPin",
      enrollmentToolCallIds,
      ...(protectedMemoryTools.length === 0 ? {} : { protectedMemoryTools }),
    } }] }],
  };
}

async function expectFailure(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

describe("protected Memory resume dependencies", () => {
  test("derives exact enrollment replay markers and preserves legacy interleaved checkpoints", () => {
    const current = identityCheckpoint([
      shareTool("current-project", undefined, "project"),
    ]);
    expect(identityEnrollmentToolCallIds(structuredClone(current)))
      .toEqual(["current-project"]);

    const legacy = structuredClone(current);
    delete (legacy.tasks[0]!.interrupts[0]!.value as {
      enrollmentToolCallIds?: string[];
    }).enrollmentToolCallIds;
    legacy.values.messages.push({ type: "tool", tool_call_id: "rejected" } as never);
    expect(identityEnrollmentToolCallIds(legacy)).toEqual(["current-project"]);

    const generic = structuredClone(current);
    generic.tasks[0]!.interrupts[0]!.value = {
      type: "identity_challenge",
      mode: "verify",
    } as never;
    expect(identityEnrollmentToolCallIds(generic)).toEqual([]);
  });

  test("identity enrollment regenerates protected attach review without granting consent", async () => {
    const port = accessPort((toolCallId) => ({
      referenceId: `fresh-${toolCallId}`,
    }));
    const bound = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => true,
      protectedMemoryAccessPortForState: () => port,
    });
    await bound.restoreIdentityCheckpoint(identityCheckpoint([
      shareTool("pending-attach"),
    ], [], [{ toolCallId: "pending-attach", mode: "attach" }]));
    const wrapped = bound.deps.protectedMemoryAccessPortForState!(STATE)!;

    expect(await wrapped.change({
      operationId: "must-not-change-from-identity",
      authority,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(await wrapped.prepareApproval!(request("pending-attach")))
      .toMatchObject({ status: "success", value: {
        reference: { referenceId: "fresh-pending-attach" },
      } });
    // Identity is not a permanent tool allowlist. A later model call still gets
    // a fresh preparation and its own ordinary ask/prove-it decision.
    expect(await wrapped.prepareApproval!(request("later-attach")))
      .toMatchObject({ status: "success", value: {
        reference: { referenceId: "fresh-later-attach" },
      } });
  });

  test("identity enrollment keeps ordinary sharing compatible but fails closed for missing protected custody", async () => {
    const ordinary = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => false,
    });
    await ordinary.restoreIdentityCheckpoint(identityCheckpoint([
      shareTool("ordinary-attach"),
    ]));

    const protectedResume = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => true,
    });
    await expectFailure(protectedResume.restoreIdentityCheckpoint(
      identityCheckpoint([shareTool("protected-attach")], [], [{
        toolCallId: "protected-attach", mode: "attach",
      }]),
    ), "fresh authorized custody");

    const genericIdentity = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => false,
    });
    const genericCheckpoint = identityCheckpoint([{
      id: "verify-identity", name: "verify_identity", args: {},
    }]);
    genericCheckpoint.tasks[0]!.interrupts[0]!.value = {
      type: "identity_challenge",
      mode: "verify",
    } as never;
    await genericIdentity.restoreIdentityCheckpoint(genericCheckpoint);
  });

  test("mixed enrollment retains custody for an allowed protected share outside the prove-it batch", async () => {
    const mixed = identityCheckpoint([
      shareTool("allowed-protected-share"),
      { id: "prove-it-sibling", name: "run_shell", args: { command: "sudo true" } },
    ], [], [{
      toolCallId: "allowed-protected-share",
      mode: "attach",
    }], ["prove-it-sibling"]);
    const missing = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => false,
    });
    await expectFailure(missing.restoreIdentityCheckpoint(mixed),
      "fresh authorized custody");

    const port = accessPort((toolCallId) => ({ referenceId: `fresh-${toolCallId}` }));
    const restored = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => false,
      protectedMemoryAccessPortForState: () => port,
    });
    await restored.restoreIdentityCheckpoint(structuredClone(mixed));
    expect(await restored.deps.protectedMemoryAccessPortForState!(STATE)!.change({
      operationId: "identity-is-not-consent",
      authority,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
  });

  test("identity enrollment restores only the current protected projection for fresh prove-it review", async () => {
    const now = Date.now();
    const reference: ProtectedAgentMemoryProjectionReference = {
      referenceVersion: 1,
      referenceId: "identity-projection-reference",
      toolCallId: "pending-projection",
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
      createdAt: now - 1_000,
      expiresAt: now + 60_000,
      sealedPreparation: "identity-authenticated-ciphertext",
    };
    const restored: string[] = [];
    const port: ProtectedAgentMemoryProjectionPort = {
      restore: async ({ reference: candidate }) => {
        restored.push(candidate.toolCallId);
        return { status: "success", value: {
          proposedContent: "fresh identity projection review",
          roomLabel: "Destination",
          roomKind: "private",
          memberCount: 2,
        } };
      },
      prepare: async () => ({ status: "unavailable", reason: "authorization_required" }),
      publish: async () => ({ status: "unavailable", reason: "authorization_required" }),
    };
    const currentSnapshot = {
      kind: "protected",
      toolCallId: reference.toolCallId,
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
      reference,
    };
    const bound = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => true,
      protectedMemoryProjectionPortForState: () => port,
    });
    const checkpoint = identityCheckpoint([
      shareTool("pending-projection", undefined, "project"),
    ], [currentSnapshot], [{
      toolCallId: "pending-projection",
      mode: "project",
    }]);

    await bound.restoreIdentityCheckpoint(checkpoint);

    expect(restored).toEqual(["pending-projection"]);
    expect(projectionApprovalPreview(currentSnapshot as ProjectionSnapshot)
      ?.projection.content).toBe("fresh identity projection review");
  });

  test("accepts only the original exact approval digest for checkpointed calls", async () => {
    const references = new Map([
      ["equal", "digest-equal"],
      ["mismatch", "digest-new"],
      ["missing", "digest-new-for-missing"],
      ["new-after-resume", "digest-new-call"],
      ["other-tool", "digest-other-tool"],
      ["projection", "digest-projection"],
    ]);
    const port = accessPort((toolCallId) => ({
      referenceId: references.get(toolCallId) ?? `digest-${toolCallId}`,
    }));
    const bound = bindProtectedMemoryResumeDeps({
      protectedMemoryAccessPortForState: () => port,
    });
    bound.bindCheckpoint(checkpoint([
      shareTool("equal", "digest-equal"),
      shareTool("mismatch", "digest-original"),
      shareTool("missing"),
      { id: "other-tool", name: "search_memory", args: {} },
      shareTool("projection", "digest-original-projection", "project"),
    ]));
    const wrapped = bound.deps.protectedMemoryAccessPortForState!(STATE)!;

    expect(await wrapped.prepareApproval!(request("equal"))).toMatchObject({
      status: "success", value: { reference: { referenceId: "digest-equal" } },
    });
    expect(await wrapped.prepareApproval!(request("mismatch"))).toEqual({
      status: "unavailable", reason: "stale_revision",
    });
    expect(await wrapped.prepareApproval!(request("missing"))).toEqual({
      status: "unavailable", reason: "stale_revision",
    });
    for (const toolCallId of ["new-after-resume", "other-tool", "projection"]) {
      expect(await wrapped.prepareApproval!(request(toolCallId))).toMatchObject({
        status: "success", value: { reference: { toolCallId } },
      });
    }
  });

  test("rejects a preparation that mixes the checkpointed call with another tool identity", async () => {
    const port = accessPort(() => ({
      referenceId: "digest-original",
      toolCallId: "different-tool-call",
    }));
    const bound = bindProtectedMemoryResumeDeps({
      protectedMemoryAccessPortForState: () => port,
    });
    bound.bindCheckpoint(checkpoint([shareTool("original", "digest-original")]));
    const wrapped = bound.deps.protectedMemoryAccessPortForState!(STATE)!;

    expect(await wrapped.prepareApproval!(request("original"))).toEqual({
      status: "unavailable", reason: "stale_revision",
    });
    expect(await wrapped.change({
      operationId: "execute-mixed",
      authority,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: {
        referenceVersion: 1,
        referenceId: "digest-original",
        toolCallId: "different-tool-call",
        requesterUserId: USER,
        agentId: AGENT,
      },
    })).toEqual({
      status: "unavailable", reason: "authorization_required",
    });
    expect(await wrapped.change({
      operationId: "execute-request-identity",
      authority,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
      approvalReference: {
        referenceVersion: 1,
        referenceId: "digest-original",
        toolCallId: "original",
        requesterUserId: USER,
        agentId: AGENT,
      },
    })).toEqual({
      status: "unavailable", reason: "authorization_required",
    });
  });

  test("fails closed without a checkpoint and rejects duplicate protected tool identities", async () => {
    const port = accessPort((toolCallId) => ({ referenceId: `digest-${toolCallId}` }));
    const unbound = bindProtectedMemoryResumeDeps({
      protectedMemoryAccessPortForState: () => port,
    });
    expect(await unbound.deps.protectedMemoryAccessPortForState!(STATE)!
      .prepareApproval!(request("new"))).toEqual({
        status: "unavailable", reason: "authorization_required",
      });
    expect(() => unbound.bindCheckpoint({})).toThrow(
      "Memory resume checkpoint unavailable",
    );

    const duplicate = bindProtectedMemoryResumeDeps({
      protectedMemoryAccessPortForState: () => port,
    });
    expect(() => duplicate.bindCheckpoint({ tasks: [
      { interrupts: [{ value: { type: "approval_ask",
        tools: [shareTool("duplicate", "digest-a")] } }] },
      { interrupts: [{ value: { type: "prove_it_challenge",
        tools: [shareTool("duplicate", "digest-b")] } }] },
    ] })).toThrow("Memory resume tool identity unavailable");
    expect(await duplicate.deps.protectedMemoryAccessPortForState!(STATE)!
      .prepareApproval!(request("duplicate"))).toEqual({
        status: "unavailable", reason: "authorization_required",
      });
  });

  test("requires live access custody for a checkpointed protected approval", () => {
    const withoutResolver = bindProtectedMemoryResumeDeps({});
    expect(() => withoutResolver.bindCheckpoint(checkpoint([
      shareTool("protected", "digest-protected"),
    ]))).toThrow("Protected Memory approval requires fresh authorized custody");

    const unavailableResolver = bindProtectedMemoryResumeDeps({
      protectedMemoryAccessPortForState: () => undefined,
    });
    unavailableResolver.bindCheckpoint(checkpoint([
      shareTool("protected", "digest-protected"),
    ]));
    expect(() => unavailableResolver.deps
      .protectedMemoryAccessPortForState!(STATE)).toThrow(
        "Protected Memory approval requires fresh authorized custody",
      );
  });

  test("restores a copied protected projection snapshot with fresh custody", async () => {
    const now = Date.now();
    const reference: ProtectedAgentMemoryProjectionReference = {
      referenceVersion: 1,
      referenceId: "resume-reference-fresh",
      toolCallId: "projection-resume",
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
      createdAt: now - 1_000,
      expiresAt: now + 60_000,
      sealedPreparation: "authenticated-ciphertext",
    };
    const copied = structuredClone(protectedProjectionCheckpoint(reference));
    const restored: unknown[] = [];
    const port: ProtectedAgentMemoryProjectionPort = {
      restore: async (input) => {
        restored.push(input);
        return { status: "success", value: {
          proposedContent: "approved projected text",
          roomLabel: "Destination",
          roomKind: "private",
          memberCount: 2,
        } };
      },
      prepare: async () => ({ status: "unavailable", reason: "authorization_required" }),
      publish: async () => ({ status: "unavailable", reason: "authorization_required" }),
    };
    const bound = bindProtectedMemoryResumeDeps({
      protectedMemoryProjectionPortForState: () => port,
    });

    await bound.restoreCheckpoint(copied);

    expect(restored).toEqual([{
      authority: {
        mode: "namespace",
        subjectUserId: USER,
        agentId: AGENT,
        readableNamespaceIds: [NAMESPACE],
        mutableNamespaceIds: [NAMESPACE],
        writableNamespaceId: NAMESPACE,
      },
      reference,
    }]);
    const snapshot = copied.values.projectionSnapshots[0]!;
    expect(projectionApprovalPreview(snapshot as ProjectionSnapshot)?.projection.content)
      .toBe("approved projected text");
    expect(JSON.stringify(snapshot)).not.toContain("approved projected text");
  });

  test("returns typed expiry before restoring or publishing any projection", async () => {
    let restored = false;
    const resume = bindProtectedMemoryResumeDeps({
      protectedMemoryProjectionPortForState: () => ({
        restore: async () => { restored = true; return { status: "unavailable", reason: "stale_revision" }; },
        prepare: async () => ({ status: "unavailable", reason: "authorization_required" }),
        publish: async () => { throw new Error("must not publish expired preview"); },
      }),
    });
    await expectFailure(resume.restoreCheckpoint(protectedProjectionCheckpoint({
      referenceVersion: 1, referenceId: "expired-reference", toolCallId: "expired-tool",
      requesterUserId: USER, requesterActorId: projectionEnvelope.actorId, agentId: AGENT,
      createdAt: Date.now() - 60_000, expiresAt: Date.now() - 1,
      sealedPreparation: "checkpoint-authenticated-capsule",
    })), "protected_memory_approval_expired");
    expect(restored).toBe(false);
  });

  test("fails closed for old or unrestorable protected projection references", async () => {
    const now = Date.now();
    const reference: ProtectedAgentMemoryProjectionReference = {
      referenceVersion: 1,
      referenceId: "resume-reference-closed",
      toolCallId: "projection-closed",
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
      createdAt: now - 1_000,
      expiresAt: now + 60_000,
      sealedPreparation: "authenticated-ciphertext-closed",
    };
    const withoutCustody = bindProtectedMemoryResumeDeps({});
    await expectFailure(withoutCustody.restoreCheckpoint(
      protectedProjectionCheckpoint(reference),
    ), "fresh authorized custody");

    const { sealedPreparation: _sealedPreparation, ...oldReference } = reference;
    const old = bindProtectedMemoryResumeDeps({
      protectedMemoryProjectionPortForState: () => ({
        restore: async () => ({ status: "success", value: {
          proposedContent: "must not bind",
          roomLabel: "Destination",
          roomKind: "private",
          memberCount: 1,
        } }),
        prepare: async () => ({ status: "unavailable", reason: "authorization_required" }),
        publish: async () => ({ status: "unavailable", reason: "authorization_required" }),
      }),
    });
    await expectFailure(old.restoreCheckpoint(
      protectedProjectionCheckpoint(oldReference),
    ), "approval is stale");

    const failed = bindProtectedMemoryResumeDeps({
      protectedMemoryProjectionPortForState: () => ({
        restore: async () => ({ status: "unavailable", reason: "stale_revision" }),
        prepare: async () => ({ status: "unavailable", reason: "authorization_required" }),
        publish: async () => ({ status: "unavailable", reason: "authorization_required" }),
      }),
    });
    await expectFailure(failed.restoreCheckpoint(
      protectedProjectionCheckpoint(reference),
    ), "could not be restored");
  });

  test("preserves an ordinary-only projection checkpoint without protected policy", async () => {
    const ordinary = protectedProjectionCheckpoint({
      referenceVersion: 1,
      referenceId: "unused-ordinary-shape",
      toolCallId: "projection-ordinary",
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    ordinary.values.projectionSnapshots = [{
      toolCallId: "projection-ordinary",
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
      sourceFingerprints: [{ id: MEMORY, contentHash: "source-hash" }],
      content: "ordinary projection",
      contentHash: "content-hash",
      destination: { roomId: "room-2", namespaceId: NAMESPACE },
      audienceFingerprint: "audience-hash",
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      creationKey: "ordinary-creation",
    } as never];
    const bound = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => false,
    });

    await bound.restoreCheckpoint(ordinary);
  });

  test("rejects mixed legacy and protected projections instead of downgrading", async () => {
    const now = Date.now();
    const protectedReference: ProtectedAgentMemoryProjectionReference = {
      referenceVersion: 1,
      referenceId: "mixed-protected-reference",
      toolCallId: "mixed-protected",
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
      createdAt: now - 1_000,
      expiresAt: now + 60_000,
      sealedPreparation: "mixed-sealed-preparation",
    };
    const mixed = protectedProjectionCheckpoint(protectedReference);
    mixed.values.projectionSnapshots.push({
      toolCallId: "mixed-legacy",
      requesterUserId: USER,
      requesterActorId: projectionEnvelope.actorId,
      agentId: AGENT,
    } as never);
    mixed.tasks[0]!.interrupts[0]!.value.tools.push({
      id: "mixed-legacy",
      name: "share_memory",
      args: { mode: "project" },
    });
    const bound = bindProtectedMemoryResumeDeps({
      fullEncryptionOnlyForState: () => true,
      protectedMemoryProjectionPortForState: () => ({
        restore: async () => ({ status: "success", value: {
          proposedContent: "must not restore",
          roomLabel: "Destination",
          roomKind: "private",
          memberCount: 1,
        } }),
        prepare: async () => ({ status: "unavailable", reason: "authorization_required" }),
        publish: async () => ({ status: "unavailable", reason: "authorization_required" }),
      }),
    });

    await expectFailure(bound.restoreCheckpoint(mixed),
      "Legacy projection approval cannot enter protected execution",
    );
  });

  test("preserves legacy no-port behavior for a checkpoint without a protected digest", () => {
    const fullEncryptionOnlyForState = () => false;
    const bound = bindProtectedMemoryResumeDeps({ fullEncryptionOnlyForState });
    bound.bindCheckpoint(checkpoint([
      shareTool("ordinary-without-digest"),
      { id: "ordinary-tool", name: "search_memory", args: {} },
    ]));

    expect(bound.deps.protectedMemoryAccessPortForState!(STATE)).toBeUndefined();
    expect(bound.deps.fullEncryptionOnlyForState).toBe(fullEncryptionOnlyForState);
  });

  test("rejects malformed approval interrupt tool collections", () => {
    for (const tools of [undefined, null, {}, "share_memory"]) {
      const bound = bindProtectedMemoryResumeDeps({});
      expect(() => bound.bindCheckpoint({ tasks: [{ interrupts: [{ value: {
        type: "approval_ask", tools,
      } }] }] })).toThrow("Memory resume approval tools unavailable");
    }
  });

  test("reuses wrappers per original port and preserves unrelated graph dependencies", () => {
    const port = accessPort((toolCallId) => ({ referenceId: `digest-${toolCallId}` }));
    const otherPort = accessPort((toolCallId) => ({ referenceId: `other-${toolCallId}` }));
    let selected = port;
    const fullEncryptionOnlyForState = () => true;
    const protectedMemoryRepositoryForState = () => ({ repository: true }) as never;
    const protectedMemoryProjectionPortForState = () => ({ projection: true }) as never;
    const input: NautiloGraphDeps = {
      fullEncryptionOnlyForState,
      protectedMemoryRepositoryForState,
      protectedMemoryProjectionPortForState,
      protectedMemoryAccessPortForState: () => selected,
    };
    const bound = bindProtectedMemoryResumeDeps(input);

    const first = bound.deps.protectedMemoryAccessPortForState!(STATE);
    const again = bound.deps.protectedMemoryAccessPortForState!(STATE);
    selected = otherPort;
    const other = bound.deps.protectedMemoryAccessPortForState!(STATE);

    expect(first).toBe(again);
    expect(first).not.toBe(port);
    expect(other).not.toBe(first);
    expect(bound.deps.fullEncryptionOnlyForState).toBe(fullEncryptionOnlyForState);
    expect(bound.deps.protectedMemoryRepositoryForState)
      .toBe(protectedMemoryRepositoryForState);
    expect(bound.deps.protectedMemoryProjectionPortForState)
      .toBe(protectedMemoryProjectionPortForState);
  });
});
