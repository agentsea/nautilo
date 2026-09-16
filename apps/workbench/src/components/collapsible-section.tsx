import { ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

function readExpanded(storageKey: string | null | undefined, fallback: boolean): boolean {
  if (!storageKey || typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    /* localStorage can be unavailable in restricted contexts. */
  }
  return fallback;
}

function writeExpanded(storageKey: string | null | undefined, expanded: boolean): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, expanded ? "1" : "0");
  } catch {
    /* localStorage can be unavailable in restricted contexts. */
  }
}

export function CollapsibleSection({
  title,
  count,
  storageKey,
  defaultExpanded = true,
  forceExpanded = false,
  icon,
  testId,
  children,
}: {
  title: string;
  count?: number;
  storageKey?: string | null;
  defaultExpanded?: boolean;
  forceExpanded?: boolean;
  icon?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(() => readExpanded(storageKey, defaultExpanded));

  useEffect(() => {
    setExpanded(readExpanded(storageKey, defaultExpanded));
  }, [defaultExpanded, storageKey]);

  const visible = forceExpanded || expanded;

  return (
    <section data-testid={testId} className="mb-2">
      <button
        type="button"
        aria-expanded={visible}
        data-testid={testId ? `${testId}-toggle` : undefined}
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          writeExpanded(storageKey, next);
        }}
        className="mb-1 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          className={["h-3 w-3 transition-transform", visible ? "rotate-90" : ""].join(" ")}
        />
        {icon}
        <span className="min-w-0 flex-1 truncate">
          {title}
          {count !== undefined ? ` (${count})` : ""}
        </span>
      </button>
      {visible ? children : null}
    </section>
  );
}
