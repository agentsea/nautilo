import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  ForegroundAgentEntityCryptoInvocation,
  ForegroundAgentEntityNamespaceAuthority,
  ProtectedAgentMemoryProjectionReference,
} from "@nautilo/lattice-bridge";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";

import { createForegroundMemoryProjectionCapsule } from
  "../../src/routes/foreground-memory-projection-capsule.ts";

const namespaceId = "checkpoint-namespace-secret";
const policyRevision = 13;
const agentAuthorizationRevision = 17;

const envelope: NamespaceMemoryEnvelope = {
  memoryMode: "namespace",
  ownerId: "sensitive-user-id",
  actorId: "sensitive-actor-id",
  agentId: "sensitive-agent-id",
  roomId: "sensitive-source-room-id",
  readableNamespaces: [namespaceId, "sensitive-source-namespace-id"],
  mutableNamespaces: [namespaceId],
  writableNamespaces: [namespaceId],
  toolPolicy: {},
};

const reference: ProtectedAgentMemoryProjectionReference = Object.freeze({
  referenceVersion: 1,
  referenceId: "projection-reference-1",
  toolCallId: "projection-tool-call-1",
  requesterUserId: envelope.ownerId,
  requesterActorId: envelope.actorId,
  agentId: envelope.agentId,
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_060_000,
});

const payload = Object.freeze({
  prepared: Object.freeze({
    proposedContent: "exact sensitive projection content",
    sourceMemoryIds: Object.freeze([
      "sensitive-source-memory-id",
    ]),
  }),
  state: Object.freeze({
    destination: Object.freeze({
      roomId: "sensitive-destination-room-id",
      namespaceId: "sensitive-destination-namespace-id",
    }),
  }),
});

function authority(overrides: Partial<
  ForegroundAgentEntityNamespaceAuthority
> = {}): ForegroundAgentEntityNamespaceAuthority {
  return {
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
    ...overrides,
  };
}

type Custody = {
  authority: ForegroundAgentEntityNamespaceAuthority;
  key: Uint8Array | null;
  revoked: boolean;
};

class InspectingLatticeCrypto extends LatticeCrypto {
  readonly derivedKeys: Uint8Array[] = [];

  override deriveKey(
    inputKeyMaterial: Uint8Array,
    label: string,
    length?: number,
  ): Uint8Array {
    const key = super.deriveKey(inputKeyMaterial, label, length);
    this.derivedKeys.push(key);
    return key;
  }
}

function fakeCurrentEntities(
  custody: Custody,
  options: Readonly<{
    controller?: AbortController;
    returnMismatchedAuthority?: boolean;
  }> = {},
): Readonly<{
  entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
  controller: AbortController;
  openedKeys: Uint8Array[];
  uses: string[];
}> {
  const controller = options.controller ?? new AbortController();
  const openedKeys: Uint8Array[] = [];
  const uses: string[] = [];

  const unavailable = () => Object.freeze({
    status: "unavailable" as const,
    reason: "content_unavailable" as const,
  });
  const open = async <Value>(execute: (
    namespaceKey: Uint8Array,
    currentAuthority: ForegroundAgentEntityNamespaceAuthority,
  ) => Value | Promise<Value>) => {
    if (controller.signal.aborted || custody.revoked || custody.key === null) {
      return unavailable();
    }
    const openedKey = custody.key.slice();
    const currentAuthority = structuredClone(custody.authority);
    openedKeys.push(openedKey);
    try {
      const value = await execute(openedKey, currentAuthority);
      return controller.signal.aborted
        ? unavailable()
        : Object.freeze({ status: "executed" as const, value });
    } finally {
      openedKey.fill(0);
    }
  };

  const entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  > = {
    signal: controller.signal,
    async use(input) {
      uses.push("use");
      if (
        !options.returnMismatchedAuthority &&
        (input.entity.namespaceId !== custody.authority.namespaceId ||
          input.entity.keyGeneration !==
            custody.authority.namespaceKeyGeneration ||
          input.entity.accessRevision !==
            custody.authority.namespaceAccessRevision)
      ) {
        return unavailable();
      }
      return open((namespaceKey, currentAuthority) => input.execute({
        namespaceKey,
        authority: currentAuthority,
      }));
    },
    async useCurrentSet(input) {
      uses.push("useCurrentSet");
      if (
        input.namespaceIds.length !== 1 ||
        input.namespaceIds[0] !== custody.authority.namespaceId
      ) {
        return unavailable();
      }
      return open((namespaceKey, currentAuthority) => input.execute([{
        namespaceKey,
        authority: currentAuthority,
      }]));
    },
  };
  return Object.freeze({ entities, controller, openedKeys, uses });
}

