import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  encodeBackgroundWorkDescriptorV2,
  verifyBackgroundAuthorizationResponseV2,
  type BackgroundAuthorizationIssuerV2,
  type BackgroundNamespaceAuthorityV2,
  type BackgroundProcessorWorkDescriptorV2,
  type BackgroundReflectionWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";

import {
  respondToCurrentDeviceAuthorizationV2,
  type CurrentBackgroundAuthorizationSigningAuthorityV2,
  type DeviceAuthorizationResponderV2Input,
  type WithCurrentBackgroundAuthorizationSigningAuthorityV2,
} from "../../src/client/background/device-authorization-responder-v2.ts";
import type {
  DomainKeyAuthorityClientV2,
  OpenedDomainKeyAuthorityV2,
} from "../../src/client/message/domain-key-authority-client.ts";
import type {
  DomainNamespaceAuthorityClientV2,
  OpenedDomainNamespaceAuthorityV2,
  OpenedDomainNamespaceGenerationV2,
} from "../../src/client/message/domain-namespace-authority-client.ts";

const NOW = 1_700_000_000_001;
const SERVER_SCOPE = "https://m317.example";
const SERVER_INSTANCE_ID = "f0957632-c716-4b4e-a366-28bfcd9a1959";

type AuthorityOutcome = "opened" | "pending" | "unavailable";

type Fixture = Awaited<ReturnType<typeof fixture>>;

function changedBytes(value: Uint8Array): Uint8Array {
  const changed = value.slice();
  changed[0]! ^= 1;
  return changed;
}

function allZero(value: Uint8Array | undefined): boolean {
  return value !== undefined && value.every((byte) => byte === 0);
}

async function fixture() {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {
    formatVersion: 2,
    requestId: "request-317",
    recipientGeneration: 2,
    workKind: "stenographer.extraction",
    workId: "work-317",
    anchorNamespaceId: "namespace-317",
    anchorDomainId: "domain-317",
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
    operations: ["decrypt", "encrypt"],
    purpose: "journal.extract",
    authority: {
      serverId: SERVER_SCOPE,
      roomId: "room-317",
      namespaceId: "namespace-317",
      namespaceAccessRevision: 4,
      namespaceKeyGeneration: 5,
      namespaceHeadDigest: new Uint8Array(32).fill(1),
      domainId: "domain-317",
      domainKeyGeneration: 6,
      domainAuthorizationRevision: 7,
      domainHeadDigest: new Uint8Array(32).fill(2),
      bundleRevision: 8,
      bundleDigest: new Uint8Array(32).fill(3),
    },
    policyRevision: 9,
    source: {
      kind: "stenographer_work",
      startSequence: 10,
      endSequence: 12,
      rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(4),
    },
    inputBindings: ["message-10", "message-12"].map((objectId) => ({objectId, namespaceId: "namespace-317"})),
    outputSlots: [{
      objectId: "record-317",
      objectType: "nautilo.reflection.record.v1",
      createdAt: NOW,
      namespaceIds: ["namespace-317"],
    }],
    maximumPlaintextBytes: 512 * 1_024,
    maximumCiphertextBytes: 1_024 * 1_024 + 40,
    recipientKeyId: "recipient-317",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW - 1,
    notBefore: NOW - 1,
    expiresAt: NOW + 299_999,
    idempotencyId: "idempotency-317",
  };
  const issuer: BackgroundAuthorizationIssuerV2 = {
    humanId: "human-317",
    deviceId: "device-317",
    deviceGeneration: 11,
    serverInstanceId: SERVER_INSTANCE_ID,
    lineageGeneration: 12,
    epoch: 13,
    securityRevision: 14,
    headDigest: new Uint8Array(32).fill(5),
    signingPublicKeyHash: crypto.hash(device.publicKey),
  };
  return {
    crypto,
    device,
    recipient,
    descriptor,
    descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
    issuer,
    domainKey: new Uint8Array(32).fill(6),
    events: [] as string[],
  };
}

type ReflectionFixture = Awaited<ReturnType<typeof reflectionFixture>>;

