import { AsyncLocalStorage } from "node:async_hooks";
import type { InitiatingClientSurfaceV1 } from "@nautilo/types";

const initiatingClientSurfaceStorage = new AsyncLocalStorage<InitiatingClientSurfaceV1>();

/** Closed server-declared surface for the current exact main-turn execution. */
export function getCurrentInitiatingClientSurface(): InitiatingClientSurfaceV1 {
  return initiatingClientSurfaceStorage.getStore() ?? "unknown";
}

/** Bind a trusted surface declaration to process-local execution only. */
export function runWithInitiatingClientSurface<T>(
  surface: InitiatingClientSurfaceV1,
  fn: () => Promise<T>,
): Promise<T> {
  return initiatingClientSurfaceStorage.run(surface, fn);
}
