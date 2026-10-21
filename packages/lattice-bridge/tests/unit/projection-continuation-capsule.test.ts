import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  createAgentMemoryProjectionContinuationCapsule,
  createProtectedTaskMemoryAccessContinuationCapsule,
  type ProtectedAgentMemoryAccessApprovalReference,
  type AgentEntityCryptoInvocation,
  type AgentEntityNamespaceAuthority,
  type AgentMemoryProjectionContinuationIdentityV1,
  type ProtectedAgentMemoryProjectionReference,
} from "../../src/index.ts";

const namespaceId = "projection-custody-namespace";
const namespaceKey = new Uint8Array(32).fill(0x31);
const authority: AgentEntityNamespaceAuthority = Object.freeze({
  namespaceId,
  namespaceAccessRevision: 5,
  namespaceKeyGeneration: 7,
  domainId: "domain-1",
  domainKeyGeneration: 3,
  domainAuthorizationRevision: 11,
  domainHeadDigest: new Uint8Array(32).fill(0x21),
  namespaceHeadDigest: new Uint8Array(32).fill(0x22),
  namespacePublicationDigest: new Uint8Array(32).fill(0x23),
  namespacePublicationSetDigest: new Uint8Array(32).fill(0x24),
  namespaceAudienceFingerprint: new Uint8Array(32).fill(0x25),
});
const reference: ProtectedAgentMemoryProjectionReference = Object.freeze({
  referenceVersion: 1,
  referenceId: "reference-1",
  toolCallId: "tool-1",
  requesterUserId: "user-1",
  requesterActorId: "actor-1",
  agentId: "agent-1",
  createdAt: 100,
  expiresAt: 200,
});
const value = Object.freeze({ proposedContent: "protected projection text" });

const foregroundIdentity: AgentMemoryProjectionContinuationIdentityV1 =
  Object.freeze({
    kind: "foreground_v1" as const,
    ownerId: "user-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    readableNamespaceIds: Object.freeze(["read-2", "read-1"]),
    mutableNamespaceIds: Object.freeze(["mutable-1"]),
    writableNamespaceIds: Object.freeze(["write-1"]),
    policyRevision: 13,
    agentAuthorizationRevision: 17,
  });
const taskIdentity: AgentMemoryProjectionContinuationIdentityV1 = Object.freeze({
  kind: "protected_task_v1" as const,
  taskId: "task-1",
  taskRunId: "run-1",
  graphThreadId: "thread-1",
  subjectUserId: "user-1",
  humanActorId: "actor-1",
  agentId: "agent-1",
  contentNamespaceId: namespaceId,
  policyRevision: 13,
  agentAuthorizationRevision: 17,
});

class InspectingCrypto extends LatticeCrypto {
  readonly derived: Uint8Array[] = [];
  readonly derivationLabels: string[] = [];

  override deriveKey(
    inputKeyMaterial: Uint8Array,
    label: string,
    length?: number,
  ): Uint8Array {
    this.derivationLabels.push(label);
    const result = super.deriveKey(inputKeyMaterial, label, length);
    this.derived.push(result);
    return result;
  }
}

function entities(): Pick<
  AgentEntityCryptoInvocation,
  "signal" | "use" | "useCurrentSet"
>;
function entities(input: Readonly<{
  signal?: AbortSignal;
  authority?: AgentEntityNamespaceAuthority;
}>): Pick<AgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet">;
function entities(input: Readonly<{
  signal?: AbortSignal;
  authority?: AgentEntityNamespaceAuthority;
}> = {}): Pick<
  AgentEntityCryptoInvocation,
  "signal" | "use" | "useCurrentSet"
> {
  const signal = input.signal ?? new AbortController().signal;
  const selectedAuthority = input.authority ?? authority;
  return Object.freeze({
    signal,
    async use(request) {
      if (request.entity.namespaceId !== selectedAuthority.namespaceId
        || request.entity.keyGeneration
          !== selectedAuthority.namespaceKeyGeneration
        || request.entity.accessRevision
          !== selectedAuthority.namespaceAccessRevision) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      const opened = namespaceKey.slice();
      try {
        return Object.freeze({
          status: "executed" as const,
          value: await request.execute({
            namespaceKey: opened,
            authority: selectedAuthority,
          }),
        });
      } finally {
        opened.fill(0);
      }
    },
    async useCurrentSet(request) {
      if (request.namespaceIds.length !== 1
        || request.namespaceIds[0] !== selectedAuthority.namespaceId) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      const opened = namespaceKey.slice();
      try {
        return Object.freeze({
          status: "executed" as const,
          value: await request.execute([{
            namespaceKey: opened,
            authority: selectedAuthority,
          }]),
        });
      } finally {
        opened.fill(0);
      }
    },
  });
}

