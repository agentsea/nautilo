/**
 * Per-command renderer for the unified `file` tool's `read` command.
 * (Originally shipped as `read-file.tsx` for the legacy `read_file`
 * tool — M088B removed that tool; the rendering logic stays here for
 * `file({command:"read", ...})`. Imported from `file-renderer.tsx`.)
 *
 * Collapsed: zoned-path (e.g. `home/notes.md` or `/abs/path`) +
 *            optional `(lines 12-40)` suffix if args carry a range.
 * Expanded: read-only CodeMirror of all received source, with exact
 *            source-window line numbers and explicit continuation metadata.
 *            Errors from the tool itself (content starts with
 *            "Error: ...") render in error-colored form.
 * D113A — multimodal `file:read` envelope (image/PDF) uses shared
 * thumbnail/lightbox; UI live-verified in Electron.
 */

import { useState, type ReactElement } from "react";
import type { ToolCardState } from "../tool-card-helpers";
import type { ToolRenderer, ToolRendererProps } from "./types";
import type { ToolActivityEvent } from "../../../adapters/runtime-contexts";
import {
  pickZonedPath,
  pickPath,
  pickLineRange,
  looksLikeToolError,
} from "./shared";
import { Thumbnail, ImageLightbox } from "./image-lightbox";
import { isDesktop, desktopAPI } from "../../../lib/desktop";

import { CodePreview } from "../../../editors/code-editor";

/** Decode only an identified text-window envelope; JSON source files remain source. */
export function parseTextReadWindow(raw: string | undefined): {
  content: string; startLine: number; endLine: number; more: boolean; partialLine: boolean;
} | null {
  if (!raw?.trimStart().startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const o = value as Record<string, unknown>;
    if (o.command !== "read" || typeof o.content !== "string" || typeof o.sourceVersion !== "string"
      || !Number.isSafeInteger(o.startLine) || !Number.isSafeInteger(o.endLine)
      || (o.startLine as number) < 1
      || ((o.endLine as number) < (o.startLine as number) && !(o.endLine === 0 && o.content === ""))) return null;
    return { content: o.content, startLine: o.startLine as number, endLine: o.endLine as number,
      more: typeof o.nextCursor === "string", partialLine: o.partialStartLine === true || o.partialEndLine === true };
  } catch { return null; }
}

export type MultimodalReadEnvelope = {
  multimodal: true;
  kind: "image" | "pdf";
  absolutePath: string;
  mime: string;
  bytes: number;
  header: string;
};

/** Parse the D113A multimodal-read envelope. Returns null on anything not matching. */
export function parseMultimodalReadEnvelope(raw: string | undefined): MultimodalReadEnvelope | null {
  if (!raw?.trim()) return null;
  // Cheap pre-check: must look like JSON and contain "multimodal"
  if (!raw.includes("multimodal")) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (o["multimodal"] !== true) return null;
    if (o["kind"] !== "image" && o["kind"] !== "pdf") return null;
    if (typeof o["absolutePath"] !== "string") return null;
    if (typeof o["mime"] !== "string") return null;
    if (typeof o["bytes"] !== "number") return null;
    if (typeof o["header"] !== "string") return null;
    return o as unknown as MultimodalReadEnvelope;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

function MultimodalReadBody(props: {
  envelope: MultimodalReadEnvelope;
  state: ToolCardState;
  event: ToolActivityEvent | undefined;
  resultText: string | undefined;
}): ReactElement {
  const { envelope: mm, state, event, resultText } = props;
  const rawError = event?.error;
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const imageRef = { kind: "fs" as const, absolutePath: mm.absolutePath, mime: mm.mime };

  const errorSection =
    state === "error" && rawError && rawError !== resultText ? (
      <section aria-label="error">
        <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
          Error
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">{rawError}</pre>
      </section>
    ) : null;

  if (mm.kind === "image") {
    return (
      <div className="border-t border-border px-3 py-2 space-y-2">
        <section aria-label="multimodal read">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            <span>Image</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="text-xs text-foreground break-words">{mm.header}</p>
            <span className="text-[0.65rem] text-foreground-dim tabular-nums">{formatBytes(mm.bytes)}</span>
          </div>
          <div className="mt-2 flex justify-center">
            <div className="aspect-square w-full max-w-[384px]">
              <Thumbnail
                image={imageRef}
                size="large"
                onOpen={() => setLightboxOpen(true)}
                ariaLabel="open read image"
              />
            </div>
          </div>
        </section>
        {errorSection}
        {lightboxOpen && (
          <ImageLightbox
            images={[imageRef]}
            index={0}
            onClose={() => setLightboxOpen(false)}
            onStep={() => {}}
          />
        )}
      </div>
    );
  }

  const api = isDesktop && desktopAPI ? desktopAPI : null;
  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
      <section aria-label="multimodal read">
        <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
          PDF
        </div>
        <p className="text-xs text-foreground break-words">{mm.header}</p>
        <span className="mt-1 block text-[0.65rem] text-foreground-dim tabular-nums">{formatBytes(mm.bytes)}</span>
        {api && (
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={(e) => {
              e.stopPropagation();
              void api.fs.openPath(mm.absolutePath);
            }}
          >
            Open in default app
          </button>
        )}
      </section>
      {errorSection}
    </div>
  );
}

