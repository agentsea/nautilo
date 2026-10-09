import {
  createWorkspaceBinaryArtifact,
  type CreateWorkspaceBinaryArtifactResult,
} from "@nautilo/agent";
import type { ConnectedWebAccountReadToolActorContext } from "@nautilo/agent";

/** Server-only imported-output receipt. It intentionally has no provider URL or id. */
export type ConnectedWebAccountPrivateOutput = Readonly<{
  readonly logicalPath: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}>;

export type ConnectedWebAccountPrivateOutputReceipt = Readonly<{
  readonly artifactId: string;
  readonly path: string;
  readonly mime: string;
}>;

export type ConnectedWebAccountPrivateOutputPublication =
  | { readonly kind: "published"; readonly receipt: ConnectedWebAccountPrivateOutputReceipt }
  | { readonly kind: "retryable_failure" }
  | { readonly kind: "permanent_failure" }
  | { readonly kind: "unsafe_failure" };

type WorkspaceBinaryArtifactWriter = typeof createWorkspaceBinaryArtifact;

const PERMANENT_ARTIFACT_FAILURES = new Set(["FORBIDDEN", "INVALID_PATH", "CONFLICT", "EXISTS"]);
const RETRYABLE_ARTIFACT_FAILURES = new Set(["WRITE_FAILED"]);

function publicationFailure(
  saved: Extract<CreateWorkspaceBinaryArtifactResult, { readonly ok: false }>,
): Exclude<ConnectedWebAccountPrivateOutputPublication, { readonly kind: "published" }> {
  if (saved.retrySafe === false || saved.stateChanged === true) return { kind: "unsafe_failure" };
  if (PERMANENT_ARTIFACT_FAILURES.has(saved.code)) return { kind: "permanent_failure" };
  // The writer reports WRITE_FAILED only when atomic publication did not
  // commit. Every post-commit/metadata-unknown path is PARTIAL_WRITE above.
  if (RETRYABLE_ARTIFACT_FAILURES.has(saved.code)) return { kind: "retryable_failure" };
  // New writer failures are unknown until their mutation semantics are
  // classified explicitly; they cannot acquire automatic replay authority.
  return { kind: "unsafe_failure" };
}

/**
 * Keeps publication failure truth for the durable supervisor. Unknown partial
 * writes must never be replayed, while failures proven to leave no state may
 * be retried by the operation worker.
 */
export async function publishConnectedWebPrivateOutput(
  input: {
    readonly actor: ConnectedWebAccountReadToolActorContext;
    readonly output: ConnectedWebAccountPrivateOutput;
    /** Stable operation/output identity for crash-safe replay of publication. */
    readonly publicationId: string;
  },
  writer: WorkspaceBinaryArtifactWriter = createWorkspaceBinaryArtifact,
): Promise<ConnectedWebAccountPrivateOutputPublication> {
  let saved: CreateWorkspaceBinaryArtifactResult;
  try {
    saved = await writer({
      envelope: input.actor.memoryAccessEnvelope,
      actor: { kind: "agent", agentId: input.actor.agentId },
      logicalPath: input.output.logicalPath,
      bytes: input.output.bytes,
      mimeType: input.output.mimeType,
      clientMutationId: input.publicationId,
      overwrite: true,
    });
  } catch {
    // The writer catches its known pre-commit failures. An escaping exception
    // has unknown mutation truth and cannot authorize automatic replay.
    return { kind: "unsafe_failure" };
  }
  if (!saved.ok) return publicationFailure(saved);
  return {
    kind: "published",
    receipt: { artifactId: saved.artifactId, path: saved.displayPath, mime: input.output.mimeType },
  };
}

/**
 * The sole D568 import custody seam. Provider retrieval must finish while the
 * read checkpoint is active, pass bytes here, then discard its bearer URL.
 */
export async function importConnectedWebPrivateOutput(input: {
  readonly actor: ConnectedWebAccountReadToolActorContext;
  readonly output: ConnectedWebAccountPrivateOutput;
  /** Stable operation/output identity for crash-safe replay of publication. */
  readonly publicationId?: string;
}): Promise<ConnectedWebAccountPrivateOutputReceipt | null> {
  if (input.publicationId !== undefined) {
    const published = await publishConnectedWebPrivateOutput({ ...input, publicationId: input.publicationId });
    return published.kind === "published" ? published.receipt : null;
  }
  const saved = await createWorkspaceBinaryArtifact({
    envelope: input.actor.memoryAccessEnvelope,
    actor: { kind: "agent", agentId: input.actor.agentId },
    logicalPath: input.output.logicalPath,
    bytes: input.output.bytes,
    mimeType: input.output.mimeType,
  });
  return saved.ok ? { artifactId: saved.artifactId, path: saved.displayPath, mime: input.output.mimeType } : null;
}
