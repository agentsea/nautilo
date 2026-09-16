import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {matchesCurrentStenographerAuthority, withCurrentStenographerAuthority} from "../../src/server/journal/current-stenographer-authority.ts";

function fixture(): Parameters<typeof matchesCurrentStenographerAuthority>[0] {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const digest = (byte: number) => new Uint8Array(32).fill(byte);
  const serverScope = "https://nautilo.example";
  const device = {userId: "user-1", humanActorId: "human-1", deviceId: "device-1",
    deviceGeneration: 2, signingPublicKey: signing.publicKey,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1", lineageGeneration: 3,
    epoch: 4, securityRevision: 5, headDigest: digest(1)};
  signing.privateKey.fill(0);
  const namespace = {status: "ready" as const, namespaceId: "namespace-1",
    namespaceAccessRevision: 6, namespaceKeyGeneration: 7,
    namespaceHeadDigest: digest(2), namespacePublicationDigest: digest(2),
    namespacePublicationSetDigest: digest(2), namespaceAudienceFingerprint: digest(2),
    domainId: "domain-1", domainKeyGeneration: 8, domainAuthorizationRevision: 9,
    domainHeadDigest: digest(3), bundleRevision: 10, bundleDigest: digest(4)};
  return {crypto, serverScope, now: 1_000, policyRevision: 11, device, namespace,
    issuer: {humanId: device.humanActorId, deviceId: device.deviceId,
      deviceGeneration: device.deviceGeneration, serverInstanceId: device.serverInstanceId,
      lineageGeneration: device.lineageGeneration, epoch: device.epoch,
      securityRevision: device.securityRevision, headDigest: device.headDigest,
      signingPublicKeyHash: crypto.hash(device.signingPublicKey)},
    admission: {...device, expiresAt: 2_000},
    descriptor: {formatVersion: 2, requestId: "request-1", recipientGeneration: 0,
      workKind: "stenographer.extraction", workId: "work-1",
      anchorNamespaceId: namespace.namespaceId, anchorDomainId: namespace.domainId,
      subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
      operations: ["decrypt", "encrypt"], purpose: "journal.extract",
      authority: {serverId: serverScope, roomId: "room-1", namespaceId: namespace.namespaceId,
        namespaceAccessRevision: namespace.namespaceAccessRevision,
        namespaceKeyGeneration: namespace.namespaceKeyGeneration, namespaceHeadDigest: namespace.namespaceHeadDigest,
        domainId: namespace.domainId, domainKeyGeneration: namespace.domainKeyGeneration,
        domainAuthorizationRevision: namespace.domainAuthorizationRevision,
        domainHeadDigest: namespace.domainHeadDigest, bundleRevision: namespace.bundleRevision,
        bundleDigest: namespace.bundleDigest},
      policyRevision: 11, source: {kind: "stenographer_work", startSequence: 1, endSequence: 2, rebuildGeneration: 0, fingerprint: digest(5)},
      inputBindings: [{objectId: "message-1", namespaceId: namespace.namespaceId}],
      outputSlots: [{objectId: "record-1", objectType: "nautilo.reflection.record.v1", createdAt: 900,
        namespaceIds: [namespace.namespaceId]}],
      maximumPlaintextBytes: 1_024, maximumCiphertextBytes: 4_096,
      recipientKeyId: "recipient-1", recipientPublicKey: new Uint8Array(65).fill(1),
      issuedAt: 900, notBefore: 900, expiresAt: 1_900, idempotencyId: "attempt-1"},
  };
}

