import type { NautiloApiClient } from "@nautilo/api-client/browser";

type CommitContentAccess = NautiloApiClient["commitContentAccess"];
export type PendingContentAccessCommand = Parameters<CommitContentAccess>[0];

export interface ContentAccessPendingScope {
  readonly serverOrigin: string;
  readonly userId: string;
  readonly roomId: string;
}

export interface PendingContentAccessOperation {
  readonly command: PendingContentAccessCommand;
  readonly previewToken: string;
}

export interface ContentAccessPendingSubject {
  readonly kind: "memory" | "artifact";
  readonly id: string;
}

export interface ContentAccessPendingOperationsPort {
  restore(subjects: readonly ContentAccessPendingSubject[]): PendingContentAccessOperation[];
  execute<T>(
    operation: PendingContentAccessOperation,
    dispatch: () => Promise<T>,
    discardOnError: (error: unknown) => boolean,
  ): Promise<T>;
}

interface PendingRecord {
  readonly v: 1;
  readonly serverOrigin: string;
  readonly userId: string;
  readonly roomId: string;
  readonly command: PendingContentAccessCommand;
  readonly previewToken: string;
}

interface StoragePort {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface LockManagerPort {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object | null) => Promise<T>,
  ): Promise<T>;
}

const STORAGE_PREFIX = "nautilo.content-access.pending.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sameTabListeners = new Set<(key: string) => void>();
const activeSameTabDispatches = new Set<string>();

export class ContentAccessPendingOperationError extends Error {
  constructor(message: string, readonly beforeDispatch = false) {
    super(message);
    this.name = "ContentAccessPendingOperationError";
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.origin === value;
  } catch {
    return false;
  }
}

function parseObject(value: unknown): ContentAccessPendingSubject | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2) return null;
  if ((candidate.kind !== "memory" && candidate.kind !== "artifact") || !validUuid(candidate.id)) return null;
  return { kind: candidate.kind, id: candidate.id };
}

function parseChange(value: unknown): PendingContentAccessCommand["change"] | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "make_private" && Object.keys(candidate).length === 1) {
    return { kind: "make_private" };
  }
  if ((candidate.kind === "grant_room" || candidate.kind === "detach_room")
    && Object.keys(candidate).length === 2 && validUuid(candidate.targetRoomId)) {
    return { kind: candidate.kind, targetRoomId: candidate.targetRoomId };
  }
  if (candidate.kind === "remove_person" && Object.keys(candidate).length === 2
    && validUuid(candidate.actorId)) {
    return { kind: "remove_person", actorId: candidate.actorId };
  }
  if (candidate.kind === "grant_people" && Object.keys(candidate).length === 2
    && Array.isArray(candidate.selectedActorIds) && candidate.selectedActorIds.length > 0
    && candidate.selectedActorIds.every(validUuid)) {
    return { kind: "grant_people", selectedActorIds: [...candidate.selectedActorIds] };
  }
  return null;
}

function parseCommand(value: unknown): PendingContentAccessCommand | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 3 || !validUuid(candidate.operationId)) return null;
  const object = parseObject(candidate.object);
  const change = parseChange(candidate.change);
  return object && change ? {
    operationId: candidate.operationId,
    object: object as PendingContentAccessCommand["object"],
    change,
  } : null;
}

function parseRecord(raw: string): PendingRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 6 || candidate.v !== 1
    || !validOrigin(candidate.serverOrigin)
    || typeof candidate.userId !== "string" || candidate.userId.length === 0
    || !validUuid(candidate.roomId)
    || typeof candidate.previewToken !== "string" || candidate.previewToken.length === 0) return null;
  const command = parseCommand(candidate.command);
  return command ? {
    v: 1,
    serverOrigin: candidate.serverOrigin,
    userId: candidate.userId,
    roomId: candidate.roomId,
    command,
    previewToken: candidate.previewToken,
  } : null;
}

