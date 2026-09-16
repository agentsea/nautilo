import type { AppStatus } from "./app-registry";

export type AppSourceEvent =
  | { type: "changed"; appId: string; sourceHash: string }
  | { type: "status"; appId: string; status: Exclude<AppStatus, "ready"> };

type AppSourceEventListener = (event: AppSourceEvent) => void;

const listeners = new Set<AppSourceEventListener>();

export function subscribeAppSourceEvents(listener: AppSourceEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishAppSourceEvent(event: AppSourceEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

export function clearAppSourceEventListenersForTests(): void {
  listeners.clear();
}
