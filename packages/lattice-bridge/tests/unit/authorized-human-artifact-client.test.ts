import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtectedArtifactPreparedPublicationRequestV1 } from "@nautilo/api-client/browser";

import {
  __mintAuthorizedHumanArtifactTestAuthorityForTesting,
  createAuthorizedHumanArtifactClient,
  createAuthorizedHumanArtifactViewerByteSource,
  type AuthorizedHumanArtifactDetailV1,
} from "../../src/client/artifact/authorized-human-artifact-client.ts";
import { FilePreparedArtifactCiphertextSidecar } from "../../src/client/artifact/file-prepared-artifact-ciphertext-sidecar.ts";
import { createPreparedArtifactMutationJournal } from "../../src/client/artifact/prepared-artifact-ciphertext-sidecar.ts";
import {
  createPreparedMutationJournal,
  type PreparedMutationJournalIndex,
  type PreparedMutationJournalVaultPort,
} from "../../src/client/memory/prepared-mutation-journal.ts";

const ARTIFACT = "82000000-0000-4000-8000-000000000201";
const ROW = "82000000-0000-4000-8000-000000000202";
const BLOB = "82000000-0000-4000-8000-000000000203";
const NS = "82000000-0000-4000-8000-000000000204";
const HASH = "A".repeat(43);

class MemoryJournalVault implements PreparedMutationJournalVaultPort {
  readonly records = new Map<string, Readonly<{
    index: PreparedMutationJournalIndex;
    bytes: Uint8Array;
  }>>();
  putSealed(input: Readonly<{ index: PreparedMutationJournalIndex; canonicalBody: Uint8Array }>) {
    if (this.records.has(input.index.operationId)) return Promise.resolve("exact_duplicate" as const);
    this.records.set(input.index.operationId, {
      index: input.index,
      bytes: input.canonicalBody.slice(),
    });
    return Promise.resolve("inserted" as const);
  }
  listIndexes() { return Promise.resolve([...this.records.values()].map(({ index }) => index)); }
  withOpenedBody<Result>(operationId: string, _digest: string,
    use: (body: Uint8Array) => Promise<Result> | Result): Promise<Result> {
    const value = this.records.get(operationId);
    if (value === undefined) throw new Error("missing");
    return Promise.resolve(use(value.bytes.slice()));
  }
  updateIndex(expected: PreparedMutationJournalIndex, replacement: PreparedMutationJournalIndex) {
    const value = this.records.get(expected.operationId);
    if (value === undefined || JSON.stringify(value.index) !== JSON.stringify(expected)) {
      return Promise.resolve(false);
    }
    this.records.set(expected.operationId, { index: replacement, bytes: value.bytes });
    return Promise.resolve(true);
  }
  removeExact(operationId: string, digest: string) {
    const value = this.records.get(operationId);
    if (value?.index.authenticatedRequestDigestBase64url !== digest) return Promise.resolve(false);
    this.records.delete(operationId);
    return Promise.resolve(true);
  }
}

function prepared(): ProtectedArtifactPreparedPublicationRequestV1 {
  return {
    requestVersion: 1, operationId: "artifact:create:client", planDigestBase64url: HASH,
    operation: "create", lifecycleAction: "activate", artifactRowId: ROW,
    artifactId: ARTIFACT, anchorNamespaceId: NS,
    cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
    expectedArtifactRevision: 0, nextArtifactRevision: 1,
    expectedCryptoAccessRevision: 0, resultCryptoAccessRevision: 0,
    expectedBlobGeneration: 0, resultBlobGeneration: 1, expectedBlobId: null,
    resultBlobId: BLOB, requiredNamespaceIds: [NS],
    encryptedControlPayloadBytesBase64url: "Y29udHJvbA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{ namespaceId: NS, envelopeBytesBase64url: "ZW52ZWxvcGU" }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    ciphertextLength: 4, ciphertextSha256Base64url: HASH,
    chunkPlaintextBytes: 1_048_576, chunkCount: 1,
    mimeClass: "document", sizeBucket: "le_64_kib",
  };
}

