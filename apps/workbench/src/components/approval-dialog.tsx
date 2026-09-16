import { useState, useRef, useEffect, useCallback } from "react";
import type { ProveItToolInfo, ShareMemoryApprovalPreview } from "@nautilo/types";
import { formatToolPreview } from "./tool-argument-preview";

export interface ApprovalDialogProps {
  tools: ProveItToolInfo[];
  onSubmit: (pin: string) => void;
  onDeny: () => void;
  error?: string;
}

const EXPIRED_SHARING_PREVIEW_MESSAGE =
  "This sharing preview has expired. Deny it and ask for a fresh preview.";

function ShareMemoryProveItDetail({
  preview,
  now,
}: {
  preview: ShareMemoryApprovalPreview;
  now: number;
}) {
  if (preview.projection) {
    const projection = preview.projection;
    if (projection.expiresAt !== undefined && projection.expiresAt <= now) {
      return (
        <div className="mt-2 rounded-md border border-border bg-background-element/80 px-3 py-2 text-xs text-foreground-muted">
          {EXPIRED_SHARING_PREVIEW_MESSAGE}
        </div>
      );
    }
    return (
      <div
        className="mt-2 space-y-2 rounded-md border border-border bg-background-element/80 px-3 py-2 text-xs text-foreground-muted"
        data-testid="share-memory-projection-preview"
      >
        <div className="font-semibold text-foreground">
          A NEW Memory copy will be created in the destination Room.
        </div>
        <div>
          <span className="font-medium text-foreground">Destination Room: </span>
          {projection.roomLabel} · {projection.roomKind.replaceAll("_", " ")} · {projection.memberCount} visible {projection.memberCount === 1 ? "member" : "members"}
        </div>
        <div
          className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background-panel px-2 py-1.5 text-foreground"
          aria-label="Exact projected Memory content"
          data-testid="share-memory-projection-content"
        >
          {projection.content}
        </div>
        {projection.audienceWarning ? (
          <div className="text-[var(--warning)]" aria-label="Destination audience warning">
            {projection.audienceWarning}
          </div>
        ) : null}
      </div>
    );
  }

  const sens =
    preview.sensitivity === "sensitive"
      ? "The agent marked this share as sensitive, so Nautilo needs proof of identity."
      : "The agent marked this share as normal.";
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-background-element/80 px-3 py-2 text-xs text-foreground-muted">
      <div className="font-semibold text-foreground">
        Share memory with @{preview.targetHandle} ({preview.targetDisplayName})
      </div>
      <div>
        <span className="font-medium text-foreground">Memory: </span>
        {preview.memoryContentSnippet}
        {preview.memoryType ? (
          <span className="ml-2 rounded bg-background-panel px-1.5 py-0.5 text-[10px] uppercase">
            {preview.memoryType}
          </span>
        ) : null}
      </div>
      {preview.wouldCreate ? (
        <div className="text-[var(--warning)]">
          This will create a new room &apos;{preview.roomLabel ?? "…"}&apos;. They will see it in
          their sidebar.
        </div>
      ) : (
        <div>Will attach to existing room &apos;{preview.roomLabel ?? "…"}&apos;.</div>
      )}
      <div>{sens}</div>
    </div>
  );
}

export function ApprovalDialog({
  tools,
  onSubmit,
  onDeny,
  error,
}: ApprovalDialogProps) {
  const [pin, setPin] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [actionInFlight, setActionInFlight] = useState(false);
  const actionInFlightRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const projectionExpiries = tools.flatMap((tool) => {
    const expiresAt = tool.shareMemoryPreview?.projection?.expiresAt;
    return expiresAt === undefined ? [] : [expiresAt];
  });
  const projectionExpiryKey = projectionExpiries.join(":");

  useEffect(() => {
    setNow(Date.now());
  }, [projectionExpiryKey]);
  const nextProjectionExpiry = projectionExpiries
    .filter((expiresAt) => expiresAt > now)
    .reduce<number | undefined>(
      (earliest, expiresAt) => earliest === undefined ? expiresAt : Math.min(earliest, expiresAt),
      undefined,
    );
  useEffect(() => {
    if (nextProjectionExpiry === undefined) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextProjectionExpiry - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [nextProjectionExpiry]);

  useEffect(() => {
    if (error === undefined) return;
    actionInFlightRef.current = false;
    setActionInFlight(false);
  }, [error]);

  const hasExpiredProjection = tools.some((tool) => {
    const expiresAt = tool.shareMemoryPreview?.projection?.expiresAt;
    return expiresAt !== undefined && expiresAt <= now;
  });
  const canSubmit = pin.length >= 6 && !hasExpiredProjection;

  const beginAction = useCallback((action: () => void) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionInFlight(true);
    try {
      action();
    } catch (actionError) {
      actionInFlightRef.current = false;
      setActionInFlight(false);
      throw actionError;
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        beginAction(onDeny);
      } else if (e.key === "Enter" && canSubmit) {
        e.preventDefault();
        beginAction(() => onSubmit(pin));
      }
    },
    [pin, canSubmit, onSubmit, onDeny, beginAction],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, "").slice(0, 8);
    setPin(val);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-accent">Prove It</h2>
          <button
            onClick={() => beginAction(onDeny)}
            disabled={actionInFlight}
            className="rounded p-1 text-foreground-muted hover:text-foreground"
            aria-label="Deny"
          >
            ✕
          </button>
        </div>

        <p className="mt-3 text-sm text-foreground-muted">
          {tools.length === 1
            ? "The assistant wants to run a destructive action:"
            : `The assistant wants to run ${tools.length} destructive actions:`}
        </p>

        <ul className="mt-2 space-y-2">
          {tools.map((tool, i) => (
            <li
              key={tool.id ?? i}
              className="rounded bg-background-element px-3 py-1.5 font-mono text-xs text-foreground"
            >
              {tool.name === "share_memory" && tool.shareMemoryPreview ? (
                <ShareMemoryProveItDetail preview={tool.shareMemoryPreview} now={now} />
              ) : (
                formatToolPreview(tool)
              )}
            </li>
          ))}
        </ul>

        <p className="mt-4 text-sm text-foreground-muted">
          Enter your PIN to approve
        </p>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          onChange={handleChange}
          placeholder="••••••"
          className="mt-2 w-full rounded-md border border-border bg-background-element px-3 py-2 text-center text-lg tracking-[0.3em] text-foreground placeholder:text-foreground-disabled focus:border-border-interactive focus:outline-none"
          autoComplete="off"
        />

        {error && (
          <p className="mt-2 text-sm text-error">{error}</p>
        )}

        <p className="mt-2 text-xs text-foreground-dim">
          {pin.length < 6 ? "Type 6–8 digits" : "Enter to approve · Esc to deny"}
        </p>

        <div className="mt-5 flex gap-3">
          <button
            onClick={() => beginAction(onDeny)}
            disabled={actionInFlight}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element"
          >
            Deny
          </button>
          <button
            onClick={() => canSubmit && beginAction(() => onSubmit(pin))}
            disabled={!canSubmit || actionInFlight}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
