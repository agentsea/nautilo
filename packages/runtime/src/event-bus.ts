import { EventEmitter } from "node:events";
import type { ServerEvent } from "@nautilo/types";

/**
 * Typed event bus for the OSS (single-instance) runtime.
 * This is the JOB_MODE=local path from the architecture doc.
 *
 * Every job emits through this; the server subscribes and bridges to WebSocket.
 */
class NautiloEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  /** Internal invalidation hint; current owners re-read authority themselves. */
  invalidateTaskLocalExecutionSources() {
    this.emitter.emit("task-local-execution-source-changed");
  }

  onTaskLocalExecutionSourceChanged(handler: () => void) {
    this.emitter.on("task-local-execution-source-changed", handler);
  }

  offTaskLocalExecutionSourceChanged(handler: () => void) {
    this.emitter.off("task-local-execution-source-changed", handler);
  }

  emit(event: ServerEvent) {
    this.emitter.emit("event", event);
  }

  on(handler: (event: ServerEvent) => void) {
    this.emitter.on("event", handler);
  }

  off(handler: (event: ServerEvent) => void) {
    this.emitter.off("event", handler);
  }
}

export const eventBus = new NautiloEventBus();
