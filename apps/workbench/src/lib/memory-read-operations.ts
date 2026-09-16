import { ClassifiedDataOperationError, type EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";

import type { MemoryDetail, MemoryDetailResponse, MemoryListItem, MemoryMode } from "./memory-api";
import type {
  WorkbenchProtectedHumanMemoryOperations,
  WorkbenchProtectedMemory,
} from "./protected-human-memory-controller";

export type MemoryListOptions = Readonly<{
  cursor?: string;
  includeArchive?: boolean;
  person?: string;
  audience?: "private";
}>;

export interface WorkbenchMemoryReadOperations {
  list(options: MemoryListOptions): Promise<Readonly<{
    items: readonly MemoryListItem[];
    nextCursor: string | null;
    memoryMode: MemoryMode;
    total?: number;
  }>>;
  detail(memoryId: string): Promise<Readonly<{
    memory: MemoryDetail; memoryMode: MemoryMode;
    accessContext?: MemoryDetailResponse["accessContext"];
    actions: MemoryActionPresentation;
  }>>;
  search(options: Readonly<{ q: string; includeArchive?: boolean }>): Promise<readonly MemoryListItem[]>;
  brief(): Promise<string>;
  archive(memoryId: string): Promise<void>;
  revokeUser(memoryId: string, userHandle: string): Promise<void>;
  update(memoryId: string, input: Readonly<{ type: string; content: string; importance: number }>): Promise<unknown>;
  transitionTier(memoryId: string, action: "promote" | "demote"): Promise<unknown>;
  restore(memoryId: string): Promise<unknown>;
  delete(memoryId: string, confirmShared?: boolean): Promise<void>;
  grantUser(memoryId: string, userHandle: string): Promise<unknown>;
  makePrivate(memoryId: string): Promise<unknown>;
  retryPendingMutations(): Promise<void>;
  dispose(): Promise<void>;
}

export type MemoryActionPresentation = Readonly<{
  canManageAccess: boolean;
  canChangeTier: boolean;
  canEditContent: boolean;
  deletion: "permanent" | "authorized_view";
  retentionNotice: string;
}>;

type OrdinaryMemoryReads = Readonly<{
  list(options: MemoryListOptions): Promise<Readonly<{
    items: MemoryListItem[]; nextCursor: string | null; memoryMode: MemoryMode; total?: number;
  }>>;
  detail(memoryId: string): Promise<Readonly<{ memory: MemoryDetail; memoryMode: MemoryMode;
    accessContext?: MemoryDetailResponse["accessContext"] }>>;
  search(options: Readonly<{
    q: string; mode: "text" | "semantic"; includeArchive?: boolean;
  }>): Promise<Readonly<{ results: readonly Readonly<{
    id: string; type: string; content: string; importance: number; tier: number;
    createdAt: string;
  }>[] }>>;
  brief(): Promise<Readonly<{ brief: string }>>;
  archive?(memoryId: string): Promise<unknown>;
  revokeUser?(memoryId: string, userHandle: string): Promise<unknown>;
  update?(memoryId: string, input: { content?: string; importance?: number }): Promise<unknown>;
  delete?(memoryId: string, options?: { confirmShared?: boolean }): Promise<unknown>;
  grantUser?(memoryId: string, userHandle: string): Promise<unknown>;
  makePrivate?(memoryId: string): Promise<unknown>;
}>;

function row(value: WorkbenchProtectedMemory): MemoryListItem {
  const unavailable = value.content.status === "unavailable";
  return {
    id: value.id,
    type: unavailable ? "Unavailable" : value.content.type,
    content: unavailable
      ? `Protected content unavailable (${value.content.reason.replaceAll("_", " ")})`
      : value.content.content,
    importance: value.importance,
    tier: value.tier,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    namespaceIds: [...value.namespaceIds],
    ...(value.accessList === undefined ? {} : { accessList: value.accessList.map((entry) => ({ ...entry })) }),
  };
}

function protectedPort(
  get: () => WorkbenchProtectedHumanMemoryOperations | undefined,
): WorkbenchProtectedHumanMemoryOperations {
  const port = get();
  if (port === undefined) throw new ClassifiedDataOperationError(
    "key_waiting", "Protected Memory device custody is unavailable",
  );
  return port;
}

function protectedMutationPort(
  get: () => WorkbenchProtectedHumanMemoryOperations | undefined,
): WorkbenchProtectedHumanMemoryOperations {
  const port = get();
  if (port === undefined) throw new ClassifiedDataOperationError(
    "authority", "Protected Memory mutation requires admitted device custody",
  );
  return port;
}

function ordinaryOperation<Result>(
  operation: (() => Promise<Result>) | undefined,
): Promise<Result> {
  if (operation === undefined) throw new ClassifiedDataOperationError(
    "unsupported", "Ordinary Memory operation is unavailable",
  );
  return operation();
}

export function createWorkbenchMemoryReadOperations(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  ordinary: OrdinaryMemoryReads;
  protected: () => WorkbenchProtectedHumanMemoryOperations | undefined;
  disposeProtected?: () => Promise<void>;
  resolveEmbedding?: () => Promise<Readonly<{
    provider: "openai" | "openrouter" | "venice"; model: string;
  }>>;
}>): WorkbenchMemoryReadOperations {
  return Object.freeze({
    async list(options: MemoryListOptions) {
      const loaded = await input.owner.read({
        ordinary: () => input.ordinary.list(options),
        protected: async () => {
          const page = await protectedPort(input.protected).list(options);
          return { ...page, items: page.items.map(row) };
        },
        consumeOrdinary: (value) => value,
        consumeProtected: (value) => value,
      });
      return loaded.value;
    },
    async detail(memoryId: string) {
      const loaded = await input.owner.read({
        ordinary: async () => ({ ...(await input.ordinary.detail(memoryId)), contentOpened: true }),
        protected: async () => {
          const detail = await protectedPort(input.protected).detail(memoryId);
          return { ...detail, memory: { ...row(detail.memory), demotedAt: null, demotedFrom: null },
            contentOpened: detail.memory.content.status === "opened" };
        },
        consumeOrdinary: (value) => value,
        consumeProtected: (value) => value,
      });
      const actions = await input.owner.runMutation<MemoryActionPresentation>({
        ordinary: () => Promise.resolve(Object.freeze({ canManageAccess: true, canChangeTier: false,
          canEditContent: loaded.value.contentOpened,
            deletion: "permanent" as const,
            retentionNotice: "Archive hides from the agent · Delete removes permanently and re-indexes." })),
        dual: () => Promise.resolve(Object.freeze({ canManageAccess: true, canChangeTier: true,
          canEditContent: loaded.value.contentOpened,
            deletion: "authorized_view" as const,
            retentionNotice: "Archive hides from the agent · Removing from your library does not delete other authorized views." })),
        protected: () => Promise.resolve(Object.freeze({ canManageAccess: true, canChangeTier: true,
          canEditContent: loaded.value.contentOpened,
          deletion: "authorized_view" as const,
          retentionNotice: "Archive hides from the agent · Removing from your library does not delete other authorized views." })),
      });
      const { contentOpened: _contentOpened, ...detail } = loaded.value;
      return Object.freeze({ ...detail, actions });
    },
    async search(options: Readonly<{ q: string; includeArchive?: boolean }>) {
      return (await input.owner.read<MemoryListItem[], MemoryListItem[], readonly MemoryListItem[]>({
        ordinary: async () => {
          let result = await input.ordinary.search({ ...options, mode: "semantic" });
          if (result.results.length === 0) result = await input.ordinary.search({ ...options, mode: "text" });
          return result.results.map((item): MemoryListItem => ({
            ...item, updatedAt: item.createdAt, namespaceIds: [],
          }));
        },
        protected: async () => (await protectedPort(input.protected).search({
          ...options, mode: "semantic",
        })).items.map(row),
        consumeOrdinary: (value) => value,
        consumeProtected: (value) => value,
      })).value;
    },
    async brief() {
      return (await input.owner.read({
        ordinary: () => input.ordinary.brief(),
        protected: () => protectedPort(input.protected).brief(),
        consumeOrdinary: (value) => value.brief,
        consumeProtected: (value) => value.brief,
      })).value;
    },
    async archive(memoryId: string) {
      await input.owner.runMutation({
        ordinary: async () => { await ordinaryOperation(
          input.ordinary.archive === undefined ? undefined : () => input.ordinary.archive!(memoryId),
        ); },
        dual: async () => { await protectedMutationPort(input.protected).archive(memoryId); },
        protected: async () => { await protectedMutationPort(input.protected).archive(memoryId); },
      });
    },
    async revokeUser(memoryId: string, userHandle: string) {
      await input.owner.runMutation({
        ordinary: async () => { await ordinaryOperation(input.ordinary.revokeUser === undefined
          ? undefined : () => input.ordinary.revokeUser!(memoryId, userHandle)); },
        dual: async () => { await protectedMutationPort(input.protected).revokeUser(memoryId, userHandle); },
        protected: async () => { await protectedMutationPort(input.protected).revokeUser(memoryId, userHandle); },
      });
    },
    update(memoryId: string, edit: Readonly<{ type: string; content: string; importance: number }>) {
      return input.owner.runMutation({
        ordinary: () => ordinaryOperation(input.ordinary.update === undefined ? undefined : () =>
          input.ordinary.update!(memoryId, { content: edit.content, importance: edit.importance })),
        dual: async () => {
          const embedding = await input.resolveEmbedding?.();
          if (embedding === undefined) throw new ClassifiedDataOperationError("unsupported", "Memory embedding is unavailable");
          return protectedMutationPort(input.protected).update({ memoryId, ...edit,
            requestedProvider: embedding.provider, requestedModel: embedding.model });
        },
        protected: async () => {
          const embedding = await input.resolveEmbedding?.();
          if (embedding === undefined) throw new ClassifiedDataOperationError("unsupported", "Memory embedding is unavailable");
          return protectedMutationPort(input.protected).update({ memoryId, ...edit,
            requestedProvider: embedding.provider, requestedModel: embedding.model });
        },
      });
    },
    transitionTier(memoryId: string, action: "promote" | "demote") {
      return input.owner.runMutation({
        dual: () => protectedMutationPort(input.protected).transitionTier(memoryId, action),
        protected: () => protectedMutationPort(input.protected).transitionTier(memoryId, action),
      });
    },
    restore(memoryId: string) {
      return input.owner.runMutation({
        dual: () => protectedMutationPort(input.protected).restore(memoryId),
        protected: () => protectedMutationPort(input.protected).restore(memoryId),
      });
    },
    async delete(memoryId: string, confirmShared?: boolean) {
      await input.owner.runMutation({
        ordinary: () => ordinaryOperation(input.ordinary.delete === undefined ? undefined : () =>
          input.ordinary.delete!(memoryId, confirmShared ? { confirmShared: true } : undefined)),
        dual: () => protectedMutationPort(input.protected).deleteAuthorizedView(memoryId),
        protected: () => protectedMutationPort(input.protected).deleteAuthorizedView(memoryId),
      });
    },
    grantUser(memoryId: string, userHandle: string) {
      return input.owner.runMutation({
        ordinary: () => ordinaryOperation(input.ordinary.grantUser === undefined ? undefined : () =>
          input.ordinary.grantUser!(memoryId, userHandle)),
        dual: () => protectedMutationPort(input.protected).grantUser(memoryId, userHandle),
        protected: () => protectedMutationPort(input.protected).grantUser(memoryId, userHandle),
      });
    },
    makePrivate(memoryId: string) {
      return input.owner.runMutation({
        ordinary: () => ordinaryOperation(input.ordinary.makePrivate === undefined ? undefined : () =>
          input.ordinary.makePrivate!(memoryId)),
        dual: () => protectedMutationPort(input.protected).makePrivate(memoryId),
        protected: () => protectedMutationPort(input.protected).makePrivate(memoryId),
      });
    },
    async retryPendingMutations() {
      const port = input.protected();
      if (port !== undefined) await port.retryPendingMutations();
    },
    dispose: () => input.disposeProtected?.() ?? Promise.resolve(),
  });
}
