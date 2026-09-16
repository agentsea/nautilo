import { describe, expect, test } from "bun:test";
import type { ProtectedArtifactDtoV1 } from "@nautilo/api-client/browser";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  createCommonAgentObjectAccessManifest,
  cryptoDeviceId,
  decryptObjectThroughNamespace,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  objectId,
  openArtifactBlobRange,
  prepareAgentRuntimeInitialization,
  unixTimestamp,
  verifyHumanArtifactPublicationRequest,
} from "@nautilo/lattice-crypto";
import {
  decodeArtifactControlV1,
  decodeEncryptedPayloadV2,
  decodeHumanArtifactExactAccessRequestV1,
  decodeHumanArtifactPublicationRequestV1,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeAgentRuntimeSignerPublicationV1,
  encodeArtifactBlobHeaderV1,
} from "@nautilo/lattice-crypto/wire";

import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import type { ClientProfileCoordinates } from "../../src/client-vault/types.ts";
import { FilePreparedArtifactCiphertextSidecar } from "../../src/client/artifact/file-prepared-artifact-ciphertext-sidecar.ts";
import {
  createVaultHumanArtifactDeviceContentPort,
} from "../../src/client/artifact/vault-human-artifact-device-content.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";

const ARTIFACT = "82000000-0000-4000-8000-000000000101";
const ROW = "82000000-0000-4000-8000-000000000102";
const BLOB = "82000000-0000-4000-8000-000000000103";
const NS = "82000000-0000-4000-8000-000000000104";
const COORDINATES: ClientProfileCoordinates = Object.freeze({
  serverScope: "https://nautilo.test",
  userId: "82000000-0000-4000-8000-000000000105",
  humanActorId: "82000000-0000-4000-8000-000000000106",
  profileId: "profile:artifact",
  deviceId: "device:artifact",
  installationLineageDigest: "17".repeat(32),
});

function seededRng(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => Uint8Array.from({ length }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state & 0xff;
  });
}

function decodeBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes.subarray(0, 7);
  yield bytes.subarray(7, 24);
  yield bytes.subarray(24);
}

async function setup() {
  const now = 1_800_000_000_000;
  const crypto = new LatticeCrypto({ bytes: seededRng(0x262) }, { now: () => now });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const namespaceKey = new Uint8Array(32).fill(0x62);
  const profile: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: COORDINATES.deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 3,
    trustedHostAuthorizationRevision: 5,
    deliveryHighWatermark: 1,
    keyringDeliveries: Object.freeze([Object.freeze({
      deliverySequence: 1,
      operationId: "delivery:artifact",
      namespaceId: NS,
      keyClass: "ai" as const,
      domainId: "domain:artifact",
      domainEpoch: 1,
      accessRevision: 2,
      bindingHash: new Uint8Array(32).fill(0x26),
      currentGeneration: 4,
      generations: Object.freeze([Object.freeze({
        generation: 4,
        key: namespaceKey,
      })]),
    })]),
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  const profileBytes = encodeClientDeviceProfileV2(profile);
  await vault.stageProfile({
    coordinates: COORDINATES,
    stageId: "artifact-profile-stage",
    generation: 1,
    profileBytes,
    publicState: { clientKind: "browser", publicFingerprint: "26".repeat(32) },
  });
  await vault.activateProfile(COORDINATES, "artifact-profile-stage");
  profileBytes.fill(0);
  const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-content-"));
  const sidecars = new FilePreparedArtifactCiphertextSidecar(root);
  let retainedAnchor: import("@nautilo/lattice-crypto").TrustedMinimumObjectAccessHead | null = null;
  return { crypto, namespaceKey, now, profile, sidecars, signing, vault,
    content: createVaultHumanArtifactDeviceContentPort({
      crypto,
      vault,
      coordinates: COORDINATES,
      subjectHumanId: "human:artifact",
      now: () => now,
      createProfileStageId: () => "artifact-profile-v4-stage",
      ciphertextStaging: sidecars,
      resolveTrustedDeviceSigningPublicKey: () =>
        Promise.resolve(signing.publicKey.slice()),
      accessAnchors: {
        load: () => Promise.resolve(retainedAnchor),
        advance: ({ expected, next }) => {
          if (expected !== retainedAnchor) return Promise.resolve(false);
          retainedAnchor = next;
          return Promise.resolve(true);
        },
      },
    }) };
}

