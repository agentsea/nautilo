import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {createBackgroundAuthorizationResponseV2, encodeBackgroundWorkDescriptorV2,
  type BackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {createProductionBackgroundAuthorizationComposition} from "../../src/routes/background-authorization-composition";
import type {BackgroundAuthorizationDeviceSubject} from "../../src/routes/background-authorization";

type Dependencies = Required<NonNullable<Parameters<typeof createProductionBackgroundAuthorizationComposition>[0]>>;
async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const now = 1_700_000_000_000;
  const device = {userId: "user-1", humanActorId: "human-1", deviceId: "device-1", deviceGeneration: 2,
    serverInstanceId: "d8c858cc-f359-48ad-8de6-341f61fb92a1", lineageGeneration: 3, epoch: 4,
    securityRevision: 5, headDigest: new Uint8Array(32).fill(8), signingPublicKey: signing.publicKey};
  const subject: BackgroundAuthorizationDeviceSubject = {...device, admission: {...device, expiresAt: now + 60_000}};
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {formatVersion: 2, requestId: "request-1", recipientGeneration: 0,
    workId: "work-1", workKind: "stenographer.extraction", anchorNamespaceId: "namespace-1", anchorDomainId: "domain-1",
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1}, operations: ["decrypt", "encrypt"],
    purpose: "journal.extract", authority: {serverId: "https://nautilo.example", roomId: "room-1", namespaceId: "namespace-1",
      namespaceAccessRevision: 2, namespaceKeyGeneration: 1, namespaceHeadDigest: new Uint8Array(32).fill(1),
      domainId: "domain-1", domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: new Uint8Array(32).fill(2),
      bundleRevision: 5, bundleDigest: new Uint8Array(32).fill(3)}, policyRevision: 6,
    source: {kind: "stenographer_work", startSequence: 10, endSequence: 12, rebuildGeneration: 0, fingerprint: new Uint8Array(32).fill(4)},
    inputBindings: [{objectId: "message-10", namespaceId: "namespace-1"}],
    outputSlots: [{objectId: "record-1", objectType: "nautilo.reflection.record.v1", createdAt: now, namespaceIds: ["namespace-1"]}],
    maximumPlaintextBytes: 1_024, maximumCiphertextBytes: 4_096, recipientKeyId: "recipient-1", recipientPublicKey: recipient.publicKey,
    issuedAt: now, notBefore: now, expiresAt: now + 60_000, idempotencyId: "attempt-1"};
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {credentialId: "credential-1", descriptorBytes,
    issuer: {humanId: device.humanActorId, deviceId: device.deviceId, deviceGeneration: device.deviceGeneration,
      serverInstanceId: device.serverInstanceId, lineageGeneration: device.lineageGeneration, epoch: device.epoch,
      securityRevision: device.securityRevision, headDigest: device.headDigest, signingPublicKeyHash: crypto.hash(signing.publicKey)},
    issuerSigningPrivateKey: signing.privateKey, domainKey: crypto.randomBytes(32)});
  signing.privateKey.fill(0); recipient.privateKey.fill(0);
  const pages: unknown[] = [];
  const accepted: unknown[] = [];
  const routed: unknown[] = [];
  let allow = true;
  let live = true;
  let pageNumber = 0;
  const connection = {query: async () => []};
  const service = createProductionBackgroundAuthorizationComposition({crypto, now: () => now, serverScope: descriptor.authority.serverId,
    restricted: (() => connection) as unknown as Dependencies["restricted"],
    context: (async () => ({canonicalRunner: {}})) as unknown as Dependencies["context"],
    currentDevice: async () => live ? {...device, headDigest: device.headDigest.slice(), signingPublicKey: signing.publicKey.slice()} : null,
    withAuthority: (async (input: Parameters<NonNullable<Dependencies["withAuthority"]>>[0]) => {
      routed.push(input.descriptor.requestId);
      if (!allow) return null;
      return input.use({device} as Parameters<typeof input.use>[0], connection as unknown as Parameters<typeof input.use>[1],
        connection as unknown as Parameters<typeof input.use>[2]);
    }) as Dependencies["withAuthority"],
    repository: (async () => ({
      listAwaitingDevicePage: async (input: unknown) => {
        pages.push(input);
        return {records: [{snapshot: {formatVersion: 2, credentialSubject: {kind: "processor"}}, descriptorBytes: descriptorBytes.slice()}],
          continuation: pageNumber++ === 0 ? {updatedAt: now - 1, requestId: "request-1"} : null};
      },
      acceptVerifiedResponse: async (input: unknown) => {accepted.push(structuredClone(input)); return {status: "accepted"};},
    })) as unknown as Dependencies["repository"],
  });
  return {service, subject, descriptorBytes, responseBytes, pages, accepted, routed,
    allow(value: boolean) {allow = value;}, live(value: boolean) {live = value;}};
}

describe("production background authorization composition", () => {
  test("filters with current Lattice authority and advances through an empty eligible page", async () => {
    const f = await fixture(); f.allow(false);
    const first = await f.service.list(f.subject, {});
    expect(first.requests).toEqual([]); expect(first.continuation).toBeString();
    f.allow(true);
    const second = await f.service.list(f.subject, {continuation: first.continuation!});
    expect(second.requests[0]?.requestBytes).toEqual(f.descriptorBytes);
    expect(second.continuation).toBeUndefined();
    expect(f.pages[1]).toMatchObject({after: {updatedAt: 1_699_999_999_999, requestId: "request-1"}, throughUpdatedAt: 1_700_000_000_000});
    expect(f.routed).toEqual(["request-1", "request-1"]);
  });
  test("rejects revoked admission and forged continuation before disclosure", async () => {
    const f = await fixture(); f.live(false);
    expect(f.service.list(f.subject, {})).rejects.toMatchObject({status: "unauthorized"});
    expect(f.pages).toHaveLength(0);
    f.live(true);
    for (const cursor of ["=", Buffer.from(JSON.stringify({v: 1, through: 1, updated: 1, id: "request-1", extra: true})).toString("base64url")]) {
      expect(f.service.list(f.subject, {continuation: cursor})).rejects.toMatchObject({status: "malformed"});
    }
    expect(f.pages).toHaveLength(0);
  });
  test("verifies real signed response under current authority before durable acceptance", async () => {
    const f = await fixture();
    expect(await f.service.respond(f.subject, {responseBytes: f.responseBytes})).toEqual({status: "accepted"});
    expect(f.accepted[0]).toMatchObject({response: {formatVersion: 2, kind: "processor", descriptor: {requestId: "request-1"}}});
    expect(f.responseBytes.some(byte => byte !== 0)).toBe(true);
    f.allow(false);
    expect(await f.service.respond(f.subject, {responseBytes: f.responseBytes})).toEqual({status: "stale"});
    expect(f.accepted).toHaveLength(1);
  });
  test("rejects another Human and signature tampering without acceptance", async () => {
    const f = await fixture();
    expect(f.service.respond({...f.subject, humanActorId: "other"}, {responseBytes: f.responseBytes}))
      .rejects.toMatchObject({status: "unauthorized"});
    const changed = f.responseBytes.slice(); changed[changed.length - 1]! ^= 1;
    expect(f.service.respond(f.subject, {responseBytes: changed})).rejects.toMatchObject({status: "malformed"});
    expect(f.accepted).toHaveLength(0);
  });
});
