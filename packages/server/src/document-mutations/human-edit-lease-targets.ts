import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  findArtifactByInternalIdForNamespaces,
} from "@nautilo/db";
import type {
  DocumentIdentity,
  DocumentVersion,
  HumanEditLeaseCandidateTarget,
} from "@nautilo/types";
import {
  envelopeMutableNamespaces,
  envelopeReadableNamespaces,
  isScopeMemoryEnvelope,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";

export type ResolvedHumanEditLeaseTarget = {
  readonly identity: DocumentIdentity;
  readonly baseVersion: DocumentVersion;
  readonly bytes: Uint8Array;
};

export type ResolveHumanEditLeaseTargetResult =
  | { readonly ok: true; readonly target: ResolvedHumanEditLeaseTarget }
  | {
      readonly ok: false;
      readonly code: "forbidden" | "not_found";
    };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function storagePathFromUri(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  const candidate = storageUri.slice("file://".length);
  return candidate.startsWith("/") ? candidate : null;
}

/**
 * Resolves a workspace target only through the artifact route's existing
 * mutable/readable namespace distinction. Candidate artifact ids and paths
 * are correlation hints, never authority: the returned identity/version are
 * entirely derived from the authenticated envelope and database row.
 */
export async function resolveWorkspaceHumanEditLeaseTarget(input: {
  readonly envelope: MemoryAccessEnvelope;
  readonly candidate: Extract<HumanEditLeaseCandidateTarget, { kind: "workspace_artifact" }>;
}): Promise<ResolveHumanEditLeaseTargetResult> {
  if (isScopeMemoryEnvelope(input.envelope) || !input.envelope.agentId) {
    return { ok: false, code: "forbidden" };
  }

  const mutable = envelopeMutableNamespaces(input.envelope);
  const row = await findArtifactByInternalIdForNamespaces({
    internalId: input.candidate.artifactInternalId,
    readableNamespaceIds: mutable,
  });
  if (!row) {
    const readable = await findArtifactByInternalIdForNamespaces({
      internalId: input.candidate.artifactInternalId,
      readableNamespaceIds: envelopeReadableNamespaces(input.envelope),
    });
    return { ok: false, code: readable ? "forbidden" : "not_found" };
  }

  // The candidate path is correlation only. Requiring an exact match prevents
  // a stale UI target from acquiring a lease for a renamed row.
  if (row.path !== input.candidate.logicalPath) {
    return { ok: false, code: "not_found" };
  }
  const storagePath = storagePathFromUri(row.storageUri);
  if (!storagePath) return { ok: false, code: "not_found" };

  let bytes: Uint8Array;
  try {
    bytes = await readFile(storagePath);
  } catch {
    return { ok: false, code: "not_found" };
  }
  const sha256 = sha256Hex(bytes);
  const identity: DocumentIdentity = {
    kind: "workspace_artifact",
    artifactId: row.id,
    logicalPath: row.path,
  };
  return {
    ok: true,
    target: {
      identity,
      baseVersion: {
        identity,
        backendVersion: { kind: "artifact_revision", revision: row.revision },
        sha256,
      },
      bytes,
    },
  };
}
