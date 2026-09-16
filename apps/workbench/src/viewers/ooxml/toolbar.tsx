import type { ButtonHTMLAttributes, ReactNode } from "react";

function ooxmlControlClassName(enabled = true): string {
  return `rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors ${
    enabled
      ? "text-foreground-muted hover:bg-background-element hover:text-foreground"
      : "cursor-not-allowed text-foreground-muted opacity-50"
  }`;
}

export function OoxmlToolbar({ children, label = "Preview controls" }: { children: ReactNode; label?: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2" role="toolbar" aria-label={label}>{children}</div>;
}

export function OoxmlControlGroup({ children, label }: { children: ReactNode; label: string }) {
  return <div className="flex items-center gap-1" role="group" aria-label={label}>{children}</div>;
}

export function OoxmlToolbarButton({
  children,
  enabled = true,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { enabled?: boolean }) {
  return <button type="button" disabled={!enabled} className={ooxmlControlClassName(enabled)} {...props}>{children}</button>;
}

export type FitMode = "page" | "width" | "manual";

export function OoxmlZoomControls({
  enabled,
  scale,
  fitMode,
  onZoomOut,
  onZoomIn,
  onFitModeChange,
  pageLabel = "Fit page",
}: {
  enabled: boolean;
  scale: number | null;
  fitMode: FitMode;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitModeChange: (mode: Exclude<FitMode, "manual">) => void;
  pageLabel?: string;
}) {
  return (
    <OoxmlControlGroup label="Zoom controls">
      <OoxmlToolbarButton enabled={enabled} onClick={onZoomOut} aria-label="Zoom out">−</OoxmlToolbarButton>
      {scale !== null ? <span className="min-w-10 text-center text-xs tabular-nums text-foreground-muted" aria-label={`Zoom ${Math.round(scale * 100)} percent`}>{Math.round(scale * 100)}%</span> : null}
      <OoxmlToolbarButton enabled={enabled} onClick={onZoomIn} aria-label="Zoom in">+</OoxmlToolbarButton>
      <select
        aria-label="Fit mode"
        disabled={!enabled}
        value={fitMode === "manual" ? "" : fitMode}
        onChange={(event) => {
          if (event.target.value === "page" || event.target.value === "width") onFitModeChange(event.target.value);
        }}
        className={`${ooxmlControlClassName(enabled)} bg-background-panel`}
      >
        <option value="" disabled>Fit</option>
        <option value="page">{pageLabel}</option>
        <option value="width">Fit width</option>
      </select>
    </OoxmlControlGroup>
  );
}
