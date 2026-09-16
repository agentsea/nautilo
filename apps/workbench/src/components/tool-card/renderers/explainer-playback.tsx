/**
 * D416 — `play_explainer` playback tool-card.
 *
 * The agent returns strict metadata after user consent. This renderer fetches
 * the authenticated media bytes through the singleton API client and gives
 * the player only a short-lived Blob URL.
 */

import {
  ExplainerPlaybackEnvelopeSchema,
  type ExplainerPlaybackEnvelope,
} from "@nautilo/types";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { apiClient } from "../../../lib/api";
import { ExplainerVideoPlayer } from "./explainer-video-player";
import type { ToolRenderer, ToolRendererProps } from "./types";
import { looksLikeToolError } from "./shared";

/** Parse only the strict server-resolved playback contract. */
export function parseExplainerPlaybackEnvelope(raw: string | undefined): ExplainerPlaybackEnvelope | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = ExplainerPlaybackEnvelopeSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatPlaybackCollapsedSummary(resultText: string | undefined): string {
  return parseExplainerPlaybackEnvelope(resultText)?.title ?? "play_explainer";
}

type MediaState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "failed" };

function useExplainerMedia(id: string): { state: MediaState; retry: () => void; failPlayback: () => void } {
  const [state, setState] = useState<MediaState>({ status: "loading" });
  const generationRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);

  const revokeObjectUrl = useCallback(() => {
    if (!objectUrlRef.current) return;
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    revokeObjectUrl();
    setState({ status: "loading" });

    void apiClient
      .fetchExplainerMedia(id)
      .then(({ blob, format }) => {
        if (format !== "mp4") throw new Error("Unsupported media format");

        const src = URL.createObjectURL(blob);
        if (generationRef.current !== generation) {
          URL.revokeObjectURL(src);
          return;
        }

        objectUrlRef.current = src;
        setState({ status: "ready", src });
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        setState({ status: "failed" });
      });
  }, [id, revokeObjectUrl]);

  const failPlayback = useCallback(() => {
    generationRef.current += 1;
    revokeObjectUrl();
    setState({ status: "failed" });
  }, [revokeObjectUrl]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      revokeObjectUrl();
    };
  }, [load, revokeObjectUrl]);

  return { state, retry: load, failPlayback };
}

function RawPlaybackResult({ resultText, state, event }: ToolRendererProps): ReactElement {
  return (
    <div className="border-t border-border px-3 py-2">
      {resultText && <pre className="whitespace-pre-wrap break-words text-xs">{resultText}</pre>}
      {state === "error" && event?.error && (
        <pre className="whitespace-pre-wrap text-xs text-tool-error">{event.error}</pre>
      )}
    </div>
  );
}

function ExplainerPlaybackContent({ envelope }: { envelope: ExplainerPlaybackEnvelope }): ReactElement {
  const { state, retry, failPlayback } = useExplainerMedia(envelope.id);

  return (
    <div className="border-t border-border px-3 py-2 space-y-2" data-testid="explainer-playback-expanded">
      {state.status === "loading" && (
        <div
          className="flex h-24 items-center justify-center rounded bg-muted text-xs text-foreground-muted"
          role="status"
        >
          Loading explainer video…
        </div>
      )}
      {state.status === "failed" && (
        <div className="flex h-24 flex-col items-center justify-center gap-2 rounded bg-muted text-center">
          <p role="alert" className="text-xs text-tool-error">
            Explainer video is unavailable.
          </p>
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-[0.65rem] hover:bg-background"
            onClick={(event) => {
              event.stopPropagation();
              retry();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {state.status === "ready" && (
        <ExplainerVideoPlayer src={state.src} title={envelope.title} onPlaybackError={failPlayback} />
      )}
      <p className="text-[0.65rem] text-foreground-muted">{envelope.summary}</p>
      <p className="text-[0.65rem] text-foreground-dim">
        {envelope.captionsAvailable ? "Captions available" : "No captions"}
      </p>
    </div>
  );
}

function ExplainerPlaybackExpanded(props: ToolRendererProps): ReactElement {
  const { resultText } = props;
  const toolError = looksLikeToolError(resultText);
  const envelope = toolError ? null : parseExplainerPlaybackEnvelope(resultText);

  if (!envelope) return <RawPlaybackResult {...props} />;

  return <ExplainerPlaybackContent envelope={envelope} />;
}

export const explainerPlaybackRenderer: ToolRenderer = {
  collapsedSummary: ({ resultText }) => formatPlaybackCollapsedSummary(resultText),
  autoExpandOnResult: true,
  ExpandedBody: ExplainerPlaybackExpanded,
};
