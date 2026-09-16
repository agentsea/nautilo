import { ChevronRight, FileText } from "lucide-react";

import type { MessageArtifactOpenRef } from "@nautilo/types";

import { requestOpenFile } from "../adapters/open-file-ref";
import { MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY } from "../adapters/session-rehydrate";
import { artifactOpenFileTarget } from "./browser-column/open-file-target";

type ArtifactOpenCardProps = {
  /** Server-authorized pointer received on the owning transcript message. */
  artifact: MessageArtifactOpenRef;
};

const EMPTY_ARTIFACT_OPEN_REFS: readonly MessageArtifactOpenRef[] = [];

/**
 * Reads only the named, server-authored metadata lane. This is intentionally
 * not a filename parser: plain `@document.md` text remains ordinary prose.
 */
export function artifactOpenRefsFromMessageMetadata(
  metadata: unknown,
): readonly MessageArtifactOpenRef[] {
  const custom = (metadata as {
    custom?: { artifactOpenRefs?: readonly MessageArtifactOpenRef[] };
  } | null | undefined)?.custom;
  const artifactOpenRefs = custom?.[MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY];
  return Array.isArray(artifactOpenRefs) ? artifactOpenRefs : EMPTY_ARTIFACT_OPEN_REFS;
}

/** Maintains server ordering while rendering the message's document cards. */
export function MessageArtifactOpenCards({
  artifacts,
}: {
  artifacts: readonly MessageArtifactOpenRef[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5" data-message-artifact-open-cards>
      {artifacts.map((artifact) => (
        <ArtifactOpenCard
          key={`${artifact.roomId}:${artifact.artifactInternalId}`}
          artifact={artifact}
        />
      ))}
    </div>
  );
}

/**
 * A compact, room-authorized Workspace document opener rendered beneath a
 * transcript message. This deliberately consumes only the server's persisted
 * pointer; it never interprets a filename mentioned in message prose.
 */
export function ArtifactOpenCard({ artifact }: ArtifactOpenCardProps) {
  const meta = `${artifact.mimeType} · ${formatArtifactOpenCardSize(artifact.sizeBytes)}`;

  return (
    <button
      type="button"
      onClick={() => {
        requestOpenFile(
          artifactOpenFileTarget({
            id: artifact.artifactInternalId,
            path: artifact.basename,
            mimeType: artifact.mimeType,
            roomId: artifact.roomId,
            sizeBytes: artifact.sizeBytes,
          }),
        );
      }}
      aria-label={`Open ${artifact.basename}, ${meta}`}
      className="group flex w-full max-w-md items-center gap-2 rounded-md border border-border bg-background-element px-3 py-2 text-left shadow-sm transition-colors hover:bg-background hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded bg-primary/10 text-primary"
      >
        <FileText className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {artifact.basename}
        </span>
        <span className="mt-0.5 block truncate text-xs text-foreground-muted">{meta}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-foreground-muted" />
    </button>
  );
}

/** Kept in sync with the compact native artifact card's human-readable size. */
export function formatArtifactOpenCardSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
