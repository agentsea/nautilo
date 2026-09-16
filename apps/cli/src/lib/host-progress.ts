import type { HostInterruptController } from "@nautilo/hosting";

/** CLI-only adapter: the shared event/polling contract lives in @nautilo/hosting. */
export interface HostSignalRegistrar {
  once(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
}

/** A caller-scoped SIGINT listener; dispose removes only this operation's listener. */
export function createScopedHostInterruptController(registrar: HostSignalRegistrar): HostInterruptController {
  let wasInterrupted = false;
  const controller = new AbortController();
  const handler = () => { wasInterrupted = true; controller.abort(); };
  registrar.once("SIGINT", handler);
  return {
    interrupted: () => wasInterrupted,
    signal: controller.signal,
    dispose: () => { registrar.removeListener("SIGINT", handler); },
  };
}
