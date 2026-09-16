/**
 * Context-panel collapse chevron (D077 accordion).
 *
 * Small chevron button anchored absolute top-left of the trailing
 * panel's `<aside>` wrapper. Clicking it collapses the panel. When
 * collapsed, the PanelEdgeStrip at the right viewport edge handles
 * restoration.
 *
 * Lives as a separate component rather than being inlined in the
 * shell because the normal context-panel `<aside>` currently has no
 * header row — adding the chevron as an overlay keeps ContextPanel
 * unaware of the surrounding layout machinery. Reader mode reuses the
 * same chevron with chat-specific labels.
 */

interface Props {
  onCollapse: () => void;
  label?: string;
}

export function ContextPanelCollapseChevron({
  onCollapse,
  label = "Hide context panel",
}: Props) {
  return (
    <button
      type="button"
      onClick={onCollapse}
      aria-label={label}
      title={`${label} (⌘⇧I)`}
      className="absolute left-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-md text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground transition-colors"
    >
      <span aria-hidden="true" className="text-sm leading-none">
        ›
      </span>
    </button>
  );
}
