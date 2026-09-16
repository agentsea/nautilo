import type {
  NautiloApiClient,
  ProtectedArtifactCiphertextRangeV1,
  ProtectedArtifactDtoV1,
  ProtectedArtifactListResponseV1,
  ProtectedArtifactMimeClassV1,
  ProtectedArtifactPublicationResponseV1,
  ProtectedArtifactSizeBucketV1,
  ProtectedArtifactUnavailableResponseV1,
  ProtectedArtifactAccessUpdateResponseV1,
  ProtectedArtifactAccessOperationV1,
  ProtectedArtifactAccessPlanResponseV1,
  ProtectedArtifactPreparedAccessRequestV1,
  ProtectedArtifactPreparedPublicationRequestV1,
} from "@nautilo/api-client/browser";
import type { ArtifactControl } from "@nautilo/lattice-crypto";
import { artifactSizeBucketForPlaintextLength } from "../../artifact/artifact-repository.ts";

import type {
  PreparedHumanArtifactMutation,
  PreparedMutationJournalIndex,
} from "../memory/prepared-mutation-journal.ts";
import type {
  PreparedArtifactCiphertextSidecarReference,
} from "./prepared-artifact-ciphertext-sidecar.ts";
import type {
  AuthorizedHumanArtifactContentIntentV1,
  PreparedHumanArtifactContentPublicationV1,
} from "./vault-human-artifact-device-content.ts";

type ArtifactApi = Pick<NautiloApiClient,
  | "listProtectedArtifacts"
  | "getProtectedArtifact"
  | "getProtectedArtifactCiphertextRange"
  | "planProtectedArtifactAccess"
  | "commitProtectedArtifactAccess"
  | "planProtectedArtifactPublication"
  | "stageProtectedArtifactCiphertext"
  | "publishProtectedArtifact"
>;

export class AuthorizedHumanArtifactUnavailableError extends Error {
  override readonly name = "AuthorizedHumanArtifactUnavailableError";
  constructor(readonly reason: ProtectedArtifactUnavailableResponseV1["reason"]) {
    super(`Protected Human Artifact is unavailable (${reason})`);
  }
}

export interface AuthorizedHumanArtifactContentPort {
  withOpenedControl<Value>(input: Readonly<{
    dto: ProtectedArtifactDtoV1;
    consume(control: ArtifactControl): Value | PromiseLike<Value>;
  }>): Promise<Value>;
  withOpenedRange<Value>(input: Readonly<{
    dto: ProtectedArtifactDtoV1;
    range: ProtectedArtifactCiphertextRangeV1;
    start: number;
    endExclusive: number;
    consume(plaintext: Uint8Array, control: ArtifactControl): Value | PromiseLike<Value>;
  }>): Promise<Value>;
  prepareContent(input: Readonly<{
    plan: Extract<Awaited<ReturnType<ArtifactApi["planProtectedArtifactPublication"]>>,
      { status: "planned" }>;
    intent: AuthorizedHumanArtifactContentIntentV1;
  }>): Promise<PreparedHumanArtifactContentPublicationV1>;
  prepareControl(input: Readonly<{
    current: ProtectedArtifactDtoV1;
    plan: Extract<Awaited<ReturnType<ArtifactApi["planProtectedArtifactPublication"]>>,
      { status: "planned" }>;
    logicalPath?: string;
    mimeType?: string;
  }>): Promise<import("@nautilo/api-client/browser").ProtectedArtifactPreparedPublicationRequestV1>;
  prepareAccess(input: Readonly<{
    current: ProtectedArtifactDtoV1;
    plan: Extract<ProtectedArtifactAccessPlanResponseV1, { status: "planned" }>;
  }>): Promise<Readonly<{ request: ProtectedArtifactPreparedAccessRequestV1 }>>;
}

