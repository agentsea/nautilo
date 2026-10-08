import {
  createDedicatedEncryptedCheckpointPool,
  embedTextWithProvenance,
  EmbeddingProviderError,
} from "@nautilo/agent";
import { MEMORY_EMBEDDING_DIMENSIONS } from "@nautilo/lattice-bridge";
import {
  sealAndParkProtectedTaskRun,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  EncryptionDataOperationOwner,
  ProtectedAgentMemoryEmbeddingPort,
} from "@nautilo/lattice-bridge";

import { createHumanProductTransactionContext } from "./human-message-product-store";
import { createForegroundProductTransactionContext } from "./foreground-message-product-store";
import {
  createProtectedTaskNativeFixedMemorySegment,
  type ProtectedTaskNativeFixedMemorySegmentInput,
} from "./protected-task-native-fixed-memory-segment";
import { createProductionProtectedTaskNativeExecutionContext } from "./protected-task-native-execution-context";
import { createProtectedTaskNativeResultPublication } from "./protected-task-native-result-publication";
import { createProtectedTaskNativeTranscriptPublisher } from "./protected-task-native-transcript-composition";
import type { ProtectedTaskRuntimeGrantPlanBuilderDependencies } from "./protected-task-runtime-grant-plan";

type Dependencies = Readonly<{
  productContext: typeof createHumanProductTransactionContext;
  agentProductContext: typeof createForegroundProductTransactionContext;
  executionContext: typeof createProductionProtectedTaskNativeExecutionContext;
  transcriptPublisher: typeof createProtectedTaskNativeTranscriptPublisher;
  segment: typeof createProtectedTaskNativeFixedMemorySegment;
  result: typeof createProtectedTaskNativeResultPublication;
  sealAndPark: typeof sealAndParkProtectedTaskRun;
}>;

export type ProductionProtectedTaskNativeExecutionInput = Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  embedding?: ProtectedAgentMemoryEmbeddingPort;
  createDedicatedPool?: ProtectedTaskNativeFixedMemorySegmentInput["createDedicatedPool"];
  now?: () => number;
}>;

/**
 * Connect native graph, Memory, checkpoint, transcript and result owners for a
 * protected occurrence. Product contexts carry identity only; private grant
 * material is borrowed later by the segment and never cached in this factory.
 */
export function createProductionProtectedTaskNativeExecution(
  input: ProductionProtectedTaskNativeExecutionInput,
  overrides: Partial<Dependencies> = {},
): Pick<ProtectedTaskRuntimeGrantPlanBuilderDependencies,
  "prepareExecution" | "publishResult"> {
  const dependencies: Dependencies = {
    productContext: createHumanProductTransactionContext,
    agentProductContext: createForegroundProductTransactionContext,
    executionContext: createProductionProtectedTaskNativeExecutionContext,
    transcriptPublisher: createProtectedTaskNativeTranscriptPublisher,
    segment: createProtectedTaskNativeFixedMemorySegment,
    result: createProtectedTaskNativeResultPublication,
    sealAndPark: sealAndParkProtectedTaskRun,
    ...overrides,
  };
  const resolveExecutionContext = dependencies.executionContext({ db: input.db });
  const embedding: ProtectedAgentMemoryEmbeddingPort = input.embedding ?? {
    async embed({ plaintext, signal }) {
      signal?.throwIfAborted();
      try {
        const result = await embedTextWithProvenance(plaintext, signal);
        signal?.throwIfAborted();
        if (result.dimensions !== MEMORY_EMBEDDING_DIMENSIONS) {
          return { status: "unavailable", reason: "embedding_unavailable" };
        }
        return { status: "success", value: { ...result, dimensions: MEMORY_EMBEDDING_DIMENSIONS } };
      } catch (error) {
        if (error instanceof EmbeddingProviderError) {
          return { status: "unavailable", reason: "embedding_unavailable" };
        }
        throw error;
      }
    },
  };
  const createDedicatedPool = input.createDedicatedPool
    ?? createDedicatedEncryptedCheckpointPool;
  return Object.freeze({
    prepareExecution: async preparation => {
      const { requestorId, agentId } = preparation.occurrence.task;
      const product = await dependencies.productContext(requestorId, input.db);
      const agentProduct = await dependencies.agentProductContext({
        userId: requestorId,
        agentId,
      });
      return dependencies.segment({
        restricted: input.restricted,
        crypto: input.crypto,
        serverScope: input.serverScope,
        product,
        agentProduct,
        owner: input.owner,
        embedding,
        createDedicatedPool,
        parkSegment: async park => {
          const result = await dependencies.sealAndPark(input.db, park);
          return result.status === "parked" || result.status === "exact_replay";
        },
        resolveExecutionContext,
        createTranscriptPublisher: dependencies.transcriptPublisher({ product }),
        ...(input.now === undefined ? {} : { now: input.now }),
      })(preparation);
    },
    publishResult: async publication => {
      const product = await dependencies.productContext(
        publication.occurrence.task.requestorId, input.db,
      );
      await dependencies.result({
        reference: publication.reference,
        db: input.db,
        restricted: input.restricted,
        crypto: input.crypto,
        owner: input.owner,
        serverScope: input.serverScope,
        product,
        ...(input.now === undefined ? {} : { now: input.now }),
      })(publication);
    },
  });
}
