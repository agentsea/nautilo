import { describe, expect, test } from "bun:test";
import {
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  agentId,
  agentRuntimeGeneration,
  deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto,
  type AgentRuntimeKeyGeneration,
} from "@nautilo/lattice-crypto";
import {
  commitMemoryMutationV1,
  deriveMemoryCryptoObjectIdV1,
  type PreparedMemoryCryptoRevision,
  type VerifiedForegroundAgentObject,
} from "@nautilo/lattice-bridge";
import { readPreparedDeviceWrappedAgentObjectSnapshot } from
  "@nautilo/lattice-bridge/testing";

import { createForegroundDomainMemoryCryptoSession } from
  "../../src/memory/foreground-domain-memory-crypto-session";

const SUBJECT_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const MEMORY_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

type DurableBacking = {
  value: VerifiedForegroundAgentObject | null;
  persistCount: number;
  publicationOperationIds: string[];
};

function setup(options: Readonly<{
  failPersist?: boolean;
  authorityUnavailable?: boolean;
  backing?: DurableBacking;
}> = {}) {
  const crypto = new LatticeCrypto({ bytes: seededRng(0x320_01) });
  const runtime = Object.freeze({
    agentId: agentId(AGENT_ID),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(2),
    key: new Uint8Array(32).fill(0x51),
  }) as AgentRuntimeKeyGeneration;
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const namespaceKey = new Uint8Array(32).fill(0x52);
  const authority = Object.freeze({
    namespaceId: NAMESPACE_ID,
    namespaceAccessRevision: 3,
    namespaceKeyGeneration: 4,
    domainId: "domain-memory",
    domainKeyGeneration: 2,
    domainAuthorizationRevision: 1,
    domainHeadDigest: new Uint8Array(32).fill(0x53),
    namespaceHeadDigest: new Uint8Array(32).fill(0x54),
    namespacePublicationDigest: new Uint8Array(32).fill(0x55),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x56),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0x57),
  });
  let uses = 0;
  const backing = options.backing ?? {
    value: null,
    persistCount: 0,
    publicationOperationIds: [],
  };
  const factory = createForegroundDomainMemoryCryptoSession({
    subjectUserId: SUBJECT_ID,
    agentId: AGENT_ID,
    entrypointId: "foreground.main",
    crypto,
    entities: {
      signal: new AbortController().signal,
      useCurrentSet: async (request) => {
        uses += 1;
        if (options.authorityUnavailable === true) return {
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        };
        return { status: "executed" as const,
          value: await request.execute([{ namespaceKey, authority }]) };
      },
      use: async (request) => {
        uses += 1;
        if (options.authorityUnavailable === true) return {
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        };
        return { status: "executed" as const,
          value: await request.execute({ namespaceKey, authority }) };
      },
    },
    publication: {
      authorizationOperationId: "accepted-foreground-operation",
      grantId: "grant-memory",
      grantDigest: new Uint8Array(32).fill(0x58),
      recipientKeyId: "recipient-memory",
      runtime,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey,
      agentAuthorizationRevision: 1,
    },
    persist: async (prepared) => {
      if (options.failPersist === true) throw new Error("persist failed");
      backing.persistCount += 1;
      const snapshot = readPreparedDeviceWrappedAgentObjectSnapshot(prepared);
      backing.publicationOperationIds.push(snapshot.access.authority.operationId);
      backing.value = Object.freeze({
        objectId: prepared.objectId,
        accessRevision: 0,
        payloadBytes: snapshot.object.payloadBytes.ciphertext.slice(),
        namespaceEnvelopes: Object.freeze(snapshot.access.envelopeBytes.map((bytes) => {
          const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
          return Object.freeze({
            namespaceId: envelope.context.namespaceId,
            keyGeneration: envelope.context.keyGeneration,
            bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
            envelopeBytes: bytes.slice(),
          });
        })),
      });
      return "created";
    },
    read: (request) => Promise.resolve(
      backing.value === null
        || request.expectedAccessRevision !== backing.value.accessRevision
        ? null
        : Object.freeze({
          ...backing.value,
          payloadBytes: backing.value.payloadBytes.slice(),
          namespaceEnvelopes: Object.freeze(backing.value.namespaceEnvelopes.map((entry) =>
            Object.freeze({ ...entry, envelopeBytes: entry.envelopeBytes.slice() })
          )),
        }),
    ),
  });
  return {
    factory,
    uses: () => uses,
    backing,
    setAccessRevision(value: number) {
      if (backing.value === null) throw new Error("Missing durable object");
      backing.value = Object.freeze({ ...backing.value, accessRevision: value });
    },
  };
}

