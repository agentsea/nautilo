import type { ReactNode } from "react";

export function ConnectionGroup({
  id,
  title,
  description,
  summary,
  actions,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly summary?: string | null;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} tabIndex={-1} className="scroll-mt-6 flex flex-col gap-3 border-t border-border pt-5 outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-1">
        <div>
          <h2 id={`${id}-title`} className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-foreground-dim">{description}</p>
        </div>
        {summary || actions ? <div className="flex items-center gap-2">
          {summary ? <p className="text-xs text-foreground-muted">{summary}</p> : null}
          {actions}
        </div> : null}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}
