import { Download, FileText, Loader2 } from "lucide-react";
import { saveArtifactToDisk } from "@nautilo/api-client/browser";
import type { MessageAttachmentRef } from "@nautilo/types";
import { useEffect, useRef, useState } from "react";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { useAuth } from "../hooks/use-auth";
import { workbenchFetch } from "../lib/admission-fetch";
import { apiClient } from "../lib/api";
import { isSupportedMessageImage } from "./message-attachment-images";

function MessageAttachmentFile({ attachment, roomId }: { attachment: MessageAttachmentRef; roomId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  async function download() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    const generation = apiClient.getCredentialGeneration();
    const current = () => !controller.signal.aborted && apiClient.getCredentialGeneration() === generation;
    setState("loading");
    try {
      const provider = apiClient.getTokenProvider();
      const token = provider ? await provider() : apiClient.getToken();
      if (!token || !current()) throw new Error("Attachment access unavailable");
      const response = await workbenchFetch(apiClient.getMessageAttachmentUrl(attachment.attachmentId, { roomId }), {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (!response.ok) throw new Error("Attachment access denied");
      const blob = await response.blob();
      if (!current()) return;
      await saveArtifactToDisk(blob, attachment.filename, { signal: controller.signal });
      if (current()) setState("idle");
    } catch { if (current()) setState("failed"); }
    finally { if (request.current === controller) request.current = null; }
  }
  return <div className="min-w-0 max-w-full">
    <button type="button" disabled={state === "loading"} aria-label={`Download ${attachment.filename}`} title={attachment.filename}
      onClick={() => void download()}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background-element px-2 py-1 text-xs text-foreground hover:bg-background-panel disabled:opacity-40">
      <FileText className="h-3.5 w-3.5 shrink-0 text-foreground-muted" aria-hidden />
      <span className="min-w-0 truncate">{attachment.filename}</span>
      {state === "loading" ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden /> : <Download className="h-3 w-3 shrink-0 text-foreground-muted" aria-hidden />}
    </button>
    {state === "failed" ? <p role="status" className="mt-1 text-xs text-foreground-muted">Could not download this file. Try again.</p> : null}
  </div>;
}

/** Non-image files stay visible after sending; bytes load only on an explicit download. */
export function MessageAttachmentFiles({ attachments, roomId }: {
  attachments: readonly MessageAttachmentRef[] | undefined; roomId: string | null;
}) {
  const auth = useAuth();
  if (!roomId || !attachments || !isAuthenticatedHumanViewer(auth.viewer)) return null;
  const files = attachments.filter(file => !isSupportedMessageImage(file));
  if (!files.length) return null;
  const scope = [roomId, auth.viewer.sessionUserId, auth.viewer.sessionActorId, auth.viewerGeneration, auth.credentialGeneration].join(":");
  return <div className="mt-1 flex min-w-0 flex-wrap gap-1.5" data-testid="message-attachment-files">
    {files.map(attachment => <MessageAttachmentFile key={`${scope}:${attachment.attachmentId}`} attachment={attachment} roomId={roomId} />)}
  </div>;
}
