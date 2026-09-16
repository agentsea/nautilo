import type { NautiloApiClient } from "@nautilo/api-client/browser";
import {
  ContentAccessPendingOperationError,
  type ContentAccessPendingOperationsPort,
  type PendingContentAccessOperation,
} from "./content-access-pending-operations";

type GetContentAccess = NautiloApiClient["getContentAccess"];
type PrepareContentAccess = NautiloApiClient["prepareContentAccess"];
type CommitContentAccess = NautiloApiClient["commitContentAccess"];
type ContentAccessPrepareRequest = Parameters<PrepareContentAccess>[0];
type ContentAccessPreparedResponse = Awaited<ReturnType<PrepareContentAccess>>;
type ContentAccessNormalizedCommand = Parameters<CommitContentAccess>[0];
export type ContentAccessReceipt = Awaited<ReturnType<CommitContentAccess>>;
export type ContentAccessSummary = Awaited<ReturnType<GetContentAccess>>;
export type ContentAccessObject = Parameters<GetContentAccess>[0];
export type ContentAccessChange = ContentAccessPrepareRequest["change"];

export interface ContentAccessSubject {
  object: ContentAccessObject;
  label: string;
}

export type ContentAccessBatchEntry = Readonly<{
  subject: ContentAccessSubject;
  phase: "prepared" | "prepare_failed" | "retryable" | "needs_prepare" | "partial" | "complete" | "expired";
  preparation?: ContentAccessPreparedResponse;
  pendingOperation?: PendingContentAccessOperation;
  receipt?: ContentAccessReceipt;
  error?: string;
}>;

export interface ContentAccessControllerPort {
  getContentAccess(object: ContentAccessObject, options: { roomId: string; signal?: AbortSignal }): Promise<ContentAccessSummary>;
  prepareContentAccess(input: ContentAccessPrepareRequest, options: { roomId: string; signal?: AbortSignal }): Promise<ContentAccessPreparedResponse>;
  commitContentAccess(command: ContentAccessNormalizedCommand, previewToken: string,
    options: { roomId: string; signal?: AbortSignal }): Promise<ContentAccessReceipt>;
}

export class ContentAccessScopeChangedError extends Error {
  constructor() {
    super("Content access context changed; reopen Manage access.");
    this.name = "ContentAccessScopeChangedError";
  }
}

const unavailablePendingOperations: ContentAccessPendingOperationsPort = {
  restore() {
    throw new ContentAccessPendingOperationError(
      "Access changes cannot be safely recovered in this context. Reopen Manage access and try again.",
    );
  },
  execute() {
    return Promise.reject(new ContentAccessPendingOperationError(
      "Access changes cannot be safely saved in this context. No change was sent.",
    ));
  },
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Content access request failed.";
}

function recovery(error: unknown): "prepare_again" | "retry_operation" | "retry_receipt" | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { recovery?: unknown }).recovery;
  return value === "prepare_again" || value === "retry_operation" || value === "retry_receipt"
    ? value
    : null;
}

/** One dialog-scoped owner for cancellation, prepared-token retention, and exact-operation retries. */
export class ContentAccessController {
  private generation = 0;
  private abort = new AbortController();

  constructor(
    private readonly port: ContentAccessControllerPort,
    readonly roomId: string,
    private readonly now: () => number = () => Date.now(),
    private readonly operationId: () => string = () => crypto.randomUUID(),
    private readonly pendingOperations: ContentAccessPendingOperationsPort = unavailablePendingOperations,
  ) {}

  dispose(): void {
    this.generation += 1;
    this.abort.abort();
  }

  private async scoped<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = await run(this.abort.signal);
    if (generation !== this.generation || this.abort.signal.aborted) {
      throw new ContentAccessScopeChangedError();
    }
    return result;
  }

  load(subject: ContentAccessSubject): Promise<ContentAccessSummary> {
    return this.scoped((signal) => this.port.getContentAccess(subject.object, {
      roomId: this.roomId,
      signal,
    }));
  }

  restore(subjects: readonly ContentAccessSubject[]): ContentAccessBatchEntry[] {
    const byObject = new Map(subjects.map((subject) => [
      `${subject.object.kind}:${subject.object.id}`,
      subject,
    ]));
    return this.pendingOperations.restore(subjects.map((subject) => subject.object)).map(
      (pendingOperation): ContentAccessBatchEntry => {
        const subject = byObject.get(
          `${pendingOperation.command.object.kind}:${pendingOperation.command.object.id}`,
        );
        if (!subject) {
          throw new ContentAccessPendingOperationError(
            "A saved access recovery does not match the currently selected item.",
          );
        }
        return {
          subject,
          phase: "retryable",
          pendingOperation,
          error: "This access change was already submitted. Check its exact outcome before making another change.",
        };
      },
    );
  }

  async prepare(
    subjects: readonly ContentAccessSubject[],
    change: ContentAccessChange,
  ): Promise<ContentAccessBatchEntry[]> {
    return Promise.all(subjects.map(async (subject): Promise<ContentAccessBatchEntry> => {
      try {
        const preparation = await this.scoped((signal) => this.port.prepareContentAccess({
          operationId: this.operationId(),
          object: subject.object,
          change,
        }, { roomId: this.roomId, signal }));
        return { subject, phase: "prepared", preparation };
      } catch (error) {
        if (error instanceof ContentAccessScopeChangedError) throw error;
        return { subject, phase: "prepare_failed", error: message(error) };
      }
    }));
  }

  async commit(entries: readonly ContentAccessBatchEntry[]): Promise<ContentAccessBatchEntry[]> {
    return Promise.all(entries.map(async (entry): Promise<ContentAccessBatchEntry> => {
      if ((entry.phase !== "prepared" && entry.phase !== "retryable")
        || (!entry.preparation && !entry.pendingOperation)) {
        return entry;
      }
      // A first Apply is bounded by preview expiry. Once a commit has an
      // indeterminate outcome, retry the exact operation/token even after that
      // local deadline so the server can recover its durable receipt first.
      if (entry.phase === "prepared" && entry.preparation
        && this.now() >= entry.preparation.expiresAt) {
        return { ...entry, phase: "expired", error: "This preview expired. Prepare a fresh preview before applying." };
      }
      const pendingOperation = entry.pendingOperation ?? {
        command: entry.preparation!.command,
        previewToken: entry.preparation!.previewToken,
      };
      try {
        const receipt = await this.pendingOperations.execute(
          pendingOperation,
          () => this.scoped((signal) => this.port.commitContentAccess(
            pendingOperation.command,
            pendingOperation.previewToken,
            { roomId: this.roomId, signal },
          )),
          (error) => recovery(error) === "prepare_again",
        );
        return {
          subject: entry.subject,
          preparation: entry.preparation,
          receipt,
          phase: receipt.outcome === "partial" ? "partial" : "complete",
        };
      } catch (error) {
        if (error instanceof ContentAccessScopeChangedError) throw error;
        const beforeDispatch = error instanceof ContentAccessPendingOperationError
          && error.beforeDispatch;
        return {
          ...entry,
          pendingOperation,
          phase: recovery(error) === "prepare_again"
            ? "needs_prepare"
            : beforeDispatch && entry.phase === "prepared" ? "prepared" : "retryable",
          error: message(error),
        };
      }
    }));
  }
}
