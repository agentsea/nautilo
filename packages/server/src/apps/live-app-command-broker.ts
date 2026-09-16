import { randomUUID } from "node:crypto";
import type { LiveDocumentVersion } from "@nautilo/types";

export type LiveAppCommand = {
  requestId: string;
  documentVersion: LiveDocumentVersion;
  deadline: number;
  command: unknown;
};
export type LiveAppCommandResult =
  | { status: "completed"; result: unknown }
  | { status: "unavailable" | "busy"; stateChanged: false; retrySafe: false }
  | { status: "unknown"; stateChanged: "unknown"; retrySafe: false };

/** No queue, history, broadcast or replay. One receiver and command per live editor. */
export class LiveAppCommandBroker {
  private receivers = new Map<string, (command: LiveAppCommand | null) => void>();
  private commands = new Map<string, { requestId: string; finish: (result: LiveAppCommandResult) => void }>();

  listen(sessionId: string, signal: AbortSignal): Promise<LiveAppCommand | null> {
    if (signal.aborted || this.receivers.has(sessionId)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (command: LiveAppCommand | null) => {
        if (this.receivers.get(sessionId) === finish) this.receivers.delete(sessionId);
        signal.removeEventListener("abort", abort);
        resolve(command);
      };
      const abort = () => finish(null);
      this.receivers.set(sessionId, finish);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  invoke(sessionId: string, input: Omit<LiveAppCommand, "requestId">, signal: AbortSignal): Promise<LiveAppCommandResult> {
    if (signal.aborted || input.deadline <= Date.now()) return Promise.resolve({ status: "unavailable", stateChanged: false, retrySafe: false });
    if (this.commands.has(sessionId)) return Promise.resolve({ status: "busy", stateChanged: false, retrySafe: false });
    const receiver = this.receivers.get(sessionId);
    if (!receiver) return Promise.resolve({ status: "unavailable", stateChanged: false, retrySafe: false });
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (result: LiveAppCommandResult) => {
        if (this.commands.get(sessionId)?.requestId !== requestId) return;
        this.commands.delete(sessionId);
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => finish({ status: "unknown", stateChanged: "unknown", retrySafe: false });
      this.commands.set(sessionId, { requestId, finish });
      signal.addEventListener("abort", abort, { once: true });
      receiver({ ...input, requestId });
    });
  }

  complete(sessionId: string, requestId: string, result: unknown): boolean {
    const pending = this.commands.get(sessionId);
    if (!pending || pending.requestId !== requestId) return false;
    pending.finish({ status: "completed", result });
    return true;
  }

  close(sessionId: string): void {
    this.receivers.get(sessionId)?.(null);
    this.commands.get(sessionId)?.finish({ status: "unknown", stateChanged: "unknown", retrySafe: false });
  }
}

export const liveAppCommandBroker = new LiveAppCommandBroker();