describe("current Stenographer authority", () => {
  test("locks publication receipts before Rooms while retaining Room-first repair validation", async () => {
    const source = fixture();
    const humanId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    const roomId = "33333333-3333-4333-8333-333333333333";
    const namespaceId = "44444444-4444-4444-8444-444444444444";
    const descriptor = {...source.descriptor, anchorNamespaceId: namespaceId,
      authority: {...source.descriptor.authority, roomId, namespaceId},
      inputBindings: source.descriptor.inputBindings.map((binding) => ({...binding, namespaceId})),
      outputSlots: source.descriptor.outputSlots.map((slot) => ({...slot, namespaceIds: [namespaceId]}))};
    const issuer = {...source.issuer, humanId};
    const events: string[] = [];
    let selectCount = 0;
    let restrictedCalls = 0;
    const selected = () => {
      const rows = selectCount++ === 0
        ? [{mode: "shadow_encryption", shadowBehavior: "fallback", revision: source.policyRevision}]
        : [{userId}];
      const query: Record<string, unknown> = {};
      for (const method of ["from", "where"]) query[method] = () => query;
      query["then"] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return query;
    };
    const roomQuery = new Error("namespace Room query reached");
    const tx = {execute: async () => [], select: selected};
    const executor = {query: async (statement: string) => {
      events.push(statement);
      throw roomQuery;
    }};
    const runner = {transaction: async (use: (transaction: unknown, product: unknown) => Promise<unknown>) =>
      use(tx, executor)};
    const restricted = {query: async () => [], transaction: async () => {restrictedCalls += 1; throw new Error("restricted authority reached");},
      transactionOnce: async () => {restrictedCalls += 1; throw new Error("restricted authority reached");}};
    const common = {runner, restricted, crypto: source.crypto, serverScope: source.serverScope,
      descriptor, issuer, now: () => source.now, use: async () => "used"};
    const invoke = (validation: Readonly<{
      validatePublication?: () => Promise<boolean>;
      validateProduct?: () => Promise<boolean>;
    }>) => withCurrentStenographerAuthority({...common, ...validation} as unknown as
      Parameters<typeof withCurrentStenographerAuthority>[0]);

    const publicationError = await invoke({validatePublication: async () => {events.push("validate publication"); return true;}})
      .catch((error: unknown) => error);
    expect(publicationError).toBe(roomQuery);
    expect(events[0]).toBe("validate publication");
    expect(events[1]).toContain('from "rooms"');
    expect(restrictedCalls).toBe(0);

    events.length = 0;
    selectCount = 0;
    expect(await invoke({validatePublication: async () => {events.push("validate publication"); return false;}})).toBeNull();
    expect(events).toEqual(["validate publication"]);
    expect(restrictedCalls).toBe(0);

    events.length = 0;
    selectCount = 0;
    const productError = await invoke({validateProduct: async () => {events.push("validate product"); return true;}})
      .catch((error: unknown) => error);
    expect(productError).toBe(roomQuery);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('from "rooms"');
    expect(restrictedCalls).toBe(0);
  });

  test("keeps signed server scope distinct from current installation identity", () => {
    const input = fixture();
    expect(matchesCurrentStenographerAuthority(input)).toBe(true);
    expect(matchesCurrentStenographerAuthority({...input, serverScope: input.device.serverInstanceId})).toBe(false);
    expect(matchesCurrentStenographerAuthority({...input, device: {...input.device, serverInstanceId: input.serverScope}})).toBe(false);
  });

  test("rejects every stale signed device coordinate", () => {
    const input = fixture();
    const changes = {humanActorId: "other-human", deviceId: "other-device", deviceGeneration: 3,
      serverInstanceId: "other-installation", lineageGeneration: 4, epoch: 5,
      securityRevision: 6, headDigest: new Uint8Array(32), signingPublicKey: new Uint8Array(32)};
    for (const [key, value] of Object.entries(changes)) {
      expect(matchesCurrentStenographerAuthority({...input, device: {...input.device, [key]: value}})).toBe(false);
    }
  });

  test("rejects every stale signed Namespace, Domain and bundle coordinate", () => {
    const input = fixture();
    const changes = {namespaceId: "other", namespaceAccessRevision: 7, namespaceKeyGeneration: 8,
      namespaceHeadDigest: new Uint8Array(32), domainId: "other", domainKeyGeneration: 9,
      domainAuthorizationRevision: 10, domainHeadDigest: new Uint8Array(32), bundleRevision: 11,
      bundleDigest: new Uint8Array(32)};
    for (const [key, value] of Object.entries(changes)) {
      expect(matchesCurrentStenographerAuthority({...input, namespace: {...input.namespace, [key]: value}})).toBe(false);
    }
  });

  test("rejects substituted anchor and object Namespace bindings", () => {
    const input = fixture();
    expect(matchesCurrentStenographerAuthority({...input, descriptor: {
      ...input.descriptor,
      anchorNamespaceId: "other",
    }})).toBe(false);
    expect(matchesCurrentStenographerAuthority({...input, descriptor: {
      ...input.descriptor,
      inputBindings: [{...input.descriptor.inputBindings[0]!, namespaceId: "other"}],
    }})).toBe(false);
    expect(matchesCurrentStenographerAuthority({...input, descriptor: {
      ...input.descriptor,
      outputSlots: [{...input.descriptor.outputSlots[0]!, namespaceIds: ["other"]}],
    }})).toBe(false);
    expect(matchesCurrentStenographerAuthority({...input, descriptor: {
      ...input.descriptor,
      outputSlots: [{...input.descriptor.outputSlots[0]!,
        namespaceIds: [input.descriptor.anchorNamespaceId, "other"]}],
    }})).toBe(false);
  });

  test("rechecks admission identity and expiry while accepted execution survives bearer expiry", () => {
    const input = fixture();
    const admission = input.admission!;
    for (const [key, value] of Object.entries({userId: "other", humanActorId: "other", deviceId: "other",
      deviceGeneration: 3, serverInstanceId: "other", lineageGeneration: 4, epoch: 5,
      securityRevision: 6, headDigest: new Uint8Array(32), expiresAt: input.now})) {
      expect(matchesCurrentStenographerAuthority({...input, admission: {...admission, [key]: value}})).toBe(false);
    }
    const {admission: _admission, ...execution} = input;
    expect(matchesCurrentStenographerAuthority(execution)).toBe(true);
    expect(matchesCurrentStenographerAuthority({...execution, now: input.descriptor.expiresAt})).toBe(false);
    expect(matchesCurrentStenographerAuthority({...execution, now: input.descriptor.notBefore - 1})).toBe(false);
    expect(matchesCurrentStenographerAuthority({...execution, policyRevision: input.policyRevision + 1})).toBe(false);
  });
});