async function* ciphertext(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2, 3, 4]);
}

describe("authorized Human Artifact client", () => {
  test("persists record+sidecar before upload and recovers exact retry after response loss", async () => {
    const now = 1_900_000_000_000;
    const journalVault = new MemoryJournalVault();
    const journal = createPreparedMutationJournal({ vault: journalVault, now: () => now });
    const sidecars = new FilePreparedArtifactCiphertextSidecar(
      await mkdtemp(join(tmpdir(), "nautilo-artifact-authorized-")),
    );
    const custody = createPreparedArtifactMutationJournal({ journal, sidecars });
    let publications = 0;
    let uploads = 0;
    const client = createAuthorizedHumanArtifactClient({
      authority: __mintAuthorizedHumanArtifactTestAuthorityForTesting(),
      api: {
        listProtectedArtifacts: () => Promise.resolve({ dtoVersion: 1,
          status: "unavailable", reason: "authorization_required" }),
        getProtectedArtifact: () => Promise.resolve({ dtoVersion: 1,
          status: "unavailable", reason: "authorization_required" }),
        getProtectedArtifactCiphertextRange: () => Promise.resolve({ dtoVersion: 1,
          status: "unavailable", reason: "authorization_required" }),
        planProtectedArtifactAccess: () => Promise.resolve({ dtoVersion: 1,
          status: "unavailable", reason: "authorization_required" }),
        commitProtectedArtifactAccess: () => Promise.resolve({ dtoVersion: 1,
          status: "unavailable", reason: "authorization_required" }),
        planProtectedArtifactPublication: () => Promise.resolve({
          dtoVersion: 1, status: "planned", planVersion: 1,
          operationId: "artifact:create:client", planDigestBase64url: HASH,
          operation: "create", lifecycleAction: "activate", artifactRowId: ROW,
          artifactId: ARTIFACT, anchorNamespaceId: NS,
          cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
          expectedArtifactRevision: 0, nextArtifactRevision: 1,
          expectedCryptoAccessRevision: 0, resultCryptoAccessRevision: 0,
          expectedBlobGeneration: 0, resultBlobGeneration: 1, expectedBlobId: null,
          resultBlobId: BLOB, requiredNamespaceIds: [NS], bindings: [{ namespaceId: NS,
            domainId: "domain:1", expectedAccessRevision: 0, expectedPolicyRevision: 0,
            bindingHashBase64url: HASH }], maxPlaintextBytes: 100,
          maxCiphertextBytes: 1_000, chunkPlaintextBytes: 1_048_576,
          mimeClass: "document", sizeBucket: "le_64_kib", deadlineAt: now + 30_000,
        }),
        stageProtectedArtifactCiphertext: async (input) => {
          uploads += 1;
          const bytes: number[] = [];
          for await (const chunk of input.ciphertext) bytes.push(...chunk);
          expect(bytes).toEqual([1, 2, 3, 4]);
          return { dtoVersion: 1, status: uploads === 1 ? "staged" : "replayed",
            operationId: input.operationId, artifactId: input.artifactId,
            blobId: input.blobId, blobGeneration: input.blobGeneration,
            ciphertextLength: input.ciphertextLength,
            ciphertextSha256Base64url: input.ciphertextSha256Base64url };
        },
        publishProtectedArtifact: () => {
          publications += 1;
          if (publications === 1) return Promise.reject(new Error("response lost"));
          return Promise.resolve({ dtoVersion: 1, status: "replayed" as const,
            operationId: "artifact:create:client", artifactId: ARTIFACT,
            artifactRevision: 1, cryptoAccessRevision: 0, blobId: BLOB,
            blobGeneration: 1, requiredNamespaceIds: [NS] });
        },
      },
      content: {
        withOpenedControl: () => Promise.reject(new Error("unused")),
        withOpenedRange: () => Promise.reject(new Error("unused")),
        prepareControl: () => Promise.reject(new Error("unused")),
        prepareAccess: () => Promise.reject(new Error("unused")),
        prepareContent: async () => {
          const stagedCiphertext = await sidecars.stage({
            operationId: "artifact:create:client", artifactId: ARTIFACT,
            blobId: BLOB, blobGeneration: 1, ciphertext: ciphertext(),
          });
          return {
            prepared: {
              ...prepared(),
              ciphertextLength: stagedCiphertext.ciphertextLength,
              ciphertextSha256Base64url:
                stagedCiphertext.ciphertextSha256Base64url,
            },
            stagedCiphertext,
          };
        },
      },
      journal: custody,
    });
    expect(client.create({ anchorNamespaceId: NS, mimeClass: "document",
      sizeBucket: "le_64_kib", content: { logicalPath: "doc.txt",
        mimeType: "text/plain", plaintextLength: 1, plaintext: ciphertext() } }))
      .rejects.toThrow("response lost");
    expect((await custody.listStatus())[0]).toMatchObject({ state: "retryable" });
    expect(await client.retryPending(now + 5_000)).toBe(1);
    expect(await custody.listStatus()).toEqual([]);
    expect(await sidecars.list()).toEqual([]);
    expect({ uploads, publications }).toEqual({ uploads: 2, publications: 2 });
  });

  test("cannot be constructed from a forged serialized authority", () => {
    expect(() => createAuthorizedHumanArtifactClient({
      authority: Object.freeze({}) as never,
      api: {} as never,
      content: {} as never,
      journal: {} as never,
    })).toThrow("authority is invalid");
  });

  test("adapts callback-local plaintext to the bounded Workbench byte source", async () => {
    const detail: AuthorizedHumanArtifactDetailV1 = {
      artifactId: ARTIFACT,
      artifactRevision: 1,
      cryptoAccessRevision: 0,
      requiredNamespaceIds: [NS],
      logicalPath: "notes/readme.txt",
      mimeType: "text/plain",
      plaintextLength: 6,
      mimeClass: "text",
      sizeBucket: "le_64_kib",
      archived: false,
      canManageAccess: true,
    };
    const plaintext = new TextEncoder().encode("viewer");
    const source = createAuthorizedHumanArtifactViewerByteSource({
      detail: () => Promise.resolve(detail),
      withOpenedRange: async <Value>(request: Readonly<{
        artifactId: string;
        start: number;
        endExclusive: number;
        consume(bytes: Uint8Array, opened: AuthorizedHumanArtifactDetailV1):
          Value | PromiseLike<Value>;
      }>): Promise<Value> => request.consume(plaintext, detail),
    });

    const opened = new Uint8Array(await source({
      artifactId: ARTIFACT,
      maxBytes: 6,
    }));
    expect(new TextDecoder().decode(opened)).toBe("viewer");
    opened.fill(0);
    expect(new TextDecoder().decode(plaintext)).toBe("viewer");
    let limitError: unknown;
    try {
      await source({ artifactId: ARTIFACT, maxBytes: 5 });
    } catch (error) {
      limitError = error;
    }
    expect(limitError).toBeInstanceOf(RangeError);
    expect((limitError as Error).message).toContain("byte limit exceeded");
  });

  test("provisions one pending target Namespace, replans, journals, and commits access", async () => {
    const journal = createPreparedMutationJournal({ vault: new MemoryJournalVault(),
      now: () => 1_900_000_000_000 });
    const sidecars = new FilePreparedArtifactCiphertextSidecar(
      await mkdtemp(join(tmpdir(), "nautilo-artifact-access-")),
    );
    const custody = createPreparedArtifactMutationJournal({ journal, sidecars });
    let plans = 0;
    let provisions = 0;
    const request = {
      requestVersion: 1 as const, operationId: "artifact:access:1",
      artifactId: ARTIFACT, artifactRevision: 1,
      expectedCryptoAccessRevision: 0, nextCryptoAccessRevision: 1,
      cryptoObjectId: `artifact:v1:${"a".repeat(64)}`, blobId: BLOB,
      blobGeneration: 1, currentNamespaceIds: [NS], targetNamespaceIds: [NS],
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      signedAccessRequestBytesBase64url: "c2lnbmVk",
      namespaceEnvelopes: [{ namespaceId: NS,
        envelopeBytesBase64url: "ZW52ZWxvcGU" }],
    };
    const dto = { dtoVersion: 1 as const, status: "encrypted" as const,
      artifactId: ARTIFACT, artifactRevision: 1,
      cryptoObjectId: request.cryptoObjectId, cryptoAccessRevision: 0,
      requiredNamespaceIds: [NS], encryptedControlPayloadBytesBase64url: "YQ",
      accessManifestBytesBase64url: "Yg", accessManifestProofBytesBase64url: [],
      accessSignerEvidence: [],
      namespaceEnvelopes: request.namespaceEnvelopes, blobId: BLOB,
      blobGeneration: 1, ciphertextLength: 10, ciphertextSha256Base64url: HASH,
      chunkPlaintextBytes: 1_048_576 as const, chunkCount: 1,
      mimeClass: "document" as const, sizeBucket: "le_64_kib" as const,
      archived: false, canManageAccess: true };
    const client = createAuthorizedHumanArtifactClient({
      authority: __mintAuthorizedHumanArtifactTestAuthorityForTesting(),
      api: {
        listProtectedArtifacts: () => Promise.resolve({ dtoVersion: 1, items: [],
          nextCursor: null }),
        getProtectedArtifact: () => Promise.resolve(dto),
        getProtectedArtifactCiphertextRange: () => Promise.reject(new Error("unused")),
        planProtectedArtifactPublication: () => Promise.reject(new Error("unused")),
        stageProtectedArtifactCiphertext: () => Promise.reject(new Error("unused")),
        publishProtectedArtifact: () => Promise.reject(new Error("unused")),
        planProtectedArtifactAccess: () => {
          plans += 1;
          return plans === 1
            ? Promise.resolve({ dtoVersion: 1 as const, status: "unavailable" as const,
                reason: "target_encryption_not_ready" as const })
            : Promise.resolve({ dtoVersion: 1 as const, status: "planned" as const,
                planVersion: 1 as const, operationId: request.operationId,
                artifactId: ARTIFACT, artifactRevision: 1,
                expectedCryptoAccessRevision: 0, nextCryptoAccessRevision: 1,
                cryptoObjectId: request.cryptoObjectId, blobId: BLOB,
                blobGeneration: 1, currentNamespaceIds: [NS],
                targetNamespaceIds: [NS], addedNamespaceIds: [],
                removedNamespaceIds: [], currentBindings: [], targetBindings: [],
                sourceAuthorized: true as const, targetAuthorized: true as const,
                deadlineAt: 1_900_000_030_000 });
        },
        commitProtectedArtifactAccess: () => Promise.resolve({ dtoVersion: 1,
          status: "updated", operationId: request.operationId,
          artifactId: ARTIFACT, cryptoAccessRevision: 1,
          requiredNamespaceIds: [NS] }),
      },
      content: { withOpenedControl: () => Promise.reject(new Error("unused")),
        withOpenedRange: () => Promise.reject(new Error("unused")),
        prepareContent: () => Promise.reject(new Error("unused")),
        prepareControl: () => Promise.reject(new Error("unused")),
        prepareAccess: () => Promise.resolve({ request }) },
      journal: custody,
      accessNamespaceProvisioning: { provision: () => {
        provisions += 1;
        return Promise.resolve({ status: "ready" as const });
      } },
    });
    expect(await client.changeAccess({ artifactId: ARTIFACT,
      operation: { kind: "grant_user", userHandle: "bob" } })).toMatchObject({
      status: "updated", cryptoAccessRevision: 1,
    });
    expect({ plans, provisions }).toEqual({ plans: 2, provisions: 1 });
    expect(await custody.listStatus()).toEqual([]);
  });
});
