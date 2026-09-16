import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  findArtifactByInternalIdForNamespaces,
  type Artifact,
} from "@nautilo/db";
import { envelopeMutableNamespaces } from "@nautilo/trust";
import {
  saveWorkspaceEditorSnapshot,
  type WorkspaceEditorSnapshotSaveResult,
} from "../document-mutations/workspace-editor-save-service";
import { requestWorkspaceDocumentMutationOutboxPump } from
  "../document-mutations/workspace-document-mutation-runtime";
import type { LiveArtifactProposalAcceptancePort } from "./app-routes";
import { verifyAcceptedLiveReviewContent } from "./live-review-accepted-content";
import { getLiveReviewExtension } from "./live-review-extension-registry";

type LiveArtifactAcceptanceDependencies = {
  findArtifact?: typeof findArtifactByInternalIdForNamespaces;
  readCanonicalContent?: (artifact: Artifact) => Promise<string>;
  saveSnapshot?: typeof saveWorkspaceEditorSnapshot;
  onCommitted?: () => void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable D448 correlation shared by pre-write reservation and canonical save. */
export function createLiveArtifactProposalClientMutationId(input: {
  artifactInternalId: string;
  sessionId: string;
  proposalId: string;
  requestId: string;
}): string {
  return `live-review:${sha256(JSON.stringify([
    input.artifactInternalId,
    input.sessionId,
    input.proposalId,
    input.requestId,
  ]))}`;
}

async function readCanonicalArtifactContent(artifact: Artifact): Promise<string> {
  if (!artifact.storageUri.startsWith("file://")) {
    throw new Error("unsupported Workspace Artifact storage URI");
  }
  return readFile(fileURLToPath(artifact.storageUri), "utf8");
}

function publicSaveFailure(result: Exclude<WorkspaceEditorSnapshotSaveResult, { ok: true }>) {
  switch (result.code) {
    case "conflict":
      return "stale_version";
    case "not_found":
    case "forbidden":
      return "local_target_forbidden";
    case "too_large":
      return "acceptance_conflict";
    case "recovery_required":
    case "error":
    default:
      return "relay_unavailable";
  }
}

/**
 * Compose live Writer acceptance onto the existing Workspace editor save
 * service. This is an adapter, not a second document writer: the established
 * mutation coordinator remains the sole owner of locking, revision checks,
 * durable idempotency receipts, history, and outbox publication.
 */
export function createLiveArtifactProposalAcceptance(
  deps: LiveArtifactAcceptanceDependencies = {},
): LiveArtifactProposalAcceptancePort {
  const findArtifact = deps.findArtifact ?? findArtifactByInternalIdForNamespaces;
  const readCanonicalContent = deps.readCanonicalContent ?? readCanonicalArtifactContent;
  const saveSnapshot = deps.saveSnapshot ?? saveWorkspaceEditorSnapshot;
  const onCommitted = deps.onCommitted ?? requestWorkspaceDocumentMutationOutboxPump;

  return async (input) => {
    if (
      input.binding.userId !== input.envelope.ownerId ||
      input.binding.documentVersion.revision !== input.documentVersion.revision
    ) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const artifact = await findArtifact({
      internalId: input.binding.artifactId,
      readableNamespaceIds: envelopeMutableNamespaces(input.envelope),
    });
    if (!artifact) return { ok: false, code: "local_target_forbidden" };
    if (artifact.revision !== input.documentVersion.revision) {
      return { ok: false, code: "stale_version" };
    }

    const extension = getLiveReviewExtension(input.binding.appId);
    if (!extension) {
      return { ok: false, code: "acceptance_conflict" };
    }

    let canonicalContent: string;
    try {
      canonicalContent = await readCanonicalContent(artifact);
    } catch {
      return { ok: false, code: "relay_unavailable" };
    }
    const verified = verifyAcceptedLiveReviewContent({
      canonicalContent,
      acceptedContent: input.acceptedContent,
      selectedOperations: input.selectedOperations,
      extension,
    });
    if (!verified.ok) return { ok: false, code: "acceptance_conflict" };

    const clientMutationId = input.clientMutationId ?? createLiveArtifactProposalClientMutationId({
      artifactInternalId: input.binding.artifactId,
      sessionId: input.sessionId,
      proposalId: input.proposalId,
      requestId: input.requestId,
    });
    const saved = await saveSnapshot({
      envelope: input.envelope,
      sessionUserId: input.binding.userId,
      artifact,
      mimeType: artifact.mimeType,
      newText: verified.canonicalAcceptedContent,
      baseRevision: input.documentVersion.revision,
      baseSha256: sha256(canonicalContent),
      checkpoint: true,
      clientMutationId,
    }, { onCommitted });
    if (!saved.ok) return { ok: false, code: publicSaveFailure(saved) };

    return {
      ok: true,
      result: {
        documentVersion: { kind: "artifact_revision", revision: saved.revision },
        contentSha256: saved.sha256,
      },
    };
  };
}
