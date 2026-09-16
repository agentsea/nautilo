import { createWorkspaceBinaryArtifact } from "@nautilo/agent";
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

/**
 * The sole D568 import custody seam. Provider retrieval must finish while the
 * read checkpoint is active, pass bytes here, then discard its bearer URL.
 */
export async function importConnectedWebPrivateOutput(input: {
  readonly actor: ConnectedWebAccountReadToolActorContext;
  readonly output: ConnectedWebAccountPrivateOutput;
}): Promise<ConnectedWebAccountPrivateOutputReceipt | null> {
  const saved = await createWorkspaceBinaryArtifact({
    envelope: input.actor.memoryAccessEnvelope,
    actor: { kind: "agent", agentId: input.actor.agentId },
    logicalPath: input.output.logicalPath,
    bytes: input.output.bytes,
    mimeType: input.output.mimeType,
  });
  return saved.ok
    ? { artifactId: saved.artifactId, path: saved.displayPath, mime: input.output.mimeType }
    : null;
}