function legacyDomain(identity: AgentMemoryProjectionContinuationIdentityV1) {
  return identity.kind === "foreground_v1"
    ? "nautilo/foreground-memory-projection/v1"
    : "nautilo/protected-task-memory-projection/v1";
}

function legacyAad(
  identity: AgentMemoryProjectionContinuationIdentityV1,
): Uint8Array {
  const coordinates = identity.kind === "foreground_v1"
    ? [
        identity.ownerId,
        identity.actorId,
        identity.agentId,
        identity.roomId,
        [...identity.readableNamespaceIds].sort(),
        [...identity.mutableNamespaceIds].sort(),
        [...identity.writableNamespaceIds].sort(),
        identity.policyRevision,
        identity.agentAuthorizationRevision,
      ]
    : [
        identity.taskId,
        identity.taskRunId,
        identity.graphThreadId,
        identity.subjectUserId,
        identity.humanActorId,
        identity.agentId,
        identity.contentNamespaceId,
        identity.policyRevision,
        identity.agentAuthorizationRevision,
      ];
  return new TextEncoder().encode(JSON.stringify([
    legacyDomain(identity),
    reference.referenceVersion,
    reference.referenceId,
    reference.toolCallId,
    reference.requesterUserId,
    reference.requesterActorId,
    reference.agentId,
    reference.createdAt,
    reference.expiresAt,
    ...coordinates,
    authority.namespaceId,
    authority.namespaceKeyGeneration,
    authority.namespaceAccessRevision,
    authority.domainId,
    authority.domainKeyGeneration,
    authority.domainAuthorizationRevision,
    Array.from(authority.namespaceHeadDigest),
    Array.from(authority.namespaceAudienceFingerprint),
  ]));
}

function legacySeal(
  crypto: LatticeCrypto,
  identity: AgentMemoryProjectionContinuationIdentityV1,
): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const key = crypto.deriveKey(namespaceKey, legacyDomain(identity), 32);
  const binding = legacyAad(identity);
  try {
    const ciphertext = crypto.aeadSeal(key, plaintext, binding);
    try {
      return JSON.stringify({
        version: 1,
        keyGeneration: authority.namespaceKeyGeneration,
        accessRevision: authority.namespaceAccessRevision,
        ciphertext: Buffer.from(ciphertext).toString("base64"),
      });
    } finally {
      ciphertext.fill(0);
    }
  } finally {
    plaintext.fill(0);
    key.fill(0);
    binding.fill(0);
  }
}