export interface AuthorizedHumanArtifactMutationJournal {
  putBeforeSend(
    mutation: PreparedHumanArtifactMutation,
    ciphertext?: PreparedHumanArtifactContentPublicationV1["stagedCiphertext"],
  ): Promise<Readonly<{
    status: "inserted" | "duplicate";
    index: PreparedMutationJournalIndex;
    sidecarReference?: PreparedArtifactCiphertextSidecarReference;
  }>>;
  listStatus(): Promise<readonly PreparedMutationJournalIndex[]>;
  withPrepared<Result>(
    operationId: string,
    use: (input: Readonly<{
      mutation: PreparedHumanArtifactMutation;
      ciphertext?: AsyncIterable<Uint8Array>;
    }>) => Promise<Result> | Result,
  ): Promise<Result>;
  recordOutcome(input: Readonly<{
    operationId: string;
    authenticatedRequestDigestBase64url: string;
    outcome: "completed" | "retryable" | "stale" | "denied" | "integrity" | "expired" | "collision";
  }>): Promise<void>;
}

export type AuthorizedHumanArtifactTestAuthority = Readonly<{
  readonly __authorizedHumanArtifactTestAuthority: unique symbol;
}>;
const authorities = new WeakSet<object>();

export interface AuthorizedHumanArtifactDetailV1 {
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly cryptoAccessRevision: number;
  readonly requiredNamespaceIds: readonly string[];
  readonly logicalPath: string;
  readonly mimeType: string;
  readonly plaintextLength: number;
  readonly mimeClass: ProtectedArtifactMimeClassV1;
  readonly sizeBucket: ProtectedArtifactSizeBucketV1;
  readonly archived: boolean;
  readonly canManageAccess: boolean;
}

