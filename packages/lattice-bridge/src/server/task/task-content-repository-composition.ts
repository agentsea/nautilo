import type { TaskContentAuthorityV1 } from "../../task/task-content-authority-v1.ts";
import {
  mutateTaskContentV1,
  readTaskContentV1,
  type TaskContentPublicationPlanV1,
} from "../../task/task-content-operation.ts";
import {
  createDormantTaskContentShadowRepository,
} from "../../task/task-content-shadow-saga.ts";
import type {
  PreparedTaskContentCryptoRevisionV1,
  TaskContentCoordinateV1,
  TaskContentPayloadV1,
  TaskContentRepository,
} from "../../task/task-content-repository.ts";
import { readPreparedTaskContentCryptoRevisionSnapshotV1 } from "../../task/task-content-prepared-revision.ts";
import {
  ClassifiedDataOperationError,
  type DataOperationPublicationContext,
  type EncryptionDataOperationOwner,
} from "../../transition/encryption-data-operation-owner.ts";
import {
  createPostgresTaskContentCryptoCompletion,
} from "./postgres-task-content-crypto-completion.ts";
import {
  PostgresTaskContentProductStore,
  type ResolveCurrentTaskContentAuthority,
} from "./postgres-task-content-product-store.ts";
import type {
  ConversationProductPostgresHandle,
} from "../message/postgres-conversation-product-store.ts";

export interface DurableTaskContentPortsV1<ProductResult> {
  /** Client-vault or Agent-runtime preparation; plaintext remains with its owner. */
  prepareProtected(input: Readonly<{
    content: TaskContentPayloadV1;
    canonicalBytes: Uint8Array;
  }>): Promise<PreparedTaskContentCryptoRevisionV1>;
  /**
   * Atomically creates or conditionally updates the Task/TaskRun product row.
   * Protected plans publish the content-free product row before crypto mapping.
   */
  publishProduct(
    plan: TaskContentPublicationPlanV1,
    context: DataOperationPublicationContext,
  ): Promise<ProductResult>;
  readOrdinary(
    coordinate: TaskContentCoordinateV1,
  ): Promise<TaskContentPayloadV1>;
  /** Authorized vault-backed open of the verified protected object. */
  readProtected(
    coordinate: TaskContentCoordinateV1,
  ): Promise<TaskContentPayloadV1>;
}

export type DurableTaskContentPublicationResult<ProductResult> = Readonly<{
  product: ProductResult;
  representation: TaskContentPublicationPlanV1["representation"];
  protectedRevision: Awaited<ReturnType<TaskContentRepository["completeRevision"]>> | null;
}>;

type PreparedTaskContentPublicationCommonV1 = Readonly<{
  owner: EncryptionDataOperationOwner;
  operationId: string;
  requestDigest: Uint8Array;
  authority: TaskContentAuthorityV1;
  operationalMetadata: Parameters<
    TaskContentRepository["reserveRevision"]
  >[0]["operationalMetadata"];
  prepared: PreparedTaskContentCryptoRevisionV1;
}>;

export type ProtectedPreparedTaskContentPublicationV1<ProductResult> =
  PreparedTaskContentPublicationCommonV1 & Readonly<{
    representation: "protected";
    publishProduct(
      context: DataOperationPublicationContext,
    ): Promise<ProductResult>;
  }>;

export type DualPreparedTaskContentPublicationV1<ProductResult> =
  PreparedTaskContentPublicationCommonV1 & Readonly<{
    representation: "dual";
    ordinaryContent: TaskContentPayloadV1;
    publishProduct(
      content: TaskContentPayloadV1,
      context: DataOperationPublicationContext,
    ): Promise<ProductResult>;
  }>;

export type PreparedTaskContentPublicationV1<ProductResult> =
  | ProtectedPreparedTaskContentPublicationV1<ProductResult>
  | DualPreparedTaskContentPublicationV1<ProductResult>;

export interface DurableTaskContentRepositoryV1<ProductResult> {
  lookupPreparedReplay: TaskContentRepository["lookupPreparedReplay"];
  mutate(input: Readonly<{
    owner: EncryptionDataOperationOwner;
    content: TaskContentPayloadV1;
    operationId: string;
    requestDigest: Uint8Array;
    authority: TaskContentAuthorityV1;
    operationalMetadata: Parameters<
      TaskContentRepository["reserveRevision"]
    >[0]["operationalMetadata"];
  }>): Promise<DurableTaskContentPublicationResult<ProductResult>>;
  /**
   * Accepts an authenticated device-prepared revision. Protected publication
   * keeps plaintext out of the server; dual publication carries its separately
   * authenticated canonical ordinary sibling to the product callback.
   */
  publishPrepared(
    input: PreparedTaskContentPublicationV1<ProductResult>,
  ): Promise<DurableTaskContentPublicationResult<ProductResult>>;
  read(input: Readonly<{
    owner: EncryptionDataOperationOwner;
    coordinate: TaskContentCoordinateV1;
  }>): ReturnType<typeof readTaskContentV1>;
  reconcilePending: TaskContentRepository["reconcilePending"];
}

