import type {
  AuthorizedHumanMemoryClient,
  AuthorizedHumanMemoryOpenedV1,
  AuthorizedHumanMemoryReadResultV1,
  AuthorizedHumanMemoryUnavailableReason,
} from "@nautilo/lattice-bridge/client/browser";
import type { ProtectedMemoryProjectionV1 } from "@nautilo/api-client/browser";
import { runWithCryptoAdmission } from "./crypto-admission-access";

export type WorkbenchProtectedMemoryContent =
  | Readonly<{
    status: "opened";
    representation: "protected" | "ordinary_fallback";
    type: string;
    content: string;
  }>
  | Readonly<{
    status: "unavailable";
    reason: AuthorizedHumanMemoryUnavailableReason;
  }>;

export type WorkbenchProtectedMemory = Readonly<{
  id: string;
  contentRevision: number;
  importance: number;
  tier: number;
  createdAt: string;
  updatedAt: string;
  namespaceIds: readonly string[];
  accessList?: readonly Readonly<{
    userHandle: string;
    displayName: string;
  }>[];
  content: WorkbenchProtectedMemoryContent;
}>;

export type WorkbenchProtectedMemorySearchResult = WorkbenchProtectedMemory &
  Readonly<{ score: number }>;

function projection(
  value: ProtectedMemoryProjectionV1,
  content: WorkbenchProtectedMemoryContent,
): WorkbenchProtectedMemory {
  return Object.freeze({
    id: value.memoryId,
    contentRevision: value.contentRevision,
    importance: value.importance,
    tier: value.tier,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    namespaceIds: Object.freeze([...value.namespaceIds]),
    ...(value.accessList === undefined ? {} : {
      accessList: Object.freeze(value.accessList.map((entry) =>
        Object.freeze({ ...entry })
      )),
    }),
    content,
  });
}

function opened(value: AuthorizedHumanMemoryReadResultV1): WorkbenchProtectedMemory {
  return projection(value.projection, Object.freeze({
    status: "opened",
    representation: value.representation,
    type: value.payload.type,
    content: value.payload.content,
  }));
}

function protectedOpened(value: AuthorizedHumanMemoryOpenedV1): WorkbenchProtectedMemory {
  return opened(Object.freeze({ ...value, representation: "protected" }));
}

