import type { LiveDocumentVersion } from "@nautilo/types";
import { liveDocumentVersionEquals } from "@nautilo/types";
import type { NautiloAcceptProposalRequest, NautiloAcceptProposalResult } from "./bridge";
import type { NautiloDocStore } from "./nautilo-doc-store";
import type { AcceptedSuggestionBatch, SuggestionController } from "./suggestion-controller";

export type WriterLiveSession = {
  /** Opaque authorization bearer; must match the proposal's sessionToken. */
  sessionToken: string;
  /** Non-authorizing routing identity. */
  sessionId: string;
  documentVersion: LiveDocumentVersion;
};

export type AcceptProposalBridge = {
  acceptProposal(request: NautiloAcceptProposalRequest): Promise<NautiloAcceptProposalResult>;
};

export type AcceptProposalPersistenceDeps = {
  controller: SuggestionController | null;
  store: NautiloDocStore | null;
  currentDocumentVersion: LiveDocumentVersion | null;
  liveSession: WriterLiveSession | undefined;
  bridge?: AcceptProposalBridge | null;
};

export type PersistAcceptedProposalResult =
  | { kind: "not_persisted" }
  | { kind: "artifact_persisted" }
  | {
      kind: "artifact_receipt_persisted";
      documentVersion: Extract<LiveDocumentVersion, { kind: "artifact_revision" }>;
      contentSha256: string;
    }
  | {
      kind: "local_persisted";
      documentVersion: Extract<LiveDocumentVersion, { kind: "local_sha" }>;
      contentSha256: string;
    };

const KNOWN_ACCEPT_PROPOSAL_CODES = new Set([
  "session_closed",
  "stale_version",
  "relay_unavailable",
  "local_target_forbidden",
  "proposal_closed",
  "acceptance_conflict",
  "invalid_request",
  "payload_too_large",
]);

function isLiveDocumentVersion(value: unknown): value is LiveDocumentVersion {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "artifact_revision") {
    return (
      typeof record["revision"] === "number" &&
      Number.isInteger(record["revision"]) &&
      record["revision"] >= 0
    );
  }
  if (record["kind"] === "local_sha") {
    return typeof record["sha256"] === "string" && record["sha256"].length > 0;
  }
  return false;
}

/** Normalize legacy bridge rejections and bare success payloads into one result shape. */
export function normalizeBridgeAcceptProposalResult(
  value: unknown,
  error?: unknown,
): NautiloAcceptProposalResult {
  if (error !== undefined) {
    const message = error instanceof Error ? error.message : "Live review acceptance failed.";
    const bracketMatch = message.match(/^\[(\d+)\]\s*(.+)$/);
    const body = (bracketMatch?.[2] ?? message).trim();
    if (KNOWN_ACCEPT_PROPOSAL_CODES.has(body)) {
      return { ok: false, code: body, message: body.replaceAll("_", " ") };
    }
    for (const code of KNOWN_ACCEPT_PROPOSAL_CODES) {
      if (body === code || body.startsWith(`${code}:`) || body.startsWith(`${code} `)) {
        return { ok: false, code, message: body };
      }
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      KNOWN_ACCEPT_PROPOSAL_CODES.has((error as { code: string }).code)
    ) {
      const code = (error as { code: string }).code;
      return { ok: false, code, message: body };
    }
    return { ok: false, code: "persistence_error", message };
  }

  if (!value || typeof value !== "object") {
    return { ok: false, code: "persistence_error", message: "Unexpected acceptance response." };
  }

  const record = value as Record<string, unknown>;
  if (record["ok"] === false) {
    const code = typeof record["code"] === "string" ? record["code"] : "persistence_error";
    const message =
      typeof record["message"] === "string" ? record["message"] : "Live review acceptance failed.";
    return { ok: false, code, message };
  }

  const documentVersion = record["documentVersion"];
  const contentSha256 = record["contentSha256"];
  if (
    isLiveDocumentVersion(documentVersion) &&
    typeof contentSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(contentSha256)
  ) {
    return {
      ok: true,
      documentVersion,
      contentSha256,
      ...(typeof record["localRevisionRef"] === "string"
        ? { localRevisionRef: record["localRevisionRef"] }
        : {}),
    };
  }

  return { ok: false, code: "persistence_error", message: "Unexpected acceptance response." };
}

async function invokeBridgeAcceptProposal(
  bridge: AcceptProposalBridge,
  request: NautiloAcceptProposalRequest,
): Promise<NautiloAcceptProposalResult> {
  try {
    const raw = await bridge.acceptProposal(request);
    return normalizeBridgeAcceptProposalResult(raw);
  } catch (error) {
    return normalizeBridgeAcceptProposalResult(undefined, error);
  }
}

function isLocalLiveSession(session: WriterLiveSession): boolean {
  return session.documentVersion.kind === "local_sha";
}

function versionsMatch(
  current: LiveDocumentVersion | null,
  session: WriterLiveSession | undefined,
  pendingVersion: LiveDocumentVersion,
): boolean {
  return Boolean(
    current &&
    session &&
    liveDocumentVersionEquals(current, pendingVersion) &&
    liveDocumentVersionEquals(session.documentVersion, pendingVersion),
  );
}

