import type { LiveDocumentVersion } from "@nautilo/types";
import { parseLiveDocumentVersion } from "@nautilo/types";

export type LiveAppProposal = {
  proposalId: string;
  appId: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
  operations: unknown[];
};

type Listener = (proposal: LiveAppProposal) => void;
const listeners = new Set<Listener>();
const reconciliationListeners = new Set<() => void>();
const RECENT_PROPOSAL_LIMIT = 256;
const recentProposals = new Map<string, LiveAppProposal>();

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parsePlatformLiveAppProposal(resultText: string | undefined): LiveAppProposal | null {
  if (!resultText) return null;
  try {
    const result = JSON.parse(resultText) as Record<string, unknown>;
    const stamp = result.__nautiloLiveReview as Record<string, unknown> | undefined;
    const documentVersion = parseLiveDocumentVersion(stamp?.documentVersion);
    if (
      result.ok !== true ||
      result.status !== "proposal_ready" ||
      !stamp ||
      stamp.kind !== "proposal_ready" ||
      !isText(stamp.appId) ||
      !isText(stamp.sessionId) ||
      !isText(stamp.proposalId) ||
      !documentVersion ||
      !Array.isArray(result.operations)
    ) {
      return null;
    }
    return {
      proposalId: stamp.proposalId,
      appId: stamp.appId,
      sessionId: stamp.sessionId,
      documentVersion,
      operations: result.operations,
    };
  } catch {
    return null;
  }
}

export function publishLiveAppProposal(proposal: LiveAppProposal): boolean {
  if (recentProposals.has(proposal.proposalId)) return false;
  recentProposals.set(proposal.proposalId, proposal);
  if (recentProposals.size > RECENT_PROPOSAL_LIMIT) {
    const oldest = recentProposals.keys().next().value;
    if (oldest) recentProposals.delete(oldest);
  }
  for (const listener of listeners) listener(proposal);
  return true;
}

export function subscribeLiveAppProposal(listener: Listener): () => void {
  listeners.add(listener);
  replayLiveAppProposals(listener);
  return () => listeners.delete(listener);
}

/**
 * Reconcile retained, server-stamped proposals after a live Writer session or
 * iframe becomes ready. Proposal delivery is UI transport, so a transiently
 * absent/mismatched surface must not permanently strand the durable Task in
 * awaiting review.
 */
export function replayLiveAppProposals(listener: Listener): void {
  for (const proposal of recentProposals.values()) listener(proposal);
}

/** Reconcile retained delivery with the server's exact pending-review list. */
export function requestLiveAppProposalReconciliation(): void {
  for (const listener of reconciliationListeners) listener();
}

export function subscribeLiveAppProposalReconciliation(listener: () => void): () => void {
  reconciliationListeners.add(listener);
  return () => reconciliationListeners.delete(listener);
}

/** Test isolation for this module-local singleton. */
export function resetLiveAppProposalBusForTest(): void {
  listeners.clear();
  reconciliationListeners.clear();
  recentProposals.clear();
}
