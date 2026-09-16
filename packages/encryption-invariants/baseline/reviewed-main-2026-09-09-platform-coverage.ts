import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink, RetiredFrozenDebt } from "../src/registry";

/** Exact current-main platform inventory; content remains linked to frozen debt. */
export const REVIEWED_MAIN_2026_09_09_PLATFORM_COVERAGE_ENTRIES: readonly EncryptionCoverageEntry[] = [
  {
    "id": "main.2026-09-09.platform.metadata.1",
    "surface": "db",
    "locator": "public.server_model_config.embedding_model",
    "classification": "bounded_metadata",
    "owner": "packages/db",
    "readers": [
      "packages/server",
      "packages/runtime"
    ],
    "writers": [
      "packages/server",
      "packages/runtime"
    ],
    "migrationState": "not_applicable",
    "plaintextReason": "The exact field is a closed identifier, revision, digest, timestamp, lease coordinate, enum, boolean, or model identifier. It stores no message, tool argument/result, embedding vector, or provider secret.",
    "metadataAllowlist": [
      "public.server_model_config.embedding_model"
    ],
    "retention": "Owning configuration, crypto-repair, Session, or Video-project lifecycle.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-platform-security.test.ts"
    ]
  }
];

export const REVIEWED_MAIN_2026_09_09_PLATFORM_DEBT_LINKS: readonly ReviewedDebtLink[] = [
  {
    "id": "main.2026-09-09.platform.wire-debt.1",
    "surface": "wire",
    "locator": "http:request_response:POST /api/apps/:appId/conversions/run#response.body",
    "owner": "packages/server",
    "targetDebtIds": [
      "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
    ],
    "reason": "This exact control or Relay observation is a new representation on an already-frozen plaintext result/control transport boundary. It is not grandfathered as new debt and carries the inherited release impact.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-platform-security.test.ts"
    ]
  },
  {
    "id": "main.2026-09-09.platform.wire-debt.2",
    "surface": "wire",
    "locator": "relay:client_to_server:relay:security-scan-progress",
    "owner": "packages/relay",
    "targetDebtIds": [
      "debt.wire.relay.client.to.server.relay.result.1bl4tr5"
    ],
    "reason": "This exact control or Relay observation is a new representation on an already-frozen plaintext result/control transport boundary. It is not grandfathered as new debt and carries the inherited release impact.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-platform-security.test.ts"
    ]
  }
];

export const RETIRED_MAIN_2026_09_09_PLATFORM_FROZEN_DEBT: readonly RetiredFrozenDebt[] = [
  {
    "debtId": "debt.wire.arbitrary.4jbgyc",
    "reason": "The conversions response now exposes one aggregate response.body shape; the former open code leaf no longer exists.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-platform-security.test.ts"
    ]
  },
  {
    "debtId": "debt.wire.arbitrary.9hgxgx",
    "reason": "The conversions response now exposes one aggregate response.body shape; the former open error leaf no longer exists.",
    "testEvidence": [
      "packages/encryption-invariants/tests/integration/reviewed-main-2026-09-09-platform-security.test.ts"
    ]
  }
];