async function reflectionFixture(sharedDomain: boolean) {
  const base = await fixture();
  const authority = (
    suffix: "a" | "b",
    domainSuffix: "a" | "b",
  ): BackgroundNamespaceAuthorityV2 => ({
    serverId: SERVER_SCOPE,
    roomId: `room-${suffix}`,
    namespaceId: `namespace-${suffix}`,
    namespaceAccessRevision: suffix === "a" ? 21 : 22,
    namespaceKeyGeneration: suffix === "a" ? 31 : 32,
    namespaceHeadDigest: new Uint8Array(32).fill(
      suffix === "a" ? 41 : 42,
    ),
    domainId: `domain-${domainSuffix}`,
    domainKeyGeneration: domainSuffix === "a" ? 51 : 52,
    domainAuthorizationRevision: domainSuffix === "a" ? 61 : 62,
    domainHeadDigest: new Uint8Array(32).fill(
      domainSuffix === "a" ? 71 : 72,
    ),
    bundleRevision: suffix === "a" ? 81 : 82,
    bundleDigest: new Uint8Array(32).fill(suffix === "a" ? 91 : 92),
  });
  const first = authority("a", "a");
  const second = authority("b", sharedDomain ? "a" : "b");
  const { authority: _stenographerAuthority, ...descriptorCommon }
    = base.descriptor;
  void _stenographerAuthority;
  const descriptor: BackgroundReflectionWorkDescriptorV2 = {
    ...descriptorCommon,
    workKind: "reflection.authority_reproject",
    workId: "reflection-work-317",
    anchorNamespaceId: first.namespaceId,
    anchorDomainId: first.domainId,
    subject: {
      kind: "processor",
      processorKind: "reflection",
      processorVersion: 1,
    },
    purpose: "record.reproject",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "reflection_authority",
      recordRef: "record-source-317",
      sourceChangeGeneration: 11,
      projectionGeneration: 12,
      expectedRepresentationGeneration: 13,
      targetRepresentationGeneration: 14,
      fingerprint: new Uint8Array(32).fill(101),
    },
    namespaceRequirements: [
      { authority: first, operations: ["decrypt", "encrypt"] },
      { authority: second, operations: ["decrypt", "encrypt"] },
    ],
    inputBindings: [
      { objectId: "record-current-317", namespaceId: first.namespaceId },
      { objectId: "record-source-317", namespaceId: second.namespaceId },
    ],
    outputSlots: [{
      objectId: "record-next-317",
      objectType: "nautilo.reflection.record.v1",
      createdAt: NOW,
      namespaceIds: [first.namespaceId, second.namespaceId],
    }],
  };
  const keys = new Map<string, Uint8Array>([
    ["domain-a", new Uint8Array(32).fill(111)],
    ...(sharedDomain
      ? []
      : [["domain-b", new Uint8Array(32).fill(112)] as const]),
  ]);
  return {
    ...base,
    descriptor,
    descriptorBytes: encodeBackgroundWorkDescriptorV2(descriptor),
    authorities: new Map(descriptor.namespaceRequirements.map((entry) => [
      entry.authority.namespaceId,
      entry.authority,
    ])),
    keys,
    namespaceLeaseOpen: false,
    namespaceCalls: [] as string[],
    domainCalls: [] as string[],
    borrowedDomainKeys: [] as Uint8Array[],
  };
}

function reflectionNamespaceClient(input: Readonly<{
  fixture: ReflectionFixture;
  failNamespaceId?: string;
  staleOnRevalidationNamespaceId?: string;
}>): DomainNamespaceAuthorityClientV2 {
  const calls = new Map<string, number>();
  return {
    ensure: async () => ({ status: "ready" }),
    servicePending: async () => 0,
    withOpenedGenerations: async <Value>(request: Parameters<
      DomainNamespaceAuthorityClientV2["withOpenedGenerations"]
    >[0], use: (
      entries: readonly OpenedDomainNamespaceGenerationV2[],
      authority: OpenedDomainNamespaceAuthorityV2,
    ) => Value | Promise<Value>) => {
      const expected = input.fixture.authorities.get(request.namespaceId);
      if (expected === undefined) {
        return { status: "unavailable", reason: "unknown_namespace" };
      }
      input.fixture.namespaceCalls.push(
        `${request.sourceRoomId}:${request.namespaceId}`,
      );
      if (request.namespaceId === input.failNamespaceId) {
        return { status: "pending", reason: "fixture" };
      }
      const count = (calls.get(request.namespaceId) ?? 0) + 1;
      calls.set(request.namespaceId, count);
      const stale = request.namespaceId
        === input.staleOnRevalidationNamespaceId && count === 2;
      const generationKey = new Uint8Array(32).fill(121);
      const entryHead = expected.namespaceHeadDigest.slice();
      const authority: OpenedDomainNamespaceAuthorityV2 = {
        sourceRoomId: expected.roomId,
        serverId: expected.serverId,
        namespaceId: expected.namespaceId,
        keyClass: "ai",
        namespaceAccessRevision: expected.namespaceAccessRevision
          + (stale ? 1 : 0),
        namespaceKeyGeneration: expected.namespaceKeyGeneration,
        namespaceHeadDigest: expected.namespaceHeadDigest.slice(),
        domainId: expected.domainId,
        domainKeyGeneration: expected.domainKeyGeneration,
        domainAuthorizationRevision: expected.domainAuthorizationRevision,
        domainHeadDigest: expected.domainHeadDigest.slice(),
        bundleRevision: expected.bundleRevision,
        bundleDigest: expected.bundleDigest.slice(),
      };
      const entries: readonly OpenedDomainNamespaceGenerationV2[] = [{
        namespaceId: expected.namespaceId,
        keyClass: "ai",
        accessRevision: expected.namespaceAccessRevision,
        generation: expected.namespaceKeyGeneration,
        headDigest: entryHead,
        generationKey,
      }];
      expect(input.fixture.namespaceLeaseOpen).toBe(false);
      input.fixture.namespaceLeaseOpen = true;
      try {
        return { status: "opened", value: await use(entries, authority) };
      } finally {
        input.fixture.namespaceLeaseOpen = false;
        generationKey.fill(0);
        entryHead.fill(0);
        authority.namespaceHeadDigest.fill(0);
        authority.domainHeadDigest.fill(0);
        authority.bundleDigest.fill(0);
      }
    },
  };
}

