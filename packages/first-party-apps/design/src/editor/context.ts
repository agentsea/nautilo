/**
 * Build and publish the active-context summary for Genie. Delegates the shape
 * to the foundation's `buildContextSummary` (context-summary.ts) so the
 * headless server tools and the live iframe agree on the contract; selection
 * is iframe-only state that flows to the agent only through this summary.
 */

import { buildContextSummary, type DesignContextSummary } from "../context-summary";
import type { DesignDocument } from "../scene-graph";
import type { NautiloAppBridge } from "../bridge";

export type PublishContextParams = {
  document: DesignDocument;
  activePageId: string | null;
  selectionNodeIds: readonly string[];
  dirty: boolean;
  lastSavedAt?: Date | null;
  documentPath?: string;
};

export function buildContext(params: PublishContextParams): DesignContextSummary {
  return buildContextSummary({
    document: params.document,
    activePageId: params.activePageId,
    selectionNodeIds: [...params.selectionNodeIds],
    dirty: params.dirty,
    ...(params.documentPath !== undefined ? { documentPath: params.documentPath } : {}),
    ...(params.lastSavedAt !== undefined ? { lastSavedAt: params.lastSavedAt } : {}),
  });
}

/** Build the summary and push it through the bridge. No-op when unbound. */
export function publishContext(
  bridge: NautiloAppBridge | null,
  params: PublishContextParams,
): DesignContextSummary {
  const summary = buildContext(params);
  if (bridge) {
    bridge.context.set(summary as unknown as Record<string, unknown>);
  }
  return summary;
}