/**
 * Binds policy selection, product publication, and the protected lifecycle into
 * one Task repository. The supplied content ports are the existing custody
 * boundary: product writes remain entity-specific and protected opens require
 * the authorized client vault or Agent runtime.
 */
export function bindDurableTaskContentRepositoryV1<ProductResult>(input: Readonly<{
  protectedRepository: TaskContentRepository;
  content: DurableTaskContentPortsV1<ProductResult>;
}>): DurableTaskContentRepositoryV1<ProductResult> {
  const repository: DurableTaskContentRepositoryV1<ProductResult> = {
    lookupPreparedReplay: (
      request: Parameters<TaskContentRepository["lookupPreparedReplay"]>[0],
    ) => input.protectedRepository.lookupPreparedReplay(request),

    async mutate(request: Parameters<DurableTaskContentRepositoryV1<ProductResult>["mutate"]>[0]) {
      return mutateTaskContentV1({
        owner: request.owner,
        content: request.content,
        ports: {
          prepareProtected: (prepareInput) =>
            input.content.prepareProtected(prepareInput),
          async reserveProtected(plan) {
            const reservation = await input.protectedRepository.reserveRevision({
              operationId: request.operationId,
              requestDigest: request.requestDigest,
              representation: plan.representation,
              authority: request.authority,
              prepared: plan.prepared,
              operationalMetadata: request.operationalMetadata,
            });
            if (reservation.status === "stale") {
              throw new ClassifiedDataOperationError(
                "stale",
                "Task content reservation is stale",
              );
            }
            if (reservation.status === "conflict") {
              throw new ClassifiedDataOperationError(
                "integrity",
                "Task content reservation conflicts with durable state",
              );
            }
          },
          async publish(plan, context) {
            const product = await input.content.publishProduct(plan, context);
            const protectedRevision = plan.representation === "ordinary"
              ? null
              : await input.protectedRepository.completeRevision({
                coordinate: plan.content.coordinate,
                prepared: plan.prepared,
              });
            return Object.freeze({
              product,
              representation: plan.representation,
              protectedRevision,
            });
          },
        },
      });
    },

    async publishPrepared(request: Parameters<DurableTaskContentRepositoryV1<ProductResult>["publishPrepared"]>[0]) {
      const publish = async (
        context: DataOperationPublicationContext,
      ): Promise<DurableTaskContentPublicationResult<ProductResult>> => {
        readPreparedTaskContentCryptoRevisionSnapshotV1(request.prepared);
        const reservation = await input.protectedRepository.reserveRevision({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          representation: request.representation,
          authority: request.authority,
          prepared: request.prepared,
          operationalMetadata: request.operationalMetadata,
        });
        if (reservation.status === "stale") {
          throw new ClassifiedDataOperationError(
            "stale",
            "Task content reservation is stale",
          );
        }
        if (reservation.status === "conflict") {
          throw new ClassifiedDataOperationError(
            "integrity",
            "Task content reservation conflicts with durable state",
          );
        }
        const product = request.representation === "dual"
          ? await request.publishProduct(request.ordinaryContent, context)
          : await request.publishProduct(context);
        const protectedRevision = await input.protectedRepository.completeRevision({
          coordinate: request.prepared.coordinate,
          prepared: request.prepared,
        });
        return Object.freeze({
          product,
          representation: request.representation,
          protectedRevision,
        });
      };
      return request.owner.runMutation(request.representation === "dual"
        ? { dual: publish }
        : { protected: publish });
    },

    read(request: Parameters<DurableTaskContentRepositoryV1<ProductResult>["read"]>[0]) {
      return readTaskContentV1({
        owner: request.owner,
        coordinate: request.coordinate,
        ports: {
          readOrdinary: (coordinate) => input.content.readOrdinary(coordinate),
          readProtected: (coordinate) => input.content.readProtected(coordinate),
        },
      });
    },

    reconcilePending: (request: Parameters<TaskContentRepository["reconcilePending"]>[0]) =>
      input.protectedRepository.reconcilePending(request),
  };
  return Object.freeze(repository);
}

type PostgresCryptoCompletionInput = Parameters<
  typeof createPostgresTaskContentCryptoCompletion
>[0];

/** Constructs the protected lifecycle from the concrete product/crypto stores. */
export function createPostgresTaskContentRepositoryV1<ProductResult>(input: Readonly<{
  product: Readonly<{
    handle: ConversationProductPostgresHandle;
    resolveCurrentAuthority: ResolveCurrentTaskContentAuthority;
  }>;
  crypto: PostgresCryptoCompletionInput;
  content: DurableTaskContentPortsV1<ProductResult>;
}>): DurableTaskContentRepositoryV1<ProductResult> {
  const product = new PostgresTaskContentProductStore(
    input.product.handle,
    input.product.resolveCurrentAuthority,
  );
  const crypto = createPostgresTaskContentCryptoCompletion(input.crypto);
  return bindDurableTaskContentRepositoryV1({
    protectedRepository: createDormantTaskContentShadowRepository({
      product,
      crypto,
    }),
    content: input.content,
  });
}