function reflectionDomainClient(input: Readonly<{
  fixture: ReflectionFixture;
  failDomainId?: string;
  afterDomain?: (domainId: string) => void;
}>): DomainKeyAuthorityClientV2 {
  return {
    ensure: async () => ({ status: "ready" }),
    servicePending: async () => ({ status: "ready", fulfilled: 0 }),
    withDomainKey: async <Value>(request: Parameters<
      DomainKeyAuthorityClientV2["withDomainKey"]
    >[0], use: (
      domainKey: Uint8Array,
      authority: OpenedDomainKeyAuthorityV2,
    ) => Value | Promise<Value>) => {
      expect(input.fixture.namespaceLeaseOpen).toBe(false);
      const namespace = input.fixture.authorities.get(request.namespaceId);
      if (namespace === undefined) {
        return { status: "unavailable", reason: "unknown_namespace" };
      }
      input.fixture.domainCalls.push(namespace.domainId);
      if (namespace.domainId === input.failDomainId) {
        return { status: "pending", reason: "fixture" };
      }
      const source = input.fixture.keys.get(namespace.domainId);
      if (source === undefined) {
        return { status: "unavailable", reason: "unknown_domain" };
      }
      const key = source.slice();
      input.fixture.borrowedDomainKeys.push(key);
      const authority: OpenedDomainKeyAuthorityV2 = {
        serverId: namespace.serverId,
        domainId: namespace.domainId,
        participantDigest: new Uint8Array(32).fill(122),
        participantCount: 2,
        keyClass: "ai",
        domainKeyGeneration: namespace.domainKeyGeneration,
        authorizationRevision: namespace.domainAuthorizationRevision,
        headDigest: namespace.domainHeadDigest.slice(),
        recipientDeviceSigningGeneration: 11,
      };
      try {
        return { status: "opened", value: await use(key, authority) };
      } finally {
        key.fill(0);
        authority.participantDigest.fill(0);
        authority.headDigest.fill(0);
        input.afterDomain?.(namespace.domainId);
      }
    },
    serviceBacklog: async () => ({
      status: "ready",
      coordinates: 0,
      fulfilled: 0,
    }),
  };
}

