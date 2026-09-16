import { type CSSProperties, type ReactNode } from "react";
import { NAUTILO_PRE_AUTH_LAYOUT_TOKENS } from "@nautilo/config/design-tokens";

export interface PreAuthShellProps {
  title: string;
  subtitle?: string;
  scrim?: "page" | "modal";
  children: ReactNode;
  testId?: string;
  onClose?: () => void;
}

function titleIdFor(title: string, testId?: string): string {
  if (testId) return `${testId}-title`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `pre-auth-${slug || "title"}`;
}

const preAuth = NAUTILO_PRE_AUTH_LAYOUT_TOKENS;

export function PreAuthShell({
  title,
  subtitle,
  scrim = "page",
  children,
  testId,
  onClose,
}: PreAuthShellProps) {
  const titleId = titleIdFor(title, testId);
  const modalMode = scrim === "modal";

  const contentStyle = {
    maxWidth: `${preAuth.content.maxWidth.$value}px`,
  } satisfies CSSProperties;

  const wordmarkStyle = {
    fontSize: `${preAuth.wordmark.fontSize.$value}px`,
    letterSpacing: `${preAuth.wordmark.letterSpacing.$value}px`,
    fontWeight: preAuth.wordmark.fontWeight.$value,
    marginBottom: `${preAuth.gap.wordmarkToHeadline.$value}px`,
  } satisfies CSSProperties;

  const headlineStyle = {
    fontSize: `${preAuth.headline.fontSize.$value}px`,
    letterSpacing: `${preAuth.headline.letterSpacing.$value}px`,
    fontWeight: preAuth.headline.fontWeight.$value,
  } satisfies CSSProperties;

  const subtitleStyle = {
    fontSize: `${preAuth.subtitle.fontSize.$value}px`,
    marginTop: `${preAuth.gap.headlineToSubtitle.$value}px`,
  } satisfies CSSProperties;

  const slotStyle = {
    marginTop: `${preAuth.gap.subtitleToContent.$value}px`,
  } satisfies CSSProperties;

  const contentClassName = modalMode
    ? "relative w-full rounded-lg border border-border-strong bg-background-panel p-6 text-center shadow-xl"
    : "w-full text-center";

  return (
    <div
      className={
        modalMode
          ? "fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
          : "fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-background-panel p-4"
      }
      data-testid={testId}
      role="dialog"
      aria-labelledby={titleId}
    >
      <div className={contentClassName} style={contentStyle}>
        {modalMode && onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 rounded p-1 text-foreground-muted hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        ) : null}
        <div
          className="text-foreground-muted uppercase"
          aria-hidden="true"
          style={wordmarkStyle}
        >
          Nautilo
        </div>
        <h1
          id={titleId}
          className="text-balance text-foreground"
          style={headlineStyle}
        >
          {title}
        </h1>
        {subtitle ? (
          <p
            className="mx-auto max-w-[34rem] text-pretty leading-relaxed text-foreground-muted"
            style={subtitleStyle}
          >
            {subtitle}
          </p>
        ) : null}
        <div style={slotStyle}>{children}</div>
      </div>
    </div>
  );
}
