import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1 } from
  "@nautilo/lattice-crypto/wire";
import type { DirectDatabase, PostgresJsBridgeConnection } from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { createTaskContentBackfillPublication } from "./task-content-backfill-publication";
import { createTaskContentBackfillScanService } from "./task-content-backfill-scan";
import type { TaskContentBackfillRouteServices } from "./task-content-backfill-routes";

/** The Task policy owner gates both discovery and every content operation. */
export function createProductionTaskContentBackfillComposition(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  crypto?: LatticeCrypto;
  now?: () => number;
}>): TaskContentBackfillRouteServices {
  const crypto = input.crypto ?? new LatticeCrypto();
  const shared = { ...input, crypto };
  const leaseDurationMs = HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1;
  return Object.freeze({
    scan: createTaskContentBackfillScanService({ ...shared,
      pageLimit: 64, leaseDurationMs, sweepIntervalMs: leaseDurationMs }),
    publication: createTaskContentBackfillPublication(shared),
    isActive: () => input.owner.runMutation({
      ordinary: () => Promise.resolve(false),
      protected: () => Promise.resolve(false),
      dual: () => Promise.resolve(true),
    }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