function createUnfencedWorkbenchProtectedHumanMemoryController(
  client: Pick<AuthorizedHumanMemoryClient,
    "withList" | "withSearch" | "withDetail" | "withBrief" | "update" | "archive" |
    "restore" | "transitionTier" | "deleteAuthorizedView" |
    "grantUser" | "revokeUser" | "makePrivate" |
    "retryPendingMutations">,
) {
  let readTail: Promise<void> = Promise.resolve();
  let disposed = false;
  function runRead<Result extends Readonly<{
    observationDelivery?: Promise<void>;
  }>>(operation: () => Promise<Result>) {
    const run = readTail.then(async () => {
      if (disposed) throw new TypeError("Protected Human Memory controller is disposed");
      return operation();
    });
    readTail = run.then(async (result) => {
      await result.observationDelivery;
    }, () => undefined);
    return run;
  }
  return Object.freeze({
    async list(options: Parameters<AuthorizedHumanMemoryClient["withList"]>[0]) {
      const items: WorkbenchProtectedMemory[] = [];
      const page = await runRead(() => client.withList(options, (value) => {
        items.push(opened(value));
      }, ({ projection: value, reason }) => {
        items.push(projection(value, Object.freeze({
          status: "unavailable",
          reason,
        })));
      }));
      const { observationDelivery: _observationDelivery, ...product } = page;
      return Object.freeze({ ...product, items: Object.freeze(items) });
    },
    async search(
      options: Parameters<AuthorizedHumanMemoryClient["withSearch"]>[0],
    ) {
      const items: WorkbenchProtectedMemorySearchResult[] = [];
      const response = await runRead(() => client.withSearch(options, (value, score) => {
        items.push(Object.freeze({ ...opened(value), score }));
      }, ({ projection: value, reason, score }) => {
        items.push(Object.freeze({
          ...projection(value, Object.freeze({ status: "unavailable", reason })),
          score,
        }));
      }));
      const { observationDelivery: _observationDelivery, ...product } = response;
      return Object.freeze({ ...product, items: Object.freeze(items) });
    },
    async detail(memoryId: string) {
      let memory: WorkbenchProtectedMemory | undefined;
      const response = await runRead(() => client.withDetail(memoryId, (value) => {
        memory = opened(value);
      }));
      if (memory === undefined) {
        throw new TypeError("Protected Human Memory detail did not open");
      }
      const { observationDelivery: _observationDelivery, ...product } = response;
      return Object.freeze({ ...product, memory });
    },
    async brief() {
      const memories: WorkbenchProtectedMemory[] = [];
      const response = await runRead(() => client.withBrief({}, (value) => {
        memories.push(opened(value));
      }));
      const { observationDelivery: _observationDelivery, ...product } = response;
      const lines = memories
        .filter((memory) => memory.tier === 1 && memory.content.status === "opened")
        .sort((left, right) => right.importance - left.importance
          || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((memory) => memory.content.status === "opened"
          ? `- [${memory.content.type}] ${memory.content.content}` : "");
      return Object.freeze({ ...product, brief: lines.join("\n") });
    },
    async update(input: Readonly<{
      memoryId: string;
      type: string;
      content: string;
      importance: number;
      requestedProvider: "openai" | "openrouter" | "venice";
      requestedModel: string;
    }>) {
      let memory: WorkbenchProtectedMemory | undefined;
      const response = await client.update(input.memoryId, {
        payload: {
          formatVersion: 1,
          type: input.type,
          content: input.content,
        },
        importance: input.importance,
        requestedProvider: input.requestedProvider,
        requestedModel: input.requestedModel,
      }, (value) => {
        memory = protectedOpened(value);
      });
      if (response.status === "ordinary_fallback") return response;
      if (memory === undefined) {
        throw new TypeError("Protected Human Memory update did not reopen");
      }
      return Object.freeze({ ...response, memory });
    },
    archive: (memoryId: string) => client.archive(memoryId),
    restore: (memoryId: string) => client.restore(memoryId),
    transitionTier: (memoryId: string, action: "promote" | "demote") =>
      client.transitionTier(memoryId, action),
    deleteAuthorizedView: (memoryId: string) =>
      client.deleteAuthorizedView(memoryId),
    grantUser: (memoryId: string, userHandle: string) =>
      client.grantUser(memoryId, userHandle),
    revokeUser: (memoryId: string, userHandle: string) =>
      client.revokeUser(memoryId, userHandle),
    makePrivate: (memoryId: string) => client.makePrivate(memoryId),
    retryPendingMutations: () => client.retryPendingMutations(),
    async dispose() {
      disposed = true;
      await readTail;
    },
  });
}

export type WorkbenchProtectedHumanMemoryController = ReturnType<
  typeof createUnfencedWorkbenchProtectedHumanMemoryController
>;
export type WorkbenchProtectedHumanMemoryOperations = Omit<
  WorkbenchProtectedHumanMemoryController,
  "dispose"
>;

export function withCryptoAdmissionForProtectedMemoryController(
  controller: WorkbenchProtectedHumanMemoryController,
): WorkbenchProtectedHumanMemoryController;
export function withCryptoAdmissionForProtectedMemoryController(
  controller: WorkbenchProtectedHumanMemoryOperations,
): WorkbenchProtectedHumanMemoryOperations;
export function withCryptoAdmissionForProtectedMemoryController(
  controller: WorkbenchProtectedHumanMemoryOperations &
    Partial<Pick<WorkbenchProtectedHumanMemoryController, "dispose">>,
): WorkbenchProtectedHumanMemoryOperations &
  Partial<Pick<WorkbenchProtectedHumanMemoryController, "dispose">> {
  const dispose = controller.dispose;
  return Object.freeze({
    list: (...args: Parameters<typeof controller.list>) =>
      runWithCryptoAdmission(() => controller.list(...args)),
    search: (...args: Parameters<typeof controller.search>) =>
      runWithCryptoAdmission(() => controller.search(...args)),
    detail: (...args: Parameters<typeof controller.detail>) =>
      runWithCryptoAdmission(() => controller.detail(...args)),
    brief: (...args: Parameters<typeof controller.brief>) =>
      runWithCryptoAdmission(() => controller.brief(...args)),
    update: (...args: Parameters<typeof controller.update>) =>
      runWithCryptoAdmission(() => controller.update(...args)),
    archive: (...args: Parameters<typeof controller.archive>) =>
      runWithCryptoAdmission(() => controller.archive(...args)),
    restore: (...args: Parameters<typeof controller.restore>) =>
      runWithCryptoAdmission(() => controller.restore(...args)),
    transitionTier: (...args: Parameters<typeof controller.transitionTier>) =>
      runWithCryptoAdmission(() => controller.transitionTier(...args)),
    deleteAuthorizedView: (...args: Parameters<typeof controller.deleteAuthorizedView>) =>
      runWithCryptoAdmission(() => controller.deleteAuthorizedView(...args)),
    grantUser: (...args: Parameters<typeof controller.grantUser>) =>
      runWithCryptoAdmission(() => controller.grantUser(...args)),
    revokeUser: (...args: Parameters<typeof controller.revokeUser>) =>
      runWithCryptoAdmission(() => controller.revokeUser(...args)),
    makePrivate: (...args: Parameters<typeof controller.makePrivate>) =>
      runWithCryptoAdmission(() => controller.makePrivate(...args)),
    retryPendingMutations: (...args: Parameters<typeof controller.retryPendingMutations>) =>
      runWithCryptoAdmission(() => controller.retryPendingMutations(...args)),
    ...(dispose === undefined ? {} : {
      dispose: () => dispose(),
    }),
  });
}

export function createWorkbenchProtectedHumanMemoryController(
  client: Parameters<typeof createUnfencedWorkbenchProtectedHumanMemoryController>[0],
): WorkbenchProtectedHumanMemoryController {
  return withCryptoAdmissionForProtectedMemoryController(
    createUnfencedWorkbenchProtectedHumanMemoryController(client),
  );
}
