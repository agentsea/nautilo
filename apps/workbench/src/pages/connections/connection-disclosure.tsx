import { useEffect, useId, useState } from "react";

const CONNECTION_DISCLOSURE_STORAGE_PREFIX = "nautilo.connections.disclosure.v1";

function storageKey(viewerKey: string, cardId: string): string {
  return `${CONNECTION_DISCLOSURE_STORAGE_PREFIX}:${viewerKey}:${cardId}`;
}

function readExpanded(viewerKey: string | null, cardId: string): boolean {
  if (!viewerKey || typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(storageKey(viewerKey, cardId)) !== "collapsed";
  } catch {
    return true;
  }
}

function writeExpanded(viewerKey: string | null, cardId: string, expanded: boolean): void {
  if (!viewerKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(viewerKey, cardId), expanded ? "expanded" : "collapsed");
  } catch {
    // Disclosure is a convenience preference. Private-mode/quota failures stay
    // local to this mounted card and must never interrupt its controller.
  }
}

export function connectionDisclosureStorageKey(viewerKey: string, cardId: string): string {
  return storageKey(viewerKey, cardId);
}

export function useConnectionDisclosure({
  cardId,
  viewerKey,
  forceOpen = false,
  routeHash,
  routeKey,
}: {
  readonly cardId: string;
  readonly viewerKey: string | null;
  readonly forceOpen?: boolean;
  readonly routeHash?: string;
  readonly routeKey?: string;
}) {
  const generatedId = useId();
  const detailsId = `${cardId}-connection-details-${generatedId.replace(/:/g, "")}`;
  const [ordinaryExpanded, setOrdinaryExpanded] = useState(() => readExpanded(viewerKey, cardId));
  const [hashTargetsCard, setHashTargetsCard] = useState(() =>
    (routeHash ?? (typeof window !== "undefined" ? window.location.hash : "")) === `#${cardId}`,
  );

  useEffect(() => {
    setOrdinaryExpanded(readExpanded(viewerKey, cardId));
  }, [cardId, viewerKey]);

  useEffect(() => {
    if (routeHash !== undefined) {
      setHashTargetsCard(routeHash === `#${cardId}`);
      return;
    }
    const updateHashTarget = () => setHashTargetsCard(window.location.hash === `#${cardId}`);
    updateHashTarget();
    window.addEventListener("hashchange", updateHashTarget);
    return () => window.removeEventListener("hashchange", updateHashTarget);
  }, [cardId, routeHash, routeKey]);

  const expanded = ordinaryExpanded || forceOpen || hashTargetsCard;
  const toggle = () => {
    // Forced-open states make recovery/action visible but never rewrite the
    // Human's ordinary choice. Once the condition resolves, that choice wins.
    if (forceOpen) return;
    // A card hash is a one-shot reveal, not a permanent lock. Once the Human
    // deliberately collapses the revealed card, keep the current URL intact
    // but release the reveal and remember the collapsed preference. A later
    // Router navigation to the same hash gets a new routeKey and reveals it
    // again.
    if (hashTargetsCard) {
      setHashTargetsCard(false);
      setOrdinaryExpanded(false);
      writeExpanded(viewerKey, cardId, false);
      return;
    }
    setOrdinaryExpanded((current) => {
      const next = !current;
      writeExpanded(viewerKey, cardId, next);
      return next;
    });
  };

  return { detailsId, expanded, toggle };
}

export function ConnectionDisclosureControl({
  expanded,
  detailsId,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly detailsId: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="rounded px-2 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground"
      aria-expanded={expanded}
      aria-controls={detailsId}
      onClick={onToggle}
    >
      {expanded ? "Collapse" : "Expand"}
    </button>
  );
}
