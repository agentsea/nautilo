import type { HTMLAttributes, ReactNode } from "react";

export type SectionId =
  | "profile"
  | "this-mac"
  | "startup"
  | "my-agents"
  | "notifications"
  | "model"
  | "fallback"
  | "web-research"
  | "integrations"
  | "current-folder"
  | "your-access"
  | "desktop-permissions"
  | "workstation-access"
  | "devices"
  | "encrypted-recovery"
  | "mobile-access"
  | "invite-people"
  | "security"
  | "costs"
  | "about";

/**
 * Section wrapper. Renders an anchor target, header, optional description and
 * body. Settings sections should use this to stay visually consistent.
 */
export function SectionCard({
  id,
  title,
  description,
  children,
  actions,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      id={id}
      className="rounded-lg border border-border bg-background-panel"
      aria-labelledby={`${id}-title`}
    >
      <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
        <div>
          <h2 id={`${id}-title`} className="text-sm font-semibold">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-xs text-foreground-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/**
 * Shared form row — label on the left, input on the right. Width is capped so
 * text inputs stay readable.
 */
export function FieldRow({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-border/40 py-3 last:border-b-0 last:pb-0 first:pt-0 sm:grid-cols-[180px_1fr]">
      <div className="pt-1.5">
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium text-foreground"
        >
          {label}
        </label>
        {hint ? (
          <div className="mt-0.5 text-xs text-foreground-muted">{hint}</div>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Text input styled to match the workbench.
 */
export function TextInput({
  value,
  onChange,
  id,
  placeholder,
  disabled,
  readOnly,
  type = "text",
  ariaLabel,
  autoComplete,
  inputMode,
  onKeyDown,
}: {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  type?: "text" | "password" | "url";
  ariaLabel?: string;
  autoComplete?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      disabled={disabled}
      readOnly={readOnly}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoComplete={autoComplete}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className="w-full rounded-md border border-border bg-background-element px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-dim focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary read-only:bg-background-panel disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}

/**
 * Primary button used for "Save", "Apply", "Change". Variants mirror the
 * conversation composer for visual consistency.
 */
export function Button({
  children,
  onClick,
  disabled,
  loading,
  variant = "secondary",
  type = "button",
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  type?: "button" | "submit";
  title?: string;
  ariaLabel?: string;
}) {
  const styles =
    variant === "primary"
      ? "bg-primary text-[var(--on-primary)] hover:bg-primary-hover"
      : variant === "ghost"
        ? "bg-transparent text-foreground-muted hover:bg-background-element hover:text-foreground"
        : "border border-border bg-background-element text-foreground hover:border-border-strong";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      aria-label={ariaLabel}
      aria-busy={loading ? "true" : undefined}
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-[color,transform,opacity] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        styles,
      ].join(" ")}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}

/**
 * Guest gate placeholder for settings sections that would otherwise leak
 * owner data (profile, model, keys). Renders inside the section's
 * SectionCard body when the active session is unverified.
 *
 * M040 / multi-user TODO: today the workbench shows a single profile
 * row (the owner's) to whoever is signed in — fine when we have one
 * physical user, but as soon as guests can browse the app they see
 * the owner's name, handle, voice, federated address, and (for the
 * keys section) the configured-status of every provider key. That's
 * a privacy + credentials leak. When M040 lands and per-actor
 * profile rows + per-actor settings exist, the gate disappears:
 * each verified user sees their own data; guests see nothing
 * sensitive because there's nothing tied to them yet. Until then
 * this placeholder is the seam.
 *
 * `kind` differentiates the copy so high-sensitivity sections (keys
 * = credentials) can warn more strongly than low-sensitivity ones
 * (profile = identifying-but-not-secret).
 */
export function GuestPlaceholder({
  what,
  kind = "normal",
}: {
  /** What the placeholder is hiding, e.g. "Your profile" or
   *  "Provider API keys". Renders as the subject of the explanatory
   *  copy. */
  what: string;
  /** "normal" = identifying info (profile, model preference);
   *  "credentials" = secrets-adjacent (provider keys). Drives copy. */
  kind?: "normal" | "credentials";
}) {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-foreground-muted">
        You're signed in as{" "}
        <span className="font-medium text-foreground">Guest</span>.
      </p>
      <p className="text-foreground-muted">
        {kind === "credentials"
          ? `${what} contain credentials and are only visible to the verified owner.`
          : `${what} is hidden until you verify your identity — you're seeing this section's structure but not its contents.`}
      </p>
      <p className="text-xs text-foreground-muted">
        Send a message in the chat. Nautilo will prompt you for your PIN
        and unlock owner-level settings on success.
      </p>
    </div>
  );
}

/**
 * M129 — shown when the viewer IS signed in and verified but lacks the
 * Capability required for a section (vs `GuestPlaceholder`, which is for
 * unverified / guest viewers). Distinguishing the two avoids the "you're
 * a guest" lie for a verified member who simply isn't permitted. Purely
 * cosmetic — the server still enforces the gate.
 */
export function PermissionPlaceholder({
  what,
}: {
  /** What the placeholder is hiding, e.g. "Provider API keys". */
  what: string;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-foreground-muted">
        You don&apos;t have permission to view {what} on this server.
      </p>
      <p className="text-xs text-foreground-muted">
        This area is limited to administrators. Ask a server administrator
        if you believe you should have access.
      </p>
    </div>
  );
}

/**
 * Inline status pill used for key presence, save success, etc.
 */
export function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "error" | "info" | "muted";
  children: ReactNode;
}) {
  const toneClass =
    tone === "ok"
      ? "bg-[var(--success)]/15 text-[var(--success)]"
      : tone === "warn"
        ? "bg-[var(--warning)]/15 text-[var(--warning)]"
        : tone === "error"
          ? "bg-[var(--error)]/15 text-[var(--error)]"
          : tone === "info"
            ? "bg-primary/15 text-primary"
            : "bg-background-element text-foreground-muted";
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        toneClass,
      ].join(" ")}
    >
      {children}
    </span>
  );
}
