import type { EncryptionCoverageEntry } from "../src/model";
import type { DtoDeclaration } from "../src/node/dto-inventory";

const REVIEW_TEST =
  "packages/encryption-invariants/tests/integration/reviewed-public-join-availability.test.ts";

export const REVIEWED_PUBLIC_JOIN_AVAILABILITY_DTO_DECLARATIONS:
readonly DtoDeclaration[] = [{
  observationId: "wire.http.request.response.get.api.public.join.1bfmmlm",
  locator: "http:request_response:GET /api/public-join",
  structuralSignatures: ["response.body:{available:boolean}"],
  arbitraryPayloads: [],
}];

/** Anonymous, content-free availability metadata for the shared sign-in surface. */
export const REVIEWED_PUBLIC_JOIN_AVAILABILITY_COVERAGE:
readonly EncryptionCoverageEntry[] = [{
  id: "wire.public-join-availability.status",
  surface: "wire",
  locator: "http:request_response:GET /api/public-join",
  owner: "packages/server",
  readers: [
    "packages/api-client/src/client.ts",
    "apps/workbench/src/components/sign-in-dialog.tsx",
  ],
  writers: ["packages/server/src/routes/public-join.ts"],
  migrationState: "not_applicable",
  retention: "One anonymous status response; neither the server nor client persists it.",
  testEvidence: [
    REVIEW_TEST,
    "packages/server/tests/unit-isolated/public-join-route.test.ts",
    "apps/workbench/tests/unit-isolated/sign-in-dialog.test.tsx",
  ],
  classification: "bounded_metadata",
  metadataAllowlist: ["available"],
  plaintextReason:
    "The response is a single public boolean derived from the current enrollment and selected-invite eligibility checks. It excludes the invite token, selection and invite identifiers, join URL, Group or Room identity, policy details, and authority error details.",
}];
