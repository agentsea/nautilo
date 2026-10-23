import type { EncryptionCoverageEntry } from "../src/model";
import type { RetiredFrozenDebt } from "../src/registry";

const MEDIA_ROUTE_EVIDENCE =
  "packages/server/tests/unit-isolated/media-generations-route.test.ts";
const MEDIA_FUNDING_BINDING_EVIDENCE =
  "packages/db/tests/unit/media-funding-binding-migration-security-contract.test.ts";

export const SUPERSEDED_RELEASE_RECONCILIATION_COVERAGE_LOCATORS =
  new Set<string>([
    "http:request_response:POST /api/voices/:voiceId/preview#response.body.errored.cause",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest#githubBinding",
    "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage#githubBinding",
    "relay:server_to_client:relay:dispatch#githubBinding",
    "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage#githubBinding",
  ]);

const MEDIA_METADATA_FIELDS = [
  "actual_usd_micros",
  "cancellation_provider_acknowledged_at",
  "cancellation_requested_at",
  "funding_binding",
] as const;

export const REVIEWED_RELEASE_RECONCILIATION_COVERAGE:
  readonly EncryptionCoverageEntry[] = [
  ...MEDIA_METADATA_FIELDS.map((field) => ({
    id: `db.release-reconciliation.media-generation-${field.replaceAll("_", "-")}`,
    surface: "db" as const,
    locator: `public.media_generations.${field}`,
    owner: "packages/db",
    readers: ["packages/db/src/queries/media-generations.ts"],
    writers: ["packages/db/src/queries/media-generations.ts"],
    migrationState: "not_applicable" as const,
    retention:
      "Retained with the paid-media lifecycle receipt until the owning Human is deleted after terminal-state eligibility checks.",
    testEvidence: [
      field === "funding_binding"
        ? MEDIA_FUNDING_BINDING_EVIDENCE
        : MEDIA_ROUTE_EVIDENCE,
    ],
    classification: "bounded_metadata" as const,
    metadataAllowlist: [field],
    plaintextReason: field === "funding_binding"
      ? "The immutable versioned funding binding contains the server or personal funding kind, provider route, optional credential id and revision, and a credential fingerprint. It contains no API key, prompt, generated media, provider response, or error text."
      : "This field is limited to a nonnegative measured-cost integer or a cancellation lifecycle timestamp. It contains no prompt, generated media, provider response, credential, or error text.",
  })),
  {
    id: "wire.release-reconciliation.media-generation-cancel",
    surface: "wire",
    locator: "http:request_response:POST /api/media-generations/:receiptId/cancel",
    owner: "packages/server",
    readers: ["packages/api-client/src/client.ts"],
    writers: ["packages/server/src/routes/media-generations.ts"],
    migrationState: "not_applicable",
    retention: "The authorized cancellation response exists only for the current request.",
    testEvidence: [MEDIA_ROUTE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: [
      "receiptId",
      "revision",
      "state",
      "cancellationRequested",
      "canCancel",
      "failure",
      "recoveryActions",
      "artifact",
      "progress",
      "mediaKind",
      "modelId",
      "settings",
    ],
    plaintextReason:
      "The route projects the same presentation-safe paid-media receipt as the status route after an authorized cancellation request. It excludes the creative prompt, lyrics, provider queue identity, credential, provider response, delivery URL, and generated media bytes.",
  },
  {
    id: "wire.release-reconciliation.media-generation-cancel-ignored-body",
    surface: "wire",
    locator: "http:request_response:POST /api/media-generations/:receiptId/cancel#request.body",
    owner: "packages/server",
    readers: [],
    writers: ["packages/server/src/routes/media-generations.ts"],
    migrationState: "not_applicable",
    retention: "The route does not read or retain a request body.",
    testEvidence: [MEDIA_ROUTE_EVIDENCE],
    classification: "bounded_metadata",
    metadataAllowlist: ["ignored request body"],
    plaintextReason:
      "Cancellation authority and identity come only from the authenticated actor and receiptId path parameter. The handler never reads, logs, stores, forwards, or returns request.body; the process-wide HTTP body limit remains the only admitted byte bound.",
  },
];

export const RETIRED_RELEASE_RECONCILIATION_FROZEN_DEBT:
  readonly RetiredFrozenDebt[] = [{
  debtId: "debt.wire.arbitrary.19gyh7u",
  reason:
    "The voice-preview route now returns a bounded response DTO instead of exposing the Node stream error cause, so the exact frozen arbitrary wire observation is absent.",
  testEvidence: ["packages/server/tests/unit-isolated/voices-routes.test.ts"],
}];
