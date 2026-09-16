import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  objectId,
  prepareAgentRuntimeInitialization,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  prepareAgentConversationCryptoRevision,
} from "../../src/message/agent-conversation-crypto.ts";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../src/message/conversation-prepared-revision.ts";
import {
  createProtectedConversationAgentContentOpener,
  type ConversationProtectedAgentContentAuthorityPort,
} from "../../src/server/message/protected-conversation-agent-content-opener.ts";
import type {
  ConversationProtectedMessageDtoV2,
} from "../../src/server/message/postgres-conversation-protected-read.ts";
import {
  ConversationCryptoReadUnavailableError,
} from "../../src/server/storage/postgres-conversation-crypto-completion.ts";
import type {
  ProtectedCheckpointNamespaceMaterial,
} from "../../src/checkpoint/protected-checkpoint-cell-crypto.ts";
import type {
  ProtectedAgentRuntimeForegroundEntrypointId,
} from "../../src/invocation/protected-agent-runtime.ts";

const NAMESPACE_ID = "namespace-agent-opener";
const DOMAIN_ID = "domain-agent-opener";
const OBJECT_ID = "message:agent-opener";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000002";

type AuthorityInput<Value> = Readonly<{
  authorizationSession: unknown;
  entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  signal?: AbortSignal;
  execute(context: Readonly<{
    material: ProtectedCheckpointNamespaceMaterial;
    signal: AbortSignal;
    assertActive(): void;
  }>): Value | PromiseLike<Value>;
}>;

type AuthorityResult<Value> =
  | Readonly<{ status: "executed"; value: Value }>
  | Readonly<{
    status: "unavailable";
    reason:
      | "authorization_unavailable"
      | "content_unavailable"
      | "content_invalid";
  }>;

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

