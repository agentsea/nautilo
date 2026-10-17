import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const REVIEW_TEST =
  "packages/encryption-invariants/tests/integration/reviewed-image-understanding-security.test.ts";

export const IMAGE_UNDERSTANDING_CONFIGURATION_LOCATOR =
  "public.server_model_config.image_understanding_model";

export const REVIEWED_IMAGE_UNDERSTANDING_COVERAGE:
  readonly EncryptionCoverageEntry[] = [{
    id: "db.image-understanding.server-selection",
    surface: "db",
    locator: IMAGE_UNDERSTANDING_CONFIGURATION_LOCATOR,
    owner: "packages/db",
    readers: [
      "packages/db/src/utils/server-model-config-queries.ts",
      "packages/server/src/lib/image-model-preferences.ts",
      "packages/server/src/routes/server-models.ts",
    ],
    writers: [
      "packages/db/src/utils/server-model-config-queries.ts",
      "packages/server/src/routes/server-models.ts",
    ],
    migrationState: "not_applicable",
    retention:
      "Retained with the singleton server model configuration and replaced or cleared by the next administrator update.",
    testEvidence: [
      REVIEW_TEST,
      "packages/db/tests/unit/server-model-config-defaults.test.ts",
      "packages/server/tests/unit/server-models-route.test.ts",
    ],
    classification: "bounded_metadata",
    metadataAllowlist: ["image_understanding_model"],
    plaintextReason:
      "The nullable value is either Automatic or one canonical signed catalogue model identifier. It contains no image, Human question, model observation, prompt, provider credential, secret key, or free-form provider error.",
  }];

/** The raw request remains inside its already-frozen endpoint carrier. */
export const REVIEWED_IMAGE_UNDERSTANDING_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
  {
    id: "link.wire.image-understanding.admin-request",
    surface: "wire",
    locator: "http:request_response:POST /api/admin/server-models#request.body",
    owner: "packages/server",
    targetDebtIds: [
      "debt.wire.http.request.response.post.api.admin.server.models.1nyrg5s",
    ],
    reason:
      "The raw administrator request remains part of the existing frozen server-model endpoint boundary. The new recognized field narrows only to a nullable signed model identifier after parsing; this link does not classify or exempt arbitrary sibling request properties.",
    testEvidence: [
      REVIEW_TEST,
      "packages/server/tests/unit/server-models-route.test.ts",
      "packages/api-client/tests/unit/server-models-contract.test.ts",
    ],
  },
];