function subjectKey(scope: ContentAccessPendingScope, subject: ContentAccessPendingSubject): string {
  return [STORAGE_PREFIX, scope.serverOrigin, scope.userId, scope.roomId, subject.kind, subject.id]
    .map(encodeURIComponent)
    .join(":");
}

function scopePrefix(scope: ContentAccessPendingScope): string {
  return [STORAGE_PREFIX, scope.serverOrigin, scope.userId, scope.roomId]
    .map(encodeURIComponent)
    .join(":") + ":";
}

function sameOperation(left: PendingContentAccessOperation, right: PendingContentAccessOperation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class BrowserContentAccessPendingOperations implements ContentAccessPendingOperationsPort {
  constructor(
    private readonly scope: ContentAccessPendingScope,
    private readonly storage: StoragePort | null,
    private readonly locks: LockManagerPort | null,
  ) {
    if (!validOrigin(scope.serverOrigin) || scope.userId.length === 0 || !validUuid(scope.roomId)) {
      throw new ContentAccessPendingOperationError(
        "Access recovery is unavailable for this server or account. Reopen Manage access after reconnecting.",
      );
    }
  }

  restore(subjects: readonly ContentAccessPendingSubject[]): PendingContentAccessOperation[] {
    if (!this.storage) {
      throw new ContentAccessPendingOperationError(
        "Access changes cannot be safely saved in this browser. Enable site storage and reopen Manage access.",
      );
    }
    const restored: PendingContentAccessOperation[] = [];
    for (const subject of subjects) {
      let raw: string | null;
      try {
        raw = this.storage.getItem(subjectKey(this.scope, subject));
      } catch {
        throw new ContentAccessPendingOperationError(
          "Access changes cannot be safely read in this browser. Enable site storage and reopen Manage access.",
        );
      }
      if (raw === null) continue;
      const record = parseRecord(raw);
      if (!record || record.serverOrigin !== this.scope.serverOrigin
        || record.userId !== this.scope.userId || record.roomId !== this.scope.roomId
        || record.command.object.kind !== subject.kind || record.command.object.id !== subject.id) {
        throw new ContentAccessPendingOperationError(
          "Saved access recovery details could not be verified. Do not repeat the access change; reconnect and retry verification.",
        );
      }
      restored.push({ command: record.command, previewToken: record.previewToken });
    }
    return restored;
  }

  list(): PendingContentAccessOperation[] {
    if (!this.storage) {
      throw new ContentAccessPendingOperationError(
        "Access changes cannot be safely read in this browser. Enable site storage and reopen Nautilo.",
      );
    }
    const prefix = scopePrefix(this.scope);
    const operations: PendingContentAccessOperation[] = [];
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key === null || !key.startsWith(prefix)) continue;
        const raw = this.storage.getItem(key);
        const record = raw === null ? null : parseRecord(raw);
        if (!record || record.serverOrigin !== this.scope.serverOrigin
          || record.userId !== this.scope.userId || record.roomId !== this.scope.roomId
          || subjectKey(this.scope, record.command.object) !== key) {
          throw new Error("invalid current-scope record");
        }
        operations.push({ command: record.command, previewToken: record.previewToken });
      }
    } catch {
      throw new ContentAccessPendingOperationError(
        "Saved access recovery details could not be verified. Do not repeat the access change; reconnect and retry verification.",
      );
    }
    return operations.sort((left, right) =>
      left.command.operationId.localeCompare(right.command.operationId));
  }

  subscribe(listener: () => void): () => void {
    const prefix = scopePrefix(this.scope);
    const receiveSameTab = (key: string): void => {
      if (key.startsWith(prefix)) listener();
    };
    const receiveStorage = (event: StorageEvent): void => {
      if (event.key?.startsWith(prefix)) listener();
    };
    sameTabListeners.add(receiveSameTab);
    if (typeof window !== "undefined") window.addEventListener("storage", receiveStorage);
    return () => {
      sameTabListeners.delete(receiveSameTab);
      if (typeof window !== "undefined") window.removeEventListener("storage", receiveStorage);
    };
  }

  isActivelyDispatching(operation: PendingContentAccessOperation): boolean {
    return activeSameTabDispatches.has(subjectKey(this.scope, operation.command.object));
  }

  async execute<T>(
    operation: PendingContentAccessOperation,
    dispatch: () => Promise<T>,
    discardOnError: (error: unknown) => boolean,
  ): Promise<T> {
    if (!this.storage || !this.locks) {
      throw new ContentAccessPendingOperationError(
        "Access changes cannot be safely saved in this browser. Enable site storage and try again.",
        true,
      );
    }
    const command = parseCommand(operation.command);
    if (!command || operation.previewToken.length === 0) {
      throw new ContentAccessPendingOperationError("The exact access operation cannot be safely recovered.", true);
    }
    const normalized = { command, previewToken: operation.previewToken };
    const key = subjectKey(this.scope, command.object);
    return this.locks.request(key, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) {
        throw new ContentAccessPendingOperationError(
          "This item's access is already being checked in another window. Wait for it to finish, then try again.",
          true,
        );
      }
      let existingRaw: string | null;
      try {
        existingRaw = this.storage!.getItem(key);
      } catch {
        throw new ContentAccessPendingOperationError("The saved access operation could not be read. No change was sent.", true);
      }
      if (existingRaw !== null) {
        const existing = parseRecord(existingRaw);
        if (!existing || existing.serverOrigin !== this.scope.serverOrigin
          || existing.userId !== this.scope.userId || existing.roomId !== this.scope.roomId
          || !sameOperation({ command: existing.command, previewToken: existing.previewToken }, normalized)) {
          throw new ContentAccessPendingOperationError(
            "A different access change is already awaiting verification for this item. Check that exact change first.",
            true,
          );
        }
      } else {
        const record: PendingRecord = { v: 1, ...this.scope, ...normalized };
        const serialized = JSON.stringify(record);
        try {
          this.storage!.setItem(key, serialized);
          if (this.storage!.getItem(key) !== serialized) throw new Error("write verification failed");
        } catch {
          throw new ContentAccessPendingOperationError(
            "The access change could not be saved for safe recovery. Free browser storage and try again; no change was sent.",
            true,
          );
        }
      }
      activeSameTabDispatches.add(key);
      for (const listener of sameTabListeners) listener(key);
      try {
        try {
          const result = await dispatch();
          this.removeExact(key, normalized);
          return result;
        } catch (error) {
          if (discardOnError(error)) this.removeExact(key, normalized);
          throw error;
        }
      } finally {
        activeSameTabDispatches.delete(key);
        for (const listener of sameTabListeners) listener(key);
      }
    });
  }

  private removeExact(key: string, operation: PendingContentAccessOperation): void {
    try {
      const raw = this.storage!.getItem(key);
      if (raw === null) return;
      const current = parseRecord(raw);
      if (!current || !sameOperation({ command: current.command, previewToken: current.previewToken }, operation)) {
        throw new Error("saved operation changed");
      }
      this.storage!.removeItem(key);
      if (this.storage!.getItem(key) !== null) throw new Error("remove verification failed");
      for (const listener of sameTabListeners) listener(key);
    } catch {
      throw new ContentAccessPendingOperationError(
        "The access result is known, but its local recovery record could not be cleared. Reopen Manage access and check it again before another change.",
      );
    }
  }
}

export function createBrowserContentAccessPendingOperations(
  scope: ContentAccessPendingScope,
): BrowserContentAccessPendingOperations {
  let storage: StoragePort | null = null;
  try {
    storage = typeof window === "undefined" ? null : window.localStorage;
  } catch {
    storage = null;
  }
  const locks = typeof navigator === "undefined" || navigator.locks === undefined
    ? null
    : navigator.locks as unknown as LockManagerPort;
  return new BrowserContentAccessPendingOperations(scope, storage, locks);
}
