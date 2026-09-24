import { describe, expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  BackgroundNamespaceAuthorityV2,
  BackgroundReflectionWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";

import {
  matchesCurrentReflectionAuthority,
  withCurrentReflectionAuthority,
} from "../../src/server/journal/current-reflection-authority.ts";

const HUMAN = "11000000-0000-4000-8000-000000000001";
const USER = "11000000-0000-4000-8000-000000000002";
const DEVICE = "11000000-0000-4000-8000-000000000003";
const ROOM_A = "22000000-0000-4000-8000-000000000001";
const ROOM_B = "22000000-0000-4000-8000-000000000002";
const NAMESPACE_A = "33000000-0000-4000-8000-000000000001";
const NAMESPACE_B = "33000000-0000-4000-8000-000000000002";
const DOMAIN_A = "44000000-0000-4000-8000-000000000001";
const DOMAIN_B = "44000000-0000-4000-8000-000000000002";
const SERVER_SCOPE = "https://m327.example";
const SERVER_INSTANCE = "55000000-0000-4000-8000-000000000001";
const NOW = 1_000;

type MatchInput = Parameters<typeof matchesCurrentReflectionAuthority>[0];
type CurrentNamespace = MatchInput["namespaces"][number];

function digest(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function fixture(sharedDomain = false): MatchInput {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const authority = (
    roomId: string,
    namespaceId: string,
    suffix: number,
    domainId: string,
    domainSuffix: number,
  ): BackgroundNamespaceAuthorityV2 => ({
    serverId: SERVER_SCOPE,
    roomId,
    namespaceId,
    namespaceAccessRevision: 10 + suffix,
    namespaceKeyGeneration: 20 + suffix,
    namespaceHeadDigest: digest(30 + suffix),
    domainId,
    domainKeyGeneration: 40 + domainSuffix,
    domainAuthorizationRevision: 50 + domainSuffix,
    domainHeadDigest: digest(60 + domainSuffix),
    bundleRevision: 70 + suffix,
    bundleDigest: digest(80 + suffix),
  });
  const first = authority(ROOM_A, NAMESPACE_A, 1, DOMAIN_A, 1);
  const second = authority(
    ROOM_B,
    NAMESPACE_B,
    2,
    sharedDomain ? DOMAIN_A : DOMAIN_B,
    sharedDomain ? 1 : 2,
  );
  const descriptor: BackgroundReflectionWorkDescriptorV2 = {
    formatVersion: 2,
    requestId: "request-327",
    recipientGeneration: 2,
    workKind: "reflection.authority_reproject",
    workId: "work-327",
    anchorNamespaceId: NAMESPACE_A,
    anchorDomainId: DOMAIN_A,
    subject: {
      kind: "processor",
      processorKind: "reflection",
      processorVersion: 1,
    },
    operations: ["decrypt", "encrypt"],
    purpose: "record.reproject",
    source: {
      kind: "reflection_authority",
      recordRef: "record-source-327",
      sourceChangeGeneration: 1,
      projectionGeneration: 2,
      expectedRepresentationGeneration: 3,
      targetRepresentationGeneration: 4,
      fingerprint: digest(90),
    },
    namespaceRequirements: [
      { authority: first, operations: ["decrypt", "encrypt"] },
      { authority: second, operations: ["decrypt", "encrypt"] },
    ],
    policyRevision: 91,
    inputBindings: [
      { objectId: "record-current-327", namespaceId: NAMESPACE_A },
      { objectId: "record-source-327", namespaceId: NAMESPACE_B },
    ],
    outputSlots: [{
      objectId: "record-output-327",
      objectType: "nautilo.reflection.record.v1",
      createdAt: 900,
      namespaceIds: [NAMESPACE_A, NAMESPACE_B],
    }],
    maximumPlaintextBytes: 1_024,
    maximumCiphertextBytes: 4_096,
    recipientKeyId: "recipient-327",
    recipientPublicKey: new Uint8Array(65).fill(1),
    issuedAt: 900,
    notBefore: 900,
    expiresAt: 1_900,
    idempotencyId: "attempt-327",
  };
  const namespaces: CurrentNamespace[] = descriptor.namespaceRequirements.map(
    ({ authority: value }) => ({
      status: "ready",
      namespaceId: value.namespaceId,
      namespaceAccessRevision: value.namespaceAccessRevision,
      namespaceKeyGeneration: value.namespaceKeyGeneration,
      namespaceHeadDigest: value.namespaceHeadDigest.slice(),
      namespacePublicationDigest: digest(101),
      namespacePublicationSetDigest: digest(102),
      namespaceAudienceFingerprint: digest(103),
      domainId: value.domainId,
      domainKeyGeneration: value.domainKeyGeneration,
      domainAuthorizationRevision: value.domainAuthorizationRevision,
      domainHeadDigest: value.domainHeadDigest.slice(),
      bundleRevision: value.bundleRevision,
      bundleDigest: value.bundleDigest.slice(),
    }),
  );
  const device = {
    userId: USER,
    humanActorId: HUMAN,
    deviceId: DEVICE,
    deviceGeneration: 5,
    signingPublicKey: signing.publicKey,
    serverInstanceId: SERVER_INSTANCE,
    lineageGeneration: 6,
    epoch: 7,
    securityRevision: 8,
    headDigest: digest(104),
  };
  signing.privateKey.fill(0);
  return {
    crypto,
    serverScope: SERVER_SCOPE,
    descriptor,
    issuer: {
      humanId: HUMAN,
      deviceId: DEVICE,
      deviceGeneration: device.deviceGeneration,
      serverInstanceId: SERVER_INSTANCE,
      lineageGeneration: device.lineageGeneration,
      epoch: device.epoch,
      securityRevision: device.securityRevision,
      headDigest: device.headDigest.slice(),
      signingPublicKeyHash: crypto.hash(device.signingPublicKey),
    },
    device,
    namespaces,
    policyRevision: descriptor.policyRevision,
    now: NOW,
    admission: {
      ...device,
      expiresAt: 1_800,
    },
  };
}

function withNamespace(
  input: MatchInput,
  index: number,
  change: Partial<CurrentNamespace>,
): MatchInput {
  return {
    ...input,
    namespaces: input.namespaces.map((entry, current) =>
      current === index ? { ...entry, ...change } : entry),
  };
}

function withDescriptorAuthority(
  input: MatchInput,
  index: number,
  change: Partial<BackgroundNamespaceAuthorityV2>,
): MatchInput {
  return {
    ...input,
    descriptor: {
      ...input.descriptor,
      namespaceRequirements: input.descriptor.namespaceRequirements.map(
        (entry, current) => current === index
          ? { ...entry, authority: { ...entry.authority, ...change } }
          : entry,
      ),
    },
  };
}

function productHarness(input: MatchInput) {
  const queries: string[] = [];
  const events: string[] = [];
  const rows = input.descriptor.namespaceRequirements.map(({ authority }) => ({
    room_id: authority.roomId,
    namespace_id: authority.namespaceId,
    kind: "access",
    parent_room_id: null,
    archived_at: null,
    namespace_access_revision: authority.namespaceAccessRevision,
    human_actor_ids: [HUMAN], effective_human_actor_ids: [HUMAN],
  }));
  const members = input.descriptor.namespaceRequirements.map(({ authority }) => ({
    room_id: authority.roomId,
    actor_id: HUMAN,
    kind: "user",
  }));
  const product: PostgresJsBridgeConnection = {
    async query<Row extends PostgresJsBridgeRow>(statement: string) {
      queries.push(statement);
      if (statement.includes('from "room_members"')) {
        return members as unknown as readonly Row[];
      }
      if (statement.includes('from "rooms"')) {
        return rows as unknown as readonly Row[];
      }
      if (statement.includes('from "actors"')) {
        return [{ owner_id: USER }] as unknown as readonly Row[];
      }
      throw new Error(`Unexpected product query ${statement}`);
    },
    transaction: (use) => use(product),
    transactionOnce: (use) => use(product),
  };
  let selection = 0;
  const selected = () => {
    const result = selection++ === 0
      ? [{ mode: "shadow_encryption", revision: input.policyRevision }]
      : [{ userId: USER }];
    const query: Record<string, unknown> = {};
    for (const method of ["from", "where"]) query[method] = () => query;
    query["then"] = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return query;
  };
  const tx = { execute: async () => [], select: selected };
  const runner = {
    transaction: async (use: (
      transaction: unknown,
      executor: PostgresJsBridgeConnection,
    ) => Promise<unknown>) => use(tx, product),
  };
  let restrictedEntries = 0;
  const restricted: PostgresJsBridgeConnection = {
    async query() {
      events.push("restricted-query");
      throw new Error("Restricted authority query reached");
    },
    transaction: (use) => use(restricted),
    transactionOnce: async (use) => {
      restrictedEntries += 1;
      events.push("restricted-enter");
      return use(restricted);
    },
  };
  return { events, product, queries, restricted, restrictedEntries: () =>
    restrictedEntries, runner };
}

describe("current Reflection authority", () => {
  test("matches every Namespace for shared and distinct Domain sets", () => {
    for (const sharedDomain of [true, false]) {
      const input = fixture(sharedDomain);
      expect(matchesCurrentReflectionAuthority(input)).toBe(true);
      const changes: readonly Partial<CurrentNamespace>[] = [
        { namespaceId: "other" },
        { namespaceAccessRevision: input.namespaces[1]!.namespaceAccessRevision + 1 },
        { namespaceKeyGeneration: input.namespaces[1]!.namespaceKeyGeneration + 1 },
        { namespaceHeadDigest: digest(201) },
        { domainId: "other" },
        { domainKeyGeneration: input.namespaces[1]!.domainKeyGeneration + 1 },
        { domainAuthorizationRevision:
          input.namespaces[1]!.domainAuthorizationRevision + 1 },
        { domainHeadDigest: digest(202) },
        { bundleRevision: input.namespaces[1]!.bundleRevision + 1 },
        { bundleDigest: digest(203) },
      ];
      for (const change of changes) {
        expect(matchesCurrentReflectionAuthority(
          withNamespace(input, 1, change),
        )).toBe(false);
      }
    }
  });

  test("rejects partial, duplicate, and stale Namespace inventories", () => {
    const input = fixture();
    expect(matchesCurrentReflectionAuthority({
      ...input,
      namespaces: [input.namespaces[0]!],
    })).toBe(false);
    expect(matchesCurrentReflectionAuthority({
      ...input,
      namespaces: [input.namespaces[0]!, input.namespaces[0]!],
    })).toBe(false);
    expect(matchesCurrentReflectionAuthority(withDescriptorAuthority(
      input,
      1,
      { bundleDigest: digest(204) },
    ))).toBe(false);
    expect(matchesCurrentReflectionAuthority(withDescriptorAuthority(
      input,
      1,
      { serverId: "https://other.example" },
    ))).toBe(false);
    expect(matchesCurrentReflectionAuthority(withDescriptorAuthority(
      input,
      1,
      { bundleRevision: input.namespaces[1]!.bundleRevision + 1 },
    ))).toBe(false);
  });

  test("rejects stale issuer, device, policy, window, and admission coordinates", () => {
    const input = fixture();
    for (const [key, value] of Object.entries({
      humanActorId: "other-human",
      deviceId: "other-device",
      deviceGeneration: 6,
      serverInstanceId: "other-installation",
      lineageGeneration: 7,
      epoch: 8,
      securityRevision: 9,
      headDigest: digest(205),
      signingPublicKey: new Uint8Array(32),
    })) {
      expect(matchesCurrentReflectionAuthority({
        ...input,
        device: { ...input.device, [key]: value },
      })).toBe(false);
    }
    for (const [key, value] of Object.entries({
      humanId: "other-human",
      deviceId: "other-device",
      deviceGeneration: 6,
      serverInstanceId: "other-installation",
      lineageGeneration: 7,
      epoch: 8,
      securityRevision: 9,
      headDigest: digest(206),
      signingPublicKeyHash: digest(207),
    })) {
      expect(matchesCurrentReflectionAuthority({
        ...input,
        issuer: { ...input.issuer, [key]: value },
      })).toBe(false);
    }
    expect(matchesCurrentReflectionAuthority({
      ...input,
      policyRevision: input.policyRevision + 1,
    })).toBe(false);
    expect(matchesCurrentReflectionAuthority({
      ...input,
      now: input.descriptor.notBefore - 1,
    })).toBe(false);
    expect(matchesCurrentReflectionAuthority({
      ...input,
      now: input.descriptor.expiresAt,
    })).toBe(false);
    expect(matchesCurrentReflectionAuthority({
      ...input,
      admission: { ...input.admission!, expiresAt: NOW },
    })).toBe(false);
    expect(matchesCurrentReflectionAuthority({
      ...input,
      admission: { ...input.admission!, securityRevision: 99 },
    })).toBe(false);
  });

  test("is a pure coordinate check whose only crypto operation is hashing", () => {
    const input = fixture();
    let hashes = 0;
    const crypto = new Proxy(input.crypto, {
      get(target, property) {
        if (property === "hash") {
          return (value: Uint8Array) => {
            hashes += 1;
            return target.hash(value);
          };
        }
        throw new Error(`Unexpected crypto operation ${String(property)}`);
      },
    });
    expect(matchesCurrentReflectionAuthority({ ...input, crypto })).toBe(true);
    expect(hashes).toBe(1);
  });

  test("validates product state before entering restricted key custody", async () => {
    for (const allowed of [false, true]) {
      const source = fixture();
      const harness = productHarness(source);
      const restrictedError = new Error("restricted entry reached");
      if (allowed) {
        harness.restricted.transactionOnce = async () => {
          harness.events.push("restricted-enter");
          throw restrictedError;
        };
      }
      const call = withCurrentReflectionAuthority({
        runner: harness.runner,
        restricted: harness.restricted,
        crypto: source.crypto,
        serverScope: source.serverScope,
        descriptor: source.descriptor,
        issuer: source.issuer,
        admission: source.admission,
        now: () => NOW,
        validateProduct: async (product: PostgresJsBridgeConnection) => {
          expect(product).not.toBe(harness.restricted);
          expect(harness.queries).toHaveLength(0);
          harness.events.push("validate-product");
          return allowed;
        },
        use: async () => {
          throw new Error("Use must not run in ordering test");
        },
      } as unknown as Parameters<typeof withCurrentReflectionAuthority>[0]);
      if (allowed) expect(await call.catch((error: unknown) => error))
        .toBe(restrictedError);
      else expect(await call).toBeNull();
      expect(harness.events[0]).toBe("validate-product");
      expect(harness.events.includes("restricted-enter")).toBe(allowed);
      expect(harness.events).not.toContain("restricted-query");
      expect(harness.queries).toHaveLength(allowed ? 3 : 0);
    }
  });

  test("honors cancellation before queries and after product validation", async () => {
    {
      const source = fixture();
      const harness = productHarness(source);
      const controller = new AbortController();
      controller.abort();
      expect(withCurrentReflectionAuthority({
        runner: harness.runner,
        restricted: harness.restricted,
        crypto: source.crypto,
        serverScope: source.serverScope,
        descriptor: source.descriptor,
        issuer: source.issuer,
        now: () => NOW,
        signal: controller.signal,
        validateProduct: async () => true,
        use: async () => "used",
      } as unknown as Parameters<typeof withCurrentReflectionAuthority>[0]))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(harness.queries).toEqual([]);
      expect(harness.restrictedEntries()).toBe(0);
    }
    {
      const source = fixture();
      const harness = productHarness(source);
      const controller = new AbortController();
      expect(withCurrentReflectionAuthority({
        runner: harness.runner,
        restricted: harness.restricted,
        crypto: source.crypto,
        serverScope: source.serverScope,
        descriptor: source.descriptor,
        issuer: source.issuer,
        now: () => NOW,
        signal: controller.signal,
        validateProduct: async () => {
          controller.abort();
          return true;
        },
        use: async () => "used",
      } as unknown as Parameters<typeof withCurrentReflectionAuthority>[0]))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(harness.restrictedEntries()).toBe(0);
      expect(harness.events).not.toContain("restricted-query");
    }
  });
});