export interface AuthorizedHumanArtifactViewerByteSourceInput {
  readonly artifactId: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

function unavailableOutcome(
  reason: ProtectedArtifactUnavailableResponseV1["reason"],
): "retryable" | "stale" | "denied" | "integrity" {
  switch (reason) {
    case "authorization_required": return "denied";
    case "integrity_failure": return "integrity";
    case "stale_revision": return "stale";
    case "target_encryption_not_ready":
    case "encryption_pending":
    case "storage_unavailable":
    case "journal_full":
      return "retryable";
  }
}

function publicationMatches(
  response: ProtectedArtifactPublicationResponseV1,
  artifactId: string,
  request: ProtectedArtifactPreparedPublicationRequestV1,
): boolean {
  return response.operationId === request.operationId
    && response.artifactId === artifactId
    && response.artifactRevision === request.nextArtifactRevision
    && response.cryptoAccessRevision === request.resultCryptoAccessRevision
    && response.blobId === request.resultBlobId
    && response.blobGeneration === request.resultBlobGeneration
    && response.requiredNamespaceIds.length === request.requiredNamespaceIds.length
    && response.requiredNamespaceIds.every((id, index) =>
      id === request.requiredNamespaceIds[index]
    );
}

export function createAuthorizedHumanArtifactClient(input: Readonly<{
  authority: AuthorizedHumanArtifactTestAuthority;
  api: ArtifactApi;
  content: AuthorizedHumanArtifactContentPort;
  journal: AuthorizedHumanArtifactMutationJournal;
  accessNamespaceProvisioning?: Readonly<{
    provision(request: Readonly<{
      artifactId: string;
      operation: ProtectedArtifactAccessOperationV1;
    }>): Promise<Readonly<{ status: "not_required" | "ready" }>
      | Readonly<{ status: "unavailable"; reason: "authorization_required" | "target_encryption_not_ready" }>>;
  }>;
}>) {
  if (!authorities.has(input.authority)) {
    throw new TypeError("Protected Human Artifact test authority is invalid");
  }

  const send = async (
    mutation: PreparedHumanArtifactMutation,
    ciphertext: AsyncIterable<Uint8Array> | undefined,
  ): Promise<ProtectedArtifactPublicationResponseV1 | ProtectedArtifactAccessUpdateResponseV1> => {
    if (mutation.kind === "artifact_access") {
      if (ciphertext !== undefined) {
        throw new TypeError("Prepared Artifact access must not have ciphertext");
      }
      const response = await input.api.commitProtectedArtifactAccess(
        mutation.artifactId,
        mutation.request,
      );
      if (response.status === "unavailable") {
        throw new AuthorizedHumanArtifactUnavailableError(response.reason);
      }
      if (
        response.operationId !== mutation.request.operationId
        || response.artifactId !== mutation.artifactId
        || response.cryptoAccessRevision
          !== mutation.request.nextCryptoAccessRevision
      ) throw new TypeError("Protected Human Artifact access was substituted");
      return response;
    }
    if (mutation.kind !== "artifact_control") {
      if (ciphertext === undefined) {
        throw new Error("Prepared Artifact ciphertext custody is unavailable");
      }
      await input.api.stageProtectedArtifactCiphertext({
        artifactId: mutation.artifactId,
        operationId: mutation.request.operationId,
        blobId: mutation.request.resultBlobId,
        blobGeneration: mutation.request.resultBlobGeneration,
        ciphertextLength: mutation.request.ciphertextLength,
        ciphertextSha256Base64url:
          mutation.request.ciphertextSha256Base64url,
        ciphertext,
      });
    }
    const response = await input.api.publishProtectedArtifact(mutation.request);
    if (response.status === "unavailable") {
      throw new AuthorizedHumanArtifactUnavailableError(response.reason);
    }
    if (!publicationMatches(response, mutation.artifactId, mutation.request)) {
      throw new TypeError("Protected Human Artifact publication was substituted");
    }
    return response;
  };

  const attempt = async (
    index: Pick<PreparedMutationJournalIndex,
      "operationId" | "authenticatedRequestDigestBase64url">,
  ): Promise<ProtectedArtifactPublicationResponseV1 | ProtectedArtifactAccessUpdateResponseV1> => {
    try {
      const response = await input.journal.withPrepared(
        index.operationId,
        ({ mutation, ciphertext }) => send(mutation, ciphertext),
      );
      await input.journal.recordOutcome({
        operationId: index.operationId,
        authenticatedRequestDigestBase64url:
          index.authenticatedRequestDigestBase64url,
        outcome: "completed",
      });
      return response;
    } catch (error) {
      await input.journal.recordOutcome({
        operationId: index.operationId,
        authenticatedRequestDigestBase64url:
          index.authenticatedRequestDigestBase64url,
        outcome: error instanceof AuthorizedHumanArtifactUnavailableError
          ? unavailableOutcome(error.reason)
          : error instanceof TypeError ? "integrity" : "retryable",
      });
      throw error;
    }
  };

  const retry = (index: PreparedMutationJournalIndex) => attempt(index);

  const current = async (artifactId: string): Promise<ProtectedArtifactDtoV1> => {
    const dto = await input.api.getProtectedArtifact(artifactId);
    if (dto.status === "unavailable") {
      throw new AuthorizedHumanArtifactUnavailableError(dto.reason);
    }
    return dto;
  };

  const describe = (dto: ProtectedArtifactDtoV1) =>
    input.content.withOpenedControl({
      dto,
      consume: (control): AuthorizedHumanArtifactDetailV1 => Object.freeze({
        artifactId: dto.artifactId,
        artifactRevision: dto.artifactRevision,
        cryptoAccessRevision: dto.cryptoAccessRevision,
        requiredNamespaceIds: Object.freeze([...dto.requiredNamespaceIds]),
        logicalPath: control.logicalPath,
        mimeType: control.mimeType,
        plaintextLength: control.plaintextLength,
        mimeClass: dto.mimeClass,
        sizeBucket: dto.sizeBucket,
        archived: dto.archived,
        canManageAccess: dto.canManageAccess,
      }),
    });

  const publishMutation = async (
    mutation: PreparedHumanArtifactMutation,
    ciphertext?: PreparedHumanArtifactContentPublicationV1["stagedCiphertext"],
  ) => {
    const custody = await input.journal.putBeforeSend(mutation, ciphertext);
    return attempt(custody.index);
  };

  const reviseControl = async (request: Readonly<{
    artifactId: string;
    lifecycleAction: "activate" | "archive";
    logicalPath?: string;
    mimeType?: string;
    mimeClass?: ProtectedArtifactMimeClassV1;
  }>) => {
    const dto = await current(request.artifactId);
    const plan = await input.api.planProtectedArtifactPublication({
      requestVersion: 1,
      operation: "revise_control",
      lifecycleAction: request.lifecycleAction,
      artifactId: dto.artifactId,
      anchorNamespaceId: dto.requiredNamespaceIds[0]!,
      expectedArtifactRevision: dto.artifactRevision,
      expectedCryptoAccessRevision: dto.cryptoAccessRevision,
      expectedBlobGeneration: dto.blobGeneration,
      expectedBlobId: dto.blobId,
      mimeClass: request.mimeClass ?? dto.mimeClass,
      sizeBucket: dto.sizeBucket,
    });
    if (plan.status === "unavailable") {
      throw new AuthorizedHumanArtifactUnavailableError(plan.reason);
    }
    const prepared = await input.content.prepareControl({
      current: dto,
      plan,
      ...(request.logicalPath === undefined ? {} : { logicalPath: request.logicalPath }),
      ...(request.mimeType === undefined ? {} : { mimeType: request.mimeType }),
    });
    return publishMutation(Object.freeze({
      kind: "artifact_control" as const,
      artifactId: dto.artifactId,
      request: prepared,
    }));
  };

  return Object.freeze({
    async list(options?: Readonly<{
      cursor?: string;
      limit?: number;
      includeArchive?: boolean;
    }>): Promise<Readonly<{
      items: readonly AuthorizedHumanArtifactDetailV1[];
      nextCursor: string | null;
    }>> {
      const response: ProtectedArtifactListResponseV1
        | ProtectedArtifactUnavailableResponseV1 =
          await input.api.listProtectedArtifacts(options);
      if ("reason" in response) {
        throw new AuthorizedHumanArtifactUnavailableError(response.reason);
      }
      const items: AuthorizedHumanArtifactDetailV1[] = [];
      for (const dto of response.items) items.push(await describe(dto));
      return Object.freeze({ items: Object.freeze(items),
        nextCursor: response.nextCursor });
    },

    async detail(artifactId: string): Promise<AuthorizedHumanArtifactDetailV1> {
      return describe(await current(artifactId));
    },

    async withOpenedRange<Value>(request: Readonly<{
      artifactId: string;
      start: number;
      endExclusive: number;
      consume(plaintext: Uint8Array, detail: AuthorizedHumanArtifactDetailV1):
        Value | PromiseLike<Value>;
    }>): Promise<Value> {
      const dto = await current(request.artifactId);
      const range = await input.api.getProtectedArtifactCiphertextRange(
        request.artifactId,
        { start: request.start, endExclusive: request.endExclusive },
      );
      if (range.status === "unavailable") {
        throw new AuthorizedHumanArtifactUnavailableError(range.reason);
      }
      return input.content.withOpenedRange({
        dto,
        range,
        start: request.start,
        endExclusive: request.endExclusive,
        consume: (plaintext, control) => request.consume(plaintext, Object.freeze({
          artifactId: dto.artifactId,
          artifactRevision: dto.artifactRevision,
          cryptoAccessRevision: dto.cryptoAccessRevision,
          requiredNamespaceIds: Object.freeze([...dto.requiredNamespaceIds]),
          logicalPath: control.logicalPath,
          mimeType: control.mimeType,
          plaintextLength: control.plaintextLength,
          mimeClass: dto.mimeClass,
          sizeBucket: dto.sizeBucket,
          archived: dto.archived,
          canManageAccess: dto.canManageAccess,
        })),
      });
    },

    async create(request: Readonly<{
      anchorNamespaceId: string;
      mimeClass: ProtectedArtifactMimeClassV1;
      sizeBucket: ProtectedArtifactSizeBucketV1;
      content: AuthorizedHumanArtifactContentIntentV1;
    }>): Promise<Readonly<{
      status: "published" | "replayed";
      artifactId: string;
    }>> {
      const plan = await input.api.planProtectedArtifactPublication({
        requestVersion: 1,
        operation: "create",
        lifecycleAction: "activate",
        artifactId: null,
        anchorNamespaceId: request.anchorNamespaceId,
        expectedArtifactRevision: 0,
        expectedCryptoAccessRevision: 0,
        expectedBlobGeneration: 0,
        expectedBlobId: null,
        mimeClass: request.mimeClass,
        sizeBucket: request.sizeBucket,
      });
      if (plan.status === "unavailable") {
        throw new AuthorizedHumanArtifactUnavailableError(plan.reason);
      }
      const prepared = await input.content.prepareContent({
        plan,
        intent: request.content,
      });
      const mutation: PreparedHumanArtifactMutation = Object.freeze({
        kind: "artifact_create",
        artifactId: plan.artifactId,
        request: prepared.prepared,
      });
      const custody = await input.journal.putBeforeSend(
        mutation,
        prepared.stagedCiphertext,
      );
      const response = await attempt(custody.index);
      if (!("blobId" in response)) {
        throw new TypeError("Protected Artifact create returned access receipt");
      }
      return Object.freeze({ status: response.status, artifactId: response.artifactId });
    },

    async replaceContent(request: Readonly<{
      artifactId: string;
      mimeClass: ProtectedArtifactMimeClassV1;
      content: AuthorizedHumanArtifactContentIntentV1;
    }>) {
      const dto = await current(request.artifactId);
      const plan = await input.api.planProtectedArtifactPublication({
        requestVersion: 1,
        operation: "replace_content",
        lifecycleAction: "activate",
        artifactId: dto.artifactId,
        anchorNamespaceId: dto.requiredNamespaceIds[0]!,
        expectedArtifactRevision: dto.artifactRevision,
        expectedCryptoAccessRevision: dto.cryptoAccessRevision,
        expectedBlobGeneration: dto.blobGeneration,
        expectedBlobId: dto.blobId,
        mimeClass: request.mimeClass,
        sizeBucket: artifactSizeBucketForPlaintextLength(
          request.content.plaintextLength,
        ),
      });
      if (plan.status === "unavailable") {
        throw new AuthorizedHumanArtifactUnavailableError(plan.reason);
      }
      const prepared = await input.content.prepareContent({
        plan,
        intent: request.content,
      });
      return publishMutation(Object.freeze({
        kind: "artifact_content" as const,
        artifactId: dto.artifactId,
        request: prepared.prepared,
      }), prepared.stagedCiphertext);
    },

    rename(request: Readonly<{
      artifactId: string;
      logicalPath: string;
      mimeType?: string;
      mimeClass?: ProtectedArtifactMimeClassV1;
    }>) {
      return reviseControl({ ...request, lifecycleAction: "activate" });
    },

    archive(artifactId: string) {
      return reviseControl({ artifactId, lifecycleAction: "archive" });
    },

    async changeAccess(request: Readonly<{
      artifactId: string;
      operation: ProtectedArtifactAccessOperationV1;
    }>): Promise<Readonly<{
      status: "unchanged" | "updated" | "replayed";
      artifactId: string;
      cryptoAccessRevision: number;
      requiredNamespaceIds: readonly string[];
    }>> {
      const dto = await current(request.artifactId);
      let plan = await input.api.planProtectedArtifactAccess(
        request.artifactId,
        { requestVersion: 1, operation: request.operation },
      );
      if (
        plan.status === "unavailable"
        && plan.reason === "target_encryption_not_ready"
        && input.accessNamespaceProvisioning !== undefined
      ) {
        const provisioned = await input.accessNamespaceProvisioning.provision(request);
        if (provisioned.status === "unavailable") {
          throw new AuthorizedHumanArtifactUnavailableError(provisioned.reason);
        }
        plan = await input.api.planProtectedArtifactAccess(
          request.artifactId,
          { requestVersion: 1, operation: request.operation },
        );
      }
      if (plan.status === "unavailable") {
        throw new AuthorizedHumanArtifactUnavailableError(plan.reason);
      }
      if (plan.status === "unchanged") {
        return Object.freeze({
          status: "unchanged" as const,
          artifactId: plan.artifactId,
          cryptoAccessRevision: plan.cryptoAccessRevision,
          requiredNamespaceIds: Object.freeze([...plan.requiredNamespaceIds]),
        });
      }
      const prepared = await input.content.prepareAccess({ current: dto, plan });
      const response = await publishMutation(Object.freeze({
        kind: "artifact_access" as const,
        artifactId: dto.artifactId,
        request: prepared.request,
      }));
      if ("blobId" in response) {
        throw new TypeError("Protected Artifact access returned publication receipt");
      }
      return Object.freeze({
        status: response.status,
        artifactId: response.artifactId,
        cryptoAccessRevision: response.cryptoAccessRevision,
        requiredNamespaceIds: Object.freeze([...response.requiredNamespaceIds]),
      });
    },

    async retryPending(now = Date.now()): Promise<number> {
      const due = (await input.journal.listStatus()).filter((entry) =>
        entry.kind.startsWith("artifact_")
        && (entry.state === "pending" || entry.state === "retryable")
        && entry.nextAttemptAt <= now
      ).slice(0, 4);
      let completed = 0;
      for (const entry of due) {
        try {
          await retry(entry);
          completed += 1;
        } catch {
          // Exact retry/terminal state was recorded by send().
        }
      }
      return completed;
    },
  });
}

export type AuthorizedHumanArtifactClient = ReturnType<
  typeof createAuthorizedHumanArtifactClient
>;

/**
 * Adapts the callback-scoped protected opener to Workbench's explicitly
 * injected bounded viewer ingress. The ordinary Workbench never constructs
 * this source, so importing either package does not activate protected reads.
 */
export function createAuthorizedHumanArtifactViewerByteSource(
  client: Pick<AuthorizedHumanArtifactClient, "detail" | "withOpenedRange">,
): (input: AuthorizedHumanArtifactViewerByteSourceInput) => Promise<ArrayBuffer> {
  return async (input) => {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new RangeError("Artifact viewer byte limit is invalid");
    }
    if (input.signal?.aborted) {
      throw new DOMException("Artifact viewer read was cancelled", "AbortError");
    }
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw new DOMException("Artifact viewer read timed out", "TimeoutError");
    }
    const detail = await client.detail(input.artifactId);
    if (detail.plaintextLength > input.maxBytes) {
      throw new RangeError("Artifact viewer byte limit exceeded");
    }
    return client.withOpenedRange({
      artifactId: input.artifactId,
      start: 0,
      endExclusive: detail.plaintextLength,
      consume(plaintext) {
        if (input.signal?.aborted) {
          throw new DOMException("Artifact viewer read was cancelled", "AbortError");
        }
        if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
          throw new DOMException("Artifact viewer read timed out", "TimeoutError");
        }
        if (plaintext.byteLength !== detail.plaintextLength) {
          throw new TypeError("Protected Artifact viewer bytes were substituted");
        }
        const owned = new Uint8Array(plaintext.byteLength);
        owned.set(plaintext);
        return owned.buffer;
      },
    });
  };
}

/** Direct-source test/developer authority; not exported from package barrels. */
export function __mintAuthorizedHumanArtifactTestAuthorityForTesting():
AuthorizedHumanArtifactTestAuthority {
  const authority = Object.freeze({}) as AuthorizedHumanArtifactTestAuthority;
  authorities.add(authority);
  return authority;
}
