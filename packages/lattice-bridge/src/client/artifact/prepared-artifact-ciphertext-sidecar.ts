import type { ProtectedArtifactPreparedPublicationRequestV1 } from "@nautilo/api-client/browser";

import {
  type PreparedHumanArtifactMutation,
  type PreparedHumanMutation,
  type PreparedMutationJournalIndex,
  inspectPreparedMutationCustodyFacts,
} from "../memory/prepared-mutation-journal.ts";

export const PREPARED_ARTIFACT_CIPHERTEXT_MAX_BYTES = 110_100_000;

export type PreparedArtifactCiphertextSidecarReference = Readonly<{
  formatVersion: 1;
  operationId: string;
  authenticatedRequestDigestBase64url: string;
  artifactId: string;
  blobId: string;
  blobGeneration: number;
  ciphertextLength: number;
  ciphertextSha256Base64url: string;
}>;

export type StagedArtifactCiphertextSidecarReference = Readonly<{
  formatVersion: 1;
  stageId: string;
  operationId: string;
  artifactId: string;
  blobId: string;
  blobGeneration: number;
  ciphertextLength: number;
  ciphertextSha256Base64url: string;
}>;

export interface PreparedArtifactCiphertextStagingPort {
  stage(input: Readonly<{
    operationId: string;
    artifactId: string;
    blobId: string;
    blobGeneration: number;
    ciphertext: AsyncIterable<Uint8Array>;
  }>): Promise<StagedArtifactCiphertextSidecarReference>;
  bind(input: Readonly<{
    staged: StagedArtifactCiphertextSidecarReference;
    reference: PreparedArtifactCiphertextSidecarReference;
  }>): Promise<"inserted" | "exact_duplicate" | "collision">;
  removeStagedExact(staged: StagedArtifactCiphertextSidecarReference): Promise<boolean>;
}

export interface PreparedArtifactCiphertextSidecarPort {
  put(input: Readonly<{
    reference: PreparedArtifactCiphertextSidecarReference;
    ciphertext: AsyncIterable<Uint8Array>;
  }>): Promise<"inserted" | "exact_duplicate" | "collision">;
  list(): Promise<readonly PreparedArtifactCiphertextSidecarReference[]>;
  withOpened<Result>(
    reference: PreparedArtifactCiphertextSidecarReference,
    use: (ciphertext: AsyncIterable<Uint8Array>) => Promise<Result> | Result,
  ): Promise<Result>;
  removeExact(reference: PreparedArtifactCiphertextSidecarReference): Promise<boolean>;
}

export interface PreparedArtifactMutationJournalPort {
  putBeforeSend(mutation: PreparedHumanArtifactMutation): Promise<Readonly<{
    status: "inserted" | "duplicate";
    index: PreparedMutationJournalIndex;
  }>>;
  listStatus(): Promise<readonly PreparedMutationJournalIndex[]>;
  withPrepared<Result>(
    operationId: string,
    use: (mutation: PreparedHumanMutation) => Promise<Result> | Result,
  ): Promise<Result>;
  recordOutcome(input: Readonly<{
    operationId: string;
    authenticatedRequestDigestBase64url: string;
    outcome: "completed" | "retryable" | "stale" | "denied" | "integrity" | "expired" | "collision";
  }>): Promise<void>;
}

function requiresSidecar(
  mutation: PreparedHumanArtifactMutation,
): boolean {
  return mutation.kind === "artifact_create" || mutation.kind === "artifact_content";
}

function reference(
  mutation: PreparedHumanArtifactMutation,
): PreparedArtifactCiphertextSidecarReference {
  if (mutation.kind === "artifact_access") {
    throw new TypeError("Artifact access mutation has no ciphertext sidecar");
  }
  const facts = inspectPreparedMutationCustodyFacts(mutation);
  const request: ProtectedArtifactPreparedPublicationRequestV1 = mutation.request;
  return Object.freeze({
    formatVersion: 1,
    operationId: facts.operationId,
    authenticatedRequestDigestBase64url:
      facts.authenticatedRequestDigestBase64url,
    artifactId: mutation.artifactId,
    blobId: request.resultBlobId,
    blobGeneration: request.resultBlobGeneration,
    ciphertextLength: request.ciphertextLength,
    ciphertextSha256Base64url: request.ciphertextSha256Base64url,
  });
}

