import { expect, test } from "bun:test";

import { createBrowserAppLifecycle } from "./app-lifecycle.web";

test("browser lifecycle shares one listener set and emits distinct visibility/online edges", () => {
  const documentListeners = new Set<() => void>();
  const windowListeners = new Map<string, Set<() => void>>();
  let visibilityState: "hidden" | "visible" = "visible";
  let focused = true;
  let online = true;
  const lifecycle = createBrowserAppLifecycle({
    document: {
      get visibilityState() { return visibilityState; },
      hasFocus: () => focused,
      addEventListener: (_event, listener) => { documentListeners.add(listener); },
      removeEventListener: (_event, listener) => { documentListeners.delete(listener); },
    },
    window: {
      addEventListener: (event, listener) => {
        const listeners = windowListeners.get(event) ?? new Set();
        listeners.add(listener);
        windowListeners.set(event, listeners);
      },
      removeEventListener: (event, listener) => { windowListeners.get(event)?.delete(listener); },
    },
    navigator: { get onLine() { return online; } },
  });
  const first: string[] = [];
  const second: string[] = [];
  const a = lifecycle.addEventListener("change", (state) => first.push(state));
  const b = lifecycle.addEventListener("change", (state) => second.push(state));
  expect(documentListeners.size).toBe(1);
  expect(windowListeners.get("online")?.size).toBe(1);

  online = false;
  windowListeners.get("offline")?.forEach((listener) => listener());
  windowListeners.get("offline")?.forEach((listener) => listener());
  online = true;
  windowListeners.get("online")?.forEach((listener) => listener());
  focused = false;
  windowListeners.get("blur")?.forEach((listener) => listener());
  visibilityState = "hidden";
  documentListeners.forEach((listener) => listener());

  expect(first).toEqual(["background", "active", "inactive", "background"]);
  expect(second).toEqual(first);
  a.remove();
  expect(documentListeners.size).toBe(1);
  b.remove();
  expect(documentListeners.size).toBe(0);
  expect(windowListeners.get("online")?.size).toBe(0);
});

test("offline and visibility edges do not install a second browser lifecycle authority", () => {
  const documentListeners = new Set<() => void>();
  const windowListeners = new Map<string, Set<() => void>>();
  let visibilityState: "hidden" | "visible" = "visible";
  let online = true;
  const lifecycle = createBrowserAppLifecycle({
    document: {
      get visibilityState() { return visibilityState; },
      addEventListener: (_event, listener) => { documentListeners.add(listener); },
      removeEventListener: (_event, listener) => { documentListeners.delete(listener); },
    },
    window: {
      addEventListener: (event, listener) => {
        const listeners = windowListeners.get(event) ?? new Set();
        listeners.add(listener);
        windowListeners.set(event, listeners);
      },
      removeEventListener: (event, listener) => { windowListeners.get(event)?.delete(listener); },
    },
    navigator: { get onLine() { return online; } },
  });
  const seen: string[] = [];
  const subscription = lifecycle.addEventListener("change", (state) => seen.push(state));
  expect(documentListeners.size).toBe(1);
  expect(windowListeners.get("offline")?.size).toBe(1);
  expect(windowListeners.get("online")?.size).toBe(1);

  online = false;
  windowListeners.get("offline")?.forEach((listener) => listener());
  visibilityState = "hidden";
  documentListeners.forEach((listener) => listener());
  online = true;
  windowListeners.get("online")?.forEach((listener) => listener());
  visibilityState = "visible";
  documentListeners.forEach((listener) => listener());

  expect(seen).toEqual(["background", "active"]);
  subscription.remove();
});
