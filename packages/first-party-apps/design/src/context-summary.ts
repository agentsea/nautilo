/**
 * Complete active-context summary for the Nautilo Design mini-app.
 * The summary is what the open
 * mini-app publishes to the agent via `window.nautiloApp.context.set(...)` so
 * Genie can reason about the current page, node counts, top-level frames, and
 * any selection (selection is iframe-only state — the headless server tools
 * never read it; it flows only through this summary).
 */

import {
  countNodes,
  findPage,
  topLevelFrames,
  type DesignDocument,
} from "./scene-graph";
import { designNodeHandle, designPageHandle } from "./design-inspection";

export type DesignContextSelection = {
  label: string;
  pageHandle: string;
  pageName: string;
  nodeHandles: string[];
  nodeCount: number;
};

export type DesignContextSummary = {
  title: string;
  documentPath?: string;
  selection?: DesignContextSelection;
  summary?: {
    documentType: "design";
    openDocumentWorkflow: string;
    state: string;
    pageCount: number;
    nodeCount: number;
    topLevelFrameCount: number;
    dirty: boolean;
    lastSavedAt?: string;
    description: string;
    design: {
      pageHandle: string;
      pageName: string;
      topLevelFrames: Array<{ handle: string; name: string }>;
      nodeCount: number;
      dirty: boolean;
      lastSavedAt?: string;
      summary: string;
    };
  };
};

const OPEN_DOCUMENT_WORKFLOW =
  "This design is open. Inspect with inspect-open-design, use only returned node:/page: handles, then apply one atomic batch with edit-open-design. Pen commands are normalized node-local M/L/C/Z; inspect geometry before revising a path. Do not use path-targeted or pointer-surrogate tools.";

export type BuildDesignContextSummaryInput = {
  documentPath?: string;
  document: DesignDocument;
  activePageId?: string | null;
  selectionNodeIds?: string[] | null;
  dirty: boolean;
  lastSavedAt?: Date | null;
};

function buildDescription(doc: DesignDocument, activePageId: string | null): string {
  const pageId = activePageId ?? doc.pages[0]?.id ?? null;
  const page = pageId ? findPage(doc, pageId) : null;
  const pageName = page?.name ?? "Page 1";
  const frames = page ? topLevelFrames(doc, page.id) : [];
  const parts = [
    `${doc.pages.length} page(s)`,
    `active "${pageName}"`,
    `${countNodes(doc)} node(s)`,
    `${frames.length} top-level frame(s)`,
  ];
  return parts.join("; ");
}

export function buildDesignSummary(
  doc: DesignDocument,
  activePageId: string | null,
): string {
  return buildDescription(doc, activePageId);
}

export function buildContextSummary(
  input: BuildDesignContextSummaryInput,
): DesignContextSummary {
  const doc = input.document;
  const activePageId = input.activePageId ?? doc.pages[0]?.id ?? null;
  const page = activePageId ? findPage(doc, activePageId) : null;
  const pageId = page?.id ?? doc.pages[0]?.id ?? "";
  const pageName = page?.name ?? doc.pages[0]?.name ?? "Page 1";
  const frames = page ? topLevelFrames(doc, page.id) : [];
  const selectionIds = input.selectionNodeIds ?? [];
  const description = buildDescription(doc, activePageId);
  const title = input.documentPath?.split(/[/\\]/).pop() ?? pageName;
  const selectionLabel =
    selectionIds.length > 0
      ? `${pageName} · ${selectionIds.length} selected`
      : pageName;
  const lastSavedAtIso = input.lastSavedAt ? input.lastSavedAt.toISOString() : undefined;

  return {
    title,
    ...(input.documentPath ? { documentPath: input.documentPath } : {}),
    ...(selectionIds.length > 0
      ? {
          selection: {
            label: selectionLabel,
            pageHandle: designPageHandle(pageId),
            pageName,
            nodeHandles: selectionIds.map(designNodeHandle),
            nodeCount: selectionIds.length,
          },
        }
      : {}),
    summary: {
      documentType: "design",
      openDocumentWorkflow: OPEN_DOCUMENT_WORKFLOW,
      state: input.dirty
        ? "unsaved changes"
        : lastSavedAtIso
          ? `saved at ${lastSavedAtIso}`
          : "saved",
      pageCount: doc.pages.length,
      nodeCount: countNodes(doc),
      topLevelFrameCount: frames.length,
      dirty: input.dirty,
      ...(lastSavedAtIso ? { lastSavedAt: lastSavedAtIso } : {}),
      description,
      design: {
        pageHandle: designPageHandle(pageId),
        pageName,
        topLevelFrames: frames.map((frame) => ({
          handle: designNodeHandle(frame.id),
          name: frame.name,
        })),
        nodeCount: countNodes(doc),
        dirty: input.dirty,
        ...(lastSavedAtIso ? { lastSavedAt: lastSavedAtIso } : {}),
        summary: description,
      },
    },
  };
}