const productAuthority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: SUBJECT_ID,
  agentId: AGENT_ID,
  readableNamespaceIds: Object.freeze([NAMESPACE_ID]),
  mutableNamespaceIds: Object.freeze([NAMESPACE_ID]),
  writableNamespaceId: NAMESPACE_ID,
});

function plan(
  contentRevision = 1,
  mutationCommitment = commitMemoryMutationV1({
    kind: "save",
    payload: {
      formatVersion: 1,
      type: "preference",
      content: "The Human prefers bounded changes.",
    },
  }),
) {
  return Object.freeze({
    operationId: "memory-operation",
    action: contentRevision === 1 ? "created" as const : "updated" as const,
    mutationKind: contentRevision === 1 ? "save" as const : "replace" as const,
    memoryId: MEMORY_ID,
    contentRevision,
    cryptoAccessRevision: 0,
    expectedPriorAccessRevision: contentRevision === 1 ? 0 : 4,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision,
    }),
    requiredNamespaceIds: Object.freeze([NAMESPACE_ID]),
    reservationDigest: new Uint8Array(32).fill(0x61),
    mutationCommitment,
    importance: 0.5,
    createdAt: Date.parse("2027-01-15T08:00:00.000Z"),
  });
}

describe("foreground Domain Memory crypto session", () => {
  test("empty open succeeds without touching foreground key authority", async () => {
    const state = setup();
    expect(await state.factory.session.openMany({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      candidates: [],
    })).toEqual({ status: "success", value: [] });
    expect(state.uses()).toBe(0);
  });

  test("rejects unbound, scope and cancelled invocations before key use", async () => {
    const state = setup();
    const base = {
      entrypointId: "foreground.main" as const,
      agentId: AGENT_ID,
      authority: productAuthority,
      candidates: [],
    };
    expect(await state.factory.session.openMany({
      ...base,
      agentId: "10000000-0000-4000-8000-000000000099",
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(await state.factory.session.openMany({
      ...base,
      entrypointId: "foreground.fork",
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(await state.factory.session.openMany({
      ...base,
      authority: { ...productAuthority,
        subjectUserId: "10000000-0000-4000-8000-000000000098" },
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(await state.factory.session.openMany({
      ...base,
      authority: {
        mode: "scope",
        subjectUserId: SUBJECT_ID,
        agentId: AGENT_ID,
        scopeId: "scope-1",
        originWritableNamespaceId: NAMESPACE_ID,
      },
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    const abort = new AbortController();
    abort.abort();
    expect(await state.factory.session.openMany({ ...base, signal: abort.signal }))
      .toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(state.uses()).toBe(0);
  });

  test("reports revoked foreground authority without calling the commit", async () => {
    const state = setup({ authorityUnavailable: true });
    let commits = 0;
    expect(await state.factory.session.authorizeCommit({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      target: {
        memoryId: MEMORY_ID,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        cryptoObjectId: plan().cryptoObjectId,
        requiredNamespaceIds: [NAMESPACE_ID],
      },
      operation: "publish",
      commit: () => { commits += 1; },
    })).toEqual({ status: "unavailable", reason: "authorization_required" });
    expect(commits).toBe(0);
  });

  test("propagates product failures and preserves a commit completed before cancellation", async () => {
    const state = setup();
    const target = {
      memoryId: MEMORY_ID,
      contentRevision: 1,
      cryptoAccessRevision: 0,
      cryptoObjectId: plan().cryptoObjectId,
      requiredNamespaceIds: [NAMESPACE_ID],
    };
    expect(state.factory.session.authorizeCommit({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      target,
      operation: "publish",
      commit: () => { throw new Error("product transaction failed"); },
    })).rejects.toThrow("product transaction failed");

    const abort = new AbortController();
    expect(await state.factory.session.authorizeCommit({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      target,
      operation: "publish",
      signal: abort.signal,
      commit: () => {
        abort.abort();
        return "published" as const;
      },
    })).toEqual({ status: "success", value: "published" });
  });

  test("prepares, persists and authenticates a payload before minting completion", async () => {
    const state = setup();
    const request = {
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      plan: plan(),
      content: { kind: "complete", payload: {
        formatVersion: 1,
        type: "preference",
        content: "The Human prefers bounded changes.",
      } } as const,
    } as const;
    const prepared = await state.factory.session.prepare(request);
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success") throw new Error(prepared.reason);
    expect(await state.factory.completion.complete(prepared.value)).toBe("duplicate");
    expect(state.factory.readPreparedPayload(prepared.value)).toEqual(request.content.payload);
    expect(Object.isFrozen(state.factory.readPreparedPayload(prepared.value))).toBe(true);
    expect(() => state.factory.readPreparedPayload({ ...prepared.value }))
      .toThrow("another crypto session");
    expect(() => setup().factory.readPreparedPayload(prepared.value))
      .toThrow("another crypto session");
    const replay = await state.factory.session.prepare(request);
    expect(replay.status).toBe("success");
    if (replay.status !== "success") throw new Error(replay.reason);
    expect(await state.factory.completion.complete(replay.value)).toBe("duplicate");
    expect(state.backing.persistCount).toBe(1);
    expect(state.backing.publicationOperationIds).toEqual([
      "accepted-foreground-operation",
    ]);

    const restarted = setup({ backing: state.backing });
    const resumed = await restarted.factory.session.prepare(request);
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") throw new Error(resumed.reason);
    expect(await restarted.factory.completion.complete(resumed.value)).toBe("duplicate");
    expect(state.backing.persistCount).toBe(1);

    const opened = await state.factory.session.openMany({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      candidates: [{
        memoryId: MEMORY_ID,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        cryptoObjectId: plan().cryptoObjectId,
        readNamespaceId: NAMESPACE_ID,
        requiredNamespaceIds: [NAMESPACE_ID],
        importance: 0.5,
        tier: 1,
        score: 0.9,
        createdAt: new Date("2027-01-15T08:00:00.000Z"),
      }],
    });
    expect(opened).toEqual({ status: "success", value: [{
      memoryId: MEMORY_ID,
      contentRevision: 1,
      type: "preference",
      content: "The Human prefers bounded changes.",
    }] });
  });

  test("replacement opens a nonzero-access prior revision and preserves its type", async () => {
    const state = setup();
    const first = await state.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      plan: plan(1, commitMemoryMutationV1({ kind: "save", payload: {
        formatVersion: 1, type: "preference", content: "old content",
      } })),
      content: { kind: "complete", payload: {
        formatVersion: 1, type: "preference", content: "old content",
      } },
    });
    expect(first.status).toBe("success");
    state.setAccessRevision(4);
    const replacement = await state.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      plan: plan(2, commitMemoryMutationV1({
        kind: "replace", content: "new content",
      })),
      content: {
        kind: "replacement",
        previous: {
          memoryId: MEMORY_ID,
          contentRevision: 1,
          cryptoAccessRevision: 4,
          cryptoObjectId: plan().cryptoObjectId,
          requiredNamespaceIds: [NAMESPACE_ID],
        },
        content: "new content",
      },
    });
    expect(replacement.status).toBe("success");
    const opened = await state.factory.session.openMany({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      candidates: [{
        memoryId: MEMORY_ID,
        contentRevision: 2,
        cryptoAccessRevision: 0,
        cryptoObjectId: plan(2).cryptoObjectId,
        readNamespaceId: NAMESPACE_ID,
        requiredNamespaceIds: [NAMESPACE_ID],
        importance: 0.5,
        tier: 1,
        score: 0.9,
        createdAt: new Date("2027-01-15T08:00:00.000Z"),
      }],
    });
    expect(opened).toEqual({ status: "success", value: [{
      memoryId: MEMORY_ID,
      contentRevision: 2,
      type: "preference",
      content: "new content",
    }] });
  });

  test("failed persistence cannot mint and foreign completion rejects handles", async () => {
    const failed = setup({ failPersist: true });
    expect(await failed.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      plan: plan(1, commitMemoryMutationV1({ kind: "save", payload: {
        formatVersion: 1, type: "fact", content: "not durable",
      } })),
      content: { kind: "complete", payload: {
        formatVersion: 1, type: "fact", content: "not durable",
      } },
    })).toEqual({ status: "unavailable", reason: "integrity_failure" });

    const owner = setup();
    const prepared = await owner.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      plan: plan(1, commitMemoryMutationV1({ kind: "save", payload: {
        formatVersion: 1, type: "fact", content: "factory-bound",
      } })),
      content: { kind: "complete", payload: {
        formatVersion: 1, type: "fact", content: "factory-bound",
      } },
    });
    if (prepared.status !== "success") throw new Error(prepared.reason);
    expect(setup().factory.completion.complete(prepared.value)).rejects.toThrow(
      "belongs to another crypto session",
    );
    expect(owner.factory.completion.complete({ ...prepared.value } as
      PreparedMemoryCryptoRevision)).rejects.toThrow(
        "belongs to another crypto session",
      );
  });

  test("rejects content that does not match the product mutation commitment", async () => {
    const state = setup();
    expect(await state.factory.session.prepare({
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: productAuthority,
      plan: plan(),
      content: { kind: "complete", payload: {
        formatVersion: 1,
        type: "preference",
        content: "substituted after reservation",
      } },
    })).toEqual({ status: "unavailable", reason: "integrity_failure" });
    expect(state.uses()).toBe(0);
  });
});
