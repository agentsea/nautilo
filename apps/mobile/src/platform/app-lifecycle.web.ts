import type {
  AppLifecycle,
  AppLifecycleState,
  AppLifecycleSubscription,
} from "./app-lifecycle";

interface BrowserDocument {
  readonly visibilityState: "hidden" | "visible" | "prerender";
  readonly hasFocus?: () => boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

interface BrowserWindow {
  addEventListener(type: "focus" | "blur" | "online" | "offline", listener: () => void): void;
  removeEventListener(type: "focus" | "blur" | "online" | "offline", listener: () => void): void;
}

interface BrowserNavigator {
  readonly onLine: boolean;
}

export interface BrowserLifecycleEnvironment {
  readonly document: BrowserDocument | null;
  readonly window: BrowserWindow | null;
  readonly navigator: BrowserNavigator | null;
}

/**
 * One browser lifecycle authority shared by realtime and event-stream owners.
 * Hidden or offline pages suspend foreground transports; becoming visible,
 * focused, and online emits one active edge without creating a new authority.
 */
export function createBrowserAppLifecycle(
  environment: BrowserLifecycleEnvironment,
): AppLifecycle {
  const listeners = new Set<(state: AppLifecycleState) => void>();
  let installed = false;
  let lastState: AppLifecycleState = snapshot(environment);

  const publish = () => {
    const next = snapshot(environment);
    if (next === lastState) return;
    lastState = next;
    for (const listener of listeners) listener(next);
  };

  const install = () => {
    if (installed) return;
    installed = true;
    environment.document?.addEventListener("visibilitychange", publish);
    for (const event of ["focus", "blur", "online", "offline"] as const) {
      environment.window?.addEventListener(event, publish);
    }
  };

  const uninstall = () => {
    if (!installed || listeners.size > 0) return;
    installed = false;
    environment.document?.removeEventListener("visibilitychange", publish);
    for (const event of ["focus", "blur", "online", "offline"] as const) {
      environment.window?.removeEventListener(event, publish);
    }
  };

  return {
    currentState: () => snapshot(environment),
    addEventListener(_event, listener): AppLifecycleSubscription {
      listeners.add(listener);
      install();
      const current = snapshot(environment);
      lastState = current;
      return {
        remove() {
          listeners.delete(listener);
          uninstall();
        },
      };
    },
  };
}

function snapshot(environment: BrowserLifecycleEnvironment): AppLifecycleState {
  if (!environment.document || !environment.window) return "background";
  if (environment.navigator?.onLine === false) return "background";
  if (environment.document.visibilityState !== "visible") return "background";
  return environment.document.hasFocus?.() === false ? "inactive" : "active";
}

export const appLifecycle = createBrowserAppLifecycle({
  document: typeof document === "undefined" ? null : document,
  window: typeof window === "undefined" ? null : window,
  navigator: typeof navigator === "undefined" ? null : navigator,
});