function factory(input: Readonly<{
  crypto: LatticeCrypto;
  custody: Custody;
  envelope?: NamespaceMemoryEnvelope;
  policyRevision?: number;
  agentAuthorizationRevision?: number;
  returnMismatchedAuthority?: boolean;
  controller?: AbortController;
}>) {
  const gateway = fakeCurrentEntities(input.custody, {
    ...(input.returnMismatchedAuthority === undefined
      ? {}
      : { returnMismatchedAuthority: input.returnMismatchedAuthority }),
    ...(input.controller === undefined
      ? {}
      : { controller: input.controller }),
  });
  return Object.freeze({
    ...gateway,
    capsule: createForegroundMemoryProjectionCapsule({
      crypto: input.crypto,
      entities: gateway.entities,
      namespaceId,
      envelope: input.envelope ?? envelope,
      policyRevision: input.policyRevision ?? policyRevision,
      agentAuthorizationRevision:
        input.agentAuthorizationRevision ?? agentAuthorizationRevision,
    }),
  });
}

async function sealedFixture(namespaceKeyGeneration = 7) {
  const crypto = new InspectingLatticeCrypto({
    bytes: (length) => new Uint8Array(length).fill(0x5a),
  });
  const custody: Custody = {
    authority: authority({ namespaceKeyGeneration }),
    key: new Uint8Array(32).fill(0x31),
    revoked: false,
  };
  const writer = factory({ crypto, custody });
  const sealedPreparation = await writer.capsule.seal(reference, payload);
  const copiedReference = JSON.parse(JSON.stringify({
    ...reference,
    sealedPreparation,
  })) as ProtectedAgentMemoryProjectionReference;
  return { copiedReference, crypto, custody, sealedPreparation, writer };
}

