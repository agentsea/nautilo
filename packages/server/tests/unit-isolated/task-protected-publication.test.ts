import { describe, expect, test } from "bun:test";
import type {
  DualTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPublicationPlanV1,
} from "@nautilo/api-client";
import {
  bindEncryptionDataOperationOwner,
  deriveTaskContentCryptoObjectIdV1,
  encodeTaskPayloadV1,
  fingerprintTaskDualPublicationFieldsV1,
  fingerprintTaskOperationalFieldsV1,
  taskContentObjectTypeV1,
  type TaskContentRepository,
} from "@nautilo/lattice-bridge";
import { bindDurableTaskContentRepositoryV1 } from "@nautilo/lattice-bridge/server";
import {
  LatticeCrypto,
  accessRevision,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanObjectAccessManifestGenesisSet,
  prepareHumanTaskPublicationRequest,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import { importProtectedTaskPublicationV1 } from "../../src/routes/task-protected-publication";

const TASK = "92000000-0000-4000-8000-000000000001";
const HUMAN = "92000000-0000-4000-8000-000000000002";
const NAMESPACE = "92000000-0000-4000-8000-000000000003";
const ROOM = "92000000-0000-4000-8000-000000000004";
const DOMAIN = "task-domain:publication";
const NOW = 1_820_000_000_000;

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function noncanonicalBase64urlAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  if (value.length % 4 !== 2 && value.length % 4 !== 3) {
    throw new Error("Fixture needs trailing unused base64url bits");
  }
  const last = alphabet.indexOf(value.at(-1)!);
  if (last < 0) throw new Error("Fixture is not base64url");
  return `${value.slice(0, -1)}${alphabet[last ^ 1]}`;
}

