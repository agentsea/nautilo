import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, MessagesSquare } from "lucide-react";
import { useCan } from "../../hooks/use-can";
import { DESTINATION_RAIL_ITEMS, PRIMARY_RAIL_ITEMS, UTILITY_RAIL_ITEMS, type RailActionId } from "./rail-items";

/** The rail's destinations remain reachable when its column is hidden. */
export function CompactNavigation({ verified, onHome, onAction }: {
  verified: boolean;
  onHome: () => void;
  onAction: (id: RailActionId) => void;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const location = useLocation();
  const can = useCan();
  const close = () => { if (disclosure.current) disclosure.current.open = false; };

  useEffect(close, [location.key]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && disclosure.current?.open) {
        event.preventDefault();
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const itemClass = "flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm hover:bg-background-element focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]";
  return <details ref={disclosure} className="relative">
    <summary ref={trigger} aria-label="Navigation menu" className="flex cursor-pointer list-none items-center gap-1 rounded border border-border px-2 py-1 text-sm hover:bg-background-element [&::-webkit-details-marker]:hidden">
      <Menu className="h-4 w-4" aria-hidden="true" /><span className="hidden min-[400px]:inline">Menu</span>
    </summary>
    <nav aria-label="Primary navigation" className="absolute left-0 top-full z-50 mt-2 max-h-[calc(100dvh-5rem)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-border bg-background-panel p-2 shadow-lg">
      <button type="button" className={itemClass} onClick={() => { close(); onHome(); }}>
        <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden="true" /> Chats
      </button>
      {[...PRIMARY_RAIL_ITEMS, ...DESTINATION_RAIL_ITEMS, ...UTILITY_RAIL_ITEMS].map(item => {
        if (item.requiresAnyCap && !item.requiresAnyCap.some(cap => can(cap))) return null;
        if (item.kind === "route" && item.verifiedOnly && !verified) return null;
        const Icon = item.Icon;
        const label = <><Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{item.label}</>;
        return item.kind === "route"
          ? <Link key={item.id} to={item.route} className={itemClass} onClick={close}
              aria-current={location.pathname === item.route || location.pathname.startsWith(`${item.route}/`) ? "page" : undefined}>{label}</Link>
          : <button key={item.id} type="button" className={itemClass} onClick={() => { close(); onAction(item.id); }}>{label}</button>;
      })}
    </nav>
  </details>;
}
