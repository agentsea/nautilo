import type { MessageAttachmentRef } from "@nautilo/types";
import { useEffect, useState, type ReactElement } from "react";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { useAuth } from "../hooks/use-auth";
import { workbenchFetch } from "../lib/admission-fetch";
import { apiClient } from "../lib/api";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function isSupportedMessageImage(
  attachment: MessageAttachmentRef,
): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase());
}

type ImageState =
  | { kind: "loading" }
  | { kind: "ready"; objectUrl: string }
  | { kind: "failed" };

function MessageAttachmentImage({
  attachment,
  roomId,
}: {
  attachment: MessageAttachmentRef;
  roomId: string;
}): ReactElement {
  const auth = useAuth();
  const [state, setState] = useState<ImageState>({ kind: "loading" });
  const authenticatedHuman = isAuthenticatedHumanViewer(auth.viewer);

  useEffect(() => {
    if (!authenticatedHuman) {
      setState({ kind: "failed" });
      return;
    }

    const controller = new AbortController();
    let ownedObjectUrl: string | null = null;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const tokenProvider = apiClient.getTokenProvider();
        const token = tokenProvider ? await tokenProvider() : apiClient.getToken();
        if (!token || controller.signal.aborted) throw new Error("Attachment access unavailable");
        const url = apiClient.getMessageAttachmentUrl(attachment.attachmentId, { roomId });
        const response = await workbenchFetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Attachment access denied");
        const blob = await response.blob();
        if (!SUPPORTED_IMAGE_MIME_TYPES.has(blob.type.toLowerCase())) {
          throw new Error("Unsupported attachment image");
        }
        if (controller.signal.aborted) return;
        ownedObjectUrl = URL.createObjectURL(blob);
        setState({ kind: "ready", objectUrl: ownedObjectUrl });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "failed" });
      }
    })();

    return () => {
      controller.abort();
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
    };
  }, [
    attachment.attachmentId,
    attachment.mimeType,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    auth.viewerGeneration,
    authenticatedHuman,
    roomId,
  ]);

  if (state.kind === "loading") {
    return (
      <div
        aria-label={`Loading ${attachment.filename}`}
        className="h-32 w-48 animate-pulse rounded-lg border border-border bg-background-element"
      />
    );
  }
  if (state.kind === "failed") {
    return (
      <div
        role="status"
        className="rounded-md border border-border bg-background-element px-3 py-2 text-xs text-foreground-muted"
      >
        {attachment.filename} · Image unavailable
      </div>
    );
  }
  return (
    <a
      href={state.objectUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${attachment.filename} full size`}
      className="block w-fit max-w-full rounded-lg outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <img
        src={state.objectUrl}
        alt={attachment.filename}
        loading="lazy"
        className="max-h-80 max-w-full rounded-lg border border-border object-contain"
      />
    </a>
  );
}

export function MessageAttachmentImages({
  attachments,
  roomId,
}: {
  attachments: readonly MessageAttachmentRef[] | undefined;
  roomId: string | null;
}): ReactElement | null {
  const auth = useAuth();
  if (!roomId || !attachments) return null;
  const images = attachments.filter(isSupportedMessageImage);
  if (images.length === 0) return null;
  const scopeKey = [
    roomId,
    auth.viewer.sessionUserId ?? "",
    auth.viewer.sessionActorId ?? "",
    String(auth.viewerGeneration),
  ].join(":");
  return (
    <div className="mt-1 flex flex-wrap gap-2" data-testid="message-attachment-images">
      {images.map((attachment) => (
        <MessageAttachmentImage
          key={`${scopeKey}:${attachment.attachmentId}`}
          attachment={attachment}
          roomId={roomId}
        />
      ))}
    </div>
  );
}
