/**
 * One renderer-local receipt for a trusted authored Design patch. It is not
 * persisted and never attempts to reconstruct chat intent: its summary and
 * reversible post-images come from the host event plus parsed scene delta.
 */

import type { NautiloDocumentPatchAppliedEvent } from "./bridge";
import { parseDesignHtml } from "./design-document";
import { jsonEqual } from "./json-equal";
import type { DesignDocument, DesignNode } from "./scene-graph";
import type { RevertTransaction } from "./transactions";

export type AgentReceipt = {
  patchId: string;
  patchKind: NautiloDocumentPatchAppliedEvent["patch"]["kind"];
  authorName: string;
  changedNodeIds: string[];
  objectLabels: string[];
  summary: string;
  /** Null is an honest disposition for structural/unknown changes. */
  revert: RevertTransaction | null;
};

function nodeIdsWithChanges(before: DesignDocument, after: DesignDocument): string[] {
  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  return [...ids].filter((id) => !jsonEqual(before.nodes[id], after.nodes[id])).sort();
}

function sameStructure(before: DesignDocument, after: DesignDocument): boolean {
  if (!jsonEqual(before.pages, after.pages)) return false;
  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  for (const id of ids) {
    const earlier = before.nodes[id];
    const later = after.nodes[id];
    if (!earlier || !later) return false;
    if (
      earlier.type !== later.type || earlier.parentId !== later.parentId ||
      !jsonEqual(earlier.childIds, later.childIds)
    ) return false;
  }
  return true;
}

function summary(authorName: string, count: number, reversible: boolean): string {
  if (!reversible) return `${authorName} changed document structure.`;
  return `${authorName} updated ${count} ${count === 1 ? "object" : "objects"}.`;
}

function nodeLabel(before: DesignDocument, after: DesignDocument, nodeId: string): string {
  const node = after.nodes[nodeId] ?? before.nodes[nodeId];
  return node?.name || (node ? `${node.type[0]?.toUpperCase()}${node.type.slice(1)}` : "Object");
}

export function receiptInspectableNodeIds(receipt: AgentReceipt, document: DesignDocument): string[] {
  return receipt.changedNodeIds.filter((nodeId) => document.nodes[nodeId] !== undefined);
}

/** Human-facing and bounded; durable IDs remain only selection keys. */
export function receiptObjectDetail(receipt: AgentReceipt): string {
  if (receipt.objectLabels.length === 0) return "Structural change — inspect the canvas before continuing.";
  const shown = receipt.objectLabels.slice(0, 3);
  const remainder = receipt.objectLabels.length - shown.length;
  return `Updated: ${shown.join(", ")}${remainder > 0 ? ` and ${remainder} others` : ""}`;
}

/**
 * Returns no receipt for human/unattributed/out-of-order events. The caller
 * supplies the autosave saved SHA so this delta is tied to the actual patch.
 */
export function deriveAgentReceipt(
  event: NautiloDocumentPatchAppliedEvent,
  previous: { content: string; sha256: string | null },
): AgentReceipt | null {
  if (
    (event.author?.kind !== "agent" && event.author?.kind !== "app_tool") ||
    previous.sha256 !== event.previousSha256
  ) return null;
  const before = parseDesignHtml(previous.content);
  const after = parseDesignHtml(event.envelope.content);
  if (!before.ok || !after.ok) return null;
  const changedNodeIds = nodeIdsWithChanges(before.document.scene, after.document.scene);
  if (changedNodeIds.length === 0 && jsonEqual(before.document.scene, after.document.scene)) return null;
  const reversible = changedNodeIds.length > 0 && sameStructure(before.document.scene, after.document.scene);
  const changes = reversible
    ? changedNodeIds.map((nodeId) => ({
        nodeId,
        expected: after.document.scene.nodes[nodeId] as DesignNode,
        restore: before.document.scene.nodes[nodeId] as DesignNode,
      }))
    : [];
  const authorName = event.author.kind === "app_tool" ? "Genie" : event.author.displayName || "Genie";
  return {
    patchId: event.patchId,
    patchKind: event.patch.kind,
    authorName,
    changedNodeIds,
    objectLabels: changedNodeIds.map((nodeId) => nodeLabel(before.document.scene, after.document.scene, nodeId)),
    summary: summary(authorName, changedNodeIds.length, reversible),
    revert: reversible ? { kind: "revert", changes } : null,
  };
}

/** Bounded retention: the one card the user can currently see. */
export class AgentReceiptState {
  private receipt: AgentReceipt | null = null;

  get(): AgentReceipt | null {
    return this.receipt;
  }

  replace(receipt: AgentReceipt): void {
    this.receipt = receipt;
  }

  clear(): void {
    this.receipt = null;
  }
}
