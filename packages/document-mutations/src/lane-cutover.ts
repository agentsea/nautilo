/**
 * Stable producer groups that can be migrated independently to the document
 * mutation coordinator. Product-specific entrypoints map to one of these lanes
 * at their cutover seam.
 */
export const DOCUMENT_MUTATION_LANES = [
  "editor_save",
  "apply_patch",
  "file_tool",
  "officecli",
  "artifact_lifecycle",
  "desktop_files_ui",
] as const;

export type DocumentMutationLane = (typeof DOCUMENT_MUTATION_LANES)[number];

export type DocumentMutationLaneMode = "legacy" | "shadow" | "coordinator";

type MaybePromise<T> = T | PromiseLike<T>;
type Writer<TResult> = () => MaybePromise<TResult>;

type LaneSelection = {
  lane: DocumentMutationLane;
};

export type DocumentMutationLaneCutover<TResult, TPreview = unknown> =
  | (LaneSelection & {
      mode: "legacy";
      legacyWrite: Writer<TResult>;
    })
  | (LaneSelection & {
      mode: "shadow";
      coordinatorPreview: () => MaybePromise<TPreview>;
      legacyWrite: Writer<TResult>;
    })
  | (LaneSelection & {
      mode: "coordinator";
      coordinatorWrite: Writer<TResult>;
    });

export type DocumentMutationPreviewOutcome<TPreview> =
  | { ok: true; value: TPreview }
  | { ok: false; error: unknown };

export type DocumentMutationLaneExecution<TResult, TPreview = unknown> =
  | { mode: "legacy"; result: TResult }
  | {
      mode: "shadow";
      /**
       * Advisory comparison that runs independently of the legacy writer.
       * Consumers may observe it out of band; authoritative completion never
       * waits for coordinator preview.
       */
      preview: Promise<DocumentMutationPreviewOutcome<TPreview>>;
      result: TResult;
    }
  | { mode: "coordinator"; result: TResult };

/**
 * Executes one mutation lane with exactly one authoritative writer.
 *
 * Shadow mode runs the coordinator only as a read-only preview. Its outcome is
 * returned for comparison, but it never admits or blocks the legacy write.
 */
export async function runDocumentMutationLane<TResult, TPreview = unknown>(
  selection: DocumentMutationLaneCutover<TResult, TPreview>,
): Promise<DocumentMutationLaneExecution<TResult, TPreview>> {
  switch (selection.mode) {
    case "legacy":
      return { mode: "legacy", result: await selection.legacyWrite() };
    case "shadow": {
      const preview: Promise<DocumentMutationPreviewOutcome<TPreview>> =
        Promise.resolve()
          .then(async () => ({
            ok: true as const,
            value: await selection.coordinatorPreview(),
          }))
          .catch((error: unknown) => ({ ok: false as const, error }));
      return {
        mode: "shadow",
        preview,
        result: await selection.legacyWrite(),
      };
    }
    case "coordinator":
      return {
        mode: "coordinator",
        result: await selection.coordinatorWrite(),
      };
  }
}
