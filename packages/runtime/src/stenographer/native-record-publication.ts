import type { DirectDatabase } from "@nautilo/db";
import {
  PostgresOrdinaryStenographerRecordPublisher,
  PostgresSemanticWorkStore,
  createHmacRecordRequestCommitmentPort,
  createHmacRecordSemanticCommitmentPort,
  readOrdinaryStenographerJournalEventsWithHandle,
  verifyRecordProductPostgresHandle,
  type OrdinaryStenographerExtractionPublicationV2,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
  type RecordRepositorySelection,
} from "@nautilo/reflection-bridge/server";

export type { RecordRepositorySelection } from "@nautilo/reflection-bridge/server";

import { planEventTransitions } from "./event-transition-planner";
import type { ExtractionClaim } from "./repository";
import type { StenographerOperation } from "./types";

type PostgresJsClient = DirectDatabase["$client"];

function executor(client: Pick<PostgresJsClient, "unsafe">): RecordProductPostgresExecutor {
  return {
    async query<Row extends RecordProductPostgresRow = RecordProductPostgresRow>(
      statement: string,
      parameters: readonly RecordProductPostgresScalar[] = [],
    ): Promise<readonly Row[]> {
      const serialized = parameters.map((parameter) =>
        parameter instanceof Date ? parameter.toISOString() : parameter
      );
      const rows = await client.unsafe(statement, serialized as never[]);
      return rows as unknown as readonly Row[];
    },
  };
}

/** Keep the postgres-js transport adapter at Runtime composition, not in Reflection. */
export function createRecordProductPostgresConnection(
  db: DirectDatabase,
): RecordProductPostgresConnection {
  const direct = executor(db.$client);
  return {
    query: direct.query.bind(direct),
    async transaction<Result>(
      callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
      options: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
    ): Promise<Result> {
      const isolation = options.isolationLevel === "serializable"
        ? "serializable"
        : "read committed";
      return await db.$client.begin(`isolation level ${isolation}`, (transaction) =>
        callback(executor(transaction))) as Result;
    },
  };
}

export interface NativeStenographerPublicationInput {
  readonly db: DirectDatabase;
  readonly selection: RecordRepositorySelection;
  /** Ordinary atomic publications need only the current process-owned key. */
  readonly commitmentKey: Uint8Array;
  /** Domain-separated semantic-work commitments for atomic Record admission. */
  readonly semanticCommitmentKey: Uint8Array;
}

export interface NativeStenographerPublicationRuntime {
  publishExtraction(publication: Readonly<{
    claim: ExtractionClaim;
    operations: readonly StenographerOperation[];
    modelId: string | null;
    now?: Date;
    ordinaryFallbackReason?: "device" | "authority";
  }>): Promise<{ published: boolean; eventsWritten: number }>;
  convertNextLegacyPage(input?: Readonly<{
    limit?: number;
    now?: Date;
  }>): Promise<{ roomId: string | null; converted: number; completedRoom: boolean }>;
}

/**
 * Compose the current ordinary Stenographer with the bridge-owned Record
 * publisher. Protected server migration state must supply its own authority-
 * bound composition; this factory refuses to pretend ordinary is protected.
 */
export async function createNativeStenographerExtractionPublisher(
  input: NativeStenographerPublicationInput,
): Promise<NativeStenographerPublicationRuntime> {
  if (input.selection.selectedRepresentation !== "ordinary") {
    throw new TypeError("Protected Stenographer publication requires the protected server composition");
  }
  const handle = await verifyRecordProductPostgresHandle(
    createRecordProductPostgresConnection(input.db),
  );
  const semanticWork = new PostgresSemanticWorkStore({
    handle,
    commitments: createHmacRecordSemanticCommitmentPort(
      input.semanticCommitmentKey,
    ),
  });
  const publisher = new PostgresOrdinaryStenographerRecordPublisher({
    handle,
    selection: input.selection,
    commitment: createHmacRecordRequestCommitmentPort(input.commitmentKey),
    semanticWork,
  });
  return {
    async publishExtraction(publication) {
      const events = await readOrdinaryStenographerJournalEventsWithHandle(handle, {
        roomId: publication.claim.roomId,
      });
      const transition = planEventTransitions({
        roomId: publication.claim.roomId,
        events,
        operations: publication.operations,
      });
      if (!transition.ok) {
        throw new Error(`journal transition rejected: ${transition.reason}`);
      }
      const bridgeInput: OrdinaryStenographerExtractionPublicationV2 = {
        claim: {
          batchId: publication.claim.batchId,
          roomId: publication.claim.roomId,
          leaseToken: publication.claim.leaseToken,
          lane: publication.claim.lane,
          fromMessageIdExclusive:
            publication.claim.plan.fromMessageIdExclusive,
          throughMessageIdInclusive:
            publication.claim.plan.throughMessageIdInclusive,
          rebuildGeneration: publication.claim.rebuildGeneration ?? null,
        },
        transition: transition.plan,
        operationCount: publication.operations.length,
        modelId: publication.modelId,
        extractorVersion: "m219-v1",
        now: publication.now ?? new Date(),
        ...(publication.ordinaryFallbackReason === undefined
          ? {}
          : { ordinaryFallbackReason: publication.ordinaryFallbackReason }),
      };
      return publisher.publishExtraction(bridgeInput);
    },
    convertNextLegacyPage: (conversionInput) =>
      publisher.convertNextLegacyPage(conversionInput),
  };
}
