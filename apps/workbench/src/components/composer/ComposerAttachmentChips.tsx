import { FileText, X } from "lucide-react";
import type { ComposerAttachment } from "../../adapters/composer-attachments-ref";
import { relativeFromWorkspace } from "../browser-column/cited-paths";

export function ComposerAttachmentChips({
  attachments, onRemove, disabled = false,
}: {
  attachments: readonly ComposerAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((att) => (
        <AttachmentChip key={att.id} attachment={att} onRemove={onRemove} disabled={disabled} />
      ))}
    </div>
  );
}

function AttachmentChip({ attachment, onRemove, disabled }: { attachment: ComposerAttachment; onRemove: (id: string) => void; disabled: boolean }) {
  const relLabel = relativeFromWorkspace(attachment.rootPath, attachment.path);
  const displayLabel = relLabel.length > 0 ? relLabel : attachment.name;
  const isError = attachment.status === "error";
  const statusLabel = isError
    ? `rejected: ${attachment.errorReason ?? "not sent"}`
    : attachment.status === "pending"
      ? "pending"
      : attachment.workspaceArtifact ? "ready — stored in this Room’s Workspace" : "ready";
  return (
    <span
      className={`flex min-w-0 max-w-[min(16rem,100%)] items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
        isError
          ? "border-error/50 bg-error/10 text-foreground"
          : "border-border bg-background text-foreground"
      }`}
      title={`${attachment.path || attachment.name}\n${statusLabel}`}
      data-testid="composer-attachment"
      data-path={attachment.path}
      data-status={attachment.status ?? "queued"}
    >
      <FileText aria-hidden="true" className="h-3 w-3 shrink-0 text-foreground-muted" />
      <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
      <span className="shrink-0 text-foreground-muted">· {isError ? "rejected" : attachment.status === "pending" ? "pending" : "ready"}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.name}`}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
      >
        <X aria-hidden="true" className="h-3 w-3" />
      </button>
    </span>
  );
}