describe("vault-backed Human Artifact content", () => {
  test("streams once into durable ciphertext, signs exact facts, and opens locally", async () => {
    const state = await setup();
    const plaintext = new TextEncoder().encode(
      "human-artifact-plaintext-canary: one pass only",
    );
    let yielded = 0;
    const prepared = await state.content.prepareContent({
      plan: {
        dtoVersion: 1,
        status: "planned",
        planVersion: 1,
        operationId: "artifact-publication:create:1",
        planDigestBase64url: Buffer.from(new Uint8Array(32).fill(0x71)).toString("base64url"),
        operation: "create",
        lifecycleAction: "activate",
        artifactRowId: ROW,
        artifactId: ARTIFACT,
        anchorNamespaceId: NS,
        cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
        expectedArtifactRevision: 0,
        nextArtifactRevision: 1,
        expectedCryptoAccessRevision: 0,
        resultCryptoAccessRevision: 0,
        expectedBlobGeneration: 0,
        resultBlobGeneration: 1,
        expectedBlobId: null,
        resultBlobId: BLOB,
        requiredNamespaceIds: [NS],
        bindings: [{
          namespaceId: NS,
          domainId: "domain:artifact",
          expectedAccessRevision: 2,
          expectedPolicyRevision: 7,
          bindingHashBase64url: Buffer.from(new Uint8Array(32).fill(0x26)).toString("base64url"),
        }],
        maxPlaintextBytes: 104_857_600,
        maxCiphertextBytes: 110_100_000,
        chunkPlaintextBytes: 1_048_576,
        mimeClass: "text",
        sizeBucket: "le_64_kib",
        deadlineAt: state.now + 30_000,
      },
      intent: {
        logicalPath: "notes/private.txt",
        mimeType: "text/plain; charset=utf-8",
        plaintextLength: plaintext.length,
        plaintext: (async function* () {
          yielded += 1;
          yield* chunks(plaintext);
        })(),
      },
    });
    expect(yielded).toBe(1);
    expect(prepared.prepared).toMatchObject({
      artifactId: ARTIFACT,
      resultBlobId: BLOB,
      operation: "create",
      requiredNamespaceIds: [NS],
    });
    const signedBytes = decodeBase64url(
      prepared.prepared.signedPublicationRequestBytesBase64url,
    );
    const decodedRequest = decodeHumanArtifactPublicationRequestV1(signedBytes);
    expect(decodedRequest.planDigest).toEqual(new Uint8Array(32).fill(0x71));
    expect(verifyHumanArtifactPublicationRequest(state.crypto, {
      requestBytes: signedBytes,
      now: unixTimestamp(state.now + 1),
      resolveCurrentAuthority: () => state.signing.publicKey,
    }).artifactId).toBe(ARTIFACT);

    const payload = decodeEncryptedPayloadV2(decodeBase64url(
      prepared.prepared.encryptedControlPayloadBytesBase64url,
    ));
    const envelope = decodeNamespaceObjectEnvelopeV2(decodeBase64url(
      prepared.prepared.namespaceEnvelopes[0]!.envelopeBytesBase64url,
    ));
    const controlBytes = decryptObjectThroughNamespace(
      state.crypto,
      state.namespaceKey,
      envelope,
      payload,
    );
    if (controlBytes === null) throw new Error("Artifact control DEK is unavailable");
    const control = decodeArtifactControlV1(controlBytes);
    expect(control.logicalPath).toBe("notes/private.txt");
    expect(control.mimeType).toBe("text/plain; charset=utf-8");

    const dto: ProtectedArtifactDtoV1 = {
        dtoVersion: 1,
        status: "encrypted",
        artifactId: ARTIFACT,
        artifactRevision: 1,
        cryptoObjectId: prepared.prepared.cryptoObjectId,
        cryptoAccessRevision: 0,
        requiredNamespaceIds: [NS],
        encryptedControlPayloadBytesBase64url:
          prepared.prepared.encryptedControlPayloadBytesBase64url,
        accessManifestBytesBase64url:
          prepared.prepared.accessManifestBytesBase64url,
        accessManifestProofBytesBase64url: [],
        accessSignerEvidence: [],
        namespaceEnvelopes: prepared.prepared.namespaceEnvelopes,
        blobId: BLOB,
        blobGeneration: 1,
        ciphertextLength: prepared.prepared.ciphertextLength,
        ciphertextSha256Base64url:
          prepared.prepared.ciphertextSha256Base64url,
        chunkPlaintextBytes: 1_048_576,
        chunkCount: 1,
        mimeClass: "text",
        sizeBucket: "le_64_kib",
        archived: false,
        canManageAccess: true,
      };
    const openedPath = await state.content.withOpenedControl({
      dto,
      consume: (opened) => opened.logicalPath,
    });
    expect(openedPath).toBe("notes/private.txt");
    const renamed = await state.content.prepareControl({
      current: dto,
      plan: {
        dtoVersion: 1,
        status: "planned",
        planVersion: 1,
        operationId: "artifact-publication:rename:2",
        planDigestBase64url: Buffer.from(new Uint8Array(32).fill(0x72)).toString("base64url"),
        operation: "revise_control",
        lifecycleAction: "activate",
        artifactRowId: ROW,
        artifactId: ARTIFACT,
        anchorNamespaceId: NS,
        cryptoObjectId: `artifact:v1:${"b".repeat(64)}`,
        expectedArtifactRevision: 1,
        nextArtifactRevision: 2,
        expectedCryptoAccessRevision: 0,
        resultCryptoAccessRevision: 0,
        expectedBlobGeneration: 1,
        resultBlobGeneration: 1,
        expectedBlobId: BLOB,
        resultBlobId: BLOB,
        requiredNamespaceIds: [NS],
        bindings: [{
          namespaceId: NS,
          domainId: "domain:artifact",
          expectedAccessRevision: 2,
          expectedPolicyRevision: 7,
          bindingHashBase64url: Buffer.from(
            new Uint8Array(32).fill(0x26),
          ).toString("base64url"),
        }],
        maxPlaintextBytes: 104_857_600,
        maxCiphertextBytes: 110_100_000,
        chunkPlaintextBytes: 1_048_576,
        mimeClass: "text",
        sizeBucket: "le_64_kib",
        deadlineAt: state.now + 30_000,
      },
      logicalPath: "renamed/private.txt",
    });
    expect(renamed).toMatchObject({ operation: "revise_control",
      expectedBlobId: BLOB, resultBlobId: BLOB, expectedBlobGeneration: 1,
      resultBlobGeneration: 1, ciphertextSha256Base64url:
        prepared.prepared.ciphertextSha256Base64url });
    const renamedPayload = decodeEncryptedPayloadV2(decodeBase64url(
      renamed.encryptedControlPayloadBytesBase64url,
    ));
    const renamedEnvelope = decodeNamespaceObjectEnvelopeV2(decodeBase64url(
      renamed.namespaceEnvelopes[0]!.envelopeBytesBase64url,
    ));
    const renamedBytes = decryptObjectThroughNamespace(
      state.crypto,
      state.namespaceKey,
      renamedEnvelope,
      renamedPayload,
    );
    if (renamedBytes === null) throw new Error("renamed control unavailable");
    const renamedControl = decodeArtifactControlV1(renamedBytes);
    expect(renamedControl.logicalPath).toBe("renamed/private.txt");
    expect(renamedControl.blobDek).toEqual(control.blobDek);
    renamedControl.blobDek.fill(0);
    renamedControl.plaintextSha256.fill(0);
    renamedControl.ciphertextSha256.fill(0);
    renamedBytes.fill(0);

    const access = await state.content.prepareAccess({
      current: dto,
      plan: {
        dtoVersion: 1, status: "planned", planVersion: 1,
        operationId: "artifact-access:remove-view", artifactId: ARTIFACT,
        artifactRevision: 1, expectedCryptoAccessRevision: 0,
        nextCryptoAccessRevision: 1, cryptoObjectId: dto.cryptoObjectId,
        blobId: BLOB, blobGeneration: 1, currentNamespaceIds: [NS],
        targetNamespaceIds: [], addedNamespaceIds: [], removedNamespaceIds: [NS],
        currentBindings: [{ namespaceId: NS, domainId: "domain:artifact",
          expectedAccessRevision: 2, expectedPolicyRevision: 7,
          bindingHashBase64url: Buffer.from(new Uint8Array(32).fill(0x26))
            .toString("base64url") }],
        targetBindings: [], sourceAuthorized: true, targetAuthorized: true,
        deadlineAt: state.now + 30_000,
      },
    });
    expect(access.request).toMatchObject({ artifactId: ARTIFACT,
      blobId: BLOB, targetNamespaceIds: [], namespaceEnvelopes: [] });
    const accessSigned = decodeHumanArtifactExactAccessRequestV1(
      decodeBase64url(access.request.signedAccessRequestBytesBase64url),
    );
    expect(accessSigned).toMatchObject({ artifactId: ARTIFACT,
      artifactRevision: 1, blobId: BLOB, blobGeneration: 1,
      expectedAccessRevision: 0, nextAccessRevision: 1 });
    expect(accessSigned.currentInventoryHash).not.toEqual(
      accessSigned.targetInventoryHash,
    );
    accessSigned.payloadHash.fill(0);
    accessSigned.currentManifestHash.fill(0);
    accessSigned.nextManifestHash.fill(0);
    accessSigned.currentInventoryHash.fill(0);
    accessSigned.targetInventoryHash.fill(0);
    accessSigned.signature.fill(0);

    const sidecarReference = {
      formatVersion: 1 as const,
      operationId: prepared.stagedCiphertext.operationId,
      authenticatedRequestDigestBase64url: "A".repeat(43),
      artifactId: ARTIFACT,
      blobId: BLOB,
      blobGeneration: 1,
      ciphertextLength: prepared.stagedCiphertext.ciphertextLength,
      ciphertextSha256Base64url:
        prepared.stagedCiphertext.ciphertextSha256Base64url,
    };
    expect(await state.sidecars.bind({
      staged: prepared.stagedCiphertext,
      reference: sidecarReference,
    })).toBe("inserted");
    await state.sidecars.withOpened(sidecarReference, async (ciphertext) => {
      const parts: Uint8Array[] = [];
      for await (const part of ciphertext) parts.push(part.slice());
      const fileBytes = Uint8Array.from(parts.flatMap((part) => [...part]));
      expect(new TextDecoder().decode(fileBytes)).not.toContain(
        "human-artifact-plaintext-canary",
      );
      expect(openArtifactBlobRange(state.crypto, {
        fileBytes,
        blobDek: control.blobDek,
        expected: {
          formatVersion: 1,
          artifactId: ARTIFACT,
          blobId: BLOB,
          blobGeneration: 1,
          plaintextLength: plaintext.length,
          chunkPlaintextBytes: 1_048_576,
          chunkCount: 1,
        },
        start: 0,
        endExclusive: plaintext.length,
      })).toEqual(plaintext);
      const headerLength = encodeArtifactBlobHeaderV1({
        formatVersion: 1,
        artifactId: ARTIFACT,
        blobId: BLOB,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        chunkPlaintextBytes: 1_048_576,
        chunkCount: 1,
      }).length;
      const openedRange = await state.content.withOpenedRange<Uint8Array>({
        dto,
        range: {
          status: "encrypted_chunks",
          artifactId: ARTIFACT,
          artifactRevision: 1,
          cryptoAccessRevision: 0,
          blobId: BLOB,
          blobGeneration: 1,
          plaintextLength: plaintext.length,
          ciphertextLength: prepared.prepared.ciphertextLength,
          ciphertextSha256Base64url:
            prepared.prepared.ciphertextSha256Base64url,
          chunkPlaintextBytes: 1_048_576,
          chunkCount: 1,
          firstChunkIndex: 0,
          returnedChunkCount: 1,
          body: fileBytes.slice(headerLength),
        },
        start: 6,
        endExclusive: 21,
        consume: (opened) => opened.slice(),
      });
      expect(openedRange).toEqual(plaintext.slice(6, 21));
      openedRange.fill(0);
      fileBytes.fill(0);
    });
    control.blobDek.fill(0);
    control.plaintextSha256.fill(0);
    control.ciphertextSha256.fill(0);
    controlBytes.fill(0);
    signedBytes.fill(0);
  });

  test("opens an Agent-written control revision through the retained common chain", async () => {
    const state = await setup();
    const prepared = await state.content.prepareContent({
      plan: {
        dtoVersion: 1,
        status: "planned",
        planVersion: 1,
        operationId: "artifact-publication:agent-read",
        planDigestBase64url: Buffer.from(new Uint8Array(32).fill(0x73))
          .toString("base64url"),
        operation: "create",
        lifecycleAction: "activate",
        artifactRowId: ROW,
        artifactId: ARTIFACT,
        anchorNamespaceId: NS,
        cryptoObjectId: `artifact:v1:${"c".repeat(64)}`,
        expectedArtifactRevision: 0,
        nextArtifactRevision: 1,
        expectedCryptoAccessRevision: 0,
        resultCryptoAccessRevision: 0,
        expectedBlobGeneration: 0,
        resultBlobGeneration: 1,
        expectedBlobId: null,
        resultBlobId: BLOB,
        requiredNamespaceIds: [NS],
        bindings: [{
          namespaceId: NS,
          domainId: "domain:artifact",
          expectedAccessRevision: 2,
          expectedPolicyRevision: 7,
          bindingHashBase64url: Buffer.from(new Uint8Array(32).fill(0x26))
            .toString("base64url"),
        }],
        maxPlaintextBytes: 104_857_600,
        maxCiphertextBytes: 110_100_000,
        chunkPlaintextBytes: 1_048_576,
        mimeClass: "text",
        sizeBucket: "le_64_kib",
        deadlineAt: state.now + 30_000,
      },
      intent: {
        logicalPath: "agent-readable.txt",
        mimeType: "text/plain",
        plaintextLength: 15,
        plaintext: (async function* () {
          yield new TextEncoder().encode("artifact-common");
        })(),
      },
    });
    const genesisBytes = decodeBase64url(
      prepared.prepared.accessManifestBytesBase64url,
    );
    const genesis = decodeObjectAccessManifestV5(genesisBytes);
    const initialized = await prepareAgentRuntimeInitialization({
      crypto: state.crypto,
      operationId: "runtime:artifact-agent-read",
      agentId: agentId("agent-artifact-reader"),
      authorizationRevision: authorizationRevision(5),
      configObjects: [{
        objectId: objectId("config-artifact-reader"),
        configRevision: authorizationRevision(1),
        plaintextDek: new Uint8Array(32).fill(0x67),
      }],
      domains: [],
      resolveCurrentDomainCommitterAuthority: () => null,
      manager: {
        managerHumanId: humanId("human:artifact"),
        managerAuthorizationRevision: authorizationRevision(5),
        managerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
      },
      managerSigningPrivateKey: state.signing.privateKey,
      resolveCurrentManagerAuthority: () => state.signing.publicKey,
    });
    const agentHead = createCommonAgentObjectAccessManifest(state.crypto, {
      objectId: genesis.objectId,
      payloadHash: genesis.payloadHash,
      accessRevision: accessRevision(1),
      previousManifestHash: state.crypto.hash(genesisBytes),
      envelopeHashes: genesis.envelopeHashes,
      signer: deriveAgentRuntimeObjectSignerPublic(
        state.crypto,
        initialized.runtime,
      ).principal,
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(5),
    }, initialized.runtime);
    const publicationBytes = encodeAgentRuntimeSignerPublicationV1(
      initialized.signerPublication,
    );
    const dto: ProtectedArtifactDtoV1 = {
      dtoVersion: 1,
      status: "encrypted",
      artifactId: ARTIFACT,
      artifactRevision: 1,
      cryptoObjectId: prepared.prepared.cryptoObjectId,
      cryptoAccessRevision: 1,
      requiredNamespaceIds: [NS],
      encryptedControlPayloadBytesBase64url:
        prepared.prepared.encryptedControlPayloadBytesBase64url,
      accessManifestBytesBase64url: Buffer.from(agentHead.bytes)
        .toString("base64url"),
      accessManifestProofBytesBase64url: [
        Buffer.from(genesisBytes).toString("base64url"),
      ],
      accessSignerEvidence: [{
        kind: "agent_runtime_publication",
        evidenceBytesBase64url: Buffer.from(publicationBytes)
          .toString("base64url"),
      }],
      namespaceEnvelopes: prepared.prepared.namespaceEnvelopes,
      blobId: BLOB,
      blobGeneration: 1,
      ciphertextLength: prepared.prepared.ciphertextLength,
      ciphertextSha256Base64url:
        prepared.prepared.ciphertextSha256Base64url,
      chunkPlaintextBytes: 1_048_576,
      chunkCount: 1,
      mimeClass: "text",
      sizeBucket: "le_64_kib",
      archived: false,
      canManageAccess: true,
    };
    expect(await state.content.withOpenedControl({
      dto,
      consume: (opened) => opened.logicalPath,
    })).toBe("agent-readable.txt");
    expect((await state.vault.listPublicProfiles())[0]?.generation).toBe(2);

    publicationBytes.fill(0);
    genesisBytes.fill(0);
  });

  test("removes the unbound staged sidecar when plaintext length is wrong", async () => {
    const state = await setup();
    const plan = {
      dtoVersion: 1 as const, status: "planned" as const, planVersion: 1 as const,
      operationId: "artifact-publication:create:short", planDigestBase64url: "A".repeat(43),
      operation: "create" as const, lifecycleAction: "activate" as const,
      artifactRowId: ROW, artifactId: ARTIFACT, anchorNamespaceId: NS,
      cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
      expectedArtifactRevision: 0, nextArtifactRevision: 1,
      expectedCryptoAccessRevision: 0, resultCryptoAccessRevision: 0 as const,
      expectedBlobGeneration: 0, resultBlobGeneration: 1, expectedBlobId: null,
      resultBlobId: BLOB, requiredNamespaceIds: [NS],
      bindings: [{ namespaceId: NS, domainId: "domain:artifact",
        expectedAccessRevision: 2, expectedPolicyRevision: 7,
        bindingHashBase64url: Buffer.from(new Uint8Array(32).fill(0x26)).toString("base64url") }],
      maxPlaintextBytes: 104_857_600, maxCiphertextBytes: 110_100_000,
      chunkPlaintextBytes: 1_048_576 as const, mimeClass: "text" as const,
      sizeBucket: "le_64_kib" as const, deadlineAt: state.now + 30_000,
    };
    expect(state.content.prepareContent({
      plan,
      intent: { logicalPath: "short.txt", mimeType: "text/plain",
        plaintextLength: 5, plaintext: (async function* () {
          yield new Uint8Array([1, 2, 3]);
        })() },
    })).rejects.toThrow("ended before");
    expect(await state.sidecars.list()).toEqual([]);
  });
});