function encoded(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function fixture() {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x237_91) },
    { now: () => 1_800_000_000_000 },
  );
  const manager = crypto.generateSigningKeyPair();
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-agent-opener-runtime",
    agentId: agentId("agent-opener"),
    authorizationRevision: authorizationRevision(9),
    configObjects: [{
      objectId: objectId("config-agent-opener"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x91),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId("human-agent-opener-manager"),
      managerAuthorizationRevision: authorizationRevision(4),
      managerDeviceId: cryptoDeviceId("device-agent-opener-manager"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const aiKey = new Uint8Array(32).fill(0x92);
  const revision = prepareAgentConversationCryptoRevision({
    crypto,
    objectId: OBJECT_ID,
    payload: {
      role: "assistant",
      content: "Protected Agent response",
      toolCalls: [{
        id: "tool-call-secret",
        name: "lookup",
        args: { query: "private" },
      }],
    },
    createdAt: 1_800_000_000_000,
    namespace: {
      namespaceId: NAMESPACE_ID,
      accessRevision: 5,
      bindingHash: new Uint8Array(32).fill(0x93),
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(2),
      keyGeneration: 3,
      aiKey,
    },
    grant: {
      grantId: "grant-agent-opener",
      grantHash: new Uint8Array(32).fill(0x94),
      useStatus: "reusable",
    },
    runtime: initialized.runtime,
    signerPublication: initialized.signerPublication,
    resolveCurrentAuthorization: (context) => ({
      context,
      grantAuthorized: true,
      namespaceAuthorized: true,
      domainAuthorized: true,
      agentAuthorized: true,
      hostAllowsOperation: true,
      currentRuntime: {
        agentId: initialized.runtime.agentId,
        authorizationRevision: authorizationRevision(9),
        runtimeGeneration: initialized.runtime.generation,
      },
      signerPublication: initialized.signerPublication,
      currentManagerSigningPublicKey: manager.publicKey,
    }),
  });
  const snapshot = readPreparedConversationCryptoRevisionSnapshot(revision);
  if (snapshot.kind !== "agent-v3") throw new Error("expected Agent revision");
  const value = snapshot.value;
  let objectReads = 0;
  const storage = {
    getObject: async () => {
      objectReads += 1;
      return {
        objectId: value.objectId,
        payloadBytes: value.object.payloadBytes.ciphertext.slice(),
      };
    },
    getObjectAccessState: async () => ({
      head: {
        objectId: value.objectId,
        accessRevision: 0,
        manifestHash: value.access.manifestHash.slice(),
        manifestBytes: value.access.manifestBytes.slice(),
      },
      namespaceEnvelopes: [{
        namespaceId: value.namespaceId,
        envelopeHash: crypto.hash(value.access.envelopeBytes[0]),
        envelopeBytes: value.access.envelopeBytes[0].slice(),
      }],
    }),
    getAgentRuntimeSignerPublication: async () =>
      initialized.signerPublication,
  } as unknown as LatticeStorage;
  const dto: ConversationProtectedMessageDtoV2 = Object.freeze({
    dtoVersion: 2,
    projection: Object.freeze({
      messageId: "41",
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      role: "assistant",
      createdAt: "2027-01-15T08:00:00.000Z",
      editRevision: 0,
    }),
    protectedPayload: Object.freeze({
      status: "encrypted",
      cryptoObjectId: value.objectId,
      payloadVersion: 2,
      keyClass: "ai",
      encryptedPayloadBytesBase64url:
        encoded(value.object.payloadBytes.ciphertext),
      accessManifestBytesBase64url:
        encoded(value.access.manifestBytes),
      namespaceEnvelopeBytesBase64url:
        encoded(value.access.envelopeBytes[0]),
    }),
  });
  const record = Object.freeze({
    dto,
    author: Object.freeze({
      actorId: "actor-agent-opener",
      handle: "genie",
      displayName: "Genie",
    }),
  });
  const material = Object.freeze({
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    domainEpoch: 2,
    accessRevision: 5,
    agentAuthorizationRevision: 9,
    bindingHash: new Uint8Array(32).fill(0x93),
    currentGeneration: 3,
    generations: Object.freeze([
      Object.freeze({ generation: 3, key: aiKey }),
    ]),
  });
  return {
    crypto,
    manager,
    initialized,
    storage,
    record,
    material,
    objectReads: () => objectReads,
  };
}

function authority(
  material: ProtectedCheckpointNamespaceMaterial,
  inspect?: (input: AuthorityInput<unknown>) => void,
): ConversationProtectedAgentContentAuthorityPort {
  const port: ConversationProtectedAgentContentAuthorityPort = Object.freeze({
    execute: async <Value>(
      input: AuthorityInput<Value>,
    ): Promise<AuthorityResult<Value>> => {
      inspect?.(input);
      const controller = new AbortController();
      let active = true;
      const assertActive = () => {
        if (!active || controller.signal.aborted) {
          throw new Error("foreground authority expired");
        }
      };
      try {
        return Object.freeze({
          status: "executed" as const,
          value: await input.execute(Object.freeze({
            material,
            signal: controller.signal,
            assertActive,
          })),
        });
      } finally {
        active = false;
        controller.abort();
      }
    },
  });
  return port;
}

function createSubject(
  state: Awaited<ReturnType<typeof fixture>>,
  overrides: Readonly<{
    storage?: LatticeStorage;
    authority?: ConversationProtectedAgentContentAuthorityPort;
  }> = {},
) {
  return createProtectedConversationAgentContentOpener({
    crypto: state.crypto,
    storage: overrides.storage ?? state.storage,
    authority: overrides.authority ?? authority(state.material),
    resolveHistoricalHumanSigner: () => null,
    resolveHistoricalAgentSignerAuthority: (context) => ({
      ...context,
      managerSigningPublicKey: state.manager.publicKey,
    }),
  });
}

function request(
  state: Awaited<ReturnType<typeof fixture>>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    authorizationSession: Object.freeze({ invocation: "agent-opener" }),
    entrypointId: "foreground.main" as const,
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    expectedAccessRevision: 5,
    expectedPolicyRevision: 9,
    messages: [state.record],
    execute: (outcomes: readonly unknown[]) => outcomes,
    ...overrides,
  };
}

describe("Protected conversation Agent content opener", () => {
  test("opens an authenticated Agent-v3 payload only inside one exact authority callback", async () => {
    const state = await fixture();
    let authorityCalls = 0;
    const opener = createSubject(state, {
      authority: authority(state.material, (input) => {
        authorityCalls += 1;
        expect(input.entrypointId).toBe("foreground.main");
        expect(input.namespaceId).toBe(NAMESPACE_ID);
        expect(input.domainId).toBe(DOMAIN_ID);
        expect(input.expectedAccessRevision).toBe(5);
        expect(input.expectedPolicyRevision).toBe(9);
      }),
    });

    const result = await opener.openBatch(request(state));

    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.value).toEqual([{
      messageId: 41,
      revision: 0,
      status: "opened",
      payload: {
        role: "assistant",
        content: "Protected Agent response",
        toolCalls: [{
          id: "tool-call-secret",
          name: "lookup",
          args: { query: "private" },
        }],
      },
    }]);
    expect(authorityCalls).toBe(1);
    expect(state.objectReads()).toBe(1);
  });

  test("rejects Human-key ciphertext before touching crypto storage", async () => {
    const state = await fixture();
    const humanRecord = {
      ...state.record,
      dto: {
        ...state.record.dto,
        protectedPayload: {
          ...state.record.dto.protectedPayload,
          status: "encrypted" as const,
          keyClass: "human" as const,
        },
      },
    };
    const result = await createSubject(state).openBatch(
      request(state, { messages: [humanRecord] }),
    );

    expect(result).toEqual({
      status: "executed",
      value: [{
        messageId: 41,
        revision: 0,
        status: "unavailable",
        reason: "unauthorized",
      }],
    });
    expect(state.objectReads()).toBe(0);
  });

  test("preserves pending state and detects product-wire substitution", async () => {
    const state = await fixture();
    const pending = {
      ...state.record,
      dto: {
        ...state.record.dto,
        projection: { ...state.record.dto.projection, messageId: "40" },
        protectedPayload: {
          status: "pending" as const,
          reason: "shadow_pending" as const,
        },
      },
    };
    const encrypted = state.record.dto.protectedPayload;
    if (encrypted.status !== "encrypted") throw new Error("expected encrypted");
    const substituted = {
      ...state.record,
      dto: {
        ...state.record.dto,
        protectedPayload: {
          ...encrypted,
          encryptedPayloadBytesBase64url: encoded(new Uint8Array([1, 2, 3])),
        },
      },
    };

    const result = await createSubject(state).openBatch(
      request(state, { messages: [pending, substituted] }),
    );

    expect(result).toEqual({
      status: "executed",
      value: [
        {
          messageId: 40,
          revision: 0,
          status: "pending",
          reason: "shadow_pending",
        },
        {
          messageId: 41,
          revision: 0,
          status: "unavailable",
          reason: "corrupt",
        },
      ],
    });
  });

  test("does not disguise storage failure or expired authority as corrupt content", async () => {
    const state = await fixture();
    const storageFailure = new Error("crypto database unavailable");
    const failingStorage = {
      ...state.storage,
      getObject: async () => {
        throw storageFailure;
      },
    } as LatticeStorage;
    const failedRead = createSubject(state, {
      storage: failingStorage,
    }).openBatch(request(state));
    const failedReadError = await failedRead.catch((error: unknown) => error);
    expect(failedReadError).toBeInstanceOf(
      ConversationCryptoReadUnavailableError,
    );

    const expiredAuthority: ConversationProtectedAgentContentAuthorityPort = {
      execute: async <Value>(
        input: AuthorityInput<Value>,
      ): Promise<AuthorityResult<Value>> => ({
        status: "executed",
        value: await input.execute({
          material: state.material,
          signal: new AbortController().signal,
          assertActive: () => {
            throw new Error("foreground authority expired");
          },
        }),
      }),
    };
    const expired = createSubject(state, {
      authority: expiredAuthority,
    }).openBatch(request(state));
    const expiredError = await expired.catch((error: unknown) => error);
    expect(expiredError).toBeInstanceOf(Error);
    expect((expiredError as Error).message).toContain(
      "foreground authority expired",
    );
  });

  test("fails closed on unauthorized material and oversized batches before content execution", async () => {
    const state = await fixture();
    let contentCalls = 0;
    const wrongMaterial = {
      ...state.material,
      accessRevision: 6,
    };
    const wrong = createSubject(state, {
      authority: authority(wrongMaterial),
    }).openBatch(request(state, {
      execute: () => {
        contentCalls += 1;
        return null;
      },
    }));
    const wrongError = await wrong.catch((error: unknown) => error);
    expect(wrongError).toBeInstanceOf(Error);
    expect((wrongError as Error).message).toContain(
      "Namespace material is unauthorized",
    );
    expect(contentCalls).toBe(0);

    const oversized = await createSubject(state).openBatch(
      request(state, {
        messages: Array.from({ length: 257 }, () => state.record),
        execute: () => {
          contentCalls += 1;
          return null;
        },
      }),
    );
    expect(oversized).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(contentCalls).toBe(0);
  });
});