/**
 * Atomically persists the currently pending Writer proposal. Artifact sessions
 * use the M193 store path; Current Folder sessions delegate to the host bridge.
 */
export async function persistAcceptedProposal(
  deps: AcceptProposalPersistenceDeps,
): Promise<PersistAcceptedProposalResult> {
  const { controller, store, currentDocumentVersion, liveSession, bridge } = deps;
  if (!controller || !store) return { kind: "not_persisted" };

  const pending = controller.getState();
  if (pending.kind !== "pending") return { kind: "not_persisted" };
  if (
    !liveSession ||
    liveSession.sessionToken !== pending.request.sessionToken ||
    !versionsMatch(currentDocumentVersion, liveSession, pending.documentVersion)
  ) {
    controller.invalidate("stale_version");
    return { kind: "not_persisted" };
  }

  const batch = controller.acceptAll();
  if (!batch) return { kind: "not_persisted" };

  if (isLocalLiveSession(liveSession)) {
    return persistLocalAcceptedProposal({
      controller,
      store,
      liveSession,
      ...(bridge !== undefined ? { bridge } : {}),
      batch,
    });
  }
  return persistArtifactAcceptedProposal({
    controller,
    store,
    ...(bridge !== undefined ? { bridge } : {}),
    batch,
  });
}

async function persistArtifactAcceptedProposal(args: {
  controller: SuggestionController;
  store: NautiloDocStore;
  bridge?: AcceptProposalBridge | null;
  batch: AcceptedSuggestionBatch;
}): Promise<PersistAcceptedProposalResult> {
  const { controller, store, bridge, batch } = args;
  // A live Artifact review uses the same server receipt route as Current
  // Folder.  The fallback remains only for non-live embedded Writer use where
  // there is no review capability or Task to finalize.
  if (bridge?.acceptProposal) {
    return persistBridgeAcceptedProposal({ controller, store, bridge, batch });
  }
  const result = await store.commitAcceptedBatch(batch.baseDoc, batch.operations);
  if (!result.ok) {
    if (result.reason === "stale_base") controller.invalidate("human_changed");
    else controller.failAccept(batch.proposalId, result.reason, result.message);
    return { kind: "not_persisted" };
  }
  controller.completeAccept(batch.proposalId);
  return { kind: "artifact_persisted" };
}

async function persistLocalAcceptedProposal(args: {
  controller: SuggestionController;
  store: NautiloDocStore;
  liveSession: WriterLiveSession;
  bridge?: AcceptProposalBridge | null;
  batch: AcceptedSuggestionBatch;
}): Promise<PersistAcceptedProposalResult> {
  const { controller, store, bridge, batch } = args;
  return persistBridgeAcceptedProposal({
    controller,
    store,
    ...(bridge !== undefined ? { bridge } : {}),
    batch,
  });
}

async function persistBridgeAcceptedProposal(args: {
  controller: SuggestionController;
  store: NautiloDocStore;
  bridge?: AcceptProposalBridge | null;
  batch: AcceptedSuggestionBatch;
}): Promise<PersistAcceptedProposalResult> {
  const { controller, store, bridge, batch } = args;
  if (!bridge?.acceptProposal) {
    controller.failAccept(batch.proposalId, "persistence_error", "Live review acceptance is unavailable.");
    return { kind: "not_persisted" };
  }

  const prepared = store.prepareAcceptedContent(batch.baseDoc, batch.operations);
  if (!prepared.ok) {
    if (prepared.reason === "stale_base") {
      controller.invalidate("human_changed");
      return { kind: "not_persisted" };
    }
    controller.failAccept(batch.proposalId, "apply_error", prepared.message);
    return { kind: "not_persisted" };
  }

  const response = await invokeBridgeAcceptProposal(bridge, {
    requestId: batch.requestId,
    proposalId: batch.proposalId,
    documentVersion: batch.documentVersion,
    acceptedOperationIndexes: [...batch.acceptedOperationIndexes],
    acceptedContent: prepared.content,
  });

  if (!response.ok) {
    if (response.code === "stale_version" || response.code === "session_closed") {
      controller.invalidate(response.code === "session_closed" ? "session_closed" : "stale_version");
      return { kind: "not_persisted" };
    }
    if (response.code === "acceptance_conflict" || response.code === "proposal_closed") {
      controller.failAccept(batch.proposalId, "persistence_error", response.message);
      return { kind: "not_persisted" };
    }
    controller.failAccept(batch.proposalId, "persistence_error", response.message);
    return { kind: "not_persisted" };
  }

  const installed = store.installAcceptedContent(
    prepared.content,
    response.contentSha256,
  );
  if (!installed.ok) {
    controller.failAccept(batch.proposalId, "persistence_error", "Accepted content could not be installed.");
    return { kind: "not_persisted" };
  }

  controller.completeAccept(batch.proposalId);
  return response.documentVersion.kind === "local_sha"
    ? {
        kind: "local_persisted",
        documentVersion: response.documentVersion,
        contentSha256: response.contentSha256,
      }
    : {
        kind: "artifact_receipt_persisted",
        documentVersion: response.documentVersion,
        contentSha256: response.contentSha256,
      };
}