function sameReference(
  left: PreparedArtifactCiphertextSidecarReference,
  right: PreparedArtifactCiphertextSidecarReference,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createPreparedArtifactMutationJournal(input: Readonly<{
  journal: PreparedArtifactMutationJournalPort;
  sidecars: PreparedArtifactCiphertextSidecarPort;
}>) {
  return Object.freeze({
    listStatus: () => input.journal.listStatus(),
    async putBeforeSend(
      mutation: PreparedHumanArtifactMutation,
      ciphertext?: AsyncIterable<Uint8Array> | StagedArtifactCiphertextSidecarReference,
    ) {
      const facts = inspectPreparedMutationCustodyFacts(mutation);
      const sidecarReference = requiresSidecar(mutation)
        ? reference(mutation)
        : undefined;
      if (requiresSidecar(mutation) !== (ciphertext !== undefined)) {
        throw new TypeError(
          requiresSidecar(mutation)
            ? "Artifact content publication requires ciphertext custody"
            : "Artifact control publication must not provide ciphertext",
        );
      }
      let sidecarInserted = false;
      if (ciphertext !== undefined && sidecarReference !== undefined) {
        const result = Symbol.asyncIterator in Object(ciphertext)
          ? await input.sidecars.put({
              reference: sidecarReference,
              ciphertext: ciphertext as AsyncIterable<Uint8Array>,
            })
          : await (input.sidecars as PreparedArtifactCiphertextSidecarPort
              & PreparedArtifactCiphertextStagingPort).bind({
              staged: ciphertext as StagedArtifactCiphertextSidecarReference,
              reference: sidecarReference,
            });
        if (result === "collision") throw new Error(
          "Prepared Artifact ciphertext operation collided",
        );
        sidecarInserted = result === "inserted";
      }
      try {
        const custody = await input.journal.putBeforeSend(mutation);
        if (
          custody.index.authenticatedRequestDigestBase64url
            !== facts.authenticatedRequestDigestBase64url
        ) throw new Error("Prepared Artifact custody digest disagrees");
        return Object.freeze({ ...custody,
          ...(sidecarReference === undefined ? {} : { sidecarReference }) });
      } catch (cause) {
        if (sidecarInserted && sidecarReference !== undefined) {
          await input.sidecars.removeExact(sidecarReference);
        }
        throw cause;
      }
    },
    async withPrepared<Result>(
      operationId: string,
      use: (input: Readonly<{
        mutation: PreparedHumanArtifactMutation;
        ciphertext?: AsyncIterable<Uint8Array>;
      }>) => Promise<Result> | Result,
    ): Promise<Result> {
      return input.journal.withPrepared(operationId, async (mutation) => {
        if (!mutation.kind.startsWith("artifact_")) {
          throw new TypeError("Prepared Artifact journal returned a non-Artifact mutation");
        }
        const artifactMutation = mutation as PreparedHumanArtifactMutation;
        if (!requiresSidecar(artifactMutation)) return use({ mutation: artifactMutation });
        const sidecarReference = reference(artifactMutation);
        return input.sidecars.withOpened(sidecarReference, (ciphertext) =>
          use({ mutation: artifactMutation, ciphertext })
        );
      });
    },
    async recordOutcome(outcome: Parameters<PreparedArtifactMutationJournalPort["recordOutcome"]>[0]) {
      let sidecarReference: PreparedArtifactCiphertextSidecarReference | undefined;
      if (outcome.outcome === "completed") {
        await input.journal.withPrepared(outcome.operationId, (mutation) => {
          if (!mutation.kind.startsWith("artifact_")) {
            throw new TypeError("Prepared Artifact journal returned a non-Artifact mutation");
          }
          const artifactMutation = mutation as PreparedHumanArtifactMutation;
          if (requiresSidecar(artifactMutation)) sidecarReference = reference(artifactMutation);
        });
      }
      await input.journal.recordOutcome(outcome);
      if (sidecarReference !== undefined) {
        await input.sidecars.removeExact(sidecarReference);
      }
    },
    async reconcileOrphans(): Promise<number> {
      const live = new Map((await input.journal.listStatus()).map((entry) => [
        entry.operationId,
        entry.authenticatedRequestDigestBase64url,
      ]));
      let removed = 0;
      for (const sidecar of await input.sidecars.list()) {
        if (live.get(sidecar.operationId) !== sidecar.authenticatedRequestDigestBase64url) {
          if (await input.sidecars.removeExact(sidecar)) removed += 1;
        }
      }
      return removed;
    },
    reference,
  });
}

export function assertPreparedArtifactCiphertextSidecarReference(
  value: PreparedArtifactCiphertextSidecarReference,
): void {
  if (
    value.formatVersion !== 1
    || value.operationId.length === 0
    || value.operationId.length > 128
    || value.authenticatedRequestDigestBase64url.length !== 43
    || value.artifactId.length === 0
    || value.blobId.length === 0
    || !Number.isSafeInteger(value.blobGeneration)
    || value.blobGeneration < 1
    || !Number.isSafeInteger(value.ciphertextLength)
    || value.ciphertextLength < 1
    || value.ciphertextLength > PREPARED_ARTIFACT_CIPHERTEXT_MAX_BYTES
    || value.ciphertextSha256Base64url.length !== 43
  ) throw new TypeError("Prepared Artifact ciphertext sidecar reference is invalid");
}

export { sameReference as preparedArtifactCiphertextSidecarReferencesEqual };
