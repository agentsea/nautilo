import { workspaceDocumentMimeType } from "@nautilo/attachments/composer-chat-extensions";
import type { ChatFocusedResourceRef } from "@nautilo/types";
import type { ComposerAttachment } from "../adapters/composer-attachments-ref";

/** Use the same namespace-gated artifact admission as a Workspace upload/drop. */
export async function uploadComposerDocument(
  input: { id: string; blob: Blob; filename: string; roomId?: string | null },
  upload: (blob: Blob, options: { path: string; mimeType: string; roomId: string }) => Promise<{ artifactId: string }>,
): Promise<{ artifactId: string; roomId: string }> {
  if (!input.roomId) throw new Error("Select a room before attaching a document.");
  const filename = input.filename.split(/[/\\]/).pop() ?? "document";
  const mimeType = workspaceDocumentMimeType(filename);
  if (!mimeType) throw new Error("Unsupported document attachment.");
  // A fresh upload owns a unique path; selecting the same filename cannot overwrite an artifact.
  const artifact = await upload(input.blob, {
    path: `Attachments/${input.id}/${filename}`,
    mimeType,
    roomId: input.roomId,
  });
  return { artifactId: artifact.artifactId, roomId: input.roomId };
}

export function workspaceAttachmentsForSend(
  attachments: readonly ComposerAttachment[],
  roomId: string | null | undefined,
): { ok: true; refs: ChatFocusedResourceRef[] } | { ok: false } {
  const refs: ChatFocusedResourceRef[] = [];
  for (const attachment of attachments) {
    if (attachment.status === "pending" || attachment.status === "error") return { ok: false };
    if (!attachment.workspaceArtifact) continue;
    if (attachment.workspaceArtifact.roomId !== roomId) return { ok: false };
    refs.push({ kind: "workspace-artifact", artifactId: attachment.workspaceArtifact.artifactId });
  }
  return { ok: true, refs };
}
