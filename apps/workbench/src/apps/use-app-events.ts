import { useEffect, useRef } from "react";
import type { MiniAppSourceEvent } from "@nautilo/api-client/browser";
import { apiClient } from "../lib/api";

export function useAppEvents(handler: (event: MiniAppSourceEvent) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let unsub: (() => void) | null = null;
    try {
      unsub = apiClient.subscribeMiniAppEvents((event) => handlerRef.current(event));
    } catch {
      // EventSource unavailable or missing auth token — live reload stays off.
    }
    return () => {
      unsub?.();
    };
  }, []);
}
