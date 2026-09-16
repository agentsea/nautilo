import { ServersPanel } from "../modes/servers/ServersPanel";

export function ServerSwitcherOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switch server"
      data-testid="server-switcher-overlay"
      className="fixed inset-0 z-[120] flex items-stretch justify-start bg-black/40 p-3"
    >
      <div className="h-full w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border-strong bg-background-panel shadow-2xl">
        <ServersPanel onCollapse={onClose} />
      </div>
    </div>
  );
}