function fixture(
  representation: "protected" | "dual" = "protected",
  prompt = "ciphertext only",
) {
  let seed = 1;
  const crypto = new LatticeCrypto({
    bytes: (length) => Uint8Array.from({ length }, () => (seed++ * 31) & 0xff),
  }, { now: () => NOW });
  const signer = crypto.generateSigningKeyPair();
  const coordinate = Object.freeze({ kind: "definition" as const,
    taskId: TASK, contentRevision: 1 });
  const cryptoObjectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  const plaintext = encodeTaskPayloadV1({ formatVersion: 1,
    prompt, expectedOutput: null, protectedMetadata: {} });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(cryptoObjectId), keyClass: "ai",
    objectType: taskContentObjectTypeV1(coordinate), createdAt: unixTimestamp(NOW),
  }, plaintext);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    // Device-side preparation owns the Namespace secret. The server receives
    // only the resulting envelope and authenticates its signed coordinates.
    wrapObjectDekForNamespace(crypto, new Uint8Array(32).fill(4), {
      objectId: objectId(cryptoObjectId), namespaceId: namespaceId(NAMESPACE),
      keyClass: "ai", keyGeneration: namespaceGeneration(1),
      bindingRevisionAtWrap: accessRevision(0),
    }, encrypted.dek),
  );
  encrypted.dek.fill(0);
  const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: cryptoObjectId, payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes], sourceAuthorized: true, targetAuthorized: true,
    subjectHumanId: HUMAN, committerDeviceId: "device:publication",
    hostAuthorizationRevision: 7, committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const task = {};
  const operationalFieldsDigest = representation === "dual"
    ? fingerprintTaskDualPublicationFieldsV1("create", task, plaintext)
    : fingerprintTaskOperationalFieldsV1("create", task);
  const planDigest = new Uint8Array(32).fill(8);
  const bindingHash = new Uint8Array(32).fill(9);
  const signed = prepareHumanTaskPublicationRequest(crypto, {
    operation: "create", operationId: "task:create:authenticated", taskId: TASK,
    cryptoObjectId, expectedContentRevision: 0, nextContentRevision: 1,
    expectedCryptoAccessRevision: 0, resultCryptoAccessRevision: 0,
    planDigest, operationalFieldsDigest, subjectHumanId: HUMAN,
    committerDeviceId: "device:publication", hostAuthorizationRevision: 7,
    namespaceId: NAMESPACE, domainId: DOMAIN, expectedNamespaceAccessRevision: 0,
    expectedPolicyRevision: 1, bindingHash, keyGeneration: 1,
    payloadHash: crypto.hash(payloadBytes), manifestHash: crypto.hash(access.manifestBytes),
    envelopeHash: crypto.hash(envelopeBytes), issuedAt: NOW, deadlineAt: NOW + 30_000,
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const plan: ProtectedTaskPublicationPlanV1 = {
    planVersion: 1, operation: "create", operationId: "task:create:authenticated",
    taskId: TASK, expectedContentRevision: 0, nextContentRevision: 1,
    expectedCryptoAccessRevision: 0, planDigestBase64url: b64(planDigest),
    authority: { requesterHumanId: HUMAN, sourceRoomId: ROOM,
      namespaceId: NAMESPACE, domainId: DOMAIN, expectedAccessRevision: 0,
      expectedPolicyRevision: 1, bindingHashBase64url: b64(bindingHash), keyGeneration: 1 },
  };
  const protectedPrepared: ProtectedTaskPreparedCreateRequestV1 = {
    requestVersion: 1 as const, operation: "create" as const,
    operationId: plan.operationId, planDigestBase64url: plan.planDigestBase64url,
    taskId: TASK, expectedContentRevision: 0 as const, nextContentRevision: 1 as const,
    expectedCryptoAccessRevision: 0 as const, resultCryptoAccessRevision: 0 as const,
    cryptoObjectId, payloadVersion: 1 as const, requiredNamespaceIds: [NAMESPACE] as [string],
    encryptedPayloadBytesBase64url: b64(payloadBytes),
    accessManifestBytesBase64url: b64(access.manifestBytes),
    namespaceEnvelopes: [{ namespaceId: NAMESPACE,
      envelopeBytesBase64url: b64(envelopeBytes) }] as [{ namespaceId: string; envelopeBytesBase64url: string }],
    signedPublicationRequestBytesBase64url: b64(signed.bytes), task,
  };
  const prepared: ProtectedTaskPreparedCreateRequestV1 | DualTaskPreparedCreateRequestV1 =
    representation === "dual"
      ? { ...protectedPrepared, representation: "dual", ordinaryPayloadBytesBase64url: b64(plaintext) }
      : protectedPrepared;
  plaintext.fill(0);
  return { crypto, signer, plan, prepared };
}

function dualFixture(prompt = "ciphertext only") {
  const state = fixture("dual", prompt);
  if (!("representation" in state.prepared)) {
    throw new Error("Expected dual fixture");
  }
  return { ...state, prepared: state.prepared };
}

class ReplayRepository implements TaskContentRepository {
  calls: string[] = [];
  private readonly requests = new Map<string, Uint8Array>();
  async reserveRevision(input: Parameters<TaskContentRepository["reserveRevision"]>[0]) {
    this.calls.push(`reserve:${input.operationId}`);
    const prior = this.requests.get(input.operationId);
    if (prior !== undefined && !prior.every((value, index) =>
      value === input.requestDigest[index])) return { status: "conflict" as const };
    this.requests.set(input.operationId, input.requestDigest.slice());
    return { status: prior === undefined ? "reserved" as const : "replayed" as const,
      coordinate: input.prepared.coordinate, cryptoObjectId: input.prepared.objectId };
  }
  async lookupPreparedReplay(input: Parameters<TaskContentRepository["lookupPreparedReplay"]>[0]) {
    const prior = this.requests.get(input.operationId);
    if (prior === undefined || !prior.every((value, index) =>
      value === input.requestDigest[index])) return { status: "unavailable" as const };
    return { status: "exact" as const, authority: Object.freeze({
      authorityVersion: 1 as const,
      kind: "requester_private_namespace" as const,
      keyClass: "ai" as const,
      requesterHumanId: HUMAN,
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 1,
    }) };
  }
  async completeRevision(input: Parameters<TaskContentRepository["completeRevision"]>[0]) {
    this.calls.push(`complete:${input.coordinate.contentRevision}`);
    return { status: "mapped" as const, coordinate: input.coordinate,
      cryptoObjectId: input.prepared.objectId };
  }
  async reconcilePending() { return { outcomes: [] }; }
}

describe("authenticated protected Task HTTP publication", () => {
  test("imports signed bytes and replays them through the PR2 repository", async () => {
    const state = fixture();
    const imported = await importProtectedTaskPublicationV1({
      crypto: state.crypto, now: NOW, plan: state.plan, prepared: state.prepared,
      resolveCurrentAuthority: async (request) => {
        expect(request.subjectHumanId).toBe(HUMAN);
        expect(request.committerDeviceId).toBe("device:publication");
        return state.signer.publicKey;
      },
    });
    const protectedRepository = new ReplayRepository();
    let productReceipt: number | null = null;
    const repository = bindDurableTaskContentRepositoryV1({
      protectedRepository,
      content: {
        prepareProtected: async () => imported.prepared,
        publishProduct: async () => productReceipt ??= 1,
        readOrdinary: async () => { throw new Error("ordinary read unavailable"); },
        readProtected: async () => { throw new Error("opened read unavailable"); },
      },
    });
    const owner = bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode: "encrypted_only", shadowBehavior: "strict" },
        revalidationToken: 1 }), revalidate: async () => undefined,
    } });
    const publish = (
      publication = imported,
      requestDigest = publication.requestDigest,
    ) => repository.publishPrepared({
      representation: "protected",
      owner, operationId: state.prepared.operationId,
      requestDigest, authority: publication.authority,
      operationalMetadata: null, prepared: publication.prepared,
      publishProduct: async () => productReceipt ??= 1,
    });
    expect(await publish()).toMatchObject({ representation: "protected",
      protectedRevision: { status: "mapped" } });
    let exactAuthorityChecks = 0;
    const immediate = await importProtectedTaskPublicationV1({
      crypto: state.crypto, now: NOW, plan: null, prepared: state.prepared,
      lookupPreparedReplay: (request) => repository.lookupPreparedReplay(request),
      resolveCurrentAuthority: async () => {
        exactAuthorityChecks += 1;
        return state.signer.publicKey;
      },
    });
    if (immediate.representation !== "protected") {
      throw new Error("Expected protected exact replay");
    }
    expect((await publish(immediate)).product).toBe(1);
    expect(await publish()).toMatchObject({ representation: "protected",
      protectedRevision: { status: "mapped" } });
    const expired = await importProtectedTaskPublicationV1({
      crypto: state.crypto, now: NOW + 31_000, plan: null, prepared: state.prepared,
      lookupPreparedReplay: (request) => repository.lookupPreparedReplay(request),
      resolveCurrentAuthority: async () => {
        exactAuthorityChecks += 1;
        return state.signer.publicKey;
      },
    });
    if (expired.representation !== "protected") {
      throw new Error("Expected protected exact replay");
    }
    expect((await publish(expired)).product).toBe(1);
    expect(exactAuthorityChecks).toBe(2);
    const replayError = await publish(imported, new Uint8Array(32).fill(42)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(replayError).toMatchObject({ failureClass: "integrity" });
    expect(protectedRepository.calls).toEqual([
      "reserve:task:create:authenticated", "complete:1",
      "reserve:task:create:authenticated", "complete:1",
      "reserve:task:create:authenticated", "complete:1",
      "reserve:task:create:authenticated", "complete:1",
      "reserve:task:create:authenticated",
    ]);
  });

  test("rejects plan substitution before minting a repository revision", async () => {
    const state = fixture();
    const error = await importProtectedTaskPublicationV1({
      crypto: state.crypto, now: NOW,
      plan: { ...state.plan, planDigestBase64url: "B".repeat(43) },
      prepared: state.prepared,
      resolveCurrentAuthority: async () => state.signer.publicKey,
    }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("disagrees with its server plan");
  });

  test("rejects expired publication without an exact durable ledger match", async () => {
    const state = fixture("dual");
    let authorityChecks = 0;
    const error = await importProtectedTaskPublicationV1({
      crypto: state.crypto,
      now: NOW + 31_000,
      plan: null,
      prepared: state.prepared,
      lookupPreparedReplay: async () => ({ status: "unavailable" }),
      resolveCurrentAuthority: async () => {
        authorityChecks += 1;
        return state.signer.publicKey;
      },
    }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("not an exact durable replay");
    expect(authorityChecks).toBe(0);
  });

  test("imports one canonical dual body and rejects ordinary sibling substitution", async () => {
    const state = dualFixture();
    const imported = await importProtectedTaskPublicationV1({
      crypto: state.crypto, now: NOW, plan: state.plan, prepared: state.prepared,
      resolveCurrentAuthority: async () => state.signer.publicKey,
    });
    expect(imported).toMatchObject({
      representation: "dual",
      ordinaryContent: {
        coordinate: { kind: "definition", taskId: TASK, contentRevision: 1 },
        payload: { prompt: "ciphertext only" },
      },
    });
    if (imported.representation !== "dual") throw new Error("Expected dual import");

    const noncanonical = await importProtectedTaskPublicationV1({
      crypto: state.crypto, now: NOW, plan: state.plan,
      prepared: {
        ...state.prepared,
        ordinaryPayloadBytesBase64url:
          noncanonicalBase64urlAlias(state.prepared.ordinaryPayloadBytesBase64url),
      },
      resolveCurrentAuthority: async () => state.signer.publicKey,
    }).then(() => null, (reason: unknown) => reason);
    expect(noncanonical).toBeInstanceOf(TypeError);
    expect((noncanonical as Error).message).toContain("canonical base64url");

    const substitutedBytes = encodeTaskPayloadV1({
      formatVersion: 1, prompt: "substituted", expectedOutput: null,
      protectedMetadata: {},
    });
    const substituted = await importProtectedTaskPublicationV1({
      crypto: state.crypto, now: NOW, plan: state.plan,
      prepared: {
        ...state.prepared,
        ordinaryPayloadBytesBase64url: b64(substitutedBytes),
      },
      resolveCurrentAuthority: async () => state.signer.publicKey,
    }).then(() => null, (reason: unknown) => reason);
    substitutedBytes.fill(0);
    expect(substituted).toBeInstanceOf(TypeError);

    const protectedRepository = new ReplayRepository();
    const repository = bindDurableTaskContentRepositoryV1<string>({
      protectedRepository,
      content: {
        prepareProtected: async () => imported.prepared,
        publishProduct: async () => { throw new Error("ordinary mutation unavailable"); },
        readOrdinary: async () => { throw new Error("ordinary read unavailable"); },
        readProtected: async () => { throw new Error("protected read unavailable"); },
      },
    });
    const shadowOwner = bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: {
        mode: "shadow_encryption", shadowBehavior: "strict",
      }, revalidationToken: 1 }),
      revalidate: async () => undefined,
    } });
    let products = 0;
    const publish = () => repository.publishPrepared({
      representation: "dual",
      owner: shadowOwner,
      operationId: state.prepared.operationId,
      requestDigest: imported.requestDigest,
      authority: imported.authority,
      operationalMetadata: null,
      prepared: imported.prepared,
      ordinaryContent: imported.ordinaryContent,
      publishProduct: async (content) => {
        expect(content).toEqual(imported.ordinaryContent);
        products += 1;
        return TASK;
      },
    });
    expect(await publish()).toMatchObject({
      representation: "dual", product: TASK,
      protectedRevision: { status: "mapped" },
    });
    expect(products).toBe(1);
    expect(protectedRepository.calls).toEqual([
      "reserve:task:create:authenticated", "complete:1",
    ]);
  });

  test("replays an exact dual body and conflicts a different valid body", async () => {
    const first = dualFixture("first body");
    const second = dualFixture("second body");
    const importDual = async (state: ReturnType<typeof dualFixture>) => {
      const imported = await importProtectedTaskPublicationV1({
        crypto: state.crypto, now: NOW, plan: state.plan, prepared: state.prepared,
        resolveCurrentAuthority: async () => state.signer.publicKey,
      });
      if (imported.representation !== "dual") throw new Error("Expected dual import");
      return imported;
    };
    const [firstImported, secondImported] = await Promise.all([
      importDual(first), importDual(second),
    ]);
    expect(firstImported.requestDigest).not.toEqual(secondImported.requestDigest);

    const protectedRepository = new ReplayRepository();
    const repository = bindDurableTaskContentRepositoryV1<number>({
      protectedRepository,
      content: {
        prepareProtected: async () => firstImported.prepared,
        publishProduct: async () => { throw new Error("ordinary mutation unavailable"); },
        readOrdinary: async () => { throw new Error("ordinary read unavailable"); },
        readProtected: async () => { throw new Error("protected read unavailable"); },
      },
    });
    const shadowOwner = bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: {
        mode: "shadow_encryption", shadowBehavior: "strict",
      }, revalidationToken: 1 }),
      revalidate: async () => undefined,
    } });
    const published = new Map<string, number>();
    const publish = (imported: typeof firstImported) => repository.publishPrepared({
      representation: "dual", owner: shadowOwner,
      operationId: first.prepared.operationId,
      requestDigest: imported.requestDigest, authority: imported.authority,
      operationalMetadata: null, prepared: imported.prepared,
      ordinaryContent: imported.ordinaryContent,
      publishProduct: async (content) => {
        if (content.coordinate.kind !== "definition" || !("prompt" in content.payload)) {
          throw new Error("Expected definition content");
        }
        const prompt = content.payload.prompt;
        const existing = published.get(prompt);
        if (existing !== undefined) return existing;
        const receipt = published.size + 1;
        published.set(prompt, receipt);
        return receipt;
      },
    });
    expect((await publish(firstImported)).product).toBe(1);
    let exactAuthorityChecks = 0;
    const expired = await importProtectedTaskPublicationV1({
      crypto: first.crypto,
      now: NOW + 31_000,
      plan: null,
      prepared: first.prepared,
      lookupPreparedReplay: (request) => repository.lookupPreparedReplay(request),
      resolveCurrentAuthority: async () => {
        exactAuthorityChecks += 1;
        return first.signer.publicKey;
      },
    });
    if (expired.representation !== "dual") throw new Error("Expected dual exact replay");
    expect((await publish(expired)).product).toBe(1);
    expect(exactAuthorityChecks).toBe(1);
    expect((await publish(firstImported)).product).toBe(1);
    const alteredExpired = await importProtectedTaskPublicationV1({
      crypto: second.crypto,
      now: NOW + 31_000,
      plan: null,
      prepared: second.prepared,
      lookupPreparedReplay: (request) => repository.lookupPreparedReplay(request),
      resolveCurrentAuthority: async () => {
        exactAuthorityChecks += 1;
        return second.signer.publicKey;
      },
    }).then(() => null, (reason: unknown) => reason);
    expect(alteredExpired).toBeInstanceOf(TypeError);
    expect(exactAuthorityChecks).toBe(1);
    const conflict = await publish(secondImported).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(conflict).toMatchObject({ failureClass: "integrity" });
    expect(published).toEqual(new Map([["first body", 1]]));
  });
});
