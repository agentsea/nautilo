import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDrawer } from "../drawer-state.tsx";

export interface DrawerShellProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Override the room drawer close action for temporary shell-owned surfaces. */
  onClose?: () => void;
}

export function DrawerShell({ title, actions, children, onClose }: DrawerShellProps) {
  const drawer = useDrawer();
  const close = onClose ?? drawer.close;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-background px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded p-1 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
            title="Close drawer (Esc)"
            aria-label={`Close ${title}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
