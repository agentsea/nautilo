import type { EncryptionCoverageEntry } from "../src/model";
import { rawDatabaseWriterDebtId } from "../src/raw-database-writer-debt";
import type { RetiredFrozenDebt, ReviewedDebtLink } from "../src/registry";

const REVIEW_EVIDENCE =
  "packages/encryption-invariants/tests/integration/reviewed-main-2026-08-21-security.test.ts";

const REFLECTION_METADATA_WRITERS = [
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.memory_namespaces:1",
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.rooms:2",
] as const;

const REFLECTION_MEMORY_WRITER =
  "packages/reflection-bridge/scripts/run-postgres-integration.ts#<module>:raw_sql:insert:public.memories:1";

export const RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS =
  new Set<string>([
    "deploy/compose-driver/src/ComposeDriver.ts#restore:raw_sql:delete:public.nautilo_instance_identity:1",
    "deploy/compose-driver/src/ComposeDriver.ts#restoreRemoteBundle:raw_sql:delete:public.nautilo_instance_identity:1",
  ]);

export const RETIRED_MAIN_2026_08_21_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] =
  [...RETIRED_MAIN_2026_08_21_RAW_DATABASE_WRITER_LOCATORS].map((locator) => ({
    debtId: rawDatabaseWriterDebtId(locator),
    reason:
      "The restore flow now preserves and verifies the imported server identity instead of deleting its marker; the vanished raw-SQL declaration remains only as immutable audit history.",
    testEvidence: [REVIEW_EVIDENCE],
  }));

export const REVIEWED_MAIN_2026_08_21_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = REFLECTION_METADATA_WRITERS.map(
  (locator) => ({
    id: `db.main-2026-08-21.reflection-fixture-${locator.includes("memory_namespaces") ? "memory-namespace" : "public-room"}`,
    surface: "db",
    locator,
    owner: "packages/reflection-bridge",
    readers: ["packages/reflection-bridge"],
    writers: ["packages/reflection-bridge/scripts/run-postgres-integration.ts"],
    migrationState: "not_applicable",
    retention:
      "Disposable PostgreSQL integration-fixture state retained only for the duration of the Reflection conformance run.",
    testEvidence: [REVIEW_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "synthetic Room, Memory, Namespace, owner, and Human identifiers",
      "fixed integration labels, Room kind, and graph-thread coordinates",
      "Memory-to-Namespace attachment coordinates",
    ],
    plaintextReason:
      "These exact statements add only synthetic integration-fixture routing and attachment metadata. Memory content and its semantic vector are excluded here and remain explicitly linked to the frozen plaintext Memory boundary.",
  }),
);

export const REVIEWED_MAIN_2026_08_21_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [{
    id: "link.db.main-2026-08-21.reflection-integration-plaintext-memory",
    surface: "db",
    locator: REFLECTION_MEMORY_WRITER,
    owner: "packages/reflection-bridge",
    targetDebtIds: [
      "debt.db.public.memories.content",
      "debt.db.public.memories.embedding",
      "debt.db.public.memories.id",
      "debt.db.public.memories.tier",
      "debt.db.public.memories.type",
    ],
    reason:
      "The disposable Reflection integration fixture writes one ordinary plaintext Memory row, including synthetic content and a deterministic semantic vector, into the exact existing Memory boundary frozen by Wave 0; it introduces no new content class or protected representation.",
    testEvidence: [REVIEW_EVIDENCE],
    crossBoundaryProjection: {
      fields: ["id", "tier", "type", "content", "embedding"],
      rationale:
        "The raw INSERT observation is a second representation of the existing public.memories row boundary: its content and embedding retain their frozen plaintext meaning, while its ID, tier, and type remain the same row coordinates.",
    },
  }];