function collapsedSummary({ args }: { args: Record<string, unknown> }): string {
  const path = pickZonedPath(args);
  const range = pickLineRange(args);
  if (path && range) return `${path} (lines ${range.start}–${range.end})`;
  return path;
}

function ReadFileExpanded(props: ToolRendererProps): ReactElement {
  const { args, resultText, resultTruncated, state, event } = props;
  const rawError = event?.error;

  const failed = state === "error" || state === "blocked";
  const mm = failed ? null : parseMultimodalReadEnvelope(resultText);
  if (mm) {
    return <MultimodalReadBody envelope={mm} state={state} event={event} resultText={resultText} />;
  }

  const toolError = failed ? resultText ?? rawError : state !== "success" && state !== "unknown" && looksLikeToolError(resultText) ? resultText : undefined;
  const window = parseTextReadWindow(resultText);
  const displayContent = toolError ? undefined : window?.content ?? resultText;
  const firstLine = window?.startLine ?? pickLineRange(args)?.start ?? 1;

  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
      {toolError && (
        <section aria-label="tool error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
            Tool error
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">
            {toolError}
          </pre>
        </section>
      )}

      {displayContent !== undefined && displayContent.length > 0 && (
        <section aria-label={state === "unknown" ? "recorded tool output" : "file content"}>
          <div className="mb-1 flex items-baseline gap-2 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
            <span>{state === "unknown" ? "Recorded output · outcome unavailable" : "Content"}</span>
            <span className="font-normal normal-case text-foreground-dim">
              {window ? `Lines ${window.startLine}–${window.endLine}` : "Received content"}
              {window?.partialLine ? " · partial line" : ""}
              {window?.more ? " · range continues in another read page" : ""}
              {resultTruncated ? " · result transport truncated" : ""}
            </span>
          </div>
          {state === "unknown" ? <pre className="whitespace-pre-wrap break-words text-xs">{displayContent}</pre>
            : <CodePreview value={displayContent} path={pickPath(args)} firstLine={firstLine} />}
        </section>
      )}

      {state === "error" && rawError && rawError !== resultText && (
        <section aria-label="error">
          <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-tool-error">
            Error
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs text-tool-error">
            {rawError}
          </pre>
        </section>
      )}

      {!toolError && (!displayContent || displayContent.length === 0) && state !== "error" && (
        <div className="text-xs italic text-foreground-dim">{window ? "(no content in the requested range)" : "(empty file)"}</div>
      )}
    </div>
  );
}

export const fileReadRenderer: ToolRenderer = {
  collapsedSummary,
  ExpandedBody: ReadFileExpanded,
};
