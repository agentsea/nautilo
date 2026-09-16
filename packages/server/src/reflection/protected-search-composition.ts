import { getProtectedMemoryEmbeddingConfiguration } from "@nautilo/agent";
import {
  createPostgresJsBridgeConnection,
  type DirectDatabase,
} from "@nautilo/db";
import {
  PostgresProtectedReflectionSearchMetadata,
  createProtectedReflectionSearchProjection,
  type ProtectedReflectionSearchMetadata,
  type ReflectionSemanticOperationPort,
} from "@nautilo/lattice-bridge/server";
import type {
  DurableSleepSemanticPort,
} from "@nautilo/reflection/durable";
import type {
  RecordEmbeddingPort,
  RecordEmbeddingProvenanceV1,
} from "@nautilo/reflection/search";
import {
  PostgresRecordSearchProjectionStore,
  PostgresSemanticWorkStore,
  createHmacRecordSemanticCommitmentPort,
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
} from "@nautilo/reflection-bridge/server";
import { REFLECTION_SEMANTIC_RUNTIME_POLICY_V1 } from "@nautilo/runtime";

type SearchSemanticPort = Pick<DurableSleepSemanticPort, "ensureSearchProjection">;

interface FactoryDependencies {
  readonly connect?: (db: DirectDatabase) => RecordProductPostgresConnection;
  readonly configuredEmbedding?: () => RecordEmbeddingProvenanceV1;
}

function configuredEmbedding(): RecordEmbeddingProvenanceV1 {
  const value = getProtectedMemoryEmbeddingConfiguration();
  if (value.dimensions !== 1_536) {
    throw new TypeError("Reflection embedding requires 1,536 dimensions");
  }
  return Object.freeze({
    provider: value.provider,
    canonicalModel: value.model,
    dimensions: value.dimensions,
    contractVersion: 1,
  });
}

function sameMetadata(
  left: ProtectedReflectionSearchMetadata,
  right: ProtectedReflectionSearchMetadata,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function heldConnection(
  product: RecordProductPostgresExecutor,
): RecordProductPostgresConnection {
  return Object.freeze({
    query: product.query.bind(product),
    transaction: <Result>(
      use: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
    ): Promise<Result> => use(product),
  });
}

/** Production protected search projection using the existing semantic grant lane. */
export async function createProductionProtectedReflectionSearchComposition(
  input: Readonly<{
    db: DirectDatabase;
    commitmentKey: Uint8Array;
    runSemantic: ReflectionSemanticOperationPort["runSemantic"];
    embedding: RecordEmbeddingPort;
    now?(): number;
  }>,
  dependencies: FactoryDependencies = {},
): Promise<SearchSemanticPort> {
  const connection = dependencies.connect?.(input.db)
    ?? createPostgresJsBridgeConnection(input.db);
  const handle = await verifyRecordProductPostgresHandle(connection);
  const resolveConfiguredEmbedding =
    dependencies.configuredEmbedding ?? configuredEmbedding;
  const metadata = new PostgresProtectedReflectionSearchMetadata({
    product: handle,
    configuredEmbedding: resolveConfiguredEmbedding,
  });
  const now = input.now ?? Date.now;
  const commitments = createHmacRecordSemanticCommitmentPort(input.commitmentKey);

  return createProtectedReflectionSearchProjection({
    operation: { runSemantic: input.runSemantic },
    embedding: input.embedding,
    resolveMetadata: (claim, signal) => metadata.resolve(claim, signal),
    nextRetryAt: () => now()
      + REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds,
    async publish({
      claim,
      metadata,
      projection,
      expectedProjectionGeneration,
      held,
      authorizeCommit,
      signal,
    }) {
      if (held.product === undefined) return "stale";
      const heldHandle = await verifyRecordProductPostgresHandle(
        heldConnection(held.product),
      );
      const semanticWork = new PostgresSemanticWorkStore({
        handle: heldHandle,
        commitments,
      });
      const fenced = await semanticWork.withClaimPublicationFence(
        claim,
        async () => {
          const current = await new PostgresProtectedReflectionSearchMetadata({
            product: heldHandle,
            configuredEmbedding: resolveConfiguredEmbedding,
          }).resolve(claim, signal);
          if (current === null || !sameMetadata(current, metadata)) return "stale";
          await authorizeCommit();
          const projections = new PostgresRecordSearchProjectionStore(heldHandle);
          return expectedProjectionGeneration === null
            ? projections.publish(projection)
            : projections.replace({
                expectedProjectionGeneration,
                projection,
              });
        },
      );
      return fenced.status === "stale" ? "stale" : fenced.value;
    },
  });
}
