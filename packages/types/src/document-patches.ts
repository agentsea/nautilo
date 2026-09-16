/**
 * ISSUE-M193 — versioned patch document collaboration wire types.
 *
 * Browser-safe protocol shapes shared by server, api-client, workbench,
 * and agent write paths.
 */

import { z } from "zod";

export type PatchDocumentTarget =
  | {
      kind: "artifact";
      artifactInternalId: string;
      path: string;
      roomId?: string;
      mimeType?: string;
    }
  | {
      kind: "currentFile";
      currentFolderRef: string;
      relativePath: string;
      relayOwnerUserId?: string;
    };

export const anchoredTextPatchSchema = z
  .object({
    kind: z.literal("anchored_text"),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
    scope: z
      .object({
        from: z.number().int().positive().safe(),
        to: z.number().int().positive().safe(),
      })
      .strict()
      .refine((scope) => scope.to >= scope.from, {
        message: "scope.to must be greater than or equal to scope.from",
        path: ["to"],
      })
      .optional(),
  })
  .strict();
export type AnchoredTextPatch = z.infer<typeof anchoredTextPatchSchema>;

export type DocumentPatchAuthor = {
  kind: "human" | "agent" | "app_tool";
  displayName: string;
};

export type DocumentPatchRequest = {
  requestId: string;
  target: PatchDocumentTarget;
  baseRevision: number | null;
  baseSha256: string;
  patch: AnchoredTextPatch;
  clientMutationId?: string;
  checkpoint?: boolean;
  mimeType?: string;
};

export type DocumentPatchApplied = {
  kind: "applied";
  target: PatchDocumentTarget;
  patchId: string;
  requestId: string;
  revision: number | null;
  sha256: string;
  /** Canonical post-patch document text after server-side apply/rebase. */
  content?: string;
  author: DocumentPatchAuthor;
  patch: AnchoredTextPatch;
  unifiedDiff: string;
  rebased: boolean;
};

export type DocumentPatchRejected =
  | {
      kind: "stale_base_unrebaseable";
      latestRevision: number | null;
      latestSha256: string;
    }
  | {
      kind: "anchor_not_found";
      latestRevision: number | null;
      latestSha256: string;
    }
  | {
      kind: "anchor_ambiguous";
      latestRevision: number | null;
      latestSha256: string;
    }
  | { kind: "unsupported"; reason: string }
  | { kind: "forbidden"; reason: string }
  | { kind: "too_large"; reason: string };

export type DocumentPatchEvent = {
  type: "document.patch.applied";
  target: PatchDocumentTarget;
  patchId: string;
  requestId?: string;
  revision: number | null;
  sha256: string;
  previousRevision: number | null;
  previousSha256: string;
  patch: AnchoredTextPatch;
  author: DocumentPatchAuthor;
  clientMutationId?: string;
  rebased?: boolean;
};

export type DocumentPatchCatchUpResponse =
  | { ok: true; events: DocumentPatchEvent[] }
  | { ok: false; reason: "cache_miss" };
