import type { EncryptionCoverageEntry } from "../src/model";

const BRIDGE_REPOSITORY =
  "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts";
const STORAGE_EVIDENCE =
  "packages/lattice-bridge/tests/integration/postgres-lattice-storage.integration.test.ts";

/**
 * Wave 8 adds one raw-SQL update to the reviewed lattice storage adapter. The
 * update advances only the bounded Runtime authorization revision, and it is
 * committed atomically with the exact validated config, Domain-envelope, and
 * challenge inventories covered by the shared Postgres storage contract.
 */
export const REVIEWED_WAVE_8_DATABASE_WRITER_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    {
      id: "db.wave8.lattice-writer-01",
      surface: "db",
      locator:
        "packages/lattice-bridge/src/server/storage/postgres-lattice-storage.ts#compareAndSwapAgentRuntimeAuthorizationTransition:raw_sql:update:public.agent_crypto_runtime_states:1",
      owner: "packages/lattice-bridge",
      readers: [BRIDGE_REPOSITORY],
      writers: [BRIDGE_REPOSITORY],
      migrationState: "ciphertext_only",
      retention:
        "The bounded authorization revision is retained with the dormant Agent Runtime record and changes only inside the atomic authorization-transition CAS.",
      testEvidence: [STORAGE_EVIDENCE],
      classification: "protected",
      keyFamily: "agent_runtime",
      bridgeRepository: BRIDGE_REPOSITORY,
      negativeTestEvidence: [STORAGE_EVIDENCE],
    },
  ];
