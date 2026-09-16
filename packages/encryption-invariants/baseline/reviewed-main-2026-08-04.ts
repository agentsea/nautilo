import type { EncryptionCoverageEntry } from "../src/model";
import type { ReviewedDebtLink } from "../src/registry";

const PAIRING_EVIDENCE =
  "packages/server/tests/integration/remote-control-pairing-store.integration.test.ts";
const ROUTE_EVIDENCE =
  "packages/server/tests/unit/remote-control-routes.test.ts";
const RELAY_EVIDENCE =
  "packages/server/tests/unit/relay-routes.test.ts";
const HOST_FILE_EVIDENCE =
  "packages/server/tests/unit/remote-control-routes.test.ts";
const ORDINARY_ADMISSION_EVIDENCE =
  "packages/server/tests/unit/ordinary-origin-admission.test.ts";

const DATABASE_FIELDS = {
  nautilo_instance_identity: [
    "server_binding_generation",
    "server_instance_id",
  ],
  ordinary_request_admissions: [
    "actor_id",
    "admitted_at",
    "body_sha256",
    "controller_installation_id",
    "expires_at",
    "installation_generation",
    "request_id",
    "user_id",
  ],
  remote_controller_bindings: [
    "actor_id",
    "challenge_id",
    "controller_installation_id",
    "created_at",
    "desktop_session_id",
    "host_installation_id",
    "id",
    "installation_generation",
    "last_seen_at",
    "pairing_generation",
    "relay_token_id",
    "revoked_at",
    "server_binding_generation",
    "server_instance_id",
    "user_id",
  ],
  remote_controller_installations: [
    "actor_id",
    "created_at",
    "id",
    "installation_generation",
    "installation_id",
    "label",
    "last_seen_at",
    "proof_key",
    "proof_key_algorithm",
    "proof_key_fingerprint",
    "revoked_at",
    "server_binding_generation",
    "server_instance_id",
    "user_id",
  ],
  remote_pairing_challenges: [
    "actor_id",
    "consumed_at",
    "created_at",
    "desktop_session_id",
    "expires_at",
    "failed_attempts",
    "host_installation_id",
    "id",
    "manual_verifier_digest",
    "pairing_generation",
    "qr_verifier_digest",
    "relay_token_id",
    "revoked_at",
    "server_binding_generation",
    "server_instance_id",
    "user_id",
    "version",
  ],
} as const;

function bounded(
  id: string,
  surface: "db" | "wire",
  locator: string,
  metadataAllowlist: readonly string[],
  testEvidence: string,
): EncryptionCoverageEntry {
  return {
    id,
    surface,
    locator,
    owner: surface === "db" ? "packages/db" : "packages/server",
    readers: surface === "db"
      ? ["packages/server/src/remote-control"]
      : ["packages/server/src/routes/remote-control.ts"],
    writers: surface === "db"
      ? ["packages/server/src/remote-control"]
      : ["apps/mobile/src", "apps/desktop/electron"],
    migrationState: "not_applicable",
    retention:
      surface === "db"
        ? "Retained only for the bounded controller-pairing or one-use admission lifecycle and removed by revocation, expiry cleanup, or owning-principal deletion."
        : "The authenticated control-plane projection is transient and retained only by the already inventoried durable pairing or Relay lifecycle.",
    testEvidence: [testEvidence],
    classification: "bounded_metadata",
    metadataAllowlist,
    plaintextReason:
      "The exact allowlist contains only canonical principal and installation identifiers, public verification material, HMAC verifier digests, bounded labels/enums/counters, lifecycle timestamps, or fixed-format request digests; it contains no Room message, Tool payload, file bytes, private key, or plaintext pairing secret.",
  };
}

const databaseEntries = Object.entries(DATABASE_FIELDS).flatMap(
  ([table, fields]) => [
    ...(table === "nautilo_instance_identity"
      ? []
      : [bounded(
        `db.main-2026-08-04.${table.replaceAll("_", "-")}`,
        "db",
        `public.${table}`,
        fields,
        table === "ordinary_request_admissions"
          ? ORDINARY_ADMISSION_EVIDENCE
          : PAIRING_EVIDENCE,
      )]),
    ...fields.map((field) =>
      bounded(
        `db.main-2026-08-04.${table.replaceAll("_", "-")}.${field.replaceAll("_", "-")}`,
        "db",
        `public.${table}.${field}`,
        [field],
        table === "ordinary_request_admissions"
          ? ORDINARY_ADMISSION_EVIDENCE
          : PAIRING_EVIDENCE,
      )
    ),
  ],
);