describe("foreground Memory projection capsule", () => {
  test("restores a generation-zero Namespace under fresh custody", async () => {
    const state = await sealedFixture(0);
    const reader = factory({ crypto: state.crypto, custody: state.custody });
    expect(await reader.capsule.open(state.copiedReference)).toEqual(payload);
    expect(reader.uses).toEqual(["use"]);
  });

  test("opens an exact payload from a copied reference under fresh current custody", async () => {
    const state = await sealedFixture();
    const reader = factory({ crypto: state.crypto, custody: state.custody });

    expect(await reader.capsule.open(state.copiedReference)).toEqual(payload);
    expect(state.writer.uses).toEqual(["useCurrentSet"]);
    expect(reader.uses).toEqual(["use"]);
    expect(state.writer.openedKeys).toHaveLength(1);
    expect(reader.openedKeys).toHaveLength(1);
    for (const key of [
      ...state.writer.openedKeys,
      ...reader.openedKeys,
      ...state.crypto.derivedKeys,
    ]) {
      expect(key).toEqual(new Uint8Array(key.length));
    }
  });

  test("keeps sensitive payload and source/destination identifiers out of the capsule", async () => {
    const state = await sealedFixture();

    for (const secret of [
      payload.prepared.proposedContent,
      payload.prepared.sourceMemoryIds[0],
      payload.state.destination.roomId,
      payload.state.destination.namespaceId,
    ]) {
      expect(state.sealedPreparation).not.toContain(secret);
    }
    const serialized = JSON.parse(state.sealedPreparation) as unknown;
    expect(serialized).toMatchObject({
      version: 1,
      keyGeneration: 7,
      accessRevision: 5,
    });
    expect(
      typeof serialized === "object" &&
        serialized !== null &&
        "ciphertext" in serialized &&
        typeof serialized.ciphertext === "string",
    ).toBeTrue();
  });

  test("rejects tampered ciphertext, reference identity, and invocation policy bindings", async () => {
    const state = await sealedFixture();
    const parsed = JSON.parse(state.sealedPreparation) as {
      ciphertext: string;
    };
    const ciphertext = Buffer.from(parsed.ciphertext, "base64");
    const lastIndex = ciphertext.length - 1;
    const lastByte = ciphertext[lastIndex];
    if (lastByte === undefined) throw new Error("test capsule was empty");
    ciphertext[lastIndex] = lastByte ^ 1;
    const tamperedCiphertext = {
      ...state.copiedReference,
      sealedPreparation: JSON.stringify({
        ...parsed,
        ciphertext: ciphertext.toString("base64"),
      }),
    };
    expect(await factory({
      crypto: state.crypto,
      custody: state.custody,
    }).capsule.open(tamperedCiphertext)).toBeNull();

    const referenceChanges: readonly Partial<
      ProtectedAgentMemoryProjectionReference
    >[] = [
      { referenceId: "projection-reference-tampered" },
      { toolCallId: "projection-tool-call-tampered" },
      { requesterUserId: "different-user" },
      { requesterActorId: "different-actor" },
      { agentId: "different-agent" },
      { createdAt: reference.createdAt + 1 },
      { expiresAt: reference.expiresAt + 1 },
    ];
    for (const change of referenceChanges) {
      expect(await factory({
        crypto: state.crypto,
        custody: state.custody,
      }).capsule.open({ ...state.copiedReference, ...change })).toBeNull();
    }

    const invocationChanges: readonly Readonly<{
      envelope?: NamespaceMemoryEnvelope;
      policyRevision?: number;
      agentAuthorizationRevision?: number;
    }>[] = [
      { envelope: { ...envelope, roomId: "different-room" } },
      {
        envelope: {
          ...envelope,
          readableNamespaces: [namespaceId, "different-readable-namespace"],
        },
      },
      { policyRevision: policyRevision + 1 },
      { agentAuthorizationRevision: agentAuthorizationRevision + 1 },
    ];
    for (const change of invocationChanges) {
      expect(await factory({
        crypto: state.crypto,
        custody: state.custody,
        ...change,
      }).capsule.open(state.copiedReference)).toBeNull();
    }
  });

  test("requires the current exact Namespace revision and authenticates its authority", async () => {
    const state = await sealedFixture();
    for (const current of [
      authority({ namespaceKeyGeneration: 8 }),
      authority({ namespaceAccessRevision: 6 }),
    ]) {
      const changedCustody = { ...state.custody, authority: current };
      const reader = factory({
        crypto: state.crypto,
        custody: changedCustody,
      });
      expect(await reader.capsule.open(state.copiedReference)).toBeNull();
      expect(reader.openedKeys).toHaveLength(0);

      const mismatched = factory({
        crypto: state.crypto,
        custody: changedCustody,
        returnMismatchedAuthority: true,
      });
      expect(await mismatched.capsule.open(state.copiedReference)).toBeNull();
      expect(mismatched.openedKeys).toHaveLength(1);
    }

    for (const current of [
      authority({ namespaceHeadDigest: new Uint8Array(32).fill(0x32) }),
      authority({
        namespaceAudienceFingerprint: new Uint8Array(32).fill(0x33),
      }),
      authority({ domainId: "domain-2" }),
      authority({ domainKeyGeneration: 4 }),
      authority({ domainAuthorizationRevision: 12 }),
    ]) {
      expect(await factory({
        crypto: state.crypto,
        custody: { ...state.custody, authority: current },
      }).capsule.open(state.copiedReference)).toBeNull();
    }
  });

  test("fails closed for revoked, aborted, or unavailable current key custody", async () => {
    const state = await sealedFixture();

    state.custody.revoked = true;
    expect(await factory({
      crypto: state.crypto,
      custody: state.custody,
    }).capsule.open(state.copiedReference)).toBeNull();
    state.custody.revoked = false;

    const unavailableKey = state.custody.key;
    state.custody.key = null;
    expect(await factory({
      crypto: state.crypto,
      custody: state.custody,
    }).capsule.open(state.copiedReference)).toBeNull();
    state.custody.key = unavailableKey;

    const controller = new AbortController();
    controller.abort();
    const aborted = factory({
      crypto: state.crypto,
      custody: state.custody,
      controller,
    });
    expect(await aborted.capsule.open(state.copiedReference)).toBeNull();
    let sealFailure: unknown;
    try {
      await aborted.capsule.seal(reference, payload);
    } catch (error) {
      sealFailure = error;
    }
    expect(sealFailure).toBeInstanceOf(Error);
    expect((sealFailure as Error).message).toContain(
      "Projection custody unavailable",
    );
  });

  test("returns null rather than leaking malformed capsule exceptions", async () => {
    const state = await sealedFixture();
    const malformed = [
      undefined,
      "not-json",
      "null",
      "[]",
      "{}",
      JSON.stringify({
        version: 1,
        keyGeneration: 7,
        accessRevision: 5,
        ciphertext: "AQ==",
        extra: true,
      }),
      JSON.stringify({
        version: 2,
        keyGeneration: 7,
        accessRevision: 5,
        ciphertext: "AQ==",
      }),
      JSON.stringify({
        version: 1,
        keyGeneration: -1,
        accessRevision: 5,
        ciphertext: "AQ==",
      }),
      JSON.stringify({
        version: 1,
        keyGeneration: 7,
        accessRevision: -1,
        ciphertext: "AQ==",
      }),
      JSON.stringify({
        version: 1,
        keyGeneration: 7,
        accessRevision: 5,
        ciphertext: "not-base64",
      }),
    ];

    const {
      sealedPreparation: _sealedPreparation,
      ...referenceWithoutCapsule
    } = state.copiedReference;
    for (const sealedPreparation of malformed) {
      const candidate: ProtectedAgentMemoryProjectionReference =
        sealedPreparation === undefined
          ? referenceWithoutCapsule
          : { ...referenceWithoutCapsule, sealedPreparation };
      expect(await factory({
        crypto: state.crypto,
        custody: state.custody,
      }).capsule.open(candidate)).toBeNull();
    }
  });
});