function legacyOpen(
  crypto: LatticeCrypto,
  identity: AgentMemoryProjectionContinuationIdentityV1,
  sealedPreparation: string,
): unknown {
  const cell = JSON.parse(sealedPreparation) as { ciphertext: string };
  const ciphertext = Buffer.from(cell.ciphertext, "base64");
  const key = crypto.deriveKey(namespaceKey, legacyDomain(identity), 32);
  const binding = legacyAad(identity);
  try {
    const plaintext = crypto.aeadOpen(key, ciphertext, binding);
    if (plaintext === null) return null;
    try {
      return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    ciphertext.fill(0);
    key.fill(0);
    binding.fill(0);
  }
}

describe("Memory projection continuation capsule", () => {
  for (const identity of [foregroundIdentity, taskIdentity]) {
    test(`opens independently encoded ${identity.kind} legacy capsules`, async () => {
      const crypto = new LatticeCrypto({
        bytes: length => new Uint8Array(length).fill(0x5a),
      });
      const capsule = createAgentMemoryProjectionContinuationCapsule({
        crypto,
        entities: entities(),
        namespaceId,
        identity,
      });
      expect(await capsule.open({
        ...reference,
        sealedPreparation: legacySeal(crypto, identity),
      })).toEqual(value);
    });

    test(`writes ${identity.kind} capsules readable by the legacy codec`, async () => {
      const crypto = new InspectingCrypto({
        bytes: length => new Uint8Array(length).fill(0x5a),
      });
      const capsule = createAgentMemoryProjectionContinuationCapsule({
        crypto,
        entities: entities(),
        namespaceId,
        identity,
      });
      const sealed = await capsule.seal(reference, value);
      expect(legacyOpen(crypto, identity, sealed)).toEqual(value);
      expect(crypto.derived.slice(0, 1).every(key =>
        key.every(byte => byte === 0))).toBeTrue();
    });
  }

  test("snapshots mutable foreground coordinate arrays before custody", async () => {
    const readable = ["read-2", "read-1"];
    const mutable = ["mutable-1"];
    const writable = ["write-1"];
    const identity: AgentMemoryProjectionContinuationIdentityV1 = {
      ...foregroundIdentity,
      readableNamespaceIds: readable,
      mutableNamespaceIds: mutable,
      writableNamespaceIds: writable,
    };
    const crypto = new LatticeCrypto({
      bytes: length => new Uint8Array(length).fill(0x5a),
    });
    const capsule = createAgentMemoryProjectionContinuationCapsule({
      crypto,
      entities: entities(),
      namespaceId,
      identity,
    });
    readable.splice(0, readable.length, "substituted");
    mutable.push("substituted");
    writable.length = 0;
    const sealed = await capsule.seal(reference, value);
    expect(legacyOpen(crypto, foregroundIdentity, sealed)).toEqual(value);
  });

  test("rejects malformed envelopes and authenticated identity substitution", async () => {
    const crypto = new LatticeCrypto({
      bytes: length => new Uint8Array(length).fill(0x5a),
    });
    const capsule = createAgentMemoryProjectionContinuationCapsule({
      crypto,
      entities: entities(),
      namespaceId,
      identity: taskIdentity,
    });
    for (const sealedPreparation of [
      "not-json",
      "{}",
      JSON.stringify({
        version: 1,
        keyGeneration: 7,
        accessRevision: 5,
        ciphertext: "AQ==",
        extra: true,
      }),
    ]) {
      expect(await capsule.open({ ...reference, sealedPreparation })).toBeNull();
    }
    const sealedPreparation = legacySeal(crypto, taskIdentity);
    const substituted = createAgentMemoryProjectionContinuationCapsule({
      crypto,
      entities: entities(),
      namespaceId,
      identity: { ...taskIdentity, taskRunId: "other-run" },
    });
    expect(await substituted.open({ ...reference, sealedPreparation })).toBeNull();
  });
});


describe("Task Memory access continuation capsule", () => {
  const accessReference: ProtectedAgentMemoryAccessApprovalReference = {
    referenceVersion: 1, referenceId: "access-reference", toolCallId: "share-call",
    requesterUserId: "user-1", agentId: "agent-1",
    taskContinuation: {
      kind: "protected_task_v1", requesterActorId: "actor-1", createdAt: 100,
      sealedPreparation: "",
    },
  };
  const identity = { ...taskIdentity, kind: "protected_task_access_v1" as const };

  test("survives a fresh invocation while separating access and projection domains", async () => {
    const crypto = new InspectingCrypto({ bytes: length => new Uint8Array(length).fill(0x5a) });
    const first = createProtectedTaskMemoryAccessContinuationCapsule({
      crypto, entities: entities(), namespaceId, identity,
    });
    const prepared = { memoryId: "private-memory", targetActorId: "approved-recipient" };
    const sealedPreparation = await first.seal(accessReference, prepared);
    expect(sealedPreparation).not.toContain("private-memory");
    expect(crypto.derivationLabels).toEqual([
      "nautilo/protected-task-memory-access/v1",
    ]);
    const retained = { ...accessReference, taskContinuation: {
      ...accessReference.taskContinuation!, sealedPreparation,
    } };
    const next = createProtectedTaskMemoryAccessContinuationCapsule({
      crypto, entities: entities(), namespaceId, identity,
    });
    expect(await next.open(retained)).toEqual(prepared);
    expect(crypto.derivationLabels).toEqual([
      "nautilo/protected-task-memory-access/v1",
      "nautilo/protected-task-memory-access/v1",
    ]);
    expect(crypto.derived.every(key => key.every(byte => byte === 0))).toBeTrue();

    const projection = createAgentMemoryProjectionContinuationCapsule({
      crypto, entities: entities(), namespaceId, identity: taskIdentity,
    });
    expect(await projection.open({ ...reference, sealedPreparation })).toBeNull();
    expect(await next.open({ ...retained, taskContinuation: {
      ...retained.taskContinuation,
      sealedPreparation: await projection.seal(reference, prepared),
    } })).toBeNull();
    expect(crypto.derivationLabels).toContain(
      "nautilo/protected-task-memory-projection/v1",
    );
    expect(new Set(crypto.derivationLabels)).toEqual(new Set([
      "nautilo/protected-task-memory-access/v1",
      "nautilo/protected-task-memory-projection/v1",
    ]));
  });

  test("rejects every substituted Namespace and Domain authority coordinate", async () => {
    const crypto = new LatticeCrypto({
      bytes: length => new Uint8Array(length).fill(0x5a),
    });
    const capsule = createProtectedTaskMemoryAccessContinuationCapsule({
      crypto, entities: entities(), namespaceId, identity,
    });
    const retained = { ...accessReference, taskContinuation: {
      ...accessReference.taskContinuation!,
      sealedPreparation: await capsule.seal(accessReference, {
        effectId: "authority-bound-effect",
      }),
    } };
    const substitutions: readonly AgentEntityNamespaceAuthority[] = [
      { ...authority, namespaceId: "other-namespace" },
      { ...authority, namespaceAccessRevision:
        authority.namespaceAccessRevision + 1 },
      { ...authority, namespaceKeyGeneration:
        authority.namespaceKeyGeneration + 1 },
      { ...authority, domainId: "other-domain" },
      { ...authority, domainKeyGeneration: authority.domainKeyGeneration + 1 },
      { ...authority, domainAuthorizationRevision:
        authority.domainAuthorizationRevision + 1 },
      { ...authority, namespaceHeadDigest:
        new Uint8Array(32).fill(0x32) },
      { ...authority, namespaceAudienceFingerprint:
        new Uint8Array(32).fill(0x35) },
    ];
    for (const substitutedAuthority of substitutions) {
      const substituted = createProtectedTaskMemoryAccessContinuationCapsule({
        crypto,
        entities: entities({ authority: substitutedAuthority }),
        namespaceId,
        identity,
      });
      expect(await substituted.open(retained)).toBeNull();
    }
  });

  test("reopens through fresh custody after the original invocation aborts", async () => {
    const crypto = new LatticeCrypto({
      bytes: length => new Uint8Array(length).fill(0x5a),
    });
    const originalController = new AbortController();
    const original = createProtectedTaskMemoryAccessContinuationCapsule({
      crypto,
      entities: entities({ signal: originalController.signal }),
      namespaceId,
      identity,
    });
    const prepared = { effectId: "fresh-custody-effect" };
    const retained = { ...accessReference, taskContinuation: {
      ...accessReference.taskContinuation!,
      sealedPreparation: await original.seal(accessReference, prepared),
    } };
    originalController.abort();
    expect(await original.open(retained)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(original.seal(accessReference, prepared)).rejects.toThrow(
      "Projection custody unavailable",
    );

    const fresh = createProtectedTaskMemoryAccessContinuationCapsule({
      crypto,
      entities: entities({ signal: new AbortController().signal }),
      namespaceId,
      identity,
    });
    expect(await fresh.open(retained)).toEqual(prepared);
  });

  test("binds exact Task, Run, checkpoint, requester and reference under fresh custody", async () => {
    const crypto = new LatticeCrypto({ bytes: length => new Uint8Array(length).fill(0x5a) });
    const capsule = createProtectedTaskMemoryAccessContinuationCapsule({
      crypto, entities: entities(), namespaceId, identity,
    });
    const retained = { ...accessReference, taskContinuation: {
      ...accessReference.taskContinuation!,
      sealedPreparation: await capsule.seal(accessReference, { effectId: "exact-effect" }),
    } };
    for (const key of ["taskId", "taskRunId", "graphThreadId", "subjectUserId", "humanActorId", "agentId", "contentNamespaceId"] as const) {
      const changed = createProtectedTaskMemoryAccessContinuationCapsule({
        crypto, entities: entities(), namespaceId, identity: { ...identity, [key]: "substituted" },
      });
      expect(await changed.open(retained)).toBeNull();
    }
    for (const key of ["referenceId", "toolCallId", "requesterUserId", "agentId"] as const) {
      expect(await capsule.open({ ...retained, [key]: "substituted" })).toBeNull();
    }
    expect(await capsule.open({ ...retained, taskContinuation: {
      ...retained.taskContinuation, requesterActorId: "other-actor",
    } })).toBeNull();
    expect(await capsule.open({ ...retained, taskContinuation: {
      ...retained.taskContinuation, createdAt: 101,
    } })).toBeNull();
    expect(await capsule.open({
      referenceVersion: 1, referenceId: accessReference.referenceId,
      toolCallId: accessReference.toolCallId,
      requesterUserId: accessReference.requesterUserId, agentId: accessReference.agentId,
    })).toBeNull();
    expect(await capsule.open({ ...retained, taskContinuation: {
      ...retained.taskContinuation, sealedPreparation: "malformed",
    } })).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const expiredCustody = createProtectedTaskMemoryAccessContinuationCapsule({
      crypto, entities: { ...entities(), signal: controller.signal }, namespaceId, identity,
    });
    expect(await expiredCustody.open(retained)).toBeNull();
    const rejected = await expiredCustody.seal(accessReference, {}).then(
      () => false,
      () => true,
    );
    expect(rejected).toBe(true);
  });
});