const boundedWire = [
  ["remote-controller-delete", "http:request_response:DELETE /api/remote/controllers/:bindingId"],
  ["remote-controller-list", "http:request_response:GET /api/remote/controllers"],
  ["remote-host-list", "http:request_response:GET /api/remote/hosts"],
  ["remote-controller-update", "http:request_response:PATCH /api/remote/controllers/:bindingId"],
  ["host-choice-reply", "http:request_response:POST /api/auth/host-choice-reply"],
  ["remote-challenge-consume", "http:request_response:POST /api/remote/challenges/consume"],
  ["remote-host-resume", "ws:client_to_server:remote.host.resume"],
  ["host-choice", "ws:server_to_client:host.choice"],
  ["remote-host-connected", "ws:server_to_client:remote.host.connected"],
  ["remote-host-disconnected", "ws:server_to_client:remote.host.disconnected"],
  ["remote-host-revoked", "ws:server_to_client:remote.host.revoked"],
  ["remote-host-snapshot", "ws:server_to_client:remote.host.snapshot"],
  ["remote-host-updated", "ws:server_to_client:remote.host.updated"],
] as const;

const secretWire: readonly EncryptionCoverageEntry[] = [
  {
    id: "wire.main-2026-08-04.electron-origin-credential",
    surface: "wire",
    locator: "http:request_response:POST /api/relay/electron-origin-credential",
    owner: "packages/server",
    readers: ["apps/desktop/electron"],
    writers: ["packages/server/src/remote-control/electron-origin-credential-store.ts"],
    migrationState: "not_applicable",
    retention:
      "The credential is returned only to the authenticated Electron origin, expires after its short fixed lifetime, is consumed from memory, and is never persisted or backed up.",
    testEvidence: [RELAY_EVIDENCE],
    classification: "operator_secret",
    secretStoreLocation:
      "Ephemeral in-process Electron-origin credential store; no durable server or client plaintext store.",
    backupProcedure:
      "Not backed up; expiry or process loss requires minting a fresh authenticated credential.",
    excludedFromAgentGrants: true,
  },
  ...[
    "http:request_response:POST /api/remote/challenges",
    "http:request_response:POST /api/remote/challenges/manual/prepare",
  ].map((locator, index): EncryptionCoverageEntry => ({
    id: `wire.main-2026-08-04.pairing-secret-${index + 1}`,
    surface: "wire",
    locator,
    owner: "packages/server",
    readers: ["apps/desktop/electron", "apps/mobile/src"],
    writers: ["packages/server/src/remote-control/pairing-store.ts"],
    migrationState: "not_applicable",
    retention:
      "Plaintext ceremony material exists only in the authenticated short-lived pairing response; the database retains HMAC verifier digests and expiry state, never the QR or manual secret.",
    testEvidence: [ROUTE_EVIDENCE],
    classification: "operator_secret",
    secretStoreLocation:
      "Ephemeral authenticated pairing response and device presentation memory; durable storage contains only keyed verifier digests.",
    backupProcedure:
      "Not backed up; an expired, lost, or interrupted ceremony must be replaced with a newly generated challenge.",
    excludedFromAgentGrants: true,
  })),
];

export const REVIEWED_MAIN_2026_08_04_COVERAGE_ENTRIES:
  readonly EncryptionCoverageEntry[] = [
    ...databaseEntries,
    bounded(
      "db.main-2026-08-04.ordinary-admission-cleanup-writer",
      "db",
      "packages/server/src/remote-control/ordinary-admission-store.ts#cleanupExpired:raw_sql:delete:public.ordinary_request_admissions:1",
      ["expired one-use admission rows"],
      ORDINARY_ADMISSION_EVIDENCE,
    ),
    ...boundedWire.map(([id, locator]) =>
      bounded(
        `wire.main-2026-08-04.${id}`,
        "wire",
        locator,
        ["canonical identifiers", "bounded lifecycle and presence metadata"],
        ROUTE_EVIDENCE,
      )
    ),
    ...[
      "bodySha256",
      "desktopSessionId",
      "method",
      "path",
      "relayId",
      "requestId",
    ].map((field) =>
      bounded(
        `wire.main-2026-08-04.electron-origin-${field.toLowerCase()}`,
        "wire",
        `http:request_response:POST /api/relay/electron-origin-credential#request.body.${field}`,
        [field],
        RELAY_EVIDENCE,
      )
    ),
    ...secretWire,
  ];

const RELAY_FILE_DEBT =
  "debt.wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaylocalfileresult.14trnr5";

export const REVIEWED_MAIN_2026_08_04_DEBT_LINKS:
  readonly ReviewedDebtLink[] = [
    ...[
      "http:request_response:POST /api/remote/current-folder/select",
      "http:request_response:POST /api/remote/host-files/list",
      "http:request_response:POST /api/remote/host-files/read",
      "http:request_response:POST /api/remote/host-files/stat",
    ].map((locator, index) => ({
      id: `debt-link.wire.main-2026-08-04.remote-host-file-${index + 1}`,
      surface: "wire" as const,
      locator,
      owner: "packages/server",
      targetDebtIds: [RELAY_FILE_DEBT],
      reason:
        "This authenticated HTTP projection is another representation of the same Relay local-file operation/result boundary, including paths, labels, metadata, and for read operations the exact file bytes; it inherits that frozen boundary's release impact.",
      testEvidence: [HOST_FILE_EVIDENCE],
    })),
  ];
