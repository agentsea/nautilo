import { Loader2, SendHorizontal } from "lucide-react";

export function ComposerSendButton({
  disabled,
  pending,
  disabledTitle,
  onSend,
  label: actionLabel,
}: {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly disabledTitle: string | undefined;
  readonly onSend: () => void;
  readonly label?: string;
}) {
  const label = pending ? "Sending message" : actionLabel ?? "Send message";
  return (
    <button
      type="button"
      disabled={disabled}
      title={pending ? "Sending message…" : disabledTitle}
      aria-label={label}
      aria-busy={pending || undefined}
      onClick={onSend}
      className="mb-0.5 inline-flex items-center gap-2 shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
    >
      {actionLabel ? <span>{pending ? "Sending…" : actionLabel}</span> : null}
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <SendHorizontal className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}