function reflectionOperationInput(input: Readonly<{
  fixture: ReflectionFixture;
  namespaceAuthority?: DomainNamespaceAuthorityClientV2;
  domainAuthority?: DomainKeyAuthorityClientV2;
  withCurrentSigningAuthority?:
    WithCurrentBackgroundAuthorizationSigningAuthorityV2;
  signal?: AbortSignal;
}>): DeviceAuthorizationResponderV2Input {
  return {
    descriptorBytes: input.fixture.descriptorBytes,
    namespaceAuthority: input.namespaceAuthority
      ?? reflectionNamespaceClient({ fixture: input.fixture }),
    domainAuthority: input.domainAuthority
      ?? reflectionDomainClient({ fixture: input.fixture }),
    crypto: input.fixture.crypto,
    serverId: SERVER_SCOPE,
    now: () => NOW,
    createId: () => "credential-reflection-317",
    withCurrentSigningAuthority: input.withCurrentSigningAuthority
      ?? signingAuthority({ fixture: input.fixture }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function namespaceClient(input: Readonly<{
  fixture: Fixture;
  outcome?: AuthorityOutcome;
  change?: (
    authority: OpenedDomainNamespaceAuthorityV2,
  ) => OpenedDomainNamespaceAuthorityV2;
  changeEntry?: (
    entry: OpenedDomainNamespaceGenerationV2,
  ) => OpenedDomainNamespaceGenerationV2;
  onRequest?: (request: Parameters<
    DomainNamespaceAuthorityClientV2["withOpenedGenerations"]
  >[0]) => void;
}>): DomainNamespaceAuthorityClientV2 {
  return {
    ensure: async () => ({ status: "ready" }),
    servicePending: async () => 0,
    withOpenedGenerations: async <Value>(request: Parameters<
      DomainNamespaceAuthorityClientV2["withOpenedGenerations"]
    >[0], use: (
      entries: readonly OpenedDomainNamespaceGenerationV2[],
      authority: OpenedDomainNamespaceAuthorityV2,
    ) => Value | Promise<Value>) => {
      input.onRequest?.(request);
      const outcome = input.outcome ?? "opened";
      if (outcome !== "opened") return { status: outcome, reason: "fixture" };
      const descriptor = input.fixture.descriptor;
      const generationKey = new Uint8Array(32).fill(91);
      const entryHead = descriptor.authority.namespaceHeadDigest.slice();
      const authority: OpenedDomainNamespaceAuthorityV2 = input.change?.({
        sourceRoomId: descriptor.authority.roomId,
        serverId: descriptor.authority.serverId,
        namespaceId: descriptor.authority.namespaceId,
        keyClass: "ai",
        namespaceAccessRevision: descriptor.authority.namespaceAccessRevision,
        namespaceKeyGeneration: descriptor.authority.namespaceKeyGeneration,
        namespaceHeadDigest: descriptor.authority.namespaceHeadDigest.slice(),
        domainId: descriptor.authority.domainId,
        domainKeyGeneration: descriptor.authority.domainKeyGeneration,
        domainAuthorizationRevision:
          descriptor.authority.domainAuthorizationRevision,
        domainHeadDigest: descriptor.authority.domainHeadDigest.slice(),
        bundleRevision: descriptor.authority.bundleRevision,
        bundleDigest: descriptor.authority.bundleDigest.slice(),
      }) ?? {
        sourceRoomId: descriptor.authority.roomId,
        serverId: descriptor.authority.serverId,
        namespaceId: descriptor.authority.namespaceId,
        keyClass: "ai",
        namespaceAccessRevision: descriptor.authority.namespaceAccessRevision,
        namespaceKeyGeneration: descriptor.authority.namespaceKeyGeneration,
        namespaceHeadDigest: descriptor.authority.namespaceHeadDigest.slice(),
        domainId: descriptor.authority.domainId,
        domainKeyGeneration: descriptor.authority.domainKeyGeneration,
        domainAuthorizationRevision:
          descriptor.authority.domainAuthorizationRevision,
        domainHeadDigest: descriptor.authority.domainHeadDigest.slice(),
        bundleRevision: descriptor.authority.bundleRevision,
        bundleDigest: descriptor.authority.bundleDigest.slice(),
      };
      const entry: OpenedDomainNamespaceGenerationV2 = {
        namespaceId: descriptor.authority.namespaceId,
        keyClass: "ai",
        accessRevision: descriptor.authority.namespaceAccessRevision,
        generation: descriptor.authority.namespaceKeyGeneration,
        headDigest: entryHead,
        generationKey,
      };
      const entries: readonly OpenedDomainNamespaceGenerationV2[] = [
        input.changeEntry?.(entry) ?? entry,
      ];
      input.fixture.events.push("namespace-enter");
      try {
        return { status: "opened", value: await use(entries, authority) };
      } finally {
        generationKey.fill(0);
        entryHead.fill(0);
        authority.namespaceHeadDigest.fill(0);
        authority.domainHeadDigest.fill(0);
        authority.bundleDigest.fill(0);
        input.fixture.events.push("namespace-exit");
      }
    },
  };
}

function domainClient(input: Readonly<{
  fixture: Fixture;
  outcome?: AuthorityOutcome;
  change?: (
    authority: OpenedDomainKeyAuthorityV2,
  ) => OpenedDomainKeyAuthorityV2;
  onBorrowed?: (key: Uint8Array) => void;
}>): DomainKeyAuthorityClientV2 {
  return {
    ensure: async () => ({ status: "ready" }),
    servicePending: async () => ({ status: "ready", fulfilled: 0 }),
    withDomainKey: async <Value>(_request: Parameters<
      DomainKeyAuthorityClientV2["withDomainKey"]
    >[0], use: (
      domainKey: Uint8Array,
      authority: OpenedDomainKeyAuthorityV2,
    ) => Value | Promise<Value>) => {
      const outcome = input.outcome ?? "opened";
      if (outcome !== "opened") return { status: outcome, reason: "fixture" };
      expect(input.fixture.events.at(-1)).toBe("namespace-exit");
      const descriptor = input.fixture.descriptor;
      const key = input.fixture.domainKey.slice();
      const authority = input.change?.({
        serverId: descriptor.authority.serverId,
        domainId: descriptor.authority.domainId,
        participantDigest: new Uint8Array(32).fill(90),
        participantCount: 1,
        keyClass: "ai",
        domainKeyGeneration: descriptor.authority.domainKeyGeneration,
        authorizationRevision:
          descriptor.authority.domainAuthorizationRevision,
        headDigest: descriptor.authority.domainHeadDigest.slice(),
        recipientDeviceSigningGeneration: 11,
      }) ?? {
        serverId: descriptor.authority.serverId,
        domainId: descriptor.authority.domainId,
        participantDigest: new Uint8Array(32).fill(90),
        participantCount: 1,
        keyClass: "ai" as const,
        domainKeyGeneration: descriptor.authority.domainKeyGeneration,
        authorizationRevision:
          descriptor.authority.domainAuthorizationRevision,
        headDigest: descriptor.authority.domainHeadDigest.slice(),
        recipientDeviceSigningGeneration: 11,
      };
      input.onBorrowed?.(key);
      input.fixture.events.push("domain-enter");
      try {
        return { status: "opened", value: await use(key, authority) };
      } finally {
        key.fill(0);
        authority.participantDigest.fill(0);
        authority.headDigest.fill(0);
        input.fixture.events.push("domain-exit");
      }
    },
    serviceBacklog: async () => ({
      status: "ready",
      coordinates: 0,
      fulfilled: 0,
    }),
  };
}

function signingAuthority(input: Readonly<{
  fixture: Readonly<{
    device: Fixture["device"];
    issuer: BackgroundAuthorizationIssuerV2;
    events: string[];
    descriptor: Readonly<{ policyRevision: number }>;
  }>;
  policyRevision?: number;
  unavailable?: boolean;
  onBorrowed?: (key: Uint8Array) => void;
  beforeUse?: () => void;
}>): WithCurrentBackgroundAuthorizationSigningAuthorityV2 {
  return async <Value>(use: (
    authority: CurrentBackgroundAuthorizationSigningAuthorityV2,
  ) => Value | Promise<Value>): Promise<Value | null> => {
    if (input.unavailable === true) return null;
    input.beforeUse?.();
    const key = input.fixture.device.privateKey.slice();
    input.onBorrowed?.(key);
    input.fixture.events.push("signing-enter");
    try {
      return await use({
        issuer: input.fixture.issuer,
        signingPrivateKey: key,
        policyRevision: input.policyRevision
          ?? input.fixture.descriptor.policyRevision,
      });
    } finally {
      key.fill(0);
      input.fixture.events.push("signing-exit");
    }
  };
}

function operationInput(input: Readonly<{
  fixture: Fixture;
  namespaceAuthority?: DomainNamespaceAuthorityClientV2;
  domainAuthority?: DomainKeyAuthorityClientV2;
  withCurrentSigningAuthority?:
    WithCurrentBackgroundAuthorizationSigningAuthorityV2;
  now?: () => number;
  signal?: AbortSignal;
  serverId?: string;
}>): DeviceAuthorizationResponderV2Input {
  return {
    descriptorBytes: input.fixture.descriptorBytes,
    namespaceAuthority: input.namespaceAuthority ?? namespaceClient({
      fixture: input.fixture,
    }),
    domainAuthority: input.domainAuthority ?? domainClient({
      fixture: input.fixture,
    }),
    crypto: input.fixture.crypto,
    serverId: input.serverId ?? SERVER_SCOPE,
    now: input.now ?? (() => NOW),
    createId: () => "credential-317",
    withCurrentSigningAuthority: input.withCurrentSigningAuthority
      ?? signingAuthority({ fixture: input.fixture }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

describe("portable current V2 device authorization responder", () => {
  test("binds exact signed coordinates and releases Namespace custody before opening Domain custody", async () => {
    const f = await fixture();
    let borrowedDomain: Uint8Array | undefined;
    let borrowedSigning: Uint8Array | undefined;
    let requested: Readonly<{
      sourceRoomId: string;
      namespaceId: string;
      keyClass: string;
      expectedAccessRevision: number | undefined;
      expectedCurrentGeneration: number | undefined;
      expectedCurrentHeadDigest: Uint8Array | undefined;
    }> | undefined;
    const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: f,
      namespaceAuthority: namespaceClient({
        fixture: f,
        onRequest: (value) => {
          requested = {
            sourceRoomId: value.sourceRoomId,
            namespaceId: value.namespaceId,
            keyClass: value.keyClass,
            expectedAccessRevision: value.expectedAccessRevision,
            expectedCurrentGeneration: value.expectedCurrentGeneration,
            expectedCurrentHeadDigest: value.expectedCurrentHeadDigest?.slice(),
          };
        },
      }),
      domainAuthority: domainClient({
        fixture: f,
        onBorrowed: (value) => { borrowedDomain = value; },
      }),
      withCurrentSigningAuthority: signingAuthority({
        fixture: f,
        onBorrowed: (value) => { borrowedSigning = value; },
      }),
    }));

    expect(requested).toMatchObject({
      sourceRoomId: f.descriptor.authority.roomId,
      namespaceId: f.descriptor.authority.namespaceId,
      keyClass: "ai",
      expectedAccessRevision: f.descriptor.authority.namespaceAccessRevision,
      expectedCurrentGeneration:
        f.descriptor.authority.namespaceKeyGeneration,
      expectedCurrentHeadDigest: f.descriptor.authority.namespaceHeadDigest,
    });
    expect(f.events).toEqual([
      "namespace-enter",
      "namespace-exit",
      "domain-enter",
      "signing-enter",
      "signing-exit",
      "domain-exit",
    ]);
    expect(allZero(borrowedDomain)).toBe(true);
    expect(allZero(borrowedSigning)).toBe(true);
    expect(f.domainKey.some((byte) => byte !== 0)).toBe(true);
    expect(f.device.privateKey.some((byte) => byte !== 0)).toBe(true);
    expect(result).toMatchObject({
      status: "ready",
      requestId: f.descriptor.requestId,
      recipientGeneration: f.descriptor.recipientGeneration,
      expiresAt: f.descriptor.expiresAt,
    });
    if (result.status !== "ready") throw new Error("Expected a response");
    const verified = await verifyBackgroundAuthorizationResponseV2(f.crypto, {
      responseBytes: result.responseBytes,
      now: NOW,
      resolveCurrentIssuer: (context) => {
        if (!("authority" in context.descriptor)) {
          throw new Error("Expected a Stenographer descriptor");
        }
        expect(context.descriptor.authority.serverId).toBe(SERVER_SCOPE);
        expect(context.issuer.serverInstanceId).toBe(SERVER_INSTANCE_ID);
        return f.device.publicKey;
      },
    });
    expect(verified.descriptor).toEqual(f.descriptor);
    expect(verified.issuer).toEqual(f.issuer);
    result.responseBytes.fill(0);
  });

  test("checks both Reflection Namespaces while borrowing one shared Domain", async () => {
    const f = await reflectionFixture(true);
    const result = await respondToCurrentDeviceAuthorizationV2(
      reflectionOperationInput({ fixture: f }),
    );

    expect(result.status).toBe("ready");
    expect(f.namespaceCalls).toEqual([
      "room-a:namespace-a",
      "room-b:namespace-b",
      "room-a:namespace-a",
      "room-b:namespace-b",
    ]);
    expect(f.domainCalls).toEqual(["domain-a"]);
    expect(f.borrowedDomainKeys).toHaveLength(1);
    expect(f.borrowedDomainKeys.every(allZero)).toBe(true);
    expect(f.keys.get("domain-a")?.some((byte) => byte !== 0)).toBe(true);
    expect(f.events).toEqual(["signing-enter", "signing-exit"]);
    if (result.status !== "ready") throw new Error("Expected a response");
    const verified = await verifyBackgroundAuthorizationResponseV2(f.crypto, {
      responseBytes: result.responseBytes,
      now: NOW,
      resolveCurrentIssuer: () => f.device.publicKey,
    });
    expect(verified.descriptor).toEqual(f.descriptor);
    result.responseBytes.fill(0);
  });

  test("collects each distinct Reflection Domain after releasing Namespace custody", async () => {
    const f = await reflectionFixture(false);
    const result = await respondToCurrentDeviceAuthorizationV2(
      reflectionOperationInput({ fixture: f }),
    );

    expect(result.status).toBe("ready");
    expect(f.domainCalls).toEqual(["domain-a", "domain-b"]);
    expect(f.borrowedDomainKeys).toHaveLength(2);
    expect(f.borrowedDomainKeys.every(allZero)).toBe(true);
    expect(f.namespaceLeaseOpen).toBe(false);
    if (result.status === "ready") result.responseBytes.fill(0);
  });

  test("returns no Reflection response when any Namespace or Domain is missing", async () => {
    {
      const f = await reflectionFixture(true);
      const result = await respondToCurrentDeviceAuthorizationV2(
        reflectionOperationInput({
          fixture: f,
          namespaceAuthority: reflectionNamespaceClient({
            fixture: f,
            failNamespaceId: "namespace-b",
          }),
        }),
      );
      expect(result).toEqual({
        status: "pending",
        reason: "namespace_authority_pending",
      });
      expect(f.domainCalls).toEqual([]);
      expect(f.events).toEqual([]);
    }
    {
      const f = await reflectionFixture(false);
      const result = await respondToCurrentDeviceAuthorizationV2(
        reflectionOperationInput({
          fixture: f,
          domainAuthority: reflectionDomainClient({
            fixture: f,
            failDomainId: "domain-b",
          }),
        }),
      );
      expect(result).toEqual({
        status: "pending",
        reason: "domain_authority_pending",
      });
      expect(f.domainCalls).toEqual(["domain-a", "domain-b"]);
      expect(f.borrowedDomainKeys).toHaveLength(1);
      expect(f.borrowedDomainKeys.every(allZero)).toBe(true);
      expect(f.events).toEqual([]);
    }
  });

  test("wipes borrowed Reflection keys when response creation fails", async () => {
    const f = await reflectionFixture(false);
    let borrowedSigning: Uint8Array | undefined;
    const wrongDevice = f.crypto.generateSigningKeyPair();
    const result = await respondToCurrentDeviceAuthorizationV2(
      reflectionOperationInput({
        fixture: f,
        withCurrentSigningAuthority: async (use) => {
          borrowedSigning = wrongDevice.privateKey.slice();
          try {
            return await use({
              issuer: f.issuer,
              signingPrivateKey: borrowedSigning,
              policyRevision: f.descriptor.policyRevision,
            });
          } finally {
            borrowedSigning.fill(0);
          }
        },
      }),
    );

    expect(result).toEqual({
      status: "unavailable",
      reason: "response_creation_failed",
    });
    expect(f.borrowedDomainKeys).toHaveLength(2);
    expect(f.borrowedDomainKeys.every(allZero)).toBe(true);
    expect(allZero(borrowedSigning)).toBe(true);
    expect([...f.keys.values()].every((key) =>
      key.some((byte) => byte !== 0))).toBe(true);
  });

  test("cancels Reflection between Domain leases and releases transient custody", async () => {
    const f = await reflectionFixture(false);
    const controller = new AbortController();
    expect(respondToCurrentDeviceAuthorizationV2(
      reflectionOperationInput({
        fixture: f,
        signal: controller.signal,
        domainAuthority: reflectionDomainClient({
          fixture: f,
          afterDomain: (domainId) => {
            if (domainId === "domain-a") controller.abort();
          },
        }),
      }),
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(f.domainCalls).toEqual(["domain-a"]);
    expect(f.borrowedDomainKeys).toHaveLength(1);
    expect(f.borrowedDomainKeys.every(allZero)).toBe(true);
    expect(f.events).toEqual([]);
  });

  test("rejects Reflection when Namespace authority changes after Domain collection", async () => {
    const f = await reflectionFixture(true);
    const result = await respondToCurrentDeviceAuthorizationV2(
      reflectionOperationInput({
        fixture: f,
        namespaceAuthority: reflectionNamespaceClient({
          fixture: f,
          staleOnRevalidationNamespaceId: "namespace-b",
        }),
      }),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "namespace_authority_changed",
    });
    expect(f.namespaceCalls).toEqual([
      "room-a:namespace-a",
      "room-b:namespace-b",
      "room-a:namespace-a",
      "room-b:namespace-b",
    ]);
    expect(f.domainCalls).toEqual(["domain-a"]);
    expect(f.borrowedDomainKeys.every(allZero)).toBe(true);
    expect(f.events).toEqual([]);
  });

  test("returns typed pending and unavailable results without entering later custody", async () => {
    for (const [outcome, expected] of [
      ["pending", { status: "pending", reason: "namespace_authority_pending" }],
      ["unavailable", {
        status: "unavailable",
        reason: "namespace_authority_unavailable",
      }],
    ] as const) {
      const f = await fixture();
      const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        namespaceAuthority: namespaceClient({ fixture: f, outcome }),
      }));
      expect(result).toEqual(expected);
      expect(f.events).toEqual([]);
    }
    for (const [outcome, expected] of [
      ["pending", { status: "pending", reason: "domain_authority_pending" }],
      ["unavailable", {
        status: "unavailable",
        reason: "domain_authority_unavailable",
      }],
    ] as const) {
      const f = await fixture();
      const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        domainAuthority: domainClient({ fixture: f, outcome }),
      }));
      expect(result).toEqual(expected);
      expect(f.events).toEqual(["namespace-enter", "namespace-exit"]);
    }
  });

  test("rejects changed Namespace, Domain, policy, and admitted-device authority", async () => {
    const namespaceMutations: readonly ((
      authority: OpenedDomainNamespaceAuthorityV2,
    ) => OpenedDomainNamespaceAuthorityV2)[] = [
      (value) => ({ ...value, sourceRoomId: "room-other" }),
      (value) => ({ ...value, serverId: "https://other.example" }),
      (value) => ({ ...value, namespaceId: "namespace-other" }),
      (value) => ({ ...value, keyClass: "human" }),
      (value) => ({
        ...value,
        namespaceAccessRevision: value.namespaceAccessRevision + 1,
      }),
      (value) => ({
        ...value,
        namespaceKeyGeneration: value.namespaceKeyGeneration + 1,
      }),
      (value) => ({
        ...value,
        namespaceHeadDigest: changedBytes(value.namespaceHeadDigest),
      }),
      (value) => ({ ...value, domainId: "domain-other" }),
      (value) => ({
        ...value,
        domainKeyGeneration: value.domainKeyGeneration + 1,
      }),
      (value) => ({
        ...value,
        domainAuthorizationRevision: value.domainAuthorizationRevision + 1,
      }),
      (value) => ({
        ...value,
        domainHeadDigest: changedBytes(value.domainHeadDigest),
      }),
      (value) => ({ ...value, bundleRevision: value.bundleRevision + 1 }),
      (value) => ({
        ...value,
        bundleDigest: changedBytes(value.bundleDigest),
      }),
    ];
    for (const change of namespaceMutations) {
      const f = await fixture();
      const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        namespaceAuthority: namespaceClient({ fixture: f, change }),
      }));
      expect(result).toEqual({
        status: "stale",
        reason: "namespace_authority_changed",
      });
      expect(f.events).toEqual(["namespace-enter", "namespace-exit"]);
    }
    {
      const f = await fixture();
      const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        namespaceAuthority: namespaceClient({
          fixture: f,
          changeEntry: (entry) => ({
            ...entry,
            headDigest: changedBytes(entry.headDigest),
          }),
        }),
      }));
      expect(result).toEqual({
        status: "stale",
        reason: "namespace_authority_changed",
      });
    }
    const domainMutations: readonly ((
      authority: OpenedDomainKeyAuthorityV2,
    ) => OpenedDomainKeyAuthorityV2)[] = [
      (value) => ({ ...value, serverId: "https://other.example" }),
      (value) => ({ ...value, domainId: "domain-other" }),
      (value) => ({ ...value, keyClass: "human" }),
      (value) => ({
        ...value,
        domainKeyGeneration: value.domainKeyGeneration + 1,
      }),
      (value) => ({
        ...value,
        authorizationRevision: value.authorizationRevision + 1,
      }),
      (value) => ({
        ...value,
        headDigest: changedBytes(value.headDigest),
      }),
    ];
    for (const change of domainMutations) {
      const f = await fixture();
      const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        domainAuthority: domainClient({ fixture: f, change }),
      }));
      expect(result).toEqual({
        status: "stale",
        reason: "domain_authority_changed",
      });
      expect(f.events).not.toContain("signing-enter");
    }
    {
      const f = await fixture();
      const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        withCurrentSigningAuthority: signingAuthority({
          fixture: f,
          policyRevision: f.descriptor.policyRevision + 1,
        }),
      }));
      expect(result).toEqual({ status: "stale", reason: "policy_changed" });
    }
    {
      const f = await fixture();
      const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        withCurrentSigningAuthority: signingAuthority({
          fixture: f,
          unavailable: true,
        }),
      }));
      expect(result).toEqual({
        status: "unavailable",
        reason: "signing_authority_unavailable",
      });
      expect(f.events).not.toContain("signing-enter");
    }
  });

  test("rejects malformed, wrong-server, not-yet-valid, and expired descriptors before custody", async () => {
    const malformed = await fixture();
    malformed.descriptorBytes[0]! ^= 1;
    expect(await respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: malformed,
    }))).toEqual({ status: "unavailable", reason: "invalid_descriptor" });
    expect(malformed.events).toEqual([]);

    const wrongServer = await fixture();
    expect(await respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: wrongServer,
      serverId: "https://changed.example",
    }))).toEqual({ status: "stale", reason: "server_changed" });
    expect(wrongServer.events).toEqual([]);

    const early = await fixture();
    expect(await respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: early,
      now: () => early.descriptor.notBefore - 1,
    }))).toEqual({ status: "stale", reason: "not_yet_valid" });
    expect(early.events).toEqual([]);

    const expired = await fixture();
    expect(await respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: expired,
      now: () => expired.descriptor.expiresAt,
    }))).toEqual({ status: "stale", reason: "expired" });
    expect(expired.events).toEqual([]);
  });

  test("rechecks the deadline after asynchronous response creation", async () => {
    const f = await fixture();
    let now = NOW;
    const realSeal = f.crypto.sealTo.bind(f.crypto);
    f.crypto.sealTo = async (...args) => {
      const result = await realSeal(...args);
      now = f.descriptor.expiresAt;
      return result;
    };
    const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: f,
      now: () => now,
    }));
    expect(result).toEqual({ status: "stale", reason: "expired" });
  });

  test("keeps Buffer-backed request custody owned by the caller", async () => {
    const f = await fixture();
    const descriptorBytes = Buffer.from(f.descriptorBytes);
    const expected = Uint8Array.from(descriptorBytes);
    const result = await respondToCurrentDeviceAuthorizationV2({
      ...operationInput({ fixture: f }),
      descriptorBytes,
    });
    expect(Uint8Array.from(descriptorBytes)).toEqual(expected);
    expect(result.status).toBe("ready");
    if (result.status === "ready") result.responseBytes.fill(0);
  });

  test("honors cancellation before custody and after asynchronous response creation", async () => {
    {
      const f = await fixture();
      const controller = new AbortController();
      controller.abort();
      expect(respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        signal: controller.signal,
      }))).rejects.toMatchObject({ name: "AbortError" });
      expect(f.events).toEqual([]);
    }
    {
      const f = await fixture();
      const controller = new AbortController();
      const realSeal = f.crypto.sealTo.bind(f.crypto);
      f.crypto.sealTo = async (...args) => {
        const result = await realSeal(...args);
        controller.abort();
        return result;
      };
      expect(respondToCurrentDeviceAuthorizationV2(operationInput({
        fixture: f,
        signal: controller.signal,
      }))).rejects.toMatchObject({ name: "AbortError" });
      expect(f.events).toContain("signing-exit");
      expect(f.events).toContain("domain-exit");
    }
  });

  test("supports native-shaped signals without throwIfAborted", async () => {
    const f = await fixture();
    const state = { aborted: false };
    const signal = state as unknown as AbortSignal;
    const result = await respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: f,
      signal,
    }));
    expect(result.status).toBe("ready");
    if (result.status === "ready") result.responseBytes.fill(0);

    state.aborted = true;
    const cancelled = await fixture();
    expect(respondToCurrentDeviceAuthorizationV2(operationInput({
      fixture: cancelled,
      signal,
    }))).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.events).toEqual([]);
  });

  test("the public background client leaf remains browser-bundle safe", async () => {
    const directory = await mkdtemp(join(import.meta.dir, ".m317-browser-"));
    const output = join(directory, "background-client.js");
    try {
      const build = Bun.spawn({
        cmd: [
          process.execPath,
          "build",
          join(import.meta.dir,
            "../../src/device/background-authorization-client.ts"),
          `--outfile=${output}`,
          "--target=browser",
          "--format=esm",
          "--sourcemap=none",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
      const bundled = await readFile(output, "utf8");
      expect(bundled).not.toContain("node:");
      expect(bundled).not.toContain("@nautilo/db");
      expect(bundled).not.toContain("electron");
      expect(bundled).not.toContain(".throwIfAborted(");
      expect(bundled).not.toContain("atob(");
      expect(bundled).not.toContain("btoa(");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
